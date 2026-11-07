/**
 * Reading a Trezu list through `bulkpayment.near` `view_list`, and the factory's DAOs, on recorded
 * response shapes. The list here is made up; no real list of people is kept in this repo.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchFactoryDaos, fetchTrezuList } from "../screener/trezu-list.ts";
import { ViewError, type Rpc } from "../screener/rpc.ts";

const ID = "ab".repeat(32);

const viewRpc = (answer: (method: string, args: Record<string, unknown>) => unknown): Rpc => ({
  url: "test",
  async call<T>(_method: string, params: unknown): Promise<T> {
    const p = params as { account_id: string; method_name: string; args_base64: string };
    const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString("utf8")) as Record<string, unknown>;
    const out = answer(`${p.account_id}.${p.method_name}`, args);
    if (typeof out === "string") return { error: out } as T;
    return { result: [...Buffer.from(JSON.stringify(out))] } as T;
  },
});

// The text a NEAR node returns when a view panics, recorded from free.rpc.fastnear.com.
const NOT_FOUND =
  'wasm execution failed with error: HostError(GuestPanic { panic_msg: "panicked at src/lib.rs:607:14:\\nPayment list not found" })';

test("view_list: the DAO that submitted it, its token, status and recipients", async () => {
  const rpc = viewRpc((call, args) => {
    assert.equal(call, "bulkpayment.near.view_list");
    assert.deepEqual(args, { list_id: ID });
    return {
      token_id: "native",
      submitter: "some-dao.sputnik-dao.near",
      status: "Approved",
      created_at: 1,
      payments: [
        { recipient: "one.near", amount: "5", status: "Pending" },
        { recipient: "two.near", amount: "7", status: { Paid: { block_height: 9 } } },
      ],
    };
  });
  const list = await fetchTrezuList(rpc, ID);
  assert.deepEqual(list, { listId: ID, submitter: "some-dao.sputnik-dao.near", tokenId: "native", status: "Approved", recipients: ["one.near", "two.near"] });
});

test("view_list: a list the contract does not hold says so in the contract's words", async () => {
  await assert.rejects(
    () => fetchTrezuList(viewRpc(() => NOT_FOUND), ID),
    (error: unknown) => error instanceof ViewError && /bulkpayment\.near\.view_list: Payment list not found$/.test(error.message),
  );
});

test("view_list: refuses an id that is not a list id before asking the network", async () => {
  let asked = false;
  const rpc = viewRpc(() => ((asked = true), {}));
  await assert.rejects(() => fetchTrezuList(rpc, "not-an-id"), /64 lowercase hex/);
  assert.equal(asked, false);
});

test("view_list: an answer that is not a list is refused", async () => {
  await assert.rejects(() => fetchTrezuList(viewRpc(() => ({ nope: 1 })), ID), /not a payment list/);
});

test("get_daos: pages by position", async () => {
  const rpc = viewRpc((call, args) => {
    assert.equal(call, "sputnik-dao.near.get_daos");
    assert.deepEqual(args, { from_index: 1000, limit: 2 });
    return ["a.sputnik-dao.near", "b.sputnik-dao.near"];
  });
  assert.deepEqual(await fetchFactoryDaos(rpc, 1000, 2), ["a.sputnik-dao.near", "b.sputnik-dao.near"]);
});
