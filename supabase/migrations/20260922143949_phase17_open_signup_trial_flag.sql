-- Apply after phase 16. This separates verified account creation from trial
-- eligibility and adds a private, audited launch control for non-.edu trials.
BEGIN;

CREATE TABLE public.private_feature_flags (
  key text PRIMARY KEY
    CHECK (key = 'non_edu_trial_credits_enabled'),
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  change_correlation_id uuid
);

ALTER TABLE public.private_feature_flags ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.private_feature_flags
  FROM PUBLIC, anon, authenticated, service_role;

-- Launch state: all new, verified, non-administrator accounts receive one
-- trial credit. Future changes must use set_non_edu_trial_credits_enabled().
INSERT INTO public.private_feature_flags (key, enabled)
VALUES ('non_edu_trial_credits_enabled', true);

-- A missing or unreadable optional launch flag must never prevent account
-- creation. Only non-.edu trial eligibility fails closed in that situation.
ALTER TABLE public.profiles ALTER COLUMN credits SET DEFAULT 0;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_email text;
  is_admin boolean := false;
  is_edu boolean := false;
  non_edu_trial_enabled boolean := false;
  grant_trial boolean := false;
  eligibility_basis text;
  correlation uuid := gen_random_uuid();
  inserted_profile_id uuid;
BEGIN
  IF new.email IS NULL OR new.email_confirmed_at IS NULL THEN
    RETURN new;
  END IF;

  IF TG_OP = 'UPDATE' AND old.email_confirmed_at IS NOT NULL THEN
    RETURN new;
  END IF;

  normalized_email := lower(btrim(new.email));
  IF length(normalized_email) > 320
    OR normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'A valid verified email address is required.' USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.admin_whitelist
    WHERE email = normalized_email AND is_active
  ) INTO is_admin;

  is_edu := normalized_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.edu$';
  IF NOT is_admin AND is_edu THEN
    grant_trial := true;
    eligibility_basis := 'edu_email';
  ELSIF NOT is_admin THEN
    -- Share the setter's transaction-scoped lock so a flag change and a
    -- non-.edu profile creation have a deterministic order. If the setter
    -- commits first this query sees the new value; if signup gets the lock
    -- first, the setter cannot commit until the profile transaction finishes.
    PERFORM pg_catalog.pg_advisory_xact_lock(738504621916000016);
    BEGIN
      SELECT flag.enabled INTO non_edu_trial_enabled
      FROM public.private_feature_flags AS flag
      WHERE flag.key = 'non_edu_trial_credits_enabled';
      non_edu_trial_enabled := coalesce(non_edu_trial_enabled, false);
    EXCEPTION WHEN OTHERS THEN
      non_edu_trial_enabled := false;
    END;
    grant_trial := non_edu_trial_enabled;
    IF grant_trial THEN
      eligibility_basis := 'non_edu_launch_promotion';
    END IF;
  END IF;

  INSERT INTO public.profiles (id, email, credits, trial_granted_at)
  VALUES (
    new.id,
    normalized_email,
    CASE WHEN grant_trial THEN 1 ELSE 0 END,
    CASE WHEN grant_trial THEN now() ELSE NULL END
  )
  ON CONFLICT (id) DO NOTHING
  RETURNING id INTO inserted_profile_id;

  -- A repeated provisioning attempt is a no-op. In particular, it cannot
  -- grant another credit or emit another trial event.
  IF inserted_profile_id IS NULL THEN
    RETURN new;
  END IF;

  IF grant_trial THEN
    INSERT INTO public.audit_events (
      event_type, subject_user_id, actor_type, reason, correlation_id, metadata
    ) VALUES (
      'trial.granted', new.id, 'system',
      'Initial eligible-user trial granted', correlation,
      jsonb_build_object('eligibility', eligibility_basis)
    );
  ELSIF is_admin THEN
    INSERT INTO public.audit_events (
      event_type, subject_user_id, actor_type, reason, correlation_id, metadata
    ) VALUES (
      'administrator.profile_created', new.id, 'system',
      'Verified allowlisted administrator profile created', correlation,
      jsonb_build_object('eligibility', 'administrator_allowlist')
    );
  END IF;

  RETURN new;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_non_edu_trial_credits_enabled(
  p_actor_user_id uuid,
  p_reason text,
  p_correlation_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_value boolean;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_user_id IS NULL OR p_correlation_id IS NULL OR p_reason IS NULL
    OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Complete feature-flag read details are required' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM auth.users AS actor
  JOIN public.admin_whitelist AS admin
    ON admin.email = lower(btrim(actor.email))
  WHERE actor.id = p_actor_user_id
    AND actor.email IS NOT NULL
    AND actor.email_confirmed_at IS NOT NULL
    AND admin.is_active
  FOR SHARE OF actor, admin;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active administrator required' USING ERRCODE = '42501';
  END IF;

  SELECT enabled INTO STRICT current_value
  FROM public.private_feature_flags
  WHERE key = 'non_edu_trial_credits_enabled';

  INSERT INTO public.audit_events (
    event_type, actor_type, actor_user_id, reason, correlation_id, metadata
  ) VALUES (
    'configuration.read', 'administrator', p_actor_user_id, btrim(p_reason),
    p_correlation_id,
    jsonb_build_object(
      'setting', 'non_edu_trial_credits_enabled',
      'current_value', current_value
    )
  );
  RETURN current_value;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_non_edu_trial_credits_enabled(
  p_enabled boolean,
  p_actor_user_id uuid,
  p_reason text,
  p_correlation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  old_value boolean;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_enabled IS NULL OR p_actor_user_id IS NULL OR p_correlation_id IS NULL
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Complete feature-flag change details are required' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM auth.users AS actor
  JOIN public.admin_whitelist AS admin
    ON admin.email = lower(btrim(actor.email))
  WHERE actor.id = p_actor_user_id
    AND actor.email IS NOT NULL
    AND actor.email_confirmed_at IS NOT NULL
    AND admin.is_active
  FOR SHARE OF actor, admin;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active administrator required' USING ERRCODE = '42501';
  END IF;

  -- Serialize changes even if the singleton row was accidentally removed;
  -- row locking alone cannot protect two concurrent recovery inserts.
  PERFORM pg_catalog.pg_advisory_xact_lock(738504621916000016);

  SELECT enabled INTO old_value
  FROM public.private_feature_flags
  WHERE key = 'non_edu_trial_credits_enabled'
  FOR UPDATE;

  INSERT INTO public.private_feature_flags (
    key, enabled, updated_at, updated_by, change_correlation_id
  ) VALUES (
    'non_edu_trial_credits_enabled', p_enabled, now(), p_actor_user_id,
    p_correlation_id
  )
  ON CONFLICT (key) DO UPDATE SET
    enabled = excluded.enabled,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by,
    change_correlation_id = excluded.change_correlation_id;

  INSERT INTO public.audit_events (
    event_type, actor_type, actor_user_id, reason, correlation_id, metadata
  ) VALUES (
    'configuration.changed', 'administrator', p_actor_user_id, btrim(p_reason),
    p_correlation_id,
    jsonb_build_object(
      'setting', 'non_edu_trial_credits_enabled',
      'old_value', old_value,
      'new_value', p_enabled
    )
  );

  RETURN jsonb_build_object('oldValue', old_value, 'newValue', p_enabled);
END;
$$;

REVOKE ALL ON FUNCTION public.get_non_edu_trial_credits_enabled(uuid, text, uuid),
  public.set_non_edu_trial_credits_enabled(boolean, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_non_edu_trial_credits_enabled(uuid, text, uuid),
  public.set_non_edu_trial_credits_enabled(boolean, uuid, text, uuid)
  TO service_role;

COMMIT;
