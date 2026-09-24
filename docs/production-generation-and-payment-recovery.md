# Production generation and payment recovery plan

## Purpose

This document records the September 22, 2026 production incident and the work
required to make generation credits and Stripe fulfillment recoverable. It is a
plan, not evidence that the fixes have been deployed.

The governing product rule is:

> A generation may consume one credit only when it produces a persisted cheat
> sheet. A failed, abandoned, or timed-out generation must eventually refund
> its reservation exactly once without requiring the user to spend another
> credit or start another request.

The payment equivalent is:

> A verified paid Stripe Checkout must grant its package exactly once. The
> application must not open Checkout when its webhook fulfillment path is not
> configured.

## Corrected incident assessment

### Generation

The production `GEMINI_MODEL` is configured as
`gemini-3.1-flash-lite-preview`. Google shut that preview model down on May 25,
2026. Generation working before that shutdown is consistent with the observed
regression. Replace it with the stable `gemini-3.1-flash-lite` model.

The Netlify timeout is a separate reliability boundary, not sufficient evidence
that the application could never have worked. Current Netlify Functions
guidance documents a 60-second synchronous limit and a 15-minute background
limit. The failed production attempts remained in `processing` at roughly the
synchronous boundary, so a hard termination is the likely reason the route did
not call `fail_extraction`. Confirm the exact termination reason in function
logs during the controlled verification run.

The existing same-request retry behavior is intentionally idempotent and should
be preserved. `reserve_extraction` returns the existing state for the same user,
request ID, and fingerprint; it does not debit a second credit. Multiple
production `processing` rows with different request IDs demonstrate separate
attempts, not a failure of same-request idempotency.

The actual credit defect is that host termination can bypass the in-process
catch handler. `fail_extraction` refunds a caught failure correctly, but there
is no independent settlement process for an abandoned reservation. The current
stale cleanup runs only inside a later `reserve_extraction` call, which cannot
be the recovery mechanism for a user whose visible balance has reached zero.

### Payment

Netlify production has `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, and `APP_URL`, but
does not have `STRIPE_WEBHOOK_SECRET`. The webhook route therefore returns
`503 Webhook unavailable` before signature verification and fulfillment.

The observed test-mode purchase has a Checkout Session and remains `pending`;
no PaymentIntent was recorded, the webhook ledger is empty, and no credits were
granted. Dashboard polling reads the database state but cannot turn a pending
purchase into a paid purchase. Reloading the success URL initializes the client
to `confirming` again, which makes the same unresolved state look perpetual.

## Immediate production recovery

Perform these steps in order. Record the deploy ID, Stripe event ID, affected
request IDs, and before/after balances in the incident record. Never record
secret values.

### 1. Stop creating new ambiguous work

- Temporarily disable generation until the stable model and execution strategy
  have passed one controlled production test.
- Temporarily disable Checkout until the webhook secret and public endpoint are
  verified.
- Do not manually edit balances, purchase status, or webhook rows.

### 2. Restore Gemini configuration

- Set production `GEMINI_MODEL` to `gemini-3.1-flash-lite`.
- Update the code default and fallback list so a shut-down preview is not tried.
- Keep at least one currently supported fallback, but retry only errors that are
  actually transient. Model-not-found and retired-model responses must fail over
  immediately without sleeping or repeating the same model.
- Redeploy and confirm the deploy reads the intended model without logging the
  API key.

Changing the model fixes the triggering provider error. It does not by itself
make credit settlement durable or guarantee a dense PDF finishes within the
synchronous runtime.

### 3. Settle abandoned generation reservations

For every affected `processing` request:

1. Verify that no `course_materials` row is associated with the request.
2. Verify that the request is older than the agreed lease/timeout threshold and
   no worker still owns it.
3. Invoke the existing protected `fail_extraction` transaction using
   service-only operational tooling. Do not increment `profiles.credits`
   directly.
4. Verify that the request is `failed`, its charged credit was restored exactly
   once, and a repeated settlement call does not alter the balance.

If a material exists or completion is ambiguous, stop and reconcile that
request individually. A completed sheet must remain charged.

### 4. Restore Stripe fulfillment

- In Stripe test mode, register
  `https://trysolosheet.com/api/webhooks/stripe`.
- Subscribe it to `checkout.session.completed`,
  `checkout.session.expired`, `charge.refunded`,
  `charge.dispute.created`, and `charge.dispute.closed`.
- Add that endpoint's test-mode `whsec_...` signing secret to Netlify as
  `STRIPE_WEBHOOK_SECRET` for the production Functions/runtime context.
- Confirm that the Stripe secret key, Price, signing secret, and pending Session
  all belong to the same Stripe account and test/live mode.
- Redeploy before accepting another Checkout.
- Replay the existing `checkout.session.completed` event from Stripe test mode.
- Verify one processed webhook-ledger row, a `paid` purchase, and exactly ten
  added credits. Replay the same event again and verify no additional grant.

If Stripe does not show a completed paid Session, do not grant credits. Expire
or complete the test Session according to its authoritative Stripe state.

## Durable generation design

### Required state machine

Use explicit states with one database transaction for every transition:

```text
reserved -> processing -> completed
                      \-> failed/refunded
                      \-> expired/refunded
```

The following invariants must hold:

- `completed` has one material ID and consumes at most one credit.
- `failed` and `expired` have no material and retain no charged credit.
- Repeating any terminal transition is a no-op that returns the authoritative
  material and balance.
- Only the same user, request ID, and fingerprint may observe or resume a job.
- A timeout is a normal terminal condition, not an indefinitely processing job.

### Near-term settlement migration

Add a forward migration that introduces a protected stale-reservation
settlement function. The function should:

- lock eligible requests and their profiles in a consistent order;
- select only `processing` requests whose lease has expired;
- mark each request terminal and refund a charged reservation in the same
  transaction;
- prevent a late worker from completing a settled request;
- be idempotent under concurrent scheduler and request activity;
- return counts, not user data or secrets;
- use a fixed empty `search_path` and schema-qualified relations;
- revoke execution from `PUBLIC`, `anon`, and `authenticated`;
- be executable only by the narrowly chosen server/scheduler role.

Run settlement on a schedule independent of user traffic. If Supabase Cron is
used, verify the extension and deployed schedule rather than inferring them from
SQL files. If a Netlify scheduled function is used, remember its runtime is
short and make it call the bounded database transaction rather than scan or
settle rows in JavaScript.

Consider adding `lease_expires_at`, `last_heartbeat_at`, `settled_at`, and a
non-sensitive `failure_code`. A lease is clearer than deriving liveness from
`created_at`, particularly once generation moves to a background worker.

### Background execution

Move Gemini processing out of the synchronous Next.js request:

1. Authenticate and validate the browser request.
2. Reserve one credit and persist a job containing storage object paths, not
   signed URLs or file bytes.
3. Dispatch a Netlify Background Function or another durable worker and return
   `202 Accepted` with the request ID.
4. Let the worker download private objects with server credentials, call Gemini,
   heartbeat/renew its lease, and invoke the existing completion transaction.
5. Have the browser poll an authenticated, ownership-checked job-status route.
6. Let the independent reconciler expire and refund a worker that disappears.

Netlify Background Functions allow longer work than synchronous functions, but
the database remains the authority. Background dispatch success must not be
treated as generation success, and a background function still needs lease
expiry because any worker can be terminated.

### Provider failure classification

Record only safe finite codes such as:

- `provider_model_not_found`
- `provider_rate_limited`
- `provider_timeout`
- `provider_invalid_response`
- `storage_download_failed`
- `worker_lease_expired`
- `persistence_failed`

Do not store provider bodies, API keys, signed URLs, extracted lecture content,
or raw stack traces in user-visible responses. Metrics should include duration,
model name, terminal state, refund outcome, and request correlation ID.

## Durable payment design

### Deployment readiness

Checkout configuration must require a valid webhook fulfillment configuration,
not just a secret key and Price. Before returning a Stripe Checkout URL, verify
that `STRIPE_WEBHOOK_SECRET` is present and structurally valid. This prevents the
application from accepting a payment when it knows fulfillment cannot run.

Add a deployment smoke check that verifies variable presence and mode
consistency without printing values. The check must not create a real payment.

### Reconciliation

Webhooks remain the primary authority. Add a bounded, server-only reconciliation
path for purchases that remain `pending` past a short threshold:

- retrieve the exact Checkout Session from Stripe using the server secret;
- verify the recorded user, purchase metadata, Price, amount, currency, and
  test/live mode;
- fulfill only when Stripe reports the Session paid;
- call the same idempotent database transaction used by the webhook;
- record a synthetic reconciliation correlation ID separately from Stripe event
  IDs so an eventual webhook remains safe to replay;
- terminalize expired unpaid Sessions without granting credits.

Do not make the browser query string authoritative and do not let a client call
the fulfillment RPC.

### Dashboard behavior

- Show `confirming` only while polling is active.
- After the bounded polling window, show an actionable `unconfirmed` message
  with a refresh control and support guidance.
- Remove or replace the success query parameters after reaching a terminal
  state so page refresh does not restart a false confirming presentation.
- Display that test-mode payments use no real money in non-production payment
  environments.

## Verification matrix

### Generation and credits

- Supported Gemini model, small synthetic PDF: completes and charges once.
- Provider model-not-found: fails over immediately or fails and refunds once.
- Provider rate limit after retries: terminal failure and refund once.
- Worker termination after reservation: scheduled settlement refunds without a
  new user request.
- Same request ID retried while active: reports processing and does not debit.
- Same request ID retried after completion: returns the same material and does
  not debit.
- Same request ID retried after failure: reports terminal failure and does not
  debit; a deliberate new request may reserve once.
- Concurrent identical requests: one reservation and at most one material.
- Late completion after expiry: rejected and cannot recreate the charge.
- Cleanup failure after committed material: material stays completed and
  charged; storage cleanup remains independently retryable.

### Stripe

- Missing webhook secret: Checkout is unavailable before redirecting to Stripe.
- Valid test Checkout: one processed event, one paid purchase, exactly ten
  credits.
- Duplicate completion delivery: no additional credits.
- Webhook delivered before dashboard return: dashboard immediately shows paid.
- Dashboard returns before webhook: confirming transitions to paid after event.
- Webhook temporarily fails: Stripe replay completes the same purchase once.
- Expired or canceled Session: no credits.
- Wrong account, mode, amount, currency, Price, user, or metadata: rejected and
  recorded without granting credits.

## Rollout order

1. Capture production evidence and affected identifiers without secrets.
2. Disable new generation and Checkout.
3. Correct Gemini and Stripe environment configuration and redeploy.
4. Replay and verify the pending test payment.
5. Settle and verify abandoned extraction reservations.
6. Implement and test independent stale-reservation settlement.
7. Move generation to a leased background job.
8. Add payment readiness checks and pending-purchase reconciliation.
9. Run the full synthetic and test-mode verification matrix.
10. Re-enable production features and monitor terminal-state and refund metrics.

## Completion criteria

The incident is not closed until:

- no charged extraction remains indefinitely in `processing`;
- every failed or expired charged extraction is refunded exactly once;
- same-request retries remain idempotent;
- production uses a supported Gemini model;
- dense synthetic extraction completes within the chosen worker runtime;
- Checkout cannot start without an operational webhook configuration;
- the pending test purchase is reconciled from Stripe's authoritative state;
- duplicate webhook delivery cannot grant duplicate credits; and
- the operational recovery steps and deploy/migration order have been exercised
  in a disposable environment before production.
