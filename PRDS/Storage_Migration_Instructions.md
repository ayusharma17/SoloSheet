# **Storage Migration Deployment Instructions (Historical)**

> Do not use the isolated commands in this document for a fresh database. They
> omit prerequisite and later hardening phases. Fresh installations must follow
> [`docs/database-bootstrap.md`](../docs/database-bootstrap.md) and execute
> `supabase/bootstrap.sql` in full as one transaction. The steps below are kept
> only to explain the historical storage rollout for an existing deployment.

## **Overview**

This migration moves file uploads from in-memory base64 encoding to Supabase Storage, enabling support for files up to 200MB and eliminating Vercel's 4.5MB body size limitation.

---

## **Step 1: Run the Supabase Migration**

### **Option A: Via Supabase Dashboard (Recommended)**

1. Go to your Supabase project dashboard: https://supabase.com/dashboard/project/YOUR_PROJECT_ID
2. Navigate to **SQL Editor** in the left sidebar
3. Click **New Query**
4. Copy the entire contents of `supabase/migration_storage_setup.sql`
5. Paste into the SQL editor
6. Click **Run** (or press Cmd/Ctrl + Enter)
7. Verify success - you should see "Success. No rows returned"

### **Option B: Via Supabase CLI**

```bash
# If you have Supabase CLI installed
supabase db push

# Or run the migration manually
supabase db execute < supabase/migration_storage_setup.sql
```

---

## **Step 2: Verify Bucket Creation**

1. In Supabase Dashboard, go to **Storage** in the left sidebar
2. You should see a new bucket named `course-materials`
3. Click on the bucket and verify:
   - **Public**: No (Private)
   - **File size limit**: 200 MB
   - **Allowed MIME types**: PDF, PNG, JPEG, WebP, GIF

---

## **Step 3: Test Storage Policies**

You can test the RLS policies directly in the Supabase dashboard:

1. Go to **Storage** > `course-materials`
2. Try uploading a test file (e.g., a small PDF)
3. The upload should succeed if you're logged in
4. Try accessing the file - you should only see files you uploaded

---

## **Step 4: Deploy the Code Changes**

### **Files Changed:**
- ✅ `src/lib/supabase/storage-helpers.ts` (new)
- ✅ `src/app/api/extract/route.ts` (modified)
- ✅ `src/app/dashboard/upload-modal.tsx` (modified)
- ✅ `next.config.ts` (modified)

### **Deploy to Vercel:**

```bash
# Option 1: Push to main branch (auto-deploy)
git add .
git commit -m "Migrate to Supabase Storage for large file support"
git push origin main

# Option 2: Deploy manually via Vercel CLI
vercel --prod
```

---

## **Step 5: Post-Deployment Testing**

### **Test 1: Small File Upload (< 5MB)**
1. Log into your app
2. Go to Dashboard
3. Click "Create Cheat Sheet"
4. Upload a small PDF (< 5MB)
5. Fill in course details
6. Click "Generate"
7. **Expected**: Upload succeeds, extraction works as before

### **Test 2: Large File Upload (5-50MB)**
1. Find a large PDF (10-50MB) - lecture slides, textbook chapter, etc.
2. Upload the file
3. **Expected**:
   - You see "Uploading {filename}..." status
   - Upload succeeds with green checkmark
   - Extraction completes successfully

### **Test 3: Very Large File (50-200MB)**
1. Upload a very large PDF (50-200MB)
2. **Expected**: Upload succeeds (may take 15-30 seconds)
3. Note: Extraction may hit Gemini's context limits with very large files

### **Test 4: Multiple Files**
1. Upload 3-5 files of varying sizes
2. **Expected**: Each file shows upload progress individually
3. All files upload successfully before extraction starts

### **Test 5: Error Handling**
1. Try uploading a file > 200MB
2. **Expected**: Error message "File is too large. Maximum size is 200MB."
3. Try uploading an unsupported file type (.txt, .docx)
4. **Expected**: Error message about unsupported file type

---

## **Step 6: Monitor Storage Usage**

### **Check Storage Dashboard:**
1. Go to Supabase Dashboard > **Storage** > `course-materials`
2. You should see uploaded files organized by user ID
3. Files should auto-delete after processing (immediate cleanup)

### **Supabase Free Tier Limits:**
- **Storage**: 1 GB
- **Bandwidth**: 2 GB/month
- **Monitor usage**: Supabase Dashboard > Settings > Usage

### **Expected Storage Behavior:**
- Files are uploaded temporarily
- After successful extraction, files are immediately deleted
- On extraction failure, files are also cleaned up
- Only orphaned files (from crashes) should persist
- Auto-cleanup function can remove files older than 24 hours

---

## **Step 7: Optional - Set Up Automated Cleanup**

For production, you may want to set up a cron job to clean up orphaned files:

### **Option A: Vercel Cron (Recommended)**

Create `app/api/cron/cleanup-storage/route.ts`:

```typescript
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createClient();

  // Call the cleanup function
  const { error } = await supabase.rpc("cleanup_old_course_materials");

  if (error) {
    console.error("Cleanup error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, message: "Cleanup completed" });
}
```

Then in `vercel.json`:

```json
{
  "crons": [{
    "path": "/api/cron/cleanup-storage",
    "schedule": "0 2 * * *"
  }]
}
```

### **Option B: Supabase pg_cron (Pro Plan Only)**

If you have Supabase Pro, you can use the built-in cron:

```sql
SELECT cron.schedule(
  'cleanup-course-materials',
  '0 2 * * *', -- Run at 2 AM daily
  $$SELECT cleanup_old_course_materials()$$
);
```

---

## **Rollback Plan**

If something goes wrong, you can quickly rollback:

### **1. Revert Code Changes**
```bash
git revert HEAD
git push origin main
```

### **2. Files < 4.5MB Will Still Work**
The old base64 flow can coexist with the new storage flow. Just change the frontend to send base64 again:

- Revert `upload-modal.tsx` to use `FileReader.readAsDataURL()`
- Revert `route.ts` to accept `files` array with `base64` field

### **3. Keep the Storage Bucket**
The Supabase bucket won't hurt anything if left in place. You can delete it later if needed.

---

## **Troubleshooting**

### **Issue: "Failed to upload file" error**

**Possible Causes:**
1. RLS policies not set up correctly
2. User not authenticated
3. File exceeds 200MB

**Fix:**
- Check Supabase logs: Dashboard > Logs > Storage Logs
- Verify user is authenticated: `supabase.auth.getUser()`
- Check file size on client before upload

### **Issue: "Invalid file URL" error in extraction**

**Cause:** URL validation is rejecting the signed URL

**Fix:**
- Check that URL matches pattern: `*.supabase.co/storage/v1/object/sign/*`
- Verify signed URL hasn't expired (1 hour TTL)
- Check browser console for full error

### **Issue: Files not being deleted after extraction**

**Cause:** Cleanup function is failing silently

**Fix:**
- Check API logs for cleanup errors
- Verify user has delete permissions (RLS policies)
- Manually delete files via Supabase Dashboard if needed

### **Issue: "Storage quota exceeded"**

**Cause:** Free tier 1GB limit reached

**Fix:**
- Run cleanup function manually: `SELECT cleanup_old_course_materials();`
- Upgrade to Supabase Pro ($25/month for 100GB)
- Or implement more aggressive cleanup (delete files immediately after extraction)

---

## **Success Criteria Checklist**

- [ ] Migration SQL executed successfully
- [ ] `course-materials` bucket visible in Supabase Dashboard
- [ ] Small file upload (< 5MB) works
- [ ] Large file upload (10-50MB) works
- [ ] Multiple files can be uploaded in one session
- [ ] Files show upload progress indicators
- [ ] Extraction completes successfully with new flow
- [ ] Files are cleaned up after extraction
- [ ] No Vercel body size errors in logs
- [ ] Storage usage remains under 1GB (check after 1 week)

---

## **Monitoring & Metrics**

### **Week 1 Post-Deployment:**
- Track upload success rate (should be >95%)
- Monitor storage usage daily
- Check for any orphaned files
- Review Vercel logs for errors

### **Key Metrics to Watch:**
1. **Upload Success Rate**: Target >95% (up from ~60% pre-migration)
2. **Average Upload Time**: Should be 3-5 seconds for 10MB file
3. **Storage Usage**: Should stay low if cleanup is working
4. **Extraction Success Rate**: Should remain unchanged (~90%+)
5. **Vercel Function Errors**: Should see no "Body size exceeded" errors

---

## **Next Steps (Future Enhancements)**

Once the migration is stable, consider:

1. **Add upload resume capability** - Allow resuming interrupted uploads
2. **Implement client-side compression** - Compress images before upload
3. **Add file preview** - Show PDF thumbnails before extraction
4. **Cache extracted results** - Store JSON in storage for quick re-renders
5. **Support additional file types** - .docx, .pptx, etc.

---

## **Support**

If you encounter any issues during migration:

1. Check Supabase logs: Dashboard > Logs
2. Check Vercel deployment logs: Vercel Dashboard > Deployments > Logs
3. Review browser console for client-side errors
4. Check Network tab to see upload/API requests

For persistent issues, create a detailed issue report with:
- Error messages (full stack trace)
- Browser console logs
- Network request/response details
- File size and type being uploaded
