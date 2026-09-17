# Stripe payment deployment and test-mode verification

SoloSheet sells one server-controlled package: 10 credits for $3.00 USD. The
browser sends no price, quantity, amount, currency, or target user. Checkout is
card-only for the MVP.

## Configuration

Create a one-time $3.00 USD Price in Stripe test mode and configure these values
only in the server environment:

```env
STRIPE_SECRET_KEY=<test-mode secret key>
STRIPE_WEBHOOK_SECRET=<test endpoint signing secret>
STRIPE_PRICE_ID=<one-time $3.00 USD Price ID>
APP_URL=https://your-app.example
```

`APP_URL` may use HTTP only in local development. Apply the ordered Supabase
migrations through `migration_phase12_stripe_payments.sql` before deploying the
matching routes.

## Webhook endpoint

Configure `/api/webhooks/stripe` for:

- `checkout.session.completed`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.closed`

The route reads the untouched request text before verifying the Stripe signature.
Only a paid $3.00 USD Checkout tied to a server-created pending purchase grants
10 credits. Duplicate event IDs and different completion events for an already
paid purchase do not grant again.

Refunds and disputes retain the existing balance, record the financial event,
and place the account under review. A lost dispute upgrades the existing dispute
hold to `chargeback`. Holds are not automatically released. An account with an
active hold cannot start a new Checkout Session or extraction.

## Local test mode

Forward Stripe test events to the local application:

```sh
stripe listen --forward-to http://127.0.0.1:3000/api/webhooks/stripe
```

Use the signing secret printed by the Stripe CLI as `STRIPE_WEBHOOK_SECRET`, then
complete Checkout with a Stripe test card. Verify the purchase is `paid`, the
balance increases by exactly 10 once, and repeated delivery of the same event
does not change the balance. Exercise a test refund and dispute separately.

Do not use live mode or real payment details for routine verification.

The Stripe CLI is optional. It is only required for forwarding sandbox events to
localhost. For a deployed test environment, register its public HTTPS webhook
URL in Stripe and use that endpoint's signing secret instead.
