import assert from "node:assert/strict";
import test from "node:test";
import {
  getTrustedAppOrigin,
  internalRedirectPath,
  isSameOriginRequest,
  trustedRedirectOrigin,
} from "../src/lib/http-security.ts";
import { readTextBody, RequestBodyError } from "../src/lib/request-body.ts";
import { isExpectedStripePrice } from "../src/lib/stripe.ts";
import { copyResponseCookies } from "../src/lib/response-cookies.ts";

function withEnvironment(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return callback(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("trusted application origin rejects credentials and non-origin paths", () => {
  withEnvironment({ NODE_ENV: "production", APP_URL: "https://solosheet.example" }, () => {
    assert.equal(getTrustedAppOrigin(), "https://solosheet.example");
  });
  for (const value of ["https://user:pass@solosheet.example", "https://solosheet.example/path", "http://solosheet.example"]) {
    withEnvironment({ NODE_ENV: "production", APP_URL: value }, () => assert.throws(getTrustedAppOrigin));
  }
});

test("OAuth next accepts only internal relative paths", () => {
  assert.equal(internalRedirectPath("/dashboard?tab=one"), "/dashboard?tab=one");
  for (const value of ["//evil.example", "https://evil.example", "/\\evil.example", "dashboard"]) {
    assert.equal(internalRedirectPath(value), "/dashboard");
  }
});

test("same-origin POST accepts exact origin and development loopback aliases", () => {
  const same = new Request("https://solosheet.example/api", {
    method: "POST",
    headers: { origin: "https://solosheet.example", "sec-fetch-site": "same-origin" },
  });
  assert.equal(isSameOriginRequest(same, "https://solosheet.example"), true);
  const cross = new Request("https://solosheet.example/api", {
    method: "POST",
    headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  });
  assert.equal(isSameOriginRequest(cross, "https://solosheet.example"), false);
  withEnvironment({ NODE_ENV: "development" }, () => {
    const loopback = new Request("http://127.0.0.1:3000/api", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin" },
    });
    assert.equal(isSameOriginRequest(loopback, "http://localhost:3000"), true);
  });
});

test("development redirects preserve an equivalent loopback cookie host", () => {
  withEnvironment({ NODE_ENV: "development" }, () => {
    const request = new Request("http://127.0.0.1:3000/auth/callback");
    assert.equal(trustedRedirectOrigin(request, "http://localhost:3000"), "http://127.0.0.1:3000");
    assert.equal(trustedRedirectOrigin(
      new Request("http://evil.example:3000/auth/callback"),
      "http://localhost:3000",
    ), "http://localhost:3000");
  });
});

test("proxy redirects preserve refreshed Supabase response cookies", () => {
  const refreshed = {
    name: "sb-refresh-token",
    value: "rotated",
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
  };
  const copied = [];
  copyResponseCookies(
    [refreshed],
    cookie => copied.push(cookie),
  );
  assert.deepEqual(copied, [refreshed]);
});

test("bounded request reader rejects declared and streamed overflow", async () => {
  await assert.rejects(
    readTextBody(new Request("https://example.test", {
      method: "POST",
      headers: { "content-length": "100" },
      body: "small",
    }), 10),
    error => error instanceof RequestBodyError && error.status === 413,
  );
  await assert.rejects(
    readTextBody(new Request("https://example.test", { method: "POST", body: "eleven bytes" }), 10),
    error => error instanceof RequestBodyError && error.status === 413,
  );
  assert.equal(await readTextBody(new Request("https://example.test", { method: "POST", body: "safe" }), 10), "safe");
});

test("Stripe package validation requires active one-time $3 USD price", () => {
  const price = { active: true, type: "one_time", unit_amount: 300, currency: "usd" };
  assert.equal(isExpectedStripePrice(price), true);
  assert.equal(isExpectedStripePrice({ ...price, active: false }), false);
  assert.equal(isExpectedStripePrice({ ...price, type: "recurring" }), false);
  assert.equal(isExpectedStripePrice({ ...price, unit_amount: 301 }), false);
  assert.equal(isExpectedStripePrice({ ...price, currency: "cad" }), false);
});
