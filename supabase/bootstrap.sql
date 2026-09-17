-- GENERATED FILE: run `npm run db:bootstrap:build` after editing a source migration.

-- Fresh databases only. The single transaction prevents a partially hardened schema.

BEGIN;

-- BEGIN SOURCE: supabase/migration.sql
-- ============================================================
-- Phase 1: Profiles, Course Materials, RLS & Auto-Creation
-- (Already applied to Supabase — kept here for reference)
-- ============================================================

-- Create a table for user profiles and credits
CREATE TABLE IF NOT EXISTS profiles (
  id uuid REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  email text UNIQUE,
  credits integer DEFAULT 3 CHECK (credits >= 0),
  updated_at timestamp with time zone DEFAULT now()
);

-- Create a table for the AI-extracted course data
CREATE TABLE IF NOT EXISTS course_materials (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  course_name text,
  extracted_json jsonb, -- This holds the dense notes/formulae
  created_at timestamp with time zone DEFAULT now()
);

-- Enable RLS on both tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_materials ENABLE ROW LEVEL SECURITY;

-- Set up RLS Policies: Users can only see/read their own data
CREATE POLICY "Users can view own profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can view own materials" ON course_materials FOR SELECT USING (auth.uid() = user_id);

-- Create a Trigger to automatically create a profile and give 3 credits on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, credits)
  VALUES (new.id, new.email, 3);
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
-- END SOURCE: supabase/migration.sql

-- BEGIN SOURCE: supabase/migration_phase2.sql
-- Phase 2: Add user_directive column and INSERT policy
-- Run this in your Supabase SQL Editor

-- 1. Add user_directive column to course_materials
ALTER TABLE course_materials ADD COLUMN IF NOT EXISTS user_directive text;

-- 2. Allow authenticated users to insert their own materials
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'course_materials' AND policyname = 'Users can insert own materials'
  ) THEN
    CREATE POLICY "Users can insert own materials"
      ON course_materials FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;
END
$$;

-- 3. Create a secure function to decrement credits (called via RPC)
CREATE OR REPLACE FUNCTION decrement_credits(user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE profiles
  SET credits = credits - 1, updated_at = now()
  WHERE id = user_id AND credits > 0;
END;
$$;
-- END SOURCE: supabase/migration_phase2.sql

-- BEGIN SOURCE: supabase/migration_phase4.sql
-- Phase 4: Add target_pages column
-- Run this in your Supabase SQL Editor

-- 1. Add target_pages column to course_materials
ALTER TABLE course_materials ADD COLUMN IF NOT EXISTS target_pages integer DEFAULT 1;

-- 2. Verify column exists
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'course_materials' AND column_name = 'target_pages';
-- END SOURCE: supabase/migration_phase4.sql

-- BEGIN SOURCE: supabase/migration_phase5_anti_abuse.sql
-- ============================================================
-- Phase 5: Anti-Abuse & Identity Guard SQL Implementation
-- Run this in your Supabase SQL Editor
-- ============================================================

-- 0. Admin Whitelist Table
CREATE TABLE IF NOT EXISTS admin_whitelist (
    email text PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now()
);

-- Administrators are deployment-specific. Bootstrap the first administrator
-- explicitly as the database owner; reusable/open-source migrations must not
-- authorize a repository maintainer's personal identity.

-- 1. Modified handle_new_user trigger (1 trial credit, .edu restriction, & whitelist)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  is_admin boolean;
BEGIN
  -- Check if the email is in the admin whitelist
  SELECT EXISTS(SELECT 1 FROM public.admin_whitelist WHERE email = new.email) INTO is_admin;

  -- Defense in depth: Deny non-.edu emails unless it's in the admin whitelist
  IF new.email NOT ILIKE '%.edu' AND NOT is_admin THEN
    RAISE EXCEPTION 'Access restricted to verified educational domains.';
  END IF;

  -- Insert profile with 1 trial credit (or 9999 for admin)
  IF is_admin THEN
      INSERT INTO public.profiles (id, email, credits)
      VALUES (new.id, new.email, 9999);
  ELSE
      INSERT INTO public.profiles (id, email, credits)
      VALUES (new.id, new.email, 1);
  END IF;
  
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- 2. Device Fingerprints Table
CREATE TABLE IF NOT EXISTS device_fingerprints (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
    fingerprint_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_fingerprints_hash ON device_fingerprints(fingerprint_hash);

-- Secure it via RLS
ALTER TABLE device_fingerprints ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'device_fingerprints' AND policyname = 'Users can insert own fingerprint'
  ) THEN
    CREATE POLICY "Users can insert own fingerprint" 
      ON device_fingerprints FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'device_fingerprints' AND policyname = 'Users can view own fingerprint'
  ) THEN
    CREATE POLICY "Users can view own fingerprint" 
      ON device_fingerprints FOR SELECT USING (auth.uid() = user_id);
  END IF;
END
$$;

-- Secure function to register device fingerprint and revoke credit if duplicate
CREATE OR REPLACE FUNCTION register_device_fingerprint(client_hash text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    existing_count integer;
BEGIN
    -- Check if this fingerprint exists for ANY OTHER user
    SELECT count(*) INTO existing_count FROM device_fingerprints WHERE fingerprint_hash = client_hash AND user_id != auth.uid();
    
    -- If it does exist elsewhere, revoke the trial credit (assuming they haven't bought any yet)
    IF existing_count > 0 THEN
       UPDATE profiles SET credits = 0 WHERE id = auth.uid() AND credits = 1;
    END IF;
    
    -- Register it for the current user (fail silently if already inserted due to unique constraints, etc.)
    INSERT INTO device_fingerprints (user_id, fingerprint_hash)
    VALUES (auth.uid(), client_hash);
END;
$$;


-- 3. Financial Integration (Secure function for Stripe webhook)
CREATE OR REPLACE FUNCTION add_credits(target_user_id uuid, amount integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE profiles
  SET credits = credits + amount, 
      updated_at = now()
  WHERE id = target_user_id;
END;
$$;
-- END SOURCE: supabase/migration_phase5_anti_abuse.sql

-- BEGIN SOURCE: supabase/migration_storage_setup.sql
-- ================================================================
-- Migration: Supabase Storage Setup for Course Materials
-- Purpose: Configure private course-material uploads and centrally managed quotas
-- Date: 2026-03-12
-- ================================================================

-- ================================================================
-- STEP 1: Create the authoritative per-user storage quota configuration
-- ================================================================
CREATE TABLE IF NOT EXISTS public.course_material_upload_limits (
  config_key text PRIMARY KEY CHECK (config_key = 'course-materials'),
  max_files_per_user integer NOT NULL CHECK (max_files_per_user > 0),
  max_total_bytes_per_user bigint NOT NULL CHECK (max_total_bytes_per_user > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.course_material_upload_limits (
  config_key, max_files_per_user, max_total_bytes_per_user
) VALUES (
  'course-materials', 10, 200 * 1024 * 1024
) ON CONFLICT (config_key) DO NOTHING;

ALTER TABLE public.course_material_upload_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.course_material_upload_limits
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sync_course_material_upload_bucket_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  UPDATE storage.buckets
  SET file_size_limit = NEW.max_total_bytes_per_user
  WHERE id = 'course-materials';
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_course_material_upload_bucket_limit()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS sync_course_material_upload_bucket_limit
  ON public.course_material_upload_limits;
CREATE TRIGGER sync_course_material_upload_bucket_limit
BEFORE INSERT OR UPDATE ON public.course_material_upload_limits
FOR EACH ROW EXECUTE FUNCTION public.sync_course_material_upload_bucket_limit();

-- ================================================================
-- STEP 2: Create the storage bucket from the authoritative configuration
-- ================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
SELECT
  'course-materials',
  'course-materials',
  false, -- Private bucket (requires authentication)
  limits.max_total_bytes_per_user,
  ARRAY[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/gif'
  ]
FROM public.course_material_upload_limits AS limits
WHERE limits.config_key = 'course-materials'
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Managed Supabase already enables RLS on storage.objects and retains ownership
-- of that table. Phase 14 installs the reservation-backed Storage policies.
-- Do not alter storage.objects here or recreate the legacy metadata-only cleanup
-- function; stored bytes must be deleted through the Storage API.

-- ================================================================
-- VERIFICATION QUERIES
-- ================================================================

-- Check bucket exists
-- SELECT * FROM storage.buckets WHERE id = 'course-materials';

-- Apply phase 14 immediately after phases 6-13 to install upload reservations
-- and the restrictive Storage policies.
-- END SOURCE: supabase/migration_storage_setup.sql

-- BEGIN SOURCE: supabase/migration_phase6_credit_security.sql
-- Apply after phases 1, 2, 4, 5 and migration_storage_setup.sql, before phase 7.
-- Apply in a transaction as the database owner. This does not change deployed
-- state until explicitly run. Admin email provisioning remains owner/service-only.

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
-- END SOURCE: supabase/migration_phase6_credit_security.sql

-- BEGIN SOURCE: supabase/migration_phase7_atomic_extraction.sql
-- Apply after phase6 credit security. Deploy before the matching extraction route.
-- Only the server service_role may reserve, finalize, or refund credits.

CREATE TABLE IF NOT EXISTS public.extraction_requests (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  charged boolean NOT NULL,
  material_id uuid REFERENCES public.course_materials(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);
ALTER TABLE public.extraction_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.extraction_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.extraction_requests TO service_role;
-- Browser inserts otherwise bypass this protocol entirely.
REVOKE INSERT, UPDATE ON public.course_materials FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.reserve_extraction(p_user_id uuid, p_request_id uuid, p_fingerprint text, p_is_admin boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.extraction_requests%ROWTYPE; balance integer; expired_count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501'; END IF;
  IF p_user_id IS NULL OR p_request_id IS NULL OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-fA-F]{64}$' THEN RAISE EXCEPTION 'Invalid request'; END IF;
  -- All operations take the same profile lock first, serializing a user's balance.
  SELECT credits INTO balance FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'no_credits'); END IF;
  -- Recover interrupted workers after twice the route's maximum runtime. A late
  -- worker cannot complete once its reservation has been marked failed.
  WITH expired AS (
    UPDATE public.extraction_requests SET status = 'failed'
    WHERE user_id = p_user_id AND status = 'processing' AND created_at < now() - interval '10 minutes'
    RETURNING charged
  ) SELECT count(*) FILTER (WHERE charged) INTO expired_count FROM expired;
  IF expired_count > 0 THEN
    UPDATE public.profiles SET credits = credits + expired_count, updated_at = now() WHERE id = p_user_id RETURNING credits INTO balance;
  END IF;
  SELECT * INTO r FROM public.extraction_requests WHERE user_id = p_user_id AND request_id = p_request_id;
  IF FOUND THEN
    IF r.fingerprint <> p_fingerprint THEN RETURN jsonb_build_object('status', 'conflict'); END IF;
    RETURN jsonb_build_object('status', r.status, 'materialId', r.material_id, 'remainingCredits', balance);
  END IF;
  IF NOT p_is_admin THEN
    UPDATE public.profiles SET credits = credits - 1, updated_at = now()
    WHERE id = p_user_id AND credits >= 1 RETURNING credits INTO balance;
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 'no_credits'); END IF;
  END IF;
  INSERT INTO public.extraction_requests(user_id, request_id, fingerprint, status, charged)
  VALUES (p_user_id, p_request_id, p_fingerprint, 'processing', NOT p_is_admin);
  RETURN jsonb_build_object('status', 'reserved', 'remainingCredits', balance);
END; $$;

CREATE OR REPLACE FUNCTION public.complete_extraction(p_user_id uuid, p_request_id uuid, p_course_name text, p_target_pages integer, p_user_directive text, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.extraction_requests%ROWTYPE; result_id uuid; balance integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501'; END IF;
  SELECT credits INTO balance FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  SELECT * INTO r FROM public.extraction_requests WHERE user_id = p_user_id AND request_id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.status = 'failed' THEN RAISE EXCEPTION 'No active reservation'; END IF;
  IF r.status = 'completed' THEN
    RETURN jsonb_build_object('materialId', r.material_id, 'remainingCredits', balance);
  END IF;
  IF p_target_pages IS NULL OR p_target_pages NOT BETWEEN 1 AND 20 OR p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN RAISE EXCEPTION 'Invalid extraction'; END IF;
  INSERT INTO public.course_materials(user_id, course_name, target_pages, user_directive, extracted_json)
  VALUES (p_user_id, p_course_name, p_target_pages, p_user_directive, p_items) RETURNING id INTO result_id;
  UPDATE public.extraction_requests SET status = 'completed', material_id = result_id WHERE user_id = p_user_id AND request_id = p_request_id;
  RETURN jsonb_build_object('materialId', result_id, 'remainingCredits', balance);
END; $$;

CREATE OR REPLACE FUNCTION public.fail_extraction(p_user_id uuid, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.extraction_requests%ROWTYPE; balance integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501'; END IF;
  SELECT credits INTO balance FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  SELECT * INTO r FROM public.extraction_requests WHERE user_id = p_user_id AND request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'failed'); END IF;
  -- A timeout after commit must never refund a successfully saved sheet.
  IF r.status = 'processing' THEN
    IF r.charged THEN
      UPDATE public.profiles SET credits = credits + 1, updated_at = now() WHERE id = p_user_id RETURNING credits INTO balance;
    END IF;
    UPDATE public.extraction_requests SET status = 'failed' WHERE user_id = p_user_id AND request_id = p_request_id;
    r.status := 'failed';
  END IF;
  RETURN jsonb_build_object('status', r.status, 'materialId', r.material_id, 'remainingCredits', balance);
END; $$;

REVOKE ALL ON FUNCTION public.reserve_extraction(uuid, uuid, text, boolean), public.complete_extraction(uuid, uuid, text, integer, text, jsonb), public.fail_extraction(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE INSERT (user_id, course_name, target_pages, user_directive, extracted_json), UPDATE ON public.course_materials FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_extraction(uuid, uuid, text, boolean), public.complete_extraction(uuid, uuid, text, integer, text, jsonb), public.fail_extraction(uuid, uuid) TO service_role;
-- END SOURCE: supabase/migration_phase7_atomic_extraction.sql

-- BEGIN SOURCE: supabase/migration_phase8_retire_device_fingerprinting.sql
-- Retire legacy device fingerprinting without rewriting historical migrations.
-- Apply only after confirming no deployed client still calls register_device_fingerprint.


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
-- END SOURCE: supabase/migration_phase8_retire_device_fingerprinting.sql

-- BEGIN SOURCE: supabase/migration_phase9_anti_abuse_foundation.sql
-- Apply after phase 8. This creates the private database foundation for the
-- anti-abuse/payment MVP without wiring signup, extraction, or Stripe routes.

-- The database allowlist is the canonical administrator source. Phase 10 will
-- update application and reservation code to consult active entries here.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.admin_whitelist
    GROUP BY lower(btrim(email))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Normalize duplicate administrator emails before phase 9';
  END IF;
END;
$$;

UPDATE public.admin_whitelist SET email = lower(btrim(email));
ALTER TABLE public.admin_whitelist
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.admin_whitelist
  DROP CONSTRAINT IF EXISTS admin_whitelist_normalized_email,
  ADD CONSTRAINT admin_whitelist_normalized_email
    CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 320),
  DROP CONSTRAINT IF EXISTS admin_whitelist_reason_length,
  ADD CONSTRAINT admin_whitelist_reason_length
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 1000);
CREATE UNIQUE INDEX IF NOT EXISTS admin_whitelist_lower_email_key
  ON public.admin_whitelist (lower(email));
ALTER TABLE public.admin_whitelist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_whitelist FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_whitelist TO service_role;

CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL
    CHECK (event_type ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  subject_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_type text NOT NULL
    CHECK (actor_type IN ('system', 'administrator', 'user', 'stripe_webhook')),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 1000),
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  retention_until timestamptz NOT NULL DEFAULT (now() + interval '1 year'),
  CHECK (retention_until > created_at),
  CHECK (
    (actor_type IN ('administrator', 'user') AND actor_user_id IS NOT NULL)
    OR
    (actor_type IN ('system', 'stripe_webhook') AND actor_user_id IS NULL)
  )
);
CREATE INDEX audit_events_subject_created_idx
  ON public.audit_events (subject_user_id, created_at DESC);
CREATE INDEX audit_events_type_created_idx
  ON public.audit_events (event_type, created_at DESC);
CREATE INDEX audit_events_retention_idx
  ON public.audit_events (retention_until);
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.audit_events TO service_role;

CREATE TABLE public.account_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason text NOT NULL
    CHECK (reason IN ('refund', 'dispute', 'chargeback', 'manual_review')),
  source text NOT NULL
    CHECK (source IN ('stripe', 'administrator', 'system')),
  source_reference text CHECK (
    source_reference IS NULL OR length(source_reference) BETWEEN 1 AND 255
  ),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released')),
  placed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  placed_at timestamptz NOT NULL DEFAULT now(),
  release_reason text CHECK (
    release_reason IS NULL OR length(release_reason) BETWEEN 1 AND 1000
  ),
  released_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  released_at timestamptz,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  retention_until timestamptz NOT NULL DEFAULT (now() + interval '7 years'),
  CHECK (
    (status = 'active' AND released_at IS NULL AND released_by IS NULL AND release_reason IS NULL)
    OR
    (status = 'released' AND released_at IS NOT NULL AND release_reason IS NOT NULL)
  ),
  CHECK (retention_until > placed_at)
);
CREATE UNIQUE INDEX account_holds_source_reference_key
  ON public.account_holds (source, source_reference)
  WHERE source_reference IS NOT NULL;
CREATE INDEX account_holds_active_user_idx
  ON public.account_holds (user_id, placed_at DESC)
  WHERE status = 'active';
ALTER TABLE public.account_holds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_holds FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.account_holds TO service_role;

CREATE TABLE public.stripe_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  checkout_session_id text NOT NULL UNIQUE
    CHECK (length(checkout_session_id) BETWEEN 1 AND 255),
  payment_intent_id text UNIQUE
    CHECK (payment_intent_id IS NULL OR length(payment_intent_id) BETWEEN 1 AND 255),
  stripe_customer_id text
    CHECK (stripe_customer_id IS NULL OR length(stripe_customer_id) BETWEEN 1 AND 255),
  price_id text NOT NULL CHECK (length(price_id) BETWEEN 1 AND 255),
  amount_total integer NOT NULL CHECK (amount_total = 300),
  currency text NOT NULL CHECK (currency = 'usd'),
  credit_amount integer NOT NULL CHECK (credit_amount = 10),
  quantity integer NOT NULL CHECK (quantity = 1),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'refunded', 'disputed', 'chargeback')),
  livemode boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  retention_until timestamptz NOT NULL DEFAULT (now() + interval '7 years'),
  CHECK (
    (status = 'pending' AND paid_at IS NULL)
    OR
    (status <> 'pending' AND paid_at IS NOT NULL)
  ),
  CHECK (updated_at >= created_at),
  CHECK (retention_until > created_at)
);
CREATE INDEX stripe_purchases_user_created_idx
  ON public.stripe_purchases (user_id, created_at DESC);
CREATE INDEX stripe_purchases_status_created_idx
  ON public.stripe_purchases (status, created_at);
ALTER TABLE public.stripe_purchases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stripe_purchases FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.stripe_purchases TO service_role;

-- Only committed, successfully handled events belong here. Failed webhook
-- attempts roll back so Stripe can safely retry the same event ID.
CREATE TABLE public.stripe_webhook_events (
  event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 255),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 255),
  purchase_id uuid REFERENCES public.stripe_purchases(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome IN ('processed', 'ignored')),
  livemode boolean NOT NULL,
  stripe_created_at timestamptz NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  retention_until timestamptz NOT NULL DEFAULT (now() + interval '7 years'),
  CHECK (retention_until > processed_at)
);
CREATE INDEX stripe_webhook_events_purchase_idx
  ON public.stripe_webhook_events (purchase_id, processed_at DESC);
CREATE INDEX stripe_webhook_events_retention_idx
  ON public.stripe_webhook_events (retention_until);
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stripe_webhook_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.stripe_webhook_events TO service_role;
-- END SOURCE: supabase/migration_phase9_anti_abuse_foundation.sql

-- BEGIN SOURCE: supabase/migration_phase10_identity_and_trial.sql
-- Apply after phase 9. This makes the private database allowlist authoritative
-- for eligibility/admin identity and grants one atomic trial to eligible users.

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
-- END SOURCE: supabase/migration_phase10_identity_and_trial.sql

-- BEGIN SOURCE: supabase/migration_phase11_extraction_access.sql
-- Apply after phase 10. Administrator bypass and account holds are resolved
-- inside the same profile-locked transaction that reserves extraction credits.

REVOKE ALL ON FUNCTION public.reserve_extraction(uuid, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION public.reserve_extraction(uuid, uuid, text, boolean);

CREATE FUNCTION public.reserve_extraction(
  p_user_id uuid,
  p_request_id uuid,
  p_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.extraction_requests%ROWTYPE;
  balance integer;
  expired_count integer;
  v_is_admin boolean := false;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_request_id IS NULL OR p_fingerprint IS NULL
    OR p_fingerprint !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'Invalid request' USING ERRCODE = '22023';
  END IF;

  SELECT credits INTO balance
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'no_credits');
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    JOIN public.admin_whitelist a ON a.email = lower(btrim(p.email))
    WHERE p.id = p_user_id AND a.is_active
  ) INTO v_is_admin;

  WITH expired AS (
    UPDATE public.extraction_requests SET status = 'failed'
    WHERE user_id = p_user_id AND status = 'processing'
      AND created_at < now() - interval '10 minutes'
    RETURNING charged
  )
  SELECT count(*) FILTER (WHERE charged) INTO expired_count FROM expired;
  IF expired_count > 0 THEN
    UPDATE public.profiles SET credits = credits + expired_count, updated_at = now()
    WHERE id = p_user_id RETURNING credits INTO balance;
  END IF;

  SELECT * INTO r FROM public.extraction_requests
  WHERE user_id = p_user_id AND request_id = p_request_id;
  IF FOUND THEN
    IF r.fingerprint <> p_fingerprint THEN
      RETURN jsonb_build_object('status', 'conflict');
    END IF;
    RETURN jsonb_build_object(
      'status', r.status,
      'materialId', r.material_id,
      'remainingCredits', balance
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.account_holds
    WHERE user_id = p_user_id AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('status', 'account_held', 'remainingCredits', balance);
  END IF;

  IF NOT v_is_admin THEN
    UPDATE public.profiles SET credits = credits - 1, updated_at = now()
    WHERE id = p_user_id AND credits >= 1 RETURNING credits INTO balance;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'no_credits');
    END IF;
  END IF;

  INSERT INTO public.extraction_requests (
    user_id, request_id, fingerprint, status, charged
  ) VALUES (
    p_user_id, p_request_id, p_fingerprint, 'processing', NOT v_is_admin
  );

  IF v_is_admin THEN
    INSERT INTO public.audit_events (
      event_type, subject_user_id, actor_type, actor_user_id,
      reason, correlation_id, metadata
    ) VALUES (
      'administrator.extraction_bypassed', p_user_id,
      'administrator', p_user_id,
      'Unlimited administrator extraction reserved', p_request_id,
      jsonb_build_object('request_id', p_request_id)
    );
  END IF;

  RETURN jsonb_build_object('status', 'reserved', 'remainingCredits', balance);
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_extraction(
  p_user_id uuid,
  p_request_id uuid,
  p_course_name text,
  p_target_pages integer,
  p_user_directive text,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.extraction_requests%ROWTYPE;
  result_id uuid;
  balance integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT credits INTO balance FROM public.profiles
  WHERE id = p_user_id FOR UPDATE;
  SELECT * INTO r FROM public.extraction_requests
  WHERE user_id = p_user_id AND request_id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.status = 'failed' THEN
    RAISE EXCEPTION 'No active reservation';
  END IF;
  IF r.status = 'completed' THEN
    RETURN jsonb_build_object(
      'status', 'completed',
      'materialId', r.material_id,
      'remainingCredits', balance
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.account_holds
    WHERE user_id = p_user_id AND status = 'active'
  ) THEN
    IF r.charged THEN
      UPDATE public.profiles SET credits = credits + 1, updated_at = now()
      WHERE id = p_user_id RETURNING credits INTO balance;
    END IF;
    UPDATE public.extraction_requests SET status = 'failed'
    WHERE user_id = p_user_id AND request_id = p_request_id;
    INSERT INTO public.audit_events (
      event_type, subject_user_id, actor_type, reason, correlation_id, metadata
    ) VALUES (
      'extraction.blocked_by_hold', p_user_id, 'system',
      'Extraction completion rejected because the account is held',
      p_request_id, jsonb_build_object('request_id', p_request_id)
    );
    RETURN jsonb_build_object(
      'status', 'account_held', 'remainingCredits', balance
    );
  END IF;

  IF p_target_pages IS NULL OR p_target_pages NOT BETWEEN 1 AND 20
    OR p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'Invalid extraction';
  END IF;
  INSERT INTO public.course_materials (
    user_id, course_name, target_pages, user_directive, extracted_json
  ) VALUES (
    p_user_id, p_course_name, p_target_pages, p_user_directive, p_items
  ) RETURNING id INTO result_id;
  UPDATE public.extraction_requests SET status = 'completed', material_id = result_id
  WHERE user_id = p_user_id AND request_id = p_request_id;
  RETURN jsonb_build_object(
    'status', 'completed',
    'materialId', result_id,
    'remainingCredits', balance
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_extraction(uuid, uuid, text),
  public.complete_extraction(uuid, uuid, text, integer, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_extraction(uuid, uuid, text),
  public.complete_extraction(uuid, uuid, text, integer, text, jsonb)
  TO service_role;
-- END SOURCE: supabase/migration_phase11_extraction_access.sql

-- BEGIN SOURCE: supabase/migration_phase12_stripe_payments.sql
-- Apply after phase 11. Stripe routes call only these service-role functions;
-- clients never choose package values or mutate the payment ledger directly.

ALTER TABLE public.stripe_purchases
  ALTER COLUMN checkout_session_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.create_pending_stripe_purchase(
  p_purchase_id uuid,
  p_user_id uuid,
  p_price_id text,
  p_livemode boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_purchase_id IS NULL OR p_user_id IS NULL OR p_livemode IS NULL
    OR p_price_id IS NULL OR length(p_price_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'Invalid pending purchase' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.account_holds
    WHERE user_id = p_user_id AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('status', 'held');
  END IF;
  INSERT INTO public.stripe_purchases (
    id, user_id, checkout_session_id, price_id, amount_total, currency,
    credit_amount, quantity, status, livemode
  ) VALUES (
    p_purchase_id, p_user_id, NULL, p_price_id, 300, 'usd',
    10, 1, 'pending', p_livemode
  );
  RETURN jsonb_build_object('status', 'pending', 'purchaseId', p_purchase_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.attach_stripe_checkout_session(
  p_purchase_id uuid,
  p_user_id uuid,
  p_checkout_session_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  purchase public.stripe_purchases%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_purchase_id IS NULL OR p_user_id IS NULL OR p_checkout_session_id IS NULL
    OR length(p_checkout_session_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'Invalid Checkout Session' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND OR purchase.user_id <> p_user_id THEN
    RAISE EXCEPTION 'Pending purchase not found' USING ERRCODE = 'P0002';
  END IF;
  IF purchase.checkout_session_id IS NOT NULL
    AND purchase.checkout_session_id <> p_checkout_session_id THEN
    RAISE EXCEPTION 'Checkout Session conflict' USING ERRCODE = '23505';
  END IF;
  UPDATE public.stripe_purchases
  SET checkout_session_id = p_checkout_session_id, updated_at = now()
  WHERE id = p_purchase_id;
  RETURN jsonb_build_object('status', purchase.status, 'purchaseId', p_purchase_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.fulfill_stripe_checkout(
  p_event_id text,
  p_purchase_id uuid,
  p_user_id uuid,
  p_checkout_session_id text,
  p_payment_intent_id text,
  p_price_id text,
  p_amount_total integer,
  p_currency text,
  p_livemode boolean,
  p_stripe_created_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  purchase public.stripe_purchases%ROWTYPE;
  balance integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255
    OR p_purchase_id IS NULL OR p_user_id IS NULL
    OR p_checkout_session_id IS NULL OR length(p_checkout_session_id) NOT BETWEEN 1 AND 255
    OR p_payment_intent_id IS NULL OR length(p_payment_intent_id) NOT BETWEEN 1 AND 255
    OR p_price_id IS NULL OR length(p_price_id) NOT BETWEEN 1 AND 255
    OR p_amount_total <> 300 OR lower(p_currency) <> 'usd'
    OR p_livemode IS NULL OR p_stripe_created_at IS NULL THEN
    RAISE EXCEPTION 'Invalid paid Checkout Session' USING ERRCODE = '22023';
  END IF;

  SELECT credits INTO balance FROM public.profiles
  WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending purchase not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stripe_webhook_events WHERE event_id = p_event_id) THEN
    RETURN jsonb_build_object('status', 'duplicate', 'remainingCredits', balance);
  END IF;
  IF purchase.user_id <> p_user_id OR purchase.price_id <> p_price_id
    OR purchase.livemode <> p_livemode
    OR (purchase.checkout_session_id IS NOT NULL
      AND purchase.checkout_session_id <> p_checkout_session_id) THEN
    RAISE EXCEPTION 'Checkout Session does not match pending purchase' USING ERRCODE = '22023';
  END IF;

  IF purchase.status <> 'pending' THEN
    INSERT INTO public.stripe_webhook_events (
      event_id, event_type, purchase_id, outcome, livemode, stripe_created_at
    ) VALUES (
      p_event_id, 'checkout.session.completed', p_purchase_id,
      'ignored', p_livemode, p_stripe_created_at
    );
    RETURN jsonb_build_object('status', 'already_fulfilled', 'remainingCredits', balance);
  END IF;

  UPDATE public.stripe_purchases SET
    checkout_session_id = p_checkout_session_id,
    payment_intent_id = p_payment_intent_id,
    status = 'paid', paid_at = now(), updated_at = now()
  WHERE id = p_purchase_id;
  UPDATE public.profiles SET credits = credits + 10, updated_at = now()
  WHERE id = p_user_id RETURNING credits INTO balance;
  INSERT INTO public.stripe_webhook_events (
    event_id, event_type, purchase_id, outcome, livemode, stripe_created_at
  ) VALUES (
    p_event_id, 'checkout.session.completed', p_purchase_id,
    'processed', p_livemode, p_stripe_created_at
  );
  INSERT INTO public.audit_events (
    event_type, subject_user_id, actor_type, reason, correlation_id, metadata
  ) VALUES (
    'payment.credits_granted', p_user_id, 'stripe_webhook',
    'Paid Stripe Checkout granted 10 credits', p_purchase_id,
    jsonb_build_object(
      'stripe_event_id', p_event_id,
      'checkout_session_id', p_checkout_session_id,
      'amount_total', 300,
      'currency', 'usd',
      'credits', 10
    )
  );
  RETURN jsonb_build_object('status', 'fulfilled', 'remainingCredits', balance);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_stripe_account_hold(
  p_event_id text,
  p_event_type text,
  p_payment_intent_id text,
  p_source_reference text,
  p_livemode boolean,
  p_stripe_created_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  purchase public.stripe_purchases%ROWTYPE;
  hold_reason text;
  purchase_status text;
  existing_hold_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255
    OR p_payment_intent_id IS NULL OR length(p_payment_intent_id) NOT BETWEEN 1 AND 255
    OR p_source_reference IS NULL OR length(p_source_reference) NOT BETWEEN 1 AND 255
    OR p_livemode IS NULL OR p_stripe_created_at IS NULL THEN
    RAISE EXCEPTION 'Invalid Stripe hold event' USING ERRCODE = '22023';
  END IF;
  CASE p_event_type
    WHEN 'charge.refunded' THEN hold_reason := 'refund'; purchase_status := 'refunded';
    WHEN 'charge.dispute.created' THEN hold_reason := 'dispute'; purchase_status := 'disputed';
    WHEN 'charge.dispute.closed' THEN hold_reason := 'chargeback'; purchase_status := 'chargeback';
    ELSE RAISE EXCEPTION 'Unsupported Stripe hold event' USING ERRCODE = '22023';
  END CASE;

  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE payment_intent_id = p_payment_intent_id;
  IF NOT FOUND THEN
    INSERT INTO public.stripe_webhook_events (
      event_id, event_type, purchase_id, outcome, livemode, stripe_created_at
    ) VALUES (
      p_event_id, p_event_type, NULL, 'ignored', p_livemode, p_stripe_created_at
    ) ON CONFLICT (event_id) DO NOTHING;
    RETURN jsonb_build_object('status', 'ignored');
  END IF;
  PERFORM 1 FROM public.profiles WHERE id = purchase.user_id FOR UPDATE;
  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE payment_intent_id = p_payment_intent_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.stripe_webhook_events WHERE event_id = p_event_id) THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;
  IF purchase.livemode <> p_livemode OR purchase.status = 'pending' THEN
    RAISE EXCEPTION 'Stripe event does not match a paid purchase' USING ERRCODE = '22023';
  END IF;

  SELECT id INTO existing_hold_id FROM public.account_holds
  WHERE source = 'stripe' AND source_reference = p_source_reference
  FOR UPDATE;
  IF FOUND THEN
    UPDATE public.account_holds SET
      reason = hold_reason,
      status = 'active',
      release_reason = NULL,
      released_by = NULL,
      released_at = NULL,
      correlation_id = purchase.id,
      metadata = jsonb_build_object('stripe_event_id', p_event_id)
    WHERE id = existing_hold_id;
  ELSE
    INSERT INTO public.account_holds (
      user_id, reason, source, source_reference, correlation_id, metadata
    ) VALUES (
      purchase.user_id, hold_reason, 'stripe', p_source_reference,
      purchase.id, jsonb_build_object('stripe_event_id', p_event_id)
    );
  END IF;
  UPDATE public.stripe_purchases SET status = purchase_status, updated_at = now()
  WHERE id = purchase.id;
  INSERT INTO public.stripe_webhook_events (
    event_id, event_type, purchase_id, outcome, livemode, stripe_created_at
  ) VALUES (
    p_event_id, p_event_type, purchase.id, 'processed', p_livemode, p_stripe_created_at
  );
  INSERT INTO public.audit_events (
    event_type, subject_user_id, actor_type, reason, correlation_id, metadata
  ) VALUES (
    'payment.account_held', purchase.user_id, 'stripe_webhook',
    'Stripe refund or dispute placed the account under review', purchase.id,
    jsonb_build_object(
      'stripe_event_id', p_event_id,
      'stripe_event_type', p_event_type,
      'hold_reason', hold_reason,
      'source_reference', p_source_reference
    )
  );
  RETURN jsonb_build_object('status', 'held');
END;
$$;

REVOKE ALL ON FUNCTION public.create_pending_stripe_purchase(uuid, uuid, text, boolean),
  public.attach_stripe_checkout_session(uuid, uuid, text),
  public.fulfill_stripe_checkout(text, uuid, uuid, text, text, text, integer, text, boolean, timestamptz),
  public.record_stripe_account_hold(text, text, text, text, boolean, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_pending_stripe_purchase(uuid, uuid, text, boolean),
  public.attach_stripe_checkout_session(uuid, uuid, text),
  public.fulfill_stripe_checkout(text, uuid, uuid, text, text, text, integer, text, boolean, timestamptz),
  public.record_stripe_account_hold(text, text, text, text, boolean, timestamptz)
  TO service_role;
-- END SOURCE: supabase/migration_phase12_stripe_payments.sql

-- BEGIN SOURCE: supabase/migration_phase13_payment_and_admin_hardening.sql
-- Apply after phase 12. This removes legacy bootstrap identity, hardens current
-- administrator resolution, and adds recoverable Stripe event/purchase states.

-- Historical phase 5 seeded an administrator in this project's deployed
-- database. Phase 5 no longer does that for fresh/open-source installs, while
-- existing deployments retain their operator until an explicit audited change.

-- Preserve the pseudonymous actor UUID after auth-account deletion. The former
-- ON DELETE SET NULL action contradicted the non-null actor integrity check and
-- prevented deletion of any administrator/user that had emitted an audit event.
ALTER TABLE public.audit_events
  DROP CONSTRAINT IF EXISTS audit_events_actor_user_id_fkey;

-- Resolve administrator privilege from the current, verified auth identity,
-- never from the profile's signup-time email snapshot.
CREATE OR REPLACE FUNCTION public.reserve_extraction(
  p_user_id uuid,
  p_request_id uuid,
  p_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.extraction_requests%ROWTYPE;
  balance integer;
  expired_count integer;
  v_is_admin boolean := false;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_request_id IS NULL OR p_fingerprint IS NULL
    OR p_fingerprint !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'Invalid request' USING ERRCODE = '22023';
  END IF;

  SELECT credits INTO balance
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'no_credits');
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM auth.users u
    JOIN public.admin_whitelist a
      ON a.email = lower(btrim(u.email)) AND a.is_active
    WHERE u.id = p_user_id
      AND u.email IS NOT NULL
      AND u.email_confirmed_at IS NOT NULL
  ) INTO v_is_admin;

  WITH expired AS (
    UPDATE public.extraction_requests SET status = 'failed'
    WHERE user_id = p_user_id AND status = 'processing'
      AND created_at < now() - interval '10 minutes'
    RETURNING charged
  )
  SELECT count(*) FILTER (WHERE charged) INTO expired_count FROM expired;
  IF expired_count > 0 THEN
    UPDATE public.profiles SET credits = credits + expired_count, updated_at = now()
    WHERE id = p_user_id RETURNING credits INTO balance;
  END IF;

  SELECT * INTO r FROM public.extraction_requests
  WHERE user_id = p_user_id AND request_id = p_request_id;
  IF FOUND THEN
    IF r.fingerprint <> p_fingerprint THEN
      RETURN jsonb_build_object('status', 'conflict');
    END IF;
    RETURN jsonb_build_object(
      'status', r.status,
      'materialId', r.material_id,
      'remainingCredits', balance
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.account_holds
    WHERE user_id = p_user_id AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('status', 'account_held', 'remainingCredits', balance);
  END IF;

  IF NOT v_is_admin THEN
    UPDATE public.profiles SET credits = credits - 1, updated_at = now()
    WHERE id = p_user_id AND credits >= 1 RETURNING credits INTO balance;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'no_credits');
    END IF;
  END IF;

  INSERT INTO public.extraction_requests (
    user_id, request_id, fingerprint, status, charged
  ) VALUES (
    p_user_id, p_request_id, p_fingerprint, 'processing', NOT v_is_admin
  );

  IF v_is_admin THEN
    INSERT INTO public.audit_events (
      event_type, subject_user_id, actor_type, actor_user_id,
      reason, correlation_id, metadata
    ) VALUES (
      'administrator.extraction_bypassed', p_user_id,
      'administrator', p_user_id,
      'Unlimited administrator extraction reserved', p_request_id,
      jsonb_build_object('request_id', p_request_id)
    );
  END IF;

  RETURN jsonb_build_object('status', 'reserved', 'remainingCredits', balance);
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_extraction(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_extraction(uuid, uuid, text)
  TO service_role;

-- Serialize administrator authorization with revocation of that same actor.
-- Once a revocation commits, a waiting operation rechecks and fails closed.
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
    target_user_id, 'administrator', p_actor_user_id,
    btrim(p_reason), p_correlation_id,
    jsonb_build_object('target_email', normalized_email)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_account_hold(
  p_hold_id uuid,
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
  hold_row public.account_holds%ROWTYPE;
  target_user_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_hold_id IS NULL OR p_actor_user_id IS NULL OR p_correlation_id IS NULL
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Complete hold release details are required' USING ERRCODE = '22023';
  END IF;

  -- Lock the administrator entry so a concurrent revocation cannot race this
  -- authorization decision.
  PERFORM 1
  FROM auth.users u
  JOIN public.admin_whitelist a
    ON a.email = lower(btrim(u.email))
  WHERE u.id = p_actor_user_id
    AND u.email IS NOT NULL
    AND u.email_confirmed_at IS NOT NULL
    AND a.is_active
  FOR SHARE OF a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active administrator required' USING ERRCODE = '42501';
  END IF;

  SELECT user_id INTO target_user_id
  FROM public.account_holds
  WHERE id = p_hold_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account hold not found' USING ERRCODE = 'P0002';
  END IF;

  -- Match payment/extraction lock order: target profile, then hold row.
  PERFORM 1 FROM public.profiles WHERE id = target_user_id FOR UPDATE;
  SELECT * INTO hold_row
  FROM public.account_holds
  WHERE id = p_hold_id
  FOR UPDATE;

  IF hold_row.status = 'released' THEN
    RETURN jsonb_build_object('status', 'already_released', 'holdId', p_hold_id);
  END IF;

  UPDATE public.account_holds SET
    status = 'released',
    release_reason = btrim(p_reason),
    released_by = p_actor_user_id,
    released_at = now(),
    correlation_id = p_correlation_id
  WHERE id = p_hold_id;

  INSERT INTO public.audit_events (
    event_type, subject_user_id, actor_type, actor_user_id,
    reason, correlation_id, metadata
  ) VALUES (
    'account_hold.released', hold_row.user_id, 'administrator', p_actor_user_id,
    btrim(p_reason), p_correlation_id,
    jsonb_build_object(
      'hold_id', p_hold_id,
      'hold_reason', hold_row.reason,
      'hold_source', hold_row.source,
      'source_reference', hold_row.source_reference
    )
  );

  RETURN jsonb_build_object('status', 'released', 'holdId', p_hold_id);
END;
$$;

REVOKE ALL ON FUNCTION public.release_account_hold(uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_account_hold(uuid, uuid, text, uuid)
  TO service_role;

-- Add explicit abandoned-Checkout states and session expiry metadata.
ALTER TABLE public.stripe_purchases
  ADD COLUMN IF NOT EXISTS checkout_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS terminal_at timestamptz;

DO $$
DECLARE
  status_definition text;
  payment_state_definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO status_definition
  FROM pg_constraint
  WHERE conrelid = 'public.stripe_purchases'::regclass
    AND conname = 'stripe_purchases_status_check' AND contype = 'c';
  SELECT pg_get_constraintdef(oid) INTO payment_state_definition
  FROM pg_constraint
  WHERE conrelid = 'public.stripe_purchases'::regclass
    AND conname = 'stripe_purchases_check' AND contype = 'c';
  IF status_definition IS DISTINCT FROM
      'CHECK ((status = ANY (ARRAY[''pending''::text, ''paid''::text, ''refunded''::text, ''disputed''::text, ''chargeback''::text])))'
    OR payment_state_definition IS DISTINCT FROM
      'CHECK ((((status = ''pending''::text) AND (paid_at IS NULL)) OR ((status <> ''pending''::text) AND (paid_at IS NOT NULL))))' THEN
    RAISE EXCEPTION
      'Stripe purchase constraints differ from the phase 9 baseline; review before phase 13'
      USING ERRCODE = '55000';
  END IF;
END;
$$;
ALTER TABLE public.stripe_purchases
  DROP CONSTRAINT IF EXISTS stripe_purchases_status_check,
  DROP CONSTRAINT IF EXISTS stripe_purchases_check;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.stripe_purchases'::regclass
      AND constraint_row.contype = 'c'
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%status%'
  ) THEN
    RAISE EXCEPTION
      'Unexpected custom stripe_purchases status constraint; review it before phase 13'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

ALTER TABLE public.stripe_purchases
  ADD CONSTRAINT stripe_purchases_status_check
    CHECK (status IN (
      'pending', 'paid', 'canceled', 'expired',
      'refunded', 'disputed', 'chargeback'
    )),
  ADD CONSTRAINT stripe_purchases_payment_state_check
    CHECK (
      (status = 'pending' AND paid_at IS NULL AND terminal_at IS NULL)
      OR (status IN ('canceled', 'expired') AND paid_at IS NULL AND terminal_at IS NOT NULL)
      OR (status IN ('paid', 'refunded', 'disputed', 'chargeback')
        AND paid_at IS NOT NULL AND terminal_at IS NULL)
    );

-- Reconcile any pre-migration duplicate pending rows before enforcing one
-- active Checkout attempt per account.
WITH ranked_pending AS (
  SELECT id, row_number() OVER (
    PARTITION BY user_id ORDER BY created_at DESC, id DESC
  ) AS position
  FROM public.stripe_purchases
  WHERE status = 'pending'
)
UPDATE public.stripe_purchases p SET
  status = 'canceled', terminal_at = now(), updated_at = now()
FROM ranked_pending r
WHERE p.id = r.id AND r.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS stripe_purchases_one_pending_user_key
  ON public.stripe_purchases (user_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS stripe_purchases_pending_expiry_idx
  ON public.stripe_purchases (checkout_expires_at)
  WHERE status = 'pending';

-- Preserve unresolved signed Stripe events in the idempotency ledger until a
-- matching paid Checkout attaches its PaymentIntent.
DO $$
DECLARE
  outcome_definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO outcome_definition
  FROM pg_constraint
  WHERE conrelid = 'public.stripe_webhook_events'::regclass
    AND conname = 'stripe_webhook_events_outcome_check' AND contype = 'c';
  IF outcome_definition IS DISTINCT FROM
      'CHECK ((outcome = ANY (ARRAY[''processed''::text, ''ignored''::text])))' THEN
    RAISE EXCEPTION
      'Webhook outcome constraint differs from the phase 9 baseline; review before phase 13'
      USING ERRCODE = '55000';
  END IF;
END;
$$;
ALTER TABLE public.stripe_webhook_events
  DROP CONSTRAINT IF EXISTS stripe_webhook_events_outcome_check;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.stripe_webhook_events'::regclass
      AND constraint_row.contype = 'c'
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%outcome%'
  ) THEN
    RAISE EXCEPTION
      'Unexpected custom webhook outcome constraint; review it before phase 13'
      USING ERRCODE = '55000';
  END IF;
END;
$$;
ALTER TABLE public.stripe_webhook_events
  ADD CONSTRAINT stripe_webhook_events_outcome_check
    CHECK (outcome IN ('processed', 'ignored', 'unresolved'));
CREATE INDEX IF NOT EXISTS stripe_webhook_events_unresolved_payment_idx
  ON public.stripe_webhook_events ((metadata->>'payment_intent_id'))
  WHERE outcome = 'unresolved';

CREATE OR REPLACE FUNCTION public.create_pending_stripe_purchase(
  p_purchase_id uuid,
  p_user_id uuid,
  p_price_id text,
  p_livemode boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  existing_purchase public.stripe_purchases%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_purchase_id IS NULL OR p_user_id IS NULL OR p_livemode IS NULL
    OR p_price_id IS NULL OR length(p_price_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'Invalid pending purchase' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.account_holds
    WHERE user_id = p_user_id AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('status', 'held');
  END IF;

  -- Terminalize only attempts whose authoritative expiry has passed, plus an
  -- unattached worker abandoned before it could create a Stripe Session.
  UPDATE public.stripe_purchases SET
    status = CASE WHEN checkout_expires_at IS NOT NULL THEN 'expired' ELSE 'canceled' END,
    terminal_at = now(), updated_at = now()
  WHERE user_id = p_user_id AND status = 'pending'
    AND (
      checkout_expires_at <= now()
      OR (checkout_session_id IS NULL AND created_at < now() - interval '10 minutes')
    );

  SELECT * INTO existing_purchase
  FROM public.stripe_purchases
  WHERE user_id = p_user_id AND status = 'pending'
  FOR UPDATE;
  IF FOUND AND existing_purchase.livemode <> p_livemode THEN
    -- Never hide an old-mode Session: it may still be chargeable. Operators
    -- must drain/expire it with the old Stripe credentials before switching.
    RETURN jsonb_build_object(
      'status', 'environment_conflict',
      'purchaseId', existing_purchase.id,
      'checkoutSessionId', existing_purchase.checkout_session_id,
      'checkoutExpiresAt', existing_purchase.checkout_expires_at
    );
  END IF;
  IF existing_purchase.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'pending_exists',
      'purchaseId', existing_purchase.id,
      'checkoutSessionId', existing_purchase.checkout_session_id,
      'checkoutExpiresAt', existing_purchase.checkout_expires_at
    );
  END IF;

  INSERT INTO public.stripe_purchases (
    id, user_id, checkout_session_id, price_id, amount_total, currency,
    credit_amount, quantity, status, livemode
  ) VALUES (
    p_purchase_id, p_user_id, NULL, p_price_id, 300, 'usd',
    10, 1, 'pending', p_livemode
  );
  RETURN jsonb_build_object('status', 'pending', 'purchaseId', p_purchase_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.attach_stripe_checkout_session_v2(
  p_purchase_id uuid,
  p_user_id uuid,
  p_checkout_session_id text,
  p_checkout_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  purchase public.stripe_purchases%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_purchase_id IS NULL OR p_user_id IS NULL OR p_checkout_session_id IS NULL
    OR length(p_checkout_session_id) NOT BETWEEN 1 AND 255
    OR (p_checkout_expires_at IS NOT NULL AND p_checkout_expires_at <= now()) THEN
    RAISE EXCEPTION 'Invalid Checkout Session' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND OR purchase.user_id <> p_user_id THEN
    RAISE EXCEPTION 'Pending purchase not found' USING ERRCODE = 'P0002';
  END IF;
  IF purchase.status <> 'pending' THEN
    RETURN jsonb_build_object('status', purchase.status, 'purchaseId', p_purchase_id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.account_holds
    WHERE user_id = p_user_id AND status = 'active'
  ) THEN
    UPDATE public.stripe_purchases SET
      status = 'canceled', terminal_at = now(), updated_at = now()
    WHERE id = p_purchase_id;
    RETURN jsonb_build_object('status', 'held', 'purchaseId', p_purchase_id);
  END IF;
  IF purchase.checkout_session_id IS NOT NULL
    AND purchase.checkout_session_id <> p_checkout_session_id THEN
    RAISE EXCEPTION 'Checkout Session conflict' USING ERRCODE = '23505';
  END IF;
  UPDATE public.stripe_purchases SET
    checkout_session_id = p_checkout_session_id,
    checkout_expires_at = p_checkout_expires_at,
    updated_at = now()
  WHERE id = p_purchase_id;
  RETURN jsonb_build_object('status', 'pending', 'purchaseId', p_purchase_id);
END;
$$;

-- Backward-compatible wrapper for a rolling deploy. New callers should pass
-- Stripe's Session expires_at through the v2 function.
CREATE OR REPLACE FUNCTION public.attach_stripe_checkout_session(
  p_purchase_id uuid,
  p_user_id uuid,
  p_checkout_session_id text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.attach_stripe_checkout_session_v2(
    p_purchase_id, p_user_id, p_checkout_session_id, NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.close_pending_stripe_purchase(
  p_purchase_id uuid,
  p_user_id uuid,
  p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  purchase public.stripe_purchases%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_purchase_id IS NULL OR p_user_id IS NULL OR p_status IS NULL
    OR p_status NOT IN ('canceled', 'expired') THEN
    RAISE EXCEPTION 'Invalid pending purchase closure' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND OR purchase.user_id <> p_user_id THEN
    RAISE EXCEPTION 'Pending purchase not found' USING ERRCODE = 'P0002';
  END IF;
  IF purchase.status <> 'pending' THEN
    RETURN jsonb_build_object('status', purchase.status, 'purchaseId', p_purchase_id);
  END IF;
  UPDATE public.stripe_purchases SET
    status = p_status, terminal_at = now(), updated_at = now()
  WHERE id = p_purchase_id;
  RETURN jsonb_build_object('status', p_status, 'purchaseId', p_purchase_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_expired_stripe_checkout(
  p_event_id text,
  p_purchase_id uuid,
  p_user_id uuid,
  p_checkout_session_id text,
  p_livemode boolean,
  p_stripe_created_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  purchase public.stripe_purchases%ROWTYPE;
  outcome text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255
    OR p_purchase_id IS NULL OR p_user_id IS NULL
    OR p_checkout_session_id IS NULL OR length(p_checkout_session_id) NOT BETWEEN 1 AND 255
    OR p_livemode IS NULL OR p_stripe_created_at IS NULL THEN
    RAISE EXCEPTION 'Invalid expired Checkout Session' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO purchase FROM public.stripe_purchases WHERE id = p_purchase_id;
  IF NOT FOUND THEN
    RETURN public.record_rejected_stripe_event(
      p_event_id, 'checkout.session.expired', p_livemode,
      p_stripe_created_at, 'expired_purchase_missing'
    );
  END IF;
  PERFORM 1 FROM public.profiles WHERE id = purchase.user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE id = p_purchase_id FOR UPDATE;
  IF purchase.user_id <> p_user_id OR purchase.livemode <> p_livemode
    OR (purchase.checkout_session_id IS NOT NULL
      AND purchase.checkout_session_id <> p_checkout_session_id) THEN
    RETURN public.record_rejected_stripe_event(
      p_event_id, 'checkout.session.expired', p_livemode,
      p_stripe_created_at, 'expired_identity_mismatch'
    );
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.stripe_webhook_events WHERE event_id = p_event_id
  ) THEN
    RETURN jsonb_build_object('status', 'duplicate', 'purchaseId', p_purchase_id);
  END IF;

  IF purchase.status IN ('pending', 'canceled', 'expired') THEN
    UPDATE public.stripe_purchases SET
      checkout_session_id = p_checkout_session_id,
      status = 'expired',
      terminal_at = coalesce(terminal_at, now()),
      updated_at = now()
    WHERE id = p_purchase_id;
    outcome := 'processed';
  ELSE
    outcome := 'ignored';
  END IF;

  INSERT INTO public.stripe_webhook_events (
    event_id, event_type, purchase_id, outcome, livemode, stripe_created_at
  ) VALUES (
    p_event_id, 'checkout.session.expired', p_purchase_id,
    outcome, p_livemode, p_stripe_created_at
  );
  INSERT INTO public.audit_events (
    event_type, subject_user_id, actor_type, reason, correlation_id, metadata
  ) VALUES (
    'payment.checkout_expired', p_user_id, 'stripe_webhook',
    CASE WHEN outcome = 'processed'
      THEN 'Stripe Checkout Session expired without payment'
      ELSE 'Late Checkout expiration observed after payment fulfillment'
    END,
    p_purchase_id,
    jsonb_build_object(
      'stripe_event_id', p_event_id,
      'checkout_session_id', p_checkout_session_id,
      'outcome', outcome
    )
  );
  RETURN jsonb_build_object(
    'status', CASE WHEN outcome = 'processed' THEN 'expired' ELSE 'already_fulfilled' END,
    'purchaseId', p_purchase_id
  );
END;
$$;

-- Permanently malformed but correctly signed relevant events are committed to
-- the idempotency/audit ledger. Stripe may then receive 2xx without retrying
-- an event that can never become valid, while database failures still retry.
CREATE OR REPLACE FUNCTION public.record_rejected_stripe_event(
  p_event_id text,
  p_event_type text,
  p_livemode boolean,
  p_stripe_created_at timestamptz,
  p_validation_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255
    OR p_event_type IS NULL OR length(p_event_type) NOT BETWEEN 1 AND 255
    OR p_livemode IS NULL OR p_stripe_created_at IS NULL
    OR p_validation_code IS NULL OR p_validation_code NOT IN (
      'paid_session_identity_missing',
      'paid_session_package_mismatch',
      'expired_session_identity_missing',
      'checkout_purchase_missing',
      'checkout_identity_mismatch',
      'expired_purchase_missing',
      'expired_identity_mismatch'
    ) THEN
    RAISE EXCEPTION 'Invalid rejected Stripe event' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.stripe_webhook_events (
    event_id, event_type, purchase_id, outcome, livemode,
    stripe_created_at, metadata
  ) VALUES (
    p_event_id, p_event_type, NULL, 'ignored', p_livemode,
    p_stripe_created_at, jsonb_build_object('validation_code', p_validation_code)
  ) ON CONFLICT (event_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;

  INSERT INTO public.audit_events (
    event_type, subject_user_id, actor_type, reason, metadata
  ) VALUES (
    'payment.webhook_rejected', NULL, 'stripe_webhook',
    'A signed relevant Stripe event failed permanent validation',
    jsonb_build_object(
      'stripe_event_id', p_event_id,
      'stripe_event_type', p_event_type,
      'validation_code', p_validation_code,
      'livemode', p_livemode
    )
  );
  RETURN jsonb_build_object('status', 'rejected');
END;
$$;

-- Non-financial abandoned attempts can be removed after a cooling-off period.
-- Purchases referenced by an auditable webhook event remain subject to the
-- financial retention policy and are deliberately not deleted here.
CREATE OR REPLACE FUNCTION public.purge_abandoned_stripe_purchases(
  p_before timestamptz,
  p_limit integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_before IS NULL OR p_before > now() - interval '30 days'
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Invalid abandoned purchase retention request' USING ERRCODE = '22023';
  END IF;
  WITH candidates AS (
    SELECT p.id
    FROM public.stripe_purchases p
    WHERE p.status IN ('canceled', 'expired')
      AND p.paid_at IS NULL
      AND p.terminal_at < p_before
      AND NOT EXISTS (
        SELECT 1 FROM public.stripe_webhook_events e
        WHERE e.purchase_id = p.id
      )
    ORDER BY p.terminal_at, p.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM public.stripe_purchases p
    USING candidates c
    WHERE p.id = c.id
    RETURNING p.id
  )
  SELECT count(*) INTO deleted_count FROM deleted;
  RETURN deleted_count;
END;
$$;

-- Internal helper. Callers must already hold the target profile and purchase
-- locks in that order. It never writes the webhook idempotency row itself.
CREATE OR REPLACE FUNCTION public.apply_stripe_hold_event(
  p_purchase_id uuid,
  p_event_id text,
  p_event_type text,
  p_source_reference text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  purchase public.stripe_purchases%ROWTYPE;
  existing_hold public.account_holds%ROWTYPE;
  hold_reason text;
  purchase_status text;
  desired_rank integer;
  current_rank integer;
  hold_rank integer;
  effective_reason text;
  changed boolean := false;
BEGIN
  CASE p_event_type
    WHEN 'charge.refunded' THEN
      hold_reason := 'refund'; purchase_status := 'refunded'; desired_rank := 1;
    WHEN 'charge.dispute.created' THEN
      hold_reason := 'dispute'; purchase_status := 'disputed'; desired_rank := 2;
    WHEN 'charge.dispute.closed' THEN
      hold_reason := 'chargeback'; purchase_status := 'chargeback'; desired_rank := 3;
    ELSE
      RAISE EXCEPTION 'Unsupported Stripe hold event' USING ERRCODE = '22023';
  END CASE;

  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND OR purchase.paid_at IS NULL THEN
    RAISE EXCEPTION 'Paid purchase not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO existing_hold FROM public.account_holds
  WHERE source = 'stripe' AND source_reference = p_source_reference
  FOR UPDATE;
  IF FOUND THEN
    hold_rank := CASE existing_hold.reason
      WHEN 'refund' THEN 1 WHEN 'dispute' THEN 2 WHEN 'chargeback' THEN 3 ELSE 0
    END;
    effective_reason := CASE WHEN hold_rank > desired_rank
      THEN existing_hold.reason ELSE hold_reason END;
    UPDATE public.account_holds SET
      reason = effective_reason,
      status = 'active',
      release_reason = NULL,
      released_by = NULL,
      released_at = NULL,
      correlation_id = purchase.id,
      metadata = metadata || jsonb_build_object('stripe_event_id', p_event_id)
    WHERE id = existing_hold.id;
    changed := existing_hold.status <> 'active' OR effective_reason <> existing_hold.reason;
  ELSE
    INSERT INTO public.account_holds (
      user_id, reason, source, source_reference, correlation_id, metadata
    ) VALUES (
      purchase.user_id, hold_reason, 'stripe', p_source_reference,
      purchase.id, jsonb_build_object('stripe_event_id', p_event_id)
    );
    changed := true;
  END IF;

  current_rank := CASE purchase.status
    WHEN 'refunded' THEN 1 WHEN 'disputed' THEN 2 WHEN 'chargeback' THEN 3 ELSE 0
  END;
  IF desired_rank > current_rank THEN
    UPDATE public.stripe_purchases SET status = purchase_status, updated_at = now()
    WHERE id = purchase.id;
    changed := true;
  END IF;

  INSERT INTO public.audit_events (
    event_type, subject_user_id, actor_type, reason, correlation_id, metadata
  ) VALUES (
    'payment.account_held', purchase.user_id, 'stripe_webhook',
    'Stripe refund or dispute placed the account under review', purchase.id,
    jsonb_build_object(
      'stripe_event_id', p_event_id,
      'stripe_event_type', p_event_type,
      'hold_reason', hold_reason,
      'source_reference', p_source_reference,
      'state_changed', changed
    )
  );
  RETURN changed;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_stripe_hold_event(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_stripe_account_hold(
  p_event_id text,
  p_event_type text,
  p_payment_intent_id text,
  p_source_reference text,
  p_livemode boolean,
  p_stripe_created_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  purchase public.stripe_purchases%ROWTYPE;
  event_outcome text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255
    OR p_event_type IS NULL OR p_event_type NOT IN (
      'charge.refunded', 'charge.dispute.created', 'charge.dispute.closed'
    )
    OR p_payment_intent_id IS NULL OR length(p_payment_intent_id) NOT BETWEEN 1 AND 255
    OR p_source_reference IS NULL OR length(p_source_reference) NOT BETWEEN 1 AND 255
    OR p_livemode IS NULL OR p_stripe_created_at IS NULL THEN
    RAISE EXCEPTION 'Invalid Stripe hold event' USING ERRCODE = '22023';
  END IF;

  -- Serialize hold delivery against fulfillment for the same PaymentIntent.
  -- Without this lock, fulfillment could scan just before an unresolved event
  -- is inserted, leaving a valid hold permanently unreconciled.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_payment_intent_id, 0)
  );

  SELECT outcome INTO event_outcome
  FROM public.stripe_webhook_events
  WHERE event_id = p_event_id;
  IF FOUND AND event_outcome <> 'unresolved' THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;

  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE payment_intent_id = p_payment_intent_id;
  IF NOT FOUND THEN
    INSERT INTO public.stripe_webhook_events (
      event_id, event_type, purchase_id, outcome, livemode,
      stripe_created_at, metadata
    ) VALUES (
      p_event_id, p_event_type, NULL, 'unresolved', p_livemode,
      p_stripe_created_at,
      jsonb_build_object(
        'payment_intent_id', p_payment_intent_id,
        'source_reference', p_source_reference
      )
    ) ON CONFLICT (event_id) DO NOTHING;
    RETURN jsonb_build_object('status', 'unresolved');
  END IF;

  PERFORM 1 FROM public.profiles WHERE id = purchase.user_id FOR UPDATE;
  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE id = purchase.id FOR UPDATE;
  IF purchase.livemode <> p_livemode OR purchase.paid_at IS NULL THEN
    RAISE EXCEPTION 'Stripe event does not match a paid purchase' USING ERRCODE = '22023';
  END IF;

  PERFORM public.apply_stripe_hold_event(
    purchase.id, p_event_id, p_event_type, p_source_reference
  );
  IF event_outcome = 'unresolved' THEN
    UPDATE public.stripe_webhook_events SET
      purchase_id = purchase.id,
      outcome = 'processed',
      processed_at = now()
    WHERE event_id = p_event_id;
  ELSE
    INSERT INTO public.stripe_webhook_events (
      event_id, event_type, purchase_id, outcome, livemode, stripe_created_at,
      metadata
    ) VALUES (
      p_event_id, p_event_type, purchase.id, 'processed', p_livemode,
      p_stripe_created_at,
      jsonb_build_object(
        'payment_intent_id', p_payment_intent_id,
        'source_reference', p_source_reference
      )
    );
  END IF;
  RETURN jsonb_build_object('status', 'held');
END;
$$;

CREATE OR REPLACE FUNCTION public.fulfill_stripe_checkout_v2(
  p_event_id text,
  p_purchase_id uuid,
  p_user_id uuid,
  p_checkout_session_id text,
  p_payment_intent_id text,
  p_amount_total integer,
  p_currency text,
  p_livemode boolean,
  p_stripe_created_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  purchase public.stripe_purchases%ROWTYPE;
  unresolved public.stripe_webhook_events%ROWTYPE;
  balance integer;
  reconciled_count integer := 0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255
    OR p_purchase_id IS NULL OR p_user_id IS NULL
    OR p_checkout_session_id IS NULL OR length(p_checkout_session_id) NOT BETWEEN 1 AND 255
    OR p_payment_intent_id IS NULL OR length(p_payment_intent_id) NOT BETWEEN 1 AND 255
    OR p_amount_total <> 300 OR p_currency IS NULL OR lower(p_currency) <> 'usd'
    OR p_livemode IS NULL OR p_stripe_created_at IS NULL THEN
    RAISE EXCEPTION 'Invalid paid Checkout Session' USING ERRCODE = '22023';
  END IF;

  -- Use the same first lock as hold delivery so an unresolved event is always
  -- visible before this transaction's reconciliation scan, or else observes
  -- this transaction's attached PaymentIntent and processes synchronously.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_payment_intent_id, 0)
  );

  SELECT * INTO purchase FROM public.stripe_purchases WHERE id = p_purchase_id;
  IF NOT FOUND THEN
    RETURN public.record_rejected_stripe_event(
      p_event_id, 'checkout.session.completed', p_livemode,
      p_stripe_created_at, 'checkout_purchase_missing'
    );
  END IF;
  SELECT credits INTO balance FROM public.profiles
  WHERE id = purchase.user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE id = p_purchase_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.stripe_webhook_events WHERE event_id = p_event_id
  ) THEN
    RETURN jsonb_build_object('status', 'duplicate', 'remainingCredits', balance);
  END IF;
  IF purchase.user_id <> p_user_id OR purchase.livemode <> p_livemode
    OR purchase.amount_total <> p_amount_total
    OR purchase.currency <> lower(p_currency)
    OR purchase.credit_amount <> 10 OR purchase.quantity <> 1
    OR (purchase.checkout_session_id IS NOT NULL
      AND purchase.checkout_session_id <> p_checkout_session_id) THEN
    RETURN public.record_rejected_stripe_event(
      p_event_id, 'checkout.session.completed', p_livemode,
      p_stripe_created_at, 'checkout_identity_mismatch'
    );
  END IF;

  IF purchase.status IN ('paid', 'refunded', 'disputed', 'chargeback') THEN
    INSERT INTO public.stripe_webhook_events (
      event_id, event_type, purchase_id, outcome, livemode, stripe_created_at
    ) VALUES (
      p_event_id, 'checkout.session.completed', p_purchase_id,
      'ignored', p_livemode, p_stripe_created_at
    );
    RETURN jsonb_build_object('status', 'already_fulfilled', 'remainingCredits', balance);
  END IF;

  -- A canceled/expired local attempt can still have succeeded at Stripe. A
  -- verified paid event is authoritative and must not strand customer funds.
  UPDATE public.stripe_purchases SET
    checkout_session_id = p_checkout_session_id,
    payment_intent_id = p_payment_intent_id,
    status = 'paid', paid_at = now(), terminal_at = NULL, updated_at = now()
  WHERE id = p_purchase_id;
  UPDATE public.profiles SET credits = credits + purchase.credit_amount, updated_at = now()
  WHERE id = p_user_id RETURNING credits INTO balance;
  INSERT INTO public.stripe_webhook_events (
    event_id, event_type, purchase_id, outcome, livemode, stripe_created_at
  ) VALUES (
    p_event_id, 'checkout.session.completed', p_purchase_id,
    'processed', p_livemode, p_stripe_created_at
  );
  INSERT INTO public.audit_events (
    event_type, subject_user_id, actor_type, reason, correlation_id, metadata
  ) VALUES (
    'payment.credits_granted', p_user_id, 'stripe_webhook',
    'Paid Stripe Checkout granted 10 credits', p_purchase_id,
    jsonb_build_object(
      'stripe_event_id', p_event_id,
      'checkout_session_id', p_checkout_session_id,
      'amount_total', p_amount_total,
      'currency', lower(p_currency),
      'credits', purchase.credit_amount,
      'configured_price_id', purchase.price_id
    )
  );

  FOR unresolved IN
    SELECT * FROM public.stripe_webhook_events
    WHERE outcome = 'unresolved'
      AND livemode = p_livemode
      AND metadata->>'payment_intent_id' = p_payment_intent_id
    ORDER BY stripe_created_at, event_id
    FOR UPDATE
  LOOP
    PERFORM public.apply_stripe_hold_event(
      p_purchase_id,
      unresolved.event_id,
      unresolved.event_type,
      unresolved.metadata->>'source_reference'
    );
    UPDATE public.stripe_webhook_events SET
      purchase_id = p_purchase_id,
      outcome = 'processed',
      processed_at = now()
    WHERE event_id = unresolved.event_id;
    reconciled_count := reconciled_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'fulfilled',
    'remainingCredits', balance,
    'reconciledEvents', reconciled_count
  );
END;
$$;

-- Rolling-deploy compatibility. The event-supplied/current configured Price ID
-- is deliberately not used for authorization; the immutable pending purchase
-- stores the Price that created the Session.
CREATE OR REPLACE FUNCTION public.fulfill_stripe_checkout(
  p_event_id text,
  p_purchase_id uuid,
  p_user_id uuid,
  p_checkout_session_id text,
  p_payment_intent_id text,
  p_price_id text,
  p_amount_total integer,
  p_currency text,
  p_livemode boolean,
  p_stripe_created_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_price_id IS NULL OR length(p_price_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'Invalid configured Price' USING ERRCODE = '22023';
  END IF;
  RETURN public.fulfill_stripe_checkout_v2(
    p_event_id, p_purchase_id, p_user_id, p_checkout_session_id,
    p_payment_intent_id, p_amount_total, p_currency, p_livemode,
    p_stripe_created_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_stripe_purchase_status(
  p_user_id uuid,
  p_checkout_session_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  purchase_status text;
  balance integer;
  held boolean;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_checkout_session_id IS NULL
    OR length(p_checkout_session_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'Invalid purchase status request' USING ERRCODE = '22023';
  END IF;

  SELECT purchase.status, profile.credits INTO purchase_status, balance
  FROM public.stripe_purchases AS purchase
  JOIN public.profiles AS profile ON profile.id = purchase.user_id
  WHERE purchase.user_id = p_user_id
    AND purchase.checkout_session_id = p_checkout_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.account_holds
    WHERE user_id = p_user_id AND status = 'active'
  ) INTO held;
  RETURN jsonb_build_object(
    'status', purchase_status,
    'remainingCredits', balance,
    'accountHeld', held
  );
END;
$$;

-- Server routes retain narrow reads, while all financial, hold, and audit
-- mutations must pass through owner-defined transactions.
REVOKE INSERT, UPDATE, DELETE ON public.profiles,
  public.account_holds,
  public.stripe_purchases,
  public.stripe_webhook_events,
  public.audit_events
  FROM service_role;
REVOKE ALL ON FUNCTION public.add_credits(uuid, integer),
  public.decrement_credits(uuid)
  FROM service_role;

REVOKE ALL ON FUNCTION public.create_pending_stripe_purchase(uuid, uuid, text, boolean),
  public.attach_stripe_checkout_session_v2(uuid, uuid, text, timestamptz),
  public.attach_stripe_checkout_session(uuid, uuid, text),
  public.close_pending_stripe_purchase(uuid, uuid, text),
  public.record_expired_stripe_checkout(text, uuid, uuid, text, boolean, timestamptz),
  public.record_rejected_stripe_event(text, text, boolean, timestamptz, text),
  public.purge_abandoned_stripe_purchases(timestamptz, integer),
  public.get_stripe_purchase_status(uuid, text),
  public.record_stripe_account_hold(text, text, text, text, boolean, timestamptz),
  public.fulfill_stripe_checkout_v2(text, uuid, uuid, text, text, integer, text, boolean, timestamptz),
  public.fulfill_stripe_checkout(text, uuid, uuid, text, text, text, integer, text, boolean, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_pending_stripe_purchase(uuid, uuid, text, boolean),
  public.attach_stripe_checkout_session_v2(uuid, uuid, text, timestamptz),
  public.attach_stripe_checkout_session(uuid, uuid, text),
  public.close_pending_stripe_purchase(uuid, uuid, text),
  public.record_expired_stripe_checkout(text, uuid, uuid, text, boolean, timestamptz),
  public.record_rejected_stripe_event(text, text, boolean, timestamptz, text),
  public.purge_abandoned_stripe_purchases(timestamptz, integer),
  public.get_stripe_purchase_status(uuid, text),
  public.record_stripe_account_hold(text, text, text, text, boolean, timestamptz),
  public.fulfill_stripe_checkout_v2(text, uuid, uuid, text, text, integer, text, boolean, timestamptz),
  public.fulfill_stripe_checkout(text, uuid, uuid, text, text, text, integer, text, boolean, timestamptz)
  TO service_role;
-- END SOURCE: supabase/migration_phase13_payment_and_admin_hardening.sql

-- BEGIN SOURCE: supabase/migration_phase14_storage_abuse_controls.sql
-- Apply after phase 13. Browser uploads must reserve an exact owned path and
-- byte count before calling the Storage API. This avoids custom triggers in the
-- Storage-managed schema while atomically bounding aggregate usage.

LOCK TABLE storage.objects IN SHARE ROW EXCLUSIVE MODE;

-- Retire the legacy metadata-only cleanup function. Stored bytes must be
-- removed through the Storage API before reservations are released.
DROP FUNCTION IF EXISTS public.cleanup_old_course_materials();

UPDATE storage.buckets
SET public = false,
  file_size_limit = limits.max_total_bytes_per_user
FROM public.course_material_upload_limits AS limits
WHERE storage.buckets.id = 'course-materials'
  AND limits.config_key = 'course-materials';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM storage.buckets AS bucket
    JOIN public.course_material_upload_limits AS limits
      ON limits.config_key = 'course-materials'
    WHERE bucket.id = 'course-materials'
      AND bucket.file_size_limit = limits.max_total_bytes_per_user
  ) THEN
    RAISE EXCEPTION
      'Course material upload limits are missing; apply migration_storage_setup.sql first'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_course_material_storage_path(
  p_name text,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
  SELECT p_name ~ (
    '^' || p_user_id::text ||
    '/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}' ||
    '/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}' ||
    '\.(pdf|png|jpg|jpeg|webp|gif)$'
  )
$$;

CREATE TABLE public.course_material_upload_reservations (
  path text PRIMARY KEY CHECK (length(path) BETWEEN 1 AND 1024),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (public.is_course_material_storage_path(path, user_id))
);
CREATE INDEX course_material_upload_reservations_user_idx
  ON public.course_material_upload_reservations (user_id);
ALTER TABLE public.course_material_upload_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.course_material_upload_reservations
  FROM PUBLIC, anon, authenticated, service_role;

-- Fail rather than silently omitting incompatible deployed objects. Operators
-- must remove invalid objects through the Storage API before retrying.
DO $$
DECLARE
  configured_max_files integer;
  configured_max_total_bytes bigint;
BEGIN
  SELECT max_files_per_user, max_total_bytes_per_user
  INTO configured_max_files, configured_max_total_bytes
  FROM public.course_material_upload_limits
  WHERE config_key = 'course-materials';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Course material upload limits are missing'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM storage.objects AS object
    WHERE object.bucket_id = 'course-materials'
      AND (
        object.name IS NULL
        OR object.name !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(pdf|png|jpg|jpeg|webp|gif)$'
        OR object.metadata->>'size' IS NULL
        OR object.metadata->>'size' !~ '^[0-9]+$'
        OR (object.metadata->>'size')::numeric NOT BETWEEN 1 AND configured_max_total_bytes
      )
  ) THEN
    RAISE EXCEPTION
      'Course material objects must have an owned three-part path and valid size metadata'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM storage.objects AS object
    WHERE object.bucket_id = 'course-materials'
    GROUP BY split_part(object.name, '/', 1)
    HAVING count(*) > configured_max_files
      OR sum((object.metadata->>'size')::bigint) > configured_max_total_bytes
  ) THEN
    RAISE EXCEPTION 'Existing course material usage exceeds quota'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

INSERT INTO public.course_material_upload_reservations (
  path, user_id, size_bytes
)
SELECT
  object.name,
  split_part(object.name, '/', 1)::uuid,
  (object.metadata->>'size')::bigint
FROM storage.objects AS object
WHERE object.bucket_id = 'course-materials';

CREATE OR REPLACE FUNCTION public.reserve_course_material_upload(
  p_path text,
  p_size_bytes bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller_id uuid := auth.uid();
  reserved_count integer;
  reserved_bytes bigint;
  stored_size bigint;
  stale_path text;
  configured_max_files integer;
  configured_max_total_bytes bigint;
  existing_reservation public.course_material_upload_reservations%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_path IS NULL OR p_size_bytes IS NULL OR p_size_bytes < 1
    OR NOT public.is_course_material_storage_path(p_path, caller_id) THEN
    RAISE EXCEPTION 'Invalid upload reservation' USING ERRCODE = '22023';
  END IF;

  SELECT max_files_per_user, max_total_bytes_per_user
  INTO configured_max_files, configured_max_total_bytes
  FROM public.course_material_upload_limits
  WHERE config_key = 'course-materials'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Course material upload limits are unavailable'
      USING ERRCODE = '55000';
  END IF;
  IF p_size_bytes > configured_max_total_bytes THEN
    RAISE EXCEPTION 'Course material storage quota exceeded'
      USING ERRCODE = '23514';
  END IF;

  -- The profile row serializes all reservations for this user. Each PL/pgSQL
  -- statement observes commits completed while waiting for this lock.
  PERFORM 1 FROM public.profiles WHERE id = caller_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;

  -- Recover reservation-only crashes after the same 24-hour window used by
  -- active extraction cleanup. The profile lock blocks new reservations while
  -- per-path locks serialize this check with Storage INSERT validation.
  FOR stale_path IN
    SELECT path FROM public.course_material_upload_reservations
    WHERE user_id = caller_id
      AND updated_at < now() - interval '24 hours'
    ORDER BY path
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(stale_path, 140014)
    );
  END LOOP;
  PERFORM 1 FROM public.course_material_upload_reservations
  WHERE user_id = caller_id
    AND updated_at < now() - interval '24 hours'
  FOR UPDATE;
  DELETE FROM public.course_material_upload_reservations AS reservation
  WHERE reservation.user_id = caller_id
    AND reservation.updated_at < now() - interval '24 hours'
    AND NOT EXISTS (
      SELECT 1 FROM storage.objects AS object
      WHERE object.bucket_id = 'course-materials'
        AND object.name = reservation.path
    );

  -- Storage INSERT validation and reservation release take this same lock.
  -- It closes the gap where an INSERT could validate immediately before a
  -- concurrent release deleted the reservation it depends on.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_path, 140014)
  );

  SELECT * INTO existing_reservation
  FROM public.course_material_upload_reservations
  WHERE path = p_path
  FOR UPDATE;
  IF FOUND AND (
    existing_reservation.user_id <> caller_id
    OR existing_reservation.size_bytes <> p_size_bytes
  ) THEN
    RAISE EXCEPTION 'Upload paths and sizes are immutable'
      USING ERRCODE = '23505';
  END IF;

  SELECT (object.metadata->>'size')::bigint INTO stored_size
  FROM storage.objects AS object
  WHERE object.bucket_id = 'course-materials' AND object.name = p_path;
  IF FOUND THEN
    IF existing_reservation.path IS NULL OR stored_size <> p_size_bytes THEN
      RAISE EXCEPTION 'Stored object does not match its reservation'
        USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object('status', 'already_stored', 'path', p_path);
  END IF;

  SELECT count(*), coalesce(sum(size_bytes), 0)
  INTO reserved_count, reserved_bytes
  FROM public.course_material_upload_reservations
  WHERE user_id = caller_id AND path <> p_path;
  IF reserved_count >= configured_max_files
    OR reserved_bytes + p_size_bytes > configured_max_total_bytes THEN
    RAISE EXCEPTION 'Course material storage quota exceeded'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.course_material_upload_reservations AS reservation (
    path, user_id, size_bytes, updated_at
  ) VALUES (
    p_path, caller_id, p_size_bytes, now()
  )
  ON CONFLICT (path) DO NOTHING;

  RETURN jsonb_build_object('status', 'reserved', 'path', p_path);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_course_material_uploads(
  p_paths text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller_id uuid := auth.uid();
  path_value text;
  released_count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  -- This is a request-shape safety bound, not the configurable storage quota.
  IF p_paths IS NULL OR cardinality(p_paths) NOT BETWEEN 1 AND 100
    OR cardinality(p_paths) <> (
      SELECT count(DISTINCT value) FROM unnest(p_paths) AS value
    ) THEN
    RAISE EXCEPTION 'Invalid upload release' USING ERRCODE = '22023';
  END IF;
  FOREACH path_value IN ARRAY p_paths LOOP
    IF NOT public.is_course_material_storage_path(path_value, caller_id) THEN
      RAISE EXCEPTION 'Invalid upload release path' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  PERFORM 1 FROM public.profiles WHERE id = caller_id FOR UPDATE;

  -- Lock paths in a deterministic order, then lock the reservation rows. The
  -- Storage policy helper takes the same advisory lock for the duration of an
  -- INSERT, so either the insert commits first or release removes the ledger
  -- before a later insert can validate.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(candidate.path, 140014)
  )
  FROM (
    SELECT value AS path FROM unnest(p_paths) AS value ORDER BY value
  ) AS candidate;
  PERFORM 1
  FROM public.course_material_upload_reservations
  WHERE user_id = caller_id AND path = ANY(p_paths)
  FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM storage.objects
    WHERE bucket_id = 'course-materials' AND name = ANY(p_paths)
  ) THEN
    RAISE EXCEPTION 'Delete Storage objects before releasing reservations'
      USING ERRCODE = '55000';
  END IF;

  DELETE FROM public.course_material_upload_reservations
  WHERE user_id = caller_id AND path = ANY(p_paths);
  GET DIAGNOSTICS released_count = ROW_COUNT;
  RETURN jsonb_build_object('status', 'released', 'releasedCount', released_count);
END;
$$;

CREATE OR REPLACE FUNCTION public.has_course_material_upload_reservation(
  p_name text,
  p_user_id uuid,
  p_metadata jsonb
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  allowed boolean;
  upload_length bigint;
  using_content_length boolean := false;
  multipart_overhead_allowance constant bigint := 64 * 1024;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated'
    OR auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid()
    OR p_name IS NULL OR p_metadata IS NULL
    OR NOT public.is_course_material_storage_path(p_name, p_user_id) THEN
    RETURN false;
  END IF;

  -- Storage's RLS preflight runs before the object exists. Current managed
  -- Storage supplies the HTTP request length as contentLength at that point;
  -- the final object size is only written after the bytes reach the backend.
  -- Standard multipart uploads add a small amount of framing, so bind the
  -- preflight length to the reservation with a deliberately narrow ceiling.
  IF p_metadata->>'size' ~ '^[0-9]{1,18}$' THEN
    upload_length := (p_metadata->>'size')::bigint;
  ELSIF p_metadata->>'contentLength' ~ '^[0-9]{1,18}$' THEN
    upload_length := (p_metadata->>'contentLength')::bigint;
    using_content_length := true;
  ELSE
    RETURN false;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_name, 140014)
  );
  SELECT EXISTS (
    SELECT 1 FROM public.course_material_upload_reservations AS reservation
    WHERE reservation.path = p_name
      AND reservation.user_id = p_user_id
      AND (
        reservation.size_bytes = upload_length
        OR (
          using_content_length
          AND upload_length BETWEEN reservation.size_bytes
            AND reservation.size_bytes + multipart_overhead_allowance
        )
      )
  ) INTO allowed;
  RETURN allowed;
END;
$$;

-- Account deletion must delete Storage objects through the Storage API first.
-- This service-only operation then removes abandoned ledger rows without
-- restoring broad table mutation privileges to the service role.
CREATE OR REPLACE FUNCTION public.cleanup_course_material_upload_reservations(
  p_user_id uuid,
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
  path_value text;
  released_count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_actor_user_id IS NULL OR p_correlation_id IS NULL
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'Invalid reservation cleanup request' USING ERRCODE = '22023';
  END IF;
  PERFORM 1
    FROM auth.users AS admin_user
    JOIN public.admin_whitelist AS admin
      ON lower(admin.email) = lower(admin_user.email)
    WHERE admin_user.id = p_actor_user_id
      AND admin_user.email_confirmed_at IS NOT NULL
      AND admin.is_active = true
    FOR SHARE OF admin;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current verified administrator required' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM auth.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target profile not found' USING ERRCODE = 'P0002';
  END IF;

  FOR path_value IN
    SELECT path FROM public.course_material_upload_reservations
    WHERE user_id = p_user_id ORDER BY path
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(path_value, 140014)
    );
  END LOOP;
  PERFORM 1 FROM public.course_material_upload_reservations
  WHERE user_id = p_user_id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM storage.objects
    WHERE bucket_id = 'course-materials'
      AND name LIKE p_user_id::text || '/%'
  ) THEN
    RAISE EXCEPTION 'Delete Storage objects before cleaning reservations'
      USING ERRCODE = '55000';
  END IF;

  DELETE FROM public.course_material_upload_reservations WHERE user_id = p_user_id;
  GET DIAGNOSTICS released_count = ROW_COUNT;
  IF released_count > 0 THEN
    INSERT INTO public.audit_events (
      event_type, subject_user_id, actor_type, actor_user_id,
      reason, correlation_id, metadata
    ) VALUES (
      'storage.reservations_released', p_user_id, 'administrator', p_actor_user_id,
      btrim(p_reason), p_correlation_id,
      jsonb_build_object('released_count', released_count)
    );
  END IF;
  RETURN jsonb_build_object(
    'status', CASE WHEN released_count > 0 THEN 'released' ELSE 'already_clean' END,
    'releasedCount', released_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.is_course_material_storage_path(text, uuid),
  public.reserve_course_material_upload(text, bigint),
  public.release_course_material_uploads(text[]),
  public.has_course_material_upload_reservation(text, uuid, jsonb),
  public.cleanup_course_material_upload_reservations(uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_course_material_upload(text, bigint),
  public.release_course_material_uploads(text[]),
  public.is_course_material_storage_path(text, uuid),
  public.has_course_material_upload_reservation(text, uuid, jsonb)
  TO authenticated;
GRANT EXECUTE ON FUNCTION
  public.cleanup_course_material_upload_reservations(uuid, uuid, text, uuid)
  TO service_role;

DROP POLICY IF EXISTS "Users can upload to own folder" ON storage.objects;
DROP POLICY IF EXISTS "Users can read own files" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own files" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own files" ON storage.objects;
DROP POLICY IF EXISTS "Course material ownership is always required" ON storage.objects;
DROP POLICY IF EXISTS "Anonymous users cannot access course materials" ON storage.objects;
DROP POLICY IF EXISTS "Users can update reserved course paths" ON storage.objects;
DROP POLICY IF EXISTS "Course material objects cannot be overwritten" ON storage.objects;

-- Restrictive policies remain mandatory even if a deployment has an unknown
-- permissive policy, because PostgreSQL ANDs restrictive policies with the
-- union of permissive policies.
CREATE POLICY "Course material ownership is always required"
ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated
USING (
  bucket_id <> 'course-materials'
  OR public.is_course_material_storage_path(name, auth.uid())
)
WITH CHECK (
  bucket_id <> 'course-materials'
  OR public.has_course_material_upload_reservation(name, auth.uid(), metadata)
);

CREATE POLICY "Anonymous users cannot access course materials"
ON storage.objects AS RESTRICTIVE FOR ALL TO anon
USING (bucket_id <> 'course-materials')
WITH CHECK (bucket_id <> 'course-materials');

-- Generated upload paths are immutable. This restrictive policy also defeats
-- an unknown permissive UPDATE policy left by an older deployment.
CREATE POLICY "Course material objects cannot be overwritten"
ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
USING (bucket_id <> 'course-materials')
WITH CHECK (bucket_id <> 'course-materials');

CREATE POLICY "Users can upload reserved course paths"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'course-materials'
  AND public.has_course_material_upload_reservation(name, auth.uid(), metadata)
);

CREATE POLICY "Users can read exact owned course paths"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'course-materials'
  AND public.is_course_material_storage_path(name, auth.uid())
);

CREATE POLICY "Users can delete exact owned course paths"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'course-materials'
  AND public.is_course_material_storage_path(name, auth.uid())
);
-- END SOURCE: supabase/migration_phase14_storage_abuse_controls.sql

-- BEGIN SOURCE: supabase/migration_phase15_storage_upload_preflight.sql
-- Apply after phase 14. Managed Supabase Storage performs its upload RLS
-- preflight before final object metadata exists. Bind its server-supplied HTTP
-- content length to the exact browser reservation while allowing only bounded
-- multipart framing overhead.

CREATE OR REPLACE FUNCTION public.has_course_material_upload_reservation(
  p_name text,
  p_user_id uuid,
  p_metadata jsonb
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  allowed boolean;
  upload_length bigint;
  using_content_length boolean := false;
  multipart_overhead_allowance constant bigint := 64 * 1024;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated'
    OR auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid()
    OR p_name IS NULL OR p_metadata IS NULL
    OR NOT public.is_course_material_storage_path(p_name, p_user_id) THEN
    RETURN false;
  END IF;

  IF p_metadata->>'size' ~ '^[0-9]{1,18}$' THEN
    upload_length := (p_metadata->>'size')::bigint;
  ELSIF p_metadata->>'contentLength' ~ '^[0-9]{1,18}$' THEN
    upload_length := (p_metadata->>'contentLength')::bigint;
    using_content_length := true;
  ELSE
    RETURN false;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_name, 140014)
  );
  SELECT EXISTS (
    SELECT 1 FROM public.course_material_upload_reservations AS reservation
    WHERE reservation.path = p_name
      AND reservation.user_id = p_user_id
      AND (
        reservation.size_bytes = upload_length
        OR (
          using_content_length
          AND upload_length BETWEEN reservation.size_bytes
            AND reservation.size_bytes + multipart_overhead_allowance
        )
      )
  ) INTO allowed;
  RETURN allowed;
END;
$$;

REVOKE ALL ON FUNCTION public.has_course_material_upload_reservation(text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_course_material_upload_reservation(text, uuid, jsonb)
  TO authenticated;
-- END SOURCE: supabase/migration_phase15_storage_upload_preflight.sql

-- BEGIN SOURCE: supabase/migration_phase16_auth_confirmation_compatibility.sql
-- Apply after phase 15. Supabase Auth inserts a user before it marks the email
-- as confirmed, so defer eligibility checks and profile creation until the
-- first verified state instead of aborting the Auth transaction.

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
-- END SOURCE: supabase/migration_phase16_auth_confirmation_compatibility.sql

COMMIT;

