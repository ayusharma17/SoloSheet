# Production generation incident — September 22, 2026

## Status

This document records the production investigation and recommended remediation.
The durable-job implementation now exists in the repository, but this document
does not claim that phase 19, the application, or the Netlify functions have
been deployed or verified against production.

The incident affected generation on `https://trysolosheet.com`. Stripe payment
fulfillment was investigated separately and was reported fixed during this
incident. The payment recovery design remains documented in
[`production-generation-and-payment-recovery.md`](./production-generation-and-payment-recovery.md).

## Executive summary

SoloSheet accepted uploaded course material, reserved a credit, and started a
Gemini extraction inside the synchronous Next.js `/api/extract` request. The
deployed Netlify request ended before the Gemini response could be received,
validated, and committed to Supabase.

For the final observed attempt, the Google AI Studio usage dashboard shows that
Gemini 2.5 Flash received and successfully processed the request, including a
large output close to the application's 8,192-token output ceiling. Netlify
logs contain the start of that call but no completion, handled provider error,
database commit, or refund. The browser consequently received a failed
transport response even though Google later counted the model call as
successful.

The generation and credit settlement currently share one synchronous process.
When the hosting platform terminates that process, JavaScript error handling
does not run. The extraction remains `processing`, no sheet is saved, and the
reserved credit remains deducted until a later database reconciliation occurs.

The recommended fix is to keep the existing Netlify deployment and move Gemini
generation into a Netlify Background Function backed by a durable Supabase job
state machine, atomic worker leases, an authenticated status endpoint, and an
independent scheduled refund sweeper.

## User-visible impact

- Generation displayed `Extraction failed` even when Google completed the
  model request.
- No generated material appeared in the dashboard.
- A reserved credit remained unavailable after the failed browser request.
- Retrying the same active request could return HTTP `409` with
  `EXTRACTION_PROCESSING` because its database row was still `processing`.
- The upload dialog could simultaneously show a red extraction failure and a
  green cleanup message. The green message referred to older storage objects,
  not to successful generation or settlement of the current request.
- Platform HTML or text error responses could surface as JSON parsing errors
  because the client unconditionally called `response.json()`.

## Architecture at the time of the incident

The production path was synchronous:

```text
Browser
  -> upload files to private Supabase Storage
  -> POST /api/extract
       -> authenticate and validate
       -> reserve one credit in Supabase
       -> download stored files
       -> call Gemini and await the complete structured response
       -> save the generated material
       -> mark the reservation completed
       -> clean up uploads
  <- final JSON response
```

Relevant implementation:

- `src/app/dashboard/upload-modal.tsx` uploads files, waits for the final POST
  response, and retains retry state for ambiguous outcomes.
- `src/app/api/extract/route.ts` authenticates, reserves a credit, downloads
  the files, awaits Gemini, persists the material, and performs cleanup.
- `src/lib/gemini.ts` requests exhaustive structured output and permits up to
  8,192 output tokens. It can retry a model and move through fallbacks.
- `src/lib/extraction-credits.ts` calls `fail_extraction()` when an ordinary
  JavaScript exception is caught.
- `reserve_extraction()` performs atomic debit/idempotency operations and lazily
  refunds sufficiently old `processing` reservations when another reservation
  is attempted.

`export const maxDuration = 300` exists in the Next.js route, but the observed
production request path did not remain alive for that duration. Application
configuration cannot be treated as proof of the effective platform limit.

## Evidence collected

### Netlify production logs

The connected Netlify site is `solosheet`, project ID
`dd9b62d0-d8b4-46fc-aadf-54efa327f3ad`. Runtime logs were read through the
authenticated Netlify CLI without deploying code.

Earlier attempts showed provider-side availability errors:

```text
2026-09-22T16:54:54.875Z
[Gemini Extraction] ... Attempting with model gemini-3.1-flash-lite...

2026-09-22T16:55:11.416Z
Model gemini-3.1-flash-lite failed ... 503 UNAVAILABLE ... high demand

2026-09-22T16:55:12.918Z
[Gemini Extraction] ... Attempting with model gemini-3.1-flash-lite...
```

Those 503 responses were real Gemini failures, but they do not explain the
final Gemini 2.5 Flash attempt.

The final observed attempt showed only the beginning of the provider call:

```text
2026-09-23T00:54:30.254Z
Both GOOGLE_API_KEY and GEMINI_API_KEY are set. Using GOOGLE_API_KEY.

2026-09-23T00:54:30.255Z
[Gemini Batch] Starting extraction for lecture5.pdf (1/1)

2026-09-23T00:54:30.257Z
[Gemini Extraction] ... Attempting with model gemini-2.5-flash...
```

There was no subsequent application log for:

- a Gemini error;
- successful parsing;
- material persistence;
- `complete_extraction()`;
- `fail_extraction()`; or
- upload cleanup for that job.

Other production request records ended at an observed duration of exactly
30,000 ms, demonstrating the effective termination boundary encountered by
this deployed request path.

### Google AI Studio usage dashboard

The Google AI Studio project usage dashboard showed:

- the application called Gemini using the project associated with the
  production `GOOGLE_API_KEY`;
- earlier Gemini 3.1 Flash Lite requests produced `503 ServiceUnavailable`
  errors;
- the latest Gemini 2.5 Flash request was received by Google;
- the latest request generated a large output near 8,000 tokens; and
- the latest request did not have a corresponding 503 error.

This is the decisive distinction between an attempted SDK call and a request
accepted by Google. The final request reached and completed at the provider,
but SoloSheet did not receive and commit the result before its synchronous
hosting request ended.

### Netlify plan capability

Read-only Netlify account metadata reported:

- plan type: `Free`;
- plan slug: `credit-free`; and
- `background_functions.included: true`.

Therefore, the current SoloSheet team can use Netlify Background Functions
without migrating hosts or upgrading solely for this capability. Netlify
documents a 15-minute Background Function execution limit, an immediate empty
`202` response, and two platform retries for failed executions.

References:

- [Netlify Background Functions](https://docs.netlify.com/build/functions/background-functions/)
- [Netlify Function configuration and limits](https://docs.netlify.com/build/functions/configuration/)
- [Netlify Function usage and billing](https://docs.netlify.com/build/functions/usage-and-billing/)
- [Vercel Function limits](https://vercel.com/docs/functions/limitations)
- [Vercel Workflow](https://vercel.com/workflows)

## Root cause

### Primary root cause

Long-running model generation and durable business settlement were coupled to
one synchronous HTTP request.

The request performed these operations in order:

1. Commit a credit reservation.
2. Await Gemini's full response.
3. Validate and persist the generated sheet.
4. Mark the reservation completed or catch an error and refund it.

If the process disappears between steps 1 and 3, step 4 cannot execute. A host
termination is not an ordinary JavaScript exception that reliably unwinds the
stack and enters `catch` or `finally`.

The latest provider call completed after the application had lost its usable
request lifecycle. As a result, Google recorded successful usage while the
application recorded neither a completed sheet nor a handled failure.

### Credit consequence

The credit was not permanently consumed by an explicit failure transaction. It
remained attached to a non-terminal `processing` reservation.

The existing database logic can refund old processing rows, but it does so
only when another `reserve_extraction()` call runs. This creates several
problems:

- recovery depends on later user traffic;
- a user at zero visible credits can remain stuck;
- the browser cannot distinguish a dead worker from a live one; and
- the current age test is not a real worker lease.

### Contributing factors

- The extraction prompt requests 40–100+ granular items rather than a short
  summary.
- `maxOutputTokens` is 8,192, and the dashboard showed the final request
  approaching that output size.
- Application-level retries and model fallbacks can consume much of a
  synchronous request budget before a successful model finishes.
- Both `GOOGLE_API_KEY` and `GEMINI_API_KEY` are configured. The application
  explicitly uses `GOOGLE_API_KEY`, which can make dashboard investigation
  confusing if the other key's project is inspected.
- There was no independent job runner, durable worker lease, heartbeat, or
  scheduled settlement process.
- The frontend assumed JSON for all responses, even when a hosting gateway
  could return HTML or plain text.

## Why the UI showed contradictory banners

The green cleanup banner and red extraction banner described different
operations.

`Clear saved temporary uploads` deleted storage objects from previous failed
attempts and set a success notice. It then reset the in-memory file entry so it
could be uploaded again. Starting the next generation cleared the error but did
not clear the earlier cleanup notice. The file was uploaded again and displayed
a green upload checkmark. When extraction subsequently failed, the stale green
cleanup notice remained next to the new red failure.

The green notice therefore meant only that older temporary storage objects were
deleted. It did not mean that the current extraction succeeded or that its
credit was settled.

## Alternatives considered

### 1. Netlify Background Function with Supabase job state — recommended

Advantages:

- available on the current SoloSheet Netlify plan;
- up to 15 minutes for generation;
- immediate `202 Accepted` response to the browser;
- no hosting, domain, environment, OAuth, or Stripe webhook migration;
- existing Supabase credit transactions remain reusable; and
- the implementation can remain provider-neutral because Supabase is the
  source of truth.

Risks and required controls:

- Netlify may retry a failed background execution, so job claiming and
  completion must be idempotent;
- the public function URL must be protected with server-to-server
  authentication and authoritative database lookup;
- the 256 KB background payload limit means the request must contain only an
  opaque job identifier, never PDF bytes;
- the current ten-minute stale rule conflicts with a valid worker that may run
  for up to 15 minutes and must be replaced with a renewable lease; and
- a separate scheduled sweeper is still required for hard termination at the
  background limit.

### 2. Move the existing synchronous route to Vercel Fluid Compute

Vercel provides substantially longer synchronous Function durations. This
would likely allow the observed request to finish and would require relatively
little application-code change.

It was not selected as the durable fix because it only moves the termination
boundary. Credit settlement would still depend on one process reaching its
catch handler. The application would still require job state, idempotency, and
independent recovery for correctness. SoloSheet is commercial, so Vercel Hobby
is not an appropriate production plan; a hosting migration would also require
environment, DNS, Supabase redirect, Stripe webhook, and deployment validation.

### 3. Vercel Workflow

Vercel Workflow offers durable steps, persisted results, retries, and workflow
observability. It is technically attractive for a larger multi-step generation
pipeline.

It was not selected for the immediate incident because it requires the same
core job-state and settlement design plus a platform migration and new workflow
tooling. It is a reasonable future choice if SoloSheet intentionally standardizes
on Vercel or expands generation into a more complex pipeline.

### 4. Change Gemini models or reduce output size

Using a faster model, reducing requested item count, lowering the output-token
limit, splitting PDFs, or processing fewer files can reduce latency and cost.

These are useful optimizations, not correctness mechanisms. Provider latency is
variable, and no model choice guarantees completion before a synchronous host
limit. The credit system must remain correct when any provider is slow,
unavailable, or completes after the caller disconnects.

### 5. Increase `maxDuration`, upgrade a plan, or stream the response

These approaches can improve the probability of success but do not provide
durable settlement. Streaming also does not solve the current requirement to
validate a complete structured response and atomically persist a finished
sheet. They were rejected as the primary fix.

## Recommended target architecture

```text
Browser
  -> upload files to private Supabase Storage
  -> POST /api/extract
       -> authenticate and validate
       -> atomically reserve credit and persist immutable queued job
       -> dispatch background worker with opaque request ID
  <- 202 Accepted + request ID + authoritative balance

Netlify Background Function
  -> authenticate internal dispatch
  -> atomically claim job and establish lease
  -> read authoritative job inputs from Supabase
  -> download private storage objects by path
  -> call Gemini
  -> validate structured result
  -> atomically persist material and complete reservation
  -> delete temporary objects through Supabase Storage API

Browser
  -> GET /api/extract/{requestId}
  <- queued | processing | completed | failed

Scheduled recovery
  -> atomically expire jobs whose worker lease is no longer valid
  -> refund charged reservations exactly once
  -> leave completed jobs charged
```

## Required database behavior

The extraction job should contain authoritative, immutable inputs:

- user and request identifiers;
- input fingerprint;
- course name, directive, and target page count;
- storage object paths, original names, MIME types, and declared sizes;
- state and attempt count;
- lease owner and lease expiration;
- created, started, heartbeat, completed, and settled timestamps;
- generated material identifier when completed; and
- a finite, non-sensitive failure code.

Recommended states:

```text
queued -> processing -> completed
                    \-> failed/refunded
                    \-> expired/refunded
```

Required invariants:

- one logical request reserves at most one credit;
- only one active worker lease may call Gemini for a request;
- platform retries cannot create another charge or material;
- completion and refund are mutually exclusive atomic terminal transitions;
- repeating a terminal transition is a no-op;
- a completed request returns the existing material;
- an expired lease is refunded without requiring another user request; and
- a late worker cannot complete a request already expired and refunded.

## Implementation plan

### Phase 1 — schema and transactions

- Add a forward Supabase migration for persisted job inputs, explicit states,
  worker attempts, and renewable leases.
- Add service-only atomic transactions to reserve/enqueue, claim, heartbeat,
  complete, fail, and expire jobs.
- Remove the implicit ten-minute `created_at` settlement rule once lease-aware
  recovery is deployed.
- Add an owner-scoped status function or authenticated API path without
  exposing service-role access.

### Phase 2 — background worker

- Add a modern Netlify Background Function under `netlify/functions/`.
- Protect dispatch with a dedicated rotatable server secret.
- Accept only the request ID and read all user, file, and generation data from
  Supabase.
- Process files incrementally. The aggregate product limit remains 200 MB, but
  each file is capped at 20 MB before upload dispatch and revalidated by the
  worker before signing/downloading. This keeps the inline Gemini payload and
  its base64 copy safely below the provider request limit.
- Give each worker an absolute 13-minute processing deadline. Every Gemini call
  uses the smaller of the remaining job budget and a 150-second per-call cap,
  leaving roughly two minutes to atomically requeue/refund before Netlify's
  15-minute background-function termination.
- Classify provider errors. Permanent 4xx/configuration errors should settle
  immediately; transient 429/503 failures may be retried under bounded policy.
- Include the request ID in every sanitized log event.

### Phase 3 — status and browser behavior

- Change the POST route to return `202` after successful dispatch.
- Add an authenticated ownership-checked status endpoint.
- Poll with bounded backoff or subscribe through Supabase Realtime.
- Navigate to the generated material only after `completed`.
- Refresh the displayed balance after every terminal state.
- Handle non-JSON transport errors without attempting unconditional JSON
  parsing.
- Clear stale cleanup notices when a new upload or extraction begins.

### Phase 4 — independent recovery

- Add a scheduled Netlify Function that invokes one bounded, set-based
  Supabase settlement transaction.
- Expire only jobs whose lease is actually invalid.
- Refund each charged reservation exactly once.
- Record safe operational metrics and audit events.
- Keep the database transaction short enough for the scheduled function's
  execution limit.

## Verification requirements

### Generation behavior

- A synthetic one-file PDF completes asynchronously and charges once.
- A request that lasts longer than 30 seconds completes successfully.
- The browser may close or reload without cancelling or duplicating the job.
- A platform retry cannot produce a second Gemini call while a valid lease is
  held.
- A completed retry returns the same material.

### Failure and credit behavior

- Provider 400/configuration failure refunds once.
- Provider 429/503 follows the bounded retry policy and eventually completes or
  refunds once.
- Invalid model output refunds once without exposing the provider response.
- Worker termination leaves a leased job that the scheduled sweeper later
  expires and refunds.
- Repeating failure, completion, or expiry settlement is a no-op.
- A late worker cannot charge or save after expiry.

### Security and storage

- Anonymous callers cannot invoke useful background work.
- A user cannot enqueue or observe another user's job.
- The worker does not trust user IDs or storage paths from the dispatch body.
- Storage paths remain under the authenticated user's namespace.
- Temporary objects are deleted through the Storage API only after an
  authoritative terminal transition.
- No API key, service-role key, signed URL, document content, or raw provider
  body appears in logs or user-visible errors.

### UI behavior

- `queued`, `processing`, `completed`, and `failed` states are distinct.
- A cleanup success message cannot be mistaken for generation success.
- HTTP 202 and 409 responses render actionable state rather than generic
  failure.
- HTML/plain-text platform errors do not produce `Unexpected token '<'`.

## Operational recovery until the fix is deployed

For a stranded extraction:

1. Identify the exact user and request ID without copying signed URLs or
   credentials into the incident record.
2. Confirm that no material is associated with the request.
3. Confirm that no worker can still complete it.
4. Invoke the protected `fail_extraction()` settlement path with service-only
   tooling on a pre-phase-18 deployment, or `fail_extraction_job()` with the
   active lease owner after phase 19; do not directly mutate the request,
   material, or profile tables.
5. Verify the request is terminal, the credit was restored exactly once, and a
   repeated settlement has no effect.

Avoid repeated production generation tests until background processing and
independent settlement are deployed. Each synchronous test can consume Gemini
quota and create another ambiguous reservation even if Google successfully
finishes after the application request ends.

## Decision

Use a Netlify Background Function plus Supabase as the durable system of
record. This is the lowest-risk solution for the current application because
the capability is enabled on the existing plan and it avoids an unrelated host
migration. Revisit Vercel Workflow only as a deliberate broader platform
decision, not as a timeout workaround.

## Repository implementation and rollout

The repository implementation uses:

- `supabase/migration_phase19_durable_extraction_jobs.sql` for immutable inputs,
  atomic enqueue/claim/heartbeat/complete/fail/expire transitions, owner-scoped
  status, and service-only upload-ledger release;
- `netlify/functions/process-extraction-background.ts` for protected background generation;
- `netlify/functions/recover-extractions.ts` for five-minute lease recovery;
- `POST /api/extract` for enqueue and dispatch only; and
- `GET /api/extract/{requestId}` for authenticated polling.

Deployment order is strict:

1. Back up and inspect the hosted database. Put generation in maintenance mode,
   stop or drain every old application instance, and verify no synchronous
   extraction request remains in flight. Keep generation paused throughout the
   database/application cutover; a rolling deploy is unsafe because phase 19
   retires the synchronous RPCs and settles legacy `processing` rows.
2. Apply the timestamped phase 19
   forward migration. It rejects ambiguous duplicate request UUIDs, settles
   legacy `processing` rows exactly once, enforces globally unique request IDs,
   and removes the synchronous reserve/complete/fail RPCs. It also aborts and
   rolls back if any charged legacy request cannot be refunded because its
   profile is missing. Repair that profile from authoritative account data,
   then rerun the unchanged migration; never mark the request settled by hand.
   Confirm no old application instance can call the retired RPCs before
   applying it.
3. Confirm `service_role` can execute the phase 19 worker RPCs but has only
   `SELECT` on `extraction_requests` and `course_materials`—no direct write,
   truncate, trigger, or references privilege. Those revocations make lease ownership, exact refund,
   material creation, and audit behavior enforceable even if server code is
   accidentally changed.
4. Configure a rotatable `EXTRACTION_DISPATCH_SECRET` of at least 32 random bytes
   in Netlify. It is server-only and must match for the Next.js route and worker.
5. Deploy the application and Netlify functions together, verify all instances
   are on the durable version, and only then take generation out of maintenance.
6. Confirm the background function and five-minute scheduled function appear in
   Netlify, then use a non-production synthetic PDF to verify enqueue, polling,
   completion, cleanup, and balance settlement.
7. Terminate one synthetic worker after it claims a job and confirm the scheduled
   sweep expires the invalid lease, refunds exactly once, and rejects late work.

Rollback must keep the phase 19 schema in place because queued/terminal job rows
and settled credits are durable. Roll back application code only to a version
that understands phase 19, or pause generation while correcting the deployment.
Do not restore the synchronous Gemini request path as a timeout workaround.
