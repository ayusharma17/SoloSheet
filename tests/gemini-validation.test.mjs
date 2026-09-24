import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_GEMINI_MODEL,
  ExtractionOutputError,
  PROVIDER_CALL_TIMEOUT_MS,
  classifyProviderError,
  combineProviderFailures,
  remainingProviderCallTimeout,
  validateExtractionItems,
} from "../src/lib/gemini.ts";

test("provider calls are capped by both a per-call timeout and the absolute job deadline", () => {
  assert.equal(remainingProviderCallTimeout(1_000_000, 0), PROVIDER_CALL_TIMEOUT_MS);
  assert.equal(remainingProviderCallTimeout(120_000, 100_000), 20_000);
  assert.equal(remainingProviderCallTimeout(100_000, 100_000), 0);
  assert.equal(remainingProviderCallTimeout(99_999, 100_000), 0);
});

const valid = {
  category: "Definition",
  topic: "Worker lease",
  content: "Exclusive ownership until expiry.",
  shorthand: "owner + TTL",
  priority: 8,
};

test("model output requires a non-empty fully typed item array", () => {
  assert.deepEqual(validateExtractionItems([valid]), [valid]);
  for (const value of [
    [],
    { items: [valid] },
    [{ ...valid, category: "Other" }],
    [{ ...valid, topic: "" }],
    [{ ...valid, priority: "8" }],
    [{ ...valid, content: "" }],
  ]) {
    assert.throws(() => validateExtractionItems(value), ExtractionOutputError);
  }
});

test("the built-in model is the stable Gemini model", () => {
  assert.equal(DEFAULT_GEMINI_MODEL, "gemini-3.1-flash-lite");
});

test("provider error classification recognizes retryable transport failures", () => {
  for (const error of [
    { status: 408 },
    { statusCode: 429 },
    { response: { status: 500 } },
    { code: "503", message: "Service unavailable" },
    new Error("Request timed out"),
    Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
  ]) {
    assert.deepEqual(classifyProviderError(error), {
      failureCode: "provider_transient",
      retryable: true,
      canFallback: true,
    });
  }
});

test("provider error classification only fails over for model-specific permanent errors", () => {
  for (const error of [
    { status: 400, message: "Invalid argument" },
    { status: 404, message: "Route was not found" },
    { status: 422 },
  ]) {
    assert.deepEqual(classifyProviderError(error), {
      failureCode: "provider_permanent",
      retryable: false,
      canFallback: false,
    });
  }
  assert.deepEqual(classifyProviderError({ status: 404, message: "Model gemini-old was not found" }), {
    failureCode: "provider_permanent",
    retryable: false,
    canFallback: true,
  });
  assert.deepEqual(classifyProviderError({ status: 401, message: "Invalid API key" }), {
    failureCode: "configuration",
    retryable: false,
    canFallback: false,
  });
});

test("nested undici fetch failures are transient", () => {
  assert.deepEqual(classifyProviderError(new TypeError("fetch failed", {
    cause: Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" }),
  })), {
    failureCode: "provider_transient",
    retryable: true,
    canFallback: true,
  });
});

test("failure aggregation preserves common permanent/configuration precedence", () => {
  assert.deepEqual(combineProviderFailures([
    classifyProviderError({ status: 404, message: "Model was not found" }),
    classifyProviderError({ status: 503 }),
  ]), {
    failureCode: "provider_transient",
    retryable: true,
    canFallback: true,
  });
  assert.deepEqual(combineProviderFailures([
    classifyProviderError({ status: 400 }),
    classifyProviderError({ status: 503 }),
  ]), {
    failureCode: "provider_permanent",
    retryable: false,
    canFallback: false,
  });
  assert.deepEqual(combineProviderFailures([
    classifyProviderError({ status: 503 }),
    classifyProviderError({ status: 401 }),
  ]), {
    failureCode: "configuration",
    retryable: false,
    canFallback: false,
  });
});
