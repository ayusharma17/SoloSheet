import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Upload a file to Supabase Storage for course material processing
 *
 * @param supabase - Authenticated Supabase client
 * @param userId - User ID (for folder scoping)
 * @param sessionId - Unique session ID for this upload batch
 * @param file - File object to upload
 * @returns Object with signed URL and storage path
 */
export async function uploadCourseFile(
  supabase: SupabaseClient,
  userId: string,
  sessionId: string,
  file: File
): Promise<{ url: string; path: string }> {
  const filePath = `${userId}/${sessionId}/${file.name}`;

  const { data, error } = await supabase.storage
    .from("course-materials")
    .upload(filePath, file, {
      cacheControl: "3600",
      upsert: false, // Don't overwrite existing files
    });

  if (error) {
    console.error("Storage upload error:", error);
    throw new Error(`Failed to upload ${file.name}: ${error.message}`);
  }

  // Generate a signed URL valid for 1 hour
  const { data: urlData, error: urlError } = await supabase.storage
    .from("course-materials")
    .createSignedUrl(filePath, 3600); // 1 hour expiry

  if (urlError || !urlData?.signedUrl) {
    console.error("Signed URL error:", urlError);
    throw new Error(`Failed to generate URL for ${file.name}`);
  }

  return {
    url: urlData.signedUrl,
    path: filePath,
  };
}

/**
 * Download a file from a signed URL as a Buffer
 *
 * @param url - Signed URL from Supabase Storage
 * @param expectedDomain - Expected domain for security validation
 * @returns Buffer containing file data and response headers
 */
export async function downloadFileFromStorage(
  url: string,
  expectedDomain?: string
): Promise<{ buffer: Buffer; headers: Headers }> {
  // Security: Validate URL is from expected domain (Supabase Storage)
  if (expectedDomain) {
    const urlObj = new URL(url);
    if (!urlObj.hostname.includes(expectedDomain)) {
      throw new Error(
        `Security violation: URL must be from ${expectedDomain}, got ${urlObj.hostname}`
      );
    }
  }

  const response = await fetch(url, {
    method: "GET",
    // Add timeout to prevent hanging on large files
    signal: AbortSignal.timeout(120000), // 2 minutes
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download file: ${response.status} ${response.statusText}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    headers: response.headers,
  };
}

/**
 * Delete uploaded files from storage (cleanup after processing)
 *
 * @param supabase - Authenticated Supabase client (must have delete permissions)
 * @param filePaths - Array of storage paths to delete
 */
export async function cleanupUploadedFiles(
  supabase: SupabaseClient,
  filePaths: string[]
): Promise<void> {
  if (filePaths.length === 0) return;

  const { error } = await supabase.storage
    .from("course-materials")
    .remove(filePaths);

  if (error) {
    console.warn("Failed to cleanup files:", error);
    // Don't throw - cleanup is best-effort
  } else {
    console.log(`Successfully cleaned up ${filePaths.length} file(s)`);
  }
}

/**
 * Check if a URL is a valid Supabase Storage signed URL
 *
 * @param url - URL to validate
 * @param projectRef - Your Supabase project reference (optional)
 * @returns boolean indicating if URL is valid
 */
export function isValidSupabaseStorageUrl(
  url: string,
  projectRef?: string
): boolean {
  try {
    const urlObj = new URL(url);

    // Check if it's a Supabase Storage URL
    const isSupabaseStorage =
      urlObj.hostname.includes("supabase.co") &&
      urlObj.pathname.includes("/storage/v1/object/");

    // Optionally validate project reference
    if (projectRef) {
      return isSupabaseStorage && urlObj.hostname.startsWith(projectRef);
    }

    return isSupabaseStorage;
  } catch {
    return false;
  }
}

/**
 * Generate a unique session ID for grouping uploaded files
 *
 * @returns UUID v4 session ID
 */
export function generateUploadSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Validate file before upload
 *
 * @param file - File to validate
 * @param maxSize - Maximum file size in bytes (default 200MB)
 * @param allowedTypes - Array of allowed MIME types
 * @throws Error if validation fails
 */
export function validateFileForUpload(
  file: File,
  maxSize: number = 200 * 1024 * 1024, // 200MB
  allowedTypes: string[] = [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
  ]
): void {
  // Check file size
  if (file.size > maxSize) {
    const sizeMB = (maxSize / (1024 * 1024)).toFixed(0);
    throw new Error(
      `File "${file.name}" is too large. Maximum size is ${sizeMB}MB.`
    );
  }

  // Check MIME type
  if (!allowedTypes.includes(file.type)) {
    throw new Error(
      `File "${file.name}" has unsupported type "${file.type}". Allowed: ${allowedTypes.join(", ")}`
    );
  }

  // Check file extension matches MIME type
  const extension = "." + file.name.split(".").pop()?.toLowerCase();
  const mimeToExtension: Record<string, string[]> = {
    "application/pdf": [".pdf"],
    "image/png": [".png"],
    "image/jpeg": [".jpg", ".jpeg"],
    "image/webp": [".webp"],
    "image/gif": [".gif"],
  };

  const validExtensions = mimeToExtension[file.type] || [];
  if (!validExtensions.includes(extension)) {
    throw new Error(
      `File "${file.name}" extension doesn't match its type "${file.type}"`
    );
  }
}
