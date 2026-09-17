import { createClient } from "@supabase/supabase-js";

export type AdminEmailLookup = (normalizedEmail: string) => Promise<boolean>;

async function lookupAdminEmail(normalizedEmail: string): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Administrator lookup is not configured");

  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client
    .from("admin_whitelist")
    .select("email")
    .eq("email", normalizedEmail)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw new Error("Administrator lookup failed");
  return data !== null;
}

// Call only with the verified user returned by server-side auth.getUser().
export async function isAdminUser(
  user: { email?: string; email_confirmed_at?: string },
  lookup: AdminEmailLookup = lookupAdminEmail,
): Promise<boolean> {
  if (!user.email || !user.email_confirmed_at) return false;
  return lookup(user.email.trim().toLowerCase());
}
