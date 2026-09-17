-- Apply after phase 14. Managed Supabase Storage performs its upload RLS
-- preflight before final object metadata exists. Bind its server-supplied HTTP
-- content length to the exact browser reservation while allowing only bounded
-- multipart framing overhead.
BEGIN;

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

COMMIT;
