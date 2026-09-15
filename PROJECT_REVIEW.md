# SoloSheet project review

Reviewed September 13, 2026. This is a source review with local lint/type checks, not a production security audit. Live database grants, applied migrations, hosting limits, provider availability, and browser/print behavior were not inspected. Application code was not changed.

## Highest priority: access control and extraction boundaries

1. **Restrict privileged database operations.** `supabase/migration_phase5_anti_abuse.sql` defines `add_credits(target_user_id, amount)` as `SECURITY DEFINER` without caller checks or execution restrictions. `migration_phase2.sql` similarly accepts any user ID in `decrement_credits`. The admin whitelist has no RLS declaration in the checked-in SQL. If deployed with default function privileges, callers can invoke these functions beyond their intended authority. Explicitly restrict grants, authorize callers, validate positive credit amounts, secure the whitelist, and fix function search paths. Verify effective grants in a test database, including anonymous and ordinary authenticated roles. [Supabase function security documentation](https://supabase.com/docs/guides/database/functions).

2. **Replace loose URL validation with owned storage paths.** `src/lib/supabase/storage-helpers.ts` uses hostname substring checks for `supabase.co`; the route does not bind a download to the configured project, bucket, or caller. A hostname such as `supabase.co.example.org` passes the string check, and fetch follows redirects. Prefer accepting an object path and downloading through the authenticated Storage client after validating ownership. If URLs remain, enforce exact HTTPS origin, bucket/path constraints, and redirect handling. Test lookalike hosts, redirects, and another user's object path.

3. **Validate request shape and actual bytes.** `src/app/api/extract/route.ts` trusts `fileEntry.size` and `type`, then buffers entire responses. Omitted/negative sizes bypass the intended total-size check; non-string names/directives and non-array file lists can produce 500s. Add a runtime request schema, bounded strings/counts, trusted metadata checks, content signatures, and an enforced streaming byte budget. Reject malformed requests before downloads or paid extraction. Apply the same count/total-size/page limits in the upload UI to avoid uploading files the API will reject.

4. **Make credit reservation atomic.** The route reads a balance, runs Gemini, saves the result, and only then decrements. Two requests with one credit can both complete; the RPC silently updates zero rows when exhausted. Its direct-update fallback also ignores the returned error and has no matching profile UPDATE policy in the repository. Reserve a credit atomically before processing, associate it with an idempotent job ID, and settle/refund once. Test concurrent submissions, duplicate retries, save failure, and provider failure.

## Next: dependable uploads and generation

5. **Move long extraction into durable jobs.** Up to ten files run sequentially with multiple provider fallbacks/retries inside one HTTP request. `maxDuration = 300` is not evidence that the deployed platform supports the total work. Persist queued/running/succeeded/failed state, impose an overall deadline, and expose per-file progress. Replace the process-local rate-limit Map with a shared atomic limiter and a concurrency cap. Validate hosting and model limits against the actual deployment before choosing limits.

6. **Fix cleanup and retry state together.** Extraction/save failures delete uploaded objects, but `upload-modal.tsx` retains their `uploaded` status and signed URL, so retry can reuse a deleted object. Download failures and partial uploads can leave objects behind. Track a server-owned upload session; either retain objects for a bounded retry window or reset client upload state after deletion. Use unique object names to avoid same-filename collisions. Replace `cleanup_old_course_materials()`'s direct SQL DELETE with a scheduled Storage API cleanup, which removes the underlying files as well as metadata. [Supabase storage schema documentation](https://supabase.com/docs/guides/storage/schema/design).

7. **Validate and improve extraction quality.** `src/lib/gemini.ts` casts model fields rather than validating them, accepts an empty response as `[]`, and concatenates documents without provenance. Add a shared runtime schema, reject empty/invalid results, handle truncated output explicitly, attach source filename/page where available, and deduplicate repeated concepts. Replace the fixed demand for 40–100+ items per document with source-grounded completeness criteria so short documents do not encourage fabricated material. Build small offline fixtures for valid output, malformed JSON, wrong field types, and provider failure.

## Product and maintainability

8. **Make page fitting honest and controllable.** The typesetter reports a check mark when fitting attempts are exhausted even if content still overflows. Distinguish fitted from unresolved overflow, expose which items were dropped, allow users to pin/edit/remove items, and persist page/layout choices. Wait for fonts before measuring and remeasure when necessary. Test the separate preview and print layouts with long equations, many items, and the optional guide. These are code-derived risks; no visual test was performed in this review.

9. **Reconcile anti-abuse requirements with implementation.** The project no longer uses device fingerprinting; retire the legacy database table and RPC through a forward migration. Stripe Checkout and payment webhooks are still absent from `src/`. The API admin list also comes from an environment variable while SQL uses a separate table. Agree on one implemented policy, document pending features, and consolidate administrator identity before extending the system.

10. **Improve setup and regression coverage.** Replace the minimal README with setup, environment variable names, OAuth configuration, migration order, and troubleshooting. Add a placeholder-only `.env.example` with a targeted `.gitignore` exception. Make migrations reproducible; several CREATE POLICY/TRIGGER statements cannot be rerun as written. Add a typecheck script and CI for lint/typecheck/build, then targeted tests for the high-risk behaviors above. Make `debug-extraction.ts` portable and explicitly separate live integration checks from offline tests. Add accessible dialog behavior (focus management, Escape, labels) to the upload modal and pagination for the dashboard's nine-item limit.

## Baseline verification

- `./node_modules/.bin/tsc --noEmit --incremental false`: passed.
- `npm run lint`: failed with one error (`src/app/api/extract/route.ts:88`, explicit `any`) and one warning (`src/lib/supabase/storage-helpers.ts:20`, unused `data`). Both predate this review.
- No automated test script exists in `package.json`.
- Production build, live extraction, database changes, and browser/print tests were not run for this documentation task.

## Agent setup

The root `AGENTS.md` records the actual stack, source map, commands, security expectations, and verification workflow. Uppercase `AGENTS.md` is the standard discovery filename. A `.agents/` directory is unnecessary here until a reusable repository skill is identified; those live at `.agents/skills/<name>/SKILL.md`. See the official [AGENTS.md guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and [skill documentation](https://learn.chatgpt.com/docs/build-skills).
