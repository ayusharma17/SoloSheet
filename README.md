# SoloSheet
Web app to create cheat sheets that you can bring with you to your exam

## Local testing

Install dependencies and start the local Supabase stack:

```sh
npm ci
npx supabase start
supabase status -o env
```

Put the local values in `.env.local` using these names:

```env
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<local anon key>
SUPABASE_SERVICE_ROLE_KEY=<local service role key>
NEXT_PUBLIC_ENABLE_TEST_AUTH=true
```

Apply the SQL files in the order documented in [the extraction pipeline PRD](PRDS/Extraction_Pipeline_Security_and_Reliability_PRD.md), then create the local Playwright account:

```sh
node scripts/create-playwright-user.mjs
```

Start the app and save an authenticated Playwright session:

```sh
npm run dev -- --hostname 127.0.0.1
node scripts/playwright-auth.mjs
```

Run automated checks:

```sh
npm run lint
./node_modules/.bin/tsc --noEmit --incremental false
node tests/extraction-credits.test.mjs
node tests/extraction-validation.test.cjs
node tests/admin.test.mjs
git diff --check
```

Use `playwright/.auth/user.json` for authenticated browser tests. Keep `.env.local`, auth state, screenshots, and generated PDFs out of version control.

To use hosted Supabase, set the hosted URL, anon key, and server-only service-role key in `.env.local`, set `NEXT_PUBLIC_ENABLE_TEST_AUTH=false`, and restart Next.js. The local test login is restricted to local Supabase URLs.
