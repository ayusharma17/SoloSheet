import assert from "node:assert/strict";
import test from "node:test";
import { ActiveExtractionStore } from "../src/lib/upload-lifecycle.ts";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
    values,
  };
}

test("per-request recovery keys preserve interleaved tab writers", () => {
  const storage = memoryStorage();
  const userId = "70000000-0000-4000-8000-000000000001";
  const first = "71000000-0000-4000-8000-000000000001";
  const second = "71000000-0000-4000-8000-000000000002";

  new ActiveExtractionStore(storage, () => 1000).save(userId, first);
  new ActiveExtractionStore(storage, () => 1001).save(userId, second);

  assert.deepEqual(new ActiveExtractionStore(storage, () => 1002).getAll(userId), [second, first]);
  assert.equal(storage.values.size, 2);
});

test("recovery ignores malformed, mismatched, future, and expired entries", () => {
  const userId = "70000000-0000-4000-8000-000000000001";
  const requestId = "71000000-0000-4000-8000-000000000001";
  const prefix = `solosheet-active-extraction-v2:${userId}:`;
  const storage = memoryStorage({
    [`${prefix}${requestId}`]: JSON.stringify({ userId, requestId, savedAt: 1000 }),
    [`${prefix}71000000-0000-4000-8000-000000000002`]: "{",
    [`${prefix}71000000-0000-4000-8000-000000000003`]: JSON.stringify({ userId, requestId: "not-a-uuid", savedAt: 1000 }),
    [`${prefix}71000000-0000-4000-8000-000000000004`]: JSON.stringify({ userId, requestId: "71000000-0000-4000-8000-000000000004", savedAt: 3000 }),
  });

  assert.deepEqual(new ActiveExtractionStore(storage, () => 2000).getAll(userId), [requestId]);
  assert.deepEqual(new ActiveExtractionStore(storage, () => 24 * 60 * 60 * 1000 + 1001).getAll(userId), []);
});
