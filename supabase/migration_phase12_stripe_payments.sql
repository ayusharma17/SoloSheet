-- Apply after phase 11. Stripe routes call only these service-role functions;
-- clients never choose package values or mutate the payment ledger directly.
BEGIN;

ALTER TABLE public.stripe_purchases
  ALTER COLUMN checkout_session_id DROP NOT NULL;

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

CREATE OR REPLACE FUNCTION public.attach_stripe_checkout_session(
  p_purchase_id uuid,
  p_user_id uuid,
  p_checkout_session_id text
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
    OR length(p_checkout_session_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'Invalid Checkout Session' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND OR purchase.user_id <> p_user_id THEN
    RAISE EXCEPTION 'Pending purchase not found' USING ERRCODE = 'P0002';
  END IF;
  IF purchase.checkout_session_id IS NOT NULL
    AND purchase.checkout_session_id <> p_checkout_session_id THEN
    RAISE EXCEPTION 'Checkout Session conflict' USING ERRCODE = '23505';
  END IF;
  UPDATE public.stripe_purchases
  SET checkout_session_id = p_checkout_session_id, updated_at = now()
  WHERE id = p_purchase_id;
  RETURN jsonb_build_object('status', purchase.status, 'purchaseId', p_purchase_id);
END;
$$;

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
DECLARE
  purchase public.stripe_purchases%ROWTYPE;
  balance integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255
    OR p_purchase_id IS NULL OR p_user_id IS NULL
    OR p_checkout_session_id IS NULL OR length(p_checkout_session_id) NOT BETWEEN 1 AND 255
    OR p_payment_intent_id IS NULL OR length(p_payment_intent_id) NOT BETWEEN 1 AND 255
    OR p_price_id IS NULL OR length(p_price_id) NOT BETWEEN 1 AND 255
    OR p_amount_total <> 300 OR lower(p_currency) <> 'usd'
    OR p_livemode IS NULL OR p_stripe_created_at IS NULL THEN
    RAISE EXCEPTION 'Invalid paid Checkout Session' USING ERRCODE = '22023';
  END IF;

  SELECT credits INTO balance FROM public.profiles
  WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending purchase not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stripe_webhook_events WHERE event_id = p_event_id) THEN
    RETURN jsonb_build_object('status', 'duplicate', 'remainingCredits', balance);
  END IF;
  IF purchase.user_id <> p_user_id OR purchase.price_id <> p_price_id
    OR purchase.livemode <> p_livemode
    OR (purchase.checkout_session_id IS NOT NULL
      AND purchase.checkout_session_id <> p_checkout_session_id) THEN
    RAISE EXCEPTION 'Checkout Session does not match pending purchase' USING ERRCODE = '22023';
  END IF;

  IF purchase.status <> 'pending' THEN
    INSERT INTO public.stripe_webhook_events (
      event_id, event_type, purchase_id, outcome, livemode, stripe_created_at
    ) VALUES (
      p_event_id, 'checkout.session.completed', p_purchase_id,
      'ignored', p_livemode, p_stripe_created_at
    );
    RETURN jsonb_build_object('status', 'already_fulfilled', 'remainingCredits', balance);
  END IF;

  UPDATE public.stripe_purchases SET
    checkout_session_id = p_checkout_session_id,
    payment_intent_id = p_payment_intent_id,
    status = 'paid', paid_at = now(), updated_at = now()
  WHERE id = p_purchase_id;
  UPDATE public.profiles SET credits = credits + 10, updated_at = now()
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
      'amount_total', 300,
      'currency', 'usd',
      'credits', 10
    )
  );
  RETURN jsonb_build_object('status', 'fulfilled', 'remainingCredits', balance);
END;
$$;

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
  hold_reason text;
  purchase_status text;
  existing_hold_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255
    OR p_payment_intent_id IS NULL OR length(p_payment_intent_id) NOT BETWEEN 1 AND 255
    OR p_source_reference IS NULL OR length(p_source_reference) NOT BETWEEN 1 AND 255
    OR p_livemode IS NULL OR p_stripe_created_at IS NULL THEN
    RAISE EXCEPTION 'Invalid Stripe hold event' USING ERRCODE = '22023';
  END IF;
  CASE p_event_type
    WHEN 'charge.refunded' THEN hold_reason := 'refund'; purchase_status := 'refunded';
    WHEN 'charge.dispute.created' THEN hold_reason := 'dispute'; purchase_status := 'disputed';
    WHEN 'charge.dispute.closed' THEN hold_reason := 'chargeback'; purchase_status := 'chargeback';
    ELSE RAISE EXCEPTION 'Unsupported Stripe hold event' USING ERRCODE = '22023';
  END CASE;

  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE payment_intent_id = p_payment_intent_id;
  IF NOT FOUND THEN
    INSERT INTO public.stripe_webhook_events (
      event_id, event_type, purchase_id, outcome, livemode, stripe_created_at
    ) VALUES (
      p_event_id, p_event_type, NULL, 'ignored', p_livemode, p_stripe_created_at
    ) ON CONFLICT (event_id) DO NOTHING;
    RETURN jsonb_build_object('status', 'ignored');
  END IF;
  PERFORM 1 FROM public.profiles WHERE id = purchase.user_id FOR UPDATE;
  SELECT * INTO purchase FROM public.stripe_purchases
  WHERE payment_intent_id = p_payment_intent_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.stripe_webhook_events WHERE event_id = p_event_id) THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;
  IF purchase.livemode <> p_livemode OR purchase.status = 'pending' THEN
    RAISE EXCEPTION 'Stripe event does not match a paid purchase' USING ERRCODE = '22023';
  END IF;

  SELECT id INTO existing_hold_id FROM public.account_holds
  WHERE source = 'stripe' AND source_reference = p_source_reference
  FOR UPDATE;
  IF FOUND THEN
    UPDATE public.account_holds SET
      reason = hold_reason,
      status = 'active',
      release_reason = NULL,
      released_by = NULL,
      released_at = NULL,
      correlation_id = purchase.id,
      metadata = jsonb_build_object('stripe_event_id', p_event_id)
    WHERE id = existing_hold_id;
  ELSE
    INSERT INTO public.account_holds (
      user_id, reason, source, source_reference, correlation_id, metadata
    ) VALUES (
      purchase.user_id, hold_reason, 'stripe', p_source_reference,
      purchase.id, jsonb_build_object('stripe_event_id', p_event_id)
    );
  END IF;
  UPDATE public.stripe_purchases SET status = purchase_status, updated_at = now()
  WHERE id = purchase.id;
  INSERT INTO public.stripe_webhook_events (
    event_id, event_type, purchase_id, outcome, livemode, stripe_created_at
  ) VALUES (
    p_event_id, p_event_type, purchase.id, 'processed', p_livemode, p_stripe_created_at
  );
  INSERT INTO public.audit_events (
    event_type, subject_user_id, actor_type, reason, correlation_id, metadata
  ) VALUES (
    'payment.account_held', purchase.user_id, 'stripe_webhook',
    'Stripe refund or dispute placed the account under review', purchase.id,
    jsonb_build_object(
      'stripe_event_id', p_event_id,
      'stripe_event_type', p_event_type,
      'hold_reason', hold_reason,
      'source_reference', p_source_reference
    )
  );
  RETURN jsonb_build_object('status', 'held');
END;
$$;

REVOKE ALL ON FUNCTION public.create_pending_stripe_purchase(uuid, uuid, text, boolean),
  public.attach_stripe_checkout_session(uuid, uuid, text),
  public.fulfill_stripe_checkout(text, uuid, uuid, text, text, text, integer, text, boolean, timestamptz),
  public.record_stripe_account_hold(text, text, text, text, boolean, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_pending_stripe_purchase(uuid, uuid, text, boolean),
  public.attach_stripe_checkout_session(uuid, uuid, text),
  public.fulfill_stripe_checkout(text, uuid, uuid, text, text, text, integer, text, boolean, timestamptz),
  public.record_stripe_account_hold(text, text, text, text, boolean, timestamptz)
  TO service_role;

COMMIT;
