/**
 * The screen's rule, on small worlds held in memory: each signal on its own, the service rules,
 * materiality, the same-parent label, groups across signals, and the verdict and report it hands
 * the contract. The sandbox test (ts/sandbox/screener.test.ts) runs the same screen on a real chain.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { screenRound, type ScreenResult } from "../screener/screen.ts";
import {
  NEAR_ASSET,
  RULE,
  VERDICT_BOUNDS,
  type ChainReader,
  type Creation,
  type RoundToScreen,
  type ScreenConfig,
  type Transfer,
} from "../screener/types.ts";

const NEAR = 10n ** 24n;
const N = 20;

/** A chain held in memory. Counts are computed from what was added, as a real reader would. */
class MemoryChain {
  readonly creations = new Map<string, Creation>();
  readonly keys = new Map<string, readonly string[] | null>();
  readonly transfers: Transfer[] = [];
  private tx = 0;

  private nextTx(): string {
    this.tx += 1;
    return `tx${String(this.tx).padStart(4, "0")}`;
  }

  /** `account` comes to exist, created by `creator` with `initialKeys`, which it still holds. */
  create(account: string, creator: string, initialKeys: readonly string[] = [`ed25519:own-${account}`]): string {
    const txHash = this.nextTx();
    this.creations.set(account, { creator, how: "sub-account", txHash, blockHeight: this.tx, initialKeys });
    this.keys.set(account, [...initialKeys]);
    return txHash;
  }

  send(from: string, to: string, amount: bigint, asset: string = NEAR_ASSET): string {
    const txHash = this.nextTx();
    this.transfers.push({ from, to, asset, amount, txHash, blockHeight: this.tx });
    return txHash;
  }

  reader(): ChainReader {
    const holders = (key: string): number =>
      [...this.creations.keys(), ...this.keys.keys()].filter(
        (account, i, all) =>
          all.indexOf(account) === i &&
          ((this.keys.get(account) ?? []).includes(key) || (this.creations.get(account)?.initialKeys ?? []).includes(key)),
      ).length;
    return {
      source: "memory",
      headHeight: 1000,
      creation: async (account) => this.creations.get(account) ?? null,
      fullAccessKeys: async (account) => (this.keys.has(account) ? this.keys.get(account) ?? null : null),
      transfersFrom: async (account) => this.transfers.filter((t) => t.from === account),
      createdCount: async (account, cap) => Math.min([...this.creations.values()].filter((c) => c.creator === account).length, cap),
      keyHolderCount: async (key, cap) => Math.min(holders(key), cap),
      senderCount: async (account, cap, counts) =>
        Math.min(new Set(this.transfers.filter((t) => t.to === account && counts(t)).map((t) => t.from)).size, cap),
    };
  }
}

const REGISTRAR = "registrar.example";
const config = (overrides: Partial<ScreenConfig> = {}): ScreenConfig => ({
  serviceThreshold: N,
  minTransfer: { [NEAR_ASSET]: NEAR / 100n, "usdc.example": 10_000n },
  services: [{ id: REGISTRAR, why: "the registrar" }],
  ...overrides,
});
const round = (recipients: readonly string[]): RoundToScreen => ({
  roundId: "a".repeat(64),
  daoId: "dao.example",
  tokenId: "usdc.example",
  headcountId: "headcount.example",
  recipients,
});

/** Named recipients created by the registrar, each with its own key, so nothing links them yet. */
const chainWith = (...accounts: string[]): MemoryChain => {
  const chain = new MemoryChain();
  for (const a of accounts) chain.create(a, REGISTRAR);
  return chain;
};

const groupsOf = (result: ScreenResult): { accounts: readonly string[]; signals: readonly string[] }[] =>
  result.verdict.groups.map((g) => ({ accounts: g.accounts, signals: g.signals }));

test("each linking signal holds a pair on its own, and a recipient linked to no one is cleared", async () => {
  const chain = chainWith("k1.example", "k2.example", "t1.example", "t2.example", "c1.example", "c2.example", "z.example");
  const f1 = chain.create("f1.example", "funder.example");
  const f2 = chain.create("f2.example", "funder.example");
  chain.keys.set("k1.example", ["ed25519:K"]);
  chain.keys.set("k2.example", ["ed25519:own-k2", "ed25519:K"]);
  const direct = chain.send("t1.example", "t2.example", NEAR);
  const toCollector1 = chain.send("c1.example", "collector.example", 2n * NEAR);
  const toCollector2 = chain.send("c2.example", "collector.example", 3n * NEAR);

  const result = await screenRound(
    round(["z.example", "t2.example", "f1.example", "k1.example", "c2.example", "t1.example", "k2.example", "f2.example", "c1.example"]),
    chain.reader(),
    config(),
  );

  assert.deepEqual(groupsOf(result), [
    { accounts: ["c1.example", "c2.example"], signals: ["shared-collector"] },
    { accounts: ["f1.example", "f2.example"], signals: ["same-funder"] },
    { accounts: ["k1.example", "k2.example"], signals: ["shared-key"] },
    { accounts: ["t1.example", "t2.example"], signals: ["direct-transfer"] },
  ]);
  assert.deepEqual(result.verdict.groups.map((g) => g.evidence), [
    [toCollector1, toCollector2],
    [f1, f2],
    ["key:ed25519:K"],
    [direct],
  ]);
  assert.deepEqual(result.screen.cleared, ["z.example"]);
  assert.equal(result.verdict.rule, RULE);
  assert.equal(result.verdict.screened_at_block, 1000);
});

test("a shared key counts when an account was created with it, even after it swapped the key out", async () => {
  const chain = chainWith("k1.example", "k2.example");
  chain.keys.set("k1.example", ["ed25519:K"]);
  const swapped = chain.create("k3.example", REGISTRAR, ["ed25519:K"]);
  chain.keys.set("k3.example", ["ed25519:fresh"]);

  const result = await screenRound(round(["k1.example", "k2.example", "k3.example"]), chain.reader(), config());

  assert.deepEqual(groupsOf(result), [{ accounts: ["k1.example", "k3.example"], signals: ["shared-key"] }]);
  assert.deepEqual(result.verdict.groups[0]?.evidence, ["key:ed25519:K", swapped], "cites k3's creation, where the key shows");
  assert.match(result.screen.groups[0]?.links[0]?.detail ?? "", /k3\.example .*created with it/);
});

test("nothing links through a service: a busy creator, a key on many accounts, a busy collector, a listed account", async () => {
  const chain = chainWith("c1.example", "c2.example", "d1.example", "d2.example", "e1.example", "e2.example");
  // A sponsor that created N + 1 accounts, two of them on the list.
  chain.create("s1.example", "sponsor.example");
  chain.create("s2.example", "sponsor.example");
  for (let i = 0; i < N - 1; i += 1) chain.create(`other${i}.example`, "sponsor.example");
  // A recovery key on N + 1 accounts, two of them on the list.
  chain.create("w1.example", REGISTRAR, ["ed25519:recovery"]);
  chain.create("w2.example", REGISTRAR, ["ed25519:recovery"]);
  for (let i = 0; i < N - 1; i += 1) chain.keys.set(`other${i}.example`, ["ed25519:recovery"]);
  // An exchange N + 1 accounts deposited at, two of them on the list.
  chain.send("c1.example", "exchange.example", NEAR);
  chain.send("c2.example", "exchange.example", NEAR);
  for (let i = 0; i < N - 1; i += 1) chain.send(`other${i}.example`, "exchange.example", NEAR);
  // The round's own DAO, and its token contract, as collectors; and the registrar as a creator.
  chain.send("d1.example", "dao.example", NEAR);
  chain.send("d2.example", "dao.example", NEAR);
  chain.send("e1.example", "usdc.example", NEAR);
  chain.send("e2.example", "usdc.example", NEAR);

  const recipients = ["s1.example", "s2.example", "w1.example", "w2.example", "c1.example", "c2.example", "d1.example", "d2.example", "e1.example", "e2.example"];
  const result = await screenRound(round(recipients), chain.reader(), config());

  assert.deepEqual(result.verdict.groups, [], "no group");
  assert.deepEqual(result.screen.cleared, [...recipients].sort());
  const why = (signal: string, via: string): string | undefined =>
    result.screen.notLinked.find((n) => n.signal === signal && n.via === via)?.why;
  assert.equal(why("same-funder", "sponsor.example"), `created more than ${N} accounts`);
  assert.equal(why("shared-key", "ed25519:recovery"), `held by more than ${N} accounts`);
  assert.equal(why("shared-collector", "exchange.example"), `received funds from more than ${N} accounts`);
  assert.equal(why("shared-collector", "dao.example"), "this round's DAO");
  assert.equal(why("shared-collector", "usdc.example"), "this round's token");
  assert.equal(why("same-funder", REGISTRAR), "the registrar");
});

test("a hub at exactly the threshold still links: only more than N accounts makes a service", async () => {
  const chain = new MemoryChain();
  chain.create("a1.example", "hub.example");
  chain.create("a2.example", "hub.example");
  for (let i = 0; i < N - 2; i += 1) chain.create(`other${i}.example`, "hub.example");

  const result = await screenRound(round(["a1.example", "a2.example"]), chain.reader(), config());

  assert.deepEqual(groupsOf(result), [{ accounts: ["a1.example", "a2.example"], signals: ["same-funder"] }]);
});

test("the exclusions file is a service list: an account the DAO lists links no one", async () => {
  const chain = new MemoryChain();
  chain.create("a1.example", "onboarding.example");
  chain.create("a2.example", "onboarding.example");
  const excluded = config({
    services: [...config().services, { id: "onboarding.example", why: "exclusions file: the DAO's own onboarding account" }],
  });

  const result = await screenRound(round(["a1.example", "a2.example"]), chain.reader(), excluded);

  assert.deepEqual(result.verdict.groups, []);
  assert.equal(result.screen.notLinked[0]?.why, "exclusions file: the DAO's own onboarding account");
});

test("transfers below the material amount link no one; a token's own minimum applies", async () => {
  const chain = chainWith("a.example", "b.example", "c.example", "d.example", "e.example", "f.example");
  chain.send("a.example", "b.example", NEAR / 1000n); // 0.001 NEAR: a tip, not material
  chain.send("c.example", "collector.example", 9_999n, "usdc.example"); // under 0.01 of a 6-decimal token
  chain.send("d.example", "collector.example", 9_999n, "usdc.example");
  chain.send("e.example", "f.example", 1n, "other-token.example"); // a token with no minimum set counts at any amount

  const result = await screenRound(round(["a.example", "b.example", "c.example", "d.example", "e.example", "f.example"]), chain.reader(), config());

  assert.deepEqual(groupsOf(result), [{ accounts: ["e.example", "f.example"], signals: ["direct-transfer"] }]);
  assert.deepEqual(
    result.screen.notLinked.filter((n) => n.signal === "direct-transfer" || n.signal === "shared-collector"),
    [],
    "a transfer that is not material is not a shape at all",
  );
});

test("the same parent only labels: it never links on its own, and joins a group's signals only beside another", async () => {
  const chain = new MemoryChain();
  // x.p and y.p: their creation is unknown to the reader, so only their names connect them.
  chain.keys.set("x.p.example", ["ed25519:x"]);
  chain.keys.set("y.p.example", ["ed25519:y"]);
  // u.q and v.q: created by q itself, which links them; the shared parent adds the label.
  chain.create("u.q.example", "q.example");
  chain.create("v.q.example", "q.example");
  // m.wallet and n.wallet: a parent that created more than N accounts is public, so no label either.
  chain.create("m.wallet.example", "wallet.example");
  chain.create("n.wallet.example", "wallet.example");
  for (let i = 0; i < N - 1; i += 1) chain.create(`user${i}.wallet.example`, "wallet.example");

  const result = await screenRound(
    round(["x.p.example", "y.p.example", "u.q.example", "v.q.example", "m.wallet.example", "n.wallet.example"]),
    chain.reader(),
    config(),
  );

  assert.deepEqual(groupsOf(result), [{ accounts: ["u.q.example", "v.q.example"], signals: ["same-funder", "same-parent"] }]);
  assert.deepEqual(
    result.screen.labels.map((l) => ({ via: l.via, accounts: l.accounts })),
    [
      { via: "q.example", accounts: ["u.q.example", "v.q.example"] },
      { via: "p.example", accounts: ["x.p.example", "y.p.example"] },
    ],
    "ordered by first account, like groups and links",
  );
  assert.ok(result.screen.cleared.includes("x.p.example") && result.screen.cleared.includes("y.p.example"));
});

test("groups are connected across signals, and a recipient that created another joins its group", async () => {
  const chain = chainWith("a.example", "b.example", "c.example", "d.example");
  chain.keys.set("a.example", ["ed25519:AB"]);
  chain.keys.set("b.example", ["ed25519:AB"]);
  chain.send("b.example", "c.example", NEAR);
  chain.create("e.example", "d.example");
  chain.create("f.example", "d.example");

  const result = await screenRound(round(["a.example", "b.example", "c.example", "d.example", "e.example", "f.example"]), chain.reader(), config());

  assert.deepEqual(groupsOf(result), [
    { accounts: ["a.example", "b.example", "c.example"], signals: ["shared-key", "direct-transfer"] },
    { accounts: ["d.example", "e.example", "f.example"], signals: ["same-funder"] },
  ]);
});

test("the verdict fits what post_verdict accepts; the report keeps the evidence the verdict has no room for", async () => {
  const chain = new MemoryChain();
  const accounts = Array.from({ length: 40 }, (_, i) => `n${String(i).padStart(2, "0")}.example`);
  for (const a of accounts) chain.create(a, REGISTRAR);
  for (let i = 0; i + 1 < accounts.length; i += 1) chain.send(accounts[i]!, accounts[i + 1]!, NEAR);

  const result = await screenRound(round(accounts), chain.reader(), config());

  assert.equal(result.verdict.groups.length, 1);
  const [group] = result.verdict.groups as [{ accounts: string[]; signals: string[]; evidence: string[] }];
  assert.equal(group.accounts.length, 40);
  assert.equal(group.evidence.length, VERDICT_BOUNDS.maxEvidence);
  assert.equal(result.screen.groups[0]?.evidence.length, 39, "the report has every transfer");
  for (const g of result.verdict.groups) {
    assert.ok(g.accounts.length >= 2);
    assert.ok(g.signals.length >= 1 && g.signals.length <= VERDICT_BOUNDS.maxSignals);
    assert.ok(g.signals.every((s) => s.length <= VERDICT_BOUNDS.maxSignalLen));
    assert.ok(g.evidence.every((e) => e.length <= VERDICT_BOUNDS.maxEvidenceLen));
  }
  assert.match(result.verdict.report_sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.verdict.report_url, null);
});

test("the report is the same bytes for the same chain, and the verdict carries its SHA-256", async () => {
  const chain = chainWith("a.example", "b.example", "c.example");
  chain.send("a.example", "b.example", NEAR);
  const once = await screenRound(round(["a.example", "b.example", "c.example"]), chain.reader(), config());
  const again = await screenRound(round(["c.example", "b.example", "a.example"]), chain.reader(), config());

  assert.equal(once.reportJson, again.reportJson);
  assert.equal(once.verdict.report_sha256, createHash("sha256").update(once.reportJson, "utf8").digest("hex"));
  assert.ok(once.reportMd.includes(once.verdict.report_sha256), "report.md names the hash");
  const parsed = JSON.parse(once.reportJson) as { rule: string; round: { round_id: string }; groups: unknown[]; cleared: string[] };
  assert.equal(parsed.rule, RULE);
  assert.equal(parsed.round.round_id, "a".repeat(64));
  assert.equal(parsed.groups.length, 1);
  assert.deepEqual(parsed.cleared, ["c.example"]);
});

test("the report describes accounts, never people: no 'same person', 'fraud' or 'sybil'", async () => {
  const chain = chainWith("a.example", "b.example", "c.example", "d.example");
  chain.create("e.example", "funder.example");
  chain.create("f.example", "funder.example");
  chain.keys.set("a.example", ["ed25519:K"]);
  chain.keys.set("b.example", ["ed25519:K"]);
  chain.send("c.example", "d.example", NEAR);

  const result = await screenRound(round(["a.example", "b.example", "c.example", "d.example", "e.example", "f.example"]), chain.reader(), config());

  for (const text of [result.reportJson, result.reportMd]) {
    for (const word of ["same person", "fraud", "sybil"]) assert.ok(!text.toLowerCase().includes(word), `"${word}" in the report`);
  }
  for (const phrase of ["created by the same account", "share a full-access key", "sent funds to"]) {
    assert.ok(result.reportMd.includes(phrase), `report.md says "${phrase}"`);
  }
  assert.match(result.reportMd, /accounts, not people/);
});

test("a recipient that does not exist is reported as such and linked to no one", async () => {
  const chain = chainWith("a.example");
  const result = await screenRound(round(["a.example", "ghost.example"]), chain.reader(), config());

  assert.deepEqual(result.verdict.groups, []);
  const ghost = result.screen.recipients.find((r) => r.account === "ghost.example");
  assert.equal(ghost?.exists, false);
  assert.match(result.reportMd, /ghost\.example.*does not exist/);
});
