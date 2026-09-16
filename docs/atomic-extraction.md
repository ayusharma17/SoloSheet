# Atomic extraction deployment and recovery

Apply the ordered migration sequence through
`supabase/migration_phase11_extraction_access.sql` before deploying the matching
extraction API. Inspect deployed schema and grants first; SQL checked into this
repository does not establish deployment status.

Configure `SUPABASE_SERVICE_ROLE_KEY` in the server deployment only, alongside
existing Supabase URL/anon key and Google API key settings. Never use a
`NEXT_PUBLIC_` prefix for the service key. Missing configuration fails closed with
HTTP 503. The browser session still authenticates the caller; the server passes
that authenticated user ID into privileged credit RPCs. Administrator identity
comes from the private database allowlist and requires a confirmed authentication
email; there is no environment-based administrator list.

The reservation transaction resolves administrator access from that allowlist;
the browser/API cannot submit an administrator flag. Each new administrator
bypass is uncharged and audit logged. Active account holds reject new
reservations. If a hold appears while provider work is running, completion marks
the request failed, refunds a charged student reservation exactly once, records
an audit event, and the API returns `ACCOUNT_HELD` without saving a sheet.

Each attempt sends a UUID `requestId`. Keep the same UUID and payload after a
network error: the original transaction may have committed. HTTP 409 with
`EXTRACTION_PROCESSING` means retry that same attempt later. HTTP 409 with
`EXTRACTION_RESTART_REQUIRED` means the attempt failed or its payload differs;
start a new UUID only after the failed attempt is resolved. Signed URLs may be
refreshed without changing the fingerprint, but object paths and settings must
remain stable while resolving an uncertain attempt.

A PostgreSQL profile row lock serializes reservation, completion, and refunds.
Reservation spends before provider work. Completion atomically inserts the sheet
and marks the reservation completed. Failure refunds at most once. A lost
completion response is resolved by the refund RPC: completed work is returned
without a refund. Browser inserts/updates to `course_materials` are revoked.

If a worker disappears, its credit stays reserved for ten minutes. The next
reservation for that user marks expired attempts failed and refunds them before
checking balance. This exceeds the route's five-minute maximum runtime. Late
completion after recovery is rejected. No scheduled live database job is
required for this lazy recovery; users who never retry retain a reservation until
an operator resolves it with the service-only `fail_extraction` RPC. Do not edit
balances directly to recover attempts, as that could double refund them later.

Failed requests preserve uploads for the browser's retry/discard flow. Completed
requests remove their validated object paths through the Storage API. Cleanup
failure returns `cleanupPending: true` with success; retrying the same completed
request repeats cleanup safely. There is no metadata-only storage deletion.

Offline workflow tests: `node --experimental-strip-types --test tests/extraction-credits.test.mjs`.
The PostgreSQL assertions in `tests/atomic-credits.sql` require a disposable
local database with migrations and the documented fixture user. These checks do
not prove deployed RLS, production service keys, or live provider behavior.
