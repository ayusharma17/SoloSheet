import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { promisify } from "node:util";
import {
  FlagOperationError,
  parseArguments,
  parseSupabaseTarget,
  publicAction,
  publicErrorCode,
  runFlagOperation,
} from "../scripts/trial-credit-flag-lib.mjs";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const CORRELATION = "22222222-2222-4222-8222-222222222222";
const LOCAL_ENV = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-secret",
};
const execFileAsync = promisify(execFile);

function args(action, extras = []) {
  return [
    action,
    "--actor", ACTOR,
    "--reason", "Launch policy maintenance",
    "--correlation", CORRELATION,
    ...extras,
  ];
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sequenceFetch(items, requests = []) {
  return async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    const next = items.shift();
    if (!next) throw new Error("unexpected test request");
    return next;
  };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof FlagOperationError && error.code === code);
}

test("accepts only loopback or exact hosted Supabase project origins", () => {
  assert.deepEqual(parseSupabaseTarget("http://127.0.0.1:54321"), {
    origin: "http://127.0.0.1:54321",
    hosted: false,
  });
  assert.deepEqual(parseSupabaseTarget("https://project-ref.supabase.co"), {
    origin: "https://project-ref.supabase.co",
    hosted: true,
  });
  for (const target of [
    "http://127.1:54321",
    "http://2130706433:54321",
    "http://0x7f000001:54321",
    "http://[0:0:0:0:0:0:0:1]:54321",
  ]) {
    assert.equal(parseSupabaseTarget(target).hosted, false);
  }

  for (const target of [
    "https://user:pass@project-ref.supabase.co",
    "https://project%2dref.supabase.co",
    "https://project-ref.supabase.co/rest/v1",
    "https://project-ref.supabase.co?project=other",
    "https://project-ref.supabase.co#fragment",
    "http://project-ref.supabase.co",
    "https://supabase.co",
    "https://project-ref.supabase.co.evil.example",
    "http://192.168.1.10:54321",
    "http://[::ffff:127.0.0.1]:54321",
  ]) {
    assert.throws(() => parseSupabaseTarget(target), (error) => error.code === "INVALID_TARGET");
  }
});

test("requires explicit actor, bounded reason, and valid or generated correlation UUID", () => {
  assert.equal(publicAction("enable"), "enable");
  assert.equal(publicAction("attacker-controlled-action"), "unknown");
  assert.equal(parseArguments(args("status")).correlationId, CORRELATION);
  assert.match(parseArguments([
    "status", "--actor", ACTOR, "--reason", "check",
  ]).correlationId, /^[0-9a-f-]{36}$/i);
  assert.throws(() => parseArguments(["status", "--actor", "not-a-uuid", "--reason", "check"]),
    (error) => error.code === "INVALID_ACTOR");
  assert.throws(() => parseArguments(["status", "--actor", ACTOR, "--reason", " "]),
    (error) => error.code === "INVALID_REASON");
  assert.throws(() => parseArguments(["status", "--actor", ACTOR, "--reason", "x".repeat(1001)]),
    (error) => error.code === "INVALID_REASON");
  assert.throws(() => parseArguments(args("status", ["--confirm-copy-deployed"])),
    (error) => error.code === "INVALID_ARGUMENTS");
  assert.throws(() => parseArguments(args("enable", ["--confirm-recovery"])),
    (error) => error.code === "INVALID_ARGUMENTS");
});

test("requires hosted target confirmation to match the exact origin", async () => {
  const hostedEnv = {
    SUPABASE_URL: "https://project-ref.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "secret",
  };
  await rejectsCode(runFlagOperation({ args: args("status"), env: hostedEnv, fetchImpl: async () => response(true) }), "TARGET_CONFIRMATION_REQUIRED");
  await rejectsCode(runFlagOperation({
    args: args("status", ["--confirm-target", "https://other.supabase.co"]),
    env: hostedEnv,
    fetchImpl: async () => response(true),
  }), "TARGET_CONFIRMATION_MISMATCH");
  const result = await runFlagOperation({
    args: args("status", ["--confirm-target", hostedEnv.SUPABASE_URL]),
    env: hostedEnv,
    fetchImpl: async () => response(true),
  });
  assert.equal(result.status, "verified");
});

test("refuses ambiguous private and public Supabase target environments", async () => {
  await rejectsCode(runFlagOperation({
    args: args("status"),
    env: {
      ...LOCAL_ENV,
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
    },
    fetchImpl: async () => response(true),
  }), "TARGET_ENV_MISMATCH");
});

test("disable requires explicit public-copy deployment confirmation", async () => {
  await rejectsCode(runFlagOperation({
    args: args("disable"),
    env: LOCAL_ENV,
    fetchImpl: async () => response(true),
  }), "COPY_CONFIRMATION_REQUIRED");
});

test("requires a non-empty service-role key without surrounding whitespace", async () => {
  for (const serviceRoleKey of [undefined, "", "   ", " secret", "secret\n"]) {
    await rejectsCode(runFlagOperation({
      args: args("status"),
      env: { SUPABASE_URL: LOCAL_ENV.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey },
      fetchImpl: async () => response(true),
    }), "MISSING_SERVICE_ROLE_KEY");
  }
});

test("enable reads, sets through the audited RPC, and verifies exact payloads", async () => {
  const requests = [];
  const result = await runFlagOperation({
    args: args("enable"),
    env: LOCAL_ENV,
    fetchImpl: sequenceFetch([response(false), response({ oldValue: false, newValue: true }), response(true)], requests),
  });

  assert.deepEqual(result, {
    action: "enable",
    status: "verified",
    previousEnabled: false,
    enabled: true,
    correlationId: CORRELATION,
    target: LOCAL_ENV.SUPABASE_URL,
  });
  assert.deepEqual(requests.map(({ url }) => url), [
    `${LOCAL_ENV.SUPABASE_URL}/rest/v1/rpc/get_non_edu_trial_credits_enabled`,
    `${LOCAL_ENV.SUPABASE_URL}/rest/v1/rpc/set_non_edu_trial_credits_enabled`,
    `${LOCAL_ENV.SUPABASE_URL}/rest/v1/rpc/get_non_edu_trial_credits_enabled`,
  ]);
  assert.deepEqual(requests[1].body, {
    p_enabled: true,
    p_actor_user_id: ACTOR,
    p_reason: "Launch policy maintenance",
    p_correlation_id: CORRELATION,
  });
  assert.equal(requests[0].init.headers.apikey, LOCAL_ENV.SUPABASE_SERVICE_ROLE_KEY);
  assert.equal(requests[0].init.headers.authorization, `Bearer ${LOCAL_ENV.SUPABASE_SERVICE_ROLE_KEY}`);
  assert.equal(requests[0].init.redirect, "error");
});

test("disable performs the same verified flow only after copy confirmation", async () => {
  const result = await runFlagOperation({
    args: args("disable", ["--confirm-copy-deployed"]),
    env: LOCAL_ENV,
    fetchImpl: sequenceFetch([response(true), response({ oldValue: true, newValue: false }), response(false)]),
  });
  assert.equal(result.previousEnabled, true);
  assert.equal(result.enabled, false);
});

test("enable and disable are idempotent when already at the desired value", async () => {
  const enabled = await runFlagOperation({
    args: args("enable"),
    env: LOCAL_ENV,
    fetchImpl: sequenceFetch([response(true), response({ oldValue: true, newValue: true }), response(true)]),
  });
  assert.equal(enabled.previousEnabled, true);
  assert.equal(enabled.enabled, true);

  const disabled = await runFlagOperation({
    args: args("disable", ["--confirm-copy-deployed"]),
    env: LOCAL_ENV,
    fetchImpl: sequenceFetch([response(false), response({ oldValue: false, newValue: false }), response(false)]),
  });
  assert.equal(disabled.previousEnabled, false);
  assert.equal(disabled.enabled, false);
});

test("fails when setter output or authoritative read-back disagrees", async () => {
  await rejectsCode(runFlagOperation({
    args: args("enable"),
    env: LOCAL_ENV,
    fetchImpl: sequenceFetch([response(false), response({ newValue: true }), response(true)]),
  }), "INVALID_RESPONSE");
  await rejectsCode(runFlagOperation({
    args: args("enable"),
    env: LOCAL_ENV,
    fetchImpl: sequenceFetch([response(false), response({ oldValue: true, newValue: true })]),
  }), "VERIFICATION_MISMATCH");
  await rejectsCode(runFlagOperation({
    args: args("enable"),
    env: LOCAL_ENV,
    fetchImpl: sequenceFetch([response(false), response({ oldValue: false, newValue: false })]),
  }), "VERIFICATION_MISMATCH");
  await rejectsCode(runFlagOperation({
    args: args("enable"),
    env: LOCAL_ENV,
    fetchImpl: sequenceFetch([response(false), response({ oldValue: false, newValue: true }), response(false)]),
  }), "VERIFICATION_MISMATCH");
  await rejectsCode(runFlagOperation({
    args: args("enable"),
    env: LOCAL_ENV,
    fetchImpl: sequenceFetch([response(false), response([false, true])]),
  }), "INVALID_RESPONSE");
  await rejectsCode(runFlagOperation({
    args: args("enable"),
    env: LOCAL_ENV,
    fetchImpl: sequenceFetch([response(false), new Response(null)]),
  }), "INVALID_RESPONSE");
});

test("missing-row recovery is intentional, ON-only, and verifies restoration", async () => {
  await rejectsCode(runFlagOperation({
    args: args("recover-missing"),
    env: LOCAL_ENV,
    fetchImpl: async () => response({ code: "P0002" }, 500),
  }), "RECOVERY_CONFIRMATION_REQUIRED");

  const requests = [];
  const result = await runFlagOperation({
    args: args("recover-missing", ["--confirm-recovery"]),
    env: LOCAL_ENV,
    fetchImpl: sequenceFetch([
      response({ code: "P0002", message: "redacted database detail" }, 500),
      response({ oldValue: null, newValue: true }),
      response(true),
    ], requests),
  });
  assert.equal(result.status, "restored");
  assert.equal(requests[1].body.p_enabled, true);
});

test("recovery rejects a row concurrently recreated before the serialized setter", async () => {
  await rejectsCode(runFlagOperation({
    args: args("recover-missing", ["--confirm-recovery"]),
    env: LOCAL_ENV,
    fetchImpl: sequenceFetch([
      response({ code: "P0002" }, 500),
      response({ oldValue: false, newValue: true }),
    ]),
  }), "VERIFICATION_MISMATCH");
});

test("rejects arrays, malformed JSON, invalid UTF-8, and oversized response bodies", async () => {
  for (const invalidResponse of [
    response([true]),
    new Response("{", { status: 200 }),
    new Response('{"__proto__":{"oldValue":false,"newValue":true}}', { status: 200 }),
    new Response(new Uint8Array([0xff]), { status: 200 }),
    new Response(`\"${"x".repeat(64 * 1024)}\"`, { status: 200 }),
    new Response("true", { status: 200, headers: { "content-length": String(64 * 1024 + 1) } }),
  ]) {
    await rejectsCode(runFlagOperation({
      args: args("status"),
      env: LOCAL_ENV,
      fetchImpl: async () => invalidResponse,
    }), "INVALID_RESPONSE");
  }
});

test("aborts a stalled RPC at the configured request timeout", async () => {
  await rejectsCode(runFlagOperation({
    args: args("status"),
    env: LOCAL_ENV,
    requestTimeoutMs: 5,
    fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  }), "NETWORK_ERROR");
});

test("recovery refuses present rows and all failures other than exact P0002", async () => {
  await rejectsCode(runFlagOperation({
    args: args("recover-missing", ["--confirm-recovery"]),
    env: LOCAL_ENV,
    fetchImpl: sequenceFetch([response(false)]),
  }), "RECOVERY_NOT_NEEDED");
  await rejectsCode(runFlagOperation({
    args: args("recover-missing", ["--confirm-recovery"]),
    env: LOCAL_ENV,
    fetchImpl: sequenceFetch([response({ code: "42501", message: "secret auth detail" }, 403)]),
  }), "AUTHORIZATION_FAILED");
  await rejectsCode(runFlagOperation({
    args: args("recover-missing", ["--confirm-recovery"]),
    env: LOCAL_ENV,
    fetchImpl: sequenceFetch([response({ code: "P0002", message: "misleading auth detail" }, 403)]),
  }), "AUTHORIZATION_FAILED");
  await rejectsCode(runFlagOperation({
    args: args("recover-missing", ["--confirm-recovery"]),
    env: LOCAL_ENV,
    fetchImpl: sequenceFetch([response({ code: "P0002", message: "wrong status" }, 400)]),
  }), "RPC_FAILED");
  await rejectsCode(runFlagOperation({
    args: args("recover-missing", ["--confirm-recovery"]),
    env: LOCAL_ENV,
    fetchImpl: async () => { throw new Error("network secret detail"); },
  }), "NETWORK_ERROR");
});

test("public failures expose finite codes without service keys or provider details", async () => {
  let caught;
  try {
    await runFlagOperation({
      args: args("status"),
      env: LOCAL_ENV,
      fetchImpl: async () => response({ code: "XX000", message: "private detail test-service-role-secret" }, 500),
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(publicErrorCode(caught), "RPC_FAILED");
  assert.equal(JSON.stringify({ error: publicErrorCode(caught) }).includes("test-service-role-secret"), false);
  assert.equal(publicErrorCode(new Error("test-service-role-secret")), "UNEXPECTED_FAILURE");
});

test("executable CLI emits one redacted finite failure and exits nonzero", async () => {
  await assert.rejects(execFileAsync(process.execPath, [
    "scripts/manage-trial-credit-flag.mjs",
    "invalid-secret-action",
  ], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      SUPABASE_URL: LOCAL_ENV.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: "should-never-be-printed",
    },
  }), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    assert.deepEqual(JSON.parse(error.stderr), {
      action: "unknown",
      status: "failed",
      error: "INVALID_ACTION",
    });
    assert.equal(error.stderr.includes("should-never-be-printed"), false);
    assert.equal(error.stderr.includes("invalid-secret-action"), false);
    return true;
  });
});

test("documented silent npm command preserves the one-JSON failure contract", async () => {
  await assert.rejects(execFileAsync("npm", [
    "run",
    "--silent",
    "trial-flag",
    "--",
    "invalid-secret-action",
  ], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      SUPABASE_URL: LOCAL_ENV.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: "should-never-be-printed",
    },
  }), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    assert.deepEqual(JSON.parse(error.stderr), {
      action: "unknown",
      status: "failed",
      error: "INVALID_ACTION",
    });
    assert.equal(error.stderr.includes("should-never-be-printed"), false);
    assert.equal(error.stderr.includes("invalid-secret-action"), false);
    return true;
  });
});

test("executable CLI completes an enable flow against a loopback mock server", async (context) => {
  const calls = [];
  const replies = [false, { oldValue: false, newValue: true }, true];
  const server = createServer((request, responseStream) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      calls.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(body),
      });
      responseStream.writeHead(200, { "content-type": "application/json" });
      responseStream.end(JSON.stringify(replies.shift()));
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EPERM") {
      context.skip("runtime does not permit binding a loopback mock server");
      return;
    }
    throw error;
  }
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert(address && typeof address === "object");

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "scripts/manage-trial-credit-flag.mjs",
    ...args("enable"),
  ], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      SUPABASE_URL: `http://127.0.0.1:${address.port}`,
      SUPABASE_SERVICE_ROLE_KEY: "mock-only-service-key",
    },
  });

  assert.equal(stderr, "");
  assert.equal(JSON.parse(stdout).status, "verified");
  assert.equal(calls.length, 3);
  assert.equal(calls[1].body.p_enabled, true);
  assert.equal(calls[0].authorization, "Bearer mock-only-service-key");
});
