-- Apply after phase6 credit security. Deploy before the matching extraction route.
-- Only the server service_role may reserve, finalize, or refund credits.
BEGIN;
CREATE TABLE IF NOT EXISTS public.extraction_requests (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  charged boolean NOT NULL,
  material_id uuid REFERENCES public.course_materials(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);
ALTER TABLE public.extraction_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.extraction_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.extraction_requests TO service_role;
-- Browser inserts otherwise bypass this protocol entirely.
REVOKE INSERT, UPDATE ON public.course_materials FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.reserve_extraction(p_user_id uuid, p_request_id uuid, p_fingerprint text, p_is_admin boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.extraction_requests%ROWTYPE; balance integer; expired_count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501'; END IF;
  IF p_user_id IS NULL OR p_request_id IS NULL OR length(p_fingerprint) <> 64 THEN RAISE EXCEPTION 'Invalid request'; END IF;
  -- All operations take the same profile lock first, serializing a user's balance.
  SELECT credits INTO balance FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'no_credits'); END IF;
  -- Recover interrupted workers after twice the route's maximum runtime. A late
  -- worker cannot complete once its reservation has been marked failed.
  WITH expired AS (
    UPDATE public.extraction_requests SET status = 'failed'
    WHERE user_id = p_user_id AND status = 'processing' AND created_at < now() - interval '10 minutes'
    RETURNING charged
  ) SELECT count(*) FILTER (WHERE charged) INTO expired_count FROM expired;
  IF expired_count > 0 THEN
    UPDATE public.profiles SET credits = credits + expired_count, updated_at = now() WHERE id = p_user_id RETURNING credits INTO balance;
  END IF;
  SELECT * INTO r FROM public.extraction_requests WHERE user_id = p_user_id AND request_id = p_request_id;
  IF FOUND THEN
    IF r.fingerprint <> p_fingerprint THEN RETURN jsonb_build_object('status', 'conflict'); END IF;
    RETURN jsonb_build_object('status', r.status, 'materialId', r.material_id, 'remainingCredits', balance);
  END IF;
  IF NOT p_is_admin THEN
    UPDATE public.profiles SET credits = credits - 1, updated_at = now()
    WHERE id = p_user_id AND credits >= 1 RETURNING credits INTO balance;
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 'no_credits'); END IF;
  END IF;
  INSERT INTO public.extraction_requests(user_id, request_id, fingerprint, status, charged)
  VALUES (p_user_id, p_request_id, p_fingerprint, 'processing', NOT p_is_admin);
  RETURN jsonb_build_object('status', 'reserved', 'remainingCredits', balance);
END; $$;

CREATE OR REPLACE FUNCTION public.complete_extraction(p_user_id uuid, p_request_id uuid, p_course_name text, p_target_pages integer, p_user_directive text, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.extraction_requests%ROWTYPE; result_id uuid; balance integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501'; END IF;
  SELECT credits INTO balance FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  SELECT * INTO r FROM public.extraction_requests WHERE user_id = p_user_id AND request_id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.status = 'failed' THEN RAISE EXCEPTION 'No active reservation'; END IF;
  IF r.status = 'completed' THEN
    RETURN jsonb_build_object('materialId', r.material_id, 'remainingCredits', balance);
  END IF;
  IF p_target_pages NOT BETWEEN 1 AND 20 OR jsonb_typeof(p_items) <> 'array' THEN RAISE EXCEPTION 'Invalid extraction'; END IF;
  INSERT INTO public.course_materials(user_id, course_name, target_pages, user_directive, extracted_json)
  VALUES (p_user_id, p_course_name, p_target_pages, p_user_directive, p_items) RETURNING id INTO result_id;
  UPDATE public.extraction_requests SET status = 'completed', material_id = result_id WHERE user_id = p_user_id AND request_id = p_request_id;
  RETURN jsonb_build_object('materialId', result_id, 'remainingCredits', balance);
END; $$;

CREATE OR REPLACE FUNCTION public.fail_extraction(p_user_id uuid, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.extraction_requests%ROWTYPE; balance integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501'; END IF;
  SELECT credits INTO balance FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  SELECT * INTO r FROM public.extraction_requests WHERE user_id = p_user_id AND request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'failed'); END IF;
  -- A timeout after commit must never refund a successfully saved sheet.
  IF r.status = 'processing' THEN
    IF r.charged THEN
      UPDATE public.profiles SET credits = credits + 1, updated_at = now() WHERE id = p_user_id RETURNING credits INTO balance;
    END IF;
    UPDATE public.extraction_requests SET status = 'failed' WHERE user_id = p_user_id AND request_id = p_request_id;
    r.status := 'failed';
  END IF;
  RETURN jsonb_build_object('status', r.status, 'materialId', r.material_id, 'remainingCredits', balance);
END; $$;

REVOKE ALL ON FUNCTION public.reserve_extraction(uuid, uuid, text, boolean), public.complete_extraction(uuid, uuid, text, integer, text, jsonb), public.fail_extraction(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_extraction(uuid, uuid, text, boolean), public.complete_extraction(uuid, uuid, text, integer, text, jsonb), public.fail_extraction(uuid, uuid) TO service_role;
COMMIT;
