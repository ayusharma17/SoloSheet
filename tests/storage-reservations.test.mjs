import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupUploadedFiles,
  cleanupStaleCourseUploads,
  createCourseUploadPath,
  uploadCourseFile,
} from "../src/lib/supabase/storage-helpers.ts";

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

test("stale recovery removes only old owned objects through normal cleanup", async () => {
  const userId = "70000000-0000-4000-8000-000000000001";
  const sessionId = "71000000-0000-4000-8000-000000000001";
  const oldFile = "72000000-0000-4000-8000-000000000001.pdf";
  const recentFile = "72000000-0000-4000-8000-000000000002.pdf";
  const calls = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
    rpc: async (name, args) => {
      calls.push({ kind: "rpc", name, args });
      return { data: { status: "released" }, error: null };
    },
    storage: {
      from: () => ({
        list: async prefix => prefix === userId
          ? { data: [{ name: sessionId }], error: null }
          : { data: [
              { name: oldFile, updated_at: "2024-01-01T00:00:00.000Z" },
              { name: recentFile, updated_at: "2026-01-02T00:00:00.000Z" },
            ], error: null },
        remove: async paths => {
          calls.push({ kind: "remove", paths });
          return { error: null };
        },
      }),
    },
  };
  const removed = await cleanupStaleCourseUploads(
    client,
    userId,
    new Date("2026-01-01T00:00:00.000Z"),
  );
  assert.equal(removed, 1);
  assert.deepEqual(calls[0], {
    kind: "remove",
    paths: [`${userId}/${sessionId}/${oldFile}`],
  });
  assert.equal(calls[1].name, "release_course_material_uploads");
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
