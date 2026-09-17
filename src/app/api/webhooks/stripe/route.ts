import { NextResponse } from "next/server";
import { paymentCall } from "@/lib/payments";
import { createServiceClient } from "@/lib/supabase/service";
import { createStripeClient, getStripeWebhookConfig } from "@/lib/stripe";
import {
  checkoutFulfillmentFromEvent,
  stripeHoldFromEvent,
  verifyStripeEvent,
} from "@/lib/stripe-webhook";

export const dynamic = "force-dynamic";

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

  const rawBody = await request.text();
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

  const fulfillment = checkoutFulfillmentFromEvent(event);
  const hold = stripeHoldFromEvent(event);
  if (!fulfillment && !hold) {
    return NextResponse.json({ received: true });
  }
  const privileged = createServiceClient();
  if (!privileged) {
    return NextResponse.json({ error: "Webhook unavailable" }, { status: 503 });
  }
  const rpc = privileged.rpc.bind(privileged);

  try {
    if (fulfillment) {
      await paymentCall(rpc, "fulfill_stripe_checkout", {
        p_event_id: fulfillment.eventId,
        p_purchase_id: fulfillment.purchaseId,
        p_user_id: fulfillment.userId,
        p_checkout_session_id: fulfillment.checkoutSessionId,
        p_payment_intent_id: fulfillment.paymentIntentId,
        p_price_id: config.priceId,
        p_amount_total: fulfillment.amountTotal,
        p_currency: fulfillment.currency,
        p_livemode: fulfillment.livemode,
        p_stripe_created_at: fulfillment.stripeCreatedAt,
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
  } catch {
    console.error("[Stripe Webhook] Database transaction failed");
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
