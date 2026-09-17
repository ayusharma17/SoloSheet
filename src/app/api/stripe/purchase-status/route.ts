import { NextResponse } from "next/server";
import { safeServerLog } from "@/lib/http-security";
import { paymentCall } from "@/lib/payments";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

function response(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get("session_id");
  if (!sessionId || !/^cs_(?:test_|live_)?[A-Za-z0-9_]{8,240}$/.test(sessionId)) {
    return response({ error: "Invalid Checkout Session." }, 400);
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user || !user.email_confirmed_at) {
    return response({ error: "Authentication required." }, 401);
  }

  const privileged = createServiceClient();
  if (!privileged) return response({ error: "Purchase status is unavailable." }, 503);

  try {
    const result = await paymentCall(
      privileged.rpc.bind(privileged),
      "get_stripe_purchase_status",
      { p_user_id: user.id, p_checkout_session_id: sessionId },
    );
    if (result.status === "not_found") {
      return response({ error: "Purchase not found." }, 404);
    }
    if (result.remainingCredits === undefined || result.accountHeld === undefined) {
      throw new Error("Incomplete purchase status");
    }
    return response({
      status: result.status,
      credits: result.remainingCredits,
      accountHeld: result.accountHeld,
    });
  } catch {
    safeServerLog("stripe.purchase_status", "database_lookup_failed");
    return response({ error: "Purchase status is unavailable." }, 503);
  }
}
