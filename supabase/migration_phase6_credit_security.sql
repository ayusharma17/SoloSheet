-- Apply after phases 1, 2, 4, 5 and migration_storage_setup.sql, before phase 7.
-- Apply in a transaction as the database owner. This does not change deployed
-- state until explicitly run. Admin email provisioning remains owner/service-only.
BEGIN;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profiles FROM PUBLIC, anon, authenticated;
-- Table revocations alone do not remove separately granted column privileges.
REVOKE INSERT (id, email, credits, updated_at), UPDATE (id, email, credits, updated_at),
  REFERENCES (id, email, credits, updated_at)
  ON public.profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.profiles TO authenticated;
DROP POLICY IF EXISTS "Credit profiles remain private" ON public.profiles;
CREATE POLICY "Credit profiles remain private" ON public.profiles
  AS RESTRICTIVE FOR SELECT TO authenticated USING (id = (SELECT auth.uid()));

ALTER TABLE public.admin_whitelist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_whitelist FROM PUBLIC, anon, authenticated;
REVOKE SELECT (email, created_at), INSERT (email, created_at),
  UPDATE (email, created_at), REFERENCES (email, created_at)
  ON public.admin_whitelist FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.admin_whitelist TO service_role;
-- Defense against an accidentally permissive pre-existing policy or later grant.
DROP POLICY IF EXISTS "Admin whitelist is server managed" ON public.admin_whitelist;
CREATE POLICY "Admin whitelist is server managed" ON public.admin_whitelist
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.add_credits(target_user_id uuid, amount integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF target_user_id IS NULL OR amount IS NULL OR amount <= 0 THEN
    RAISE EXCEPTION 'A user and positive credit amount are required' USING ERRCODE = '22023';
  END IF;
  UPDATE public.profiles SET credits = credits + amount, updated_at = now()
    WHERE id = target_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.add_credits(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_credits(uuid, integer) TO service_role;

-- Keep the old signature for compatibility, but never expose arbitrary-user
-- debits to clients. Phase 7 replaces the extraction flow with reservations.
CREATE OR REPLACE FUNCTION public.decrement_credits(user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.profiles SET credits = credits - 1, updated_at = now()
    WHERE id = user_id AND credits > 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No credits remaining' USING ERRCODE = 'P0001';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.decrement_credits(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decrement_credits(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  is_admin boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM public.admin_whitelist WHERE lower(email) = lower(new.email))
    INTO is_admin;
  IF new.email IS NULL OR (new.email NOT ILIKE '%.edu' AND NOT is_admin) THEN
    RAISE EXCEPTION 'Access restricted to verified educational domains.';
  END IF;
  INSERT INTO public.profiles (id, email, credits)
    VALUES (new.id, new.email, CASE WHEN is_admin THEN 9999 ELSE 1 END);
  RETURN new;
END;
$$;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.device_fingerprints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.device_fingerprints FROM PUBLIC, anon, authenticated;
REVOKE INSERT (id, user_id, fingerprint_hash, created_at),
  UPDATE (id, user_id, fingerprint_hash, created_at),
  REFERENCES (id, user_id, fingerprint_hash, created_at)
  ON public.device_fingerprints FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.device_fingerprints TO authenticated;
CREATE OR REPLACE FUNCTION public.register_device_fingerprint(client_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  caller_id uuid := auth.uid();
BEGIN
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF client_hash IS NULL OR length(client_hash) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'Invalid fingerprint' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.device_fingerprints
    WHERE fingerprint_hash = client_hash AND user_id <> caller_id) THEN
    UPDATE public.profiles SET credits = 0, updated_at = now()
      WHERE id = caller_id AND credits = 1;
  END IF;
  INSERT INTO public.device_fingerprints (user_id, fingerprint_hash)
    SELECT caller_id, client_hash WHERE NOT EXISTS (
      SELECT 1 FROM public.device_fingerprints
      WHERE user_id = caller_id AND fingerprint_hash = client_hash
    );
END;
$$;
REVOKE ALL ON FUNCTION public.register_device_fingerprint(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_device_fingerprint(text) TO authenticated;

-- A browser JWT must never confer cross-user storage administration. Owner
-- policies remain in effect; maintenance must use the server Storage API.
DROP POLICY IF EXISTS "Admins can manage all files" ON storage.objects;
UPDATE storage.buckets SET public = false WHERE id = 'course-materials';
-- Disable the legacy metadata-only deletion even if an old cron job calls it.
CREATE OR REPLACE FUNCTION public.cleanup_old_course_materials()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Use the Storage API to delete expired objects and their data';
END;
$$;
REVOKE ALL ON FUNCTION public.cleanup_old_course_materials() FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
