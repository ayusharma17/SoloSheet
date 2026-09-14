---
name: local-testing
description: "Run and document safe local Supabase, Next.js, Playwright, API, and print verification for SoloSheet. Use for local QA; never infer permission to test hosted production data."
---

# SoloSheet local testing

Use this skill when validating SoloSheet changes on a developer machine. Keep all
data local and do not call hosted Supabase, Gemini, payment providers, or real
student accounts unless the user explicitly authorizes that separate operation.

## Environment setup

1. Inspect `git status`, `.env.local`, `supabase/config.toml`, and the repository
   `AGENTS.md`. Never print environment values, tokens, signed URLs, or storage
   paths containing secrets.
2. Start local Supabase with `npx supabase start`. If Docker registry limits or
   network failures occur, report them and do not switch to hosted services.
3. Run `supabase status -o env` and map local values into `.env.local`:
   `API_URL` → `NEXT_PUBLIC_SUPABASE_URL`, `ANON_KEY` →
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SERVICE_ROLE_KEY` →
   `SUPABASE_SERVICE_ROLE_KEY`.
4. Enable the development-only login with
   `NEXT_PUBLIC_ENABLE_TEST_AUTH=true`. It is effective only in development.
5. Apply the SQL phases in the order documented by
   `PRDS/Extraction_Pipeline_Security_and_Reliability_PRD.md`. Confirm the target
   database is local before applying mutations.
6. Create/reset the test account with
   `node scripts/create-playwright-user.mjs`.

## Automated checks

Run the repository's available checks:

```sh
npm run lint
./node_modules/.bin/tsc --noEmit --incremental false
node tests/extraction-credits.test.mjs
node tests/extraction-validation.test.cjs
node tests/admin.test.mjs
git diff --check
```

For credit changes, run the SQL assertions under `supabase/tests/` only against
the disposable local database. Use the local regression runner when Docker and
its PostgreSQL image are available; it must never receive a hosted URL.

## Playwright workflow

Start Next on loopback with `npm run dev -- --hostname 127.0.0.1`. Create a saved
local session with `node scripts/playwright-auth.mjs`; this opens a visible
Chromium window, signs in through the development-only form, and writes the
ignored `playwright/.auth/user.json` state.

Use that state for authenticated tests. Cover dashboard access, upload form
validation, extraction retry messaging, and the cheat-sheet page. For typesetting,
use a dense local fixture and verify:

- the preview reaches a stable fit/overflow status;
- guide-off/separate mode appends one guide page;
- guide-in-pages mode keeps the requested sheet page count;
- dropped items and oversized blocks are reported;
- `page.pdf({ format: "Letter", printBackground: true })` has the expected count.

Never treat a redirect to `/login` as a successful authenticated test. Refresh the
storage state after restarting Supabase or Next.

## Failure handling

- A stale `.next/dev/lock` may be removed only after checking that no intended
  Next process owns port 3000; restart Next after clearing generated `.next` data.
- If Google OAuth says the automated browser is not secure, use the local test
  login. Do not bypass Google or reuse personal browser profiles.
- Preserve uploads for ambiguous extraction failures and reuse the same request ID;
  use a new ID only when the API explicitly returns
  `EXTRACTION_RESTART_REQUIRED`.
- Report build failures caused by unavailable Google Fonts separately from code
  failures.

## Evidence and reporting

Report commands and outcomes, distinguishing static tests, local service tests,
and browser tests. Do not claim hosted RLS, deployed migrations, live extraction,
or printed output was verified unless it was actually checked. Keep generated
screenshots and PDFs in temporary directories unless the user requests artifacts.
