import { randomUUID } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOSTED_SUPABASE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.supabase\.co$/;
const ACTIONS = new Set(["status", "enable", "disable", "recover-missing"]);
const MISSING_ROW_CODE = "P0002";
const MISSING_ROW_HTTP_STATUS = 500;
const MAX_RESPONSE_BYTES = 64 * 1024;

export function publicAction(action) {
  return ACTIONS.has(action) ? action : "unknown";
}

export class FlagOperationError extends Error {
  constructor(code) {
    super(code);
    this.name = "FlagOperationError";
    this.code = code;
  }
}

function fail(code) {
  throw new FlagOperationError(code);
}

export function parseSupabaseTarget(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() !== rawUrl || rawUrl === "") {
    fail("INVALID_TARGET");
  }

  // Require a literal host spelling. URL canonicalization is still useful for
  // recognizing alternate numeric loopback forms, but percent-encoded host
  // characters make the target harder for a maintainer to audit by sight.
  const authority = rawUrl.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1];
  if (!authority || authority.includes("%")) fail("INVALID_TARGET");

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail("INVALID_TARGET");
  }

  if (url.username || url.password || (url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) {
    fail("INVALID_TARGET");
  }

  const hostname = url.hostname.toLowerCase();
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  const isHosted = url.protocol === "https:" && !url.port && HOSTED_SUPABASE_PATTERN.test(hostname);
  if ((!isLoopback || !["http:", "https:"].includes(url.protocol)) && !isHosted) {
    fail("INVALID_TARGET");
  }

  return { origin: url.origin, hosted: isHosted };
}

export function parseArguments(argv) {
  const [action, ...tokens] = argv;
  if (!ACTIONS.has(action)) fail("INVALID_ACTION");

  const values = {};
  const switches = new Set();
  const valueOptions = new Set(["--actor", "--reason", "--correlation", "--confirm-target"]);
  const switchOptions = new Set(["--confirm-copy-deployed", "--confirm-recovery"]);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (switchOptions.has(token)) {
      if (switches.has(token)) fail("INVALID_ARGUMENTS");
      switches.add(token);
      continue;
    }
    if (!valueOptions.has(token) || values[token] !== undefined || tokens[index + 1] === undefined) {
      fail("INVALID_ARGUMENTS");
    }
    values[token] = tokens[index + 1];
    index += 1;
  }

  const actor = values["--actor"];
  const reason = values["--reason"]?.trim();
  const correlationId = values["--correlation"] ?? randomUUID();
  if (!UUID_PATTERN.test(actor ?? "")) fail("INVALID_ACTOR");
  if (!reason || [...reason].length > 1000) fail("INVALID_REASON");
  if (!UUID_PATTERN.test(correlationId)) fail("INVALID_CORRELATION");
  if (action === "disable" && !switches.has("--confirm-copy-deployed")) fail("COPY_CONFIRMATION_REQUIRED");
  if (action === "recover-missing" && !switches.has("--confirm-recovery")) fail("RECOVERY_CONFIRMATION_REQUIRED");
  if (action !== "disable" && switches.has("--confirm-copy-deployed")) fail("INVALID_ARGUMENTS");
  if (action !== "recover-missing" && switches.has("--confirm-recovery")) fail("INVALID_ARGUMENTS");

  return {
    action,
    actor,
    reason,
    correlationId,
    confirmTarget: values["--confirm-target"],
  };
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function parseResponse(response) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_RESPONSE_BYTES) {
      fail("INVALID_RESPONSE");
    }
  }

  let text = "";
  try {
    if (!response.body || typeof response.body.getReader !== "function") fail("INVALID_RESPONSE");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytesRead = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail("INVALID_RESPONSE");
      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        fail("INVALID_RESPONSE");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch {
    fail("INVALID_RESPONSE");
  }
}

function createRpcClient({ origin, serviceRoleKey, fetchImpl, requestTimeoutMs }) {
  if (
    typeof serviceRoleKey !== "string"
    || serviceRoleKey.trim() === ""
    || serviceRoleKey.trim() !== serviceRoleKey
  ) {
    fail("MISSING_SERVICE_ROLE_KEY");
  }
  if (typeof fetchImpl !== "function") fail("NETWORK_ERROR");

  async function call(functionName, payload) {
    let response;
    try {
      response = await fetchImpl(`${origin}/rest/v1/rpc/${functionName}`, {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      fail("NETWORK_ERROR");
    }

    // Authorization status is authoritative even if an intermediary returns a
    // malformed or misleading JSON body. In particular, it must never be
    // possible for a 401/403 body containing `P0002` to enter recovery.
    if (response.status === 401 || response.status === 403) {
      fail("AUTHORIZATION_FAILED");
    }

    const body = await parseResponse(response);
    if (!response.ok) {
      const databaseCode = isRecord(body) && Object.hasOwn(body, "code") && typeof body.code === "string"
        ? body.code
        : null;
      // PostgREST maps PostgreSQL's P0* PL/pgSQL error class to HTTP 500.
      // Require both values so a generic 500 or a misleading code at another
      // status cannot enter the intentional recovery path.
      if (response.status === MISSING_ROW_HTTP_STATUS && databaseCode === MISSING_ROW_CODE) {
        fail("FLAG_ROW_MISSING");
      }
      if (databaseCode === "42501") {
        fail("AUTHORIZATION_FAILED");
      }
      fail("RPC_FAILED");
    }
    return body;
  }

  return {
    async read(payload) {
      const result = await call("get_non_edu_trial_credits_enabled", payload);
      if (typeof result !== "boolean") fail("INVALID_RESPONSE");
      return result;
    },
    async set(enabled, payload) {
      const result = await call("set_non_edu_trial_credits_enabled", {
        p_enabled: enabled,
        ...payload,
      });
      if (
        !isRecord(result)
        || !Object.hasOwn(result, "oldValue")
        || !Object.hasOwn(result, "newValue")
        || (result.oldValue !== null && typeof result.oldValue !== "boolean")
        || typeof result.newValue !== "boolean"
      ) {
        fail("INVALID_RESPONSE");
      }
      return result;
    },
  };
}

export async function runFlagOperation({
  args,
  env,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 15_000,
}) {
  const options = parseArguments(args);
  const target = parseSupabaseTarget(env.SUPABASE_URL);
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) fail("INVALID_ARGUMENTS");
  if (env.NEXT_PUBLIC_SUPABASE_URL) {
    const publicTarget = parseSupabaseTarget(env.NEXT_PUBLIC_SUPABASE_URL);
    if (publicTarget.origin !== target.origin) fail("TARGET_ENV_MISMATCH");
  }
  if (target.hosted && options.confirmTarget === undefined) fail("TARGET_CONFIRMATION_REQUIRED");
  if (target.hosted && options.confirmTarget !== target.origin) fail("TARGET_CONFIRMATION_MISMATCH");
  if (!target.hosted && options.confirmTarget !== undefined && options.confirmTarget !== target.origin) {
    fail("TARGET_CONFIRMATION_MISMATCH");
  }

  const rpc = createRpcClient({
    origin: target.origin,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    fetchImpl,
    requestTimeoutMs,
  });
  const auditPayload = {
    p_actor_user_id: options.actor,
    p_reason: options.reason,
    p_correlation_id: options.correlationId,
  };

  if (options.action === "status") {
    const enabled = await rpc.read(auditPayload);
    return {
      action: "status",
      status: "verified",
      enabled,
      correlationId: options.correlationId,
      target: target.origin,
    };
  }

  if (options.action === "recover-missing") {
    try {
      await rpc.read(auditPayload);
      fail("RECOVERY_NOT_NEEDED");
    } catch (error) {
      if (!(error instanceof FlagOperationError) || error.code !== "FLAG_ROW_MISSING") throw error;
    }
    const changed = await rpc.set(true, auditPayload);
    // The setter holds the database advisory lock while observing oldValue.
    // Requiring null prevents a concurrent maintainer from recreating or
    // changing a present row between this command's read and write.
    if (changed.oldValue !== null || changed.newValue !== true) fail("VERIFICATION_MISMATCH");
    const enabled = await rpc.read(auditPayload);
    if (enabled !== true) fail("VERIFICATION_MISMATCH");
    return {
      action: "recover-missing",
      status: "restored",
      enabled: true,
      correlationId: options.correlationId,
      target: target.origin,
    };
  }

  const desired = options.action === "enable";
  const previousEnabled = await rpc.read(auditPayload);
  const changed = await rpc.set(desired, auditPayload);
  if (changed.oldValue !== previousEnabled || changed.newValue !== desired) {
    fail("VERIFICATION_MISMATCH");
  }
  const enabled = await rpc.read(auditPayload);
  if (enabled !== desired) fail("VERIFICATION_MISMATCH");
  return {
    action: options.action,
    status: "verified",
    previousEnabled,
    enabled,
    correlationId: options.correlationId,
    target: target.origin,
  };
}

export function publicErrorCode(error) {
  return error instanceof FlagOperationError ? error.code : "UNEXPECTED_FAILURE";
}
