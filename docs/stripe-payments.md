# Stripe payment deployment and test-mode verification

SoloSheet sells one server-controlled package: 10 credits for $3.00 USD. The
browser sends no price, quantity, amount, currency, or target user. Checkout is
card-only for the MVP.

## Configuration

Create a one-time $3.00 USD Price in Stripe test mode and configure these values
only in the server environment:

Use a dedicated Stripe account for SoloSheet's MVP. The out-of-order event
ledger intentionally retains unmatched refund/dispute events until a matching
Checkout completion arrives; sharing the account with unrelated products would
mix their financial identifiers into that recovery path.

```env
STRIPE_SECRET_KEY=<test-mode secret key>
STRIPE_WEBHOOK_SECRET=<test endpoint signing secret>
STRIPE_PRICE_ID=<one-time $3.00 USD Price ID>
APP_URL=https://your-app.example
```

`APP_URL` may use HTTP only in local development. Apply the ordered Supabase
migrations through `migration_phase14_storage_abuse_controls.sql` before
deploying the matching routes.

## Webhook endpoint

Configure `/api/webhooks/stripe` for:

- `checkout.session.completed`
- `checkout.session.expired`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.closed`

The route reads the untouched request text before verifying the Stripe signature.
Only a paid $3.00 USD Checkout tied to a server-created pending purchase grants
10 credits. Duplicate event IDs and different completion events for an already
paid purchase do not grant again. Expired sessions are terminalized, while a
late verified paid event remains authoritative so a customer is never charged
without receiving the purchased credits. The dashboard polls an authenticated,
user-bound status endpoint after Stripe redirects back; the query string itself
never grants credits.

Refunds and disputes retain the existing balance, record the financial event,
and place the account under review. A lost dispute upgrades the existing dispute
hold to `chargeback`; later lower-severity events cannot downgrade that state.
Events that arrive before Checkout completion are retained and reconciled when
the matching PaymentIntent is attached. Holds are not automatically released.
An account with an active hold cannot start a new Checkout Session or extraction.

Release a hold only after manual review through the audited server-only process
in [administrator operations](admin-operations.md). The current policy fulfills
a valid paid purchase even if a hold was placed between session creation and
webhook delivery, but the account remains blocked from spending credits until
the hold is reviewed.

## Local test mode

Forward Stripe test events to the local application:

```sh
stripe listen --forward-to http://127.0.0.1:3000/api/webhooks/stripe
```

Use the signing secret printed by the Stripe CLI as `STRIPE_WEBHOOK_SECRET`, then
complete Checkout with a Stripe test card. Verify the purchase is `paid`, the
balance increases by exactly 10 once, and repeated delivery of the same event
does not change the balance. Exercise expiration, refund, dispute, out-of-order
delivery, and duplicate delivery separately. Rotate to a second test Price only
after creating an unpaid session and verify that the old session can still be
fulfilled from its recorded package values.

Do not use live mode or real payment details for routine verification.

The Stripe CLI is optional. It is only required for forwarding sandbox events to
localhost. For a deployed test environment, register its public HTTPS webhook
URL in Stripe and use that endpoint's signing secret instead.

## Changing Stripe mode or account

Do not replace a test/live secret or move SoloSheet to another Stripe account
while an open Checkout Session exists. A Session created by the old account or
mode can still charge a customer, but the new credentials cannot retrieve it or
verify its webhook. SoloSheet therefore preserves the pending purchase and
returns a conflict instead of silently canceling it locally.

Before changing `STRIPE_SECRET_KEY` or its owning account:

1. Using the old credentials, stop new deployments from creating Checkout
   Sessions and expire or allow every open Session to finish.
2. Keep the old webhook endpoint active until all completion/expiration events
   are successfully recorded and no purchase remains pending.
3. Change the secret, Price, and endpoint signing secret together. Confirm they
   all belong to the same dedicated Stripe account and mode.
4. Deploy, create one low-risk test Checkout, and verify its signed webhook and
   dashboard balance before reopening payments.

If Checkout reports an account-change conflict, restore the old credentials and
complete this drain procedure. Do not delete or locally cancel the purchase row;
a late verified paid event remains authoritative.
