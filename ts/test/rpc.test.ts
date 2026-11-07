/**
 * The JSON-RPC client against a pretend node: what an error carries when the node answers with an
 * HTTP status other than 200. neard 2.13.4 answers an unknown block below its head with HTTP 422,
 * a timeout with HTTP 408 and an internal error with HTTP 500, each with NEAR's usual JSON-RPC
 * error body (chain/jsonrpc/src/lib.rs, `rpc_handler`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { RpcError, jsonRpc, type Transport } from "../screener/rpc.ts";

/** A transport that answers every request with `status` and `body`. */
const answering = (status: number, body: unknown): Transport => async () =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** NEAR's JSON-RPC error body, as neard sends it. */
const nearError = (cause: string, data: string): unknown => ({
  jsonrpc: "2.0",
  id: 1,
  error: { name: "HANDLER_ERROR", cause: { info: {}, name: cause }, code: -32000, message: "Server error", data },
});

test("a node's HTTP 422 and 408 answers keep NEAR's own cause name, so a skipped block and a timeout read as such", async () => {
  const unknownBlock = jsonRpc("http://node.test", answering(422, nearError("UNKNOWN_BLOCK", "DB Not Found Error: BLOCK HEIGHT: 18 \n Cause: Unknown")));
  await assert.rejects(unknownBlock.call("block", { block_id: 18 }), (error: unknown) => {
    assert.ok(error instanceof RpcError, String(error));
    assert.deepEqual([error.method, error.causeName, error.httpStatus], ["block", "UNKNOWN_BLOCK", 422]);
    assert.match(error.message, /BLOCK HEIGHT: 18/);
    return true;
  });
  const timeout = jsonRpc("http://node.test", answering(408, nearError("TIMEOUT_ERROR", "Timeout")));
  await assert.rejects(timeout.call("tx", {}), (error: unknown) => {
    assert.ok(error instanceof RpcError, String(error));
    assert.deepEqual([error.method, error.causeName, error.httpStatus], ["tx", "TIMEOUT_ERROR", 408]);
    return true;
  });
});

test("an answer other than 200 without NEAR's error body is named by its HTTP status", async () => {
  const proxy = jsonRpc("http://node.test", answering(502, "<html>bad gateway</html>"));
  await assert.rejects(proxy.call("block", {}), (error: unknown) => {
    assert.ok(error instanceof RpcError, String(error));
    assert.deepEqual([error.causeName, error.httpStatus], ["HTTP_502", 502]);
    assert.match(error.message, /bad gateway/);
    return true;
  });
});
