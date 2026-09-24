/* eslint-disable @typescript-eslint/no-require-imports -- isolated TypeScript handler harness. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

class ExtractionProviderError extends Error {
  constructor(failureCode, retryable) {
    super('provider failed');
    this.failureCode = failureCode;
    this.retryable = retryable;
  }
}
class ExtractionOutputError extends Error { constructor() { super(); this.failureCode = 'invalid_output'; } }
class ExtractionRuntimeError extends Error {
  constructor(failureCode, retryable) { super(); this.failureCode = failureCode; this.retryable = retryable; }
}

function loadWorker(overrides = {}) {
  const filename = path.join(__dirname, '..', 'netlify/functions/process-extraction-background.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const compiled = { exports: {} };
  const runtime = {
    authorizedDispatch: () => true,
    cleanupJobUploads: async () => {},
    createWorkerClient: () => overrides.client,
    leaseRenewalDisposition: (renewed, error, deadline) => !error && renewed === true ? 'active' : !error || Date.now() >= deadline ? 'lost' : 'transient_error',
    parseRequestId: value => {
      if (typeof value !== 'string') throw new Error('invalid');
      return value;
    },
    ...overrides.runtime,
  };
  const dependencies = {
    '../../src/lib/gemini': {
      extractFromMaterials: overrides.extract ?? (async () => [{ topic: 'ok' }]),
      ExtractionProviderError,
      ExtractionOutputError,
    },
    '../../src/lib/extraction-validation': {
      ExtractionRuntimeError,
      iterateExtractionJobFiles: () => ({ async *[Symbol.asyncIterator]() { yield { name: 'a.pdf' }; } }),
    },
    '../../src/lib/extraction-jobs': { parseClaimedExtractionJob: value => value },
    './_shared/extraction-runtime': runtime,
  };
  new Function('require', 'module', 'exports', output)(
    name => dependencies[name] ?? require(name), compiled, compiled.exports,
  );
  return compiled.exports.default;
}

const id = '11111111-1111-4111-8111-111111111111';
const request = (body = JSON.stringify({ requestId: id }), authorization = true) => new Request('https://app.test/internal/extraction-worker', {
  method: 'POST',
  headers: authorization ? { authorization: 'Bearer secret' } : {},
  body,
});
const processing = { status: 'processing', userId: 'owner', userDirective: '', fileInputs: [{ path: 'owner/session/a.pdf' }] };

test('worker hides unauthorized dispatch and rejects malformed JSON before claiming', async () => {
  let claimed = false;
  const client = { rpc: async () => { claimed = true; return { data: null, error: null }; } };
  const unauthorized = loadWorker({ client, runtime: { authorizedDispatch: () => false } });
  assert.equal((await unauthorized(request())).status, 404);
  const malformed = loadWorker({ client });
  assert.equal((await malformed(request('{'))).status, 400);
  assert.equal(claimed, false);
});

test('worker preserves a live competing lease as a retry signal', async () => {
  const client = { rpc: async () => ({ data: { status: 'leased' }, error: null }) };
  await assert.rejects(loadWorker({ client })(request()), /active lease/);
});

test('retryable provider failure is settled back to queued and rethrown for platform retry', async () => {
  const calls = [];
  const client = { rpc: async (name, args) => {
    calls.push([name, args]);
    if (name === 'claim_extraction_job') return { data: processing, error: null };
    if (name === 'heartbeat_extraction_job') return { data: true, error: null };
    if (name === 'fail_extraction_job') return { data: { status: 'queued' }, error: null };
    throw new Error(`unexpected ${name}`);
  } };
  const handler = loadWorker({ client, extract: async () => { throw new ExtractionProviderError('provider_transient', true); } });
  await assert.rejects(handler(request()), /Retryable extraction failure/);
  const settlement = calls.find(([name]) => name === 'fail_extraction_job')[1];
  assert.equal(settlement.p_failure_code, 'provider_transient');
  assert.equal(settlement.p_retryable, true);
});

test('completed and terminal-failed jobs both attempt upload cleanup', async () => {
  for (const mode of ['completed', 'failed']) {
    let cleaned = 0;
    const client = { rpc: async name => {
      if (name === 'claim_extraction_job') return { data: processing, error: null };
      if (name === 'heartbeat_extraction_job') return { data: true, error: null };
      if (name === 'complete_extraction_job') return { data: { status: 'completed' }, error: null };
      if (name === 'fail_extraction_job') return { data: { status: 'failed' }, error: null };
      throw new Error(`unexpected ${name}`);
    } };
    const extract = mode === 'failed'
      ? async () => { throw new ExtractionOutputError(); }
      : async () => [{ topic: 'ok' }];
    const handler = loadWorker({ client, extract, runtime: { cleanupJobUploads: async () => { cleaned += 1; } } });
    await handler(request());
    assert.equal(cleaned, 1, mode);
  }
});
