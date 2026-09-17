import Stripe from "stripe";
import { STRIPE_PACKAGE_AMOUNT, STRIPE_PACKAGE_CURRENCY } from "./stripe.ts";

export type CheckoutFulfillment = {
  eventId: string;
  purchaseId: string;
  userId: string;
  checkoutSessionId: string;
  paymentIntentId: string;
  amountTotal: number;
  currency: string;
  livemode: boolean;
  stripeCreatedAt: string;
};

export type StripeHold = {
  eventId: string;
  eventType: "charge.refunded" | "charge.dispute.created" | "charge.dispute.closed";
  paymentIntentId: string;
  sourceReference: string;
  livemode: boolean;
  stripeCreatedAt: string;
};

function objectId(value: string | { id: string } | null): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value.id === "string") return value.id;
  return null;
}

export function verifyStripeEvent(
  stripe: Stripe,
  rawBody: string,
  signature: string,
  webhookSecret: string,
): Stripe.Event {
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}

export function checkoutFulfillmentFromEvent(
  event: Stripe.Event,
): CheckoutFulfillment | null {
  if (event.type !== "checkout.session.completed") return null;
  const session = event.data.object as Stripe.Checkout.Session;
  const purchaseId = session.metadata?.purchase_id;
  const userId = session.client_reference_id;
  const paymentIntentId = objectId(session.payment_intent);
  if (session.payment_status !== "paid" || !purchaseId || !userId || !paymentIntentId ||
      session.amount_total !== STRIPE_PACKAGE_AMOUNT ||
      session.currency?.toLowerCase() !== STRIPE_PACKAGE_CURRENCY) {
    return null;
  }
  return {
    eventId: event.id,
    purchaseId,
    userId,
    checkoutSessionId: session.id,
    paymentIntentId,
    amountTotal: session.amount_total,
    currency: session.currency,
    livemode: event.livemode,
    stripeCreatedAt: new Date(event.created * 1000).toISOString(),
  };
}

export function stripeHoldFromEvent(event: Stripe.Event): StripeHold | null {
  if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    const paymentIntentId = objectId(charge.payment_intent);
    if (!paymentIntentId) return null;
    return {
      eventId: event.id,
      eventType: event.type,
      paymentIntentId,
      sourceReference: charge.id,
      livemode: event.livemode,
      stripeCreatedAt: new Date(event.created * 1000).toISOString(),
    };
  }
  if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed") {
    const dispute = event.data.object as Stripe.Dispute;
    if (event.type === "charge.dispute.closed" && dispute.status !== "lost") return null;
    const paymentIntentId = objectId(dispute.payment_intent);
    if (!paymentIntentId) return null;
    return {
      eventId: event.id,
      eventType: event.type,
      paymentIntentId,
      sourceReference: dispute.id,
      livemode: event.livemode,
      stripeCreatedAt: new Date(event.created * 1000).toISOString(),
    };
  }
  return null;
}
