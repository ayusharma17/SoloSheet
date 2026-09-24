// Runs only against a disposable, port-unpublished Docker PostgreSQL container.
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const container = process.env.TEST_POSTGRES_CONTAINER || 'solosheet-hardening-db';
const database = `hardening_${Date.now()}`;
const upgradeDatabase = `hardening_upgrade_${Date.now()}`;
const collisionDatabase = `hardening_collision_${Date.now()}`;
const missingProfileDatabase = `hardening_missing_profile_${Date.now()}`;
const args = ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'];
function sql(text, db = database) {
  const result = spawnSync('docker', [...args, '-d', db, '-Atq'], { input: text, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
function file(path, db = database) {
  sql(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), db);
}
function rejectedFile(path, db) {
  return spawnSync('docker', [...args, '-d', db], {
    input: readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
    encoding: 'utf8',
  });
}

for (const [source, forward] of [
  ['supabase/migration_phase17_open_signup_trial_flag.sql', 'supabase/migrations/20260922143949_phase17_open_signup_trial_flag.sql'],
  ['supabase/migration_phase18_profile_recovery.sql', 'supabase/migrations/20260922144005_phase18_profile_recovery.sql'],
  ['supabase/migration_phase19_durable_extraction_jobs.sql', 'supabase/migrations/20260923014953_durable_extraction_jobs.sql'],
]) {
  assert.equal(
    readFileSync(new URL(`../${source}`, import.meta.url), 'utf8'),
    readFileSync(new URL(`../${forward}`, import.meta.url), 'utf8'),
    `${source} and its timestamped forward migration must remain identical`,
  );
}

// Exercise the supported existing-database route separately from the generated
// fresh bootstrap. This catches migrations that work only when their new schema
// is created from scratch and proves that the rollout preserves old balances.
sql(`CREATE DATABASE ${upgradeDatabase}`, 'postgres');
file('supabase/tests/local-bootstrap.sql', upgradeDatabase);
for (const migration of [
  'migration.sql',
  'migration_phase2.sql',
  'migration_phase4.sql',
  'migration_phase5_anti_abuse.sql',
  'migration_storage_setup.sql',
  'migration_phase6_credit_security.sql',
  'migration_phase7_atomic_extraction.sql',
  'migration_phase8_retire_device_fingerprinting.sql',
  'migration_phase9_anti_abuse_foundation.sql',
  'migration_phase10_identity_and_trial.sql',
  'migration_phase11_extraction_access.sql',
  'migration_phase12_stripe_payments.sql',
  'migration_phase13_payment_and_admin_hardening.sql',
  'migration_phase14_storage_abuse_controls.sql',
  'migration_phase15_storage_upload_preflight.sql',
  'migration_phase16_auth_confirmation_compatibility.sql',
]) {
  file(`supabase/${migration}`, upgradeDatabase);
}
sql(`
  INSERT INTO auth.users(id,email,email_confirmed_at)
  VALUES ('71000000-0000-4000-8000-000000000001','preserved@school.edu',now());
  UPDATE public.profiles
  SET credits=7, trial_granted_at='2025-01-02T03:04:05Z'
  WHERE id='71000000-0000-4000-8000-000000000001';
`, upgradeDatabase);
file('supabase/migration_phase17_open_signup_trial_flag.sql', upgradeDatabase);
file('supabase/migration_phase18_profile_recovery.sql', upgradeDatabase);

// Clone the exact phase-17 state to prove phase 18 aborts cleanly on both
// ambiguous request IDs and a charged legacy reservation whose profile is gone.
sql(`CREATE DATABASE ${collisionDatabase} TEMPLATE ${upgradeDatabase}`, 'postgres');
sql(`
  INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
    ('72000000-0000-4000-8000-000000000001','collision-one@school.edu',now()),
    ('72000000-0000-4000-8000-000000000002','collision-two@school.edu',now());
  INSERT INTO public.extraction_requests(user_id,request_id,fingerprint,status,charged) VALUES
    ('72000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000099',repeat('a',64),'processing',true),
    ('72000000-0000-4000-8000-000000000002','72000000-0000-4000-8000-000000000099',repeat('b',64),'processing',false);
`, collisionDatabase);
const collisionMigration = rejectedFile('supabase/migration_phase19_durable_extraction_jobs.sql', collisionDatabase);
assert.notEqual(collisionMigration.status, 0, 'phase 18 accepted duplicate legacy request IDs');
assert.match(collisionMigration.stderr, /Duplicate extraction request IDs/);
assert.equal(sql("SELECT count(*) FROM public.extraction_requests WHERE request_id='72000000-0000-4000-8000-000000000099' AND status='processing'", collisionDatabase), '2');
assert.equal(sql("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='extraction_requests' AND column_name='attempt_count'", collisionDatabase), '0');

sql(`CREATE DATABASE ${missingProfileDatabase} TEMPLATE ${upgradeDatabase}`, 'postgres');
sql(`
  INSERT INTO auth.users(id,email,email_confirmed_at)
  VALUES ('73000000-0000-4000-8000-000000000001','missing-refund@school.edu',now());
  DELETE FROM public.profiles WHERE id='73000000-0000-4000-8000-000000000001';
  INSERT INTO public.extraction_requests(user_id,request_id,fingerprint,status,charged)
  VALUES ('73000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000099',repeat('c',64),'processing',true);
`, missingProfileDatabase);
const missingProfileMigration = rejectedFile('supabase/migration_phase19_durable_extraction_jobs.sql', missingProfileDatabase);
assert.notEqual(missingProfileMigration.status, 0, 'phase 18 settled a charged legacy request without a profile');
assert.match(missingProfileMigration.stderr, /could not refund every charged legacy extraction/i);
assert.equal(sql("SELECT status FROM public.extraction_requests WHERE request_id='73000000-0000-4000-8000-000000000099'", missingProfileDatabase), 'processing');
assert.equal(sql("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='extraction_requests' AND column_name='attempt_count'", missingProfileDatabase), '0');

sql(`
  INSERT INTO public.extraction_requests(user_id,request_id,fingerprint,status,charged,created_at) VALUES
    ('71000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000011',repeat('1',64),'processing',true,now()-interval '2 minutes'),
    ('71000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000012',repeat('2',64),'processing',false,now()-interval '2 minutes'),
    ('71000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000013',repeat('3',64),'completed',true,now()-interval '2 minutes');
`, upgradeDatabase);
file('supabase/migration_phase19_durable_extraction_jobs.sql', upgradeDatabase);
assert.equal(sql("SELECT credits FROM public.profiles WHERE id='71000000-0000-4000-8000-000000000001'", upgradeDatabase), '8');
assert.equal(sql("SELECT trial_granted_at='2025-01-02T03:04:05Z'::timestamptz FROM public.profiles WHERE id='71000000-0000-4000-8000-000000000001'", upgradeDatabase), 't');
assert.equal(sql("SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='credits'", upgradeDatabase), '0');
assert.equal(sql("SELECT enabled FROM public.private_feature_flags WHERE key='non_edu_trial_credits_enabled'", upgradeDatabase), 't');
assert.equal(sql("SELECT count(*) FROM public.extraction_requests WHERE request_id IN ('71000000-0000-4000-8000-000000000011','71000000-0000-4000-8000-000000000012') AND status='expired' AND failure_code='legacy_migration' AND settled_at IS NOT NULL", upgradeDatabase), '2');
assert.equal(sql("SELECT status FROM public.extraction_requests WHERE request_id='71000000-0000-4000-8000-000000000013'", upgradeDatabase), 'completed');
sql(`
  INSERT INTO auth.users(id,email,email_confirmed_at)
  VALUES
    ('71000000-0000-4000-8000-000000000002','new-after-upgrade@example.com',now()),
    ('71000000-0000-4000-8000-000000000003','repair-after-upgrade@school.edu',now());
  DELETE FROM public.profiles
  WHERE id='71000000-0000-4000-8000-000000000003';
`, upgradeDatabase);
assert.equal(sql("SELECT credits FROM public.profiles WHERE id='71000000-0000-4000-8000-000000000002'", upgradeDatabase), '1');
assert.equal(sql(`
  SET request.jwt.claim.sub='71000000-0000-4000-8000-000000000003';
  SET request.jwt.claim.role='authenticated';
  SET ROLE authenticated;
  SELECT public.repair_missing_profile()->>'status';
`, upgradeDatabase), 'repaired');
assert.equal(sql("SELECT credits FROM public.profiles WHERE id='71000000-0000-4000-8000-000000000003'", upgradeDatabase), '0');
assert.equal(sql("SELECT trial_granted_at IS NULL FROM public.profiles WHERE id='71000000-0000-4000-8000-000000000003'", upgradeDatabase), 't');
assert.equal(sql("SELECT count(*) FROM public.audit_events WHERE event_type='profile.repaired' AND subject_user_id='71000000-0000-4000-8000-000000000003'", upgradeDatabase), '1');
console.log('Phase 15 -> 18 upgrade preserved state, refunded only charged legacy work, rejected corrupt/colliding rollouts, and repaired a missing profile at zero credits');

sql(`CREATE DATABASE ${database}`, 'postgres');
console.log(`Disposable test database: ${database}`);
// Roles are cluster-wide. Use a fresh container for each full suite invocation.
file('supabase/tests/local-bootstrap.sql');
file('supabase/bootstrap.sql');
console.log('Applied the complete application schema in one transaction');
file('supabase/tests/credit_security.sql');
file('supabase/tests/anti_abuse_foundation.sql');
file('supabase/tests/identity_and_trial.sql');
file('supabase/tests/stripe_payments.sql');
// Phase 13 and phase 16 regression files predate the durable queue and assert
// only administrator/no-credit policy through the retired reserve signature.
// Adapt those historical assertions inside this disposable database, then drop
// the shim before phase 18 tests verify that the production RPC is absent.
sql(`
  CREATE FUNCTION public.reserve_extraction(
    p_user_id uuid, p_request_id uuid, p_fingerprint text
  ) RETURNS jsonb LANGUAGE plpgsql AS $$
  DECLARE result jsonb;
  BEGIN
    result := public.enqueue_extraction(
      p_user_id, p_request_id, p_fingerprint, 'Legacy regression adapter', 1, '',
      jsonb_build_array(jsonb_build_object(
        'path', p_user_id::text || '/' || p_request_id::text || '/' || p_request_id::text || '.pdf',
        'name', 'legacy-regression.pdf', 'type', 'application/pdf', 'size', 42
      ))
    );
    IF result->>'status' = 'queued' THEN
      result := jsonb_set(result, '{status}', '"reserved"'::jsonb);
    END IF;
    RETURN result;
  END;
  $$;
  REVOKE ALL ON FUNCTION public.reserve_extraction(uuid, uuid, text)
    FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.reserve_extraction(uuid, uuid, text)
    TO service_role;
`);
file('supabase/tests/phase13_payment_and_admin_hardening.sql');
file('supabase/tests/storage_abuse_controls.sql');
file('supabase/tests/open_signup_trial_flag.sql');
sql('DROP FUNCTION public.reserve_extraction(uuid, uuid, text)');
file('supabase/tests/profile_recovery.sql');
file('supabase/tests/durable_extraction_jobs.sql');
sql("INSERT INTO auth.users(id,email) VALUES ('10000000-0000-4000-8000-000000000001','atomic@example.edu')");
file('tests/atomic-credits.sql');
console.log('Security, identity/trial, payment, storage, feature-flag, profile-recovery, durable-extraction, and atomic SQL regression assertions passed');
sql("UPDATE public.profiles SET credits=1 WHERE id='10000000-0000-4000-8000-000000000001'");
const requestIds = Array.from({ length: 8 }, (_, i) => `30000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
function concurrentSql(input) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...args, '-d', database, '-Atq']);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
    child.stdin.end(input);
  });
}

// Exercise the durable state machine through the same service_role boundary as
// the worker. Owner writes below are fixture setup/backdating only; every raced
// transition is an independently connected RPC call with bounded lock/statement
// timeouts so a deadlock fails the suite instead of hanging it.
const raceUser = '80000000-0000-4000-8000-000000000001';
const raceFiles = requestId => JSON.stringify([{
  path: `${raceUser}/${requestId}/89000000-0000-4000-8000-000000000001.pdf`,
  name: 'race.pdf', type: 'application/pdf', size: 42,
}]).replaceAll("'", "''");
function enqueueRace(requestId, fingerprintCharacter) {
  assert.equal(sql(`
    SET request.jwt.claim.role='service_role';
    SET ROLE service_role;
    SELECT public.enqueue_extraction(
      '${raceUser}', '${requestId}', repeat('${fingerprintCharacter}',64),
      'Durable race', 1, '', '${raceFiles(requestId)}'::jsonb
    )->>'status';
  `), 'queued');
}
function serviceRace(statement) {
  return concurrentSql(`
    SET lock_timeout='5s';
    SET statement_timeout='10s';
    SET request.jwt.claim.role='service_role';
    SET ROLE service_role;
    ${statement}
  `);
}

sql(`
  INSERT INTO auth.users(id,email,email_confirmed_at)
  VALUES ('${raceUser}','durable-races@school.edu',now());
  UPDATE public.profiles SET credits=10 WHERE id='${raceUser}';
`);

const sameClaimRequest = '81000000-0000-4000-8000-000000000001';
enqueueRace(sameClaimRequest, '1');
const sameClaimResults = await Promise.all([
  serviceRace(`SELECT public.claim_extraction_job('${sameClaimRequest}',
    '82000000-0000-4000-8000-000000000001',180)->>'status';`),
  serviceRace(`SELECT public.claim_extraction_job('${sameClaimRequest}',
    '82000000-0000-4000-8000-000000000002',180)->>'status';`),
]);
assert.deepEqual(sameClaimResults.sort(), ['leased', 'processing']);
assert.equal(sql(`SELECT attempt_count FROM public.extraction_requests
  WHERE request_id='${sameClaimRequest}'`), '1');
console.log('Concurrent same-ID claims: one lease owner, one leased response, no deadlock');

const terminalRaceRequest = '81000000-0000-4000-8000-000000000002';
const terminalRaceLease = '82000000-0000-4000-8000-000000000003';
enqueueRace(terminalRaceRequest, '2');
assert.equal(sql(`
  SET request.jwt.claim.role='service_role'; SET ROLE service_role;
  SELECT public.claim_extraction_job('${terminalRaceRequest}','${terminalRaceLease}',180)->>'status';
`), 'processing');
const terminalRaceResults = await Promise.all([
  serviceRace(`SELECT public.complete_extraction_job(
    '${terminalRaceRequest}','${terminalRaceLease}',
    '[{"category":"Definition","topic":"Race","content":"Once","shorthand":"1","priority":1}]'
  )->>'status';`),
  serviceRace(`SELECT public.fail_extraction_job(
    '${terminalRaceRequest}','${terminalRaceLease}','worker_error',false
  )->>'status';`),
]);
const terminalRaceStatus = sql(`SELECT status FROM public.extraction_requests
  WHERE request_id='${terminalRaceRequest}'`);
assert.ok(['completed', 'failed'].includes(terminalRaceStatus));
assert.deepEqual([...new Set(terminalRaceResults)], [terminalRaceStatus]);
assert.equal(sql(`SELECT count(*) FROM public.course_materials AS material
  JOIN public.extraction_requests AS request ON request.material_id=material.id
  WHERE request.request_id='${terminalRaceRequest}'`), terminalRaceStatus === 'completed' ? '1' : '0');
console.log('Concurrent complete/fail: one terminal outcome and at most one material, no deadlock');

const expiryRaceRequest = '81000000-0000-4000-8000-000000000003';
const expiryRaceLease = '82000000-0000-4000-8000-000000000004';
enqueueRace(expiryRaceRequest, '3');
sql(`
  SET request.jwt.claim.role='service_role'; SET ROLE service_role;
  SELECT public.claim_extraction_job('${expiryRaceRequest}','${expiryRaceLease}',180);
  RESET ROLE;
  UPDATE public.extraction_requests SET lease_expires_at=now()-interval '1 second'
  WHERE request_id='${expiryRaceRequest}';
`);
const completeExpiryResults = await Promise.all([
  serviceRace(`SELECT public.complete_extraction_job(
    '${expiryRaceRequest}','${expiryRaceLease}',
    '[{"category":"Definition","topic":"Late","content":"No","shorthand":"0","priority":1}]'
  )->>'status';`),
  serviceRace('SELECT public.expire_extraction_jobs(50);'),
]);
// SKIP LOCKED may intentionally defer the stale row when completion holds its
// lock. The next scheduler pass must then settle it, and the two passes together
// must report it exactly once.
const expiryFollowUp = JSON.parse(await serviceRace('SELECT public.expire_extraction_jobs(50);'));
const completeExpirySettlements = [
  ...JSON.parse(completeExpiryResults[1]).jobs,
  ...expiryFollowUp.jobs,
].filter(job => job.requestId === expiryRaceRequest);
assert.equal(completeExpirySettlements.length, 1);
assert.equal(sql(`SELECT status FROM public.extraction_requests
  WHERE request_id='${expiryRaceRequest}'`), 'expired');
assert.equal(sql(`SELECT count(*) FROM public.course_materials AS material
  JOIN public.extraction_requests AS request ON request.material_id=material.id
  WHERE request.request_id='${expiryRaceRequest}'`), '0');
console.log('Concurrent complete/expiry: expiry wins stale lease exactly once, no late material');

const concurrentExpiryRequest = '81000000-0000-4000-8000-000000000004';
const concurrentExpiryLease = '82000000-0000-4000-8000-000000000005';
enqueueRace(concurrentExpiryRequest, '4');
sql(`
  SET request.jwt.claim.role='service_role'; SET ROLE service_role;
  SELECT public.claim_extraction_job('${concurrentExpiryRequest}','${concurrentExpiryLease}',180);
  RESET ROLE;
  UPDATE public.extraction_requests SET lease_expires_at=now()-interval '1 second'
  WHERE request_id='${concurrentExpiryRequest}';
`);
const expiryResults = await Promise.all([
  serviceRace('SELECT public.expire_extraction_jobs(50);'),
  serviceRace('SELECT public.expire_extraction_jobs(50);'),
]);
const expirySettlements = expiryResults
  .map(result => JSON.parse(result).jobs)
  .flat()
  .filter(job => job.requestId === concurrentExpiryRequest);
assert.equal(expirySettlements.length, 1);
assert.equal(sql(`SELECT status FROM public.extraction_requests
  WHERE request_id='${concurrentExpiryRequest}'`), 'expired');
console.log('Concurrent expiry sweepers: one settlement/refund result, no deadlock');

const cleanupRaceRequest = '81000000-0000-4000-8000-000000000005';
const cleanupRaceLease = '82000000-0000-4000-8000-000000000006';
enqueueRace(cleanupRaceRequest, '5');
sql(`
  INSERT INTO public.course_material_upload_reservations(path,user_id,size_bytes)
  VALUES ('${raceUser}/${cleanupRaceRequest}/89000000-0000-4000-8000-000000000001.pdf',
    '${raceUser}',42);
  SET request.jwt.claim.role='service_role'; SET ROLE service_role;
  SELECT public.claim_extraction_job('${cleanupRaceRequest}','${cleanupRaceLease}',180);
  RESET ROLE;
  UPDATE public.extraction_requests SET lease_expires_at=now()-interval '1 second'
  WHERE request_id='${cleanupRaceRequest}';
  SET request.jwt.claim.role='service_role'; SET ROLE service_role;
  SELECT public.expire_extraction_jobs(50);
`);
const [lateCompletionStatus, cleanupStatus] = await Promise.all([
  serviceRace(`SELECT public.complete_extraction_job(
    '${cleanupRaceRequest}','${cleanupRaceLease}',
    '[{"category":"Definition","topic":"Too late","content":"No","shorthand":"0","priority":1}]'
  )->>'status';`),
  serviceRace(`SELECT public.release_extraction_upload_reservations(
    '${cleanupRaceRequest}'
  )->>'status';`),
]);
assert.equal(lateCompletionStatus, 'expired');
assert.equal(cleanupStatus, 'released');
assert.equal(sql(`SELECT count(*) FROM public.course_materials AS material
  JOIN public.extraction_requests AS request ON request.material_id=material.id
  WHERE request.request_id='${cleanupRaceRequest}'`), '0');
assert.equal(sql(`SELECT (uploads_cleaned_at IS NOT NULL)::text FROM public.extraction_requests
  WHERE request_id='${cleanupRaceRequest}'`), 'true');
assert.equal(sql(`SELECT count(*) FROM public.course_material_upload_reservations
  WHERE user_id='${raceUser}' AND path LIKE '%/${cleanupRaceRequest}/%'`), '0');

const expectedRaceCredits = terminalRaceStatus === 'failed' ? '9' : '8';
assert.equal(sql(`SELECT credits FROM public.profiles WHERE id='${raceUser}'`), expectedRaceCredits);
assert.equal(sql(`SELECT count(*) FROM public.course_materials AS material
  JOIN public.extraction_requests AS request ON request.material_id=material.id
  WHERE request.user_id='${raceUser}'`), terminalRaceStatus === 'completed' ? '1' : '0');
console.log('Late completion/cleanup: terminal cleanup succeeds, late material is rejected, credits settle exactly once');

sql(`
  INSERT INTO auth.users(id,email,email_confirmed_at)
  VALUES ('e0000000-0000-4000-8000-000000000010','repair-concurrent@example.com',now());
  DELETE FROM public.profiles
  WHERE id='e0000000-0000-4000-8000-000000000010';
`);
const repairResults = await Promise.all(Array.from({ length: 8 }, () => concurrentSql(`
  SET request.jwt.claim.sub='e0000000-0000-4000-8000-000000000010';
  SET request.jwt.claim.role='authenticated';
  SET ROLE authenticated;
  SELECT public.repair_missing_profile()->>'status';
`)));
assert.equal(repairResults.filter(status => status === 'repaired').length, 1);
assert.equal(repairResults.filter(status => status === 'existing').length, 7);
assert.equal(sql("SELECT credits FROM public.profiles WHERE id='e0000000-0000-4000-8000-000000000010'"), '0');
assert.equal(sql("SELECT trial_granted_at IS NULL FROM public.profiles WHERE id='e0000000-0000-4000-8000-000000000010'"), 't');
assert.equal(sql("SELECT count(*) FROM public.audit_events WHERE event_type='profile.repaired' AND subject_user_id='e0000000-0000-4000-8000-000000000010'"), '1');
console.log('Eight concurrent profile repairs: exactly one insert and audit event, seven existing results');
const results = await Promise.all(requestIds.map(id => concurrentSql(`
  SET request.jwt.claim.role='service_role';
  SELECT public.enqueue_extraction(
    '10000000-0000-4000-8000-000000000001',
    '${id}', repeat('a',64), 'Concurrent credit test', 1, '',
    jsonb_build_array(jsonb_build_object(
      'path', '10000000-0000-4000-8000-000000000001/31000000-0000-4000-8000-000000000001/32000000-0000-4000-8000-000000000001.pdf',
      'name', 'concurrent.pdf', 'type', 'application/pdf', 'size', 42
    ))
  )->>'status';
`)));
assert.equal(results.filter(status => status === 'queued').length, 1);
assert.equal(results.filter(status => status === 'no_credits').length, 7);
assert.equal(sql("SELECT credits FROM public.profiles WHERE id='10000000-0000-4000-8000-000000000001'"), '0');
console.log('Eight concurrent enqueue attempts: exactly one queued, seven rejected, balance zero');
sql(`
  INSERT INTO public.admin_whitelist(email, reason)
  VALUES ('flag-concurrency-admin@example.com', 'Feature-flag concurrency fixture');
  INSERT INTO auth.users(id,email,email_confirmed_at)
  VALUES ('d0000000-0000-4000-8000-000000000001','flag-concurrency-admin@example.com',now());
  SET request.jwt.claim.role='service_role';
  SET ROLE service_role;
  SELECT public.set_non_edu_trial_credits_enabled(
    true,
    'd0000000-0000-4000-8000-000000000001',
    'Prepare feature-flag ordering regression',
    'd1000000-0000-4000-8000-000000000008'
  );
`);
const flagChangeFirst = concurrentSql(`
  BEGIN;
  SET LOCAL request.jwt.claim.role='service_role';
  SET LOCAL ROLE service_role;
  SELECT public.set_non_edu_trial_credits_enabled(
    false,
    'd0000000-0000-4000-8000-000000000001',
    'Concurrent feature-flag ordering regression',
    'd1000000-0000-4000-8000-000000000009'
  );
  SELECT pg_sleep(1);
  COMMIT;
`);
const signupAfterFlagLock = concurrentSql(`
  SELECT pg_sleep(0.2);
  INSERT INTO auth.users(id,email,email_confirmed_at)
  VALUES ('70000000-0000-4000-8000-000000000001','flag-race@example.com',now());
`);
await Promise.all([flagChangeFirst, signupAfterFlagLock]);
assert.equal(sql("SELECT credits FROM public.profiles WHERE id='70000000-0000-4000-8000-000000000001'"), '0');
assert.equal(sql("SELECT trial_granted_at IS NULL FROM public.profiles WHERE id='70000000-0000-4000-8000-000000000001'"), 't');
console.log('Concurrent flag change/signup: a change that commits first controls the new profile');
sql(`
  INSERT INTO auth.users(id,email,email_confirmed_at)
  VALUES ('40000000-0000-4000-8000-000000000001','payments-concurrent@example.edu',now());
  UPDATE public.profiles SET credits=0
  WHERE id='40000000-0000-4000-8000-000000000001';
  SET request.jwt.claim.role='service_role';
  SELECT public.create_pending_stripe_purchase(
    '41000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'price_solosheet_test', false
  );
  SELECT public.attach_stripe_checkout_session(
    '41000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'cs_test_concurrent'
  );
`);
const paymentResults = await Promise.all(requestIds.map((_, i) => concurrentSql(`
  SET request.jwt.claim.role='service_role';
  SELECT public.fulfill_stripe_checkout(
    'evt_checkout_concurrent_${i + 1}',
    '41000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'cs_test_concurrent', 'pi_test_concurrent', 'price_solosheet_test',
    300, 'usd', false, now()
  )->>'status';
`)));
assert.equal(paymentResults.filter(status => status === 'fulfilled').length, 1);
assert.equal(paymentResults.filter(status => status === 'already_fulfilled').length, 7);
assert.equal(sql("SELECT credits FROM public.profiles WHERE id='40000000-0000-4000-8000-000000000001'"), '10');
console.log('Eight concurrent webhook deliveries: exactly one grant, final balance ten');
sql(`
  INSERT INTO auth.users(id,email,email_confirmed_at)
  VALUES ('50000000-0000-4000-8000-000000000001','storage-concurrent@example.edu',now());
`);
const storageResults = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => concurrentSql(`
  SET request.jwt.claim.sub='50000000-0000-4000-8000-000000000001';
  SET request.jwt.claim.role='authenticated';
  SET ROLE authenticated;
  SELECT public.reserve_course_material_upload(
    '50000000-0000-4000-8000-000000000001/51000000-0000-4000-8000-000000000001/${String(i + 1).padStart(8, '0')}-0000-4000-8000-000000000001.pdf',
    1
  )->>'status';
`)));
assert.equal(storageResults.filter(result => result.status === 'fulfilled').length, 10);
assert.equal(storageResults.filter(result => result.status === 'rejected').length, 2);
assert.equal(sql("SELECT count(*) FROM public.course_material_upload_reservations WHERE user_id='50000000-0000-4000-8000-000000000001'"), '10');
console.log('Twelve concurrent upload reservations: exactly ten accepted, two quota-rejected');
sql(`
  INSERT INTO auth.users(id,email,email_confirmed_at)
  VALUES ('60000000-0000-4000-8000-000000000001','storage-race@example.edu',now());
  SET request.jwt.claim.sub='60000000-0000-4000-8000-000000000001';
  SET request.jwt.claim.role='authenticated';
  SET ROLE authenticated;
  SELECT public.reserve_course_material_upload(
    '60000000-0000-4000-8000-000000000001/61000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000001.pdf',
    5
  );
`);
const racedPath = '60000000-0000-4000-8000-000000000001/61000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000001.pdf';
const uploadDuringRelease = concurrentSql(`
  BEGIN;
  SET LOCAL request.jwt.claim.sub='60000000-0000-4000-8000-000000000001';
  SET LOCAL request.jwt.claim.role='authenticated';
  SET LOCAL ROLE authenticated;
  SELECT public.has_course_material_upload_reservation('${racedPath}', auth.uid(), '{"size":5}');
  SELECT pg_sleep(1);
  INSERT INTO storage.objects(bucket_id,name,metadata)
  VALUES ('course-materials','${racedPath}','{"size":5}');
  COMMIT;
`);
const releaseDuringUpload = concurrentSql(`
  SET request.jwt.claim.sub='60000000-0000-4000-8000-000000000001';
  SET request.jwt.claim.role='authenticated';
  SET ROLE authenticated;
  SELECT pg_sleep(0.2);
  SELECT public.release_course_material_uploads(ARRAY['${racedPath}']);
`);
const raceResults = await Promise.allSettled([uploadDuringRelease, releaseDuringUpload]);
assert.equal(raceResults[0].status, 'fulfilled');
assert.equal(raceResults[1].status, 'rejected');
assert.equal(sql(`SELECT count(*) FROM storage.objects AS object
  JOIN public.course_material_upload_reservations AS reservation
    ON reservation.path=object.name
  WHERE object.bucket_id='course-materials' AND object.name='${racedPath}'`), '1');
console.log('Concurrent upload/release: upload remains atomically paired with its reservation');
console.log('No deployed services were accessed. Remove the disposable container after review.');
