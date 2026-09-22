# Database bootstrap and migration safety

The historical `supabase/migration*.sql` files represent the order in which an
existing deployment evolved. Some early phases temporarily expose permissions
that later hardening phases revoke. Applying only a prefix is therefore an
unsafe and unsupported deployment state.

## Fresh database

Regenerate the reviewed bootstrap whenever a source migration changes:

```sh
npm run db:bootstrap:build
git diff --exit-code -- supabase/bootstrap.sql
```

Run the complete `supabase/bootstrap.sql` file as the database owner in one SQL
Editor execution or one `psql` session. It wraps every phase in a single
transaction: any error rolls back the entire application schema instead of
leaving an early, insecure phase active. Do not split the file or remove its
outer `BEGIN`/`COMMIT`.

After bootstrap, run `npm run test:database` against the disposable local
PostgreSQL container described in `README.md`. Before enabling production
traffic, verify the effective policies and grants in the actual hosted project.

## Existing database

Never run `bootstrap.sql` over an existing deployment. Back up the database,
determine the last migration already applied, and apply only later forward
migrations in order. Each transactional phase must finish successfully before
the matching application code is deployed. If a phase fails, keep traffic on
the previous application version, inspect the database state, and restore from
the backup when rollback is not automatic.

The files under `supabase/migrations/` reflect hosted forward-migration history;
their timestamps are not a supported fresh-install path. The generated
bootstrap is the canonical fresh-install artifact.

For an existing database at phase 16, apply these forward migrations in order:

1. `supabase/migrations/20260922143949_phase17_open_signup_trial_flag.sql`
2. `supabase/migrations/20260922144005_phase18_profile_recovery.sql`

Phase 17 must commit before Phase 18, and both must commit before deploying the
open-signup application/callback. Phase 17 defaults the launch flag to On,
replaces the old `.edu` account restriction, and preserves all existing profile
balances and trial timestamps. Phase 18 adds `repair_missing_profile()`. The RPC repairs
only the authenticated caller when its Auth email is verified. It creates a
zero-credit profile with no trial marker, records one privacy-minimized
`profile.repaired` audit event, and leaves existing profiles unchanged. If the
callback cannot confirm repair, it clears only that callback's local session and
fails closed instead of redirecting to the dashboard.

After the application is deployed in a non-production environment, use the
maintainer CLI in `docs/admin-operations.md` to confirm the launch flag is On,
then follow `docs/open-signup-local-acceptance.md`. Repository migration files
and local test results do not establish the hosted project's applied state.
