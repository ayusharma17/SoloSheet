import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";

export function runtimeEnv(name: string): string | undefined {
  return (typeof Netlify !== "undefined" ? Netlify.env.get(name) : undefined) ?? process.env[name];
}

export function createWorkerClient(): SupabaseClient {
  const url = runtimeEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = runtimeEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Worker database configuration is unavailable");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function authorizedDispatch(request: Request): boolean {
  const expected = runtimeEnv("EXTRACTION_DISPATCH_SECRET");
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || expected.length < 32 || !supplied) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function parseRequestId(value: unknown): string {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid request ID");
  }
  return value;
}

export function leaseRenewalDisposition(
  renewed: unknown,
  error: unknown,
  leaseDeadline: number,
  now = Date.now(),
): "active" | "transient_error" | "lost" {
  if (!error && renewed === true) return "active";
  if (!error) return "lost";
  return now >= leaseDeadline ? "lost" : "transient_error";
}

export async function cleanupJobUploads(
  supabase: SupabaseClient,
  requestId: string,
  files: Array<{ path: string }>,
) {
  const paths = [...new Set(files.map(file => file.path))];
  if (paths.length) {
    const { error } = await supabase.storage.from("course-materials").remove(paths);
    if (error) throw new Error("Storage cleanup failed");
  }
  const { error } = await supabase.rpc("release_extraction_upload_reservations", {
    p_request_id: requestId,
  });
  if (error) throw new Error("Upload reservation cleanup failed");
}
