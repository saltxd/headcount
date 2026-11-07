/**
 * The FastNEAR adapter against a pretend FastNEAR (ts/test/fastnear-world.ts) and against a
 * response recorded from the real thing (fixtures/fastnear/): what it reads, how few requests it
 * spends, and where it says it stopped early. No network, no waiting.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fastnearReader, toTxStatus, type FastNearTx } from "../screener/fastnear.ts";
import { createPacedFetch } from "../screener/paced-fetch.ts";
import { factsFromTx } from "../screener/block-scan.ts";
import { NEAR_ASSET } from "../screener/types.ts";
import { FACTORY, FACTORY_KEY, createTx, makeWorld, subAccountTx, tokenTx, transferTx } from "./fastnear-world.ts";

const NEAR = 10n ** 24n;
const noWait = async (): Promise<void> => undefined;

const reader = (world: ReturnType<typeof makeWorld>, extra: { maxRows?: number } = {}) =>
  fastnearReader({ fetch: createPacedFetch({ base: world.fetch, sleep: noWait, now: () => 0 }), sleep: noWait, registrars: ["near"], ...extra });

test("a recorded creation transaction reads the way the block scan reads it", () => {
  const recorded = JSON.parse(readFileSync("fixtures/fastnear/devdao-creation-tx.json", "utf8")) as { transactions: FastNearTx[] };
  const { status, heights } = toTxStatus(recorded.transactions[0] as FastNearTx);
  const creates = factsFromTx(status, (h) => heights.get(h), new Set(["near"])).flatMap((f) => (f.kind === "create" ? [f] : []));
  assert.equal(creates.length, 1);
  assert.equal(creates[0]?.account, "devdao.sputnik-dao.near");
  assert.equal(creates[0]?.creation.creator, "sputnik-dao.near");
  assert.equal(creates[0]?.creation.how, "sub-account");
  assert.equal(creates[0]?.creation.txHash, "7Zb4J1xXzHTUuHXMGre2NRKUr9Nw5Yqk9SMbBKsoteTm");
  assert.ok((creates[0]?.creation.blockHeight ?? 0) > 0);
});

test("creation: the account's first transaction as receiver names its creator and keys", async () => {
  const world = makeWorld({
    txs: [createTx("c1", 10, "alice-owner.test", "a.factory.test", ["ed25519:KeyA"]), transferTx("t1", 20, "bob.test", "a.factory.test", NEAR)],
    keys: { "a.factory.test": ["ed25519:KeyA"] },
  });
  const r = await reader(world);
  const creation = await r.creation("a.factory.test");
  assert.equal(creation?.creator, FACTORY);
  assert.equal(creation?.how, "sub-account");
  assert.deepEqual(creation?.initialKeys, ["ed25519:KeyA"]);
  assert.equal(creation?.blockHeight, 10);
  assert.equal(await r.creation("nobody.test"), null);
});

test("creation: an implicit account is created by whoever sent its first transfer", async () => {
  const implicit = "ab".repeat(32);
  const world = makeWorld({ txs: [transferTx("t1", 7, "funder.test", implicit, NEAR), transferTx("t2", 9, "other.test", implicit, NEAR)], keys: { [implicit]: [] } });
  const creation = await (await reader(world)).creation(implicit);
  assert.equal(creation?.creator, "funder.test");
  assert.equal(creation?.how, "first-transfer");
  assert.equal(creation?.initialKeys.length, 1);
});

test("fullAccessKeys: the keys it holds now; null for an account that is not there", async () => {
  const world = makeWorld({ txs: [], keys: { "a.test": ["ed25519:B", "ed25519:A"], "empty.test": [] } });
  const r = await reader(world);
  assert.deepEqual(await r.fullAccessKeys("a.test"), ["ed25519:A", "ed25519:B"]);
  assert.deepEqual(await r.fullAccessKeys("empty.test"), []);
  assert.equal(await r.fullAccessKeys("gone.test"), null);
  assert.equal(r.headHeight, 5000);
});

test("transfersFrom: what the account itself sent, NEAR and tokens, oldest first", async () => {
  const world = makeWorld({
    txs: [
      transferTx("t2", 30, "a.test", "x.test", 2n * NEAR),
      transferTx("t1", 20, "a.test", "y.test", NEAR),
      tokenTx("k1", 25, "a.test", "usdc.test", "z.test", "5000"),
      transferTx("in", 40, "other.test", "a.test", NEAR), // received, not sent
    ],
    keys: {},
  });
  const sent = await (await reader(world)).transfersFrom("a.test");
  assert.deepEqual(
    sent.map((t) => [t.txHash, t.to, t.asset, t.amount]),
    [
      ["t1", "y.test", NEAR_ASSET, NEAR],
      ["k1", "z.test", "usdc.test", 5000n],
      ["t2", "x.test", NEAR_ASSET, 2n * NEAR],
    ],
  );
});

test("keyHolderCount: asks the key index once, and stops at the cap", async () => {
  const world = makeWorld({ txs: [], keys: { "d.test": [FACTORY_KEY] }, extraHolders: { [FACTORY_KEY]: 50 } });
  const r = await reader(world);
  assert.equal(await r.keyHolderCount(FACTORY_KEY, 21), 21);
  assert.equal(await r.keyHolderCount(FACTORY_KEY, 100), 51);
  assert.equal(world.seen.filter((s) => s.startsWith("api.fastnear.com")).length, 1);
  assert.equal(await r.keyHolderCount("ed25519:Unused", 21), 0);
});

test("createdCount: counts what an account created, and stops reading once it passes the cap", async () => {
  const txs = Array.from({ length: 300 }, (_, i) => createTx(`c${i}`, 100 + i, `maker${i}.test`, `n${i}.factory.test`));
  const world = makeWorld({ txs, keys: {} });
  const r = await reader(world);
  assert.equal(await r.createdCount(FACTORY, 21), 21);
  assert.equal(await r.createdCount(FACTORY, 21), 21, "the second ask is free");
  assert.equal(await r.createdCount("maker3.test", 21), 0, "the caller of a factory is not the creator");
  // 300 transactions sit on two pages; passing 21 settles it on the first page of 200, read in batches of 20
  const accountCalls = world.seen.filter((s) => s.includes("/v0/account")).length;
  const txCalls = world.seen.filter((s) => s.includes("/v0/transactions")).length;
  assert.equal(accountCalls, 2, "one page for the factory, one row for maker3");
  assert.equal(txCalls, 10 + 1);
  assert.deepEqual(r.caveats(), []);
});

test("createdCount: a little creator is counted exactly; an implicit recipient counts as created", async () => {
  const world = makeWorld({
    txs: [subAccountTx("c1", 10, "maker.test", "n1.maker.test"), transferTx("t1", 11, "maker.test", "cd".repeat(32), NEAR)],
    keys: {},
  });
  assert.equal(await (await reader(world)).createdCount("maker.test", 21), 2);
});

test("senderCount: distinct senders that count, including token transfers logged to the account", async () => {
  const world = makeWorld({
    txs: [
      transferTx("t1", 10, "a.test", "hub.test", NEAR),
      transferTx("t2", 11, "a.test", "hub.test", NEAR),
      transferTx("t3", 12, "b.test", "hub.test", NEAR),
      transferTx("dust", 13, "c.test", "hub.test", 1n),
      tokenTx("k1", 14, "d.test", "usdc.test", "hub.test", "9"),
    ],
    keys: {},
  });
  const r = await reader(world);
  assert.equal(await r.senderCount("hub.test", 21, (t) => t.amount >= NEAR / 100n || t.asset !== NEAR_ASSET), 3);
  assert.equal(await r.senderCount("hub.test", 2, () => true), 2, "stops at the cap");
});

test("when an account has more history than the budget, it says so and keeps the newest", async () => {
  const txs = Array.from({ length: 30 }, (_, i) => transferTx(`t${i}`, 100 + i, "busy.test", `r${i}.test`, NEAR));
  const world = makeWorld({ txs, keys: {} });
  const r = await reader(world, { maxRows: 10 });
  const sent = await r.transfersFrom("busy.test");
  assert.equal(sent.length, 10);
  assert.equal(sent[0]?.blockHeight, 120, "the newest ten, oldest of them first");
  assert.match(r.caveats().join("\n"), /busy\.test: only its newest 10 outgoing transactions were read/);
});

test("never asks /v0/transactions for more than 20 hashes at once", async () => {
  const txs = Array.from({ length: 45 }, (_, i) => transferTx(`t${i}`, 100 + i, "busy.test", `r${i}.test`, NEAR));
  const world = makeWorld({ txs, keys: {} });
  assert.equal((await (await reader(world)).transfersFrom("busy.test")).length, 45);
  const sizes = world.seen.filter((s) => s.includes("/v0/transactions")).map((s) => (JSON.parse(s.split(" ").slice(1).join(" ")) as { tx_hashes: string[] }).tx_hashes.length);
  assert.deepEqual(sizes, [20, 20, 5]);
});

test("a hub too big to read is treated as a service, and the caveat says why", async () => {
  // 120 incoming transfers from only 3 senders, but a budget of 50 rows: the newest 50 cannot show it is small
  const senders = ["s1.test", "s2.test", "s3.test"];
  const txs = Array.from({ length: 120 }, (_, i) => transferTx(`t${i}`, 100 + i, senders[i % 3] as string, "hub.test", NEAR));
  const world = makeWorld({ txs, keys: {} });
  const r = await reader(world, { maxRows: 50 });
  assert.equal(await r.senderCount("hub.test", 21, () => true), 21);
  assert.match(r.caveats().join("\n"), /hub\.test: more than 50 incoming transactions; treated as a service/);

  // the same shape inside the budget is counted exactly
  const small = await reader(world, { maxRows: 500 });
  assert.equal(await small.senderCount("hub.test", 21, () => true), 3);
  assert.deepEqual(small.caveats(), []);
});

test("an outgoing hub is treated the same way for createdCount", async () => {
  const txs = Array.from({ length: 120 }, (_, i) => transferTx(`t${i}`, 100 + i, "bot.test", "same.test", NEAR));
  const r = await reader(makeWorld({ txs, keys: {} }), { maxRows: 50 });
  assert.equal(await r.createdCount("bot.test", 21), 21);
  assert.match(r.caveats().join("\n"), /bot\.test: more than 50 outgoing transactions; treated as a service/);
  assert.match(r.tooBusy?.("bot.test") ?? "", /more than 50 outgoing transactions, too busy to read/);
  assert.equal(r.tooBusy?.("quiet.test"), null);
});
