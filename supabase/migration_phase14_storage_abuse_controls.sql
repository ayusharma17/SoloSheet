-- Apply after phase 13. Browser uploads must reserve an exact owned path and
-- byte count before calling the Storage API. This avoids custom triggers in the
-- Storage-managed schema while atomically bounding aggregate usage.
BEGIN;

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
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated'
    OR auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid()
    OR p_name IS NULL OR p_metadata IS NULL
    OR NOT public.is_course_material_storage_path(p_name, p_user_id)
    OR p_metadata->>'size' !~ '^[0-9]{1,18}$' THEN
    RETURN false;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_name, 140014)
  );
  SELECT EXISTS (
    SELECT 1 FROM public.course_material_upload_reservations AS reservation
    WHERE reservation.path = p_name
      AND reservation.user_id = p_user_id
      AND reservation.size_bytes = (p_metadata->>'size')::bigint
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

COMMIT;
