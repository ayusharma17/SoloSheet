// Call only with the user returned by server-side supabase.auth.getUser().
// ADMIN_EMAILS is server configuration, never user-editable metadata or input.
export function isAdminUser(user: { email?: string; email_confirmed_at?: string }): boolean {
  if (!user.email || !user.email_confirmed_at) return false;

  const adminEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  return adminEmails.includes(user.email.toLowerCase());
}
