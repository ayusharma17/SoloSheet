import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { paymentCall } from "@/lib/payments";
import { createStripeClient, getStripeCheckoutConfig } from "@/lib/stripe";

export const dynamic = "force-dynamic";

export async function POST() {
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

  const purchaseId = randomUUID();
  const rpc = privileged.rpc.bind(privileged);
  try {
    const pending = await paymentCall(rpc, "create_pending_stripe_purchase", {
      p_purchase_id: purchaseId,
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

    const stripe = createStripeClient(config.secretKey);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{ price: config.priceId, quantity: 1 }],
      client_reference_id: user.id,
      customer_email: user.email,
      metadata: { purchase_id: purchaseId },
      success_url: `${config.appUrl}/dashboard?checkout=success`,
      cancel_url: `${config.appUrl}/dashboard?checkout=canceled`,
    }, { idempotencyKey: `solosheet-purchase-${purchaseId}` });

    if (!session.url) throw new Error("Checkout URL unavailable");
    try {
      await paymentCall(rpc, "attach_stripe_checkout_session", {
        p_purchase_id: purchaseId,
        p_user_id: user.id,
        p_checkout_session_id: session.id,
      });
    } catch (error) {
      try { await stripe.checkout.sessions.expire(session.id); } catch { /* best effort */ }
      throw error;
    }
    return NextResponse.json({ url: session.url });
  } catch {
    console.error("[Stripe Checkout] Could not create Checkout Session");
    return NextResponse.json({ error: "Checkout is temporarily unavailable." }, { status: 502 });
  }
}
