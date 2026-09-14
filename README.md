# SoloSheet
Web app to create cheat sheets that you can bring with you to your exam

## Local testing

Install dependencies and start the local Supabase stack:

```sh
npm ci
npx supabase start
supabase status -o env
```

Run `supabase status -o env` and copy the values from its output into `.env.local`.
Use `API_URL` for the URL, `ANON_KEY` for the anon key, and `SERVICE_ROLE_KEY`
for the service-role key:

```env
NEXT_PUBLIC_SUPABASE_URL=<value from API_URL>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<value from ANON_KEY>
SUPABASE_SERVICE_ROLE_KEY=<value from SERVICE_ROLE_KEY>
NEXT_PUBLIC_ENABLE_TEST_AUTH=true
```

Start the local app:

```sh
npm run dev -- --hostname 127.0.0.1
```

Restart Next.js whenever `.env.local` changes. Apply the SQL files once, in the
order documented in [the extraction pipeline PRD](PRDS/Extraction_Pipeline_Security_and_Reliability_PRD.md); repeat this only after resetting the database or creating a new Supabase project.

Run automated checks:

```sh
npm run lint
./node_modules/.bin/tsc --noEmit --incremental false
node tests/extraction-credits.test.mjs
node tests/extraction-validation.test.cjs
node tests/admin.test.mjs
git diff --check
```

To have an agent run the authenticated browser test, ask: `Use the local-testing skill, start the local Supabase and Next.js services, authenticate the local Playwright account, and verify dashboard access, guide modes, overflow reporting, and printed PDF page counts.`

Keep `.env.local`, auth state, screenshots, and generated PDFs out of version control. To use hosted Supabase, set the hosted URL, anon key, and server-only service-role key in `.env.local`, set `NEXT_PUBLIC_ENABLE_TEST_AUTH=false`, and restart Next.js.
