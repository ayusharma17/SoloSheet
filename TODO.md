# TODO

## P0 — Highest priority

- [x] **Implement signup eligibility separately from free-credit eligibility:** [open signup and configurable trial-credit eligibility](PRDS/Open_Signup_and_Trial_Credit_Flag_PRD.md) is implemented with local regression coverage and a local browser harness. Hosted migration state, real Google OAuth, and deployed launch-copy verification remain unverified release checks; see [local acceptance](docs/open-signup-local-acceptance.md).

### Recoverable extraction attempts

- [ ] Move multi-file extraction out of the synchronous Next.js request and into a durable background job that can run beyond Netlify's synchronous function limit. Return promptly, persist queued/running/per-file/succeeded/failed state, expose honest progress through polling, enforce an overall deadline, and recover after refresh or worker failure. Verify the complete production flow with one file and at least eight files.
- [ ] Make preserved uploads genuinely recoverable across modal closure, refresh, sign-out, and deployment. Persist a server-backed upload/extraction session containing the request ID and owned storage paths (never signed URLs), show it on the dashboard with **Resume retry** and **Discard uploads** actions, refresh signed URLs when resuming, and reuse the original idempotent request without charging twice. Successful, explicitly failed, expired, and discarded sessions must release their objects and quota deterministically. The manual **Clear saved temporary uploads** action is only an emergency escape hatch, not completion of this item.

- [ ] Remove “Powered by Gemini” tags from the website.
- [ ] Add a dedicated SoloSheet icon for the website branding and favicon.
- [ ] Configure a production custom domain for SoloSheet in Netlify, then update `APP_URL`/`SITE_URL`, Supabase site and redirect URLs, Google OAuth authorized origins/redirect URIs, Stripe redirect URLs, and any security-origin allowlists. Verify login, callback, dashboard, extraction, payments, and logout on the custom domain before redirecting the `netlify.app` hostname.
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
- [x] Use unique storage object names to support files with identical filenames.
- [ ] Track upload sessions and clean up partial uploads, removed files, abandoned sessions, and download failures with a defined retry retention window.
- [ ] Replace direct SQL deletion of `storage.objects` with scheduled deletion through the Storage API.
- [ ] Implement rate limiting as a separate post-MVP reliability feature: replace the in-memory limiter with a shared atomic limiter and cap concurrent extraction work per user. This is not part of the anti-abuse/payment MVP.
- [ ] Schedule Storage-API cleanup for abandoned upload objects/reservations and bounded cleanup or alerting for unmatched Stripe events; keep database-only metadata deletion prohibited.
- [ ] Verify actual hosting timeouts and provider file/context limits; review model fallbacks and retry only appropriate failures.
- [ ] Add runtime validation shared across model output and saved extraction data; reject empty, malformed, or truncated responses.
- [ ] Replace fixed minimum item quotas in the prompt with source-grounded completeness criteria.
- [ ] Preserve source filenames and page references where available, and deduplicate repeated concepts across documents.
- [ ] Add offline extraction fixtures covering valid results, invalid JSON, wrong field types, empty/truncated output, provider failure, and upload retry/cleanup behavior.

## P1 — Typesetting and print correctness

- [ ] When **Hide guide** is selected, disable the **Separate page** / **In page** placement control because guide placement is not applicable.
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
- [ ] Apply and verify open signup and trial allocation through the actual hosted Google OAuth flow for `.edu` and non-`.edu` test identities. Confirm the Phase 17/18 migration order and launch-On flag first; local implementation and regression coverage are complete.
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
- [x] Update PRDs and migration notes to distinguish implemented, deployed/verified, and planned features.

## P3 — Generation loading experience (low priority)

- [ ] Improve the feel of analysis/generation with a clearer loading screen, an engaging graphic or animation, and honest stage/status messaging. Start with this lightweight UX improvement; avoid invented progress percentages or completion estimates.
- [ ] Evaluate bounded parallel extraction across files as an optional speed improvement. Benchmark against the current sequential flow and check provider rate limits, memory use, retries, result ordering, and credit/failure handling before adopting it. Parallelization is exploratory, not required for the loading-screen improvement.
