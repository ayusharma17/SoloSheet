# SoloSheet Reliability and Security Hardening PRD

**Status:** Implemented and locally verified where services were available  
**Date:** 2026-09-13  
**Owners:** SoloSheet engineering

## Executive summary

SoloSheet converts private lecture uploads into printable exam cheat sheets. This
hardening effort closes five reliability and security gaps in the extraction
pipeline: credit authorization, concurrent credit spending, file validation,
upload retries, and page-fit/print consistency.

The implementation keeps provider calls and administrative operations server-only,
binds uploaded objects to the authenticated user, and gives every extraction a
durable request identity. It also makes the browser preview and printed PDF use
the same measured page model.

## Problem statement

The original flow trusted client-provided credit and file metadata, deducted a
credit after provider work, and used different layout paths for screen and print.
Concurrent requests could therefore spend one credit more than once, malformed or
foreign storage URLs could reach the server, failed uploads could strand objects,
and the preview could disagree with the printed page count.

## Goals and success criteria

- Ordinary clients cannot grant credits, change another balance, or enroll an
  administrator.
- At most one extraction reservation succeeds for concurrent requests when one
  credit is available.
- Retrying a lost response does not invoke the provider or charge twice.
- Storage URLs, paths, MIME declarations, signatures, redirects, and actual bytes
  are validated before extraction.
- Partial uploads and failed extraction attempts can be retried or cleaned up.
- Preview and print agree on page geometry, guide accounting, overflow, and page
  limits.

## Users and operational personas

**Student:** uploads lecture files, requests a sheet, retries after a network
failure, and prints the result.

**Administrator:** manages the service through server-side configuration and
privileged payment or maintenance operations.

**Developer/QA:** runs local Supabase and Playwright fixtures without contacting
hosted services or using real student data.

## User stories and acceptance criteria

### Credit and admin security

As a student, I want my balance protected so browser calls cannot mint credits or
edit another account.

- Profile and admin-whitelist writes are unavailable to `anon` and `authenticated`.
- Credit mutation RPCs require `service_role`, positive amounts, and a valid user.
- Security-definer functions use an empty/fixed search path.
- The course-material storage bucket remains private.

### Atomic extraction

As a student, I want concurrent clicks to produce at most one sheet per credit.

- Reservation locks the user balance in PostgreSQL.
- A UUID request ID and request fingerprint make retries idempotent.
- Provider or save failure refunds an active reservation exactly once.
- A completed request returns its existing material instead of generating again.
- Stale processing reservations are recovered and late completions are rejected.

### File validation

As a student, I want only my uploaded files processed.

- Request JSON is bounded and structurally narrowed at runtime.
- Signed URLs use the exact configured storage origin and owned path.
- Names, extensions, declared MIME types, and file counts/sizes are bounded.
- Redirects are rejected and response bytes are streamed under per-file and total
  limits.
- PDF/image magic bytes and response metadata must match the declaration.

### Upload retry and cleanup

As a student, I want a failed upload or network response to be recoverable.

- Partial batches are removed through the Storage API when safe.
- Ambiguous extraction failures preserve files and reuse the same request ID.
- Terminal failures signal when a new request ID is required.
- Signed URLs are refreshed for retries; cleanup paths never persist signed URLs.
- Failed cleanup is retained in a local journal for a later owned cleanup attempt.

### Page fitting and printing

As a student, I want the PDF I print to match the preview and requested limit.

- Fixed Letter page wrappers and measured block pagination are shared by preview and
  print.
- The guide is a separate appended page by default and consumes the limit when
  included.
- Oversized blocks and dropped low-priority items are reported accurately.
- Empty content does not create a phantom page.

## Technical design

### Database migrations

Apply these in order, as the local database owner/service role, after backing up
any non-disposable database:

1. `supabase/migration.sql`
2. `supabase/migration_phase2.sql`
3. `supabase/migration_phase4.sql`
4. `supabase/migration_phase5_anti_abuse.sql`
5. `supabase/migration_storage_setup.sql`
6. `supabase/migration_phase6_credit_security.sql`
7. `supabase/migration_phase7_atomic_extraction.sql`
8. `supabase/migration_phase8_retire_device_fingerprinting.sql`
9. `supabase/migration_phase9_anti_abuse_foundation.sql`
10. `supabase/migration_phase10_identity_and_trial.sql`
11. `supabase/migration_phase11_extraction_access.sql`
12. `supabase/migration_phase12_stripe_payments.sql`
13. `supabase/migration_phase13_payment_and_admin_hardening.sql`
14. `supabase/migration_phase14_storage_abuse_controls.sql`

Phase 6 secures legacy credit functions and access policies. Phase 7 adds the
durable `extraction_requests` reservation protocol. Phase 8 retires device
fingerprinting, and phase 9 adds the private administrator, audit, account-hold,
and Stripe ledger foundation. Phase 10 makes that administrator source canonical,
enforces verified educational-email eligibility, and grants the one-time trial.
Phase 11 resolves administrator bypass and account holds inside the atomic
extraction transaction. SQL files describe intended deployment; successful local
execution does not prove hosted deployment. Phase 12 adds pending purchase,
idempotent Stripe fulfillment, and refund/dispute hold transactions. Phase 13
adds recoverable payment lifecycle states, out-of-order event reconciliation,
current-identity administrator checks, and audited hold release. Phase 14 adds
reservation-backed exact owned Storage paths plus per-user object-count and
aggregate-byte quotas without writing Storage metadata directly. The quota
values live in the protected `public.course_material_upload_limits` row created
by the Storage setup migration; phase 14 reads that configuration instead of
embedding product-policy values in reservation functions.
Phase 14 intentionally fails if existing Storage metadata cannot be safely
backfilled; inspect and clean incompatible objects through the Storage API first.

### Server and client boundaries

`src/app/api/extract/route.ts` authenticates the user, parses validated requests,
uses a server-only service-role client for credit RPCs, downloads owned files, calls
Gemini, finalizes the material, and performs owned Storage API cleanup.

`src/lib/extraction-validation.ts`, `src/lib/extraction-credits.ts`, and
`src/lib/upload-lifecycle.ts` contain the reusable validation, idempotency, and
retry contracts. `src/lib/typesetting/paginate.ts` drives deterministic layout
measurement.

## Local QA workflow

The development-only test login is enabled only when both `NODE_ENV=development`
and `NEXT_PUBLIC_ENABLE_TEST_AUTH=true`. Local setup and Playwright session creation
are documented in [local-playwright-auth.md](../docs/local-playwright-auth.md).

The Playwright run used a dense 120-item local fixture and verified:

- authenticated dashboard access;
- sheet preview and fit status;
- guide toggle to “In pages”;
- two-page PDF when the guide is included;
- three-page PDF when the guide is separate by default.

Focused automated checks also cover malformed credit responses, provider/save
failure settlement, ownership and URL validation, streamed byte limits, magic-byte
checks, and admin access.

## Scope

**In scope:** the five hardening areas, forward SQL migrations, local test setup,
retry contracts, and verification documentation.

**Originally out of scope for phases 1-7:** payment-provider implementation and
the canonical administrator/payment policy. Those are now specified by
`Anti-Abuse_PRD.md` and implemented by later forward migrations. Hosted migration
execution and live Gemini extraction tests remain separate deployment checks.

## Risks and mitigations

- **Migration ordering or partial deployment:** apply one phase at a time and run
  the SQL regression assertions before enabling the matching route.
- **Missing service-role configuration:** extraction fails closed with a 503 rather
  than falling back to a client-controlled balance update.
- **Stale reservations:** the database recovers processing rows older than the
  configured timeout and prevents late completion.
- **Browser/provider differences in print:** keep the fixed page model and verify
  generated PDF page counts with Playwright.
- **Local credentials leaking into source control:** `.env*`, Playwright auth state,
  and browser profiles are ignored; never commit their contents.

## Dependencies and assumptions

- Supabase Auth, Postgres, Storage, and RLS are available in the target environment.
- `SUPABASE_SERVICE_ROLE_KEY` is configured only on the server.
- The `course-materials` bucket is private and uses paths beginning with the user ID.
- Local Docker can pull the Supabase images and the machine has Playwright Chromium.

## Verification record

- ESLint: passed.
- Strict TypeScript check: passed.
- Focused credit, validation, and admin tests: passed.
- Authenticated Playwright dashboard and print smoke tests: passed locally.
- Production build: blocked by unavailable Google Fonts network access in the test
  environment.
- Disposable PostgreSQL migration runner: added, but hosted/deployed behavior was
  not claimed or verified.

## Open questions

- Should the production deployment pipeline apply phase 6 and phase 7 automatically
  or require an operator approval step?
- What retention period and scheduled job should remove failed upload journal entries
  and old Storage objects?
- Should a dedicated test Supabase project replace local Docker for CI browser tests?
