-- Run as database owner against an isolated database after phase 6 (or later).
-- Requires Supabase auth.uid()/auth.role() helpers and anon/authenticated roles.
-- All fixtures and writes roll back. Never run against production.
BEGIN;
INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'security-one@example.edu'),
  ('a0000000-0000-4000-8000-000000000002', 'security-two@example.edu');
INSERT INTO public.profiles (id, email, credits) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'security-one@example.edu', 1),
  ('a0000000-0000-4000-8000-000000000002', 'security-two@example.edu', 1)
  ON CONFLICT (id) DO UPDATE SET credits = 1;
SELECT set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.profiles) <> 1 THEN
    RAISE EXCEPTION 'Users must see only their own profile';
  END IF;
  BEGIN
    PERFORM public.add_credits('a0000000-0000-4000-8000-000000000001', 100);
    RAISE EXCEPTION 'Self credit grant succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.decrement_credits('a0000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'Cross-user credit debit succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.profiles SET credits = 100 WHERE id = auth.uid();
    RAISE EXCEPTION 'Direct balance update succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO public.admin_whitelist(email) VALUES ('attacker@example.edu');
    RAISE EXCEPTION 'Admin self-enrollment succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM email FROM public.admin_whitelist;
    RAISE EXCEPTION 'Admin whitelist disclosure succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.register_device_fingerprint(NULL);
    RAISE EXCEPTION 'Null fingerprint accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END;
$$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM public.add_credits('a0000000-0000-4000-8000-000000000001', 1);
    RAISE EXCEPTION 'Anonymous credit grant succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
RESET ROLE;
-- Execution grants are not the only boundary: a service-role SQL connection
-- with an authenticated JWT must still fail the in-function authorization.
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    PERFORM public.add_credits('a0000000-0000-4000-8000-000000000001', 1);
    RAISE EXCEPTION 'Caller authorization bypass succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
RESET ROLE;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    PERFORM public.add_credits('a0000000-0000-4000-8000-000000000001', -1);
    RAISE EXCEPTION 'Negative credit grant accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  PERFORM public.add_credits('a0000000-0000-4000-8000-000000000001', 2);
END;
$$;
RESET ROLE;
DO $$
BEGIN
  IF (SELECT credits FROM public.profiles WHERE id = 'a0000000-0000-4000-8000-000000000001') <> 3
    OR (SELECT credits FROM public.profiles WHERE id = 'a0000000-0000-4000-8000-000000000002') <> 1 THEN
    RAISE EXCEPTION 'Credit balances are incorrect';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN
      ('add_credits', 'decrement_credits', 'handle_new_user', 'register_device_fingerprint', 'cleanup_old_course_materials')
    AND p.prosecdef AND NOT ('search_path=""' = ANY(coalesce(p.proconfig, ARRAY[]::text[])))) THEN
    RAISE EXCEPTION 'Unsafe SECURITY DEFINER search_path';
  END IF;
END;
$$;
ROLLBACK;
