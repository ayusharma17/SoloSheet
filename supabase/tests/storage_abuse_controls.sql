-- Run as database owner against an isolated database after phase 14.
-- Storage metadata is a local stand-in; all fixtures roll back.
BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'storage-one@example.edu'),
  ('e0000000-0000-4000-8000-000000000002', 'storage-two@example.edu'),
  ('e0000000-0000-4000-8000-000000000003', 'storage-three@example.edu'),
  ('e0000000-0000-4000-8000-000000000004', 'storage-four@example.edu');
INSERT INTO public.admin_whitelist (email, reason) VALUES
  ('storage-one@example.edu', 'Storage cleanup administrator fixture');

DO $$
BEGIN
  IF (SELECT max_files_per_user FROM public.course_material_upload_limits
      WHERE config_key = 'course-materials') <> 10
    OR (SELECT max_total_bytes_per_user FROM public.course_material_upload_limits
      WHERE config_key = 'course-materials') <> 209715200 THEN
    RAISE EXCEPTION 'Default storage quota configuration is incorrect';
  END IF;
END;
$$;

CREATE POLICY "Unexpected permissive deployment policy"
ON storage.objects FOR ALL TO authenticated USING (true) WITH CHECK (true);

SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;

SELECT public.reserve_course_material_upload(
  'e0000000-0000-4000-8000-000000000001/e1000000-0000-4000-8000-000000000001/00000001-0000-4000-8000-000000000001.pdf',
  2
);
INSERT INTO storage.objects (bucket_id, name, metadata) VALUES (
  'course-materials',
  'e0000000-0000-4000-8000-000000000001/e1000000-0000-4000-8000-000000000001/00000001-0000-4000-8000-000000000001.pdf',
  '{"size":2}'
);

DO $$
DECLARE
  changed_count integer;
BEGIN
  BEGIN
    INSERT INTO storage.objects (bucket_id, name, metadata) VALUES (
      'course-materials',
      'e0000000-0000-4000-8000-000000000002/e1000000-0000-4000-8000-000000000001/00000002-0000-4000-8000-000000000001.pdf',
      '{"size":1}'
    );
    RAISE EXCEPTION 'Unexpected permissive policy bypassed ownership';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    INSERT INTO storage.objects (bucket_id, name, metadata) VALUES (
      'course-materials',
      'e0000000-0000-4000-8000-000000000001/e1000000-0000-4000-8000-000000000001/00000002-0000-4000-8000-000000000001.pdf',
      '{"size":1}'
    );
    RAISE EXCEPTION 'Unreserved upload bypassed quota protocol';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  UPDATE storage.objects SET metadata = '{"size":3}'
  WHERE name LIKE '%/00000001-%';
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count <> 0 THEN
    RAISE EXCEPTION 'Unreserved overwrite bypassed byte binding';
  END IF;

  UPDATE storage.objects SET metadata = metadata
  WHERE name LIKE '%/00000001-%';
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count <> 0 THEN
    RAISE EXCEPTION 'Unexpected permissive policy enabled immutable-path updates';
  END IF;
END;
$$;

DO $$
BEGIN
  BEGIN
    PERFORM public.reserve_course_material_upload(
      'e0000000-0000-4000-8000-000000000001/e1000000-0000-4000-8000-000000000001/00000001-0000-4000-8000-000000000001.pdf',
      1
    );
    RAISE EXCEPTION 'Stored object reservation was allowed to shrink';
  EXCEPTION WHEN unique_violation THEN NULL; END;
END;
$$;

-- Reserve nine more paths through the RPC; the eleventh must fail.
SELECT public.reserve_course_material_upload(
  'e0000000-0000-4000-8000-000000000001/e1000000-0000-4000-8000-000000000001/' ||
    lpad(to_hex(number), 8, '0') || '-0000-4000-8000-000000000001.pdf',
  1
)
FROM generate_series(2, 10) AS number;
DO $$
BEGIN
  BEGIN
    PERFORM public.reserve_course_material_upload(
      'e0000000-0000-4000-8000-000000000001/e1000000-0000-4000-8000-000000000001/0000000b-0000-4000-8000-000000000001.pdf',
      1
    );
    RAISE EXCEPTION 'Eleventh reservation bypassed object quota';
  EXCEPTION WHEN check_violation THEN NULL; END;
END;
$$;

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-4000-8000-000000000002', true);
SET LOCAL ROLE authenticated;
SELECT public.reserve_course_material_upload(
  'e0000000-0000-4000-8000-000000000002/e1000000-0000-4000-8000-000000000002/00000001-0000-4000-8000-000000000002.pdf',
  157286400
);
SELECT public.reserve_course_material_upload(
  'e0000000-0000-4000-8000-000000000002/e1000000-0000-4000-8000-000000000002/00000002-0000-4000-8000-000000000002.pdf',
  52428800
);
DO $$
BEGIN
  BEGIN
    PERFORM public.reserve_course_material_upload(
      'e0000000-0000-4000-8000-000000000002/e1000000-0000-4000-8000-000000000002/00000003-0000-4000-8000-000000000002.pdf',
      1
    );
    RAISE EXCEPTION 'Aggregate byte quota was bypassed';
  EXCEPTION WHEN check_violation THEN NULL; END;
END;
$$;

RESET ROLE;
UPDATE public.course_material_upload_limits SET
  max_files_per_user = 11,
  max_total_bytes_per_user = 209715201
WHERE config_key = 'course-materials';
DO $$
BEGIN
  IF (SELECT file_size_limit FROM storage.buckets
      WHERE id = 'course-materials') <> 209715201 THEN
    RAISE EXCEPTION 'Storage bucket did not follow centralized byte configuration';
  END IF;
END;
$$;

SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-4000-8000-000000000001', true);
SET LOCAL ROLE authenticated;
SELECT public.reserve_course_material_upload(
  'e0000000-0000-4000-8000-000000000001/e1000000-0000-4000-8000-000000000001/0000000b-0000-4000-8000-000000000001.pdf',
  1
);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-4000-8000-000000000002', true);
SET LOCAL ROLE authenticated;
SELECT public.reserve_course_material_upload(
  'e0000000-0000-4000-8000-000000000002/e1000000-0000-4000-8000-000000000002/00000003-0000-4000-8000-000000000002.pdf',
  1
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-4000-8000-000000000004', true);
SET LOCAL ROLE authenticated;
SELECT public.reserve_course_material_upload(
  'e0000000-0000-4000-8000-000000000004/e1000000-0000-4000-8000-000000000004/00000001-0000-4000-8000-000000000004.pdf',
  100
);
RESET ROLE;
UPDATE public.course_material_upload_reservations SET
  updated_at = now() - interval '25 hours'
WHERE user_id = 'e0000000-0000-4000-8000-000000000004';
SET LOCAL ROLE authenticated;
SELECT public.reserve_course_material_upload(
  'e0000000-0000-4000-8000-000000000004/e1000000-0000-4000-8000-000000000004/00000002-0000-4000-8000-000000000004.pdf',
  1
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-4000-8000-000000000003', true);
SET LOCAL ROLE authenticated;
SELECT public.reserve_course_material_upload(
  'e0000000-0000-4000-8000-000000000003/e1000000-0000-4000-8000-000000000003/00000001-0000-4000-8000-000000000003.pdf',
  1
);
INSERT INTO storage.objects (bucket_id, name, metadata) VALUES (
  'course-materials',
  'e0000000-0000-4000-8000-000000000003/e1000000-0000-4000-8000-000000000003/00000001-0000-4000-8000-000000000003.pdf',
  '{"size":1}'
);
DELETE FROM storage.objects
WHERE name LIKE 'e0000000-0000-4000-8000-000000000003/%';
RESET ROLE;

SELECT set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    DELETE FROM public.course_material_upload_reservations
    WHERE user_id = 'e0000000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'Service role bypassed audited reservation cleanup';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
SELECT public.cleanup_course_material_upload_reservations(
  'e0000000-0000-4000-8000-000000000003',
  'e0000000-0000-4000-8000-000000000001',
  'Requested account deletion after Storage API cleanup',
  'e2000000-0000-4000-8000-000000000003'
);
SELECT public.cleanup_course_material_upload_reservations(
  'e0000000-0000-4000-8000-000000000003',
  'e0000000-0000-4000-8000-000000000001',
  'Idempotent retry after reservation cleanup',
  'e2000000-0000-4000-8000-000000000003'
);
RESET ROLE;
DELETE FROM auth.users WHERE id = 'e0000000-0000-4000-8000-000000000003';

DO $$
BEGIN
  IF (SELECT size_bytes FROM public.course_material_upload_reservations
      WHERE path LIKE 'e0000000-0000-4000-8000-000000000001/%/00000001-%') <> 2 THEN
    RAISE EXCEPTION 'Rejected resize changed reservation accounting';
  END IF;
  IF (SELECT count(*) FROM public.course_material_upload_reservations
      WHERE user_id = 'e0000000-0000-4000-8000-000000000001') <>
      (SELECT max_files_per_user FROM public.course_material_upload_limits
       WHERE config_key = 'course-materials') THEN
    RAISE EXCEPTION 'Object reservation quota count is incorrect';
  END IF;
  IF (SELECT sum(size_bytes) FROM public.course_material_upload_reservations
      WHERE user_id = 'e0000000-0000-4000-8000-000000000002') <>
      (SELECT max_total_bytes_per_user FROM public.course_material_upload_limits
       WHERE config_key = 'course-materials') THEN
    RAISE EXCEPTION 'Aggregate reservation bytes are incorrect';
  END IF;
  IF EXISTS (SELECT 1 FROM public.course_material_upload_reservations
      WHERE user_id = 'e0000000-0000-4000-8000-000000000004'
        AND path LIKE '%/00000001-%')
    OR (SELECT count(*) FROM public.course_material_upload_reservations
      WHERE user_id = 'e0000000-0000-4000-8000-000000000004') <> 1 THEN
    RAISE EXCEPTION 'Stale reservation-only crash was not recovered';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.course_material_upload_reservations
    WHERE user_id = 'e0000000-0000-4000-8000-000000000003'
  ) OR EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = 'e0000000-0000-4000-8000-000000000003'
  ) THEN
    RAISE EXCEPTION 'Released reservation blocked Auth user deletion';
  END IF;
  IF (SELECT count(*) FROM public.audit_events
      WHERE event_type = 'storage.reservations_released'
        AND correlation_id = 'e2000000-0000-4000-8000-000000000003') <> 1 THEN
    RAISE EXCEPTION 'Reservation cleanup audit was missing or duplicated';
  END IF;
  IF has_table_privilege('authenticated',
      'public.course_material_upload_reservations', 'SELECT') THEN
    RAISE EXCEPTION 'Upload reservations are visible to authenticated clients';
  END IF;
  IF has_table_privilege('authenticated',
      'public.course_material_upload_limits', 'SELECT')
    OR has_table_privilege('service_role',
      'public.course_material_upload_limits', 'UPDATE') THEN
    RAISE EXCEPTION 'Upload quota configuration has unsafe client privileges';
  END IF;
  IF to_regprocedure('public.cleanup_old_course_materials()') IS NOT NULL THEN
    RAISE EXCEPTION 'Legacy direct Storage metadata cleanup remains callable';
  END IF;
END;
$$;

ROLLBACK;
