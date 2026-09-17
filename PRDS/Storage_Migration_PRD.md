# **PRD: Supabase Storage Migration for Large File Support**

---

## **1. Executive Summary**

The current implementation uses in-memory base64 encoding to transfer files from the client to the API, which hits Vercel's 4.5MB body size limit and causes upload failures for PDFs larger than ~5MB. This migration moves file uploads to **Supabase Storage**, enabling support for files up to **200MB** while maintaining the existing security model and user experience.

---

## **2. Problem Statement**

### **Current Architecture Issues:**
1. **Double Base64 Encoding:** Files are encoded on the client, sent via JSON, decoded on the server, then re-encoded for Gemini — doubling memory usage
2. **Vercel Body Limit:** 4.5MB hard limit on serverless function payloads (Hobby/Pro plans)
3. **Timeout Risk:** Large file processing can exceed 10-second Vercel timeout on Hobby plan
4. **Memory Inefficiency:** Entire file contents loaded into memory multiple times during processing
5. **Poor Error Recovery:** If extraction fails mid-process, the file must be re-uploaded entirely

### **Impact:**
- Users cannot upload typical lecture PDFs (often 10-50MB)
- Platform appears broken for core use case (processing dense course materials)
- Competitive disadvantage vs. other cheat sheet tools

---

## **3. Solution Architecture**

### **3.1 Supabase Storage Configuration**

#### **Bucket Setup:**
- **Bucket Name:** `course-materials`
- **Privacy:** Private (requires authentication)
- **File Size Limit:** 200MB per file
- **Allowed MIME Types:** `application/pdf`, `image/png`, `image/jpeg`, `image/webp`, `image/gif`
- **Storage Path Pattern:** `{user_id}/{upload_session_id}/{filename}`

#### **Security Policies (RLS):**
```sql
-- Users can only upload to their own folder
CREATE POLICY "Users can upload to own folder"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'course-materials'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Users can only read their own files
CREATE POLICY "Users can read own files"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'course-materials'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Users can delete their own files
CREATE POLICY "Users can delete own files"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'course-materials'
  AND (storage.foldername(name))[1] = auth.uid()::text
);
```

#### **Lifecycle Policy:**
- Auto-delete files older than **24 hours** (temporary processing only)
- Prevents storage bloat from abandoned uploads
- Files are not needed after extraction completes

---

### **3.2 New Upload Flow**

```
┌─────────┐     ┌──────────────────┐     ┌─────────────┐     ┌────────┐
│ Client  │────>│ Supabase Storage │────>│ /api/extract│────>│ Gemini │
│ Upload  │     │  (Direct Upload) │     │ (URL-based) │     │  API   │
└─────────┘     └──────────────────┘     └─────────────┘     └────────┘
```

**Steps:**
1. **Client:** Upload files directly to Supabase Storage using `supabase.storage.from('course-materials').upload()`
2. **Client:** Collect signed URLs for uploaded files
3. **Client:** Send extraction request to `/api/extract` with:
   - `courseName`, `targetPages`, `userDirective`
   - `fileUrls: Array<{ url: string, name: string, type: string }>`
4. **API:** Download files from Supabase Storage as streams
5. **API:** Convert to buffers and process with Gemini (existing logic)
6. **API:** Return extraction results
7. **Background:** Supabase auto-deletes files after 24 hours

---

### **3.3 Data Flow Changes**

#### **OLD (Current):**
```typescript
// upload-modal.tsx
FileReader.readAsDataURL() → base64 string (in memory)
  ↓
fetch('/api/extract', { body: JSON.stringify({ files: [{ base64 }] }) })
  ↓ (hits Vercel 4.5MB limit)
// route.ts
Buffer.from(file.base64, 'base64') → buffer (in memory)
  ↓
buffer.toString('base64') → send to Gemini
```

#### **NEW (After Migration):**
```typescript
// upload-modal.tsx
supabase.storage.upload() → file stored in bucket
  ↓
getPublicUrl() → signed URL
  ↓
fetch('/api/extract', { body: JSON.stringify({ fileUrls: [...] }) })
  ↓ (no size limit, just URLs)
// route.ts
fetch(signedUrl) → stream download
  ↓
convert to buffer → send to Gemini
```

---

## **4. Implementation Plan**

### **Phase 1: Supabase Storage Setup**
1. Create migration SQL for bucket setup and RLS policies
2. Run migration against Supabase instance
3. Test bucket permissions with manual uploads

### **Phase 2: Backend API Changes**
1. Update `/api/extract/route.ts`:
   - Accept `fileUrls: Array<{ url: string, name: string, type: string, size: number }>` instead of base64
   - Add helper function to download file from URL as buffer
   - Validate total file size BEFORE downloading
   - Add error handling for failed downloads
2. Keep existing Gemini integration unchanged (still receives buffers)

### **Phase 3: Frontend Upload Changes**
1. Update `upload-modal.tsx`:
   - Remove base64 encoding logic
   - Add direct Supabase Storage upload with progress tracking
   - Generate unique upload session ID: `crypto.randomUUID()`
   - Upload path: `{user.id}/{sessionId}/{file.name}`
   - Collect signed URLs after successful upload
   - Show per-file upload progress (using Supabase SDK callbacks)
   - Handle upload failures with retry logic
2. Update API call to send URLs instead of base64

### **Phase 4: Cleanup & Optimization**
1. Update `next.config.ts` — remove `bodySizeLimit` (no longer needed)
2. Add cleanup function to delete uploaded files after successful extraction
3. Update error messages to reference storage upload failures
4. Add monitoring/logging for storage usage

---

## **5. Technical Specifications**

### **5.1 API Contract Changes**

#### **Old Request Format:**
```json
{
  "courseName": "CS 577",
  "targetPages": 2,
  "userDirective": "Focus on dynamic programming",
  "files": [
    {
      "name": "lecture10.pdf",
      "type": "application/pdf",
      "size": 5242880,
      "base64": "JVBERi0xLjQKJeLjz9..." // ❌ Massive payload
    }
  ]
}
```

#### **New Request Format:**
```json
{
  "courseName": "CS 577",
  "targetPages": 2,
  "userDirective": "Focus on dynamic programming",
  "fileUrls": [
    {
      "url": "https://xyz.supabase.co/storage/v1/object/sign/course-materials/abc/session-123/lecture10.pdf?token=...",
      "name": "lecture10.pdf",
      "type": "application/pdf",
      "size": 5242880
    }
  ]
}
```

### **5.2 Storage Helper Functions**

```typescript
// lib/supabase/storage-helpers.ts

export async function uploadCourseFile(
  supabase: SupabaseClient,
  userId: string,
  sessionId: string,
  file: File,
  onProgress?: (progress: number) => void
): Promise<{ url: string; path: string }> {
  const filePath = `${userId}/${sessionId}/${file.name}`;

  const { data, error } = await supabase.storage
    .from('course-materials')
    .upload(filePath, file, {
      cacheControl: '3600',
      upsert: false,
    });

  if (error) throw error;

  const { data: urlData } = await supabase.storage
    .from('course-materials')
    .createSignedUrl(filePath, 3600); // 1 hour expiry

  if (!urlData?.signedUrl) throw new Error('Failed to generate signed URL');

  return { url: urlData.signedUrl, path: filePath };
}

export async function downloadFileFromStorage(
  url: string
): Promise<{ buffer: Buffer; headers: Headers }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    headers: response.headers,
  };
}

export async function cleanupUploadedFiles(
  supabase: SupabaseClient,
  filePaths: string[]
): Promise<void> {
  const { error } = await supabase.storage
    .from('course-materials')
    .remove(filePaths);

  if (error) console.warn('Failed to cleanup files:', error);
}
```

---

## **6. Error Handling & Edge Cases**

### **6.1 Upload Failures**
- **Issue:** Network interruption during upload
- **Solution:** Show retry button, keep file in queue, retry with exponential backoff

### **6.2 Malicious File URLs**
- **Issue:** User sends URL to external resource (not Supabase Storage)
- **Solution:** Validate URL matches Supabase Storage domain pattern before downloading

### **6.3 Storage Quota Exceeded**
- **Issue:** User exceeds Supabase free tier storage (1GB)
- **Solution:** Catch error, display message "Storage quota exceeded. Please contact support."

### **6.4 Signed URL Expiry**
- **Issue:** User waits too long between upload and extraction
- **Solution:** Set 1-hour expiry on signed URLs; show warning if >50 minutes elapsed

### **6.5 Partial Upload Success**
- **Issue:** 3 of 5 files uploaded, then user gets error
- **Solution:** Track uploaded file paths, allow user to retry failed files only, cleanup on modal close

---

## **7. Security Considerations**

### **7.1 Access Control**
- ✅ RLS policies ensure users can only access their own files
- ✅ Signed URLs expire after 1 hour
- ✅ Bucket is private (no public access)

### **7.2 File Validation**
- ✅ MIME type validation on client (before upload)
- ✅ File extension validation on client
- ✅ Size validation on client (before upload) and server (before download)
- ✅ Supabase enforces bucket-level size limits (200MB)

### **7.3 Abuse Prevention**
- ✅ Rate limiting already exists (5 requests/minute per user)
- ✅ 24-hour auto-delete prevents storage hoarding
- ✅ Credit system prevents unlimited extractions
- ✅ User-scoped folders prevent cross-contamination

---

## **8. Rollback Plan**

If migration causes critical issues:
1. Revert frontend to send base64 (keep old code in git history)
2. Revert API to accept base64
3. Keep Supabase bucket active (no harm in leaving it)
4. Files <4MB will work with old flow

**Mitigation:** Test thoroughly on dev/staging before production deployment.

---

## **9. Success Metrics**

### **Before Migration:**
- Max upload size: ~5MB
- Upload success rate: ~60% (due to failures on larger files)
- Average upload time (5MB): ~8 seconds

### **After Migration (Targets):**
- Max upload size: 200MB
- Upload success rate: >95%
- Average upload time (5MB): ~4 seconds (direct to storage)
- Average upload time (50MB): ~15 seconds

---

## **10. Acceptance Criteria**

- **AC 1:** Users can upload PDFs up to 200MB without errors
- **AC 2:** Upload progress is shown per-file with percentage
- **AC 3:** Failed uploads can be retried without re-uploading successful files
- **AC 4:** Files are automatically deleted after 24 hours
- **AC 5:** Users cannot access other users' uploaded files
- **AC 6:** Extraction still works exactly as before (same output quality)
- **AC 7:** No Vercel body size limit errors in production logs
- **AC 8:** Existing <5MB uploads still work without breaking changes

---

## **11. Dependencies**

- Supabase Storage (already included in `@supabase/supabase-js`)
- No new npm packages required
- Supabase free tier limits:
  - 1GB storage
  - 2GB bandwidth/month
  - Should support ~50-100 active users/month

---

## **12. Future Enhancements (Out of Scope)**

- Store extracted results as JSON in storage (for re-rendering without re-extraction)
- Add file preview before upload
- Support drag-and-drop re-ordering of files
- Allow users to save frequently used materials for quick re-processing
- Add compression for images before upload
- Support .docx, .pptx file types
