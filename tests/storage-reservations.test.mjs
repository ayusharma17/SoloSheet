import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupUploadedFiles,
  createCourseUploadPath,
  uploadCourseFile,
} from "../src/lib/supabase/storage-helpers.ts";
import {
  ActiveExtractionStore,
  UploadCleanupJournal,
  extractionPollDelay,
  retryDisposition,
} from "../src/lib/upload-lifecycle.ts";

function mockClient() {
  const calls = [];
  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: "user-one" } }, error: null }),
    },
    rpc: async (name, args) => {
      calls.push({ kind: "rpc", name, args });
      return { data: { status: name.startsWith("reserve") ? "reserved" : "released" }, error: null };
    },
    storage: {
      from: () => ({
        upload: async (path) => {
          calls.push({ kind: "upload", path });
          return { error: null };
        },
        createSignedUrl: async (path) => {
          calls.push({ kind: "sign", path });
          return { data: { signedUrl: "https://storage.test/signed" }, error: null };
        },
        remove: async (paths) => {
          calls.push({ kind: "remove", paths });
          return { error: null };
        },
      }),
    },
  };
  return { client, calls };
}

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

test("upload reserves the exact generated path before writing Storage", async () => {
  const { client, calls } = mockClient();
  const file = { name: "notes.pdf", type: "application/pdf", size: 42 };
  const preparedPath = createCourseUploadPath("user-one", "session-one", file);
  const result = await uploadCourseFile(
    client,
    "user-one",
    "session-one",
    file,
    preparedPath,
  );
  assert.equal(result.path, preparedPath);
  assert.equal(calls[0].name, "reserve_course_material_upload");
  assert.equal(calls[0].args.p_path, result.path);
  assert.equal(calls[0].args.p_size_bytes, 42);
  assert.equal(calls[1].kind, "upload");
});

test("cleanup deletes objects before releasing their quota reservations", async () => {
  const { client, calls } = mockClient();
  const path = "user-one/session-one/file-one.pdf";
  assert.equal(await cleanupUploadedFiles(client, [path]), true);
  assert.deepEqual(calls.map(call => call.kind === "rpc" ? call.name : call.kind), [
    "remove",
    "release_course_material_uploads",
  ]);
});

test("cleanup journal flushes more than ten due paths in bounded batches", async () => {
  let stored = "[]";
  const storage = {
    getItem: () => stored,
    setItem: (_key, value) => { stored = value; },
  };
  const journal = new UploadCleanupJournal(storage, () => 1000);
  for (let index = 0; index < 12; index += 1) {
    journal.track(`user-one/session/${index}.pdf`, false);
  }
  const batches = [];
  await journal.flush("user-one", async paths => {
    batches.push(paths);
    return true;
  });
  assert.deepEqual(batches.map(batch => batch.length), [10, 2]);
  assert.deepEqual(JSON.parse(stored), []);
});

test("cleanup journal forgets paths owned by a terminal server job", () => {
  let stored = "[]";
  const storage = {
    getItem: () => stored,
    setItem: (_key, value) => { stored = value; },
  };
  const journal = new UploadCleanupJournal(storage, () => 1000);
  journal.track("user-one/session/one.pdf");
  journal.track("user-one/session/two.pdf");
  journal.forget(["user-one/session/one.pdf"]);
  assert.deepEqual(JSON.parse(stored).map(entry => entry.path), ["user-one/session/two.pdf"]);
});

test("an explicit terminal extraction failure restarts instead of preserving inaccessible uploads", () => {
  assert.equal(retryDisposition(500, {
    code: "EXTRACTION_RESTART_REQUIRED",
  }), "restart");
  assert.equal(retryDisposition(500, {
    error: "Connection outcome is unknown",
  }), "preserve");
});

test("active extraction recovery stores only owner, request ID, and timestamp", () => {
  const storage = memoryStorage();
  const userId = "70000000-0000-4000-8000-000000000001";
  const requestId = "71000000-0000-4000-8000-000000000001";
  const store = new ActiveExtractionStore(storage, () => 1000);
  store.save(userId, requestId);
  assert.equal(store.get(userId), requestId);
  assert.equal(storage.values.size, 1);
  const stored = [...storage.values.values()][0];
  assert.deepEqual(JSON.parse(stored), { userId, requestId, savedAt: 1000 });
  assert.equal(stored.includes("url"), false);
  store.clear(userId, requestId);
  assert.equal(storage.values.size, 0);
});

test("active extraction recovery preserves concurrent request IDs and reveals the next one", () => {
  let now = 1000;
  const storage = memoryStorage();
  const userId = "70000000-0000-4000-8000-000000000001";
  const first = "71000000-0000-4000-8000-000000000001";
  const second = "71000000-0000-4000-8000-000000000002";
  const store = new ActiveExtractionStore(storage, () => now);
  store.save(userId, first);
  now += 1;
  store.save(userId, second);
  assert.deepEqual(store.getAll(userId), [second, first]);
  store.clear(userId, second);
  assert.equal(store.get(userId), first);
});

test("active extraction recovery cannot lose interleaved tab writers", () => {
  const storage = memoryStorage();
  const userId = "70000000-0000-4000-8000-000000000001";
  const first = "71000000-0000-4000-8000-000000000001";
  const second = "71000000-0000-4000-8000-000000000002";
  const firstTab = new ActiveExtractionStore(storage, () => 1000);
  const secondTab = new ActiveExtractionStore(storage, () => 1001);

  firstTab.save(userId, first);
  secondTab.save(userId, second);

  assert.deepEqual(new ActiveExtractionStore(storage, () => 1002).getAll(userId), [second, first]);
  assert.equal(storage.values.size, 2);
});

test("active extraction recovery bounds retained requests per user", () => {
  let now = 1000;
  const storage = memoryStorage();
  const userId = "70000000-0000-4000-8000-000000000001";
  const store = new ActiveExtractionStore(storage, () => now);
  for (let index = 0; index < 12; index += 1) {
    store.save(userId, `71000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    now += 1;
  }
  assert.equal(store.getAll(userId).length, 8);
});

test("active extraction recovery rejects malformed and expired entries", () => {
  const userId = "70000000-0000-4000-8000-000000000001";
  const validRequestId = "71000000-0000-4000-8000-000000000001";
  const storage = memoryStorage({
    [`solosheet-active-extraction-v2:${userId}:not-a-request`]: JSON.stringify({ userId, requestId: "not-a-request", savedAt: 1000 }),
    [`solosheet-active-extraction-v2:${userId}:${validRequestId}`]: JSON.stringify({ userId, requestId: validRequestId, savedAt: 1000 }),
  });
  assert.equal(new ActiveExtractionStore(storage, () => 24 * 60 * 60 * 1000 + 1001).get(userId), null);
});

test("poll delays back off for healthy jobs and failures with bounded testable jitter", () => {
  const middleJitter = () => 0.5;
  assert.deepEqual(
    [0, 1, 2, 3, 4, 20].map(failures => extractionPollDelay(failures, 0, middleJitter)),
    [1250, 2000, 4000, 8000, 10000, 10000],
  );
  const healthy = [0, 1, 2, 5, 20].map(polls => extractionPollDelay(0, polls, middleJitter));
  assert.deepEqual(healthy, [1250, 1688, 2278, 5605, 10000]);
  assert.equal(extractionPollDelay(0, 20, () => -1), 9000);
  assert.equal(extractionPollDelay(20, 0, () => 2), 10000);
});
