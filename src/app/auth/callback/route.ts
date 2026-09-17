import { createClient } from "@/lib/supabase/server";
import {
  getTrustedAppOrigin,
  internalRedirectPath,
  safeServerLog,
  trustedRedirectOrigin,
} from "@/lib/http-security";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const next = internalRedirectPath(searchParams.get("next"));
  let trustedOrigin: string;
  try {
    trustedOrigin = trustedRedirectOrigin(request, getTrustedAppOrigin());
  } catch {
    safeServerLog("auth.callback", "invalid_server_configuration");
    return NextResponse.json({ error: "Authentication is unavailable." }, { status: 503 });
  }

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(next, trustedOrigin));
    }
    safeServerLog("auth.callback", "code_exchange_failed");
  }

  return NextResponse.redirect(new URL("/login?error=auth", trustedOrigin));
}
