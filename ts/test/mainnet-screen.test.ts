/**
 * Mainnet mode end to end on a pretend FastNEAR: a list of DAOs that one factory made, all with
 * the factory's key, links none of them (the factory and its key are services, found by measuring,
 * not by name); a pair that really shares a creator and a key is linked by the same code.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createPacedFetch } from "../screener/paced-fetch.ts";
import { MAINNET_SERVICES, screenMainnet, mainnetConfig } from "../screener/mainnet.ts";
import { FACTORY, FACTORY_KEY, createTx, makeWorld, subAccountTx, transferTx } from "./fastnear-world.ts";

const noWait = async (): Promise<void> => undefined;
const paced = (world: ReturnType<typeof makeWorld>) => createPacedFetch({ base: world.fetch, sleep: noWait, now: () => 0 });

const daos = Array.from({ length: 25 }, (_, i) => `dao${String(i).padStart(2, "0")}.factory.test`);
const daoWorld = () =>
  makeWorld({
    // each DAO made by a different caller through the factory, each born holding the factory's key
    txs: daos.map((d, i) => createTx(`c${i}`, 100 + i, `caller${i}.test`, d, [FACTORY_KEY])),
    keys: Object.fromEntries(daos.map((d) => [d, [FACTORY_KEY]])),
    extraHolders: { [FACTORY_KEY]: 2000 },
  });

test("a paced screen of public DAOs finishes and links none: the factory and its key are services", async () => {
  const world = daoWorld();
  const { result, caveats } = await screenMainnet({ roundId: "daos", daoId: "n-a.invalid", tokenId: "native", recipients: daos, fetch: paced(world), sleep: noWait });
  assert.equal(result.screen.groups.length, 0);
  assert.equal(result.screen.cleared.length, 25);
  assert.deepEqual(result.verdict.groups, []);
  const met = new Map(result.screen.services.map((s) => [s.id, s.why]));
  assert.match(met.get(FACTORY) ?? "", /created more than 20 accounts/);
  assert.match(met.get(FACTORY_KEY) ?? "", /held by more than 20 accounts/);
  const kinds = new Set(result.screen.notLinked.map((n) => n.signal));
  assert.ok(kinds.has("same-funder") && kinds.has("shared-key"), [...kinds].join(","));
  assert.equal(result.screen.labels.length, 0, "a shared parent that is a service does not even label");
  assert.deepEqual(caveats, []);
});

test("the same adapter does link a pair that shares a private creator and a private key", async () => {
  const txs = [
    subAccountTx("s1", 10, "boss.test", "left.boss.test"),
    subAccountTx("s2", 11, "boss.test", "right.boss.test"),
    createTx("c3", 12, "someone.test", "far.factory.test", ["ed25519:OwnKey"]),
  ];
  const world = makeWorld({
    txs,
    keys: { "left.boss.test": ["ed25519:Shared"], "right.boss.test": ["ed25519:Shared"], "far.factory.test": ["ed25519:OwnKey"] },
  });
  const recipients = ["left.boss.test", "right.boss.test", "far.factory.test"];
  const { result } = await screenMainnet({ roundId: "pair", daoId: "n-a.invalid", tokenId: "native", recipients, fetch: paced(world), sleep: noWait });
  assert.deepEqual(result.screen.groups.map((g) => g.accounts), [["left.boss.test", "right.boss.test"]]);
  assert.deepEqual(result.screen.cleared, ["far.factory.test"]);
});

test("the screen never exceeds 2 requests a second, even on a long list", async () => {
  const world = daoWorld();
  const starts: number[] = [];
  let clock = 0;
  const base: typeof world.fetch = async (url, init) => (starts.push(clock), world.fetch(url, init));
  const fetch = createPacedFetch({ base, sleep: async (ms) => void (clock += ms), now: () => clock });
  await screenMainnet({ roundId: "daos", daoId: "n-a.invalid", tokenId: "native", recipients: daos, fetch, sleep: noWait });
  assert.ok(starts.length > 100, `only ${starts.length} requests`);
  const gaps = starts.slice(1).map((t, i) => t - (starts[i] as number));
  assert.ok(Math.min(...gaps) >= 500, `smallest gap ${Math.min(...gaps)} ms`);
  assert.equal(fetch.requests, starts.length);
});

test("a transfer between two listed accounts is still caught on mainnet", async () => {
  const world = makeWorld({
    txs: [subAccountTx("s1", 10, "a-owner.test", "a.test"), subAccountTx("s2", 11, "b-owner.test", "b.test"), transferTx("t1", 20, "a.test", "b.test", 5n * 10n ** 24n)],
    keys: { "a.test": [], "b.test": [] },
  });
  const { result } = await screenMainnet({ roundId: "x", daoId: "n-a.invalid", tokenId: "native", recipients: ["a.test", "b.test"], fetch: paced(world), sleep: noWait });
  assert.deepEqual(result.screen.groups.map((g) => g.signals), [["direct-transfer"]]);
});

test("a collector too busy to read is a service, and the report says that, not a count it never made", async () => {
  // two recipients each send to a hub with 120 incoming transfers, over a budget of 50 rows
  const sends = Array.from({ length: 118 }, (_, i) => transferTx(`h${i}`, 100 + i, `x${i % 3}.test`, "hub.test", 5n * 10n ** 24n));
  const world = makeWorld({
    txs: [
      subAccountTx("s1", 10, "o1.test", "a.o1.test"),
      subAccountTx("s2", 11, "o2.test", "b.o2.test"),
      transferTx("ta", 20, "a.o1.test", "hub.test", 5n * 10n ** 24n),
      transferTx("tb", 21, "b.o2.test", "hub.test", 5n * 10n ** 24n),
      ...sends,
    ],
    keys: { "a.o1.test": [], "b.o2.test": [] },
  });
  const { result, caveats } = await screenMainnet({ roundId: "x", daoId: "n-a.invalid", tokenId: "native", recipients: ["a.o1.test", "b.o2.test"], fetch: paced(world), maxRows: 50, sleep: noWait });
  assert.equal(result.screen.groups.length, 0);
  assert.match(result.screen.services.find((s) => s.id === "hub.test")?.why ?? "", /too busy to read/);
  assert.doesNotMatch(result.reportMd, /hub\.test counts as a service here \(created more/);
  assert.match(caveats.join("\n"), /hub\.test: more than 50/);
});

test("the listed services are the ones the design names", () => {
  assert.deepEqual(MAINNET_SERVICES.map((s) => s.id).sort(), ["bulkpayment.near", "near", "sponsor.trezu.near", "sputnik-dao.near"]);
  assert.equal(mainnetConfig([{ id: "x.near", why: "an exclusion" }]).services.length, 5);
});
