import { createClient } from "@/lib/supabase/server";
import {
  getTrustedAppOrigin,
  internalRedirectPath,
  safeServerLog,
  trustedRedirectOrigin,
} from "@/lib/http-security";
import {
  completeAuthCallback,
} from "@/lib/auth-profile-recovery";
import { authErrorCodeFromCallback } from "@/lib/auth-ui";
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
    const outcome = await completeAuthCallback({
      exchangeCode: async () => {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        return error === null;
      },
      getUser: async () => {
        const { data: { user }, error } = await supabase.auth.getUser();
        return { user, failed: error !== null };
      },
      repairProfile: async () => {
        const { data, error } = await supabase.rpc("repair_missing_profile");
        return { result: data, failed: error !== null };
      },
      clearLocalSession: async () => {
        const { error } = await supabase.auth.signOut({ scope: "local" });
        return error === null;
      },
    });

    if (outcome === "complete") {
      return NextResponse.redirect(new URL(next, trustedOrigin));
    }
    safeServerLog("auth.callback", outcome);
    if (outcome === "cleanup_failed") {
      return NextResponse.json({ error: "Authentication is unavailable." }, { status: 503 });
    }
    return NextResponse.redirect(new URL(`/login?error=${authErrorCodeFromCallback(outcome)}`, trustedOrigin));
  }

  return NextResponse.redirect(new URL("/login?error=oauth", trustedOrigin));
}
