-- Apply after phase 9. This makes the private database allowlist authoritative
-- for eligibility/admin identity and grants one atomic trial to eligible users.
BEGIN;

ALTER TABLE public.profiles
  ALTER COLUMN credits SET DEFAULT 1,
  ADD COLUMN IF NOT EXISTS trial_granted_at timestamptz;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_email text;
  is_admin boolean;
  correlation uuid := gen_random_uuid();
BEGIN
  IF new.email IS NULL OR new.email_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'A verified email address is required.' USING ERRCODE = '22023';
  END IF;

  normalized_email := lower(btrim(new.email));
  SELECT EXISTS (
    SELECT 1
    FROM public.admin_whitelist
    WHERE email = normalized_email AND is_active
  ) INTO is_admin;

  IF normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.edu$' AND NOT is_admin THEN
    RAISE EXCEPTION 'Access restricted to verified educational domains.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.profiles (id, email, credits, trial_granted_at)
  VALUES (
    new.id,
    normalized_email,
    CASE WHEN is_admin THEN 0 ELSE 1 END,
    CASE WHEN is_admin THEN NULL ELSE now() END
  );

  INSERT INTO public.audit_events (
    event_type, subject_user_id, actor_type, reason, correlation_id, metadata
  ) VALUES (
    CASE WHEN is_admin THEN 'administrator.profile_created' ELSE 'trial.granted' END,
    new.id,
    'system',
    CASE WHEN is_admin
      THEN 'Verified allowlisted administrator profile created'
      ELSE 'Initial eligible-user trial granted'
    END,
    correlation,
    jsonb_build_object('eligibility', CASE WHEN is_admin THEN 'administrator_allowlist' ELSE 'edu_email' END)
  );

  RETURN new;
END;
$$;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated, service_role;

-- All administrator changes must use this audited workflow. The caller is the
-- server service role, but the named actor must itself be an active admin.
CREATE OR REPLACE FUNCTION public.set_administrator_access(
  p_email text,
  p_enabled boolean,
  p_actor_user_id uuid,
  p_reason text,
  p_correlation_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_email text;
  target_user_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_email IS NULL OR p_enabled IS NULL OR p_actor_user_id IS NULL
    OR p_correlation_id IS NULL OR p_reason IS NULL
    OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Complete administrator change details are required' USING ERRCODE = '22023';
  END IF;

  normalized_email := lower(btrim(p_email));
  IF normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    OR length(normalized_email) > 320 THEN
    RAISE EXCEPTION 'Invalid administrator email' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM auth.users u
    JOIN public.admin_whitelist a ON a.email = lower(btrim(u.email))
    WHERE u.id = p_actor_user_id AND u.email_confirmed_at IS NOT NULL AND a.is_active
  ) THEN
    RAISE EXCEPTION 'Active administrator required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.admin_whitelist (
    email, is_active, reason, created_by, updated_at
  ) VALUES (
    normalized_email, p_enabled, btrim(p_reason), p_actor_user_id, now()
  )
  ON CONFLICT (email) DO UPDATE SET
    is_active = excluded.is_active,
    reason = excluded.reason,
    updated_at = now();

  SELECT id INTO target_user_id
  FROM auth.users
  WHERE lower(btrim(email)) = normalized_email
  LIMIT 1;

  INSERT INTO public.audit_events (
    event_type, subject_user_id, actor_type, actor_user_id,
    reason, correlation_id, metadata
  ) VALUES (
    CASE WHEN p_enabled
      THEN 'administrator.access_granted'
      ELSE 'administrator.access_revoked'
    END,
    target_user_id,
    'administrator',
    p_actor_user_id,
    btrim(p_reason),
    p_correlation_id,
    jsonb_build_object('target_email', normalized_email)
  );
END;
$$;

REVOKE INSERT, UPDATE, DELETE ON public.admin_whitelist FROM service_role;
REVOKE ALL ON FUNCTION public.set_administrator_access(text, boolean, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_administrator_access(text, boolean, uuid, text, uuid)
  TO service_role;

COMMIT;
