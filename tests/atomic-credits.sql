-- Isolated test database only. Requires migrations through phase11 and fixture
-- auth.users/profiles ID below. Run psql -v ON_ERROR_STOP=1 -f this-file.
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
UPDATE public.profiles SET credits = 1 WHERE id = '10000000-0000-4000-8000-000000000001';
DO $$
DECLARE r jsonb; u uuid := '10000000-0000-4000-8000-000000000001'; a uuid := '20000000-0000-4000-8000-000000000001'; b uuid := '20000000-0000-4000-8000-000000000002';
BEGIN
  r := public.reserve_extraction(u,a,repeat('a',64));
  ASSERT r->>'status' = 'reserved', 'first request reserves';
  r := public.reserve_extraction(u,b,repeat('b',64));
  ASSERT r->>'status' = 'no_credits', 'second request cannot share credit';
  r := public.reserve_extraction(u,a,repeat('a',64));
  ASSERT r->>'status' = 'processing', 'replay cannot launch second provider';
  r := public.reserve_extraction(u,a,repeat('b',64));
  ASSERT r->>'status' = 'conflict', 'request identity is bound';
  r := public.complete_extraction(u,a,'test',1,'','[]');
  ASSERT r->>'materialId' IS NOT NULL, 'completion saves sheet';
  r := public.fail_extraction(u,a);
  ASSERT r->>'status' = 'completed' AND (r->>'remainingCredits')::int = 0, 'ambiguous commit never refunded';
  r := public.reserve_extraction(u,a,repeat('a',64));
  ASSERT r->>'status' = 'completed', 'completion replay returns existing';
  UPDATE public.profiles SET credits = 1 WHERE id = u;
  r := public.reserve_extraction(u,b,repeat('b',64));
  r := public.fail_extraction(u,b);
  ASSERT (r->>'remainingCredits')::int = 1, 'failure refund';
  r := public.fail_extraction(u,b);
  ASSERT (r->>'remainingCredits')::int = 1, 'refund idempotency';
  BEGIN
    PERFORM public.complete_extraction(u,b,'test',1,'','[]');
    RAISE EXCEPTION 'late completion incorrectly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'No active reservation' THEN RAISE; END IF;
  END;
  r := public.reserve_extraction(u,'20000000-0000-4000-8000-000000000003',repeat('c',64));
  UPDATE public.extraction_requests SET created_at = now() - interval '11 minutes' WHERE user_id = u AND status = 'processing';
  r := public.reserve_extraction(u,'20000000-0000-4000-8000-000000000004',repeat('d',64));
  ASSERT r->>'status' = 'reserved' AND (r->>'remainingCredits')::int = 0, 'crashed worker recovered';
  r := public.fail_extraction(u,'20000000-0000-4000-8000-000000000004');
  ASSERT (r->>'remainingCredits')::int = 1, 'recovered request can be refunded';

  INSERT INTO public.account_holds(user_id, reason, source, source_reference)
  VALUES (u, 'manual_review', 'system', 'hold-before-reserve');
  r := public.reserve_extraction(u,'20000000-0000-4000-8000-000000000005',repeat('e',64));
  ASSERT r->>'status' = 'account_held' AND (r->>'remainingCredits')::int = 1,
    'active hold blocks reservation without spending';
  UPDATE public.account_holds SET status = 'released', released_at = now(),
    release_reason = 'Continue regression test'
  WHERE source_reference = 'hold-before-reserve';

  r := public.reserve_extraction(u,'20000000-0000-4000-8000-000000000005',repeat('e',64));
  ASSERT r->>'status' = 'reserved', 'reservation succeeds after hold release';
  INSERT INTO public.account_holds(user_id, reason, source, source_reference)
  VALUES (u, 'manual_review', 'system', 'hold-before-completion');
  r := public.complete_extraction(
    u,'20000000-0000-4000-8000-000000000005','held',1,'','[]'
  );
  ASSERT r->>'status' = 'account_held' AND (r->>'remainingCredits')::int = 1,
    'hold during processing blocks completion and refunds';
  ASSERT (SELECT status FROM public.extraction_requests
    WHERE user_id = u AND request_id = '20000000-0000-4000-8000-000000000005') = 'failed',
    'held completion closes reservation';
  ASSERT (SELECT count(*) FROM public.audit_events
    WHERE subject_user_id = u AND event_type = 'extraction.blocked_by_hold') = 1,
    'held completion is audited';

  ASSERT NOT has_function_privilege('authenticated','public.reserve_extraction(uuid,uuid,text)','EXECUTE'), 'authenticated reserve forbidden';
  ASSERT to_regprocedure('public.reserve_extraction(uuid,uuid,text,boolean)') IS NULL,
    'caller-controlled admin signature still exists';
  ASSERT NOT has_function_privilege('anon','public.fail_extraction(uuid,uuid)','EXECUTE'), 'anonymous refund forbidden';
  ASSERT NOT has_table_privilege('authenticated','public.course_materials','INSERT'), 'client sheet insertion forbidden';
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  BEGIN
    PERFORM public.fail_extraction(u,a);
    RAISE EXCEPTION 'unauthorized function call succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

SELECT set_config('request.jwt.claim.role', 'service_role', true);
INSERT INTO auth.users(id, email, email_confirmed_at)
VALUES ('10000000-0000-4000-8000-000000000002', 'ayush170505@gmail.com', now());
DO $$
DECLARE
  r jsonb;
  admin_id uuid := '10000000-0000-4000-8000-000000000002';
BEGIN
  r := public.reserve_extraction(
    admin_id, '20000000-0000-4000-8000-000000000006', repeat('f',64)
  );
  ASSERT r->>'status' = 'reserved', 'administrator first bypass reserves';
  r := public.reserve_extraction(
    admin_id, '20000000-0000-4000-8000-000000000007', repeat('f',64)
  );
  ASSERT r->>'status' = 'reserved', 'administrator concurrent bypass reserves';
  ASSERT (SELECT credits FROM public.profiles WHERE id = admin_id) = 0,
    'administrator bypass changed finite balance';
  ASSERT (SELECT count(*) FROM public.audit_events
    WHERE subject_user_id = admin_id
      AND event_type = 'administrator.extraction_bypassed') = 2,
    'administrator bypasses were not audited exactly once';
  ASSERT (SELECT count(*) FROM public.extraction_requests
    WHERE user_id = admin_id AND charged) = 0,
    'administrator request was marked charged';
END $$;
ROLLBACK;
