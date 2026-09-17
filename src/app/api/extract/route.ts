import { createHash } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { extractFromMaterials } from "@/lib/gemini";
import { NextResponse } from "next/server";
import { cleanupUploadedFiles } from "@/lib/supabase/storage-helpers";
import { readExtractionRequest, downloadExtractionFiles, ExtractionValidationError } from "@/lib/extraction-validation";
import { creditCall, finishExtraction } from "@/lib/extraction-credits";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let cleanupClient: Awaited<ReturnType<typeof createClient>> | null = null;
  let failedUploadPaths: string[] = [];
  try {
    const supabase = await createClient();
    cleanupClient = supabase;
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const storageOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!storageOrigin || !serviceKey) {
      return NextResponse.json({ error: "Extraction service is not configured." }, { status: 503 });
    }
    const payload = await readExtractionRequest(request, user.id, storageOrigin);
    const { requestId, courseName, userDirective, targetPages, fileUrls } = payload;
    failedUploadPaths = fileUrls.map((file) => file.path);
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
    });
    if (reservation.status === "no_credits") {
      return NextResponse.json({ error: "No credits remaining" }, { status: 403 });
    }
    if (reservation.status === "processing") {
      return NextResponse.json({ error: "This extraction is still processing.", code: "EXTRACTION_PROCESSING" }, { status: 409 });
    }
    if (reservation.status === "account_held") {
      return NextResponse.json({ error: "This account is under review.", code: "ACCOUNT_HELD" }, { status: 423 });
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
    if (result.status === "account_held") {
      return NextResponse.json({ error: "This account is under review.", code: "ACCOUNT_HELD" }, { status: 423 });
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
    // A response from this catch is a known terminal failure: finishExtraction
    // has already settled the credit reservation and this request ID cannot be
    // reused. Clear its uploads so they do not strand the user's storage quota.
    // A transport failure where the browser receives no response remains
    // ambiguous and is still preserved client-side for an idempotent retry.
    if (cleanupClient && failedUploadPaths.length > 0) {
      try {
        await cleanupUploadedFiles(cleanupClient, failedUploadPaths);
      } catch {
        // The browser also journals these paths for an idempotent cleanup retry.
      }
    }
    // Never return provider diagnostics, signed URLs, or database internals.
    console.error("[Extract API] Extraction attempt failed");
    return NextResponse.json({
      error: "Extraction failed. Please try again. The failed upload batch was cleared.",
      code: "EXTRACTION_RESTART_REQUIRED",
    }, { status: 500 });
  }
}
