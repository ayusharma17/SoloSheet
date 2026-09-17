---
name: local-testing
description: "Run and document safe local Supabase, Next.js, Playwright, API, and print verification for SoloSheet. Use for local QA; never infer permission to test hosted production data."
---

# SoloSheet local testing

Use this skill when validating SoloSheet changes on a developer machine. Keep all
data local and do not call hosted Supabase, Gemini, payment providers, or real
student accounts unless the user explicitly authorizes that separate operation.

## Choose the Supabase target first

Next.js loads `.env.local` before `.env`. Inspect both filenames without printing
values and choose one target before starting the app:

- **Hosted mode:** keep hosted URL, anon key, and service-role key in `.env.local`,
  set `NEXT_PUBLIC_ENABLE_TEST_AUTH=false`, and run only `npm run dev`.
- **Local mode:** run `npx supabase start`, map `API_URL`, `ANON_KEY`, and
  `SERVICE_ROLE_KEY` from `supabase status -o env` into `.env.local`, set
  `NEXT_PUBLIC_ENABLE_TEST_AUTH=true`, and run both Supabase and Next.js.

Never mix local Supabase keys with a hosted URL. Save the inactive env file under a
clear name such as `.env.local.local-backup`; restart Next.js after switching.

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
5. For a fresh local database, regenerate and apply `supabase/bootstrap.sql` as
   one transaction following `docs/database-bootstrap.md`. Never stop after an
   early historical phase. Confirm the target database is local before applying
   mutations; for an existing database, apply only reviewed, unapplied forward
   migrations.
6. Create/reset the test account with
   `node scripts/create-playwright-user.mjs`.

## Automated checks

Run the repository's available checks:

```sh
npm run check
npm run build
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
