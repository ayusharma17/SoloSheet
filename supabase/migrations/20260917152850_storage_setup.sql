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
