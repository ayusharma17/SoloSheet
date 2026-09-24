-- Apply after phase 17 and before deploying the asynchronous extraction worker.
-- This turns extraction_requests into the durable job/credit source of truth.
BEGIN;

ALTER TABLE public.extraction_requests
  DROP CONSTRAINT IF EXISTS extraction_requests_status_check;

ALTER TABLE public.extraction_requests
  ADD COLUMN IF NOT EXISTS course_name text,
  ADD COLUMN IF NOT EXISTS user_directive text,
  ADD COLUMN IF NOT EXISTS target_pages integer,
  ADD COLUMN IF NOT EXISTS file_inputs jsonb,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_owner uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS settled_at timestamptz,
  ADD COLUMN IF NOT EXISTS uploads_cleaned_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_code text;

ALTER TABLE public.extraction_requests
  ADD CONSTRAINT extraction_requests_status_check
    CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'expired')),
  ADD CONSTRAINT extraction_requests_attempt_count_check
    CHECK (attempt_count BETWEEN 0 AND 3),
  ADD CONSTRAINT extraction_requests_failure_code_check
    CHECK (failure_code IS NULL OR failure_code IN (
      'provider_permanent', 'provider_transient', 'invalid_output',
      'configuration', 'worker_error', 'lease_expired', 'queue_expired',
      'dispatch_failed', 'account_held', 'legacy_migration'
    ));

-- Worker RPCs intentionally accept only a request UUID. Refuse the rollout if
-- historical data would make that identity ambiguous, then enforce it for all
-- future callers. Operators must investigate collisions rather than silently
-- re-keying jobs whose UUID may already be held by a client.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.extraction_requests
    GROUP BY request_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate extraction request IDs must be resolved before phase 18'
      USING ERRCODE = '23505';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.extraction_requests'::regclass
      AND conname = 'extraction_requests_request_id_key'
  ) THEN
    ALTER TABLE public.extraction_requests
      ADD CONSTRAINT extraction_requests_request_id_key UNIQUE (request_id);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS extraction_requests_recovery_idx
  ON public.extraction_requests (status, lease_expires_at, created_at)
  WHERE status IN ('queued', 'processing');

-- Settle reservations stranded by the old synchronous request lifecycle once.
-- A charged request without a profile is an integrity failure: abort the whole
-- migration rather than terminalizing it without returning its credit.
DO $$
DECLARE
  expected_refunds integer;
  applied_refunds integer;
BEGIN
  WITH stranded AS (
    UPDATE public.extraction_requests
    SET status = 'expired', failure_code = 'legacy_migration',
        completed_at = now(), settled_at = now()
    WHERE status = 'processing'
    RETURNING user_id, charged
  ), refunds AS (
    SELECT user_id, count(*) FILTER (WHERE charged)::integer AS amount
    FROM stranded GROUP BY user_id
  ), applied AS (
    UPDATE public.profiles AS profile
    SET credits = profile.credits + refunds.amount, updated_at = now()
    FROM refunds
    WHERE profile.id = refunds.user_id AND refunds.amount > 0
    RETURNING refunds.amount
  )
  SELECT
    coalesce((SELECT sum(amount) FROM refunds), 0),
    coalesce((SELECT sum(amount) FROM applied), 0)
  INTO expected_refunds, applied_refunds;

  IF applied_refunds <> expected_refunds THEN
    RAISE EXCEPTION
      'Phase 18 could not refund every charged legacy extraction (% expected, % applied)',
      expected_refunds, applied_refunds
      USING ERRCODE = '23503';
  END IF;
END;
$$;

-- The synchronous lifecycle is unsafe once the durable queue is live. Drop the
-- old service-only entry points so no stale server can create or settle jobs
-- outside the lease protocol.
DROP FUNCTION IF EXISTS public.reserve_extraction(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.complete_extraction(uuid, uuid, text, integer, text, jsonb);
DROP FUNCTION IF EXISTS public.fail_extraction(uuid, uuid);

CREATE OR REPLACE FUNCTION public.enqueue_extraction(
  p_user_id uuid,
  p_request_id uuid,
  p_fingerprint text,
  p_course_name text,
  p_target_pages integer,
  p_user_directive text,
  p_files jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.extraction_requests%ROWTYPE;
  balance integer;
  v_is_admin boolean := false;
  file_count integer;
  total_size bigint;
  request_found boolean;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_request_id IS NULL OR p_fingerprint IS NULL
    OR p_fingerprint !~ '^[0-9a-fA-F]{64}$'
    OR p_course_name IS NULL OR length(p_course_name) NOT BETWEEN 1 AND 100
    OR p_target_pages IS NULL OR p_target_pages NOT BETWEEN 1 AND 20
    OR p_user_directive IS NULL OR length(p_user_directive) > 1000
    OR p_files IS NULL OR jsonb_typeof(p_files) <> 'array' THEN
    RAISE EXCEPTION 'Invalid extraction job' USING ERRCODE = '22023';
  END IF;

  SELECT count(*), coalesce(sum((item->>'size')::bigint), 0)
  INTO file_count, total_size
  FROM jsonb_array_elements(p_files) AS entry(item)
  WHERE jsonb_typeof(item) = 'object'
    AND item ?& ARRAY['path', 'name', 'type', 'size']
    AND jsonb_typeof(item->'path') = 'string'
    AND jsonb_typeof(item->'name') = 'string'
    AND jsonb_typeof(item->'type') = 'string'
    AND jsonb_typeof(item->'size') = 'number'
    AND item->>'size' ~ '^[1-9][0-9]{0,8}$'
    AND (item->>'size')::bigint <= 209715200
    AND item->>'path' LIKE p_user_id::text || '/%'
    AND item->>'path' ~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}\.(pdf|png|jpg|jpeg|webp|gif)$'
    AND length(item->>'name') BETWEEN 1 AND 255
    AND item->>'name' !~ '[/\\[:cntrl:]]'
    AND item->>'type' IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif');
  IF file_count IS DISTINCT FROM jsonb_array_length(p_files)
    OR file_count NOT BETWEEN 1 AND 10 OR total_size > 209715200 THEN
    RAISE EXCEPTION 'Invalid extraction files' USING ERRCODE = '22023';
  END IF;

  -- Serialize even a not-yet-created request ID, then always lock request before
  -- profile. Every settlement function that needs both follows this order.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::text, 180018)
  );
  SELECT * INTO r FROM public.extraction_requests
  WHERE request_id = p_request_id FOR UPDATE;
  request_found := FOUND;

  SELECT credits INTO balance FROM public.profiles
  WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'no_credits');
  END IF;

  IF request_found THEN
    IF r.user_id <> p_user_id OR r.fingerprint <> p_fingerprint THEN
      RETURN jsonb_build_object('status', 'conflict', 'remainingCredits', balance);
    END IF;
    RETURN jsonb_build_object(
      'status', r.status, 'materialId', r.material_id,
      'remainingCredits', balance, 'failureCode', r.failure_code
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.account_holds
    WHERE user_id = p_user_id AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('status', 'account_held', 'remainingCredits', balance);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM auth.users AS auth_user
    JOIN public.admin_whitelist AS admin
      ON admin.email = lower(btrim(auth_user.email)) AND admin.is_active
    WHERE auth_user.id = p_user_id
      AND auth_user.email IS NOT NULL
      AND auth_user.email_confirmed_at IS NOT NULL
  ) INTO v_is_admin;

  IF NOT v_is_admin THEN
    UPDATE public.profiles SET credits = credits - 1, updated_at = now()
    WHERE id = p_user_id AND credits >= 1 RETURNING credits INTO balance;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'no_credits');
    END IF;
  END IF;

  INSERT INTO public.extraction_requests (
    user_id, request_id, fingerprint, status, charged, course_name,
    user_directive, target_pages, file_inputs
  ) VALUES (
    p_user_id, p_request_id, p_fingerprint, 'queued', NOT v_is_admin,
    p_course_name, p_user_directive, p_target_pages, p_files
  );

  IF v_is_admin THEN
    INSERT INTO public.audit_events (
      event_type, subject_user_id, actor_type, actor_user_id,
      reason, correlation_id, metadata
    ) VALUES (
      'administrator.extraction_bypassed', p_user_id, 'administrator', p_user_id,
      'Unlimited administrator extraction queued', p_request_id,
      jsonb_build_object('request_id', p_request_id)
    );
  END IF;

  RETURN jsonb_build_object('status', 'queued', 'remainingCredits', balance);
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_extraction_job(
  p_request_id uuid,
  p_lease_owner uuid,
  p_lease_seconds integer DEFAULT 180
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.extraction_requests%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL OR p_lease_owner IS NULL OR p_lease_seconds IS NULL
    OR p_lease_seconds NOT BETWEEN 60 AND 900 THEN
    RAISE EXCEPTION 'Invalid worker lease' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::text, 180018)
  );
  SELECT * INTO r FROM public.extraction_requests
  WHERE request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'missing'); END IF;
  IF r.status = 'completed' THEN
    RETURN jsonb_build_object('status', 'completed', 'materialId', r.material_id);
  END IF;
  IF r.status IN ('failed', 'expired') THEN
    RETURN jsonb_build_object('status', r.status);
  END IF;
  IF r.status = 'processing' AND r.lease_expires_at > now() THEN
    RETURN jsonb_build_object('status', 'leased');
  END IF;
  IF r.attempt_count >= 3 THEN
    RETURN jsonb_build_object('status', 'attempts_exhausted');
  END IF;

  UPDATE public.extraction_requests
  SET status = 'processing', attempt_count = attempt_count + 1,
      lease_owner = p_lease_owner,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      started_at = coalesce(started_at, now()), heartbeat_at = now(),
      failure_code = NULL
  WHERE user_id = r.user_id AND request_id = r.request_id
  RETURNING * INTO r;

  RETURN jsonb_build_object(
    'status', 'processing', 'userId', r.user_id, 'requestId', r.request_id,
    'courseName', r.course_name, 'userDirective', r.user_directive,
    'targetPages', r.target_pages, 'fileInputs', r.file_inputs,
    'attemptCount', r.attempt_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.heartbeat_extraction_job(
  p_request_id uuid,
  p_lease_owner uuid,
  p_lease_seconds integer DEFAULT 180
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL OR p_lease_owner IS NULL OR p_lease_seconds IS NULL
    OR p_lease_seconds NOT BETWEEN 60 AND 900 THEN
    RAISE EXCEPTION 'Invalid worker lease' USING ERRCODE = '22023';
  END IF;
  UPDATE public.extraction_requests
  SET heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  WHERE request_id = p_request_id AND status = 'processing'
    AND lease_owner = p_lease_owner AND lease_expires_at > now();
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_extraction_job(
  p_request_id uuid,
  p_lease_owner uuid,
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
  profile_found boolean;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
    OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Invalid extraction output' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::text, 180018)
  );
  SELECT * INTO r FROM public.extraction_requests
  WHERE request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'missing'); END IF;
  SELECT credits INTO balance FROM public.profiles
  WHERE id = r.user_id FOR UPDATE;
  profile_found := FOUND;
  IF r.charged AND NOT profile_found THEN
    RAISE EXCEPTION 'Charged extraction profile is missing'
      USING ERRCODE = '23503';
  END IF;
  IF r.status = 'completed' THEN
    RETURN jsonb_build_object('status', 'completed', 'materialId', r.material_id,
      'remainingCredits', balance);
  END IF;
  IF r.status <> 'processing' OR r.lease_owner <> p_lease_owner
    OR r.lease_expires_at <= now() THEN
    RETURN jsonb_build_object('status', r.status);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.account_holds
    WHERE user_id = r.user_id AND status = 'active'
  ) THEN
    IF r.charged THEN
      UPDATE public.profiles SET credits = credits + 1, updated_at = now()
      WHERE id = r.user_id RETURNING credits INTO balance;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Charged extraction refund was not applied'
          USING ERRCODE = '23503';
      END IF;
    END IF;
    UPDATE public.extraction_requests
    SET status = 'failed', failure_code = 'account_held',
        completed_at = now(), settled_at = now(), lease_owner = NULL,
        lease_expires_at = NULL
    WHERE user_id = r.user_id AND request_id = r.request_id;
    INSERT INTO public.audit_events (
      event_type, subject_user_id, actor_type, reason, correlation_id, metadata
    ) VALUES (
      'extraction.blocked_by_hold', r.user_id, 'system',
      'Durable extraction completion rejected because the account is held',
      r.request_id, jsonb_build_object('request_id', r.request_id)
    );
    RETURN jsonb_build_object('status', 'failed', 'failureCode', 'account_held',
      'remainingCredits', balance);
  END IF;

  INSERT INTO public.course_materials (
    user_id, course_name, target_pages, user_directive, extracted_json
  ) VALUES (
    r.user_id, r.course_name, r.target_pages, left(r.user_directive, 500), p_items
  ) RETURNING id INTO result_id;

  UPDATE public.extraction_requests
  SET status = 'completed', material_id = result_id, completed_at = now(),
      settled_at = now(), lease_owner = NULL, lease_expires_at = NULL
  WHERE user_id = r.user_id AND request_id = r.request_id;
  RETURN jsonb_build_object('status', 'completed', 'materialId', result_id,
    'remainingCredits', balance);
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_extraction_job(
  p_request_id uuid,
  p_lease_owner uuid,
  p_failure_code text,
  p_retryable boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.extraction_requests%ROWTYPE;
  balance integer;
  profile_found boolean;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_failure_code NOT IN (
    'provider_permanent', 'provider_transient', 'invalid_output',
    'configuration', 'worker_error'
  ) THEN
    RAISE EXCEPTION 'Invalid failure code' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::text, 180018)
  );
  SELECT * INTO r FROM public.extraction_requests
  WHERE request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'missing'); END IF;
  SELECT credits INTO balance FROM public.profiles
  WHERE id = r.user_id FOR UPDATE;
  profile_found := FOUND;
  IF r.charged AND NOT profile_found THEN
    RAISE EXCEPTION 'Charged extraction profile is missing'
      USING ERRCODE = '23503';
  END IF;
  IF r.status IN ('completed', 'failed', 'expired') THEN
    RETURN jsonb_build_object('status', r.status, 'materialId', r.material_id,
      'remainingCredits', balance);
  END IF;
  IF r.status <> 'processing' OR r.lease_owner <> p_lease_owner
    OR r.lease_expires_at <= now() THEN
    RETURN jsonb_build_object('status', r.status, 'remainingCredits', balance);
  END IF;

  IF p_retryable AND r.attempt_count < 3 THEN
    UPDATE public.extraction_requests
    SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
        heartbeat_at = NULL, failure_code = p_failure_code
    WHERE user_id = r.user_id AND request_id = r.request_id;
    RETURN jsonb_build_object('status', 'queued', 'remainingCredits', balance);
  END IF;

  IF r.charged THEN
    UPDATE public.profiles SET credits = credits + 1, updated_at = now()
    WHERE id = r.user_id RETURNING credits INTO balance;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Charged extraction refund was not applied'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  UPDATE public.extraction_requests
  SET status = 'failed', failure_code = p_failure_code, completed_at = now(),
      settled_at = now(), lease_owner = NULL, lease_expires_at = NULL
  WHERE user_id = r.user_id AND request_id = r.request_id;
  RETURN jsonb_build_object('status', 'failed', 'remainingCredits', balance,
    'failureCode', p_failure_code);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_extraction_dispatch(
  p_user_id uuid,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.extraction_requests%ROWTYPE;
  balance integer;
  request_found boolean;
  profile_found boolean;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'Invalid dispatch cancellation' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::text, 180018)
  );
  SELECT * INTO r FROM public.extraction_requests
  WHERE request_id = p_request_id FOR UPDATE;
  request_found := FOUND;
  SELECT credits INTO balance FROM public.profiles
  WHERE id = p_user_id FOR UPDATE;
  profile_found := FOUND;
  IF NOT request_found THEN
    RETURN jsonb_build_object('status', 'missing', 'remainingCredits', balance);
  END IF;
  IF r.user_id <> p_user_id THEN
    RETURN jsonb_build_object('status', 'missing', 'remainingCredits', balance);
  END IF;
  IF r.status <> 'queued' OR r.attempt_count <> 0 THEN
    RETURN jsonb_build_object('status', coalesce(r.status, 'missing'),
      'remainingCredits', balance);
  END IF;
  IF r.charged AND NOT profile_found THEN
    RAISE EXCEPTION 'Charged extraction profile is missing'
      USING ERRCODE = '23503';
  END IF;
  IF r.charged THEN
    UPDATE public.profiles SET credits = credits + 1, updated_at = now()
    WHERE id = p_user_id RETURNING credits INTO balance;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Charged extraction refund was not applied'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  UPDATE public.extraction_requests
  SET status = 'failed', failure_code = 'dispatch_failed',
      completed_at = now(), settled_at = now()
  WHERE user_id = p_user_id AND request_id = p_request_id;
  RETURN jsonb_build_object('status', 'failed', 'failureCode', 'dispatch_failed',
    'remainingCredits', balance);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_extraction_status(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.extraction_requests%ROWTYPE;
  balance integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM public.extraction_requests
  WHERE user_id = auth.uid() AND request_id = p_request_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'missing'); END IF;
  SELECT credits INTO balance FROM public.profiles WHERE id = auth.uid();
  RETURN jsonb_build_object(
    'status', r.status, 'materialId', r.material_id,
    'remainingCredits', balance, 'failureCode', r.failure_code,
    'attemptCount', r.attempt_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.expire_extraction_jobs(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  jobs jsonb;
  expected_refunds integer;
  applied_refunds integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid recovery limit' USING ERRCODE = '22023';
  END IF;

  WITH candidates AS (
    SELECT user_id, request_id
    FROM public.extraction_requests
    WHERE (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now())
       OR (status = 'queued' AND created_at <= now() - interval '30 minutes')
    ORDER BY coalesce(lease_expires_at, created_at), request_id
    LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), expired AS (
    UPDATE public.extraction_requests AS request
    SET status = 'expired',
        failure_code = CASE WHEN request.status = 'processing'
          THEN 'lease_expired' ELSE 'queue_expired' END,
        completed_at = now(), settled_at = now(),
        lease_owner = NULL, lease_expires_at = NULL
    FROM candidates
    WHERE request.user_id = candidates.user_id
      AND request.request_id = candidates.request_id
    RETURNING request.user_id, request.request_id, request.file_inputs,
      request.charged, request.failure_code
  ), refunds AS (
    SELECT user_id, count(*) FILTER (WHERE charged)::integer AS amount
    FROM expired GROUP BY user_id
  ), applied AS (
    UPDATE public.profiles AS profile
    SET credits = profile.credits + refunds.amount, updated_at = now()
    FROM refunds
    WHERE profile.id = refunds.user_id AND refunds.amount > 0
    RETURNING refunds.amount
  )
  SELECT
    coalesce(jsonb_agg(jsonb_build_object(
      'requestId', expired.request_id, 'fileInputs', expired.file_inputs,
      'failureCode', expired.failure_code
    )), '[]'::jsonb),
    coalesce((SELECT sum(amount) FROM refunds), 0),
    coalesce((SELECT sum(amount) FROM applied), 0)
  INTO jobs, expected_refunds, applied_refunds
  FROM expired;
  IF applied_refunds <> expected_refunds THEN
    RAISE EXCEPTION
      'Could not refund every expired charged extraction (% expected, % applied)',
      expected_refunds, applied_refunds
      USING ERRCODE = '23503';
  END IF;
  RETURN jsonb_build_object('status', 'ok', 'jobs', jobs);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_extraction_upload_reservations(
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.extraction_requests%ROWTYPE;
  paths text[];
  released integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM public.extraction_requests
  WHERE request_id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.status NOT IN ('completed', 'failed', 'expired') THEN
    RETURN jsonb_build_object('status', 'not_terminal', 'releasedCount', 0);
  END IF;
  SELECT coalesce(array_agg(item->>'path'), ARRAY[]::text[]) INTO paths
  FROM jsonb_array_elements(coalesce(r.file_inputs, '[]'::jsonb)) AS entry(item);
  IF cardinality(paths) = 0 THEN
    RETURN jsonb_build_object('status', 'released', 'releasedCount', 0);
  END IF;
  -- Match reservation creation, browser release, and Storage INSERT validation.
  -- Deterministic ordering prevents cleanup workers from deadlocking each other.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(candidate.path, 140014)
  )
  FROM (SELECT unnest(paths) AS path ORDER BY path) AS candidate;
  IF EXISTS (
    SELECT 1 FROM storage.objects
    WHERE bucket_id = 'course-materials' AND name = ANY(paths)
  ) THEN
    RAISE EXCEPTION 'Delete Storage objects before releasing reservations'
      USING ERRCODE = '55000';
  END IF;
  DELETE FROM public.course_material_upload_reservations
  WHERE user_id = r.user_id AND path = ANY(paths);
  GET DIAGNOSTICS released = ROW_COUNT;
  UPDATE public.extraction_requests
  SET uploads_cleaned_at = now()
  WHERE user_id = r.user_id AND request_id = r.request_id;
  RETURN jsonb_build_object('status', 'released', 'releasedCount', released);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_pending_extraction_cleanup_jobs(
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE jobs jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid cleanup limit' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'requestId', pending.request_id, 'fileInputs', pending.file_inputs
  )), '[]'::jsonb) INTO jobs
  FROM (
    SELECT request_id, file_inputs
    FROM public.extraction_requests
    WHERE status IN ('completed', 'failed', 'expired')
      AND uploads_cleaned_at IS NULL AND file_inputs IS NOT NULL
    ORDER BY completed_at NULLS LAST, request_id
    LIMIT p_limit
  ) AS pending;
  RETURN jsonb_build_object('status', 'ok', 'jobs', jobs);
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_extraction(uuid, uuid, text, text, integer, text, jsonb),
  public.claim_extraction_job(uuid, uuid, integer),
  public.heartbeat_extraction_job(uuid, uuid, integer),
  public.complete_extraction_job(uuid, uuid, jsonb),
  public.fail_extraction_job(uuid, uuid, text, boolean),
  public.cancel_extraction_dispatch(uuid, uuid),
  public.expire_extraction_jobs(integer),
  public.release_extraction_upload_reservations(uuid),
  public.get_pending_extraction_cleanup_jobs(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_extraction(uuid, uuid, text, text, integer, text, jsonb),
  public.claim_extraction_job(uuid, uuid, integer),
  public.heartbeat_extraction_job(uuid, uuid, integer),
  public.complete_extraction_job(uuid, uuid, jsonb),
  public.fail_extraction_job(uuid, uuid, text, boolean),
  public.cancel_extraction_dispatch(uuid, uuid),
  public.expire_extraction_jobs(integer),
  public.release_extraction_upload_reservations(uuid),
  public.get_pending_extraction_cleanup_jobs(integer)
  TO service_role;

-- The service role invokes owner-defined RPCs; it must not bypass their lease,
-- settlement, validation, audit, or availability invariants with direct table
-- privileges. Start from no table privileges so unusual grants such as TRUNCATE,
-- REFERENCES, and TRIGGER cannot survive an older project default, then restore
-- only the reads used by trusted server diagnostics.
REVOKE ALL ON TABLE public.extraction_requests,
  public.course_materials
  FROM service_role;
GRANT SELECT ON TABLE public.extraction_requests,
  public.course_materials
  TO service_role;

REVOKE ALL ON FUNCTION public.get_extraction_status(uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_extraction_status(uuid)
  TO authenticated;

COMMIT;
