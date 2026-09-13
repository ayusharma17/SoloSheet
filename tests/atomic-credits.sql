-- Isolated test database only. Requires migrations through phase7 and fixture
-- auth.users/profiles ID below. Run psql -v ON_ERROR_STOP=1 -f this-file.
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
UPDATE public.profiles SET credits = 1 WHERE id = '10000000-0000-4000-8000-000000000001';
DO $$
DECLARE r jsonb; u uuid := '10000000-0000-4000-8000-000000000001'; a uuid := '20000000-0000-4000-8000-000000000001'; b uuid := '20000000-0000-4000-8000-000000000002';
BEGIN
  r := public.reserve_extraction(u,a,repeat('a',64),false);
  ASSERT r->>'status' = 'reserved', 'first request reserves';
  r := public.reserve_extraction(u,b,repeat('b',64),false);
  ASSERT r->>'status' = 'no_credits', 'second request cannot share credit';
  r := public.reserve_extraction(u,a,repeat('a',64),false);
  ASSERT r->>'status' = 'processing', 'replay cannot launch second provider';
  r := public.reserve_extraction(u,a,repeat('b',64),false);
  ASSERT r->>'status' = 'conflict', 'request identity is bound';
  r := public.complete_extraction(u,a,'test',1,'','[]');
  ASSERT r->>'materialId' IS NOT NULL, 'completion saves sheet';
  r := public.fail_extraction(u,a);
  ASSERT r->>'status' = 'completed' AND (r->>'remainingCredits')::int = 0, 'ambiguous commit never refunded';
  r := public.reserve_extraction(u,a,repeat('a',64),false);
  ASSERT r->>'status' = 'completed', 'completion replay returns existing';
  UPDATE public.profiles SET credits = 1 WHERE id = u;
  r := public.reserve_extraction(u,b,repeat('b',64),false);
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
  r := public.reserve_extraction(u,'20000000-0000-4000-8000-000000000003',repeat('c',64),false);
  UPDATE public.extraction_requests SET created_at = now() - interval '11 minutes' WHERE user_id = u AND status = 'processing';
  r := public.reserve_extraction(u,'20000000-0000-4000-8000-000000000004',repeat('d',64),false);
  ASSERT r->>'status' = 'reserved' AND (r->>'remainingCredits')::int = 0, 'crashed worker recovered';
  ASSERT NOT has_function_privilege('authenticated','public.reserve_extraction(uuid,uuid,text,boolean)','EXECUTE'), 'authenticated reserve forbidden';
  ASSERT NOT has_function_privilege('anon','public.fail_extraction(uuid,uuid)','EXECUTE'), 'anonymous refund forbidden';
  ASSERT NOT has_table_privilege('authenticated','public.course_materials','INSERT'), 'client sheet insertion forbidden';
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  BEGIN
    PERFORM public.fail_extraction(u,a);
    RAISE EXCEPTION 'unauthorized function call succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;
