// Local-only browser acceptance for the open-signup/trial-credit release.
// Prerequisites and the intentionally isolated flag toggles are documented in
// docs/open-signup-local-acceptance.md. This script refuses hosted targets.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const actor = process.env.PLAYWRIGHT_FLAG_ACTOR;
const baseUrl = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3000";
const password = process.env.PLAYWRIGHT_PASSWORD || "local-open-signup-test-123";
const localDbContainer = process.env.PLAYWRIGHT_LOCAL_DB_CONTAINER || "supabase_db_solosheet-local";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requestTimeoutMs = 15_000;
const maxResponseBytes = 1024 * 1024;

function localOrigin(value, label) {
  if (!value) throw new Error(`${label} is required`);
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (!loopback || url.username || url.password ||
      !["http:", "https:"].includes(url.protocol) ||
      (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error(`${label} must be a loopback origin`);
  }
  return url.origin;
}

const supabaseOrigin = localOrigin(supabaseUrl, "NEXT_PUBLIC_SUPABASE_URL");
const appOrigin = localOrigin(baseUrl, "PLAYWRIGHT_BASE_URL");
if (!serviceKey || serviceKey.trim() !== serviceKey ||
    !anonKey || anonKey.trim() !== anonKey) {
  throw new Error("Local Supabase anon and service-role keys are required without surrounding whitespace");
}
if (!uuidPattern.test(actor ?? "")) throw new Error("PLAYWRIGHT_FLAG_ACTOR must be a local active administrator UUID");
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(localDbContainer)) {
  throw new Error("PLAYWRIGHT_LOCAL_DB_CONTAINER must be a simple local Docker container name");
}

const serviceHeaders = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  "content-type": "application/json",
};

async function jsonRequest(path, options = {}, onCommitted) {
  const response = await fetch(`${supabaseOrigin}${path}`, {
    ...options,
    headers: { ...serviceHeaders, ...options.headers },
    redirect: "error",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  // Mutating PostgREST/Auth requests have committed once a 2xx response is
  // received, even if their response body is subsequently truncated or
  // malformed. Let callers record that fact before response parsing so their
  // cleanup logic does not reason from stale state.
  if (response.ok) onCommitted?.();
  const contentLength = response.headers.get("content-length");
  const declaredLength = contentLength === null ? null : Number(contentLength);
  if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    throw new Error(`Local Supabase response was too large (${response.status})`);
  }
  let text = "";
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytesRead = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxResponseBytes) {
        await reader.cancel();
        throw new Error(`Local Supabase response was too large (${response.status})`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); }
    catch { throw new Error(`Local Supabase returned malformed JSON (${response.status})`); }
  }
  if (!response.ok) throw new Error(`Local Supabase request failed (${response.status})`);
  return payload;
}

async function readFlag(reason) {
  const result = await jsonRequest("/rest/v1/rpc/get_non_edu_trial_credits_enabled", {
    method: "POST",
    body: JSON.stringify({
      p_actor_user_id: actor,
      p_reason: reason,
      p_correlation_id: randomUUID(),
    }),
  });
  if (typeof result !== "boolean") {
    throw new Error("Local feature-flag read returned an invalid response");
  }
  return result;
}

async function setFlag(enabled, expectedCurrent) {
  const observedCurrent = await readFlag("Verify isolated loopback browser acceptance ownership");
  if (observedCurrent !== expectedCurrent) {
    throw new Error("Local trial flag changed outside this acceptance run; refusing to overwrite it");
  }
  const result = await jsonRequest("/rest/v1/rpc/set_non_edu_trial_credits_enabled", {
    method: "POST",
    body: JSON.stringify({
      p_enabled: enabled,
      p_actor_user_id: actor,
      p_reason: "Isolated loopback browser acceptance; state restored after run",
      p_correlation_id: randomUUID(),
    }),
  }, () => {
    expectedFlag = enabled;
  });
  if (result === null || typeof result !== "object" || Array.isArray(result) ||
      typeof result.oldValue !== "boolean" || typeof result.newValue !== "boolean") {
    throw new Error("Local feature-flag change returned an invalid response");
  }
  assert.equal(result.oldValue, expectedCurrent, "Feature flag changed concurrently during acceptance setup");
  assert.equal(result.newValue, enabled);
  assert.equal(await readFlag("Verify isolated loopback browser acceptance state"), enabled);
}

async function createUser(email) {
  const result = await jsonRequest("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "Open Signup Acceptance" },
    }),
  });
  if (!uuidPattern.test(result?.id ?? "")) throw new Error("Local Auth did not return a user UUID");
  return result.id;
}

async function deleteUser(id) {
  await jsonRequest(`/auth/v1/admin/users/${id}`, { method: "DELETE" });
}

async function readProfile(id) {
  const result = await jsonRequest(`/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=id,email,credits,trial_granted_at`);
  if (!Array.isArray(result) || result.length > 1) throw new Error("Local profile lookup returned an invalid response");
  return result[0] ?? null;
}

async function assertProfile(id, scenario) {
  const profile = await readProfile(id);
  assert.ok(profile, "Verified local Auth user must have a profile");
  assert.equal(profile.id, id);
  assert.equal(profile.email, scenario.email);
  assert.equal(profile.credits, scenario.credits);
  assert.equal(profile.trial_granted_at === null, scenario.credits === 0);
}

function removeProfileForRecovery(id) {
  // Simulate a historical signup failure through the local database owner. The
  // production repair RPC itself remains self-scoped and browser-callable.
  const result = spawnSync("docker", [
    "exec", localDbContainer,
    "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres",
    "-c", `DELETE FROM public.profiles WHERE id = '${id}'::uuid`,
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Could not prepare the local missing-profile recovery fixture");
}

async function repairProfile(email) {
  const session = await jsonRequest("/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    body: JSON.stringify({ email, password }),
  });
  if (typeof session?.access_token !== "string" || session.access_token === "") {
    throw new Error("Local password sign-in did not return an access token");
  }
  const result = await jsonRequest("/rest/v1/rpc/repair_missing_profile", {
    method: "POST",
    headers: { apikey: anonKey, Authorization: `Bearer ${session.access_token}` },
    body: "{}",
  });
  assert.deepEqual(result, { status: "repaired" });
}

let blockedRemoteRequestCount = 0;

async function createLocalContext(browser) {
  // Blocking service workers keeps every browser-originated network request
  // observable by the HTTP/WebSocket routes below.
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) &&
        url.origin !== appOrigin && url.origin !== supabaseOrigin) {
      blockedRemoteRequestCount += 1;
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await context.routeWebSocket("**/*", async webSocket => {
    const url = new URL(webSocket.url());
    const allowedHosts = new Set([
      new URL(appOrigin).host,
      new URL(supabaseOrigin).host,
    ]);
    if (!["ws:", "wss:"].includes(url.protocol) || !allowedHosts.has(url.host)) {
      blockedRemoteRequestCount += 1;
      await webSocket.close({ code: 1008, reason: "Non-loopback network request blocked" });
      return;
    }
    await webSocket.connectToServer();
  });
  return context;
}

async function verifyDashboard(browser, scenario) {
  const context = await createLocalContext(browser);
  const page = await context.newPage();
  async function signInAndAssertDashboard() {
    await page.goto(`${appOrigin}/login`);
    await page.getByLabel("Email").fill(scenario.email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: /sign in to local test account/i }).click();
    await page.waitForURL("**/dashboard");
    await page.getByRole("heading", { name: /welcome/i }).waitFor();
    await page.getByText(new RegExp(`^${scenario.credits} credits$`, "i")).first().waitFor();
  }
  try {
    await signInAndAssertDashboard();

    const upload = page.getByRole("button", {
      name: scenario.credits === 0 ? /upload & generate/i : /initiate upload/i,
    });
    if (scenario.credits === 0) {
      assert.equal(await upload.isDisabled(), true);
      await page.getByText(/your account is active\. add credits/i).waitFor();
      const checkout = page.getByRole("button", { name: /add 10 credits/i });
      await checkout.waitFor();
      let checkoutRequests = 0;
      await page.route("**/api/stripe/checkout", async route => {
        checkoutRequests += 1;
        assert.equal(route.request().method(), "POST");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ url: `${appOrigin}/dashboard?checkout=canceled` }),
        });
      });
      await checkout.click();
      await page.waitForURL("**/dashboard?checkout=canceled");
      assert.equal(checkoutRequests, 1);
      await page.getByText(/checkout canceled/i).waitFor();
    } else {
      assert.equal(await upload.isEnabled(), true);
    }

    await page.getByRole("button", { name: /sign out/i }).click();
    await page.waitForURL("**/login");
    await signInAndAssertDashboard();
    await page.getByRole("button", { name: /sign out/i }).click();
    await page.waitForURL("**/login");
  } finally {
    await context.close();
  }
}

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const scenarios = [
  { enabled: true, email: `task5-on-edu-${suffix}@school.edu`, credits: 1 },
  { enabled: true, email: `task5-on-non-edu-${suffix}@example.com`, credits: 1 },
  { enabled: false, email: `task5-off-edu-${suffix}@school.edu`, credits: 1 },
  { enabled: false, email: `task5-off-non-edu-${suffix}@example.com`, credits: 0 },
];
const createdUserIds = [];
let originalFlag;
let expectedFlag;
let browser;
let operationError;
const cleanupErrors = [];

try {
  browser = await chromium.launch({ headless: true });
  const preflightContext = await createLocalContext(browser);
  const publicPage = await preflightContext.newPage();
  await publicPage.goto(appOrigin);
  await publicPage.getByText(/1 free credit for every new account/i).waitFor();
  const loginPage = await preflightContext.newPage();
  await loginPage.goto(`${appOrigin}/login`);
  await loginPage.getByRole("button", { name: /sign in to local test account/i }).waitFor();
  await preflightContext.close();

  originalFlag = await readFlag("Capture state before isolated loopback browser acceptance");
  expectedFlag = originalFlag;

  for (const scenario of scenarios) {
    await setFlag(scenario.enabled, expectedFlag);
    const userId = await createUser(scenario.email);
    createdUserIds.push(userId);
    await assertProfile(userId, scenario);
    await verifyDashboard(browser, scenario);
    console.log(`PASS ${scenario.enabled ? "On" : "Off"} ${scenario.email.endsWith(".edu") ? ".edu" : "non-.edu"}: profile, ${scenario.credits} credit(s), logout, repeat login`);
  }

  await setFlag(false, expectedFlag);
  const recoveryScenario = { email: `task5-recovery-${suffix}@example.com`, credits: 0 };
  const recoveryUserId = await createUser(recoveryScenario.email);
  createdUserIds.push(recoveryUserId);
  await assertProfile(recoveryUserId, recoveryScenario);
  removeProfileForRecovery(recoveryUserId);
  assert.equal(await readProfile(recoveryUserId), null);
  await repairProfile(recoveryScenario.email);
  await assertProfile(recoveryUserId, recoveryScenario);
  await verifyDashboard(browser, recoveryScenario);
  console.log("PASS missing-profile recovery: repaired at zero credits, dashboard, logout, repeat login");
  assert.equal(blockedRemoteRequestCount, 0, "Browser acceptance attempted a non-loopback request");
  console.log("Local browser acceptance passed; Stripe Checkout was route-isolated and Gemini was not called");
} catch (error) {
  operationError = error;
} finally {
  if (browser) await browser.close();
  for (const id of createdUserIds.reverse()) {
    try { await deleteUser(id); }
    catch { cleanupErrors.push(new Error("Could not clean up a local test user")); }
  }
  if (typeof originalFlag === "boolean") {
    try {
      await setFlag(originalFlag, expectedFlag);
    }
    catch { cleanupErrors.push(new Error("Could not restore the local trial flag; inspect it before further testing")); }
  }
}

if (operationError && cleanupErrors.length > 0) {
  throw new AggregateError([operationError, ...cleanupErrors], "Browser acceptance and cleanup both failed");
}
if (operationError) throw operationError;
if (cleanupErrors.length > 0) {
  throw new AggregateError(cleanupErrors, "Browser acceptance cleanup failed");
}
