-- Run only against an isolated database after phase 18. All writes roll back.
BEGIN;

INSERT INTO auth.users (id, email, email_confirmed_at)
VALUES
  ('f0000000-0000-4000-8000-000000000001', 'durable-owner@school.edu', now()),
  ('f0000000-0000-4000-8000-000000000002', 'durable-other@school.edu', now());
UPDATE public.profiles SET credits = 10
WHERE id = 'f0000000-0000-4000-8000-000000000001';
UPDATE public.profiles SET credits = 3
WHERE id = 'f0000000-0000-4000-8000-000000000002';
INSERT INTO public.course_material_upload_reservations(path, user_id, size_bytes)
VALUES (
  'f0000000-0000-4000-8000-000000000001/f3000000-0000-4000-8000-000000000001/f4000000-0000-4000-8000-000000000001.pdf',
  'f0000000-0000-4000-8000-000000000001', 42
);

-- Test-only owner-defined setup helper. Production service_role must not have
-- the direct UPDATE grant needed to age a queued row for recovery coverage.
CREATE FUNCTION pg_temp.backdate_extraction(p_request_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.extraction_requests
  SET created_at = now() - interval '31 minutes'
  WHERE request_id = p_request_id
$$;

SELECT set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL ROLE service_role;

DO $$
DECLARE
  result jsonb;
  service_rpc text;
  owner_id constant uuid := 'f0000000-0000-4000-8000-000000000001';
  other_id constant uuid := 'f0000000-0000-4000-8000-000000000002';
  request_id constant uuid := 'f1000000-0000-4000-8000-000000000001';
  lease_owner constant uuid := 'f2000000-0000-4000-8000-000000000001';
  wrong_lease constant uuid := 'f2000000-0000-4000-8000-000000000002';
  owner_files jsonb := '[{"path":"f0000000-0000-4000-8000-000000000001/f3000000-0000-4000-8000-000000000001/f4000000-0000-4000-8000-000000000001.pdf","name":"notes.pdf","type":"application/pdf","size":42}]';
  other_files jsonb := '[{"path":"f0000000-0000-4000-8000-000000000002/f3000000-0000-4000-8000-000000000002/f4000000-0000-4000-8000-000000000002.pdf","name":"other.pdf","type":"application/pdf","size":42}]';
  retry_request constant uuid := 'f1000000-0000-4000-8000-000000000002';
  retry_lease uuid;
  attempt integer;
  lease_expiry_before timestamptz;
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.extraction_requests'::regclass
      AND conname = 'extraction_requests_request_id_key' AND contype = 'u'
  ), 'request UUID is not globally unique';
  ASSERT to_regprocedure('public.reserve_extraction(uuid,uuid,text)') IS NULL,
    'legacy reserve RPC still exists';
  ASSERT to_regprocedure('public.complete_extraction(uuid,uuid,text,integer,text,jsonb)') IS NULL,
    'legacy completion RPC still exists';
  ASSERT to_regprocedure('public.fail_extraction(uuid,uuid)') IS NULL,
    'legacy failure RPC still exists';

  result := public.enqueue_extraction(
    owner_id, request_id, repeat('a', 64),
    'Durable Systems', 2, 'Focus on leases', owner_files
  );
  ASSERT result->>'status' = 'queued', 'new request was not queued';
  ASSERT (result->>'remainingCredits')::integer = 9, 'queue did not charge once';
  result := public.enqueue_extraction(
    owner_id, request_id, repeat('a', 64),
    'Durable Systems', 2, 'Focus on leases', owner_files
  );
  ASSERT result->>'status' = 'queued', 'idempotent queue replay changed state';
  ASSERT (result->>'remainingCredits')::integer = 9, 'queue replay charged twice';

  result := public.enqueue_extraction(
    other_id, request_id, repeat('a', 64), 'Other Course', 1, '', other_files
  );
  ASSERT result->>'status' = 'conflict', 'cross-account request collision was accepted';
  ASSERT (SELECT credits FROM public.profiles WHERE id = other_id) = 3,
    'cross-account collision spent credits';

  result := public.claim_extraction_job(request_id, lease_owner, 180);
  ASSERT result->>'status' = 'processing' AND result->>'userId' = owner_id::text,
    'worker did not receive authoritative ownership';

  -- SQL three-valued logic makes `NULL NOT BETWEEN ...` evaluate to NULL, not
  -- true. Every required lease input must therefore be rejected explicitly so
  -- heartbeat cannot replace a live expiry with NULL and strand the job.
  SELECT lease_expires_at INTO lease_expiry_before
  FROM public.extraction_requests
  WHERE extraction_requests.request_id = 'f1000000-0000-4000-8000-000000000001';
  BEGIN
    PERFORM public.claim_extraction_job(request_id, lease_owner, NULL);
    RAISE EXCEPTION 'claim accepted a NULL lease duration';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.claim_extraction_job(NULL, lease_owner, 180);
    RAISE EXCEPTION 'claim accepted a NULL request ID';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.claim_extraction_job(request_id, NULL, 180);
    RAISE EXCEPTION 'claim accepted a NULL lease owner';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.heartbeat_extraction_job(request_id, lease_owner, NULL);
    RAISE EXCEPTION 'heartbeat accepted a NULL lease duration';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.heartbeat_extraction_job(NULL, lease_owner, 180);
    RAISE EXCEPTION 'heartbeat accepted a NULL request ID';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.heartbeat_extraction_job(request_id, NULL, 180);
    RAISE EXCEPTION 'heartbeat accepted a NULL lease owner';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  ASSERT (SELECT lease_expires_at = lease_expiry_before
    FROM public.extraction_requests
    WHERE extraction_requests.request_id = 'f1000000-0000-4000-8000-000000000001'),
    'invalid lease input changed or cleared the active lease';
  ASSERT NOT public.heartbeat_extraction_job(request_id, wrong_lease, 180),
    'wrong lease owner renewed the job';
  result := public.complete_extraction_job(
    request_id, wrong_lease,
    '[{"category":"Definition","topic":"Wrong","content":"No","shorthand":"no","priority":1}]'
  );
  ASSERT result->>'status' = 'processing', 'wrong lease owner completed the job';
  result := public.fail_extraction_job(request_id, wrong_lease, 'worker_error', false);
  ASSERT result->>'status' = 'processing', 'wrong lease owner failed the job';
  ASSERT (SELECT credits FROM public.profiles WHERE id = owner_id) = 9,
    'wrong lease owner changed credits';

  result := public.complete_extraction_job(
    request_id, lease_owner,
    '[{"category":"Definition","topic":"Lease","content":"Exclusive work ownership","shorthand":"lease","priority":8}]'
  );
  ASSERT result->>'status' = 'completed' AND result->>'materialId' IS NOT NULL,
    'leased worker did not complete atomically';
  result := public.complete_extraction_job(
    request_id, lease_owner,
    '[{"category":"Definition","topic":"Duplicate","content":"No","shorthand":"no","priority":1}]'
  );
  ASSERT result->>'status' = 'completed', 'completion replay was not idempotent';
  ASSERT (SELECT count(*) FROM public.course_materials WHERE user_id = owner_id) = 1,
    'completion replay created duplicate material';

  ASSERT jsonb_array_length(public.get_pending_extraction_cleanup_jobs(50)->'jobs') = 1,
    'completed job was not queued for cleanup';
  result := public.release_extraction_upload_reservations(request_id);
  ASSERT result->>'status' = 'released' AND (result->>'releasedCount')::integer = 1,
    'terminal cleanup did not release the reservation';
  ASSERT (SELECT uploads_cleaned_at IS NOT NULL FROM public.extraction_requests
    WHERE extraction_requests.request_id = 'f1000000-0000-4000-8000-000000000001'),
    'terminal cleanup was not marked durably';

  result := public.enqueue_extraction(
    owner_id, retry_request, repeat('b', 64), 'Retries', 1, '', owner_files
  );
  FOR attempt IN 1..3 LOOP
    retry_lease := ('f2000000-0000-4000-8000-' || lpad((10 + attempt)::text, 12, '0'))::uuid;
    result := public.claim_extraction_job(retry_request, retry_lease, 180);
    ASSERT (result->>'attemptCount')::integer = attempt, 'attempt count drifted';
    result := public.fail_extraction_job(
      retry_request, retry_lease, 'provider_transient', true
    );
    IF attempt < 3 THEN
      ASSERT result->>'status' = 'queued', 'retryable failure was not requeued';
    ELSE
      ASSERT result->>'status' = 'failed', 'retry exhaustion did not fail';
    END IF;
  END LOOP;
  ASSERT (SELECT credits FROM public.profiles WHERE id = owner_id) = 9,
    'retry exhaustion was not refunded exactly once';
  result := public.fail_extraction_job(retry_request, retry_lease, 'provider_transient', true);
  ASSERT result->>'status' = 'failed' AND (result->>'remainingCredits')::integer = 9,
    'retry exhaustion replay refunded twice';

  result := public.enqueue_extraction(
    owner_id, 'f1000000-0000-4000-8000-000000000003', repeat('c', 64),
    'Queue expiry', 1, '', owner_files
  );
  PERFORM pg_temp.backdate_extraction('f1000000-0000-4000-8000-000000000003');
  result := public.expire_extraction_jobs(50);
  ASSERT result->'jobs' @> '[{"requestId":"f1000000-0000-4000-8000-000000000003","failureCode":"queue_expired"}]'::jsonb,
    'stale queued job was not expired';
  ASSERT (SELECT credits FROM public.profiles WHERE id = owner_id) = 9,
    'queued expiry did not refund exactly once';
  result := public.expire_extraction_jobs(50);
  ASSERT jsonb_array_length(result->'jobs') = 0, 'expiry replay settled twice';

  result := public.enqueue_extraction(
    owner_id, 'f1000000-0000-4000-8000-000000000004', repeat('d', 64),
    'Dispatch', 1, '', owner_files
  );
  result := public.cancel_extraction_dispatch(other_id,
    'f1000000-0000-4000-8000-000000000004');
  ASSERT result->>'status' = 'missing', 'foreign owner cancelled dispatch';
  ASSERT (SELECT status FROM public.extraction_requests
    WHERE extraction_requests.request_id = 'f1000000-0000-4000-8000-000000000004') = 'queued',
    'foreign cancellation mutated the job';
  result := public.cancel_extraction_dispatch(owner_id,
    'f1000000-0000-4000-8000-000000000004');
  ASSERT result->>'failureCode' = 'dispatch_failed'
    AND (result->>'remainingCredits')::integer = 9,
    'dispatch cancellation did not refund';
  result := public.cancel_extraction_dispatch(owner_id,
    'f1000000-0000-4000-8000-000000000004');
  ASSERT (result->>'remainingCredits')::integer = 9,
    'dispatch cancellation replay refunded twice';

  result := public.enqueue_extraction(
    owner_id, 'f1000000-0000-4000-8000-000000000005', repeat('e', 64),
    'Held', 1, '', owner_files
  );
  result := public.claim_extraction_job(
    'f1000000-0000-4000-8000-000000000005',
    'f2000000-0000-4000-8000-000000000020', 180
  );

  FOREACH service_rpc IN ARRAY ARRAY[
    'public.enqueue_extraction(uuid,uuid,text,text,integer,text,jsonb)',
    'public.claim_extraction_job(uuid,uuid,integer)',
    'public.heartbeat_extraction_job(uuid,uuid,integer)',
    'public.complete_extraction_job(uuid,uuid,jsonb)',
    'public.fail_extraction_job(uuid,uuid,text,boolean)',
    'public.cancel_extraction_dispatch(uuid,uuid)',
    'public.expire_extraction_jobs(integer)',
    'public.release_extraction_upload_reservations(uuid)',
    'public.get_pending_extraction_cleanup_jobs(integer)'
  ] LOOP
    ASSERT has_function_privilege('service_role', service_rpc, 'EXECUTE'),
      'service role RPC grant missing: ' || service_rpc;
    ASSERT NOT has_function_privilege('authenticated', service_rpc, 'EXECUTE'),
      'authenticated service RPC grant leaked: ' || service_rpc;
    ASSERT NOT has_function_privilege('anon', service_rpc, 'EXECUTE'),
      'anonymous service RPC grant leaked: ' || service_rpc;
  END LOOP;
  ASSERT has_function_privilege('authenticated',
    'public.get_extraction_status(uuid)', 'EXECUTE'),
    'authenticated status grant missing';
  ASSERT NOT has_function_privilege('anon',
    'public.get_extraction_status(uuid)', 'EXECUTE'),
    'anonymous status grant leaked';
  ASSERT NOT has_function_privilege('service_role',
    'public.get_extraction_status(uuid)', 'EXECUTE'),
    'service role status grant leaked';

  ASSERT has_table_privilege('service_role', 'public.extraction_requests', 'SELECT'),
    'service role extraction status read missing';
  ASSERT NOT has_table_privilege('service_role', 'public.extraction_requests', 'INSERT')
    AND NOT has_table_privilege('service_role', 'public.extraction_requests', 'UPDATE')
    AND NOT has_table_privilege('service_role', 'public.extraction_requests', 'DELETE')
    AND NOT has_table_privilege('service_role', 'public.extraction_requests', 'TRUNCATE')
    AND NOT has_table_privilege('service_role', 'public.extraction_requests', 'REFERENCES')
    AND NOT has_table_privilege('service_role', 'public.extraction_requests', 'TRIGGER'),
    'service role can bypass extraction job RPCs with direct DML';
  ASSERT NOT has_table_privilege('authenticated', 'public.extraction_requests', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.extraction_requests', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.extraction_requests', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'public.extraction_requests', 'DELETE'),
    'authenticated direct extraction request privilege leaked';
  ASSERT NOT has_table_privilege('anon', 'public.extraction_requests', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.extraction_requests', 'INSERT')
    AND NOT has_table_privilege('anon', 'public.extraction_requests', 'UPDATE')
    AND NOT has_table_privilege('anon', 'public.extraction_requests', 'DELETE'),
    'anonymous direct extraction request privilege leaked';
  ASSERT has_table_privilege('service_role', 'public.course_materials', 'SELECT'),
    'service role course material read missing';
  ASSERT NOT has_table_privilege('service_role', 'public.course_materials', 'INSERT')
    AND NOT has_table_privilege('service_role', 'public.course_materials', 'UPDATE')
    AND NOT has_table_privilege('service_role', 'public.course_materials', 'DELETE')
    AND NOT has_table_privilege('service_role', 'public.course_materials', 'TRUNCATE')
    AND NOT has_table_privilege('service_role', 'public.course_materials', 'REFERENCES')
    AND NOT has_table_privilege('service_role', 'public.course_materials', 'TRIGGER'),
    'service role can bypass completion RPC with direct material DML';
  ASSERT has_table_privilege('authenticated', 'public.course_materials', 'SELECT'),
    'authenticated course material read missing';
END;
$$;

RESET ROLE;
INSERT INTO public.account_holds(user_id, reason, source, source_reference)
VALUES (
  'f0000000-0000-4000-8000-000000000001',
  'manual_review', 'system', 'durable-hold'
);
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL ROLE service_role;
DO $$
DECLARE result jsonb;
BEGIN
  result := public.complete_extraction_job(
    'f1000000-0000-4000-8000-000000000005',
    'f2000000-0000-4000-8000-000000000020',
    '[{"category":"Definition","topic":"Held","content":"No","shorthand":"no","priority":1}]'
  );
  ASSERT result->>'failureCode' = 'account_held'
    AND (result->>'remainingCredits')::integer = 9,
    'account hold did not reject and refund completion';
  ASSERT (SELECT count(*) FROM public.audit_events
    WHERE subject_user_id = 'f0000000-0000-4000-8000-000000000001'
      AND correlation_id = 'f1000000-0000-4000-8000-000000000005') = 1,
    'account hold rejection was not audited exactly once';
END;
$$;

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-000000000002', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE result jsonb;
BEGIN
  result := public.get_extraction_status('f1000000-0000-4000-8000-000000000001');
  ASSERT result->>'status' = 'missing', 'foreign job leaked through status';
END;
$$;

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'f0000000-0000-4000-8000-000000000001', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE result jsonb;
BEGIN
  result := public.get_extraction_status('f1000000-0000-4000-8000-000000000001');
  ASSERT result->>'status' = 'completed' AND result->>'materialId' IS NOT NULL,
    'owner could not read completed job';
END;
$$;

-- Corrupt historical state must fail closed. None of the charged terminal
-- transitions may settle a request if its refund/profile row disappeared.
RESET ROLE;
INSERT INTO auth.users (id, email, email_confirmed_at)
VALUES ('f0000000-0000-4000-8000-000000000003', 'missing-profile@school.edu', now());
INSERT INTO public.extraction_requests (
  user_id, request_id, fingerprint, status, charged, course_name,
  user_directive, target_pages, file_inputs, attempt_count,
  lease_owner, lease_expires_at, created_at
) VALUES
  ('f0000000-0000-4000-8000-000000000003', 'f1000000-0000-4000-8000-000000000031', repeat('1', 64), 'processing', true, 'Missing complete', '', 1, '[]', 1, 'f2000000-0000-4000-8000-000000000031', now() + interval '5 minutes', now()),
  ('f0000000-0000-4000-8000-000000000003', 'f1000000-0000-4000-8000-000000000032', repeat('2', 64), 'processing', true, 'Missing fail', '', 1, '[]', 1, 'f2000000-0000-4000-8000-000000000032', now() + interval '5 minutes', now()),
  ('f0000000-0000-4000-8000-000000000003', 'f1000000-0000-4000-8000-000000000033', repeat('3', 64), 'queued', true, 'Missing cancel', '', 1, '[]', 0, NULL, NULL, now()),
  ('f0000000-0000-4000-8000-000000000003', 'f1000000-0000-4000-8000-000000000034', repeat('4', 64), 'queued', true, 'Missing expire', '', 1, '[]', 0, NULL, NULL, now() - interval '31 minutes');
DELETE FROM public.profiles
WHERE id = 'f0000000-0000-4000-8000-000000000003';
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    PERFORM public.complete_extraction_job(
      'f1000000-0000-4000-8000-000000000031',
      'f2000000-0000-4000-8000-000000000031',
      '[{"category":"Definition","topic":"Missing","content":"No","shorthand":"no","priority":1}]'
    );
    RAISE EXCEPTION 'completion settled a charged request without a profile';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.fail_extraction_job(
      'f1000000-0000-4000-8000-000000000032',
      'f2000000-0000-4000-8000-000000000032', 'worker_error', false
    );
    RAISE EXCEPTION 'failure settled a charged request without a profile';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.cancel_extraction_dispatch(
      'f0000000-0000-4000-8000-000000000003',
      'f1000000-0000-4000-8000-000000000033'
    );
    RAISE EXCEPTION 'cancellation settled a charged request without a profile';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.expire_extraction_jobs(50);
    RAISE EXCEPTION 'expiry settled a charged request without a profile';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  ASSERT (SELECT status FROM public.extraction_requests WHERE request_id = 'f1000000-0000-4000-8000-000000000031') = 'processing',
    'failed completion mutated corrupt charged request';
  ASSERT (SELECT status FROM public.extraction_requests WHERE request_id = 'f1000000-0000-4000-8000-000000000032') = 'processing',
    'failed failure transition mutated corrupt charged request';
  ASSERT (SELECT status FROM public.extraction_requests WHERE request_id = 'f1000000-0000-4000-8000-000000000033') = 'queued',
    'failed cancellation mutated corrupt charged request';
  ASSERT (SELECT status FROM public.extraction_requests WHERE request_id = 'f1000000-0000-4000-8000-000000000034') = 'queued',
    'failed expiry mutated corrupt charged request';
END;
$$;

ROLLBACK;
