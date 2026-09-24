import { createHash } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { readExtractionRequest, ExtractionValidationError } from "@/lib/extraction-validation";
import { creditCall } from "@/lib/extraction-credits";
import { dispatchCancellationDisposition } from "@/lib/extraction-jobs";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

async function dispatchExtraction(requestId: string) {
  const appUrl = process.env.APP_URL;
  const secret = process.env.EXTRACTION_DISPATCH_SECRET;
  if (!appUrl || !secret || secret.length < 32) throw new Error("Extraction worker is not configured");
  const endpoint = new URL("/internal/extraction-worker", appUrl);
  if (!["https:", "http:"].includes(endpoint.protocol) ||
      (endpoint.protocol === "http:" && !["localhost", "127.0.0.1"].includes(endpoint.hostname))) {
    throw new Error("Extraction worker URL is invalid");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ requestId }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 202) throw new Error("Extraction worker rejected dispatch");
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const storageOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!storageOrigin || !serviceKey) {
      return NextResponse.json({ error: "Extraction service is not configured." }, { status: 503 });
    }
    const payload = await readExtractionRequest(request, user.id, storageOrigin);
    const { requestId, courseName, userDirective, targetPages, fileUrls } = payload;
    const fingerprint = createHash("sha256").update(JSON.stringify({
      courseName, userDirective, targetPages,
      files: fileUrls.map(({ path, name, type, size }) => ({ path, name, type, size })),
    })).digest("hex");
    const privileged = createSupabaseClient(storageOrigin, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const rpc = privileged.rpc.bind(privileged);
    const result = await creditCall(rpc, "enqueue_extraction", {
      p_user_id: user.id,
      p_request_id: requestId,
      p_fingerprint: fingerprint,
      p_course_name: courseName,
      p_target_pages: targetPages,
      p_user_directive: userDirective,
      p_files: fileUrls.map(({ path, name, type, size }) => ({ path, name, type, size })),
    });
    if (result.status === "no_credits") {
      return NextResponse.json({ error: "No credits remaining" }, { status: 403 });
    }
    if (result.status === "account_held") {
      return NextResponse.json({ error: "This account is under review.", code: "ACCOUNT_HELD" }, { status: 423 });
    }
    if (result.status === "conflict" || result.status === "failed" || result.status === "expired") {
      return NextResponse.json({ error: "Start a new extraction attempt to retry.", code: "EXTRACTION_RESTART_REQUIRED" }, { status: 409 });
    }
    if (result.status === "completed" && result.materialId) {
      return NextResponse.json({
        status: "completed", materialId: result.materialId,
        remainingCredits: result.remainingCredits,
      });
    }
    if (result.status === "processing") {
      return NextResponse.json({ status: "processing", requestId, remainingCredits: result.remainingCredits }, { status: 202 });
    }
    if (result.status !== "queued") throw new Error("Unexpected extraction job state");

    try {
      await dispatchExtraction(requestId);
    } catch {
      const cancelled = await creditCall(rpc, "cancel_extraction_dispatch", {
        p_user_id: user.id, p_request_id: requestId,
      });
      // If dispatch succeeded but its response was lost, the worker may already
      // own the lease. Keep that authoritative job alive and let the UI poll.
      const disposition = dispatchCancellationDisposition(cancelled.status);
      if (disposition === "refunded") {
        return NextResponse.json({
          error: "Generation could not be queued. Your credit was restored.",
          code: "EXTRACTION_RESTART_REQUIRED",
          remainingCredits: cancelled.remainingCredits,
        }, { status: 503 });
      }
      if (disposition === "unknown") {
        throw new Error("Unable to resolve extraction dispatch");
      }
    }

    return NextResponse.json({
      status: "queued", requestId, remainingCredits: result.remainingCredits,
    }, { status: 202 });
  } catch (error: unknown) {
    if (error instanceof ExtractionValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[Extract API] Unable to enqueue extraction");
    return NextResponse.json({ error: "Generation could not be started. Please try again." }, { status: 500 });
  }
}
