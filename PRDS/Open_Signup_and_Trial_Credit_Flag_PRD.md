# PRD: Open Signup and Configurable Trial Credit Eligibility

**Status:** Implemented locally; hosted deployment and live OAuth unverified
**Created:** 2026-09-18
**Last updated:** 2026-09-18
**Priority:** P0 / initial-release blocker
**Owner:** Solo project maintainer

## Executive Summary

SoloSheet must allow every user with a valid, verified Google identity to create an account and sign in, regardless of email domain. Educational-email eligibility must no longer be an authentication or account-creation requirement.

New `.edu` users always receive one promotional credit. New non-`.edu` users receive one promotional credit only when a server-controlled feature flag is enabled. The flag will be enabled for the initial release so every new non-administrator account begins with one free credit. The maintainer can later disable the flag without a deployment; after that change, new non-`.edu` accounts begin with zero credits but retain full account access and can purchase credits.

The flag affects trial allocation at profile creation only. It does not revoke credits, grant credits retroactively, change existing balances, or affect paid credits. Trial allocation remains one-time and idempotent.

## Problem Statement

### Historical state before this implementation

The Phase 10 identity migration enforced `.edu` eligibility inside
`public.handle_new_user()`. A verified non-`.edu` Google identity caused the
trigger to raise an exception, preventing normal account/profile creation. That
historical policy is superseded by this PRD and the Phase 17 forward migration.

This combines two separate product decisions:

1. whether a verified person may have a SoloSheet account; and
2. whether that new account receives a promotional credit.

As a result, prospective users outside US `.edu` domains cannot access SoloSheet at all, including users who are willing to purchase credits. It also prevents an inclusive launch while limiting the ability to narrow the promotion later if abuse or cost becomes material.

### Desired state

Account eligibility, promotional-credit eligibility, and paid-credit access are independent:

- **Account eligibility:** every valid, verified Google user.
- **Promotional-credit eligibility:** every new `.edu` account, plus new non-`.edu` accounts when the feature flag is enabled.
- **Paid-credit access:** every valid account that is not otherwise held or restricted.

### Why now

This is required before the initial public release. Launch should minimize signup friction and let all new users experience one generated sheet, while preserving a rapid, reversible way to stop granting the promotion to new non-`.edu` accounts.

## Goals & Objectives

### Goals

1. Allow all verified Google users to create and access a SoloSheet account.
2. Give exactly one promotional credit to every eligible new non-administrator account.
3. Launch with non-`.edu` trial eligibility enabled.
4. Allow the maintainer to enable or disable non-`.edu` trial eligibility without deploying application code.
5. Preserve existing accounts, balances, trial history, administrator behavior, and paid-credit access.
6. Make eligibility decisions deterministic, auditable, atomic, and safe under repeated authentication callbacks.
7. Show zero-credit users a usable dashboard and purchase path instead of an authentication failure.

## Scope

### In scope

- Open account creation for every valid, verified Google user.
- One-time promotional-credit allocation for `.edu` users and flag-eligible non-`.edu` users.
- A server-controlled, auditable flag that is enabled for the initial release.
- A usable zero-credit dashboard and paid-credit path.
- Forward database migration, regression coverage, operational documentation, and rollout verification.

### Out of scope

- Proving current enrollment or student status.
- Supporting additional educational-domain lists such as `.ac.uk` in this release.
- Granting or revoking credits retroactively when the flag changes.
- Giving a second promotion after an email, provider, or eligibility change.
- Replacing Google/Supabase authentication.
- Changing administrator unlimited access, Stripe package size, pricing, extraction charging, or refund policy.
- Introducing device fingerprinting, shared rate limiting, referral credits, coupons, or a general-purpose experimentation platform.

## Policy and Definitions

### 4.1 Definitions

- **Verified account:** a Supabase Auth identity created through Google whose email is present and verified by the authentication flow.
- **Educational email:** the normalized verified email matches the existing case-insensitive `.edu` suffix policy. Client-provided email values are never authoritative.
- **Promotional credit:** the single free extraction credit that may be granted when a non-administrator profile is first created.
- **Non-`.edu` trial flag:** the server-controlled boolean setting that determines whether a newly created non-`.edu` profile receives the promotional credit.
- **Initial release state:** non-`.edu` trial flag enabled.

### 4.2 Required decision table

| Verified identity | Administrator | Email class | Flag state at first profile creation | Account/profile created | Initial finite credits | Trial recorded |
|---|---:|---|---:|---:|---:|---:|
| No | Any | Any | Any | No | N/A | No |
| Yes | Yes | Any | Any | Yes | 0 | No; administrator policy applies |
| Yes | No | `.edu` | On or off | Yes | 1 | Yes |
| Yes | No | non-`.edu` | On | Yes | 1 | Yes |
| Yes | No | non-`.edu` | Off | Yes | 0 | No |

### 4.3 Flag semantics

- The launch default is **On**.
- The flag is read by the authoritative server/database provisioning path when a profile is first created.
- The setting must fail closed for promotional cost: if it cannot be read reliably, a non-`.edu` profile is still created but starts with zero credits. `.edu` provisioning remains eligible for one credit.
- Changing the flag affects only non-`.edu` profiles created after the committed change.
- Switching the flag Off does not remove an already granted or paid credit.
- Switching the flag On does not backfill existing non-`.edu` zero-credit accounts.
- Repeat login, OAuth callback retry, concurrent callback, profile repair, or application retry must not grant an additional credit.
- Only the maintainer, using an authenticated server-side maintenance workflow, may change the flag. Ordinary authenticated and anonymous clients cannot read or modify private configuration unless a separate sanitized status is intentionally exposed.
- Every flag change records the actor, old value, new value, timestamp, reason, and correlation identifier.

## User Personas

### New user with an educational email

Wants to sign in quickly, receive the standing student promotion, and generate a first cheat sheet. This user must receive one credit regardless of the non-`.edu` flag.

### New user without an educational email

Wants to use SoloSheet even without a `.edu` address. At launch this user receives one credit; if the promotion is later narrowed, the user still receives an account, sees a clear zero-credit state, and can buy credits.

### Solo project maintainer

Wants to stop or resume promotional credit grants to future non-`.edu` signups quickly if cost or abuse changes, without disrupting authentication or existing balances.

## User Stories & Requirements

### Story 1 — Open account creation

As a user with a verified Google identity, I want to create a SoloSheet account regardless of my email domain, So that I can use or purchase the service.

**Acceptance Criteria:**

- Given a verified `.edu` Google identity, when the user signs in for the first time, then exactly one profile is created and the user reaches the dashboard.
- Given a verified non-`.edu` Google identity, when the user signs in for the first time, then exactly one profile is created and the user reaches the dashboard regardless of the flag state.
- Given an unverified or missing email identity, when provisioning is attempted, then no profile or promotional credit is created and the request fails safely.
- No supported verified email domain produces an “educational domains only” authentication error.

### Story 2 — One-time trial allocation

As an eligible new user, I want one promotional credit when my profile is created, So that I can experience SoloSheet before purchasing credits.

**Acceptance Criteria:**

- A new non-administrator `.edu` profile receives exactly one credit whether the flag is On or Off.
- A new non-administrator non-`.edu` profile receives exactly one credit when the flag is On.
- A new non-administrator non-`.edu` profile receives zero credits when the flag is Off.
- Repeat and concurrent provisioning attempts never produce more than one profile, one trial record, or one promotional credit.
- A promotional grant creates an audit event identifying the eligibility basis as `edu_email` or `non_edu_launch_promotion` without exposing unnecessary identity data.
- An ineligible zero-credit profile does not receive a trial-granted timestamp or event.

### Story 3 — Safe flag operation

As a solo project maintainer, I want to change non-`.edu` trial eligibility without a deployment, So that I can respond quickly to launch cost or abuse.

**Acceptance Criteria:**

- The maintainer can read the current authoritative value and intentionally set it On or Off through a documented, authenticated workflow.
- Anonymous users and ordinary authenticated users cannot change the setting.
- Every change is auditable with actor, reason, old/new value, timestamp, and correlation identifier.
- A committed flag change applies deterministically to subsequent profile creations.
- The runbook documents verification, rollback, and recovery if a change fails partway.

### Story 4 — Zero-credit account experience

As a user who starts with zero credits, I want to access my dashboard and purchase credits, So that promotional ineligibility does not make my account unusable.

**Acceptance Criteria:**

- A zero-credit user can sign in, sign out, view the dashboard, and access the normal purchase flow.
- Extraction remains blocked until the user has a paid or promotional credit.
- The dashboard uses the existing zero-credit state and does not describe the user as ineligible to hold an account.
- Successful Stripe fulfillment adds paid credits exactly once regardless of email domain or current flag state.

### Story 5 — Existing-account preservation

As an existing user, I want this rollout to preserve my account and balance, So that a policy change does not alter credits I already own.

**Acceptance Criteria:**

- The migration does not overwrite existing profile balances or `trial_granted_at` values.
- Turning the flag On or Off does not change any existing balance.
- Existing non-`.edu` authenticated identities that lack a profile because of the old restriction have a documented, idempotent repair path; repair follows an explicitly documented eligibility rule and cannot duplicate a trial.
- Administrator allowlist behavior and unlimited extraction enforcement remain unchanged.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-01 | Remove `.edu` as a condition for verified account/profile creation. | P0 |
| FR-02 | Keep `.edu` as an unconditional signal for one promotional credit. | P0 |
| FR-03 | Add one authoritative boolean flag for new non-`.edu` promotional grants, enabled for launch. | P0 |
| FR-04 | Evaluate and record trial eligibility atomically during first profile creation. | P0 |
| FR-05 | Preserve existing balances and make all provisioning retries idempotent. | P0 |
| FR-06 | Permit zero-credit users to access checkout and receive paid credits. | P0 |
| FR-07 | Restrict and audit flag changes through a documented maintainer workflow. | P0 |
| FR-08 | Emit privacy-minimized events sufficient to segment signup and trial outcomes by eligibility basis. | P1 |

## Non-Functional Requirements

- **Security:** Verified Supabase Auth identity is authoritative. Client input cannot select email class, flag state, initial balance, or target user.
- **Atomicity:** Profile creation, promotional grant, trial marker, and grant audit event succeed as one transaction or do not grant a credit.
- **Idempotency:** One Supabase Auth user ID maps to one profile and at most one promotional grant.
- **Privacy:** Metrics and audit data must avoid device fingerprints and unnecessary raw identity data.
- **Operability:** The flag can be inspected and changed without a code deployment, with least-privilege access and written maintenance instructions.
- **Reliability:** Failure to read optional non-`.edu` promotion configuration must not block verified account creation.
- **Compatibility:** Existing extraction reservation, administrator bypass, account-hold, and Stripe fulfillment behavior remains intact.

## Design & UX Requirements

- Sign-in and landing-page copy must not state or imply that a `.edu` address is required to create an account.
- While the flag is On, public copy may continue to say “1 free credit” only if every supported new non-administrator account reliably receives it.
- Before turning the flag Off, public copy must be updated so it does not promise a free credit to all users. Acceptable copy may distinguish the `.edu` promotion without implying non-`.edu` users cannot create an account.
- A new non-`.edu` user who receives zero credits must land on the normal dashboard with the existing zero-credit purchase call to action.
- Authentication errors must describe actual identity failures, not trial eligibility.

## Technical Considerations

### Implementation impact

- Phase 17 replaces `public.handle_new_user()` so verified non-`.edu` emails are
  accepted and the decision table is evaluated transactionally.
- Phase 17 changes the `profiles.credits` default to zero and explicitly sets
  every provisioned balance, preventing a flag-Off account from inheriting a
  promotional credit.
- `trial_granted_at` and audit events reflect actual promotional grants, not
  profile creation.
- Historical migration files remain historical. Forward Phases 16 and 17 and
  the generated bootstrap contain the current local implementation.
- The anti-abuse and implementation documents have been reconciled to treat
  `.edu` as a trial signal rather than an account requirement.

### Configuration and access

The specific schema is an implementation detail, but the authoritative flag must be available inside the database transaction that creates the profile. An environment-only value read by Next.js is insufficient if the database trigger remains the provisioning authority. The control plane must support:

- one canonical boolean value;
- a known launch value of On;
- service-role or stronger write restriction;
- an audited mutation function or equivalent controlled workflow;
- explicit behavior when the row/value is missing; and
- read-after-write verification in the maintenance instructions.

## Timeline & Milestones

### Migration and rollout sequence

1. Inventory deployed migrations and current trigger/function definitions in a non-production environment.
2. Add the feature-flag storage and restricted maintainer workflow.
3. Replace the signup trigger/function so verified non-`.edu` users always receive profiles and the decision table is enforced.
4. Set and verify the launch value as On before opening public signup.
5. Test signup, repeat login, extraction access, zero-credit behavior, and checkout for both domain classes.
6. Deploy application copy and behavior compatible with open signup.
7. Roll back by applying a forward corrective migration; never restore the old account-blocking policy as an operational substitute for disabling non-`.edu` trials.

No deployment or migration may claim to repair historical non-`.edu` identities until their actual Supabase state is inspected. Existing balances must not be recomputed from email or the current flag.

## Success Metrics

This release uses a focused AARRR measurement plan. Baselines are not yet established and must be captured during launch rather than invented in this document.

### Launch correctness metrics

- **Verified signup success:** 100% in automated acceptance tests for both `.edu` and non-`.edu` cases in both flag states.
- **Domain-policy authentication failures:** zero production signup failures caused solely by a verified user having a non-`.edu` address.
- **Duplicate promotional grants:** zero detected duplicate trial grants per Supabase Auth user ID.
- **Flag correctness:** 100% of sampled/audited new profiles match the decision table.

### Product metrics to monitor by signup cohort

- Signup-to-dashboard completion rate, segmented by `.edu` and non-`.edu`.
- First successful extraction rate, segmented by trial eligibility basis.
- Non-`.edu` zero-credit-to-paid conversion after the flag is disabled.
- Promotional credits granted, consumed, refunded, and left unused.
- Provider cost per activated account and evidence of abnormal signup/extraction volume.

### Counter-metrics

- Authentication/profile-creation error rate must not increase after rollout.
- Paid-credit fulfillment success must not differ because of email class.
- Support contacts about account eligibility or missing promised credits must remain at zero during pre-release acceptance and be reviewed after launch.

## Test and Release Acceptance

Before release, automated or repeatable tests must cover:

- verified `.edu`, flag On: profile with one trial credit;
- verified `.edu`, flag Off: profile with one trial credit;
- verified non-`.edu`, flag On: profile with one trial credit;
- verified non-`.edu`, flag Off: profile with zero trial credits;
- unverified/missing email: no profile or trial;
- administrator identity in both flag states: unchanged administrator behavior;
- repeated and concurrent profile provisioning: no duplicate profile or credit;
- flag change authorization, audit record, read-after-write verification, and missing-setting behavior;
- existing accounts and balances before and after migration and flag changes;
- zero-credit dashboard, extraction block, Stripe Checkout creation, and idempotent paid fulfillment;
- public copy in the launch-On state and the future Off state.

Release is complete only after the forward migration is applied and verified in a non-production environment, regression tests pass, the launch flag is confirmed On, the maintenance instructions are verified, and the complete browser flow is exercised for both `.edu` and non-`.edu` test users. Production database state and live OAuth behavior remain unverified until explicitly checked.

## Risks & Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Launch promotion increases abuse or provider cost | High | Monitor cohort cost and volume; disable only future non-`.edu` grants through the flag; retain atomic credit controls. |
| Flag failure blocks signup | High | Decouple profile creation from promotion; missing/unreadable configuration yields a zero-credit non-`.edu` profile. |
| Database default accidentally grants a credit | High | Set the initial balance explicitly in the authoritative transaction and test the Off path. |
| Toggle unexpectedly changes existing balances | High | Define the flag as creation-time-only; prohibit bulk recomputation; regression-test existing profiles. |
| Marketing promises a credit after the flag is disabled | Medium | Make copy update part of the Off runbook and release checklist. |
| Existing rejected identities are handled inconsistently | Medium | Inspect actual Auth/profile state and use a documented idempotent repair policy. |
| `.edu` excludes legitimate international students | Medium | Keep account creation open; consider broader educational eligibility in a separate PRD. |

## Dependencies & Assumptions

### Dependencies

- Supabase Google OAuth continues to provide a verified email signal.
- A forward Supabase migration can replace the current provisioning function safely.
- The existing zero-credit dashboard and Stripe purchase path remain available to ordinary accounts.
- The maintainer has a secure, authenticated way to invoke the documented flag workflow.

### Assumptions

- One promotional credit equals one extraction under the current credit model.
- `.edu` matching retains the repository’s current case-insensitive suffix policy for this release.
- The initial release requires the flag to be On.
- The feature applies prospectively. Historical profile repair creates a profile
  with zero credits and no trial marker; it never performs a promotional backfill.

## Open Questions

The following decision does not block the core policy and remains outside this release:

1. **Broader educational domains:** Should future trial eligibility support verified domains such as `.ac.uk` or an institution allowlist? This should be a separate policy expansion, not inferred in this release.

## Relationship to Existing Documents

This PRD supersedes only the parts of `PRDS/Anti-Abuse_PRD.md` that restrict account creation to `.edu` users or define `.edu` as the sole trial-eligibility path. Its atomic credit, administrator, privacy, Stripe, refund, and monitoring requirements remain in force.

The repository task list remains the implementation tracker. This document defines the product behavior and release acceptance criteria; it does not claim the feature or required database migration is deployed.

## Change Log

| Version | Date | Change |
|---|---|---|
| 0.1 | 2026-09-18 | Initial draft defining open signup, launch-wide free credit, and a prospective non-`.edu` trial flag. |
| 0.2 | 2026-09-18 | Resolved historical profile repair as a zero-credit, non-promotional operation. |
| 1.0 | 2026-09-21 | Marked the feature implemented locally, added release acceptance coverage, and retained explicit hosted/OAuth deployment gates. |
