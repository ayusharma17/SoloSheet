# Administrator and account-hold operations

Browser clients cannot read or mutate the administrator allowlist, payment
ledger, audit log, or account holds. Run these operations only as a database
owner or through reviewed server-only tooling. Use a unique correlation UUID
and a specific reason for every change. Never put a service-role key in a
browser or public script.

## Operate the non-.edu trial-credit flag

Use the repository CLI to inspect or change whether **future** verified
non-`.edu` accounts receive one promotional credit. `.edu` accounts remain
eligible regardless of this flag. A change never alters existing accounts,
balances, or trial records.

The CLI calls only the audited Phase 17 RPCs. It does not expose a browser
endpoint and does not write `private_feature_flags` directly. Each invocation
requires:

- `SUPABASE_URL`, set to one authoritative target origin;
- `SUPABASE_SERVICE_ROLE_KEY`, available only in the maintainer shell;
- `--actor`, the UUID of a current, verified, active administrator; and
- `--reason`, a specific non-secret reason between 1 and 1,000 characters.

`SUPABASE_URL` must be either a loopback origin such as
`http://127.0.0.1:54321` or the exact hosted project origin in the form
`https://<project-ref>.supabase.co`. Credentials, encoded host spellings,
non-root paths, query parameters, fragments, non-loopback IPs, and hosted HTTP
URLs are rejected. RPC redirects are rejected so credentials cannot be
forwarded to another origin. Do not copy the service-role key into command
history as an inline assignment. Load it into the shell environment from the intended
project's protected secret store, and confirm the URL and key belong to the
same project without printing the key.

Apply Phase 17 to the intended database before using this CLI. If both
`SUPABASE_URL` and the application's `NEXT_PUBLIC_SUPABASE_URL` are present,
their canonical origins must match; the CLI stops with `TARGET_ENV_MISMATCH`
when they disagree. Remove an unrelated public variable from the maintainer
shell or load a matching environment rather than bypassing that guard.

### Inspect

Local/disposable project:

```sh
npm run --silent trial-flag -- status \
  --actor 00000000-0000-4000-8000-000000000000 \
  --reason "Verify local non-.edu trial policy"
```

Hosted project operations require the exact origin a second time. This is a
wrong-project guard, not an authentication mechanism:

```sh
npm run --silent trial-flag -- status \
  --actor 00000000-0000-4000-8000-000000000000 \
  --reason "Verify production non-.edu trial policy" \
  --confirm-target https://project-ref.supabase.co
```

A successful read emits one JSON object with `action: "status"`,
`status: "verified"`, the boolean `enabled` value, the target origin, and a
correlation UUID. The read itself creates a `configuration.read` audit event.

### Enable

```sh
npm run --silent trial-flag -- enable \
  --actor 00000000-0000-4000-8000-000000000000 \
  --reason "Enable launch promotion for future non-.edu accounts" \
  --confirm-target https://project-ref.supabase.co
```

The CLI reads the current value, invokes the audited setter with `true`, then
reads the authoritative value again. It succeeds only if the setter response
and read-back both say `true`. The output includes `previousEnabled` and the
verified `enabled` value.

### Disable

Before disabling, change and deploy the landing-page and sign-in copy so it no
longer promises a free credit to every account. Verify that deployment first;
then acknowledge it explicitly:

```sh
npm run --silent trial-flag -- disable \
  --actor 00000000-0000-4000-8000-000000000000 \
  --reason "Limit promotion after public copy deployment" \
  --confirm-copy-deployed \
  --confirm-target https://project-ref.supabase.co
```

Without `--confirm-copy-deployed`, the CLI exits before making a request. The
disable flow reads, sets `false`, and reads back exactly as the enable flow
does. If a disable must be rolled back, fix or confirm universal-free-credit
copy first, then run `enable` and retain its correlation UUID in the incident
notes.

### Correlation and audit behavior

By default, the CLI generates one UUID and reuses it across the pre-change
read, `configuration.changed` event, and verification read. Supply a prepared
UUID with `--correlation <uuid>` when an incident or change record already has
one. The RPC records the explicit administrator actor and reason. Do not put
email addresses, tokens, or other secrets in the reason.

### Recover an accidentally missing flag row

Recovery is intentionally separate from enable. Use it only after a normal
`status` invocation reports `FLAG_ROW_MISSING`:

```sh
npm run --silent trial-flag -- recover-missing \
  --actor 00000000-0000-4000-8000-000000000000 \
  --reason "Restore accidentally deleted trial flag to safe launch state" \
  --confirm-recovery \
  --confirm-target https://project-ref.supabase.co
```

Recovery first repeats the audited read. It invokes the audited setter only
when that read returns PostgreSQL code `P0002` with PostgREST's corresponding
HTTP 500 status, the exact expected missing-row result. Network,
authorization, malformed-response, and all other
database failures stop without attempting recovery. A present row also stops
with `RECOVERY_NOT_NEEDED`. Recovery can restore only `true`, and succeeds only
when the serialized setter also reports that the old value was absent and a
read-back verifies the restored On state. A concurrent recreation fails as a
verification mismatch even if the resulting value is On.

### Failure handling

The CLI prints one finite error code and exits nonzero. It deliberately omits
provider messages, response bodies, headers, and credentials:

- `INVALID_TARGET`, `TARGET_CONFIRMATION_REQUIRED`, or
  `TARGET_CONFIRMATION_MISMATCH`: stop and verify the intended project origin.
- `TARGET_ENV_MISMATCH`: load one unambiguous project environment; the private
  and public Supabase origins currently disagree.
- `INVALID_ACTOR`, `INVALID_REASON`, `INVALID_CORRELATION`, or
  `INVALID_ARGUMENTS`: correct the command locally; no RPC was attempted.
- `MISSING_SERVICE_ROLE_KEY`: load the intended project's service-role key into
  the shell without surrounding whitespace; never pass it as a command argument.
- `COPY_CONFIRMATION_REQUIRED` or `RECOVERY_CONFIRMATION_REQUIRED`: complete
  the documented prerequisite instead of bypassing it.
- `AUTHORIZATION_FAILED`: verify that the environment contains the matching
  service-role key and that the actor is still a verified active administrator.
- `NETWORK_ERROR`, `RPC_FAILED`, or `INVALID_RESPONSE`: do not attempt recovery;
  resolve connectivity or deployment state, then start again with `status`.
- `VERIFICATION_MISMATCH`: treat the requested change as unconfirmed. Run
  `status` with a new reason/correlation UUID before deciding whether to retry.
- `FLAG_ROW_MISSING`: use the intentional recovery procedure above.

Never infer success from a setter request alone. Preserve the successful JSON
output's target and correlation UUID with the maintenance record. The CLI does
not reconcile historical accounts or grant credits retroactively.

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

## Change per-user Storage quotas

`public.course_material_upload_limits` is the authoritative Storage quota
configuration. It is owner-managed and intentionally inaccessible to browser
and service-role clients. The `course-materials` row controls
`max_files_per_user` and `max_total_bytes_per_user`.

Change both values in one database-owner transaction:

```sql
BEGIN;

UPDATE public.course_material_upload_limits
SET max_files_per_user = 10,
    max_total_bytes_per_user = 200 * 1024 * 1024
WHERE config_key = 'course-materials';

COMMIT;
```

The configuration trigger synchronizes the private Storage bucket’s per-object
byte ceiling, and new upload reservations read the same row under a transaction
lock. Lowering a quota does not delete existing objects or reservations; it
blocks new reservations until usage is back within the configured limit.

## Purge abandoned payment attempts

Run `public.purge_abandoned_stripe_purchases` periodically from trusted
server-only maintenance tooling. It accepts a cutoff at least 30 days old and a
batch size no larger than 1,000. It deletes only unpaid canceled or expired
attempts with no webhook-ledger references; paid and financially relevant
records retain their seven-year policy.
