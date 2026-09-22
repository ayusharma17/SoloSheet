// Runs only against a disposable, port-unpublished Docker PostgreSQL container.
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const container = process.env.TEST_POSTGRES_CONTAINER || 'solosheet-hardening-db';
const database = `hardening_${Date.now()}`;
const upgradeDatabase = `hardening_upgrade_${Date.now()}`;
const args = ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'];
function sql(text, db = database) {
  const result = spawnSync('docker', [...args, '-d', db, '-Atq'], { input: text, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
function file(path, db = database) {
  sql(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), db);
}

for (const [source, forward] of [
  ['supabase/migration_phase17_open_signup_trial_flag.sql', 'supabase/migrations/20260918123000_phase17_open_signup_trial_flag.sql'],
  ['supabase/migration_phase18_profile_recovery.sql', 'supabase/migrations/20260918124000_phase18_profile_recovery.sql'],
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
assert.equal(sql("SELECT credits FROM public.profiles WHERE id='71000000-0000-4000-8000-000000000001'", upgradeDatabase), '7');
assert.equal(sql("SELECT trial_granted_at='2025-01-02T03:04:05Z'::timestamptz FROM public.profiles WHERE id='71000000-0000-4000-8000-000000000001'", upgradeDatabase), 't');
assert.equal(sql("SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='credits'", upgradeDatabase), '0');
assert.equal(sql("SELECT enabled FROM public.private_feature_flags WHERE key='non_edu_trial_credits_enabled'", upgradeDatabase), 't');
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
console.log('Phase 16 -> 17 -> 18 forward upgrade preserved historical state, enabled the launch promotion, and repaired a missing profile at zero credits');

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
file('supabase/tests/phase13_payment_and_admin_hardening.sql');
file('supabase/tests/storage_abuse_controls.sql');
file('supabase/tests/open_signup_trial_flag.sql');
file('supabase/tests/profile_recovery.sql');
sql("INSERT INTO auth.users(id,email) VALUES ('10000000-0000-4000-8000-000000000001','atomic@example.edu')");
file('tests/atomic-credits.sql');
console.log('Security, identity/trial, payment, storage, feature-flag, profile-recovery, and atomic SQL regression assertions passed');
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
  SELECT public.reserve_extraction('10000000-0000-4000-8000-000000000001','${id}',repeat('a',64))->>'status';
`)));
assert.equal(results.filter(status => status === 'reserved').length, 1);
assert.equal(results.filter(status => status === 'no_credits').length, 7);
assert.equal(sql("SELECT credits FROM public.profiles WHERE id='10000000-0000-4000-8000-000000000001'"), '0');
console.log('Eight concurrent connections: exactly one reservation, seven rejected, balance zero');
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
