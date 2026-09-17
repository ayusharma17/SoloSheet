# Administrator and account-hold operations

Browser clients cannot read or mutate the administrator allowlist, payment
ledger, audit log, or account holds. Run these operations only as a database
owner or through reviewed server-only tooling. Use a unique correlation UUID
and a specific reason for every change. Never put a service-role key in a
browser or public script.

## Bootstrap the first administrator

Reusable migrations contain no personal administrator identity. Before the
first non-`.edu` administrator signs in, insert the normalized verified Google
email as the database owner and record the bootstrap in the audit log:

```sql
BEGIN;

INSERT INTO public.admin_whitelist (email, is_active, reason)
VALUES ('owner@example.com', true, 'Initial owner-approved administrator bootstrap')
ON CONFLICT (email) DO UPDATE SET
  is_active = true,
  reason = EXCLUDED.reason,
  updated_at = now();

INSERT INTO public.audit_events (
  event_type, actor_type, reason, correlation_id, metadata
) VALUES (
  'administrator.bootstrap',
  'system',
  'Initial owner-approved administrator bootstrap',
  gen_random_uuid(),
  jsonb_build_object('target_email', 'owner@example.com')
);

COMMIT;
```

Replace the placeholder with a lowercase email and keep the reason free of
secrets. The administrator can then sign in normally. Later allowlist changes
must use `public.set_administrator_access`; its named actor must be a current,
verified, active administrator.

## Change administrator access

Invoke the audited `public.set_administrator_access` RPC from a trusted server
operation using the service role. Its arguments are the target email, enabled
state, authenticated administrator user UUID, review reason, and a new
correlation UUID. Do not grant direct allowlist table writes back to the service
role.

## Release an account hold

After documenting the refund, dispute, or manual review, invoke
`public.release_account_hold` from a trusted server operation using the service
role. Supply the hold UUID, the current verified administrator's user UUID, a
specific release reason, and a new correlation UUID. Repeating the same hold
release is safe and does not duplicate the audit event.

Keep holds active when evidence is incomplete. Releasing a hold does not reverse
Stripe state, refund a payment, or alter credits; those are separate explicit
operations.

## Delete an account with upload reservations

The reservation foreign key intentionally prevents deleting an Auth user while
upload accounting remains. Perform deletion in this order:

1. List and delete every object below `<user-uuid>/` in the private
   `course-materials` bucket through the Supabase Storage API. Never delete
   `storage.objects` rows directly.
2. Invoke `public.cleanup_course_material_upload_reservations` with the target
   user UUID, a current verified administrator UUID, a specific reason, and a
   correlation UUID. The RPC refuses to proceed while any matching object
   remains and records one audit event when rows are released.
3. Delete the Auth user only after the cleanup RPC succeeds. An idempotent retry
   returns `already_clean` without duplicating the audit event.

The upload dialog also removes owned objects older than 24 hours when that user
returns, covering browsers that could not persist the local cleanup journal.
Reservation-only crashes are reclaimed under the same 24-hour cutoff when the
user next reserves a path, using the same transaction locks as Storage inserts.
The scheduled Storage-API cleanup worker for users who never return remains an
explicit post-MVP operational task in `TODO.md`.

## Purge abandoned payment attempts

Run `public.purge_abandoned_stripe_purchases` periodically from trusted
server-only maintenance tooling. It accepts a cutoff at least 30 days old and a
batch size no larger than 1,000. It deletes only unpaid canceled or expired
attempts with no webhook-ledger references; paid and financially relevant
records retain their seven-year policy.
