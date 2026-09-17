import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import {
  checkoutFulfillmentFromEvent,
  stripeHoldFromEvent,
  verifyStripeEvent,
} from "../src/lib/stripe-webhook.ts";

const stripe = new Stripe("sk_test_local_only");
const secret = "whsec_local_test_secret";

function event(type, object, overrides = {}) {
  return {
    id: overrides.id ?? "evt_test",
    object: "event",
    api_version: null,
    created: 1_700_000_000,
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
  };
}

test("Stripe signature verification uses the exact raw body", () => {
  const raw = JSON.stringify(event("test.event", { id: "object" }));
  const signature = stripe.webhooks.generateTestHeaderString({ payload: raw, secret });
  assert.equal(verifyStripeEvent(stripe, raw, signature, secret).id, "evt_test");
  assert.throws(() => verifyStripeEvent(stripe, `${raw} `, signature, secret));
});

test("only a fully paid fixed-package Checkout event can fulfill", () => {
  const session = {
    id: "cs_test_one",
    object: "checkout.session",
    amount_total: 300,
    client_reference_id: "d0000000-0000-4000-8000-000000000001",
    currency: "usd",
    metadata: { purchase_id: "d1000000-0000-4000-8000-000000000001" },
    payment_intent: "pi_test_one",
    payment_status: "paid",
  };
  const parsed = checkoutFulfillmentFromEvent(event("checkout.session.completed", session));
  assert.equal(parsed?.amountTotal, 300);
  assert.equal(parsed?.paymentIntentId, "pi_test_one");
  assert.equal(checkoutFulfillmentFromEvent(event("checkout.session.completed", { ...session, payment_status: "unpaid" })), null);
  assert.equal(checkoutFulfillmentFromEvent(event("checkout.session.completed", { ...session, amount_total: 301 })), null);
  assert.equal(checkoutFulfillmentFromEvent(event("checkout.session.completed", { ...session, client_reference_id: null })), null);
});

test("refunds and lost disputes become holds while won disputes do not", () => {
  const refund = stripeHoldFromEvent(event("charge.refunded", {
    id: "ch_test",
    object: "charge",
    payment_intent: "pi_test",
  }));
  assert.equal(refund?.eventType, "charge.refunded");
  assert.equal(refund?.sourceReference, "ch_test");

  const dispute = { id: "dp_test", object: "dispute", payment_intent: "pi_test", status: "lost" };
  assert.equal(stripeHoldFromEvent(event("charge.dispute.created", dispute))?.eventType, "charge.dispute.created");
  assert.equal(stripeHoldFromEvent(event("charge.dispute.closed", dispute))?.eventType, "charge.dispute.closed");
  assert.equal(stripeHoldFromEvent(event("charge.dispute.closed", { ...dispute, status: "won" })), null);
});
