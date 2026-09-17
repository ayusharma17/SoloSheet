# SoloSheet
Web app to create cheat sheets that you can bring with you to your exam

## Local testing

Install dependencies and start the local Supabase stack:

```sh
npm ci
npx supabase start
supabase status -o env
```

Copy `.env.example` to `.env.local`, then replace its placeholders with the
matching local or hosted values. Never mix credentials from different Supabase
targets.

Run `supabase status -o env` and copy the values from its output into `.env.local`.
Use `API_URL` for the URL, `ANON_KEY` for the anon key, and `SERVICE_ROLE_KEY`
for the service-role key:

```env
NEXT_PUBLIC_SUPABASE_URL=<value from API_URL>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<value from ANON_KEY>
SUPABASE_SERVICE_ROLE_KEY=<value from SERVICE_ROLE_KEY>
NEXT_PUBLIC_ENABLE_TEST_AUTH=true
# Required only for local Stripe test-mode integration:
STRIPE_SECRET_KEY=<test-mode secret key>
STRIPE_WEBHOOK_SECRET=<Stripe CLI or test endpoint signing secret>
STRIPE_PRICE_ID=<one-time $3.00 USD Price ID>
APP_URL=http://127.0.0.1:3000
```

Start the local app:

```sh
npm run dev -- --hostname 127.0.0.1
```

Restart Next.js whenever `.env.local` changes. Apply the SQL files once, in the
order documented in [the extraction pipeline PRD](PRDS/Extraction_Pipeline_Security_and_Reliability_PRD.md); repeat this only after resetting the database or creating a new Supabase project.

`npx supabase start` runs the local backend services (Auth, Postgres, Storage, and
REST). `npm run dev` runs only the Next.js frontend/API. Full local integration
testing requires both commands. With local Supabase, Google OAuth is not enabled;
the login page uses the development test account. With hosted Supabase, use the
normal Google login. The automated checks below can run without either service.

Stripe is card-only for the MVP. The configured Price must be a one-time $3.00
USD price for 10 credits. Subscribe the webhook endpoint
`/api/webhooks/stripe` to `checkout.session.completed`,
`checkout.session.expired`, `charge.refunded`, `charge.dispute.created`, and
`charge.dispute.closed`. See
[docs/stripe-payments.md](docs/stripe-payments.md) before test-mode verification.
The Stripe CLI is optional and is needed only to forward sandbox webhooks to a
localhost server; a deployed HTTPS endpoint receives webhooks directly.

Run automated checks. The database suite requires Docker and uses only a fresh,
unpublished disposable PostgreSQL database:

```sh
npm run check
docker run --name solosheet-hardening-db -e POSTGRES_HOST_AUTH_METHOD=trust -d postgres:16
npm run test:database
npm run build
git diff --check
```

See [administrator operations](docs/admin-operations.md) for first-admin
bootstrap, allowlist changes, and hold release. These operations are never
available to browser clients.

To have an agent run the authenticated browser test, ask: `Use the local-testing skill, start the local Supabase and Next.js services, authenticate the local Playwright account, and verify dashboard access, guide modes, overflow reporting, and printed PDF page counts.`

Keep `.env.local`, auth state, screenshots, and generated PDFs out of version control. To use hosted Supabase, set the hosted URL, anon key, and server-only service-role key in `.env.local`, set `NEXT_PUBLIC_ENABLE_TEST_AUTH=false`, and restart Next.js.

## Choosing hosted or local Supabase

Next.js loads `.env.local` before `.env`, so only one Supabase target should be
active at a time. `npm run dev` starts the Next.js app; it does not start or stop
Supabase.

For hosted Supabase, keep the hosted values in `.env.local` (or remove `.env.local`
to use the hosted values already in `.env`), set:

```env
NEXT_PUBLIC_ENABLE_TEST_AUTH=false
```

Then run:

```sh
npm run dev -- --hostname 127.0.0.1
```

The hosted setup uses the normal Google login. It does not require `npx supabase
start`.

For local Supabase, start the local services and restore or create `.env.local`
with the local values:

```sh
npx supabase start
supabase status -o env
mv .env.local.local-backup .env.local  # if you previously saved the local file
npm run dev -- --hostname 127.0.0.1
```

The local setup uses the development test account because Google OAuth is not
enabled by default in the local stack. Apply the SQL phases once per database;
repeat them only after a database reset or when creating a new project.
