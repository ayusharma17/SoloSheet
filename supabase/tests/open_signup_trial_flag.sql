-- Run as database owner against an isolated database after phase 17.
-- All fixtures and writes roll back. Never run against production.
BEGIN;

INSERT INTO public.admin_whitelist (email, reason)
VALUES ('flag-admin@example.com', 'Trial flag regression fixture');

-- The launch default is on. Administrator behavior remains zero finite credits;
-- both educational and non-educational ordinary users receive one trial.
INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'flag-admin@example.com', now()),
  ('d0000000-0000-4000-8000-000000000002', 'launch@school.edu', now()),
  ('d0000000-0000-4000-8000-000000000003', 'launch@example.com', now());

DO $$
BEGIN
  IF (SELECT credits FROM public.profiles
      WHERE id = 'd0000000-0000-4000-8000-000000000001') IS DISTINCT FROM 0
    OR (SELECT trial_granted_at FROM public.profiles
        WHERE id = 'd0000000-0000-4000-8000-000000000001') IS NOT NULL THEN
    RAISE EXCEPTION 'Administrator trial behavior changed';
  END IF;
  IF (SELECT credits FROM public.profiles
      WHERE id = 'd0000000-0000-4000-8000-000000000002') IS DISTINCT FROM 1
    OR (SELECT credits FROM public.profiles
        WHERE id = 'd0000000-0000-4000-8000-000000000003') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Launch default did not grant both ordinary account classes';
  END IF;
  IF (SELECT metadata->>'eligibility' FROM public.audit_events
      WHERE subject_user_id = 'd0000000-0000-4000-8000-000000000002'
        AND event_type = 'trial.granted') IS DISTINCT FROM 'edu_email' THEN
    RAISE EXCEPTION 'Educational trial audit metadata is inaccurate';
  END IF;
  IF (SELECT metadata->>'eligibility' FROM public.audit_events
      WHERE subject_user_id = 'd0000000-0000-4000-8000-000000000003'
        AND event_type = 'trial.granted') IS DISTINCT FROM 'non_edu_launch_promotion' THEN
    RAISE EXCEPTION 'Non-educational trial audit metadata is inaccurate';
  END IF;
END;
$$;

-- Neither clients nor the service role can bypass the audited control plane.
SELECT set_config('request.jwt.claim.sub', 'd0000000-0000-4000-8000-000000000003', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM enabled FROM public.private_feature_flags;
    RAISE EXCEPTION 'Ordinary user read private feature flags';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.get_non_edu_trial_credits_enabled(
      'd0000000-0000-4000-8000-000000000003', 'Unauthorized read', gen_random_uuid()
    );
    RAISE EXCEPTION 'Ordinary user called the flag read workflow';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
RESET ROLE;

SELECT set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL ROLE service_role;
DO $$
DECLARE
  privilege_name text;
BEGIN
  FOREACH privilege_name IN ARRAY ARRAY[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ] LOOP
    IF has_table_privilege(
      'service_role',
      'public.private_feature_flags',
      privilege_name
    ) THEN
      RAISE EXCEPTION 'Service role retained direct feature-flag % privilege',
        privilege_name;
    END IF;
  END LOOP;
  IF public.get_non_edu_trial_credits_enabled(
      'd0000000-0000-4000-8000-000000000001',
      'Verify launch setting',
      'd1000000-0000-4000-8000-000000000001'
    ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Audited launch flag read returned the wrong value';
  END IF;
  PERFORM public.set_non_edu_trial_credits_enabled(
    false,
    'd0000000-0000-4000-8000-000000000001',
    'Pause non-educational launch promotion',
    'd1000000-0000-4000-8000-000000000002'
  );

  BEGIN
    PERFORM public.set_non_edu_trial_credits_enabled(
      true,
      'd0000000-0000-4000-8000-000000000003',
      'Attempt non-administrator change',
      'd1000000-0000-4000-8000-000000000004'
    );
    RAISE EXCEPTION 'Service role named a non-administrator as flag actor';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    PERFORM public.set_non_edu_trial_credits_enabled(
      true,
      'd0000000-0000-4000-8000-000000000001',
      '   ',
      'd1000000-0000-4000-8000-000000000005'
    );
    RAISE EXCEPTION 'Blank feature-flag reason was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END;
$$;
RESET ROLE;

-- A forged service-role claim is insufficient without the database role, and
-- the database role is insufficient without the trusted PostgREST claim.
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.get_non_edu_trial_credits_enabled(
      'd0000000-0000-4000-8000-000000000001',
      'Forged service claim',
      'd1000000-0000-4000-8000-000000000006'
    );
    RAISE EXCEPTION 'A service-role claim bypassed the function ACL';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
RESET ROLE;

SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    PERFORM public.get_non_edu_trial_credits_enabled(
      'd0000000-0000-4000-8000-000000000001',
      'Missing service claim',
      'd1000000-0000-4000-8000-000000000007'
    );
    RAISE EXCEPTION 'The database role bypassed the trusted claim check';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
RESET ROLE;

-- With the flag off, .edu remains eligible while all other verified accounts
-- are created normally with zero credits and no trial marker/event.
INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('d0000000-0000-4000-8000-000000000004', 'always@school.edu', now()),
  ('d0000000-0000-4000-8000-000000000005', 'zero@example.com', now());

INSERT INTO public.admin_whitelist (email, reason)
VALUES ('flag-off-admin@example.com', 'Flag-off administrator regression fixture');
INSERT INTO auth.users (id, email, email_confirmed_at)
VALUES ('d0000000-0000-4000-8000-000000000009', 'flag-off-admin@example.com', now());

DO $$
BEGIN
  IF (SELECT credits FROM public.profiles
      WHERE id = 'd0000000-0000-4000-8000-000000000004') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Educational trial depended on the non-educational flag';
  END IF;
  IF (SELECT credits FROM public.profiles
      WHERE id = 'd0000000-0000-4000-8000-000000000005') IS DISTINCT FROM 0
    OR (SELECT trial_granted_at FROM public.profiles
        WHERE id = 'd0000000-0000-4000-8000-000000000005') IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM public.audit_events
      WHERE subject_user_id = 'd0000000-0000-4000-8000-000000000005'
        AND event_type = 'trial.granted'
    ) THEN
    RAISE EXCEPTION 'Flag-off account received trial state or was not created';
  END IF;
  IF (SELECT credits FROM public.profiles
      WHERE id = 'd0000000-0000-4000-8000-000000000003') IS DISTINCT FROM 1
    OR (SELECT trial_granted_at FROM public.profiles
        WHERE id = 'd0000000-0000-4000-8000-000000000003') IS NULL THEN
    RAISE EXCEPTION 'Turning the flag off changed an existing trial account';
  END IF;
  IF (SELECT credits FROM public.profiles
      WHERE id = 'd0000000-0000-4000-8000-000000000009') IS DISTINCT FROM 0
    OR (SELECT trial_granted_at FROM public.profiles
        WHERE id = 'd0000000-0000-4000-8000-000000000009') IS NOT NULL THEN
    RAISE EXCEPTION 'Flag-off administrator behavior changed';
  END IF;
  IF (SELECT enabled FROM public.private_feature_flags
      WHERE key = 'non_edu_trial_credits_enabled') IS DISTINCT FROM false
    OR EXISTS (
      SELECT 1 FROM public.audit_events
      WHERE correlation_id IN (
        'd1000000-0000-4000-8000-000000000004',
        'd1000000-0000-4000-8000-000000000005'
      )
    ) THEN
    RAISE EXCEPTION 'Rejected feature-flag changes mutated state or audit history';
  END IF;
  IF (SELECT count(*) FROM public.audit_events
      WHERE correlation_id = 'd1000000-0000-4000-8000-000000000001'
        AND event_type = 'configuration.read'
        AND actor_user_id = 'd0000000-0000-4000-8000-000000000001'
        AND metadata->>'current_value' = 'true') <> 1 THEN
    RAISE EXCEPTION 'Feature-flag read audit is missing or inaccurate';
  END IF;
  IF (SELECT count(*) FROM public.audit_events
      WHERE correlation_id = 'd1000000-0000-4000-8000-000000000002'
        AND event_type = 'configuration.changed'
        AND actor_user_id = 'd0000000-0000-4000-8000-000000000001'
        AND metadata->>'old_value' = 'true'
        AND metadata->>'new_value' = 'false') <> 1 THEN
    RAISE EXCEPTION 'Feature-flag change audit is missing or inaccurate';
  END IF;
END;
$$;

-- A flag-off non-.edu account cannot extract at zero credits, but remains a
-- normal purchase-capable account. Paid fulfillment is independent of domain
-- and does not create or rewrite promotional trial state.
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL ROLE service_role;
DO $$
DECLARE result jsonb;
BEGIN
  result := public.reserve_extraction(
    'd0000000-0000-4000-8000-000000000005',
    'd2000000-0000-4000-8000-000000000001',
    repeat('a', 64)
  );
  IF result->>'status' IS DISTINCT FROM 'no_credits' THEN
    RAISE EXCEPTION 'Flag-off zero-credit account was allowed to extract';
  END IF;
END;
$$;
SELECT public.create_pending_stripe_purchase(
  'd3000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000005',
  'price_solosheet_test', false
);
SELECT public.attach_stripe_checkout_session(
  'd3000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000005',
  'cs_test_flag_off_non_edu'
);
SELECT public.fulfill_stripe_checkout(
  'evt_flag_off_non_edu',
  'd3000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000005',
  'cs_test_flag_off_non_edu', 'pi_test_flag_off_non_edu',
  'price_solosheet_test', 300, 'usd', false, now()
);
RESET ROLE;

DO $$
BEGIN
  IF (SELECT credits FROM public.profiles
      WHERE id = 'd0000000-0000-4000-8000-000000000005') IS DISTINCT FROM 10
    OR (SELECT trial_granted_at FROM public.profiles
        WHERE id = 'd0000000-0000-4000-8000-000000000005') IS NOT NULL THEN
    RAISE EXCEPTION 'Paid fulfillment did not preserve zero-credit trial history';
  END IF;
  IF (SELECT enabled FROM public.private_feature_flags
      WHERE key = 'non_edu_trial_credits_enabled') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Paid fulfillment changed the trial feature flag';
  END IF;
END;
$$;

-- Auth retries cannot create another auth identity/profile or another grant.
DO $$
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email, email_confirmed_at)
    VALUES ('d0000000-0000-4000-8000-000000000002', 'launch@school.edu', now());
    RAISE EXCEPTION 'Duplicate auth identity unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  IF (SELECT credits FROM public.profiles
      WHERE id = 'd0000000-0000-4000-8000-000000000002') IS DISTINCT FROM 1
    OR (SELECT count(*) FROM public.audit_events
        WHERE subject_user_id = 'd0000000-0000-4000-8000-000000000002'
          AND event_type = 'trial.granted') <> 1 THEN
    RAISE EXCEPTION 'Repeated signup changed the one-time trial';
  END IF;

  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES ('d0000000-0000-4000-8000-000000000006', 'unverified@example.com', NULL);
  IF EXISTS (SELECT 1 FROM public.profiles
      WHERE id = 'd0000000-0000-4000-8000-000000000006') THEN
    RAISE EXCEPTION 'Unverified identity left a profile behind';
  END IF;
  UPDATE auth.users SET email_confirmed_at = now()
  WHERE id = 'd0000000-0000-4000-8000-000000000006';
  IF (SELECT credits FROM public.profiles
      WHERE id = 'd0000000-0000-4000-8000-000000000006') IS DISTINCT FROM 0
    OR (SELECT trial_granted_at FROM public.profiles
        WHERE id = 'd0000000-0000-4000-8000-000000000006') IS NOT NULL THEN
    RAISE EXCEPTION 'Delayed non-educational confirmation did not follow the Off policy';
  END IF;

  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES ('d0000000-0000-4000-8000-000000000010', NULL, now());
  IF EXISTS (SELECT 1 FROM public.profiles
      WHERE id = 'd0000000-0000-4000-8000-000000000010') THEN
    RAISE EXCEPTION 'Missing-email identity left a profile behind';
  END IF;
END;
$$;

-- Simulate a damaged/missing optional setting. Signup must continue, and only
-- non-.edu promotional cost fails closed.
DELETE FROM public.private_feature_flags
WHERE key = 'non_edu_trial_credits_enabled';
INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('d0000000-0000-4000-8000-000000000007', 'missing@example.com', now()),
  ('d0000000-0000-4000-8000-000000000008', 'missing@school.edu', now());

DO $$
BEGIN
  IF (SELECT credits FROM public.profiles
      WHERE id = 'd0000000-0000-4000-8000-000000000007') IS DISTINCT FROM 0
    OR (SELECT trial_granted_at FROM public.profiles
        WHERE id = 'd0000000-0000-4000-8000-000000000007') IS NOT NULL THEN
    RAISE EXCEPTION 'Missing setting did not fail closed for non-.edu trial cost';
  END IF;
  IF (SELECT credits FROM public.profiles
      WHERE id = 'd0000000-0000-4000-8000-000000000008') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Missing optional setting disrupted educational signup';
  END IF;
  IF has_table_privilege('service_role', 'public.private_feature_flags', 'SELECT')
    OR has_table_privilege('service_role', 'public.private_feature_flags', 'UPDATE')
    OR has_function_privilege(
      'authenticated',
      'public.set_non_edu_trial_credits_enabled(boolean,uuid,text,uuid)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'Feature-flag least-privilege grants are too broad';
  END IF;
END;
$$;

-- The audited setter is also the recovery path for a missing row.
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL ROLE service_role;
SELECT public.set_non_edu_trial_credits_enabled(
  true,
  'd0000000-0000-4000-8000-000000000001',
  'Restore missing launch setting',
  'd1000000-0000-4000-8000-000000000003'
);
RESET ROLE;

DO $$
BEGIN
  IF (SELECT enabled FROM public.private_feature_flags
      WHERE key = 'non_edu_trial_credits_enabled') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Audited recovery did not restore the feature flag';
  END IF;
  IF (SELECT metadata->>'old_value' FROM public.audit_events
      WHERE correlation_id = 'd1000000-0000-4000-8000-000000000003') IS NOT NULL
    OR (SELECT metadata->>'new_value' FROM public.audit_events
        WHERE correlation_id = 'd1000000-0000-4000-8000-000000000003') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Missing-row recovery audit did not preserve old/new values';
  END IF;
  IF (SELECT credits FROM public.profiles
      WHERE id = 'd0000000-0000-4000-8000-000000000005') IS DISTINCT FROM 10
    OR (SELECT trial_granted_at FROM public.profiles
        WHERE id = 'd0000000-0000-4000-8000-000000000005') IS NOT NULL THEN
    RAISE EXCEPTION 'Turning the flag on changed an existing paid balance or trial history';
  END IF;
END;
$$;

ROLLBACK;
