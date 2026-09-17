import { NextResponse } from "next/server";
import { paymentCall } from "@/lib/payments";
import { safeServerLog } from "@/lib/http-security";
import { readTextBody, RequestBodyError } from "@/lib/request-body";
import { createServiceClient } from "@/lib/supabase/service";
import { createStripeClient, getStripeWebhookConfig } from "@/lib/stripe";
import {
  type CheckoutExpiration,
  checkoutExpirationFromEvent,
  type CheckoutFulfillment,
  checkoutFulfillmentFromEvent,
  StripeEventValidationError,
  type StripeHold,
  stripeHoldFromEvent,
  verifyStripeEvent,
} from "@/lib/stripe-webhook";

export const dynamic = "force-dynamic";
const MAX_STRIPE_WEBHOOK_BYTES = 256 * 1024;

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let config: ReturnType<typeof getStripeWebhookConfig>;
  try {
    config = getStripeWebhookConfig();
  } catch {
    return NextResponse.json({ error: "Webhook unavailable" }, { status: 503 });
  }

  let rawBody: string;
  try {
    rawBody = await readTextBody(request, MAX_STRIPE_WEBHOOK_BYTES);
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return NextResponse.json({ error: "Invalid webhook body" }, { status });
  }
  let event;
  try {
    event = verifyStripeEvent(
      createStripeClient(config.secretKey),
      rawBody,
      signature,
      config.webhookSecret,
    );
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  let fulfillment: CheckoutFulfillment | null;
  let expiration: CheckoutExpiration | null;
  let hold: StripeHold | null;
  try {
    fulfillment = checkoutFulfillmentFromEvent(event);
    expiration = checkoutExpirationFromEvent(event);
    hold = stripeHoldFromEvent(event);
  } catch (error) {
    if (error instanceof StripeEventValidationError) {
      const privileged = createServiceClient();
      if (!privileged) {
        return NextResponse.json({ error: "Webhook unavailable" }, { status: 503 });
      }
      try {
        await paymentCall(privileged.rpc.bind(privileged), "record_rejected_stripe_event", {
          p_event_id: event.id,
          p_event_type: event.type,
          p_livemode: event.livemode,
          p_stripe_created_at: new Date(event.created * 1000).toISOString(),
          p_validation_code: error.code,
        });
        safeServerLog("stripe.webhook", "relevant_event_rejected", {
          eventType: event.type,
          livemode: event.livemode,
          validationCode: error.code,
        });
        return NextResponse.json({ received: true, rejected: true });
      } catch (databaseError) {
        safeServerLog("stripe.webhook", "rejection_record_failed", {
          eventType: event.type,
          livemode: event.livemode,
          errorType: databaseError instanceof Error ? databaseError.name : "unknown",
        });
        return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
      }
    }
    safeServerLog("stripe.webhook", "relevant_event_rejected", {
      eventType: event.type,
      livemode: event.livemode,
      validationCode: "invalid_event",
    });
    return NextResponse.json({ error: "Webhook event requires retry" }, { status: 500 });
  }
  if (!fulfillment && !expiration && !hold) {
    return NextResponse.json({ received: true });
  }
  const privileged = createServiceClient();
  if (!privileged) {
    return NextResponse.json({ error: "Webhook unavailable" }, { status: 503 });
  }
  const rpc = privileged.rpc.bind(privileged);

  try {
    if (fulfillment) {
      await paymentCall(rpc, "fulfill_stripe_checkout_v2", {
        p_event_id: fulfillment.eventId,
        p_purchase_id: fulfillment.purchaseId,
        p_user_id: fulfillment.userId,
        p_checkout_session_id: fulfillment.checkoutSessionId,
        p_payment_intent_id: fulfillment.paymentIntentId,
        p_amount_total: fulfillment.amountTotal,
        p_currency: fulfillment.currency,
        p_livemode: fulfillment.livemode,
        p_stripe_created_at: fulfillment.stripeCreatedAt,
      });
    } else if (expiration) {
      await paymentCall(rpc, "record_expired_stripe_checkout", {
        p_event_id: expiration.eventId,
        p_purchase_id: expiration.purchaseId,
        p_user_id: expiration.userId,
        p_checkout_session_id: expiration.checkoutSessionId,
        p_livemode: expiration.livemode,
        p_stripe_created_at: expiration.stripeCreatedAt,
      });
    } else if (hold) {
      await paymentCall(rpc, "record_stripe_account_hold", {
        p_event_id: hold.eventId,
        p_event_type: hold.eventType,
        p_payment_intent_id: hold.paymentIntentId,
        p_source_reference: hold.sourceReference,
        p_livemode: hold.livemode,
        p_stripe_created_at: hold.stripeCreatedAt,
      });
    }
  } catch (error) {
    safeServerLog("stripe.webhook", "database_transaction_failed", {
      eventType: event.type,
      livemode: event.livemode,
      errorType: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
