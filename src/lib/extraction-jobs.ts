import type { ValidatedJobFile } from "@/lib/extraction-validation";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ExtractionJobStatus = "queued" | "processing" | "completed" | "failed" | "expired";

type ExtractionStatusMetadata = {
  remainingCredits?: number;
  failureCode?: string;
  attemptCount?: number;
};

export type ExtractionStatus = ExtractionStatusMetadata & (
  | { status: "queued" }
  | { status: "processing" }
  | { status: "completed"; materialId: string }
  | { status: "failed" }
  | { status: "expired" }
  | { status: "missing" }
);

export type ClaimedExtractionJob = {
  status: "processing";
  userId: string;
  requestId: string;
  courseName: string;
  userDirective: string;
  targetPages: number;
  fileInputs: ValidatedJobFile[];
  attemptCount: number;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseExtractionStatus(value: unknown): ExtractionStatus {
  if (!record(value) || typeof value.status !== "string" ||
      !["queued", "processing", "completed", "failed", "expired", "missing"].includes(value.status)) {
    throw new Error("Invalid extraction status response");
  }
  if (value.status === "completed" &&
      (typeof value.materialId !== "string" || !UUID_PATTERN.test(value.materialId))) {
    throw new Error("Invalid extraction material response");
  }
  if (value.status !== "completed" && value.materialId !== undefined && value.materialId !== null) {
    throw new Error("Unexpected extraction material response");
  }
  if (value.remainingCredits !== undefined &&
      (!Number.isInteger(value.remainingCredits) || Number(value.remainingCredits) < 0)) {
    throw new Error("Invalid extraction balance response");
  }
  if (value.failureCode !== undefined && value.failureCode !== null && typeof value.failureCode !== "string") {
    throw new Error("Invalid extraction failure response");
  }
  if (value.attemptCount !== undefined &&
      (!Number.isInteger(value.attemptCount) || Number(value.attemptCount) < 0)) {
    throw new Error("Invalid extraction attempt response");
  }
  return value as ExtractionStatus;
}

type UnclaimedJob = {
  status: "missing" | "completed" | "failed" | "expired" | "leased" | "attempts_exhausted";
};

export function parseClaimedExtractionJob(value: unknown): ClaimedExtractionJob | UnclaimedJob {
  if (!record(value) || typeof value.status !== "string") {
    throw new Error("Invalid extraction claim response");
  }
  if (value.status !== "processing") {
    if (!["missing", "completed", "failed", "expired", "leased", "attempts_exhausted"].includes(value.status)) {
      throw new Error("Invalid extraction claim state");
    }
    return { status: value.status as UnclaimedJob["status"] };
  }
  if (typeof value.userId !== "string" || typeof value.requestId !== "string" ||
      typeof value.courseName !== "string" || typeof value.userDirective !== "string" ||
      !Number.isInteger(value.targetPages) || !Number.isInteger(value.attemptCount) ||
      !Array.isArray(value.fileInputs)) {
    throw new Error("Invalid extraction job inputs");
  }
  const prefix = `${value.userId}/`;
  const files = value.fileInputs.map((file): ValidatedJobFile => {
    if (!record(file) || typeof file.path !== "string" || !file.path.startsWith(prefix) ||
        file.path.split("/").length !== 3 || typeof file.name !== "string" ||
        typeof file.type !== "string" || !Number.isSafeInteger(file.size) || Number(file.size) <= 0) {
      throw new Error("Invalid extraction job file");
    }
    return { path: file.path, name: file.name, type: file.type, size: Number(file.size) };
  });
  return { ...value, fileInputs: files } as ClaimedExtractionJob;
}

export async function readJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) return null;
  try { return await response.json(); } catch { return null; }
}

export function extractionFailureMessage(status: ExtractionStatus): string {
  if (status.failureCode === "account_held") return "This account is under review. Your credit was restored.";
  if (status.status === "expired") return "Generation timed out safely. Your credit was restored; start a new attempt.";
  return "Generation could not be completed. Your credit was restored; start a new attempt.";
}

export function dispatchCancellationDisposition(status: string | undefined): "active" | "refunded" | "unknown" {
  if (status === "queued" || status === "processing") return "active";
  if (status === "failed") return "refunded";
  return "unknown";
}
