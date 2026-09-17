-- Apply after phase 15. Supabase Auth inserts a user before it marks the email
-- as confirmed, so defer eligibility checks and profile creation until the
-- first verified state instead of aborting the Auth transaction.
BEGIN;

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
    RETURN new;
  END IF;

  IF TG_OP = 'UPDATE' AND old.email_confirmed_at IS NOT NULL THEN
    RETURN new;
  END IF;

  normalized_email := lower(btrim(new.email));
  SELECT EXISTS (
    SELECT 1
    FROM public.admin_whitelist
    WHERE email = normalized_email AND is_active
  ) INTO is_admin;

  IF normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    OR (normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.edu$' AND NOT is_admin) THEN
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

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT OR UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

COMMIT;
