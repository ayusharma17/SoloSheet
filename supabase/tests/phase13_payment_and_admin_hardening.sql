-- Run as database owner against an isolated database after phase 13.
-- All fixtures and writes roll back. Never run against production.
BEGIN;

INSERT INTO public.admin_whitelist (email, reason) VALUES
  ('current-admin@example.com', 'Phase 13 administrator fixture'),
  ('stale-admin@example.com', 'Phase 13 stale-profile fixture');

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'current-admin@example.com', now()),
  ('e0000000-0000-4000-8000-000000000002', 'stale-admin@example.com', now()),
  ('e0000000-0000-4000-8000-000000000003', 'hold-target@school.edu', now()),
  ('e0000000-0000-4000-8000-000000000004', 'ordinary-actor@school.edu', now()),
  ('e0000000-0000-4000-8000-000000000005', 'deletion-actor@school.edu', now()),
  ('e0000000-0000-4000-8000-000000000006', 'payments-hardening@school.edu', now());

-- A profile snapshot must neither confer nor remove administrator privilege.
UPDATE public.profiles SET email = 'old-profile@school.edu'
WHERE id = 'e0000000-0000-4000-8000-000000000001';
UPDATE auth.users SET email = 'demoted@school.edu'
WHERE id = 'e0000000-0000-4000-8000-000000000002';

SELECT set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL ROLE service_role;

DO $$
DECLARE
  result jsonb;
BEGIN
  result := public.reserve_extraction(
    'e0000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000001', repeat('a', 64)
  );
  IF result->>'status' <> 'reserved' THEN
    RAISE EXCEPTION 'Current verified administrator identity was not honored';
  END IF;
  IF (SELECT charged FROM public.extraction_requests
      WHERE user_id = 'e0000000-0000-4000-8000-000000000001'
        AND request_id = 'e1000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'Current administrator extraction was charged';
  END IF;

  result := public.reserve_extraction(
    'e0000000-0000-4000-8000-000000000002',
    'e1000000-0000-4000-8000-000000000002', repeat('b', 64)
  );
  IF result->>'status' <> 'no_credits' THEN
    RAISE EXCEPTION 'Stale profile email retained administrator privilege';
  END IF;
END;
$$;

RESET ROLE;

-- Removing an auth identity must not erase or invalidate its audit actor UUID.
INSERT INTO public.audit_events (
  event_type, subject_user_id, actor_type, actor_user_id, reason
) VALUES (
  'administrator.test_action',
  'e0000000-0000-4000-8000-000000000003',
  'administrator',
  'e0000000-0000-4000-8000-000000000005',
  'Phase 13 actor deletion fixture'
);
DELETE FROM auth.users
WHERE id = 'e0000000-0000-4000-8000-000000000005';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.audit_events
    WHERE event_type = 'administrator.test_action'
      AND actor_user_id = 'e0000000-0000-4000-8000-000000000005'
  ) THEN
    RAISE EXCEPTION 'Audit actor identity was erased or blocked account deletion';
  END IF;
END;
$$;

INSERT INTO public.account_holds (
  id, user_id, reason, source, source_reference
) VALUES (
  'e2000000-0000-4000-8000-000000000001',
  'e0000000-0000-4000-8000-000000000003',
  'manual_review', 'system', 'phase13-manual-hold'
);

SELECT set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL ROLE service_role;

DO $$
DECLARE
  result jsonb;
BEGIN
  BEGIN
    PERFORM public.release_account_hold(
      'e2000000-0000-4000-8000-000000000001',
      'e0000000-0000-4000-8000-000000000004',
      'Unauthorized release attempt',
      'e3000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'Ordinary user released an account hold';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  result := public.release_account_hold(
    'e2000000-0000-4000-8000-000000000001',
    'e0000000-0000-4000-8000-000000000001',
    'Manual review completed',
    'e3000000-0000-4000-8000-000000000002'
  );
  IF result->>'status' <> 'released' THEN
    RAISE EXCEPTION 'Administrator hold release failed';
  END IF;
  result := public.release_account_hold(
    'e2000000-0000-4000-8000-000000000001',
    'e0000000-0000-4000-8000-000000000001',
    'Idempotent retry',
    'e3000000-0000-4000-8000-000000000003'
  );
  IF result->>'status' <> 'already_released' THEN
    RAISE EXCEPTION 'Hold release retry was not idempotent';
  END IF;
END;
$$;

RESET ROLE;
DO $$
BEGIN
  IF (SELECT status FROM public.account_holds
      WHERE id = 'e2000000-0000-4000-8000-000000000001') <> 'released' THEN
    RAISE EXCEPTION 'Released hold remained active';
  END IF;
  IF (SELECT count(*) FROM public.audit_events
      WHERE event_type = 'account_hold.released'
        AND correlation_id = 'e3000000-0000-4000-8000-000000000002') <> 1 THEN
    RAISE EXCEPTION 'Hold release was not audited exactly once';
  END IF;
END;
$$;

UPDATE public.profiles SET credits = 0
WHERE id = 'e0000000-0000-4000-8000-000000000006';
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL ROLE service_role;

-- A second request reuses the one active Checkout, and the v2 attach records
-- Stripe's authoritative session expiry.
SELECT public.create_pending_stripe_purchase(
  'e4000000-0000-4000-8000-000000000001',
  'e0000000-0000-4000-8000-000000000006',
  'price_legacy', false
);
SELECT public.attach_stripe_checkout_session_v2(
  'e4000000-0000-4000-8000-000000000001',
  'e0000000-0000-4000-8000-000000000006',
  'cs_phase13_superseded', now() + interval '1 day'
);
DO $$
DECLARE
  result jsonb;
BEGIN
  result := public.create_pending_stripe_purchase(
    'e4000000-0000-4000-8000-000000000002',
    'e0000000-0000-4000-8000-000000000006',
    'price_current', false
  );
  IF result->>'status' <> 'pending_exists'
    OR result->>'purchaseId' <> 'e4000000-0000-4000-8000-000000000001'
    OR result->>'checkoutSessionId' <> 'cs_phase13_superseded' THEN
    RAISE EXCEPTION 'Existing active Checkout was not reused';
  END IF;
  IF (SELECT status FROM public.stripe_purchases
      WHERE id = 'e4000000-0000-4000-8000-000000000001') <> 'pending' THEN
    RAISE EXCEPTION 'Active Checkout was unexpectedly terminalized';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stripe_purchases
      WHERE id = 'e4000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'Duplicate active Checkout row was inserted';
  END IF;
  IF (SELECT count(*) FROM public.stripe_purchases
      WHERE user_id = 'e0000000-0000-4000-8000-000000000006'
        AND status = 'pending') <> 1 THEN
    RAISE EXCEPTION 'More than one pending purchase remains active';
  END IF;
END;
$$;

SELECT public.close_pending_stripe_purchase(
  'e4000000-0000-4000-8000-000000000001',
  'e0000000-0000-4000-8000-000000000006',
  'canceled'
);
SELECT public.create_pending_stripe_purchase(
  'e4000000-0000-4000-8000-000000000002',
  'e0000000-0000-4000-8000-000000000006',
  'price_current', false
);

-- A valid late paid event remains authoritative even after local cancellation,
-- and fulfillment uses the purchase's stored Price rather than current config.
SELECT public.fulfill_stripe_checkout_v2(
  'evt_phase13_late_paid',
  'e4000000-0000-4000-8000-000000000001',
  'e0000000-0000-4000-8000-000000000006',
  'cs_phase13_superseded', 'pi_phase13_legacy',
  300, 'usd', false, now()
);

SELECT public.record_expired_stripe_checkout(
  'evt_phase13_expired',
  'e4000000-0000-4000-8000-000000000002',
  'e0000000-0000-4000-8000-000000000006',
  'cs_phase13_expired', false, now()
);
SELECT public.record_expired_stripe_checkout(
  'evt_phase13_expired',
  'e4000000-0000-4000-8000-000000000002',
  'e0000000-0000-4000-8000-000000000006',
  'cs_phase13_expired', false, now()
);

-- A pending Session from the other Stripe mode must never be retrieved with
-- the current environment's key.
SELECT public.create_pending_stripe_purchase(
  'e4000000-0000-4000-8000-000000000004',
  'e0000000-0000-4000-8000-000000000006',
  'price_test_mode', false
);
DO $$
DECLARE
  result jsonb;
BEGIN
  result := public.create_pending_stripe_purchase(
    'e4000000-0000-4000-8000-000000000005',
    'e0000000-0000-4000-8000-000000000006',
    'price_live_mode', true
  );
  IF result->>'status' <> 'environment_conflict'
    OR result->>'purchaseId' <> 'e4000000-0000-4000-8000-000000000004' THEN
    RAISE EXCEPTION 'Cross-mode pending Checkout was not blocked';
  END IF;
  IF (SELECT status FROM public.stripe_purchases
      WHERE id = 'e4000000-0000-4000-8000-000000000004') <> 'pending' THEN
    RAISE EXCEPTION 'Chargeable prior-mode Checkout was terminalized locally';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stripe_purchases
      WHERE id = 'e4000000-0000-4000-8000-000000000005') THEN
    RAISE EXCEPTION 'A new Checkout was created during an environment conflict';
  END IF;
END;
$$;
SELECT public.close_pending_stripe_purchase(
  'e4000000-0000-4000-8000-000000000004',
  'e0000000-0000-4000-8000-000000000006',
  'canceled'
);

-- Deliver a lost dispute before the matching Checkout completion. It must be
-- retained as unresolved, then reconciled atomically by fulfillment.
SELECT public.record_stripe_account_hold(
  'evt_phase13_dispute_lost', 'charge.dispute.closed',
  'pi_phase13_out_of_order', 'dp_phase13_out_of_order', false,
  now() - interval '1 minute'
);
SELECT public.create_pending_stripe_purchase(
  'e4000000-0000-4000-8000-000000000003',
  'e0000000-0000-4000-8000-000000000006',
  'price_rotated_away_later', false
);
SELECT public.attach_stripe_checkout_session_v2(
  'e4000000-0000-4000-8000-000000000003',
  'e0000000-0000-4000-8000-000000000006',
  'cs_phase13_out_of_order', now() + interval '1 day'
);
SELECT public.fulfill_stripe_checkout_v2(
  'evt_phase13_checkout',
  'e4000000-0000-4000-8000-000000000003',
  'e0000000-0000-4000-8000-000000000006',
  'cs_phase13_out_of_order', 'pi_phase13_out_of_order',
  300, 'usd', false, now()
);

-- Later lower-severity events cannot downgrade chargeback state or its dispute
-- hold, even when they have distinct valid Stripe event IDs.
SELECT public.record_stripe_account_hold(
  'evt_phase13_dispute_created_late', 'charge.dispute.created',
  'pi_phase13_out_of_order', 'dp_phase13_out_of_order', false, now()
);
SELECT public.record_stripe_account_hold(
  'evt_phase13_refund_late', 'charge.refunded',
  'pi_phase13_out_of_order', 'ch_phase13_refund', false, now()
);

RESET ROLE;
DO $$
BEGIN
  IF (SELECT credits FROM public.profiles
      WHERE id = 'e0000000-0000-4000-8000-000000000006') <> 20 THEN
    RAISE EXCEPTION 'Late/rotated-price fulfillment did not grant exactly twice';
  END IF;
  IF (SELECT status FROM public.stripe_purchases
      WHERE id = 'e4000000-0000-4000-8000-000000000002') <> 'expired' THEN
    RAISE EXCEPTION 'Pending purchase expiration was not recorded';
  END IF;
  IF (SELECT count(*) FROM public.stripe_webhook_events
      WHERE event_id = 'evt_phase13_expired'
        AND event_type = 'checkout.session.expired'
        AND outcome = 'processed') <> 1 THEN
    RAISE EXCEPTION 'Checkout expiration was not idempotently recorded';
  END IF;
  IF (SELECT count(*) FROM public.audit_events
      WHERE event_type = 'payment.checkout_expired'
        AND correlation_id = 'e4000000-0000-4000-8000-000000000002') <> 1 THEN
    RAISE EXCEPTION 'Checkout expiration was not audited exactly once';
  END IF;
  IF (SELECT status FROM public.stripe_purchases
      WHERE id = 'e4000000-0000-4000-8000-000000000003') <> 'chargeback' THEN
    RAISE EXCEPTION 'Lower-severity event downgraded chargeback state';
  END IF;
  IF (SELECT reason FROM public.account_holds
      WHERE source = 'stripe' AND source_reference = 'dp_phase13_out_of_order')
      <> 'chargeback' THEN
    RAISE EXCEPTION 'Late dispute-created event downgraded chargeback hold';
  END IF;
  IF (SELECT outcome FROM public.stripe_webhook_events
      WHERE event_id = 'evt_phase13_dispute_lost') <> 'processed' THEN
    RAISE EXCEPTION 'Out-of-order dispute was not reconciled';
  END IF;
  IF (SELECT purchase_id FROM public.stripe_webhook_events
      WHERE event_id = 'evt_phase13_dispute_lost')
      <> 'e4000000-0000-4000-8000-000000000003'::uuid THEN
    RAISE EXCEPTION 'Reconciled dispute was not linked to its purchase';
  END IF;
END;
$$;

SELECT set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL ROLE service_role;
SELECT public.record_rejected_stripe_event(
  'evt_phase13_rejected', 'checkout.session.completed', false, now(),
  'paid_session_package_mismatch'
);
SELECT public.record_rejected_stripe_event(
  'evt_phase13_rejected', 'checkout.session.completed', false, now(),
  'paid_session_package_mismatch'
);
SELECT public.fulfill_stripe_checkout_v2(
  'evt_phase13_unknown_purchase',
  'e4000000-0000-4000-8000-000000000099',
  'e0000000-0000-4000-8000-000000000006',
  'cs_phase13_unknown', 'pi_phase13_unknown',
  300, 'usd', false, now()
);
SELECT public.fulfill_stripe_checkout_v2(
  'evt_phase13_wrong_identity',
  'e4000000-0000-4000-8000-000000000003',
  'e0000000-0000-4000-8000-000000000004',
  'cs_phase13_wrong', 'pi_phase13_wrong',
  300, 'usd', false, now()
);
SELECT public.record_expired_stripe_checkout(
  'evt_phase13_unknown_expiration',
  'e4000000-0000-4000-8000-000000000098',
  'e0000000-0000-4000-8000-000000000006',
  'cs_phase13_unknown_expiration', false, now()
);
DO $$
DECLARE
  result jsonb;
BEGIN
  result := public.get_stripe_purchase_status(
    'e0000000-0000-4000-8000-000000000006',
    'cs_phase13_out_of_order'
  );
  IF result->>'status' <> 'chargeback'
    OR (result->>'remainingCredits')::integer <> 20
    OR (result->>'accountHeld')::boolean IS NOT true THEN
    RAISE EXCEPTION 'Atomic purchase status returned inconsistent state';
  END IF;
  IF (SELECT count(*) FROM public.stripe_webhook_events
      WHERE event_id = 'evt_phase13_rejected' AND outcome = 'ignored') <> 1
    OR (SELECT count(*) FROM public.audit_events
      WHERE event_type = 'payment.webhook_rejected'
        AND metadata->>'stripe_event_id' = 'evt_phase13_rejected') <> 1 THEN
    RAISE EXCEPTION 'Rejected signed webhook was not recorded idempotently';
  END IF;
  IF (SELECT count(*) FROM public.stripe_webhook_events
      WHERE event_id IN (
        'evt_phase13_unknown_purchase',
        'evt_phase13_wrong_identity',
        'evt_phase13_unknown_expiration'
      ) AND outcome = 'ignored') <> 3 THEN
    RAISE EXCEPTION 'Permanent database-level webhook mismatch was not acknowledged';
  END IF;

  BEGIN
    UPDATE public.account_holds SET status = 'released'
    WHERE source_reference = 'dp_phase13_out_of_order';
    RAISE EXCEPTION 'Service role directly mutated an account hold';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.add_credits(
      'e0000000-0000-4000-8000-000000000006', 100
    );
    RAISE EXCEPTION 'Service role executed retired generic credit grant';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;

SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.release_account_hold(
      'e2000000-0000-4000-8000-000000000001',
      'e0000000-0000-4000-8000-000000000001',
      'Client bypass', gen_random_uuid()
    );
    RAISE EXCEPTION 'Authenticated client executed hold release';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.get_stripe_purchase_status(
      'e0000000-0000-4000-8000-000000000006',
      'cs_phase13_out_of_order'
    );
    RAISE EXCEPTION 'Authenticated client read private purchase status';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.fulfill_stripe_checkout_v2(
      'evt_client_bypass',
      'e4000000-0000-4000-8000-000000000003',
      'e0000000-0000-4000-8000-000000000006',
      'cs_phase13_out_of_order', 'pi_phase13_out_of_order',
      300, 'usd', false, now()
    );
    RAISE EXCEPTION 'Authenticated client executed payment fulfillment';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;

ROLLBACK;
