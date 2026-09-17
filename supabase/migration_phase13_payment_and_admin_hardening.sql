-- Apply after phase 12. This removes legacy bootstrap identity, hardens current
-- administrator resolution, and adds recoverable Stripe event/purchase states.
BEGIN;

-- Historical phase 5 seeded an administrator in this project's deployed
-- database. Phase 5 no longer does that for fresh/open-source installs, while
-- existing deployments retain their operator until an explicit audited change.

-- Preserve the pseudonymous actor UUID after auth-account deletion. The former
-- ON DELETE SET NULL action contradicted the non-null actor integrity check and
-- prevented deletion of any administrator/user that had emitted an audit event.
ALTER TABLE public.audit_events
  DROP CONSTRAINT IF EXISTS audit_events_actor_user_id_fkey;

-- Resolve administrator privilege from the current, verified auth identity,
-- never from the profile's signup-time email snapshot.
CREATE OR REPLACE FUNCTION public.reserve_extraction(
  p_user_id uuid,
  p_request_id uuid,
  p_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.extraction_requests%ROWTYPE;
  balance integer;
  expired_count integer;
  v_is_admin boolean := false;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_request_id IS NULL OR p_fingerprint IS NULL
    OR p_fingerprint !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'Invalid request' USING ERRCODE = '22023';
  END IF;

  SELECT credits INTO balance
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'no_credits');
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM auth.users u
    JOIN public.admin_whitelist a
      ON a.email = lower(btrim(u.email)) AND a.is_active
    WHERE u.id = p_user_id
      AND u.email IS NOT NULL
      AND u.email_confirmed_at IS NOT NULL
  ) INTO v_is_admin;

  WITH expired AS (
    UPDATE public.extraction_requests SET status = 'failed'
    WHERE user_id = p_user_id AND status = 'processing'
      AND created_at < now() - interval '10 minutes'
    RETURNING charged
  )
  SELECT count(*) FILTER (WHERE charged) INTO expired_count FROM expired;
  IF expired_count > 0 THEN
    UPDATE public.profiles SET credits = credits + expired_count, updated_at = now()
    WHERE id = p_user_id RETURNING credits INTO balance;
  END IF;

  SELECT * INTO r FROM public.extraction_requests
  WHERE user_id = p_user_id AND request_id = p_request_id;
  IF FOUND THEN
    IF r.fingerprint <> p_fingerprint THEN
      RETURN jsonb_build_object('status', 'conflict');
    END IF;
    RETURN jsonb_build_object(
      'status', r.status,
      'materialId', r.material_id,
      'remainingCredits', balance
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.account_holds
    WHERE user_id = p_user_id AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('status', 'account_held', 'remainingCredits', balance);
  END IF;

  IF NOT v_is_admin THEN
    UPDATE public.profiles SET credits = credits - 1, updated_at = now()
    WHERE id = p_user_id AND credits >= 1 RETURNING credits INTO balance;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'no_credits');
    END IF;
  END IF;

  INSERT INTO public.extraction_requests (
    user_id, request_id, fingerprint, status, charged
  ) VALUES (
    p_user_id, p_request_id, p_fingerprint, 'processing', NOT v_is_admin
  );

  IF v_is_admin THEN
    INSERT INTO public.audit_events (
      event_type, subject_user_id, actor_type, actor_user_id,
      reason, correlation_id, metadata
    ) VALUES (
      'administrator.extraction_bypassed', p_user_id,
      'administrator', p_user_id,
      'Unlimited administrator extraction reserved', p_request_id,
      jsonb_build_object('request_id', p_request_id)
    );
  END IF;

  RETURN jsonb_build_object('status', 'reserved', 'remainingCredits', balance);
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_extraction(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_extraction(uuid, uuid, text)
  TO service_role;

-- Serialize administrator authorization with revocation of that same actor.
-- Once a revocation commits, a waiting operation rechecks and fails closed.
CREATE OR REPLACE FUNCTION public.set_administrator_access(
  p_email text,
  p_enabled boolean,
  p_actor_user_id uuid,
  p_reason text,
  p_correlation_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_email text;
  target_user_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_email IS NULL OR p_enabled IS NULL OR p_actor_user_id IS NULL
    OR p_correlation_id IS NULL OR p_reason IS NULL
    OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Complete administrator change details are required' USING ERRCODE = '22023';
  END IF;

  normalized_email := lower(btrim(p_email));
  IF normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    OR length(normalized_email) > 320 THEN
    RAISE EXCEPTION 'Invalid administrator email' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM auth.users AS actor
  JOIN public.admin_whitelist AS admin
    ON admin.email = lower(btrim(actor.email))
  WHERE actor.id = p_actor_user_id
    AND actor.email IS NOT NULL
    AND actor.email_confirmed_at IS NOT NULL
    AND admin.is_active
  FOR SHARE OF actor, admin;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active administrator required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.admin_whitelist (
    email, is_active, reason, created_by, updated_at
  ) VALUES (
    normalized_email, p_enabled, btrim(p_reason), p_actor_user_id, now()
  )
  ON CONFLICT (email) DO UPDATE SET
    is_active = excluded.is_active,
    reason = excluded.reason,
    updated_at = now();

  SELECT id INTO target_user_id
  FROM auth.users
  WHERE lower(btrim(email)) = normalized_email
  LIMIT 1;

  INSERT INTO public.audit_events (
    event_type, subject_user_id, actor_type, actor_user_id,
    reason, correlation_id, metadata
  ) VALUES (
    CASE WHEN p_enabled
      THEN 'administrator.access_granted'
      ELSE 'administrator.access_revoked'
    END,
    target_user_id, 'administrator', p_actor_user_id,
    btrim(p_reason), p_correlation_id,
    jsonb_build_object('target_email', normalized_email)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_account_hold(
  p_hold_id uuid,
  p_actor_user_id uuid,
  p_reason text,
  p_correlation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  hold_row public.account_holds%ROWTYPE;
  target_user_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_hold_id IS NULL OR p_actor_user_id IS NULL OR p_correlation_id IS NULL
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Complete hold release details are required' USING ERRCODE = '22023';
  END IF;

  -- Lock the administrator entry so a concurrent revocation cannot race this
  -- authorization decision.
  PERFORM 1
  FROM auth.users u
  JOIN public.admin_whitelist a
    ON a.email = lower(btrim(u.email))
  WHERE u.id = p_actor_user_id
    AND u.email IS NOT NULL
    AND u.email_confirmed_at IS NOT NULL
    AND a.is_active
  FOR SHARE OF a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active administrator required' USING ERRCODE = '42501';
  END IF;

  SELECT user_id INTO target_user_id
  FROM public.account_holds
  WHERE id = p_hold_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account hold not found' USING ERRCODE = 'P0002';
  END IF;

  -- Match payment/extraction lock order: target profile, then hold row.
  PERFORM 1 FROM public.profiles WHERE id = target_user_id FOR UPDATE;
  SELECT * INTO hold_row
  FROM public.account_holds
  WHERE id = p_hold_id
  FOR UPDATE;

  IF hold_row.status = 'released' THEN
    RETURN jsonb_build_object('status', 'already_released', 'holdId', p_hold_id);
  END IF;

  UPDATE public.account_holds SET
    status = 'released',
    release_reason = btrim(p_reason),
    released_by = p_actor_user_id,
    released_at = now(),
    correlation_id = p_correlation_id
  WHERE id = p_hold_id;

  INSERT INTO public.audit_events (
    event_type, subject_user_id, actor_type, actor_user_id,
    reason, correlation_id, metadata
  ) VALUES (
    'account_hold.released', hold_row.user_id, 'administrator', p_actor_user_id,
    btrim(p_reason), p_correlation_id,
    jsonb_build_object(
      'hold_id', p_hold_id,
      'hold_reason', hold_row.reason,
      'hold_source', hold_row.source,
      'source_reference', hold_row.source_reference
    )
  );

  RETURN jsonb_build_object('status', 'released', 'holdId', p_hold_id);
END;
$$;

REVOKE ALL ON FUNCTION public.release_account_hold(uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_account_hold(uuid, uuid, text, uuid)
  TO service_role;

-- Add explicit abandoned-Checkout states and session expiry metadata.
ALTER TABLE public.stripe_purchases
  ADD COLUMN IF NOT EXISTS checkout_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS terminal_at timestamptz;

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.stripe_purchases'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.stripe_purchases DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END;
$$;

ALTER TABLE public.stripe_purchases
  ADD CONSTRAINT stripe_purchases_status_check
    CHECK (status IN (
      'pending', 'paid', 'canceled', 'expired',
      'refunded', 'disputed', 'chargeback'
    )),
  ADD CONSTRAINT stripe_purchases_payment_state_check
    CHECK (
      (status = 'pending' AND paid_at IS NULL AND terminal_at IS NULL)
      OR (status IN ('canceled', 'expired') AND paid_at IS NULL AND terminal_at IS NOT NULL)
      OR (status IN ('paid', 'refunded', 'disputed', 'chargeback')
        AND paid_at IS NOT NULL AND terminal_at IS NULL)
    );

-- Reconcile any pre-migration duplicate pending rows before enforcing one
-- active Checkout attempt per account.
WITH ranked_pending AS (
  SELECT id, row_number() OVER (
    PARTITION BY user_id ORDER BY created_at DESC, id DESC
  ) AS position
  FROM public.stripe_purchases
  WHERE status = 'pending'
)
UPDATE public.stripe_purchases p SET
  status = 'canceled', terminal_at = now(), updated_at = now()
FROM ranked_pending r
WHERE p.id = r.id AND r.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS stripe_purchases_one_pending_user_key
  ON public.stripe_purchases (user_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS stripe_purchases_pending_expiry_idx
  ON public.stripe_purchases (checkout_expires_at)
  WHERE status = 'pending';

-- Preserve unresolved signed Stripe events in the idempotency ledger until a
-- matching paid Checkout attaches its PaymentIntent.
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.stripe_webhook_events'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%outcome%'
  LOOP
    EXECUTE format('ALTER TABLE public.stripe_webhook_events DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END;
$$;
ALTER TABLE public.stripe_webhook_events
  ADD CONSTRAINT stripe_webhook_events_outcome_check
    CHECK (outcome IN ('processed', 'ignored', 'unresolved'));
CREATE INDEX IF NOT EXISTS stripe_webhook_events_unresolved_payment_idx
  ON public.stripe_webhook_events ((metadata->>'payment_intent_id'))
  WHERE outcome = 'unresolved';

CREATE OR REPLACE FUNCTION public.create_pending_stripe_purchase(
  p_purchase_id uuid,
  p_user_id uuid,
  p_price_id text,
  p_livemode boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  existing_purchase public.stripe_purchases%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_purchase_id IS NULL OR p_user_id IS NULL OR p_livemode IS NULL
    OR p_price_id IS NULL OR length(p_price_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'Invalid pending purchase' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.account_holds
    WHERE user_id = p_user_id AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('status', 'held');
  END IF;

  -- Terminalize only attempts whose authoritative expiry has passed, plus an
  -- unattached worker abandoned before it could create a Stripe Session.
  UPDATE public.stripe_purchases SET
    status = CASE WHEN checkout_expires_at IS NOT NULL THEN 'expired' ELSE 'canceled' END,
    terminal_at = now(), updated_at = now()
  WHERE user_id = p_user_id AND status = 'pending'
    AND (
      checkout_expires_at <= now()
      OR (checkout_session_id IS NULL AND created_at < now() - interval '10 minutes')
    );

  SELECT * INTO existing_purchase
  FROM public.stripe_purchases
  WHERE user_id = p_user_id AND status = 'pending'
  FOR UPDATE;
  IF FOUND AND existing_purchase.livemode <> p_livemode THEN
    -- Never hide an old-mode Session: it may still be chargeable. Operators
    -- must drain/expire it with the old Stripe credentials before switching.
    RETURN jsonb_build_object(
      'status', 'environment_conflict',
      'purchaseId', existing_purchase.id,
      'checkoutSessionId', existing_purchase.checkout_session_id,
      'checkoutExpiresAt', existing_purchase.checkout_expires_at
    );
  END IF;
  IF existing_purchase.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'pending_exists',
      'purchaseId', existing_purchase.id,
      'checkoutSessionId', existing_purchase.checkout_session_id,
      'checkoutExpiresAt', existing_purchase.checkout_expires_at
    );
  END IF;

  INSERT INTO public.stripe_purchases (
    id, user_id, checkout_session_id, price_id, amount_total, currency,
    credit_amount, quantity, status, livemode
  ) VALUES (
    p_purchase_id, p_user_id, NULL, p_price_id, 300, 'usd',
    10, 1, 'pending', p_livemode
  );
  RETURN jsonb_build_object('status', 'pending', 'purchaseId', p_purchase_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.attach_stripe_checkout_session_v2(
  p_purchase_id uuid,
  p_user_id uuid,
  p_checkout_session_id text,
  p_checkout_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  purchase public.stripe_purchases%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_purchase_id IS NULL OR p_user_id IS NULL OR p_checkout_session_id IS NULL
    OR length(p_checkout_session_id) NOT BETWEEN 1 AND 255
    OR (p_checkout_expires_at IS NOT NULL AND p_checkout_expires_at <= now()) THEN
    RAISE EXCEPTION 'Invalid Checkout Session' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND OR purchase.user_id <> p_user_id THEN
    RAISE EXCEPTION 'Pending purchase not found' USING ERRCODE = 'P0002';
  END IF;
  IF purchase.status <> 'pending' THEN
    RETURN jsonb_build_object('status', purchase.status, 'purchaseId', p_purchase_id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.account_holds
    WHERE user_id = p_user_id AND status = 'active'
  ) THEN
    UPDATE public.stripe_purchases SET
      status = 'canceled', terminal_at = now(), updated_at = now()
    WHERE id = p_purchase_id;
    RETURN jsonb_build_object('status', 'held', 'purchaseId', p_purchase_id);
  END IF;
  IF purchase.checkout_session_id IS NOT NULL
    AND purchase.checkout_session_id <> p_checkout_session_id THEN
    RAISE EXCEPTION 'Checkout Session conflict' USING ERRCODE = '23505';
  END IF;
  UPDATE public.stripe_purchases SET
    checkout_session_id = p_checkout_session_id,
    checkout_expires_at = p_checkout_expires_at,
    updated_at = now()
  WHERE id = p_purchase_id;
  RETURN jsonb_build_object('status', 'pending', 'purchaseId', p_purchase_id);
END;
$$;

-- Backward-compatible wrapper for a rolling deploy. New callers should pass
-- Stripe's Session expires_at through the v2 function.
CREATE OR REPLACE FUNCTION public.attach_stripe_checkout_session(
  p_purchase_id uuid,
  p_user_id uuid,
  p_checkout_session_id text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.attach_stripe_checkout_session_v2(
    p_purchase_id, p_user_id, p_checkout_session_id, NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.close_pending_stripe_purchase(
  p_purchase_id uuid,
  p_user_id uuid,
  p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  purchase public.stripe_purchases%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_purchase_id IS NULL OR p_user_id IS NULL OR p_status IS NULL
    OR p_status NOT IN ('canceled', 'expired') THEN
    RAISE EXCEPTION 'Invalid pending purchase closure' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND OR purchase.user_id <> p_user_id THEN
    RAISE EXCEPTION 'Pending purchase not found' USING ERRCODE = 'P0002';
  END IF;
  IF purchase.status <> 'pending' THEN
    RETURN jsonb_build_object('status', purchase.status, 'purchaseId', p_purchase_id);
  END IF;
  UPDATE public.stripe_purchases SET
    status = p_status, terminal_at = now(), updated_at = now()
  WHERE id = p_purchase_id;
  RETURN jsonb_build_object('status', p_status, 'purchaseId', p_purchase_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_expired_stripe_checkout(
  p_event_id text,
  p_purchase_id uuid,
  p_user_id uuid,
  p_checkout_session_id text,
  p_livemode boolean,
  p_stripe_created_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  purchase public.stripe_purchases%ROWTYPE;
  outcome text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255
    OR p_purchase_id IS NULL OR p_user_id IS NULL
    OR p_checkout_session_id IS NULL OR length(p_checkout_session_id) NOT BETWEEN 1 AND 255
    OR p_livemode IS NULL OR p_stripe_created_at IS NULL THEN
    RAISE EXCEPTION 'Invalid expired Checkout Session' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO purchase FROM public.stripe_purchases WHERE id = p_purchase_id;
  IF NOT FOUND THEN
    RETURN public.record_rejected_stripe_event(
      p_event_id, 'checkout.session.expired', p_livemode,
      p_stripe_created_at, 'expired_purchase_missing'
    );
  END IF;
  PERFORM 1 FROM public.profiles WHERE id = purchase.user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE id = p_purchase_id FOR UPDATE;
  IF purchase.user_id <> p_user_id OR purchase.livemode <> p_livemode
    OR (purchase.checkout_session_id IS NOT NULL
      AND purchase.checkout_session_id <> p_checkout_session_id) THEN
    RETURN public.record_rejected_stripe_event(
      p_event_id, 'checkout.session.expired', p_livemode,
      p_stripe_created_at, 'expired_identity_mismatch'
    );
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.stripe_webhook_events WHERE event_id = p_event_id
  ) THEN
    RETURN jsonb_build_object('status', 'duplicate', 'purchaseId', p_purchase_id);
  END IF;

  IF purchase.status IN ('pending', 'canceled', 'expired') THEN
    UPDATE public.stripe_purchases SET
      checkout_session_id = p_checkout_session_id,
      status = 'expired',
      terminal_at = coalesce(terminal_at, now()),
      updated_at = now()
    WHERE id = p_purchase_id;
    outcome := 'processed';
  ELSE
    outcome := 'ignored';
  END IF;

  INSERT INTO public.stripe_webhook_events (
    event_id, event_type, purchase_id, outcome, livemode, stripe_created_at
  ) VALUES (
    p_event_id, 'checkout.session.expired', p_purchase_id,
    outcome, p_livemode, p_stripe_created_at
  );
  INSERT INTO public.audit_events (
    event_type, subject_user_id, actor_type, reason, correlation_id, metadata
  ) VALUES (
    'payment.checkout_expired', p_user_id, 'stripe_webhook',
    CASE WHEN outcome = 'processed'
      THEN 'Stripe Checkout Session expired without payment'
      ELSE 'Late Checkout expiration observed after payment fulfillment'
    END,
    p_purchase_id,
    jsonb_build_object(
      'stripe_event_id', p_event_id,
      'checkout_session_id', p_checkout_session_id,
      'outcome', outcome
    )
  );
  RETURN jsonb_build_object(
    'status', CASE WHEN outcome = 'processed' THEN 'expired' ELSE 'already_fulfilled' END,
    'purchaseId', p_purchase_id
  );
END;
$$;

-- Permanently malformed but correctly signed relevant events are committed to
-- the idempotency/audit ledger. Stripe may then receive 2xx without retrying
-- an event that can never become valid, while database failures still retry.
CREATE OR REPLACE FUNCTION public.record_rejected_stripe_event(
  p_event_id text,
  p_event_type text,
  p_livemode boolean,
  p_stripe_created_at timestamptz,
  p_validation_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255
    OR p_event_type IS NULL OR length(p_event_type) NOT BETWEEN 1 AND 255
    OR p_livemode IS NULL OR p_stripe_created_at IS NULL
    OR p_validation_code IS NULL OR p_validation_code NOT IN (
      'paid_session_identity_missing',
      'paid_session_package_mismatch',
      'expired_session_identity_missing',
      'checkout_purchase_missing',
      'checkout_identity_mismatch',
      'expired_purchase_missing',
      'expired_identity_mismatch'
    ) THEN
    RAISE EXCEPTION 'Invalid rejected Stripe event' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.stripe_webhook_events (
    event_id, event_type, purchase_id, outcome, livemode,
    stripe_created_at, metadata
  ) VALUES (
    p_event_id, p_event_type, NULL, 'ignored', p_livemode,
    p_stripe_created_at, jsonb_build_object('validation_code', p_validation_code)
  ) ON CONFLICT (event_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;

  INSERT INTO public.audit_events (
    event_type, subject_user_id, actor_type, reason, metadata
  ) VALUES (
    'payment.webhook_rejected', NULL, 'stripe_webhook',
    'A signed relevant Stripe event failed permanent validation',
    jsonb_build_object(
      'stripe_event_id', p_event_id,
      'stripe_event_type', p_event_type,
      'validation_code', p_validation_code,
      'livemode', p_livemode
    )
  );
  RETURN jsonb_build_object('status', 'rejected');
END;
$$;

-- Non-financial abandoned attempts can be removed after a cooling-off period.
-- Purchases referenced by an auditable webhook event remain subject to the
-- financial retention policy and are deliberately not deleted here.
CREATE OR REPLACE FUNCTION public.purge_abandoned_stripe_purchases(
  p_before timestamptz,
  p_limit integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_before IS NULL OR p_before > now() - interval '30 days'
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Invalid abandoned purchase retention request' USING ERRCODE = '22023';
  END IF;
  WITH candidates AS (
    SELECT p.id
    FROM public.stripe_purchases p
    WHERE p.status IN ('canceled', 'expired')
      AND p.paid_at IS NULL
      AND p.terminal_at < p_before
      AND NOT EXISTS (
        SELECT 1 FROM public.stripe_webhook_events e
        WHERE e.purchase_id = p.id
      )
    ORDER BY p.terminal_at, p.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM public.stripe_purchases p
    USING candidates c
    WHERE p.id = c.id
    RETURNING p.id
  )
  SELECT count(*) INTO deleted_count FROM deleted;
  RETURN deleted_count;
END;
$$;

-- Internal helper. Callers must already hold the target profile and purchase
-- locks in that order. It never writes the webhook idempotency row itself.
CREATE OR REPLACE FUNCTION public.apply_stripe_hold_event(
  p_purchase_id uuid,
  p_event_id text,
  p_event_type text,
  p_source_reference text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  purchase public.stripe_purchases%ROWTYPE;
  existing_hold public.account_holds%ROWTYPE;
  hold_reason text;
  purchase_status text;
  desired_rank integer;
  current_rank integer;
  hold_rank integer;
  effective_reason text;
  changed boolean := false;
BEGIN
  CASE p_event_type
    WHEN 'charge.refunded' THEN
      hold_reason := 'refund'; purchase_status := 'refunded'; desired_rank := 1;
    WHEN 'charge.dispute.created' THEN
      hold_reason := 'dispute'; purchase_status := 'disputed'; desired_rank := 2;
    WHEN 'charge.dispute.closed' THEN
      hold_reason := 'chargeback'; purchase_status := 'chargeback'; desired_rank := 3;
    ELSE
      RAISE EXCEPTION 'Unsupported Stripe hold event' USING ERRCODE = '22023';
  END CASE;

  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND OR purchase.paid_at IS NULL THEN
    RAISE EXCEPTION 'Paid purchase not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO existing_hold FROM public.account_holds
  WHERE source = 'stripe' AND source_reference = p_source_reference
  FOR UPDATE;
  IF FOUND THEN
    hold_rank := CASE existing_hold.reason
      WHEN 'refund' THEN 1 WHEN 'dispute' THEN 2 WHEN 'chargeback' THEN 3 ELSE 0
    END;
    effective_reason := CASE WHEN hold_rank > desired_rank
      THEN existing_hold.reason ELSE hold_reason END;
    UPDATE public.account_holds SET
      reason = effective_reason,
      status = 'active',
      release_reason = NULL,
      released_by = NULL,
      released_at = NULL,
      correlation_id = purchase.id,
      metadata = metadata || jsonb_build_object('stripe_event_id', p_event_id)
    WHERE id = existing_hold.id;
    changed := existing_hold.status <> 'active' OR effective_reason <> existing_hold.reason;
  ELSE
    INSERT INTO public.account_holds (
      user_id, reason, source, source_reference, correlation_id, metadata
    ) VALUES (
      purchase.user_id, hold_reason, 'stripe', p_source_reference,
      purchase.id, jsonb_build_object('stripe_event_id', p_event_id)
    );
    changed := true;
  END IF;

  current_rank := CASE purchase.status
    WHEN 'refunded' THEN 1 WHEN 'disputed' THEN 2 WHEN 'chargeback' THEN 3 ELSE 0
  END;
  IF desired_rank > current_rank THEN
    UPDATE public.stripe_purchases SET status = purchase_status, updated_at = now()
    WHERE id = purchase.id;
    changed := true;
  END IF;

  INSERT INTO public.audit_events (
    event_type, subject_user_id, actor_type, reason, correlation_id, metadata
  ) VALUES (
    'payment.account_held', purchase.user_id, 'stripe_webhook',
    'Stripe refund or dispute placed the account under review', purchase.id,
    jsonb_build_object(
      'stripe_event_id', p_event_id,
      'stripe_event_type', p_event_type,
      'hold_reason', hold_reason,
      'source_reference', p_source_reference,
      'state_changed', changed
    )
  );
  RETURN changed;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_stripe_hold_event(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_stripe_account_hold(
  p_event_id text,
  p_event_type text,
  p_payment_intent_id text,
  p_source_reference text,
  p_livemode boolean,
  p_stripe_created_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  purchase public.stripe_purchases%ROWTYPE;
  event_outcome text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255
    OR p_event_type IS NULL OR p_event_type NOT IN (
      'charge.refunded', 'charge.dispute.created', 'charge.dispute.closed'
    )
    OR p_payment_intent_id IS NULL OR length(p_payment_intent_id) NOT BETWEEN 1 AND 255
    OR p_source_reference IS NULL OR length(p_source_reference) NOT BETWEEN 1 AND 255
    OR p_livemode IS NULL OR p_stripe_created_at IS NULL THEN
    RAISE EXCEPTION 'Invalid Stripe hold event' USING ERRCODE = '22023';
  END IF;

  -- Serialize hold delivery against fulfillment for the same PaymentIntent.
  -- Without this lock, fulfillment could scan just before an unresolved event
  -- is inserted, leaving a valid hold permanently unreconciled.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_payment_intent_id, 0)
  );

  SELECT outcome INTO event_outcome
  FROM public.stripe_webhook_events
  WHERE event_id = p_event_id;
  IF FOUND AND event_outcome <> 'unresolved' THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;

  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE payment_intent_id = p_payment_intent_id;
  IF NOT FOUND THEN
    INSERT INTO public.stripe_webhook_events (
      event_id, event_type, purchase_id, outcome, livemode,
      stripe_created_at, metadata
    ) VALUES (
      p_event_id, p_event_type, NULL, 'unresolved', p_livemode,
      p_stripe_created_at,
      jsonb_build_object(
        'payment_intent_id', p_payment_intent_id,
        'source_reference', p_source_reference
      )
    ) ON CONFLICT (event_id) DO NOTHING;
    RETURN jsonb_build_object('status', 'unresolved');
  END IF;

  PERFORM 1 FROM public.profiles WHERE id = purchase.user_id FOR UPDATE;
  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE id = purchase.id FOR UPDATE;
  IF purchase.livemode <> p_livemode OR purchase.paid_at IS NULL THEN
    RAISE EXCEPTION 'Stripe event does not match a paid purchase' USING ERRCODE = '22023';
  END IF;

  PERFORM public.apply_stripe_hold_event(
    purchase.id, p_event_id, p_event_type, p_source_reference
  );
  IF event_outcome = 'unresolved' THEN
    UPDATE public.stripe_webhook_events SET
      purchase_id = purchase.id,
      outcome = 'processed',
      processed_at = now()
    WHERE event_id = p_event_id;
  ELSE
    INSERT INTO public.stripe_webhook_events (
      event_id, event_type, purchase_id, outcome, livemode, stripe_created_at,
      metadata
    ) VALUES (
      p_event_id, p_event_type, purchase.id, 'processed', p_livemode,
      p_stripe_created_at,
      jsonb_build_object(
        'payment_intent_id', p_payment_intent_id,
        'source_reference', p_source_reference
      )
    );
  END IF;
  RETURN jsonb_build_object('status', 'held');
END;
$$;

CREATE OR REPLACE FUNCTION public.fulfill_stripe_checkout_v2(
  p_event_id text,
  p_purchase_id uuid,
  p_user_id uuid,
  p_checkout_session_id text,
  p_payment_intent_id text,
  p_amount_total integer,
  p_currency text,
  p_livemode boolean,
  p_stripe_created_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  purchase public.stripe_purchases%ROWTYPE;
  unresolved public.stripe_webhook_events%ROWTYPE;
  balance integer;
  reconciled_count integer := 0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255
    OR p_purchase_id IS NULL OR p_user_id IS NULL
    OR p_checkout_session_id IS NULL OR length(p_checkout_session_id) NOT BETWEEN 1 AND 255
    OR p_payment_intent_id IS NULL OR length(p_payment_intent_id) NOT BETWEEN 1 AND 255
    OR p_amount_total <> 300 OR p_currency IS NULL OR lower(p_currency) <> 'usd'
    OR p_livemode IS NULL OR p_stripe_created_at IS NULL THEN
    RAISE EXCEPTION 'Invalid paid Checkout Session' USING ERRCODE = '22023';
  END IF;

  -- Use the same first lock as hold delivery so an unresolved event is always
  -- visible before this transaction's reconciliation scan, or else observes
  -- this transaction's attached PaymentIntent and processes synchronously.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_payment_intent_id, 0)
  );

  SELECT * INTO purchase FROM public.stripe_purchases WHERE id = p_purchase_id;
  IF NOT FOUND THEN
    RETURN public.record_rejected_stripe_event(
      p_event_id, 'checkout.session.completed', p_livemode,
      p_stripe_created_at, 'checkout_purchase_missing'
    );
  END IF;
  SELECT credits INTO balance FROM public.profiles
  WHERE id = purchase.user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE id = p_purchase_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.stripe_webhook_events WHERE event_id = p_event_id
  ) THEN
    RETURN jsonb_build_object('status', 'duplicate', 'remainingCredits', balance);
  END IF;
  IF purchase.user_id <> p_user_id OR purchase.livemode <> p_livemode
    OR purchase.amount_total <> p_amount_total
    OR purchase.currency <> lower(p_currency)
    OR purchase.credit_amount <> 10 OR purchase.quantity <> 1
    OR (purchase.checkout_session_id IS NOT NULL
      AND purchase.checkout_session_id <> p_checkout_session_id) THEN
    RETURN public.record_rejected_stripe_event(
      p_event_id, 'checkout.session.completed', p_livemode,
      p_stripe_created_at, 'checkout_identity_mismatch'
    );
  END IF;

  IF purchase.status IN ('paid', 'refunded', 'disputed', 'chargeback') THEN
    INSERT INTO public.stripe_webhook_events (
      event_id, event_type, purchase_id, outcome, livemode, stripe_created_at
    ) VALUES (
      p_event_id, 'checkout.session.completed', p_purchase_id,
      'ignored', p_livemode, p_stripe_created_at
    );
    RETURN jsonb_build_object('status', 'already_fulfilled', 'remainingCredits', balance);
  END IF;

  -- A canceled/expired local attempt can still have succeeded at Stripe. A
  -- verified paid event is authoritative and must not strand customer funds.
  UPDATE public.stripe_purchases SET
    checkout_session_id = p_checkout_session_id,
    payment_intent_id = p_payment_intent_id,
    status = 'paid', paid_at = now(), terminal_at = NULL, updated_at = now()
  WHERE id = p_purchase_id;
  UPDATE public.profiles SET credits = credits + purchase.credit_amount, updated_at = now()
  WHERE id = p_user_id RETURNING credits INTO balance;
  INSERT INTO public.stripe_webhook_events (
    event_id, event_type, purchase_id, outcome, livemode, stripe_created_at
  ) VALUES (
    p_event_id, 'checkout.session.completed', p_purchase_id,
    'processed', p_livemode, p_stripe_created_at
  );
  INSERT INTO public.audit_events (
    event_type, subject_user_id, actor_type, reason, correlation_id, metadata
  ) VALUES (
    'payment.credits_granted', p_user_id, 'stripe_webhook',
    'Paid Stripe Checkout granted 10 credits', p_purchase_id,
    jsonb_build_object(
      'stripe_event_id', p_event_id,
      'checkout_session_id', p_checkout_session_id,
      'amount_total', p_amount_total,
      'currency', lower(p_currency),
      'credits', purchase.credit_amount,
      'configured_price_id', purchase.price_id
    )
  );

  FOR unresolved IN
    SELECT * FROM public.stripe_webhook_events
    WHERE outcome = 'unresolved'
      AND livemode = p_livemode
      AND metadata->>'payment_intent_id' = p_payment_intent_id
    ORDER BY stripe_created_at, event_id
    FOR UPDATE
  LOOP
    PERFORM public.apply_stripe_hold_event(
      p_purchase_id,
      unresolved.event_id,
      unresolved.event_type,
      unresolved.metadata->>'source_reference'
    );
    UPDATE public.stripe_webhook_events SET
      purchase_id = p_purchase_id,
      outcome = 'processed',
      processed_at = now()
    WHERE event_id = unresolved.event_id;
    reconciled_count := reconciled_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'fulfilled',
    'remainingCredits', balance,
    'reconciledEvents', reconciled_count
  );
END;
$$;

-- Rolling-deploy compatibility. The event-supplied/current configured Price ID
-- is deliberately not used for authorization; the immutable pending purchase
-- stores the Price that created the Session.
CREATE OR REPLACE FUNCTION public.fulfill_stripe_checkout(
  p_event_id text,
  p_purchase_id uuid,
  p_user_id uuid,
  p_checkout_session_id text,
  p_payment_intent_id text,
  p_price_id text,
  p_amount_total integer,
  p_currency text,
  p_livemode boolean,
  p_stripe_created_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_price_id IS NULL OR length(p_price_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'Invalid configured Price' USING ERRCODE = '22023';
  END IF;
  RETURN public.fulfill_stripe_checkout_v2(
    p_event_id, p_purchase_id, p_user_id, p_checkout_session_id,
    p_payment_intent_id, p_amount_total, p_currency, p_livemode,
    p_stripe_created_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_stripe_purchase_status(
  p_user_id uuid,
  p_checkout_session_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  purchase_status text;
  balance integer;
  held boolean;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_checkout_session_id IS NULL
    OR length(p_checkout_session_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'Invalid purchase status request' USING ERRCODE = '22023';
  END IF;

  SELECT purchase.status, profile.credits INTO purchase_status, balance
  FROM public.stripe_purchases AS purchase
  JOIN public.profiles AS profile ON profile.id = purchase.user_id
  WHERE purchase.user_id = p_user_id
    AND purchase.checkout_session_id = p_checkout_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.account_holds
    WHERE user_id = p_user_id AND status = 'active'
  ) INTO held;
  RETURN jsonb_build_object(
    'status', purchase_status,
    'remainingCredits', balance,
    'accountHeld', held
  );
END;
$$;

-- Server routes retain narrow reads, while all financial, hold, and audit
-- mutations must pass through owner-defined transactions.
REVOKE INSERT, UPDATE, DELETE ON public.profiles,
  public.account_holds,
  public.stripe_purchases,
  public.stripe_webhook_events,
  public.audit_events
  FROM service_role;
REVOKE ALL ON FUNCTION public.add_credits(uuid, integer),
  public.decrement_credits(uuid)
  FROM service_role;

REVOKE ALL ON FUNCTION public.create_pending_stripe_purchase(uuid, uuid, text, boolean),
  public.attach_stripe_checkout_session_v2(uuid, uuid, text, timestamptz),
  public.attach_stripe_checkout_session(uuid, uuid, text),
  public.close_pending_stripe_purchase(uuid, uuid, text),
  public.record_expired_stripe_checkout(text, uuid, uuid, text, boolean, timestamptz),
  public.record_rejected_stripe_event(text, text, boolean, timestamptz, text),
  public.purge_abandoned_stripe_purchases(timestamptz, integer),
  public.get_stripe_purchase_status(uuid, text),
  public.record_stripe_account_hold(text, text, text, text, boolean, timestamptz),
  public.fulfill_stripe_checkout_v2(text, uuid, uuid, text, text, integer, text, boolean, timestamptz),
  public.fulfill_stripe_checkout(text, uuid, uuid, text, text, text, integer, text, boolean, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_pending_stripe_purchase(uuid, uuid, text, boolean),
  public.attach_stripe_checkout_session_v2(uuid, uuid, text, timestamptz),
  public.attach_stripe_checkout_session(uuid, uuid, text),
  public.close_pending_stripe_purchase(uuid, uuid, text),
  public.record_expired_stripe_checkout(text, uuid, uuid, text, boolean, timestamptz),
  public.record_rejected_stripe_event(text, text, boolean, timestamptz, text),
  public.purge_abandoned_stripe_purchases(timestamptz, integer),
  public.get_stripe_purchase_status(uuid, text),
  public.record_stripe_account_hold(text, text, text, text, boolean, timestamptz),
  public.fulfill_stripe_checkout_v2(text, uuid, uuid, text, text, integer, text, boolean, timestamptz),
  public.fulfill_stripe_checkout(text, uuid, uuid, text, text, text, integer, text, boolean, timestamptz)
  TO service_role;

COMMIT;
