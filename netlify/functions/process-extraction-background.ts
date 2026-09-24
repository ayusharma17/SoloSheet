import type { Config } from "@netlify/functions";
import { randomUUID } from "node:crypto";
import { extractFromMaterials, ExtractionOutputError, ExtractionProviderError } from "../../src/lib/gemini";
import { ExtractionRuntimeError, iterateExtractionJobFiles } from "../../src/lib/extraction-validation";
import { parseClaimedExtractionJob } from "../../src/lib/extraction-jobs";
import {
  authorizedDispatch,
  cleanupJobUploads,
  createWorkerClient,
  leaseRenewalDisposition,
  parseRequestId,
} from "./_shared/extraction-runtime";

const LEASE_SECONDS = 180;
// Leave two minutes for final settlement/logging before Netlify's 15-minute kill.
export const WORKER_JOB_BUDGET_MS = 13 * 60_000;

class ExtractionLeaseLostError extends Error {
  constructor() {
    super("Extraction worker lease is no longer active");
    this.name = "ExtractionLeaseLostError";
  }
}

export default async function handler(request: Request) {
  const jobDeadlineMs = Date.now() + WORKER_JOB_BUDGET_MS;
  if (request.method !== "POST" || !authorizedDispatch(request)) {
    return new Response(null, { status: 404 });
  }
  let requestId: string;
  try {
    const body: unknown = await request.json();
    requestId = parseRequestId(
      typeof body === "object" && body !== null && "requestId" in body ? body.requestId : null,
    );
  } catch {
    return new Response(null, { status: 400 });
  }

  const supabase = createWorkerClient();
  const leaseOwner = randomUUID();
  const { data, error } = await supabase.rpc("claim_extraction_job", {
    p_request_id: requestId,
    p_lease_owner: leaseOwner,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error(`Extraction claim failed for request ${requestId}`);
  const claim = parseClaimedExtractionJob(data);
  if (claim.status === "leased") {
    // A prior invocation may have been hard-killed while its database lease is
    // still active. Failing the invocation preserves the platform retry signal;
    // returning success here would silently consume it.
    throw new Error(`Extraction request ${requestId} still has an active lease`);
  }
  if (claim.status !== "processing") return;

  let leaseLost = false;
  let leaseDeadline = Date.now() + LEASE_SECONDS * 1_000;
  let heartbeatPromise: Promise<boolean> | null = null;
  const renewLease = async (): Promise<boolean> => {
    if (leaseLost) return false;
    if (heartbeatPromise) return heartbeatPromise;
    heartbeatPromise = (async () => {
      try {
        const { data: renewed, error: heartbeatError } = await supabase.rpc("heartbeat_extraction_job", {
          p_request_id: requestId,
          p_lease_owner: leaseOwner,
          p_lease_seconds: LEASE_SECONDS,
        });
        const disposition = leaseRenewalDisposition(renewed, heartbeatError, leaseDeadline);
        if (disposition === "active") {
          leaseDeadline = Date.now() + LEASE_SECONDS * 1_000;
          return true;
        }
        if (disposition === "lost") {
          leaseLost = true;
          return false;
        }
        // A transport/database error does not prove ownership was revoked. Keep
        // the current lease until its last known deadline, then stop safely.
        console.warn(`[Extraction Worker] request=${requestId} heartbeat=transient_error`);
      } catch {
        console.warn(`[Extraction Worker] request=${requestId} heartbeat=transient_error`);
        if (leaseRenewalDisposition(undefined, true, leaseDeadline) === "lost") leaseLost = true;
      }
      return !leaseLost;
    })().finally(() => {
      heartbeatPromise = null;
    });
    return heartbeatPromise;
  };
  const assertLeaseActive = async () => {
    if (!await renewLease()) throw new ExtractionLeaseLostError();
  };
  const timer = setInterval(() => void renewLease(), 60_000);

  try {
    // Sign, download, validate, and submit one input at a time. This bounds the
    // worker to one source buffer plus its temporary base64 request rather than
    // retaining every source file and every encoded request at once.
    const files = iterateExtractionJobFiles(supabase, claim.userId, claim.fileInputs);
    const items = await extractFromMaterials(files, claim.userDirective, {
      requestId,
      onProgress: assertLeaseActive,
      totalFiles: claim.fileInputs.length,
      deadlineMs: jobDeadlineMs,
    });
    await assertLeaseActive();
    const { data: completed, error: completeError } = await supabase.rpc("complete_extraction_job", {
      p_request_id: requestId,
      p_lease_owner: leaseOwner,
      p_items: items,
    });
    if (completeError) throw new Error("Extraction completion failed");
    if (typeof completed === "object" && completed !== null &&
        "status" in completed && completed.status === "completed") {
      try {
        await cleanupJobUploads(supabase, requestId, claim.fileInputs);
      } catch {
        console.warn(`[Extraction Worker] request=${requestId} cleanup=pending`);
      }
      return;
    }
  } catch (workerError: unknown) {
    if (workerError instanceof ExtractionLeaseLostError || leaseLost) {
      console.warn(`[Extraction Worker] request=${requestId} lease=lost`);
      return;
    }
    const failureCode = workerError instanceof ExtractionProviderError ||
      workerError instanceof ExtractionOutputError || workerError instanceof ExtractionRuntimeError
      ? workerError.failureCode
      : runtimeFailureCode(workerError);
    const retryable = (workerError instanceof ExtractionProviderError || workerError instanceof ExtractionRuntimeError) &&
      workerError.retryable;
    const { data: settlement, error: settlementError } = await supabase.rpc("fail_extraction_job", {
      p_request_id: requestId,
      p_lease_owner: leaseOwner,
      p_failure_code: failureCode,
      p_retryable: retryable,
    });
    if (settlementError) throw new Error(`Extraction settlement failed for request ${requestId}`);
    const status = typeof settlement === "object" && settlement !== null && "status" in settlement
      ? settlement.status : null;
    console.error(`[Extraction Worker] request=${requestId} failure=${failureCode} state=${String(status)}`);
    if (status === "failed") {
      try { await cleanupJobUploads(supabase, requestId, claim.fileInputs); }
      catch { console.warn(`[Extraction Worker] request=${requestId} cleanup=pending`); }
    }
    if (status === "queued") throw new Error(`Retryable extraction failure for request ${requestId}`);
  } finally {
    clearInterval(timer);
  }
}

function runtimeFailureCode(error: unknown): "configuration" | "worker_error" {
  return error instanceof Error && error.message.includes("configuration")
    ? "configuration" : "worker_error";
}

export const config: Config = {
  path: "/internal/extraction-worker",
};
