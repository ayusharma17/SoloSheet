import { createClient } from "@supabase/supabase-js";

export type AccountHoldLookup = (userId: string) => Promise<boolean>;

async function lookupActiveHold(userId: string): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Account hold lookup is not configured");

  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client
    .from("account_holds")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  if (error) throw new Error("Account hold lookup failed");
  return data !== null;
}

export async function isAccountHeld(
  userId: string,
  lookup: AccountHoldLookup = lookupActiveHold,
): Promise<boolean> {
  if (!userId) return false;
  return lookup(userId);
}
