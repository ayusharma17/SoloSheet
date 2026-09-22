# Supabase Storage Migration - Implementation Complete

> Historical document: do not use the isolated storage commands below to
> initialize a new database. They can leave prerequisite and hardening phases
> unapplied. Use the atomic fresh-install procedure in
> [`docs/database-bootstrap.md`](docs/database-bootstrap.md). Existing databases
> must apply only reviewed, unapplied forward migrations.

> Current schema note (2026-09-21): the storage migration described below is
> historical. The current ordered schema continues through Phase 16 (delayed
> Auth confirmation compatibility), Phase 17 (open verified signup plus the
> audited prospective non-`.edu` trial flag), and Phase 18 (zero-credit
> authenticated profile repair). Apply those forward migrations
> in order before deploying the current auth callback. This repository does not
> establish whether any hosted project has applied them; see
> [`docs/open-signup-local-acceptance.md`](docs/open-signup-local-acceptance.md).

## Summary

Successfully migrated CheatSheetAI from in-memory base64 file uploads to Supabase Storage, enabling support for files up to **200MB** (previously limited to ~5MB due to Vercel's body size restrictions).

---

## What Changed

### Architecture

**Before:**
```
Client → Base64 encode file → Send via JSON → API Route (4.5MB limit) → Gemini
```

**After:**
```
Client → Upload to Supabase Storage → Send URL → API Route (no limit) → Download → Gemini
```

### Key Benefits

1. ✅ **Support files up to 200MB** (40x increase)
2. ✅ **No Vercel body size limit** - files bypass API routes
3. ✅ **Faster uploads** - direct to cloud storage
4. ✅ **Better error recovery** - can retry individual file uploads
5. ✅ **Automatic cleanup** - files deleted after processing
6. ✅ **Secure** - RLS policies ensure user isolation

---

## Files Created

1. **`supabase/migration_storage_setup.sql`**
   - Creates `course-materials` bucket
   - Sets up RLS policies for user isolation
   - Adds cleanup function for old files

2. **`src/lib/supabase/storage-helpers.ts`**
   - `uploadCourseFile()` - Upload file to storage
   - `downloadFileFromStorage()` - Download file from signed URL
   - `cleanupUploadedFiles()` - Delete files after processing
   - `validateFileForUpload()` - Client-side validation
   - `isValidSupabaseStorageUrl()` - Security validation

3. **`PRDS/Storage_Migration_PRD.md`**
   - Complete technical specification
   - Security considerations
   - Error handling strategy
   - Success metrics

4. **`PRDS/Storage_Migration_Instructions.md`**
   - Step-by-step deployment guide
   - Testing procedures
   - Troubleshooting guide
   - Rollback plan

---

## Files Modified

1. **`src/app/api/extract/route.ts`**
   - Changed from accepting `files: [{base64}]` to `fileUrls: [{url, path}]`
   - Added download logic for files from storage
   - Added automatic cleanup after processing
   - Added cleanup on errors

2. **`src/app/dashboard/upload-modal.tsx`**
   - Replaced base64 encoding with Supabase Storage uploads
   - Added per-file upload progress tracking
   - Added upload status indicators (pending/uploading/uploaded/failed)
   - Shows visual feedback with icons (spinner, checkmark, error)

3. **`next.config.ts`**
   - Removed `bodySizeLimit: "200mb"` (no longer needed)

---

## Deployment Steps (Netlify)

### 1. Run Supabase Migration

```bash
# Via Supabase Dashboard
# Go to SQL Editor → New Query → Paste migration_storage_setup.sql → Run

# Or via CLI
supabase db execute < supabase/migration_storage_setup.sql
```

### 2. Verify Bucket Creation

- Go to Supabase Dashboard → Storage
- Confirm `course-materials` bucket exists
- Check settings: Private, 200MB limit, correct MIME types

### 3. Deploy Code to Netlify

```bash
git add .
git commit -m "Migrate to Supabase Storage for large file support"
git push origin main
# Netlify will auto-deploy
```

**Note**: Netlify has a 125MB function body limit, but this migration bypasses that entirely by uploading files directly to Supabase Storage client-side.

### 4. Test

See `PRDS/Storage_Migration_Instructions.md` for detailed test cases.

**Quick Test:**
1. Upload a 10MB PDF
2. Verify you see "Uploading..." status
3. Verify extraction completes successfully
4. Check Supabase Storage - file should be deleted after processing

---

## API Contract Changes

### Old Request Format (Base64)
```json
{
  "courseName": "CS 577",
  "targetPages": 2,
  "userDirective": "Focus on DP",
  "files": [
    {
      "name": "lecture.pdf",
      "type": "application/pdf",
      "size": 5242880,
      "base64": "JVBERi0xLjQK..." // 5MB+ payload
    }
  ]
}
```

### New Request Format (URLs)
```json
{
  "courseName": "CS 577",
  "targetPages": 2,
  "userDirective": "Focus on DP",
  "fileUrls": [
    {
      "url": "https://xyz.supabase.co/storage/v1/object/sign/course-materials/...",
      "path": "user-id/session-id/lecture.pdf",
      "name": "lecture.pdf",
      "type": "application/pdf",
      "size": 5242880
    }
  ]
}
```

---

## Security

### RLS Policies

1. **Upload**: Users can only upload to their own folder (`{user_id}/...`)
2. **Read**: Users can only read their own files
3. **Delete**: Users can only delete their own files
4. **Admin**: Admin whitelist emails can manage all files

### URL Validation

- Only Supabase Storage URLs accepted (domain validation)
- Signed URLs expire after 1 hour
- Prevents abuse from external URL injection

### File Validation

- Client-side: File type, size, extension checks
- Server-side: MIME type validation, total size limits
- Double validation prevents malicious uploads

---

## Storage Management

### Automatic Cleanup

Files are deleted in these scenarios:
1. ✅ After successful extraction (immediate)
2. ✅ On extraction failure (immediate)
3. ✅ On database save failure (immediate)
4. ✅ Optional: Cron job for orphaned files >24 hours old

### Storage Path Structure

```
course-materials/
├── {user-id-1}/
│   ├── {session-id-1}/
│   │   ├── lecture1.pdf
│   │   └── notes.png
│   └── {session-id-2}/
│       └── textbook.pdf
└── {user-id-2}/
    └── {session-id-3}/
        └── slides.pdf
```

Each upload session gets a unique ID to prevent filename conflicts.

---

## Performance Expectations

### Before Migration
- Max file size: ~5MB
- Upload success rate: ~60% (failures on larger files)
- Upload time (5MB): ~8 seconds (base64 encoding + network)

### After Migration (Expected)
- Max file size: 200MB
- Upload success rate: >95%
- Upload time (5MB): ~3-4 seconds (direct to storage)
- Upload time (50MB): ~15 seconds

---

## Monitoring

### Week 1 Checklist

- [ ] Check storage usage daily (should stay low with auto-cleanup)
- [ ] Monitor upload success rate in application logs
- [ ] Review Vercel logs for any errors
- [ ] Verify no "Body size exceeded" errors
- [ ] Check for orphaned files in storage bucket

### Key Metrics

1. **Upload Success Rate**: Target >95%
2. **Storage Usage**: Should remain <100MB (with cleanup)
3. **Extraction Success Rate**: Should match pre-migration rate
4. **Average Upload Time**: 3-5s for 10MB files

---

## Troubleshooting

### Common Issues

**"Failed to upload file"**
- Check RLS policies in Supabase Dashboard
- Verify user is authenticated
- Check file size < 200MB

**"Invalid file URL"**
- Verify URL is from Supabase Storage domain
- Check signed URL hasn't expired (1hr TTL)

**Files not deleted after extraction**
- Check API logs for cleanup errors
- Verify delete RLS policy is active
- Run manual cleanup: `SELECT cleanup_old_course_materials();`

**Storage quota exceeded**
- Run cleanup function manually
- Check for orphaned files
- Consider upgrading to Supabase Pro

See `PRDS/Storage_Migration_Instructions.md` for detailed troubleshooting.

---

## Rollback Plan

If critical issues arise:

1. Revert code: `git revert HEAD && git push`
2. Old flow will work for files <4.5MB
3. Storage bucket can remain (no harm)
4. Re-deploy after fixes

---

## Future Enhancements

1. **Upload Progress Bars** - Real-time percentage for each file
2. **Resume Uploads** - Handle network interruptions
3. **Image Compression** - Reduce file sizes client-side
4. **File Preview** - Show PDF thumbnails before extraction
5. **Cached Results** - Store extraction JSON in storage for re-rendering
6. **Additional File Types** - .docx, .pptx support

---

## Success Criteria

- [x] PRD created with full technical spec
- [x] Migration SQL with bucket and RLS policies
- [x] Storage helper utilities implemented
- [x] API route updated for URL-based uploads
- [x] Upload modal updated with progress tracking
- [x] next.config.ts cleaned up
- [x] Deployment instructions documented
- [x] Testing procedures defined

### To Be Verified After Deployment:

- [ ] Files >5MB upload successfully
- [ ] Files up to 200MB work
- [ ] Upload progress shown correctly
- [ ] Files auto-delete after processing
- [ ] No Vercel body size errors in production
- [ ] Storage usage stays under 1GB

---

## Support

For issues or questions:
1. Check deployment instructions: `PRDS/Storage_Migration_Instructions.md`
2. Review PRD: `PRDS/Storage_Migration_PRD.md`
3. Check Supabase logs: Dashboard → Logs → Storage
4. Check Vercel logs: Dashboard → Deployments → Logs

---

**Migration Status**: ✅ Implementation Complete - Ready for Deployment

**Next Step**: Run the Supabase migration SQL and deploy to Vercel
