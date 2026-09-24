import { downloadFileFromStorage, ownedStoragePath } from "@/lib/supabase/storage-helpers";
import { MAX_EXTRACTION_FILE_SIZE, MAX_EXTRACTION_TOTAL_SIZE } from "@/lib/extraction-limits";
import type { SupabaseClient } from "@supabase/supabase-js";

export const MAX_FILE_SIZE = MAX_EXTRACTION_FILE_SIZE;
export const MAX_TOTAL_SIZE = MAX_EXTRACTION_TOTAL_SIZE;
const MAX_REQUEST_SIZE = 64 * 1024;
const MIME_EXTENSIONS: Record<string, readonly string[]> = {
  "application/pdf": ["pdf"],
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
};

export class ExtractionValidationError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "ExtractionValidationError";
  }
}

export class ExtractionRuntimeError extends Error {
  readonly failureCode: "provider_transient" | "configuration" | "worker_error";
  readonly retryable: boolean;

  constructor(
    failureCode: "provider_transient" | "configuration" | "worker_error",
    retryable: boolean,
    cause?: unknown,
  ) {
    super("Extraction input could not be read", { cause });
    this.name = "ExtractionRuntimeError";
    this.failureCode = failureCode;
    this.retryable = retryable;
  }
}

export interface ValidatedFile {
  url: string;
  path: string;
  name: string;
  type: string;
  size: number;
}

export type ValidatedJobFile = Omit<ValidatedFile, "url">;
export type DownloadedExtractionFile = { buffer: Buffer; mimeType: string; name: string };

export interface ValidatedExtractionRequest {
  requestId: string;
  courseName: string;
  userDirective: string;
  targetPages: number;
  fileUrls: ValidatedFile[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimeErrorDetails(error: unknown): { status?: number; text: string } {
  const textParts: string[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  let status: number | undefined;
  for (let depth = 0; depth < 8; depth++) {
    const value = record(current) ? current : null;
    if (!value || seen.has(value)) break;
    seen.add(value);
    for (const candidate of [value.name, value.message, value.code]) {
      if (typeof candidate === "string") textParts.push(candidate);
    }
    for (const candidate of [value.status, value.statusCode, value.code, record(value.response) ? value.response.status : undefined]) {
      if (typeof candidate === "number" && Number.isInteger(candidate)) status ??= candidate;
      else if (typeof candidate === "string" && /^\d{3}$/.test(candidate)) status ??= Number(candidate);
    }
    current = value.cause ?? value.error;
  }
  return { status, text: textParts.join(" ").toLowerCase() };
}

export function classifyExtractionRuntimeError(
  error: unknown,
): Pick<ExtractionRuntimeError, "failureCode" | "retryable"> {
  if (error instanceof ExtractionRuntimeError) {
    return { failureCode: error.failureCode, retryable: error.retryable };
  }
  if (error instanceof ExtractionValidationError) {
    return { failureCode: "worker_error", retryable: false };
  }
  const { status, text } = runtimeErrorDetails(error);
  if (status === 401 || status === 403 || /api[_ -]?key|credential|authentication|invalid configured storage url/.test(text)) {
    return { failureCode: "configuration", retryable: false };
  }
  if (status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500) ||
      /timeout|timed out|aborterror|fetch failed|econnreset|econnrefused|enotfound|eai_again|socket hang up|network|failed to download file/.test(text)) {
    return { failureCode: "provider_transient", retryable: true };
  }
  return { failureCode: "worker_error", retryable: false };
}

function boundedString(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.length > max || /[\u0000]/.test(value)) {
    throw new ExtractionValidationError(`Invalid ${label}`);
  }
  return value;
}

export function parseExtractionRequest(
  payload: unknown,
  userId: string,
  storageOrigin: string
): ValidatedExtractionRequest {
  if (!record(payload)) throw new ExtractionValidationError("Expected a request object");
  const requestId = boundedString(payload.requestId, 36, "request ID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new ExtractionValidationError("Invalid request ID");
  }
  const courseName = boundedString(payload.courseName ?? "Untitled Course", 100, "course name").trim() || "Untitled Course";
  const userDirective = boundedString(payload.userDirective ?? "", 1000, "instructions").trim();
  const targetPages = payload.targetPages ?? 1;
  if (typeof targetPages !== "number" || !Number.isInteger(targetPages) || targetPages < 1 || targetPages > 20) {
    throw new ExtractionValidationError("Page limit must be an integer between 1 and 20");
  }
  if (!Array.isArray(payload.fileUrls) || payload.fileUrls.length < 1 || payload.fileUrls.length > 10) {
    throw new ExtractionValidationError("Upload between 1 and 10 files");
  }
  let totalSize = 0;
  const paths = new Set<string>();
  const fileUrls = payload.fileUrls.map((entry: unknown): ValidatedFile => {
    if (!record(entry)) throw new ExtractionValidationError("Invalid file entry");
    const url = boundedString(entry.url, 8192, "file URL");
    const path = boundedString(entry.path, 1024, "storage path");
    const name = boundedString(entry.name, 255, "file name");
    const type = boundedString(entry.type, 100, "file type");
    if (!name || /[/\\\u0000-\u001f\u007f]/.test(name) || !Object.hasOwn(MIME_EXTENSIONS, type) || !MIME_EXTENSIONS[type].includes(name.split(".").pop()?.toLowerCase() ?? "")) {
      throw new ExtractionValidationError("Unsupported file type or filename");
    }
    const derivedPath = ownedStoragePath(url, userId, storageOrigin);
    if (!derivedPath || derivedPath !== path || paths.has(path)) {
      throw new ExtractionValidationError("Invalid or duplicate owned storage path");
    }
    paths.add(path);
    if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size <= 0) {
      throw new ExtractionValidationError("Invalid file size");
    }
    if (entry.size > MAX_FILE_SIZE) {
      throw new ExtractionValidationError("Individual file size exceeds 20MB limit", 413);
    }
    totalSize += entry.size;
    if (totalSize > MAX_TOTAL_SIZE) throw new ExtractionValidationError("Total file size exceeds 200MB limit", 413);
    return { url, path: derivedPath, name, type, size: entry.size };
  });
  return { requestId, courseName, userDirective, targetPages, fileUrls };
}

export async function readExtractionRequest(request: Request, userId: string, storageOrigin: string) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ExtractionValidationError("Content-Type must be application/json");
  }
  if (!request.body) throw new ExtractionValidationError("Missing request body");
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_SIZE) {
        await reader.cancel();
        throw new ExtractionValidationError("Request body is too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let payload: unknown;
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ExtractionValidationError("Failed to parse request body"); }
  return parseExtractionRequest(payload, userId, storageOrigin);
}

export function matchesFileSignature(buffer: Buffer, type: string): boolean {
  switch (type) {
    case "application/pdf": return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
    case "image/png": return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/jpeg": return buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    case "image/gif": return ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"));
    case "image/webp": return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
    default: return false;
  }
}

async function downloadExtractionFile(entry: ValidatedFile, maxBytes: number): Promise<DownloadedExtractionFile> {
  let downloaded: Awaited<ReturnType<typeof downloadFileFromStorage>>;
  try {
    downloaded = await downloadFileFromStorage(entry.url, undefined, maxBytes);
  } catch (error) {
    const detail = runtimeErrorDetails(error).text;
    if (/downloaded file exceeds size limit|invalid download limit/.test(detail)) {
      throw new ExtractionValidationError("Downloaded file exceeds size limit", 413);
    }
    const classification = classifyExtractionRuntimeError(error);
    throw new ExtractionRuntimeError(classification.failureCode, classification.retryable, error);
  }
  const { buffer, headers } = downloaded;
  const responseType = headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if ((responseType && responseType !== entry.type && responseType !== "application/octet-stream") || !matchesFileSignature(buffer, entry.type)) {
    throw new ExtractionValidationError("Downloaded file does not match its declared type");
  }
  if (buffer.length !== entry.size) throw new ExtractionValidationError("Downloaded file size differs from upload metadata");
  return { buffer, mimeType: entry.type, name: entry.name };
}

export async function downloadExtractionFiles(fileUrls: ValidatedFile[]) {
  const files: DownloadedExtractionFile[] = [];
  let totalSize = 0;
  for (const entry of fileUrls) {
    const file = await downloadExtractionFile(entry, Math.min(entry.size, MAX_TOTAL_SIZE - totalSize));
    totalSize += file.buffer.length;
    files.push(file);
  }
  return files;
}

export async function* iterateExtractionJobFiles(
  supabase: SupabaseClient,
  userId: string,
  files: ValidatedJobFile[],
): AsyncGenerator<DownloadedExtractionFile> {
  let totalSize = 0;
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_FILE_SIZE) {
      throw new ExtractionValidationError("Individual file size exceeds 20MB limit", 413);
    }
    if (!file.path.startsWith(`${userId}/`) || file.path.split("/").length !== 3) {
      throw new ExtractionValidationError("Invalid owned storage path");
    }
    let signingResult: Awaited<ReturnType<ReturnType<typeof supabase.storage.from>["createSignedUrl"]>>;
    try {
      signingResult = await supabase.storage
        .from("course-materials")
        .createSignedUrl(file.path, 600);
    } catch (error) {
      const classification = classifyExtractionRuntimeError(error);
      throw new ExtractionRuntimeError(
        classification.failureCode === "worker_error" ? "provider_transient" : classification.failureCode,
        classification.failureCode === "worker_error" || classification.retryable,
        error,
      );
    }
    const { data, error } = signingResult;
    if (error || !data?.signedUrl) {
      const classification = classifyExtractionRuntimeError(error ?? new Error("Storage signing returned no URL"));
      // Unknown signing failures are normally service/transport failures. A
      // clear 4xx remains permanent, while an opaque SDK failure gets retried.
      const opaque = !error || (classification.failureCode === "worker_error" && !runtimeErrorDetails(error).status);
      throw new ExtractionRuntimeError(
        opaque ? "provider_transient" : classification.failureCode,
        opaque || classification.retryable,
        error,
      );
    }
    const downloaded = await downloadExtractionFile(
      { ...file, url: data.signedUrl },
      Math.min(file.size, MAX_TOTAL_SIZE - totalSize),
    );
    totalSize += downloaded.buffer.length;
    yield downloaded;
  }
}

export async function downloadExtractionJobFiles(
  supabase: SupabaseClient,
  userId: string,
  files: ValidatedJobFile[],
) {
  const downloaded: DownloadedExtractionFile[] = [];
  for await (const file of iterateExtractionJobFiles(supabase, userId, files)) downloaded.push(file);
  return downloaded;
}
