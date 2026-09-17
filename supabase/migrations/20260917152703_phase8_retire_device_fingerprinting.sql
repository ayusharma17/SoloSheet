-- Retire legacy device fingerprinting without rewriting historical migrations.
-- Apply only after confirming no deployed client still calls register_device_fingerprint.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.register_device_fingerprint(text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.register_device_fingerprint(text)
      FROM PUBLIC, anon, authenticated, service_role;
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.register_device_fingerprint(text);
-- This removes any legacy fingerprint hashes. Confirm retention requirements
-- before applying the migration to a hosted database.
DROP TABLE IF EXISTS public.device_fingerprints;

COMMIT;
