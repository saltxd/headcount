/**
 * Waiting for a sandbox transaction's final outcome on a slow machine. The `tx` query asks the node
 * to wait until the transaction is final, and a loaded node gives up first: it answers HTTP 408 with
 * NEAR's TIMEOUT_ERROR. The transaction was already sent, so asking again is safe. These run
 * `waitFinal` through the real JSON-RPC client against a pretend node, with a pretend clock.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { waitFinal, type FinalTx } from "../sandbox/send.ts";
import { RpcError, jsonRpc, type Transport } from "../screener/rpc.ts";

const FINAL: FinalTx = { status: { SuccessValue: "" }, receipts_outcome: [] };

type Answer = "timeout" | "bare-408" | "final" | "invalid";

/**
 * A node whose answers to `tx` come from `answers` in turn (the last one repeats). Each answer
 * moves the pretend clock 10 s, as the node's own wait before a timeout would.
 */
const pretendNode = (answers: readonly Answer[]) => {
  const clock = { now: 0 };
  const calls: unknown[] = [];
  const slept: number[] = [];
  let n = 0;
  const transport: Transport = async (_url, init) => {
    const { id, method, params } = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown };
    calls.push([method, params]);
    clock.now += 10_000;
    const answer = answers[Math.min(n, answers.length - 1)];
    n += 1;
    const failure = (status: number, cause: string, data: string): Response =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id, error: { name: "HANDLER_ERROR", cause: { name: cause }, code: -32000, message: "Server error", data } }),
        { status },
      );
    if (answer === "timeout") return failure(408, "TIMEOUT_ERROR", "Timeout");
    if (answer === "bare-408") return new Response("Request Timeout", { status: 408 });
    if (answer === "invalid") return failure(200, "INVALID_TRANSACTION", "made up");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: FINAL }), { status: 200 });
  };
  const options = {
    now: () => clock.now,
    sleep: async (ms: number): Promise<void> => {
      slept.push(ms);
      clock.now += ms;
    },
  };
  return { rpc: jsonRpc("http://node.test", transport), calls, slept, options };
};

test("waitFinal: a tx query that times out once (HTTP 408) is asked again, and the final outcome comes back", async () => {
  const node = pretendNode(["timeout", "final"]);
  assert.deepEqual(await waitFinal(node.rpc, "tx-hash", "alice.test.near", node.options), FINAL);
  const asked = ["tx", { tx_hash: "tx-hash", sender_account_id: "alice.test.near", wait_until: "FINAL" }];
  assert.deepEqual(node.calls, [asked, asked], "the same query, twice");
  assert.equal(node.slept.length, 1);
});

test("waitFinal: a tx query that keeps timing out fails with the node's own timeout error once the wait is over", async () => {
  const node = pretendNode(["timeout"]);
  await assert.rejects(waitFinal(node.rpc, "tx-hash", "alice.test.near", { ...node.options, waitMs: 60_000 }), (error: unknown) => {
    assert.ok(error instanceof RpcError, String(error));
    assert.deepEqual([error.method, error.causeName, error.httpStatus], ["tx", "TIMEOUT_ERROR", 408]);
    return true;
  });
  // Each query takes the node's 10 s; the pauses between them double from 200 ms up to 2 s.
  assert.deepEqual(node.slept, [200, 400, 800, 1600, 2000], "pauses that double, then stop growing");
  assert.equal(node.calls.length, 6, "asked as often as fits in the 60 s wait, and no more");
});

test("waitFinal: a bare HTTP 408, with no NEAR error body, counts as a timeout too", async () => {
  const node = pretendNode(["bare-408", "final"]);
  assert.deepEqual(await waitFinal(node.rpc, "tx-hash", "alice.test.near", node.options), FINAL);
  assert.equal(node.calls.length, 2);
});

test("waitFinal: any other error fails at once", async () => {
  const node = pretendNode(["invalid", "final"]);
  await assert.rejects(waitFinal(node.rpc, "tx-hash", "alice.test.near", node.options), /INVALID_TRANSACTION/);
  assert.equal(node.calls.length, 1);
});
