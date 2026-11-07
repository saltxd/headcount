/**
 * How the block scan turns a transaction's receipts into facts, on hand-written transactions in
 * the shape `EXPERIMENTAL_tx_status` returns. Every account and key here is made up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import nearApi from "near-api-js";

import { buildIndex, factsFromTx, impliedKey, scanChain, type Fact, type RpcAction, type TxStatus } from "../screener/block-scan.ts";
import { jsonRpc, type Rpc, type Transport } from "../screener/rpc.ts";
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

// --- the scan over a pretend node: heights NEAR skipped, and a block the node lost -----------------

interface PretendBlock {
  readonly height: number;
  /** The height of the block before it, whose hash is `hash-<parent>`; none for genesis. */
  readonly parent?: number;
  /** Transactions in this block's one chunk. */
  readonly txs?: readonly TxStatus[];
}

/**
 * A node over `blocks`, the last of which is the final head, answering as neard 2.13.4 does: a
 * height with no block below the head is UNKNOWN_BLOCK with HTTP 422. Each method in `timeouts`
 * times out once (HTTP 408, TIMEOUT_ERROR), as a loaded node's calls do.
 */
const pretendNode = (blocks: readonly PretendBlock[], timeouts: readonly string[] = []): { transport: Transport; calls: string[] } => {
  const byHeight = new Map(blocks.map((b) => [b.height, b]));
  const head = blocks.at(-1)!;
  const txs = new Map(blocks.flatMap((b) => (b.txs ?? []).map((t) => [t.transaction.hash, t] as const)));
  const pending = new Set(timeouts);
  const calls: string[] = [];
  const view = (b: PretendBlock) => ({
    header: {
      height: b.height,
      hash: `hash-${b.height}`,
      prev_hash: b.parent === undefined ? "11111111111111111111111111111111" : `hash-${b.parent}`,
      prev_height: b.parent ?? 0,
    },
    chunks: [{ chunk_hash: `chunk-${b.height}`, height_included: b.height }],
  });
  const transport: Transport = async (_url, init) => {
    const { id, method, params } = JSON.parse(String(init.body)) as { id: number; method: string; params: Record<string, unknown> };
    calls.push(method);
    const ok = (result: unknown): Response => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });
    const failure = (status: number, cause: string, data: string): Response =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id, error: { name: "HANDLER_ERROR", cause: { info: {}, name: cause }, code: -32000, message: "Server error", data } }),
        { status },
      );
    if (pending.delete(method)) return failure(408, "TIMEOUT_ERROR", "Timeout");
    switch (method) {
      case "status":
        return ok({ sync_info: { earliest_block_height: 0 } });
      case "EXPERIMENTAL_genesis_config":
        return ok({ genesis_height: 0 });
      case "block": {
        const height = params["finality"] === "final" ? head.height : Number(params["block_id"]);
        const block = byHeight.get(height);
        return block ? ok(view(block)) : failure(422, "UNKNOWN_BLOCK", `DB Not Found Error: BLOCK HEIGHT: ${height} \n Cause: Unknown`);
      }
      case "chunk": {
        const block = byHeight.get(Number(String(params["chunk_id"]).replace("chunk-", "")));
        return ok({ transactions: (block?.txs ?? []).map((t) => ({ hash: t.transaction.hash, signer_id: t.transaction.signer_id })) });
      }
      case "EXPERIMENTAL_tx_status":
        return ok(txs.get(String(params["tx_hash"])));
      default:
        throw new Error(`the scan should not call ${method}`);
    }
  };
  return { transport, calls };
};

/** farm.example creates x.farm.example in the block at height 4. */
const CREATED_AT_4 = txStatus("tx-create", [
  { id: "r1", predecessor: "farm.example", receiver: "x.farm.example", actions: ["CreateAccount", pay(1000n), fullKey("ed25519:A")], block: "hash-4" },
]);
const noWait = async (): Promise<void> => undefined;

test("the scan passes over a height NEAR skipped, which the next block's link to the one before proves, and reads every block there is", async () => {
  // Height 3 has no block: block 4 names block 2 as the one before it. A busy sandbox skips heights.
  const { transport } = pretendNode([
    { height: 0 },
    { height: 1, parent: 0 },
    { height: 2, parent: 1 },
    { height: 4, parent: 2, txs: [CREATED_AT_4] },
    { height: 5, parent: 4 },
  ]);
  const reader = await scanChain(jsonRpc("http://node.test", transport), { registrars: [], sleep: noWait });
  assert.deepEqual(reader.stats, { fromHeight: 0, toHeight: 5, blocks: 5, skippedHeights: 1, chunks: 5, transactions: 1 });
  assert.deepEqual(await reader.creation("x.farm.example"), {
    creator: "farm.example",
    how: "sub-account",
    txHash: "tx-create",
    blockHeight: 4,
    initialKeys: ["ed25519:A"],
  });
});

test("the scan fails loudly when a block names one before it that the node did not return: a missing block, not a skipped height", async () => {
  // Block 4 says block 3 came before it, yet the node has no block at height 3.
  const { transport } = pretendNode([
    { height: 0 },
    { height: 1, parent: 0 },
    { height: 2, parent: 1 },
    { height: 4, parent: 3, txs: [CREATED_AT_4] },
    { height: 5, parent: 4 },
  ]);
  await assert.rejects(
    scanChain(jsonRpc("http://node.test", transport), { registrars: [], sleep: noWait }),
    /block 4 follows block hash-3 at height 3, which the node did not return: a missing block, not a skipped height/,
  );
});

test("the scan refuses a block that is not on the chain from genesis to the final head", async () => {
  // Blocks 3 and 4 both name block 2 as the one before them; only 4 leads to the head.
  const { transport } = pretendNode([
    { height: 0 },
    { height: 1, parent: 0 },
    { height: 2, parent: 1 },
    { height: 3, parent: 2 },
    { height: 4, parent: 2 },
    { height: 5, parent: 4 },
  ]);
  await assert.rejects(
    scanChain(jsonRpc("http://node.test", transport), { registrars: [], sleep: noWait }),
    /the blocks at heights 3 are not on the chain from genesis to the final head/,
  );
});

test("the scan asks again when the node times out on a transaction's status (HTTP 408), as a loaded node does", async () => {
  const { transport, calls } = pretendNode(
    [{ height: 0 }, { height: 1, parent: 0 }, { height: 4, parent: 1, txs: [CREATED_AT_4] }],
    ["EXPERIMENTAL_tx_status"],
  );
  const reader = await scanChain(jsonRpc("http://node.test", transport), { registrars: [], sleep: noWait });
  assert.equal(calls.filter((m) => m === "EXPERIMENTAL_tx_status").length, 2, "asked twice");
  assert.equal((await reader.creation("x.farm.example"))?.txHash, "tx-create");
});
