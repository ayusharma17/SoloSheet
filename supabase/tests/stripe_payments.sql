-- Run as database owner against an isolated database after phase 12.
-- All fixtures and writes roll back. Never run against production.
BEGIN;

INSERT INTO auth.users (id, email, email_confirmed_at)
VALUES ('d0000000-0000-4000-8000-000000000001', 'payments@school.edu', now());
UPDATE public.profiles SET credits = 0
WHERE id = 'd0000000-0000-4000-8000-000000000001';

SELECT set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL ROLE service_role;

SELECT public.create_pending_stripe_purchase(
  'd1000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001',
  'price_solosheet_test', false
);
SELECT public.attach_stripe_checkout_session(
  'd1000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001',
  'cs_test_solosheet_one'
);
SELECT public.fulfill_stripe_checkout(
  'evt_checkout_one',
  'd1000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001',
  'cs_test_solosheet_one', 'pi_solosheet_one', 'price_solosheet_test',
  300, 'usd', false, now()
);

DO $$
DECLARE result jsonb;
BEGIN
  IF (SELECT credits FROM public.profiles
      WHERE id = 'd0000000-0000-4000-8000-000000000001') <> 10 THEN
    RAISE EXCEPTION 'Paid Checkout did not grant exactly 10 credits';
  END IF;
  result := public.fulfill_stripe_checkout(
    'evt_checkout_one',
    'd1000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'cs_test_solosheet_one', 'pi_solosheet_one', 'price_solosheet_test',
    300, 'usd', false, now()
  );
  ASSERT result->>'status' = 'duplicate', 'duplicate Stripe event was not idempotent';
  result := public.fulfill_stripe_checkout(
    'evt_checkout_one_replayed',
    'd1000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'cs_test_solosheet_one', 'pi_solosheet_one', 'price_solosheet_test',
    300, 'usd', false, now()
  );
  ASSERT result->>'status' = 'already_fulfilled', 'second event re-fulfilled purchase';
  IF (SELECT credits FROM public.profiles
      WHERE id = 'd0000000-0000-4000-8000-000000000001') <> 10 THEN
    RAISE EXCEPTION 'Webhook replay granted extra credits';
  END IF;
END;
$$;

SELECT public.create_pending_stripe_purchase(
  'd1000000-0000-4000-8000-000000000002',
  'd0000000-0000-4000-8000-000000000001',
  'price_solosheet_test', false
);
SELECT public.attach_stripe_checkout_session(
  'd1000000-0000-4000-8000-000000000002',
  'd0000000-0000-4000-8000-000000000001',
  'cs_test_solosheet_two'
);
SELECT public.fulfill_stripe_checkout(
  'evt_checkout_two',
  'd1000000-0000-4000-8000-000000000002',
  'd0000000-0000-4000-8000-000000000001',
  'cs_test_solosheet_two', 'pi_solosheet_two', 'price_solosheet_test',
  300, 'usd', false, now()
);

SELECT public.record_stripe_account_hold(
  'evt_refund_one', 'charge.refunded', 'pi_solosheet_one',
  'ch_solosheet_one', false, now()
);
SELECT public.record_stripe_account_hold(
  'evt_refund_one', 'charge.refunded', 'pi_solosheet_one',
  'ch_solosheet_one', false, now()
);

DO $$
DECLARE result jsonb;
BEGIN
  result := public.create_pending_stripe_purchase(
    'd1000000-0000-4000-8000-000000000003',
    'd0000000-0000-4000-8000-000000000001',
    'price_solosheet_test', false
  );
  ASSERT result->>'status' = 'held', 'held account was allowed to start Checkout';
  IF EXISTS (
    SELECT 1 FROM public.stripe_purchases
    WHERE id = 'd1000000-0000-4000-8000-000000000003'
  ) THEN
    RAISE EXCEPTION 'held account created a pending purchase';
  END IF;
END;
$$;

SELECT public.record_stripe_account_hold(
  'evt_dispute_created', 'charge.dispute.created', 'pi_solosheet_two',
  'dp_solosheet_two', false, now()
);
SELECT public.record_stripe_account_hold(
  'evt_dispute_lost', 'charge.dispute.closed', 'pi_solosheet_two',
  'dp_solosheet_two', false, now()
);

DO $$
BEGIN
  IF (SELECT credits FROM public.profiles
      WHERE id = 'd0000000-0000-4000-8000-000000000001') <> 20 THEN
    RAISE EXCEPTION 'Refund or dispute silently removed credits';
  END IF;
  IF (SELECT status FROM public.stripe_purchases
      WHERE id = 'd1000000-0000-4000-8000-000000000001') <> 'refunded' THEN
    RAISE EXCEPTION 'Refunded purchase status missing';
  END IF;
  IF (SELECT status FROM public.stripe_purchases
      WHERE id = 'd1000000-0000-4000-8000-000000000002') <> 'chargeback' THEN
    RAISE EXCEPTION 'Lost dispute did not record chargeback status';
  END IF;
  IF (SELECT count(*) FROM public.account_holds
      WHERE user_id = 'd0000000-0000-4000-8000-000000000001'
        AND status = 'active') <> 2 THEN
    RAISE EXCEPTION 'Refund/dispute holds are incorrect';
  END IF;
  IF (SELECT reason FROM public.account_holds
      WHERE source_reference = 'dp_solosheet_two') <> 'chargeback' THEN
    RAISE EXCEPTION 'Lost dispute did not upgrade the existing hold';
  END IF;
  IF (SELECT count(*) FROM public.stripe_webhook_events
      WHERE outcome = 'processed') <> 5 THEN
    RAISE EXCEPTION 'Processed Stripe event ledger is incorrect';
  END IF;
END;
$$;

DO $$
BEGIN
  PERFORM public.fulfill_stripe_checkout(
    'evt_bad_amount',
    'd1000000-0000-4000-8000-000000000002',
    'd0000000-0000-4000-8000-000000000001',
    'cs_test_solosheet_two', 'pi_solosheet_two', 'price_solosheet_test',
    299, 'usd', false, now()
  );
  RAISE EXCEPTION 'Invalid package amount was accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL;
END;
$$;

RESET ROLE;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.create_pending_stripe_purchase(
      gen_random_uuid(),
      'd0000000-0000-4000-8000-000000000001',
      'price_solosheet_test', false
    );
    RAISE EXCEPTION 'Authenticated user created a payment ledger row';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
RESET ROLE;

ROLLBACK;
