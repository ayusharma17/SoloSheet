-- Run as database owner against an isolated database after phase 18.
-- All fixtures and writes roll back. Never run against production.
BEGIN;

-- Create verified historical identities, then remove the profiles that the
-- current signup trigger correctly provisioned so the legacy gap is simulated.
INSERT INTO public.admin_whitelist (email, reason)
VALUES ('repair-admin@example.com', 'Profile recovery regression fixture');

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'repair@school.edu', now()),
  ('e0000000-0000-4000-8000-000000000002', 'repair@example.com', now()),
  ('e0000000-0000-4000-8000-000000000003', 'repair-admin@example.com', now()),
  ('e0000000-0000-4000-8000-000000000004', 'existing@example.com', now()),
  ('e0000000-0000-4000-8000-000000000005', 'unverified@example.com', now());

DELETE FROM public.profiles
WHERE id IN (
  'e0000000-0000-4000-8000-000000000001',
  'e0000000-0000-4000-8000-000000000002',
  'e0000000-0000-4000-8000-000000000003',
  'e0000000-0000-4000-8000-000000000005'
);
UPDATE auth.users SET email_confirmed_at = NULL
WHERE id = 'e0000000-0000-4000-8000-000000000005';
UPDATE public.profiles SET credits = 7
WHERE id = 'e0000000-0000-4000-8000-000000000004';

-- Anonymous callers and service-role callers cannot invoke self-repair.
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claim.role', 'anon', true);
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM public.repair_missing_profile();
    RAISE EXCEPTION 'Anonymous caller repaired a profile';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
RESET ROLE;

SELECT set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    PERFORM public.repair_missing_profile();
    RAISE EXCEPTION 'Service role repaired a user profile';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
RESET ROLE;

-- A forged JWT role claim cannot bypass the database EXECUTE grants. This
-- models an untrusted caller changing request GUCs without obtaining the
-- authenticated database role that PostgREST assigns only after JWT checks.
SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM public.repair_missing_profile();
    RAISE EXCEPTION 'Anonymous role repaired a profile with forged claims';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
RESET ROLE;

SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    PERFORM public.repair_missing_profile();
    RAISE EXCEPTION 'Service role repaired a profile with forged claims';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
RESET ROLE;

-- A verified user may repair only the profile bound to its JWT subject.
SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  result jsonb;
BEGIN
  result := public.repair_missing_profile();
  IF result->>'status' IS DISTINCT FROM 'repaired' THEN
    RAISE EXCEPTION 'Verified educational identity was not repaired';
  END IF;
END;
$$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT credits FROM public.profiles
      WHERE id = 'e0000000-0000-4000-8000-000000000001') IS DISTINCT FROM 0
    OR (SELECT trial_granted_at FROM public.profiles
        WHERE id = 'e0000000-0000-4000-8000-000000000001') IS NOT NULL THEN
    RAISE EXCEPTION 'Educational historical repair received promotional state';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles
      WHERE id = 'e0000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'Self-repair affected a different user';
  END IF;
END;
$$;

-- Current launch flag state must not grant a non-.edu historical repair.
SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-4000-8000-000000000002', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT public.repair_missing_profile();
RESET ROLE;

-- Allowlisted administrators still have a zero finite balance; unlimited
-- behavior continues to be determined by the existing administrator checks.
SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-4000-8000-000000000003', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT public.repair_missing_profile();
RESET ROLE;

-- Existing profiles are returned unchanged, and repeats emit no repair event.
SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-4000-8000-000000000004', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  result jsonb;
BEGIN
  result := public.repair_missing_profile();
  IF result->>'status' IS DISTINCT FROM 'existing' THEN
    RAISE EXCEPTION 'Existing profile was not recognized';
  END IF;
END;
$$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT public.repair_missing_profile();
RESET ROLE;

-- An unverified identity cannot repair itself.
SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-4000-8000-000000000005', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.repair_missing_profile();
    RAISE EXCEPTION 'Unverified identity repaired a profile';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT credits FROM public.profiles
      WHERE id = 'e0000000-0000-4000-8000-000000000002') IS DISTINCT FROM 0
    OR (SELECT trial_granted_at FROM public.profiles
        WHERE id = 'e0000000-0000-4000-8000-000000000002') IS NOT NULL
    OR (SELECT credits FROM public.profiles
        WHERE id = 'e0000000-0000-4000-8000-000000000003') IS DISTINCT FROM 0
    OR (SELECT trial_granted_at FROM public.profiles
        WHERE id = 'e0000000-0000-4000-8000-000000000003') IS NOT NULL THEN
    RAISE EXCEPTION 'Historical repair granted promotional or admin credits';
  END IF;
  IF (SELECT credits FROM public.profiles
      WHERE id = 'e0000000-0000-4000-8000-000000000004') IS DISTINCT FROM 7 THEN
    RAISE EXCEPTION 'Existing balance was changed by repair';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles
      WHERE id = 'e0000000-0000-4000-8000-000000000005') THEN
    RAISE EXCEPTION 'Unverified identity left a profile behind';
  END IF;
  IF (SELECT count(*) FROM public.audit_events
      WHERE event_type = 'profile.repaired'
        AND subject_user_id IN (
          'e0000000-0000-4000-8000-000000000001',
          'e0000000-0000-4000-8000-000000000002',
          'e0000000-0000-4000-8000-000000000003'
        )
        AND actor_user_id = subject_user_id
        AND reason = 'Missing profile repaired after verified authentication'
        AND metadata = '{"source":"authenticated_self_repair"}'::jsonb) <> 3 THEN
    RAISE EXCEPTION 'Repair audit was missing, duplicated, or over-collected identity data';
  END IF;
  IF EXISTS (SELECT 1 FROM public.audit_events
      WHERE event_type = 'profile.repaired'
        AND subject_user_id = 'e0000000-0000-4000-8000-000000000004') THEN
    RAISE EXCEPTION 'Existing profile emitted a repair audit';
  END IF;
  IF has_function_privilege('anon', 'public.repair_missing_profile()', 'EXECUTE')
    OR has_function_privilege('service_role', 'public.repair_missing_profile()', 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.repair_missing_profile()', 'EXECUTE')
    OR has_table_privilege('authenticated', 'public.profiles', 'INSERT') THEN
    RAISE EXCEPTION 'Profile recovery privileges are broader or narrower than intended';
  END IF;
END;
$$;

ROLLBACK;
