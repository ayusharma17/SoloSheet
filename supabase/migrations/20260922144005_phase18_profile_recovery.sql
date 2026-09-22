-- Apply after phase 17. This adds a self-scoped recovery path for verified
-- Auth identities left without profiles by historical signup failures.
BEGIN;

CREATE OR REPLACE FUNCTION public.repair_missing_profile()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller_id uuid := auth.uid();
  normalized_email text;
  inserted_profile_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR caller_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated user required' USING ERRCODE = '42501';
  END IF;

  -- The Auth identity is authoritative. No caller-controlled identity, email,
  -- credit amount, or eligibility input is accepted by this function.
  SELECT lower(btrim(auth_user.email))
  INTO normalized_email
  FROM auth.users AS auth_user
  WHERE auth_user.id = caller_id
    AND auth_user.email IS NOT NULL
    AND auth_user.email_confirmed_at IS NOT NULL
  FOR SHARE;

  IF NOT FOUND
    OR length(normalized_email) > 320
    OR normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'Verified identity required' USING ERRCODE = '42501';
  END IF;

  -- Historical repair is deliberately non-promotional. The current email
  -- class and feature-flag value do not affect this insert.
  INSERT INTO public.profiles (id, email, credits, trial_granted_at)
  VALUES (caller_id, normalized_email, 0, NULL)
  ON CONFLICT (id) DO NOTHING
  RETURNING id INTO inserted_profile_id;

  IF inserted_profile_id IS NULL THEN
    RETURN jsonb_build_object('status', 'existing');
  END IF;

  INSERT INTO public.audit_events (
    event_type,
    subject_user_id,
    actor_type,
    actor_user_id,
    reason,
    correlation_id,
    metadata
  ) VALUES (
    'profile.repaired',
    caller_id,
    'user',
    caller_id,
    'Missing profile repaired after verified authentication',
    gen_random_uuid(),
    jsonb_build_object('source', 'authenticated_self_repair')
  );

  RETURN jsonb_build_object('status', 'repaired');
END;
$$;

REVOKE ALL ON FUNCTION public.repair_missing_profile()
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.repair_missing_profile()
  TO authenticated;

COMMIT;
