/* eslint-disable @typescript-eslint/no-require-imports -- Node offline test harness uses CommonJS. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Compile just the pure validation modules; no network, provider or database calls.
function loadSource(relativePath, dependencies = {}) {
  const filename = path.join(__dirname, '..', relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', output)(
    name => dependencies[name] ?? require(name), compiled, compiled.exports
  );
  return compiled.exports;
}
const storage = loadSource('src/lib/supabase/storage-helpers.ts');
const validation = loadSource('src/lib/extraction-validation.ts', {
  '@/lib/supabase/storage-helpers': storage,
});
const origin = 'https://project.supabase.co';
const user = 'owner';
const file = { url: `${origin}/storage/v1/object/sign/course-materials/owner/session/a.pdf?token=x`, path: 'owner/session/a.pdf', name: 'a.pdf', type: 'application/pdf', size: 8 };
const payload = () => ({ requestId: '11111111-1111-4111-8111-111111111111', courseName: 'Test', targetPages: 1, fileUrls: [{ ...file }] });

test('validates structure and rejects forged ownership, origins and paths', () => {
  assert.equal(validation.parseExtractionRequest(payload(), user, origin).fileUrls[0].path, file.path);
  for (const invalid of [null, [], 4, {}, { ...payload(), courseName: {} }, { ...payload(), targetPages: '1' }, { ...payload(), targetPages: 1.5 }, { ...payload(), fileUrls: {} }, { ...payload(), fileUrls: [null] }, { ...payload(), requestId: 'bad' }]) {
    assert.throws(() => validation.parseExtractionRequest(invalid, user, origin));
  }
  for (const patch of [
    { size: -1 }, { size: '8' }, { size: Infinity }, { size: 201 * 1024 * 1024 },
    { type: 'text/html' }, { type: '__proto__' }, { name: 'bad.png' },
    { path: 'other/session/a.pdf' },
    { url: file.url.replace('owner/', 'other/') },
    { url: file.url.replace('project.supabase.co', 'project.supabase.co.evil.test') },
    { url: file.url.replace('https:', 'http:') },
    { url: file.url.replace('/sign/', '/public/') },
    { url: file.url.replace('a.pdf', '%252e%252e') },
    { url: file.url.replace('a.pdf', 'a%2fb.pdf') },
    { url: file.url.replace('a.pdf', 'a%5cb.pdf') },
    { url: file.url + '#fragment' },
  ]) assert.throws(() => validation.parseExtractionRequest({ ...payload(), fileUrls: [{ ...file, ...patch }] }, user, origin));
  assert.throws(() => validation.parseExtractionRequest({ ...payload(), fileUrls: [file, file] }, user, origin));
});

test('bounds JSON body and rejects malformed input', async () => {
  const request = body => new Request('https://app.test/api/extract', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal((await validation.readExtractionRequest(request(JSON.stringify(payload())), user, origin)).targetPages, 1);
  await assert.rejects(validation.readExtractionRequest(request('{'), user, origin));
  await assert.rejects(validation.readExtractionRequest(request(' '.repeat(65537)), user, origin), { status: 413 });
});

test('rejects signature and actual byte mismatches and cancels oversized streams', async () => {
  const originalFetch = global.fetch;
  const originalOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_URL = origin;
  let cancelled = false;
  try {
    global.fetch = async (_url, options) => {
      assert.equal(options.redirect, 'error');
      return new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } });
    };
    assert.equal((await validation.downloadExtractionFiles([file]))[0].buffer.length, 8);
    global.fetch = async () => new Response('<script>', { headers: { 'content-type': 'application/pdf' } });
    await assert.rejects(validation.downloadExtractionFiles([file]), /declared type/);
    global.fetch = async () => new Response('%PDF-1.7', { headers: { 'content-type': 'text/html' } });
    await assert.rejects(validation.downloadExtractionFiles([file]), /declared type/);
    global.fetch = async () => new Response('%PDF-', { headers: { 'content-type': 'application/pdf' } });
    await assert.rejects(validation.downloadExtractionFiles([file]), /size differs/);
    global.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(9)); },
      cancel() { cancelled = true; },
    }));
    await assert.rejects(validation.downloadExtractionFiles([file]), /size limit/);
    assert.equal(cancelled, true);
    global.fetch = async () => new Response('%PDF-1.7', { headers: { 'content-length': '99999' } });
    await assert.rejects(validation.downloadExtractionFiles([file]), /size limit/);
    await assert.rejects(storage.downloadFileFromStorage('https://evil.test/a', origin, 8), /storage URL/);
  } finally {
    global.fetch = originalFetch;
    if (originalOrigin === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalOrigin;
  }
});

test('recognizes the allowlisted magic bytes', () => {
  for (const [type, bytes] of [
    ['application/pdf', Buffer.from('%PDF-1.7')],
    ['image/png', Buffer.from([137,80,78,71,13,10,26,10])],
    ['image/jpeg', Buffer.from([255,216,255])],
    ['image/gif', Buffer.from('GIF89a')],
    ['image/webp', Buffer.from('RIFF0000WEBP')],
  ]) {
    assert.equal(validation.matchesFileSignature(bytes, type), true);
    assert.equal(validation.matchesFileSignature(Buffer.from('invalid'), type), false);
  }
});
