# TODO

- [ ] Remove “Powered by Gemini” tags from the website.
- [ ] Add a dedicated SoloSheet icon for the website branding and favicon.
- [ ] Replace the raw Supabase project hostname shown in Google sign-in with professional SoloSheet branding. Configure the Supabase custom auth domain and OAuth consent-screen/app name where supported, then verify the full redirect and consent flow in production.

Backlog from the project overview and [project review](PROJECT_REVIEW.md). Priorities indicate suggested implementation order. Unchecked items are pending; deployed database configuration still needs verification.

## P0 — Security and credit correctness

- [ ] Audit deployed Supabase migrations, RLS policies, and function grants using anonymous and ordinary authenticated test accounts.
- [x] Restrict `add_credits` to authorized server operations, validate positive amounts, and prevent `decrement_credits` from targeting another user.
- [x] Secure `admin_whitelist` and set fixed search paths with schema-qualified relations for privileged SQL functions.
- [x] Replace storage hostname substring checks with authenticated, owned object paths; enforce the configured project and bucket. If URLs remain, validate exact HTTPS origin and redirects.
- [x] Validate extraction request bodies at runtime, including field types, bounded strings, file arrays, and page counts; return clear 400 errors for malformed input.
- [x] Enforce actual download byte limits and validate file content/type instead of trusting client-supplied sizes and MIME types.
- [x] Reserve credits atomically before extraction, associate spending with an idempotent request/job ID, and settle or refund exactly once.
- [x] Remove the unchecked direct profile-update fallback and return the authoritative remaining balance.
- [x] Add regression tests for cross-user access, privileged RPC access, invalid URLs, malformed payloads, concurrent spending, duplicate requests, and failed extraction refunds.

## P1 — Upload and extraction reliability

- [ ] Share file-count, total-size, directive-length, and page-count limits between the upload UI and API; reject invalid selections before uploading.
- [ ] Fix retry state so deleted objects or expired signed URLs are never reused as successful uploads.
- [ ] Use unique storage object names to support files with identical filenames.
- [ ] Track upload sessions and clean up partial uploads, removed files, abandoned sessions, and download failures with a defined retry retention window.
- [ ] Replace direct SQL deletion of `storage.objects` with scheduled deletion through the Storage API.
- [ ] Move long extraction into durable jobs with queued/running/succeeded/failed states, per-file progress, an overall deadline, and recovery after refresh or worker failure.
- [ ] Implement rate limiting as a separate post-MVP reliability feature: replace the in-memory limiter with a shared atomic limiter and cap concurrent extraction work per user. This is not part of the anti-abuse/payment MVP.
- [ ] Schedule Storage-API cleanup for abandoned upload objects/reservations and bounded cleanup or alerting for unmatched Stripe events; keep database-only metadata deletion prohibited.
- [ ] Verify actual hosting timeouts and provider file/context limits; review model fallbacks and retry only appropriate failures.
- [ ] Add runtime validation shared across model output and saved extraction data; reject empty, malformed, or truncated responses.
- [ ] Replace fixed minimum item quotas in the prompt with source-grounded completeness criteria.
- [ ] Preserve source filenames and page references where available, and deduplicate repeated concepts across documents.
- [ ] Add offline extraction fixtures covering valid results, invalid JSON, wrong field types, empty/truncated output, provider failure, and upload retry/cleanup behavior.

## P1 — Typesetting and print correctness

- [ ] Fix screen-preview page bleed: the left side of the next (bottom) page appears at the right edge of the preceding (top) page. Reproduce with a multi-page sheet and correct preview offsets/clipping so each page shows only its own content. The user reports the actual PDF is correct; preserve that output and verify it remains unchanged.
- [ ] Distinguish successful fitting from unresolved overflow instead of always displaying a success indicator after fitting stops.
- [ ] Wait for fonts before measuring and remeasure when layout inputs change.
- [ ] Show which items were dropped and let users inspect their full content.
- [ ] Make the navigation guide's inclusion in the page budget match the selected option and printed result.
- [ ] Verify preview and printed output agree on pagination, clipping, formulas, and page counts.
- [ ] Add print regression fixtures for dense notes, long equations, shorthand, dropped items, multiple pages, and both guide modes.

## P2 — Sheet management and usability

- [ ] Let students iterate on an existing sheet: start from saved extracted content, provide revision feedback or a new focus directive, generate a revised version, and preserve the original/version history. Define whether an iteration costs a credit and do not depend on temporary source uploads that may already have been deleted.
- [ ] Allow users to edit, pin, and remove extracted items before printing.
- [ ] Persist page targets, layout preferences, and content edits when reopening a sheet.
- [ ] Add sheet deletion with ownership enforcement and related-data cleanup.
- [ ] Add dashboard pagination and search so users can access more than nine sheets.
- [ ] Calculate the total sheets-created count independently of the recent-results limit.
- [x] Add upload dialog focus management, Escape handling, accessible labels, and clear status announcements.
- [ ] Reconcile the typesetter's styling with the rest of the application and verify narrow-screen usability.
- [ ] Align product copy with supported inputs and export behavior; raw text upload is not implemented and PDF export currently uses browser printing.

## P2 — Anti-abuse and payments

- [x] Treat `.edu` as an eligibility signal, not proof of one active student.
- [ ] After launch, monitor privacy-minimized aggregate signup and extraction metrics and evaluate additional controls only if abuse becomes measurable.
- [x] Reconcile the anti-abuse PRD with SQL before implementing policy changes: review holds versus immediate credit removal, trial allocation, and payment-provider naming.
- [x] Consolidate administrator identity across environment configuration, SQL, and UI credit behavior.
- [ ] Complete and verify educational-email eligibility and trial allocation through the actual signup flow.
- [x] Implement Stripe Checkout and credit purchases according to the current PRD, passing the authenticated Supabase user ID as the Checkout Session's `client_reference_id`.
- [x] Add authenticated payment fulfillment with verified webhook signatures, duplicate-event protection, server-controlled credit amounts, and the agreed refund handling.
- [x] Add tests for signup eligibility, administrator exceptions, and duplicate or invalid payment events.
- [ ] Before supporting self-service Stripe account rotation, persist the Stripe
  account identity on purchases and support an overlap/drain window for the old
  webhook secret. The MVP requires the documented zero-pending-purchase
  operator runbook before any account or mode change.

## P2 — Developer setup and maintenance

- [x] Fix the existing explicit `any` lint error in `src/app/api/extract/route.ts` and unused `data` warning in `src/lib/supabase/storage-helpers.ts`.
- [x] Expand README with local setup, environment variable names, OAuth configuration, migration order, deployment steps, and troubleshooting.
- [x] Add a placeholder-only `.env.example` and a targeted `.gitignore` exception.
- [x] Make schema setup reproducible; document historical migrations and add forward migrations for fixes instead of assuming scripts can be rerun unchanged.
- [x] Add a `typecheck` script and CI for lint, type checking, production builds, and the new regression tests.
- [ ] Make `debug-extraction.ts` use configurable paths and explicit test configuration; separate live integration checks from offline tests.
- [x] Update PRDs and migration notes to distinguish implemented, deployed/verified, and planned features.

## P3 — Generation loading experience (low priority)

- [ ] Improve the feel of analysis/generation with a clearer loading screen, an engaging graphic or animation, and honest stage/status messaging. Start with this lightweight UX improvement; avoid invented progress percentages or completion estimates.
- [ ] Evaluate bounded parallel extraction across files as an optional speed improvement. Benchmark against the current sequential flow and check provider rate limits, memory use, retries, result ordering, and credit/failure handling before adopting it. Parallelization is exploratory, not required for the loading-screen improvement.
