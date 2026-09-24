import assert from "node:assert/strict";
import test from "node:test";
import { leaseRenewalDisposition } from "../netlify/functions/_shared/extraction-runtime.ts";

test("an explicit heartbeat rejection is definitive lease loss", () => {
  assert.equal(leaseRenewalDisposition(false, null, 2_000, 1_000), "lost");
  assert.equal(leaseRenewalDisposition(null, null, 2_000, 1_000), "lost");
});

test("heartbeat transport errors remain transient only before the known deadline", () => {
  const rpcError = { message: "connection reset" };
  assert.equal(leaseRenewalDisposition(undefined, rpcError, 2_000, 1_999), "transient_error");
  assert.equal(leaseRenewalDisposition(undefined, rpcError, 2_000, 2_000), "lost");
});

test("a successful heartbeat renews active ownership", () => {
  assert.equal(leaseRenewalDisposition(true, null, 2_000, 3_000), "active");
});
