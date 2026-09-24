import assert from "node:assert/strict";
import test from "node:test";
import {
  extractionFailureMessage,
  dispatchCancellationDisposition,
  parseClaimedExtractionJob,
  parseExtractionStatus,
  readJsonResponse,
} from "../src/lib/extraction-jobs.ts";

test("status parsing distinguishes active and terminal job states", () => {
  assert.equal(parseExtractionStatus({ status: "queued", remainingCredits: 0 }).status, "queued");
  assert.equal(parseExtractionStatus({ status: "processing", attemptCount: 1 }).status, "processing");
  const materialId = "72000000-0000-4000-8000-000000000001";
  assert.equal(parseExtractionStatus({ status: "completed", materialId }).materialId, materialId);
  assert.throws(() => parseExtractionStatus({ status: "unknown" }));
  assert.throws(() => parseExtractionStatus({ status: "completed", materialId: 42 }));
  assert.throws(() => parseExtractionStatus({ status: "completed", materialId: "sheet" }));
  assert.throws(() => parseExtractionStatus({ status: "completed" }));
  assert.throws(() => parseExtractionStatus({ status: "failed", materialId }));
});

test("claimed jobs require authoritative owner-scoped file paths", () => {
  const job = parseClaimedExtractionJob({
    status: "processing",
    userId: "user-one",
    requestId: "request-one",
    courseName: "Course",
    userDirective: "",
    targetPages: 1,
    attemptCount: 1,
    fileInputs: [{
      path: "user-one/session-one/file.pdf",
      name: "notes.pdf",
      type: "application/pdf",
      size: 42,
    }],
  });
  assert.equal(job.status, "processing");
  assert.throws(() => parseClaimedExtractionJob({
    ...job,
    fileInputs: [{ path: "other/session/file.pdf", name: "notes.pdf", type: "application/pdf", size: 42 }],
  }));
});

test("platform HTML is not parsed as JSON", async () => {
  const html = new Response("<html>gateway timeout</html>", {
    status: 504,
    headers: { "content-type": "text/html" },
  });
  assert.equal(await readJsonResponse(html), null);
  const malformed = new Response("{", { headers: { "content-type": "application/json" } });
  assert.equal(await readJsonResponse(malformed), null);
});

test("terminal failure copy confirms credit restoration", () => {
  assert.match(extractionFailureMessage({ status: "expired", failureCode: "lease_expired" }), /credit was restored/i);
  assert.match(extractionFailureMessage({ status: "failed", failureCode: "provider_permanent" }), /credit was restored/i);
});

test("ambiguous dispatch keeps claimed or retry-queued work active", () => {
  assert.equal(dispatchCancellationDisposition("processing"), "active");
  assert.equal(dispatchCancellationDisposition("queued"), "active");
  assert.equal(dispatchCancellationDisposition("failed"), "refunded");
  assert.equal(dispatchCancellationDisposition("missing"), "unknown");
});
