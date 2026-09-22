# Open-signup local acceptance

This workflow verifies the open-signup and configurable trial-credit release
without using hosted Supabase, Google OAuth, Gemini, Stripe, or real accounts.
It provides local evidence only; it does not prove that hosted migrations or
OAuth settings have been deployed.

## Automated acceptance matrix

`npm run verify:open-signup` runs the focused application/CLI tests and the
complete database suite against the explicitly named, disposable PostgreSQL
container from `README.md`. The database suite covers:

| New verified identity | Flag | Expected profile |
|---|---:|---|
| `.edu` non-admin | On | 1 credit and one `edu_email` trial event |
| `.edu` non-admin | Off | 1 credit and one `edu_email` trial event |
| non-`.edu` non-admin | On | 1 credit and one `non_edu_launch_promotion` event |
| non-`.edu` non-admin | Off | 0 credits and no trial marker/event |
| administrator | On or Off | 0 finite credits; administrator policy unchanged |
| unverified or missing email | Either | no profile or trial |

It also verifies the Phase 15 → 16 → 17 forward-upgrade path, preservation of
existing balances and trial timestamps, missing-setting fail-closed behavior,
audited flag access, concurrent flag/signup ordering, idempotent and concurrent
profile repair, zero-credit extraction denial, and paid fulfillment for an
actual flag-Off non-`.edu` account.

## Browser acceptance against local Supabase

First complete the local setup in `README.md`, apply the full current bootstrap,
and start Next.js with `NEXT_PUBLIC_ENABLE_TEST_AUTH=true`. Use an active,
verified administrator that exists only in the local database and export its
UUID as `PLAYWRIGHT_FLAG_ACTOR`. The administrator can be bootstrapped using the
local database-owner procedure in `docs/admin-operations.md`; never use a hosted
administrator or hosted credentials for this test.

Use a disposable local project exclusively for this run. Do not operate the
trial flag from another shell or run a second browser acceptance process at the
same time. The runner checks the expected value before every change and refuses
to overwrite an unexpected value, but the production RPC is intentionally an
administrative setter rather than a test-only compare-and-swap primitive.

The browser runner is a standalone Node process, so it reads its Supabase URL
and keys from the invoking shell rather than loading Next.js's `.env.local`.
Export the same local-only `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` values reported
by `supabase status -o env`. Also export `PLAYWRIGHT_FLAG_ACTOR`; optionally set
`PLAYWRIGHT_BASE_URL` and `PLAYWRIGHT_PASSWORD` when they differ from the
documented loopback defaults. Do not print the values or mix targets.

Confirm both target origins are loopback without printing any keys, install the
browser once if necessary, then run:

```sh
npx playwright install chromium
npm run test:open-signup:browser
```

The browser runner refuses non-loopback app or Supabase origins. It creates four
unique, verified local Auth users, exercises both email classes under both flag
states, confirms dashboard access and displayed balances, checks that the
flag-Off zero-credit account sees disabled generation and an enabled purchase
call to action, verifies sign-out, and checks the rendered launch-On offer. The
Checkout request is intercepted locally, and unexpected non-loopback browser
HTTP or WebSocket requests are blocked and fail the run. Service workers are
disabled so they cannot bypass that isolation; no Stripe or Gemini request is
made.

The runner validates the original flag response before making any mutation,
deletes its Auth fixtures, and restores the original local flag in a `finally`
block. Those operations intentionally leave append-only local audit events
behind. A concurrent or unexpected flag value is treated as a cleanup failure
instead of being silently overwritten. A cleanup or restoration failure makes
the command fail; inspect the local-only project before running another test:

```sh
npm run --silent trial-flag -- status \
  --actor "$PLAYWRIGHT_FLAG_ACTOR" \
  --reason "Inspect local state after browser acceptance"
```

Do not use this browser runner against a hosted project. Hosted Google OAuth,
hosted RLS/grants, a real Stripe test-mode Checkout, and deployed public copy
remain separate release checks that require explicit authorization.

## Release evidence boundary

Local completion means the implementation and repeatable local suites pass.
Release completion still requires applying Phases 16 and 17 in a non-production
hosted environment, confirming the launch flag is On, running the maintenance
workflow there, and exercising real Google OAuth for `.edu` and non-`.edu` test
identities. Production state must not be inferred from repository files.
