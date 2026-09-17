import test from "node:test";
import assert from "node:assert/strict";
import { creditCall, finishExtraction } from "../src/lib/extraction-credits.ts";
const identity = { p_user_id: "user", p_request_id: "request" };
test("malformed credit responses fail closed", async () => {
    for (const data of [null, [], "reserved", { remainingCredits: -1 }, { materialId: 1 }]) {
        await assert.rejects(creditCall(async () => ({ data, error: null }), "reserve", {}));
    }
});
test("provider failure refunds before surfacing failure", async () => {
    const calls = [];
    const rpc = async (name) => { calls.push(name); return { data: { status: "failed" }, error: null }; };
    await assert.rejects(finishExtraction({ rpc, identity, completion: {}, generate: async () => { throw new Error("provider"); } }), /provider/);
    assert.deepEqual(calls, ["fail_extraction"]);
});
test("save failure settles reservation", async () => {
    const calls = [];
    const rpc = async (name) => {
        calls.push(name);
        return name === "complete_extraction" ? { data: null, error: "save failure" } : { data: { status: "failed" }, error: null };
    };
    await assert.rejects(finishExtraction({ rpc, identity, completion: {}, generate: async () => [] }));
    assert.deepEqual(calls, ["complete_extraction", "fail_extraction"]);
});
test("ambiguous successful commit returns saved result instead of double refund", async () => {
    const rpc = async (name) => name === "complete_extraction"
        ? { data: null, error: "connection lost after commit" }
        : { data: { status: "completed", materialId: "saved", remainingCredits: 0 }, error: null };
    const result = await finishExtraction({ rpc, identity, completion: {}, generate: async () => [] });
    assert.equal(result.materialId, "saved");
    assert.equal(result.remainingCredits, 0);
});
test("successful completion never refunds", async () => {
    const calls = [];
    const rpc = async (name) => { calls.push(name); return { data: { materialId: "saved", remainingCredits: 0 }, error: null }; };
    await finishExtraction({ rpc, identity, completion: {}, generate: async () => [] });
    assert.deepEqual(calls, ["complete_extraction"]);
});
