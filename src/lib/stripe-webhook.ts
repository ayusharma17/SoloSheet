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

export type CheckoutExpiration = {
  eventId: string;
  purchaseId: string;
  userId: string;
  checkoutSessionId: string;
  livemode: boolean;
  stripeCreatedAt: string;
};

export class StripeEventValidationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Stripe event validation failed");
    this.name = "StripeEventValidationError";
    this.code = code;
  }
}

function objectId(value: string | { id: string } | null): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value.id === "string") return value.id;
  return null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
  if (session.payment_status !== "paid") return null;
  if (!purchaseId || !userId || !paymentIntentId ||
      !isUuid(purchaseId) || !isUuid(userId)) {
    throw new StripeEventValidationError("paid_session_identity_missing");
  }
  if (session.amount_total !== STRIPE_PACKAGE_AMOUNT ||
      session.currency?.toLowerCase() !== STRIPE_PACKAGE_CURRENCY) {
    throw new StripeEventValidationError("paid_session_package_mismatch");
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

export function checkoutExpirationFromEvent(event: Stripe.Event): CheckoutExpiration | null {
  if (event.type !== "checkout.session.expired") return null;
  const session = event.data.object as Stripe.Checkout.Session;
  const purchaseId = session.metadata?.purchase_id;
  const userId = session.client_reference_id;
  if (!purchaseId || !userId || !session.id ||
      !isUuid(purchaseId) || !isUuid(userId)) {
    throw new StripeEventValidationError("expired_session_identity_missing");
  }
  return {
    eventId: event.id,
    purchaseId,
    userId,
    checkoutSessionId: session.id,
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
