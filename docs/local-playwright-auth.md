# Local Playwright authentication

This test login is available only when `NEXT_PUBLIC_ENABLE_TEST_AUTH=true`; it is
compiled out of production deployments. It uses local Supabase email/password
authentication and leaves the Google OAuth flow unchanged.

```sh
supabase start
supabase status -o env > .env.local
printf '\nNEXT_PUBLIC_ENABLE_TEST_AUTH=true\n' >> .env.local
# Export SUPABASE_SERVICE_ROLE_KEY from the local status output, then:
node scripts/create-playwright-user.mjs
npm run dev -- --hostname 127.0.0.1
PLAYWRIGHT_EMAIL=playwright@example.edu \
PLAYWRIGHT_PASSWORD=local-playwright-password-123 \
npx playwright install chromium
node scripts/playwright-auth.mjs
```

The last command opens a visible browser, signs in through the local test form,
and writes `playwright/.auth/user.json` (ignored by git). Tests can load that
state with Playwright's `storageState` option. Never point the account-creation
script at a hosted production Supabase project.
