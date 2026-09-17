import assert from "node:assert/strict";
import test from "node:test";
import { paymentCall } from "../src/lib/payments.ts";
import { isStripeResourceMissing } from "../src/lib/stripe.ts";

test("payment RPC responses are narrowed and malformed values fail closed", async () => {
  const ok = async () => ({
    data: { status: "fulfilled", purchaseId: "purchase", remainingCredits: 10 },
    error: null,
  });
  assert.deepEqual(await paymentCall(ok, "fulfill", {}), {
    status: "fulfilled",
    purchaseId: "purchase",
    remainingCredits: 10,
  });

  const pending = async () => ({
    data: {
      status: "pending_exists",
      purchaseId: "purchase",
      checkoutSessionId: "cs_test_existing",
      checkoutExpiresAt: null,
    },
    error: null,
  });
  assert.equal((await paymentCall(pending, "pending", {})).checkoutSessionId, "cs_test_existing");

  for (const data of [
    null,
    [],
    {},
    { status: 1 },
    { status: "ok", remainingCredits: -1 },
    { status: "ok", checkoutSessionId: 4 },
    { status: "ok", reconciledEvents: -1 },
    { status: "ok", accountHeld: "yes" },
  ]) {
    const rpc = async () => ({ data, error: null });
    await assert.rejects(paymentCall(rpc, "test", {}), /Payment transaction unavailable|Invalid payment/);
  }
  await assert.rejects(
    paymentCall(async () => ({ data: { status: "ok" }, error: new Error("db") }), "test", {}),
    /Payment transaction unavailable/,
  );
});

test("only Stripe's account-scoped missing-resource error triggers rotation handling", () => {
  assert.equal(isStripeResourceMissing({
    type: "StripeInvalidRequestError",
    code: "resource_missing",
  }), true);
  assert.equal(isStripeResourceMissing({
    type: "StripeAuthenticationError",
    code: "resource_missing",
  }), false);
  assert.equal(isStripeResourceMissing(new Error("resource_missing")), false);
});
