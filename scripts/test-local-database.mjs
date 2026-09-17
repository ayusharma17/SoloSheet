// Runs only against a disposable, port-unpublished Docker PostgreSQL container.
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const container = process.env.TEST_POSTGRES_CONTAINER || 'solosheet-hardening-db';
const database = `hardening_${Date.now()}`;
const args = ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'];
function sql(text, db = database) {
  const result = spawnSync('docker', [...args, '-d', db, '-Atq'], { input: text, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
function file(path) { sql(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')); }
sql(`CREATE DATABASE ${database}`, 'postgres');
console.log(`Disposable test database: ${database}`);
// Roles are cluster-wide. Use a fresh container for each full suite invocation.
file('supabase/tests/local-bootstrap.sql');
for (const migration of ['migration.sql', 'migration_phase2.sql', 'migration_phase4.sql',
  'migration_phase5_anti_abuse.sql', 'migration_storage_setup.sql',
  'migration_phase6_credit_security.sql', 'migration_phase7_atomic_extraction.sql',
  'migration_phase8_retire_device_fingerprinting.sql',
  'migration_phase9_anti_abuse_foundation.sql',
  'migration_phase10_identity_and_trial.sql',
  'migration_phase11_extraction_access.sql',
  'migration_phase12_stripe_payments.sql']) {
  file(`supabase/${migration}`);
  console.log(`Applied ${migration}`);
}
file('supabase/tests/credit_security.sql');
file('supabase/tests/anti_abuse_foundation.sql');
file('supabase/tests/identity_and_trial.sql');
file('supabase/tests/stripe_payments.sql');
sql("INSERT INTO auth.users(id,email) VALUES ('10000000-0000-4000-8000-000000000001','atomic@example.edu')");
file('tests/atomic-credits.sql');
console.log('Security, identity/trial, anti-abuse foundation, and atomic SQL regression assertions passed');
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
const results = await Promise.all(requestIds.map(id => concurrentSql(`
  SET request.jwt.claim.role='service_role';
  SELECT public.reserve_extraction('10000000-0000-4000-8000-000000000001','${id}',repeat('a',64))->>'status';
`)));
assert.equal(results.filter(status => status === 'reserved').length, 1);
assert.equal(results.filter(status => status === 'no_credits').length, 7);
assert.equal(sql("SELECT credits FROM public.profiles WHERE id='10000000-0000-4000-8000-000000000001'"), '0');
console.log('Eight concurrent connections: exactly one reservation, seven rejected, balance zero');
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
console.log('No deployed services were accessed. Remove the disposable container after review.');
