-- Run as database owner against an isolated database after phase 9.
-- All fixtures and writes roll back. Never run against production.
BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'foundation-one@example.edu'),
  ('b0000000-0000-4000-8000-000000000002', 'foundation-two@example.edu');

INSERT INTO public.admin_whitelist (email, reason)
VALUES ('foundation-admin@example.edu', 'Foundation regression fixture');

DO $$
BEGIN
  BEGIN
    INSERT INTO public.admin_whitelist (email) VALUES ('UPPERCASE@example.edu');
    RAISE EXCEPTION 'Non-normalized administrator email accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    INSERT INTO public.stripe_purchases (
      user_id, checkout_session_id, price_id, amount_total, currency,
      credit_amount, quantity, livemode
    ) VALUES (
      'b0000000-0000-4000-8000-000000000001', 'cs_invalid_amount', 'price_test',
      301, 'usd', 10, 1, false
    );
    RAISE EXCEPTION 'Invalid package amount accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END;
$$;

INSERT INTO public.stripe_purchases (
  id, user_id, checkout_session_id, price_id, amount_total, currency,
  credit_amount, quantity, livemode
) VALUES (
  'b1000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000001',
  'cs_foundation_test', 'price_test', 300, 'usd', 10, 1, false
);

INSERT INTO public.stripe_webhook_events (
  event_id, event_type, purchase_id, outcome, livemode, stripe_created_at
) VALUES (
  'evt_foundation_test', 'checkout.session.completed',
  'b1000000-0000-4000-8000-000000000001', 'processed', false, now()
);

INSERT INTO public.account_holds (
  user_id, reason, source, source_reference
) VALUES (
  'b0000000-0000-4000-8000-000000000001',
  'dispute', 'stripe', 'dp_foundation_test'
);

INSERT INTO public.audit_events (
  event_type, subject_user_id, actor_type, reason
) VALUES (
  'account.hold.placed',
  'b0000000-0000-4000-8000-000000000001',
  'system', 'Foundation regression fixture'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.stripe_purchases (
      user_id, checkout_session_id, price_id, amount_total, currency,
      credit_amount, quantity, livemode
    ) VALUES (
      'b0000000-0000-4000-8000-000000000002', 'cs_foundation_test',
      'price_test', 300, 'usd', 10, 1, false
    );
    RAISE EXCEPTION 'Duplicate Checkout Session accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  BEGIN
    INSERT INTO public.stripe_webhook_events (
      event_id, event_type, outcome, livemode, stripe_created_at
    ) VALUES (
      'evt_foundation_test', 'checkout.session.completed', 'processed', false, now()
    );
    RAISE EXCEPTION 'Duplicate Stripe event accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  IF NOT EXISTS (
    SELECT 1 FROM public.account_holds
    WHERE user_id = 'b0000000-0000-4000-8000-000000000001'
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Active account hold was not recorded';
  END IF;
END;
$$;

SELECT set_config('request.jwt.claim.sub', 'b0000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM email FROM public.admin_whitelist;
    RAISE EXCEPTION 'Administrator allowlist disclosed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM id FROM public.audit_events;
    RAISE EXCEPTION 'Audit events disclosed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM id FROM public.account_holds;
    RAISE EXCEPTION 'Account holds disclosed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM id FROM public.stripe_purchases;
    RAISE EXCEPTION 'Purchases disclosed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM event_id FROM public.stripe_webhook_events;
    RAISE EXCEPTION 'Webhook events disclosed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
RESET ROLE;

SELECT set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL ROLE service_role;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.stripe_purchases WHERE checkout_session_id = 'cs_foundation_test') <> 1 THEN
    RAISE EXCEPTION 'Service role cannot read purchases';
  END IF;
  BEGIN
    UPDATE public.audit_events SET reason = 'tampered';
    RAISE EXCEPTION 'Audit event mutation succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    DELETE FROM public.stripe_purchases;
    RAISE EXCEPTION 'Payment ledger deletion succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
RESET ROLE;

ROLLBACK;
