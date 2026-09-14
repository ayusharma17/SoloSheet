// Create or reset the local Playwright account using the Supabase service key.
// Obtain local values with: supabase status -o env
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.PLAYWRIGHT_EMAIL || "playwright@example.edu";
const password = process.env.PLAYWRIGHT_PASSWORD || "local-playwright-password-123";
if (!url || !serviceKey) throw new Error("Set local Supabase URL and service role key first");
const response = await fetch(`${url}/auth/v1/admin/users`, {
  method: "POST",
  headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "content-type": "application/json" },
  body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: "Playwright Test" } }),
});
if (!response.ok && response.status !== 422) throw new Error(`Could not create test user (${response.status})`);
console.log(`Local Playwright account ready: ${email}`);
