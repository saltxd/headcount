/**
 * How the block scan turns a transaction's receipts into facts, on hand-written transactions in
 * the shape `EXPERIMENTAL_tx_status` returns. Every account and key here is made up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import nearApi from "near-api-js";

import { buildIndex, factsFromTx, impliedKey, scanChain, type Fact, type RpcAction, type TxStatus } from "../screener/block-scan.ts";
import type { Rpc } from "../screener/rpc.ts";
import { NEAR_ASSET } from "../screener/types.ts";

const REGISTRARS = new Set(["near"]);
const HEIGHTS = new Map([
  ["block-5", 5],
  ["block-6", 6],
  ["block-7", 7],
  ["block-9", 9],
]);
const heightOf = (hash: string): number | undefined => HEIGHTS.get(hash);

interface ReceiptSpec {
  readonly id: string;
  readonly predecessor: string;
  readonly receiver: string;
  readonly signer?: string;
  readonly actions: readonly RpcAction[];
  readonly block?: string;
  readonly failed?: boolean;
  readonly logs?: readonly string[];
  readonly children?: readonly string[];
  /** NEAR's tx status leaves out the receipt of a transaction its own receiver signed. */
  readonly unlisted?: boolean;
}

/** A transaction whose first receipt is `receipts[0]`, in the shape EXPERIMENTAL_tx_status returns. */
const txStatus = (hash: string, receipts: readonly ReceiptSpec[]): TxStatus => {
  const [first] = receipts;
  if (!first) throw new Error("a transaction has at least one receipt");
  const signer = first.signer ?? first.predecessor;
  return {
    transaction: { hash, signer_id: signer, receiver_id: first.receiver, actions: first.actions },
    transaction_outcome: { block_hash: first.block ?? "block-5", outcome: { receipt_ids: [first.id] } },
    receipts: receipts
      .filter((r) => !r.unlisted)
      .map((r) => ({
        receipt_id: r.id,
        predecessor_id: r.predecessor,
        receiver_id: r.receiver,
        receipt: { Action: { signer_id: r.signer ?? signer, actions: r.actions } },
      })),
    receipts_outcome: receipts.map((r) => ({
      id: r.id,
      block_hash: r.block ?? "block-5",
      outcome: {
        status: r.failed ? { Failure: { ActionError: { index: 0, kind: "made up" } } } : { SuccessValue: "" },
        logs: r.logs ?? [],
        receipt_ids: r.children ?? [],
        executor_id: r.receiver,
      },
    })),
  };
};

const fullKey = (key: string): RpcAction => ({ AddKey: { public_key: key, access_key: { nonce: 0, permission: "FullAccess" } } });
const callKey = (key: string): RpcAction => ({
  AddKey: { public_key: key, access_key: { nonce: 0, permission: { FunctionCall: { allowance: null, receiver_id: "app.example", method_names: [] } } } },
});
const pay = (deposit: bigint): RpcAction => ({ Transfer: { deposit: String(deposit) } });
const call = (method: string, deposit = 0n): RpcAction => ({ FunctionCall: { method_name: method, args: "", gas: 30_000_000_000_000, deposit: String(deposit) } });
const ftEvent = (from: string, to: string, amount: string): string =>
  `EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1.0.0", event: "ft_transfer", data: [{ old_owner_id: from, new_owner_id: to, amount }] })}`;

const creations = (facts: readonly Fact[]) => facts.flatMap((f) => (f.kind === "create" ? [{ account: f.account, ...f.creation }] : []));
const transfers = (facts: readonly Fact[]) => facts.flatMap((f) => (f.kind === "transfer" ? [f.transfer] : []));

test("a sub-account is created by its parent, with the full-access keys its creation added", () => {
  const facts = factsFromTx(
    txStatus("tx-sub", [
      {
        id: "r1",
        predecessor: "farm.example",
        receiver: "x.farm.example",
        actions: ["CreateAccount", pay(1000n), fullKey("ed25519:A"), callKey("ed25519:F")],
      },
    ]),
    heightOf,
    REGISTRARS,
  );
  assert.deepEqual(creations(facts), [
    { account: "x.farm.example", creator: "farm.example", how: "sub-account", txHash: "tx-sub", blockHeight: 5, initialKeys: ["ed25519:A"] },
  ]);
  assert.deepEqual(transfers(facts), [
    { from: "farm.example", to: "x.farm.example", asset: NEAR_ASSET, amount: 1000n, txHash: "tx-sub", blockHeight: 5 },
  ]);
  assert.deepEqual(
    facts.filter((f) => f.kind === "add-key"),
    [{ kind: "add-key", account: "x.farm.example", key: "ed25519:A", blockHeight: 5 }],
    "a function-call key is not a full-access key",
  );
});

test("an account the registrar creates counts as created by whoever called the registrar, also through a relayer", () => {
  const direct = factsFromTx(
    txStatus("tx-direct", [
      { id: "r1", predecessor: "alice.near", receiver: "near", actions: [call("create_account", 10n)], children: ["r2"] },
      { id: "r2", predecessor: "near", receiver: "bob.near", signer: "alice.near", actions: ["CreateAccount", fullKey("ed25519:B"), pay(10n)], block: "block-6" },
    ]),
    heightOf,
    REGISTRARS,
  );
  assert.deepEqual(creations(direct).map((c) => [c.account, c.creator, c.how]), [["bob.near", "alice.near", "via-registrar"]]);

  // A meta-transaction: a relayer signs, and the user's delegated call reaches the registrar.
  const relayed = factsFromTx(
    txStatus("tx-relayed", [
      { id: "r0", predecessor: "relayer.near", receiver: "carol.near", actions: [{ Delegate: { delegate_action: {}, signature: "" } }], children: ["r1"] },
      { id: "r1", predecessor: "carol.near", receiver: "near", signer: "relayer.near", actions: [call("create_account", 10n)], children: ["r2"], block: "block-6" },
      { id: "r2", predecessor: "near", receiver: "dave.near", signer: "relayer.near", actions: ["CreateAccount", fullKey("ed25519:D"), pay(10n)], block: "block-7" },
    ]),
    heightOf,
    REGISTRARS,
  );
  assert.deepEqual(creations(relayed).map((c) => [c.account, c.creator]), [["dave.near", "carol.near"]], "the user, not the relayer");
});

test("an implicit account is created by its first NEAR transfer, and its id is its first key", () => {
  const key = nearApi.KeyPair.fromRandom("ed25519");
  const implicit = Buffer.from(key.getPublicKey().data).toString("hex");
  assert.equal(impliedKey(implicit), key.getPublicKey().toString(), "the same key near-api-js derives");
  assert.equal(impliedKey("alice.near"), null);

  const index = buildIndex([
    ...factsFromTx(txStatus("tx-first", [{ id: "r1", predecessor: "sponsor.example", receiver: implicit, actions: [pay(5n)] }]), heightOf, REGISTRARS),
    ...factsFromTx(
      txStatus("tx-later", [{ id: "r2", predecessor: "other.example", receiver: implicit, actions: [pay(7n)], block: "block-9" }]),
      heightOf,
      REGISTRARS,
    ),
  ]);
  assert.deepEqual(index.creations.get(implicit), {
    creator: "sponsor.example",
    how: "first-transfer",
    txHash: "tx-first",
    blockHeight: 5,
    initialKeys: [key.getPublicKey().toString()],
  });
  assert.deepEqual([...(index.createdBy.get("sponsor.example") ?? [])], [implicit]);
  assert.equal(index.createdBy.get("other.example"), undefined, "a later transfer creates nothing");
  assert.deepEqual([...(index.keysOf.get(implicit) ?? [])], [key.getPublicKey().toString()]);
  assert.deepEqual(index.transfersTo.get(implicit)?.map((t) => t.from), ["sponsor.example", "other.example"]);
});

test("failed receipts and gas refunds leave no facts, and nor do receipts after the scanned head", () => {
  const facts = factsFromTx(
    txStatus("tx-mixed", [
      { id: "r1", predecessor: "a.example", receiver: "b.example", actions: [pay(100n)], failed: true, children: ["r2"] },
      { id: "r2", predecessor: "system", receiver: "a.example", actions: [pay(100n)] },
      { id: "r3", predecessor: "a.example", receiver: "c.example", actions: [pay(100n)], block: "block-not-scanned" },
    ]),
    heightOf,
    REGISTRARS,
  );
  assert.deepEqual(facts, []);
});

test("a token transfer counts only when the sender itself called the token", () => {
  const facts = factsFromTx(
    txStatus("tx-ft", [
      // alice calls the token: counted.
      { id: "r1", predecessor: "alice.example", receiver: "usdc.example", actions: [call("ft_transfer", 1n)], logs: [ftEvent("alice.example", "bob.example", "250")] },
      // A contract of mallory's logs an event naming alice as the sender: alice never called it.
      { id: "r2", predecessor: "mallory.example", receiver: "fake.example", actions: [call("anything")], logs: [ftEvent("alice.example", "carol.example", "999")] },
      // A refund leg: the token calls itself; the receiver did not send anything.
      { id: "r3", predecessor: "usdc.example", receiver: "usdc.example", actions: [call("ft_resolve_transfer")], logs: [ftEvent("bob.example", "alice.example", "50")] },
      // Not JSON, or not a transfer: ignored.
      { id: "r4", predecessor: "dave.example", receiver: "usdc.example", actions: [call("ft_transfer", 1n)], logs: ["EVENT_JSON:{oops", "plain log"] },
    ]),
    heightOf,
    REGISTRARS,
  );
  assert.deepEqual(transfers(facts), [
    { from: "alice.example", to: "bob.example", asset: "usdc.example", amount: 250n, txHash: "tx-ft", blockHeight: 5 },
  ]);
});

test("a transaction an account signs to itself still shows its key changes, though tx status lists no receipt for it", () => {
  const rotation = txStatus("tx-rotate", [
    {
      id: "r1",
      predecessor: "omar.example",
      receiver: "omar.example",
      actions: [fullKey("ed25519:fresh"), { DeleteKey: { public_key: "ed25519:shared" } }],
      unlisted: true,
      block: "block-9",
    },
  ]);
  assert.equal(rotation.receipts?.length, 0, "the fixture lists no receipt, as NEAR's RPC does");
  const index = buildIndex([
    ...factsFromTx(
      txStatus("tx-create", [{ id: "r0", predecessor: "near", receiver: "omar.example", signer: "near", actions: ["CreateAccount", fullKey("ed25519:shared")] }]),
      heightOf,
      REGISTRARS,
    ),
    ...factsFromTx(rotation, heightOf, REGISTRARS),
  ]);
  assert.deepEqual([...(index.keysOf.get("omar.example") ?? [])], ["ed25519:fresh"]);
  assert.deepEqual([...(index.everHeld.get("ed25519:shared") ?? [])], ["omar.example"], "the key it was created with still counts as held");
  assert.deepEqual(index.creations.get("omar.example")?.initialKeys, ["ed25519:shared"]);
});

test("a deleted account loses its keys and its creation; one created again under the same name starts over", () => {
  const index = buildIndex([
    ...factsFromTx(txStatus("tx-1", [{ id: "r1", predecessor: "p.example", receiver: "x.p.example", actions: ["CreateAccount", fullKey("ed25519:old")] }]), heightOf, REGISTRARS),
    ...factsFromTx(
      txStatus("tx-2", [{ id: "r2", predecessor: "x.p.example", receiver: "x.p.example", actions: [{ DeleteAccount: { beneficiary_id: "p.example" } }], block: "block-6" }]),
      heightOf,
      REGISTRARS,
    ),
    ...factsFromTx(
      txStatus("tx-3", [{ id: "r3", predecessor: "p.example", receiver: "x.p.example", actions: ["CreateAccount", fullKey("ed25519:new")], block: "block-7" }]),
      heightOf,
      REGISTRARS,
    ),
  ]);
  assert.equal(index.creations.get("x.p.example")?.txHash, "tx-3");
  assert.deepEqual([...(index.keysOf.get("x.p.example") ?? [])], ["ed25519:new"]);
  assert.deepEqual([...(index.createdBy.get("p.example") ?? [])], ["x.p.example"]);
});

test("the scan refuses a node that no longer keeps every block: a creation it never saw could hide a link", async () => {
  const pruned: Rpc = {
    url: "made-up",
    async call<T>(method: string): Promise<T> {
      if (method === "status") return { sync_info: { earliest_block_height: 100 } } as T;
      if (method === "EXPERIMENTAL_genesis_config") return { genesis_height: 0 } as T;
      throw new Error(`the scan should stop before calling ${method}`);
    },
  };
  await assert.rejects(scanChain(pruned, { registrars: [] }), /keeps blocks only from height 100/);
});
