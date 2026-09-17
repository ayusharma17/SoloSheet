-- Apply after phase 10. Administrator bypass and account holds are resolved
-- inside the same profile-locked transaction that reserves extraction credits.
BEGIN;

REVOKE ALL ON FUNCTION public.reserve_extraction(uuid, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION public.reserve_extraction(uuid, uuid, text, boolean);

CREATE FUNCTION public.reserve_extraction(
  p_user_id uuid,
  p_request_id uuid,
  p_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.extraction_requests%ROWTYPE;
  balance integer;
  expired_count integer;
  v_is_admin boolean := false;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_request_id IS NULL OR p_fingerprint IS NULL
    OR p_fingerprint !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'Invalid request' USING ERRCODE = '22023';
  END IF;

  SELECT credits INTO balance
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'no_credits');
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    JOIN public.admin_whitelist a ON a.email = lower(btrim(p.email))
    WHERE p.id = p_user_id AND a.is_active
  ) INTO v_is_admin;

  WITH expired AS (
    UPDATE public.extraction_requests SET status = 'failed'
    WHERE user_id = p_user_id AND status = 'processing'
      AND created_at < now() - interval '10 minutes'
    RETURNING charged
  )
  SELECT count(*) FILTER (WHERE charged) INTO expired_count FROM expired;
  IF expired_count > 0 THEN
    UPDATE public.profiles SET credits = credits + expired_count, updated_at = now()
    WHERE id = p_user_id RETURNING credits INTO balance;
  END IF;

  SELECT * INTO r FROM public.extraction_requests
  WHERE user_id = p_user_id AND request_id = p_request_id;
  IF FOUND THEN
    IF r.fingerprint <> p_fingerprint THEN
      RETURN jsonb_build_object('status', 'conflict');
    END IF;
    RETURN jsonb_build_object(
      'status', r.status,
      'materialId', r.material_id,
      'remainingCredits', balance
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.account_holds
    WHERE user_id = p_user_id AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('status', 'account_held', 'remainingCredits', balance);
  END IF;

  IF NOT v_is_admin THEN
    UPDATE public.profiles SET credits = credits - 1, updated_at = now()
    WHERE id = p_user_id AND credits >= 1 RETURNING credits INTO balance;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'no_credits');
    END IF;
  END IF;

  INSERT INTO public.extraction_requests (
    user_id, request_id, fingerprint, status, charged
  ) VALUES (
    p_user_id, p_request_id, p_fingerprint, 'processing', NOT v_is_admin
  );

  IF v_is_admin THEN
    INSERT INTO public.audit_events (
      event_type, subject_user_id, actor_type, actor_user_id,
      reason, correlation_id, metadata
    ) VALUES (
      'administrator.extraction_bypassed', p_user_id,
      'administrator', p_user_id,
      'Unlimited administrator extraction reserved', p_request_id,
      jsonb_build_object('request_id', p_request_id)
    );
  END IF;

  RETURN jsonb_build_object('status', 'reserved', 'remainingCredits', balance);
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_extraction(
  p_user_id uuid,
  p_request_id uuid,
  p_course_name text,
  p_target_pages integer,
  p_user_directive text,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.extraction_requests%ROWTYPE;
  result_id uuid;
  balance integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT credits INTO balance FROM public.profiles
  WHERE id = p_user_id FOR UPDATE;
  SELECT * INTO r FROM public.extraction_requests
  WHERE user_id = p_user_id AND request_id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.status = 'failed' THEN
    RAISE EXCEPTION 'No active reservation';
  END IF;
  IF r.status = 'completed' THEN
    RETURN jsonb_build_object(
      'status', 'completed',
      'materialId', r.material_id,
      'remainingCredits', balance
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.account_holds
    WHERE user_id = p_user_id AND status = 'active'
  ) THEN
    IF r.charged THEN
      UPDATE public.profiles SET credits = credits + 1, updated_at = now()
      WHERE id = p_user_id RETURNING credits INTO balance;
    END IF;
    UPDATE public.extraction_requests SET status = 'failed'
    WHERE user_id = p_user_id AND request_id = p_request_id;
    INSERT INTO public.audit_events (
      event_type, subject_user_id, actor_type, reason, correlation_id, metadata
    ) VALUES (
      'extraction.blocked_by_hold', p_user_id, 'system',
      'Extraction completion rejected because the account is held',
      p_request_id, jsonb_build_object('request_id', p_request_id)
    );
    RETURN jsonb_build_object(
      'status', 'account_held', 'remainingCredits', balance
    );
  END IF;

  IF p_target_pages IS NULL OR p_target_pages NOT BETWEEN 1 AND 20
    OR p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'Invalid extraction';
  END IF;
  INSERT INTO public.course_materials (
    user_id, course_name, target_pages, user_directive, extracted_json
  ) VALUES (
    p_user_id, p_course_name, p_target_pages, p_user_directive, p_items
  ) RETURNING id INTO result_id;
  UPDATE public.extraction_requests SET status = 'completed', material_id = result_id
  WHERE user_id = p_user_id AND request_id = p_request_id;
  RETURN jsonb_build_object(
    'status', 'completed',
    'materialId', result_id,
    'remainingCredits', balance
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_extraction(uuid, uuid, text),
  public.complete_extraction(uuid, uuid, text, integer, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_extraction(uuid, uuid, text),
  public.complete_extraction(uuid, uuid, text, integer, text, jsonb)
  TO service_role;

COMMIT;
