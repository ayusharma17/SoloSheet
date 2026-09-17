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

-- ================================================================
-- STEP 3: Row Level Security (RLS) Policies
-- ================================================================

-- Enable RLS on storage.objects (should already be enabled, but enforce it)
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- ================================================================
-- Policy 1: Users can upload files to their own folder
-- ================================================================
-- Pattern: {user_id}/{session_id}/{filename}
-- Example: abc123/session-xyz/lecture.pdf
CREATE POLICY "Users can upload to own folder"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'course-materials'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- ================================================================
-- Policy 2: Users can read/download their own files
-- ================================================================
CREATE POLICY "Users can read own files"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'course-materials'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- ================================================================
-- Policy 3: Users can delete their own files
-- ================================================================
CREATE POLICY "Users can delete own files"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'course-materials'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- ================================================================
-- Policy 4: Admins can manage all files (optional but useful)
-- ================================================================
-- This allows admin emails to clean up storage if needed
CREATE POLICY "Admins can manage all files"
ON storage.objects
FOR ALL
TO authenticated
USING (
  bucket_id = 'course-materials'
  AND (
    auth.jwt()->>'email' IN (
      SELECT email FROM admin_whitelist
    )
  )
);

-- ================================================================
-- STEP 4: Create cleanup function for old files
-- ================================================================
-- This function deletes files older than 24 hours
-- Run this via a cron job or manually as needed

CREATE OR REPLACE FUNCTION cleanup_old_course_materials()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM storage.objects
  WHERE bucket_id = 'course-materials'
    AND created_at < NOW() - INTERVAL '24 hours';
END;
$$;

-- ================================================================
-- STEP 5: Schedule automatic cleanup (Supabase Pro feature)
-- ================================================================
-- If you have Supabase Pro, you can use pg_cron to schedule this:
--
-- SELECT cron.schedule(
--   'cleanup-course-materials',
--   '0 2 * * *', -- Run at 2 AM daily
--   $$SELECT cleanup_old_course_materials()$$
-- );
--
-- For free tier, you can call this manually or via an API cron job (e.g., Vercel Cron)

-- ================================================================
-- VERIFICATION QUERIES
-- ================================================================

-- Check bucket exists
-- SELECT * FROM storage.buckets WHERE id = 'course-materials';

-- Check policies are created
-- SELECT * FROM pg_policies WHERE tablename = 'objects' AND schemaname = 'storage';

-- Test upload permissions (as a user)
-- You can test this in the Supabase dashboard or via the JavaScript client
