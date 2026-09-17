# PRD: Identity Guard & Anti-Abuse System

## Status

This document defines the **target state**. It does not claim that every requirement is deployed.

The codebase currently has an authenticated extraction route, database-backed administrator lookup, server-created Stripe Checkout and signature-verified webhook routes, plus forward SQL migrations for atomic credit reservations, private audit records, verified-email eligibility, one-time trial provisioning, idempotent payment fulfillment, and payment review holds. Deployment of those migrations and live Stripe test-mode behavior are unverified. Rate limiting is separate post-MVP work.

## 1. Goal and scope

SoloSheet offers one trial sheet to eligible students, then sells a $3.00 package of 10 credits through Stripe. The MVP should deter obvious credit farming through eligibility checks and atomic credit use without collecting device fingerprints.

This policy applies to Google-authenticated users. It is not proof of active enrollment: an `.edu` address is only an eligibility signal. Support for non-US institutions or an explicit list of approved schools is a separate product decision.

## 2. Authentication and identity

### 2.1 Eligibility enforcement

- The server-side signup path is the source of truth for eligibility. It must reject non-`.edu` addresses unless the address is in a server-managed administrator allowlist.
- Google or Supabase domain controls may be used as an additional convenience check, but they cannot be the only enforcement point and cannot implement database-based administrator exceptions.
- The allowlist must be private: ordinary clients cannot read or change it. Adding or removing an entry requires a secure administrator workflow and an audit event.
- Eligibility is evaluated from the verified identity returned by Supabase Auth, never from client-provided email fields.

### 2.2 Identity mapping

- A profile is keyed by the Supabase Auth user ID, not by an email address or an application-created Google `sub` column.
- The same Google account should retain the same Supabase identity across sign-ins. The application does not promise to merge separate Google accounts simply because their emails look like institutional aliases.
- If stronger alias prevention becomes necessary, evaluate a school-specific verified identifier or a user-approved account-linking flow. Do not infer ownership from similar email addresses.

## 3. Trial, administrator, and anti-abuse policy

### 3.1 Trial credit policy

- A new eligible non-admin profile receives exactly one trial credit.
- Credits are reserved atomically before extraction so concurrent requests cannot spend the same trial or paid credit twice.
- SoloSheet does not collect, store, or use browser or device fingerprints for eligibility, trial decisions, or account review.
- Monitor aggregate, privacy-minimized signup and extraction metrics before introducing any new anti-abuse control. Any future control requires its own documented policy and privacy review.

### 3.2 Administrator access

- Administrators are managed by the private database allowlist as the single server-controlled source of truth.
- An administrator’s unlimited status is enforced inside the atomic credit-reservation operation, not only in UI or application code.
- Administrator actions and bypassed extractions are audit logged. A finite placeholder balance such as `9999` is not a substitute for an unlimited-role policy.

## 4. Stripe payments and fulfillment

### 4.1 Checkout creation

- An authenticated server route creates a Stripe Checkout Session for one server-configured $3.00 / 10-credit Price ID, currency, and quantity. The client cannot choose the amount, quantity, or target user.
- The route sets the authenticated Supabase user ID as `client_reference_id` and records a pending purchase with the Checkout Session ID.
- Stripe processes payments; SoloSheet remains responsible for applicable tax, consumer, and privacy obligations. Assess Stripe Tax before selling outside the intended market.

### 4.2 Webhook fulfillment

- A server-only webhook route verifies the Stripe signature against the unmodified raw request body before parsing it.
- Fulfill only the expected event for a Checkout Session that belongs to the recorded user and has `payment_status = paid`. If delayed payment methods are enabled, handle their later success event instead of granting credits early.
- In one database transaction, record the unique Stripe event ID, record payment/session ID, amount, currency, package, and grant exactly 10 credits. A repeated event must return success without granting again.
- Only return a successful webhook response after the transaction commits; safely retry database failures.
- Refunds, disputes, and chargebacks create an auditable account hold for manual review. Do not silently remove already-spent credits until a refund policy is defined.

## 5. Acceptance criteria

- [ ] An authenticated user with a non-`.edu` verified email cannot receive a profile or trial credit unless a server-managed allowlist entry exists; ordinary clients cannot read or modify that allowlist.
- [ ] The same Supabase Auth identity always resolves to one profile and one credit balance. Separate Google accounts are not falsely merged from email similarity.
- [ ] A new eligible non-admin profile receives exactly one trial credit, and concurrent extraction attempts cannot spend that credit more than once.
- [ ] No browser or device fingerprint is collected, stored, or used in signup, trial, or review workflows.
- [ ] Administrator unlimited status is enforced by the credit reservation transaction, survives concurrent requests, and produces an audit record for each bypassed extraction.
- [ ] A user cannot create a Stripe Checkout Session for another user, alter the configured price/package, or receive credits before the session is paid.
- [ ] A valid paid Stripe Checkout yields exactly 10 credits once. Invalid signatures, unexpected event types, unpaid sessions, duplicate events, concurrent deliveries, and transaction retries cannot create extra credits.
- [ ] Refund, dispute, and chargeback events are recorded and put the account into the documented review path.

## 6. Delivery prerequisites

Before declaring this PRD complete, apply and verify all relevant Supabase migrations in a non-production environment, add regression coverage for the acceptance criteria, and exercise Stripe in test mode. Update product copy that still advertises three free credits when the one-credit trial is actually deployed. Shared rate limiting and signup-velocity controls are separate post-MVP work tracked in `TODO.md`.
