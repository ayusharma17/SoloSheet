import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { paymentCall } from "@/lib/payments";
import { isSameOriginRequest, safeServerLog, trustedRedirectOrigin } from "@/lib/http-security";
import {
  createStripeClient,
  getStripeCheckoutConfig,
  isExpectedStripePrice,
  isStripeResourceMissing,
} from "@/lib/stripe";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let sameOrigin = false;
  try {
    sameOrigin = isSameOriginRequest(request);
  } catch {
    return NextResponse.json({ error: "Payments are not configured." }, { status: 503 });
  }
  if (!sameOrigin) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user || !user.email_confirmed_at) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let config: ReturnType<typeof getStripeCheckoutConfig>;
  try {
    config = getStripeCheckoutConfig();
  } catch {
    return NextResponse.json({ error: "Payments are not configured." }, { status: 503 });
  }
  const privileged = createServiceClient();
  if (!privileged) {
    return NextResponse.json({ error: "Payments are not configured." }, { status: 503 });
  }

  const rpc = privileged.rpc.bind(privileged);
  try {
    const stripe = createStripeClient(config.secretKey);
    const returnOrigin = trustedRedirectOrigin(request, config.appUrl);
    let configuredPriceValidated = false;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestedPurchaseId = randomUUID();
      const pending = await paymentCall(rpc, "create_pending_stripe_purchase", {
        p_purchase_id: requestedPurchaseId,
        p_user_id: user.id,
        p_price_id: config.priceId,
        p_livemode: config.livemode,
      });
      if (pending.status === "held") {
        return NextResponse.json(
          { error: "This account is under review." },
          { status: 423 },
        );
      }
      if (pending.status === "environment_conflict") {
        return NextResponse.json(
          { error: "Payments are paused while the payment environment is being changed." },
          { status: 409 },
        );
      }

      if (pending.status === "pending_exists") {
        if (!pending.purchaseId || !pending.checkoutSessionId) {
          return NextResponse.json(
            { error: "Checkout is already being prepared. Please retry shortly." },
            { status: 409 },
          );
        }
        let existing;
        try {
          existing = await stripe.checkout.sessions.retrieve(pending.checkoutSessionId);
        } catch (error) {
          if (isStripeResourceMissing(error)) {
            return NextResponse.json(
              { error: "Payments are paused while the Stripe account is being changed." },
              { status: 409 },
            );
          }
          throw error;
        }
        if (existing.client_reference_id !== user.id ||
            existing.metadata?.purchase_id !== pending.purchaseId) {
          throw new Error("Existing Checkout Session identity mismatch");
        }
        if (existing.status === "open" && existing.url) {
          return NextResponse.json({ url: existing.url });
        }
        if (existing.status === "expired") {
          await paymentCall(rpc, "close_pending_stripe_purchase", {
            p_purchase_id: pending.purchaseId,
            p_user_id: user.id,
            p_status: "expired",
          });
          continue;
        }
        return NextResponse.json(
          { error: "A payment is already being confirmed. Refresh your balance shortly." },
          { status: 409 },
        );
      }

      if (pending.status !== "pending" || pending.purchaseId !== requestedPurchaseId) {
        throw new Error("Invalid pending purchase state");
      }

      if (!configuredPriceValidated) {
        let price;
        try {
          price = await stripe.prices.retrieve(config.priceId);
        } catch (error) {
          try {
            await paymentCall(rpc, "close_pending_stripe_purchase", {
              p_purchase_id: requestedPurchaseId,
              p_user_id: user.id,
              p_status: "canceled",
            });
          } catch { /* stale unattached rows also self-terminalize after 10 minutes */ }
          throw error;
        }
        if (!isExpectedStripePrice(price)) {
          await paymentCall(rpc, "close_pending_stripe_purchase", {
            p_purchase_id: requestedPurchaseId,
            p_user_id: user.id,
            p_status: "canceled",
          });
          safeServerLog("stripe.checkout", "invalid_configured_price", {
            livemode: config.livemode,
          });
          return NextResponse.json({ error: "Payments are not configured." }, { status: 503 });
        }
        configuredPriceValidated = true;
      }

      let session: Awaited<ReturnType<typeof stripe.checkout.sessions.create>>;
      try {
        session = await stripe.checkout.sessions.create({
          mode: "payment",
          payment_method_types: ["card"],
          line_items: [{ price: config.priceId, quantity: 1 }],
          client_reference_id: user.id,
          customer_email: user.email,
          metadata: { purchase_id: requestedPurchaseId },
          success_url: `${returnOrigin}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${returnOrigin}/dashboard?checkout=canceled`,
        }, { idempotencyKey: `solosheet-purchase-${requestedPurchaseId}` });
      } catch (error) {
        try {
          await paymentCall(rpc, "close_pending_stripe_purchase", {
            p_purchase_id: requestedPurchaseId,
            p_user_id: user.id,
            p_status: "canceled",
          });
        } catch { /* stale unattached rows also self-terminalize after 10 minutes */ }
        throw error;
      }

      if (!session.url) {
        try { await stripe.checkout.sessions.expire(session.id); } catch { /* best effort */ }
        await paymentCall(rpc, "close_pending_stripe_purchase", {
          p_purchase_id: requestedPurchaseId,
          p_user_id: user.id,
          p_status: "canceled",
        });
        throw new Error("Checkout URL unavailable");
      }

      try {
        const attached = await paymentCall(rpc, "attach_stripe_checkout_session_v2", {
          p_purchase_id: requestedPurchaseId,
          p_user_id: user.id,
          p_checkout_session_id: session.id,
          p_checkout_expires_at: new Date(session.expires_at * 1000).toISOString(),
        });
        if (attached.status !== "pending") {
          try { await stripe.checkout.sessions.expire(session.id); } catch { /* best effort */ }
          return NextResponse.json(
            { error: attached.status === "held"
              ? "This account is under review."
              : "Checkout is no longer available." },
            { status: attached.status === "held" ? 423 : 409 },
          );
        }
      } catch (error) {
        try { await stripe.checkout.sessions.expire(session.id); } catch { /* best effort */ }
        try {
          await paymentCall(rpc, "close_pending_stripe_purchase", {
            p_purchase_id: requestedPurchaseId,
            p_user_id: user.id,
            p_status: "canceled",
          });
        } catch { /* a later webhook remains authoritative */ }
        throw error;
      }
      return NextResponse.json({ url: session.url });
    }

    return NextResponse.json(
      { error: "Checkout is temporarily unavailable. Please retry." },
      { status: 409 },
    );
  } catch (error) {
    safeServerLog("stripe.checkout", "session_creation_failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ error: "Checkout is temporarily unavailable." }, { status: 502 });
  }
}
