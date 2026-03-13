-- ================================================================
-- Migration: Supabase Storage Setup for Course Materials
-- Purpose: Enable large file uploads (up to 200MB) via Supabase Storage
-- Date: 2026-03-12
-- ================================================================

-- ================================================================
-- STEP 1: Create the storage bucket
-- ================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'course-materials',
  'course-materials',
  false, -- Private bucket (requires authentication)
  209715200, -- 200MB in bytes
  ARRAY[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/gif'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- ================================================================
-- STEP 2: Row Level Security (RLS) Policies
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
-- STEP 3: Create cleanup function for old files
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
-- STEP 4: Schedule automatic cleanup (Supabase Pro feature)
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
