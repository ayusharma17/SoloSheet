-- Apply after phase 8. This creates the private database foundation for the
-- anti-abuse/payment MVP without wiring signup, extraction, or Stripe routes.
BEGIN;

-- The database allowlist is the canonical administrator source. Phase 10 will
-- update application and reservation code to consult active entries here.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.admin_whitelist
    GROUP BY lower(btrim(email))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Normalize duplicate administrator emails before phase 9';
  END IF;
END;
$$;

UPDATE public.admin_whitelist SET email = lower(btrim(email));
ALTER TABLE public.admin_whitelist
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.admin_whitelist
  DROP CONSTRAINT IF EXISTS admin_whitelist_normalized_email,
  ADD CONSTRAINT admin_whitelist_normalized_email
    CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 320),
  DROP CONSTRAINT IF EXISTS admin_whitelist_reason_length,
  ADD CONSTRAINT admin_whitelist_reason_length
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 1000);
CREATE UNIQUE INDEX IF NOT EXISTS admin_whitelist_lower_email_key
  ON public.admin_whitelist (lower(email));
ALTER TABLE public.admin_whitelist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_whitelist FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_whitelist TO service_role;

CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL
    CHECK (event_type ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  subject_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_type text NOT NULL
    CHECK (actor_type IN ('system', 'administrator', 'user', 'stripe_webhook')),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 1000),
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  retention_until timestamptz NOT NULL DEFAULT (now() + interval '1 year'),
  CHECK (retention_until > created_at),
  CHECK (
    (actor_type IN ('administrator', 'user') AND actor_user_id IS NOT NULL)
    OR
    (actor_type IN ('system', 'stripe_webhook') AND actor_user_id IS NULL)
  )
);
CREATE INDEX audit_events_subject_created_idx
  ON public.audit_events (subject_user_id, created_at DESC);
CREATE INDEX audit_events_type_created_idx
  ON public.audit_events (event_type, created_at DESC);
CREATE INDEX audit_events_retention_idx
  ON public.audit_events (retention_until);
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.audit_events TO service_role;

CREATE TABLE public.account_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason text NOT NULL
    CHECK (reason IN ('refund', 'dispute', 'chargeback', 'manual_review')),
  source text NOT NULL
    CHECK (source IN ('stripe', 'administrator', 'system')),
  source_reference text CHECK (
    source_reference IS NULL OR length(source_reference) BETWEEN 1 AND 255
  ),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released')),
  placed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  placed_at timestamptz NOT NULL DEFAULT now(),
  release_reason text CHECK (
    release_reason IS NULL OR length(release_reason) BETWEEN 1 AND 1000
  ),
  released_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  released_at timestamptz,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  retention_until timestamptz NOT NULL DEFAULT (now() + interval '7 years'),
  CHECK (
    (status = 'active' AND released_at IS NULL AND released_by IS NULL AND release_reason IS NULL)
    OR
    (status = 'released' AND released_at IS NOT NULL AND release_reason IS NOT NULL)
  ),
  CHECK (retention_until > placed_at)
);
CREATE UNIQUE INDEX account_holds_source_reference_key
  ON public.account_holds (source, source_reference)
  WHERE source_reference IS NOT NULL;
CREATE INDEX account_holds_active_user_idx
  ON public.account_holds (user_id, placed_at DESC)
  WHERE status = 'active';
ALTER TABLE public.account_holds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_holds FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.account_holds TO service_role;

CREATE TABLE public.stripe_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  checkout_session_id text NOT NULL UNIQUE
    CHECK (length(checkout_session_id) BETWEEN 1 AND 255),
  payment_intent_id text UNIQUE
    CHECK (payment_intent_id IS NULL OR length(payment_intent_id) BETWEEN 1 AND 255),
  stripe_customer_id text
    CHECK (stripe_customer_id IS NULL OR length(stripe_customer_id) BETWEEN 1 AND 255),
  price_id text NOT NULL CHECK (length(price_id) BETWEEN 1 AND 255),
  amount_total integer NOT NULL CHECK (amount_total = 300),
  currency text NOT NULL CHECK (currency = 'usd'),
  credit_amount integer NOT NULL CHECK (credit_amount = 10),
  quantity integer NOT NULL CHECK (quantity = 1),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'refunded', 'disputed', 'chargeback')),
  livemode boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  retention_until timestamptz NOT NULL DEFAULT (now() + interval '7 years'),
  CHECK (
    (status = 'pending' AND paid_at IS NULL)
    OR
    (status <> 'pending' AND paid_at IS NOT NULL)
  ),
  CHECK (updated_at >= created_at),
  CHECK (retention_until > created_at)
);
CREATE INDEX stripe_purchases_user_created_idx
  ON public.stripe_purchases (user_id, created_at DESC);
CREATE INDEX stripe_purchases_status_created_idx
  ON public.stripe_purchases (status, created_at);
ALTER TABLE public.stripe_purchases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stripe_purchases FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.stripe_purchases TO service_role;

-- Only committed, successfully handled events belong here. Failed webhook
-- attempts roll back so Stripe can safely retry the same event ID.
CREATE TABLE public.stripe_webhook_events (
  event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 255),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 255),
  purchase_id uuid REFERENCES public.stripe_purchases(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome IN ('processed', 'ignored')),
  livemode boolean NOT NULL,
  stripe_created_at timestamptz NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  retention_until timestamptz NOT NULL DEFAULT (now() + interval '7 years'),
  CHECK (retention_until > processed_at)
);
CREATE INDEX stripe_webhook_events_purchase_idx
  ON public.stripe_webhook_events (purchase_id, processed_at DESC);
CREATE INDEX stripe_webhook_events_retention_idx
  ON public.stripe_webhook_events (retention_until);
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stripe_webhook_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.stripe_webhook_events TO service_role;

COMMIT;
