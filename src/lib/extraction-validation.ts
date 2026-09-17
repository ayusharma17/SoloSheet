import { downloadFileFromStorage, ownedStoragePath } from "@/lib/supabase/storage-helpers";

export const MAX_TOTAL_SIZE = 200 * 1024 * 1024;
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

export interface ValidatedFile {
  url: string;
  path: string;
  name: string;
  type: string;
  size: number;
}

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

export async function downloadExtractionFiles(fileUrls: ValidatedFile[]) {
  const files: { buffer: Buffer; mimeType: string; name: string }[] = [];
  let totalSize = 0;
  for (const entry of fileUrls) {
    const { buffer, headers } = await downloadFileFromStorage(entry.url, undefined, Math.min(entry.size, MAX_TOTAL_SIZE - totalSize));
    totalSize += buffer.length;
    const responseType = headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if ((responseType && responseType !== entry.type && responseType !== "application/octet-stream") || !matchesFileSignature(buffer, entry.type)) {
      throw new ExtractionValidationError("Downloaded file does not match its declared type");
    }
    if (buffer.length !== entry.size) throw new ExtractionValidationError("Downloaded file size differs from upload metadata");
    files.push({ buffer, mimeType: entry.type, name: entry.name });
  }
  return files;
}
