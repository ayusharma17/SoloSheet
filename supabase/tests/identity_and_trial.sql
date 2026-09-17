-- Run as database owner against an isolated database after phase 10.
-- All fixtures and writes roll back. Never run against production.
BEGIN;

INSERT INTO public.admin_whitelist (email, reason)
VALUES ('initial-admin@example.com', 'Identity regression fixture');

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'initial-admin@example.com', now()),
  ('c0000000-0000-4000-8000-000000000002', 'student@school.edu', now());

DO $$
BEGIN
  IF (SELECT credits FROM public.profiles WHERE id = 'c0000000-0000-4000-8000-000000000001') <> 0
    OR (SELECT trial_granted_at FROM public.profiles WHERE id = 'c0000000-0000-4000-8000-000000000001') IS NOT NULL THEN
    RAISE EXCEPTION 'Administrator received a finite placeholder balance or trial';
  END IF;
  IF (SELECT credits FROM public.profiles WHERE id = 'c0000000-0000-4000-8000-000000000002') <> 1
    OR (SELECT trial_granted_at FROM public.profiles WHERE id = 'c0000000-0000-4000-8000-000000000002') IS NULL THEN
    RAISE EXCEPTION 'Eligible student did not receive exactly one recorded trial';
  END IF;
  IF (SELECT count(*) FROM public.audit_events
      WHERE subject_user_id = 'c0000000-0000-4000-8000-000000000002'
        AND event_type = 'trial.granted') <> 1 THEN
    RAISE EXCEPTION 'Trial grant was not audited exactly once';
  END IF;

  BEGIN
    INSERT INTO auth.users (id, email, email_confirmed_at)
    VALUES ('c0000000-0000-4000-8000-000000000003', 'outsider@example.com', now());
    RAISE EXCEPTION 'Non-educational signup succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    INSERT INTO auth.users (id, email, email_confirmed_at)
    VALUES ('c0000000-0000-4000-8000-000000000004', 'unverified@school.edu', NULL);
    RAISE EXCEPTION 'Unverified signup succeeded';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END;
$$;

SELECT set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.admin_whitelist (email, reason)
    VALUES ('bypass@example.com', 'Attempt to bypass audited workflow');
    RAISE EXCEPTION 'Service role bypassed audited administrator workflow';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
SELECT public.set_administrator_access(
  'NEW-ADMIN@example.com', true,
  'c0000000-0000-4000-8000-000000000001',
  'Add second administrator for regression coverage',
  'c1000000-0000-4000-8000-000000000001'
);
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_whitelist
    WHERE email = 'new-admin@example.com' AND is_active
  ) THEN
    RAISE EXCEPTION 'Audited administrator grant failed';
  END IF;
  IF (SELECT count(*) FROM public.audit_events
      WHERE event_type = 'administrator.access_granted'
        AND actor_user_id = 'c0000000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'Administrator grant audit missing';
  END IF;
END;
$$;

SELECT set_config('request.jwt.claim.sub', 'c0000000-0000-4000-8000-000000000002', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.set_administrator_access(
      'attacker@example.com', true,
      'c0000000-0000-4000-8000-000000000002',
      'Self enrollment', gen_random_uuid()
    );
    RAISE EXCEPTION 'Ordinary user changed administrator access';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
RESET ROLE;

ROLLBACK;
