import { SupabaseClient } from "@supabase/supabase-js";

export class UploadStorageError extends Error {
  readonly storagePath: string;

  constructor(message: string, storagePath: string) {
    super(message);
    this.name = "UploadStorageError";
    this.storagePath = storagePath;
  }
}

export function createCourseUploadPath(
  userId: string,
  sessionId: string,
  file: Pick<File, "name">,
): string {
  if (![userId, sessionId].every(part => /^[a-zA-Z0-9_-]+$/.test(part))) {
    throw new Error("Invalid upload owner or session");
  }
  const extension = file.name.split(".").pop?.()?.toLowerCase();
  if (!extension || !/^(pdf|png|jpg|jpeg|webp|gif)$/.test(extension)) {
    throw new Error("Invalid upload extension");
  }
  return `${userId}/${sessionId}/${crypto.randomUUID()}.${extension}`;
}

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
  file: File,
  preparedPath?: string,
): Promise<{ url: string; path: string }> {
  validateFileForUpload(file);
  const generatedPath = createCourseUploadPath(userId, sessionId, file);
  const filePath = preparedPath ?? generatedPath;
  const expectedPrefix = `${userId}/${sessionId}/`;
  const expectedExtension = `.${file.name.split(".").pop()!.toLowerCase()}`;
  if (!filePath.startsWith(expectedPrefix) || !filePath.endsWith(expectedExtension) ||
      filePath.slice(expectedPrefix.length, -expectedExtension.length).includes("/")) {
    throw new Error("Invalid prepared upload path");
  }

  const { error: reservationError } = await supabase.rpc(
    "reserve_course_material_upload",
    { p_path: filePath, p_size_bytes: file.size },
  );
  if (reservationError) {
    throw new Error("Upload storage quota is unavailable or exceeded");
  }

  const { error } = await supabase.storage
    .from("course-materials")
    .upload(filePath, file, {
      cacheControl: "3600",
      upsert: false, // Don't overwrite existing files
    });

  if (error) {
    console.error("Storage upload error:", error);
    const { error: releaseError } = await supabase.rpc(
      "release_course_material_uploads",
      { p_paths: [filePath] },
    );
    if (releaseError) {
      throw new UploadStorageError(
        `Failed to upload ${file.name}; reserved path needs cleanup`,
        filePath,
      );
    }
    throw new Error(`Failed to upload ${file.name}: ${error.message}`);
  }

  // Generate a signed URL valid for 1 hour
  const { data: urlData, error: urlError } = await supabase.storage
    .from("course-materials")
    .createSignedUrl(filePath, 3600); // 1 hour expiry

  if (urlError || !urlData?.signedUrl) {
    try {
      const { error: cleanupError } = await supabase.storage.from("course-materials").remove([filePath]);
      if (cleanupError) throw new Error("Cleanup failed");
      const { error: releaseError } = await supabase.rpc(
        "release_course_material_uploads",
        { p_paths: [filePath] },
      );
      if (releaseError) throw new Error("Reservation cleanup failed");
    } catch {
      throw new UploadStorageError(`Failed to generate URL for ${file.name}; uploaded file needs cleanup`, filePath);
    }
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
 * @param expectedDomain - Full configured Supabase origin (defaults to environment)
 * @param maxBytes - Actual streamed byte limit
 * @returns Buffer containing file data and response headers
 */
export async function downloadFileFromStorage(
  url: string,
  expectedDomain?: string,
  maxBytes: number = 200 * 1024 * 1024
): Promise<{ buffer: Buffer; headers: Headers }> {
  const configuredOrigin = expectedDomain ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!configuredOrigin || !isValidSupabaseStorageUrl(url, configuredOrigin)) {
    throw new Error("Invalid configured storage URL");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid download limit");
  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok || !response.body) throw new Error("Failed to download file from storage");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      await reader.cancel();
      throw new Error("Downloaded file exceeds size limit");
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Downloaded file exceeds size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { buffer: Buffer.concat(chunks, size), headers: response.headers };
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
): Promise<boolean> {
  if (filePaths.length === 0) return true;
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user || filePaths.some(path => {
    const parts = path.split("/");
    return parts.length !== 3 || parts[0] !== user.id || parts.some(part =>
      !part || part === "." || part === ".." || /[\\%\u0000-\u001f\u007f]/.test(part)
    );
  })) return false;

  const { error } = await supabase.storage
    .from("course-materials")
    .remove(filePaths);

  if (error) {
    console.warn("Failed to cleanup files:", error);
    return false;
  }
  const { error: releaseError } = await supabase.rpc(
    "release_course_material_uploads",
    { p_paths: filePaths },
  );
  if (releaseError) {
    console.warn("Failed to release upload reservations");
    return false;
  }
  return true;
}

/**
 * Recover uploads abandoned by a browser that could not persist its cleanup
 * journal. Only files older than the cutoff are removed, and deletion still
 * flows through Storage before the matching reservation is released.
 */
export async function cleanupStaleCourseUploads(
  supabase: SupabaseClient,
  userId: string,
  cutoff: Date | null = new Date(Date.now() - 24 * 60 * 60 * 1000),
): Promise<number> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(userId) ||
      (cutoff !== null && !Number.isFinite(cutoff.getTime()))) return 0;
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || user?.id !== userId) return 0;

  const { data: sessions, error: sessionError } = await supabase.storage
    .from("course-materials")
    .list(userId, { limit: 100 });
  if (sessionError || !sessions) return 0;

  const stalePaths: string[] = [];
  for (const session of sessions) {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(session.name)) continue;
    const { data: objects, error } = await supabase.storage
      .from("course-materials")
      .list(`${userId}/${session.name}`, { limit: 100 });
    if (error || !objects) continue;
    for (const object of objects) {
      const timestamp = object.updated_at ?? object.created_at;
      if (!timestamp || (cutoff !== null && new Date(timestamp).getTime() >= cutoff.getTime()) ||
          !/^[0-9a-f]{8}-[0-9a-f-]{27}\.(pdf|png|jpg|jpeg|webp|gif)$/i.test(object.name)) {
        continue;
      }
      stalePaths.push(`${userId}/${session.name}/${object.name}`);
    }
  }

  let removed = 0;
  for (let index = 0; index < stalePaths.length; index += 10) {
    const batch = stalePaths.slice(index, index + 10);
    if (await cleanupUploadedFiles(supabase, batch)) removed += batch.length;
  }
  return removed;
}

/**
 * Explicit user recovery for temporary uploads left by failed attempts.
 * Generated cheat sheets live in Postgres and are not affected.
 */
export async function cleanupAllCourseUploads(
  supabase: SupabaseClient,
  userId: string,
): Promise<number> {
  return cleanupStaleCourseUploads(supabase, userId, null);
}

/**
 * Check if a URL is a valid Supabase Storage signed URL
 *
 * @param url - URL to validate
 * @param storageOrigin - Full configured Supabase origin
 * @returns boolean indicating if URL is valid
 */
export function isValidSupabaseStorageUrl(
  url: string,
  storageOrigin: string = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
): boolean {
  try {
    const candidate = new URL(url);
    const configured = new URL(storageOrigin);
    return ["https:", "http:"].includes(configured.protocol) &&
      candidate.origin === configured.origin && !candidate.username && !candidate.password &&
      !candidate.hash && candidate.pathname.startsWith("/storage/v1/object/sign/course-materials/") &&
      Boolean(candidate.searchParams.get("token"));
  } catch {
    return false;
  }
}

/** Derive cleanup/download identity only from the authenticated user's signed URL. */
export function ownedStoragePath(url: string, userId: string, storageOrigin: string): string | null {
  if (!isValidSupabaseStorageUrl(url, storageOrigin)) return null;
  try {
    const encodedPath = new URL(url).pathname.slice("/storage/v1/object/sign/course-materials/".length);
    const parts = encodedPath.split("/").map(decodeURIComponent);
    if (parts.length !== 3 || parts[0] !== userId || parts.some(part =>
      !part || part === "." || part === ".." || /[/\\%\u0000-\u001f\u007f]/.test(part)
    )) return null;
    return parts.join("/");
  } catch {
    return null;
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
  if (file.size <= 0) throw new Error(`File "${file.name}" is empty.`);
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
