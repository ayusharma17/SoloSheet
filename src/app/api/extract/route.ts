import { createHash } from "node:crypto";
import { isAdminUser } from "@/lib/admin";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { extractFromMaterials } from "@/lib/gemini";
import { NextResponse } from "next/server";
import { cleanupUploadedFiles } from "@/lib/supabase/storage-helpers";
import { readExtractionRequest, downloadExtractionFiles, ExtractionValidationError } from "@/lib/extraction-validation";
import { creditCall, finishExtraction } from "@/lib/extraction-credits";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const now = Date.now();
    for (const [id, entry] of rateLimitMap) {
      if (now - entry.windowStart > 60_000) rateLimitMap.delete(id);
    }
    const rate = rateLimitMap.get(user.id) ?? { count: 0, windowStart: now };
    if (rate.count >= 5) {
      return NextResponse.json({ error: "Too many extraction requests. Please wait a minute and try again." }, { status: 429 });
    }
    rate.count++;
    rateLimitMap.set(user.id, rate);

    const storageOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!storageOrigin || !serviceKey) {
      return NextResponse.json({ error: "Extraction service is not configured." }, { status: 503 });
    }
    const payload = await readExtractionRequest(request, user.id, storageOrigin);
    const { requestId, courseName, userDirective, targetPages, fileUrls } = payload;
    // Signed URL tokens may rotate on retry. Stable object identity and all
    // extraction settings bind the idempotency key to the original operation.
    const fingerprint = createHash("sha256").update(JSON.stringify({
      courseName, userDirective, targetPages,
      files: fileUrls.map(({ path, name, type, size }) => ({ path, name, type, size })),
    })).digest("hex");
    const privileged = createSupabaseClient(storageOrigin, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const rpc = privileged.rpc.bind(privileged);
    const identity = { p_user_id: user.id, p_request_id: requestId };
    const reservation = await creditCall(rpc, "reserve_extraction", {
      ...identity, p_fingerprint: fingerprint,
      p_is_admin: await isAdminUser(user),
    });
    if (reservation.status === "no_credits") {
      return NextResponse.json({ error: "No credits remaining" }, { status: 403 });
    }
    if (reservation.status === "processing") {
      return NextResponse.json({ error: "This extraction is still processing.", code: "EXTRACTION_PROCESSING" }, { status: 409 });
    }
    if (reservation.status === "failed" || reservation.status === "conflict") {
      return NextResponse.json({ error: "Start a new extraction attempt to retry.", code: "EXTRACTION_RESTART_REQUIRED" }, { status: 409 });
    }
    let result = reservation;
    if (reservation.status === "reserved") {
      result = await finishExtraction({
        rpc, identity,
        generate: async () => extractFromMaterials(await downloadExtractionFiles(fileUrls), userDirective),
        completion: { p_course_name: courseName, p_target_pages: targetPages, p_user_directive: userDirective.slice(0, 500) },
      });
    } else if (reservation.status !== "completed") {
      throw new Error("Unexpected reservation status");
    }
    if (!result.materialId) throw new Error("Saved extraction is unavailable");
    // A cleanup failure must not turn committed work into a failed extraction.
    // Retry of the same request safely repeats cleanup without generating again.
    let cleanupPending = false;
    try {
      cleanupPending = !(await cleanupUploadedFiles(supabase, fileUrls.map((file) => file.path)));
    } catch {
      cleanupPending = true;
    }
    return NextResponse.json({ success: true, materialId: result.materialId, remainingCredits: result.remainingCredits, cleanupPending });
  } catch (error: unknown) {
    if (error instanceof ExtractionValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // Preserve uploads on failures: the browser may retry or explicitly discard.
    // Never return provider diagnostics, signed URLs, or database internals.
    console.error("[Extract API] Extraction attempt failed");
    return NextResponse.json({ error: "Extraction failed. Please retry. Your uploads have been preserved." }, { status: 500 });
  }
}
