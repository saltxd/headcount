/**
 * Scenario 3: the screener reads the sandbox chain and posts its verdict.
 *
 *     npm test
 *
 * A world with a known answer is planted first (ts/sandbox/world.ts): four farms of linked
 * accounts among sixteen recipients, next to decoys that only look linked because they share a
 * wallet sponsor, a wallet's recovery key, an exchange or the DAO itself. The DAO, the real Sputnik
 * v3.2 with Trezu's roles, names its screener by vote; the Requestor turns the world's CSV into a
 * round. The screener then scans every block of the sandbox over RPC, screens the round's list,
 * writes its report and posts the verdict. The test holds the screen to the planted answer: exactly
 * the four farms, no decoy.
 *
 * Nothing here touches a network: the sandbox is a local neard with throwaway accounts.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import nearApi from "near-api-js";
import type { NearAccount, Worker } from "near-workspaces";

import { listId, parseTrezuCsv } from "../src/list-id.ts";
import { scanChain, type BlockScanReader } from "../screener/block-scan.ts";
import { writeScreenFiles } from "../screener/report.ts";
import { jsonRpc, type Rpc } from "../screener/rpc.ts";
import { DEFAULT_MIN_NEAR, DEFAULT_SERVICE_THRESHOLD, screenRound } from "../screener/screen.ts";
import { NEAR_ASSET, type ScreenConfig } from "../screener/types.ts";
import { callKind, quietSandboxLogs, tgas, trezuPolicy } from "./harness.ts";
import { startSandbox } from "./sandbox.ts";
import { createNamedAccounts, near, planWorld, seedWorld, type NamedSpec, type World } from "./world.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "out");
const SCREEN_DIR = join(OUT, "screen");
const WASM = {
  sputnik: join(OUT, "sputnikdao2.wasm"),
  token: join(OUT, "test_token.wasm"),
  headcount: join(OUT, "headcount.wasm"),
};

const DAY = 86_400;
/** The sandbox token stands in for a 6-decimal token such as USDC. */
const DECIMALS = 6;
/** Trezu's list timestamp for the round: 2026-11-08 00:00 UTC, in milliseconds. */
const ROUND_TIMESTAMP = 1_794_096_000_000;
/** The design's "N": more accounts than this behind one creator, key or collector means a service. */
const SERVICE_THRESHOLD = DEFAULT_SERVICE_THRESHOLD;

interface RoundView {
  readonly round_id: string;
  readonly dao_id: string;
  readonly token_id: string;
  readonly payments: readonly { readonly recipient: string; readonly amount: string; readonly state: string }[];
}

let worker: Worker | undefined;
let rpc: Rpc;
let root: NearAccount;
let dao: NearAccount;
let token: NearAccount;
let headcount: NearAccount;
let screener: NearAccount;
let world: World;
let roundId = "";
let reader: BlockScanReader | undefined;

const key = (): nearApi.KeyPair => nearApi.KeyPair.fromRandom("ed25519");

before(async () => {
  for (const wasm of Object.values(WASM)) {
    if (!existsSync(wasm)) throw new Error(`${wasm} is missing. Run npm test, whose pretest builds it.`);
  }
  quietSandboxLogs();
  worker = await startSandbox();
  root = worker.rootAccount;
  rpc = jsonRpc((worker.provider as unknown as { connection: { url: string } }).connection.url);
  const id = (name: string): string => `${name}.${root.accountId}`;

  const approverNames = ["approver1", "approver2", "approver3", "approver4"];
  const person = (name: string): NamedSpec => ({ name, balance: near("5"), keyPair: key() });
  const infra: NamedSpec[] = [
    {
      name: "dao",
      balance: near("50"),
      keyPair: key(),
      contract: {
        wasm: readFileSync(WASM.sputnik),
        init: "new",
        args: {
          config: { name: "community", purpose: "pays contributors for campaigns", metadata: "" },
          policy: trezuPolicy({
            requestors: [id("treasurer")],
            admins: [id("admin")],
            approvers: approverNames.map(id),
            paymentThreshold: 2,
            governanceThreshold: 1,
          }),
        },
      },
    },
    { name: "token", balance: near("10"), keyPair: key(), contract: { wasm: readFileSync(WASM.token), init: "new", args: {} } },
    { name: "headcount", balance: near("10"), keyPair: key(), contract: { wasm: readFileSync(WASM.headcount), init: "new", args: {} } },
    person("treasurer"),
    person("admin"),
    ...approverNames.map(person),
    person("screener"),
  ];
  const plan = planWorld();
  const accounts = await createNamedAccounts(rpc, root, [...infra, ...plan.named]);
  const must = (name: string): NearAccount => {
    const account = accounts[name];
    if (!account) throw new Error(`${name} was not created`);
    return account;
  };
  dao = must("dao");
  token = must("token");
  headcount = must("headcount");
  screener = must("screener");
  const treasurer = must("treasurer");
  const [first, second] = approverNames.map(must) as [NearAccount, NearAccount];

  // The DAO names its screener by vote while the world plays out its history.
  const configureByVote = async (): Promise<number> => {
    const kind = callKind(
      headcount.accountId,
      "configure",
      { dao_id: dao.accountId, screener_id: screener.accountId, verdict_window_sec: 2 * DAY, hold_window_sec: 2 * DAY },
      near("0.01"),
      30,
    );
    const proposal = await treasurer.call<number>(dao, "add_proposal", {
      proposal: { description: "Name the screener for our Headcount rounds", kind },
    });
    for (const voter of [first, second]) {
      await voter.call(dao, "act_proposal", { id: proposal, action: "VoteApprove", proposal: kind }, { gas: tgas(250) });
    }
    return proposal;
  };
  const [proposal, seeded] = await Promise.all([
    configureByVote(),
    seedWorld(rpc, plan, { root, daoId: dao.accountId, tokenId: token.accountId }),
  ]);
  world = seeded;
  assert.equal((await dao.view<{ status: string }>("get_proposal", { id: proposal })).status, "Approved");

  const payments = parseTrezuCsv(world.csv, DECIMALS);
  roundId = await treasurer.call<string>(
    headcount,
    "create_round",
    { dao_id: dao.accountId, token_id: token.accountId, payments, timestamp: ROUND_TIMESTAMP },
    { attachedDeposit: near("0.1"), gas: tgas(100) },
  );
  assert.equal(roundId, listId({ submitter: dao.accountId, tokenId: token.accountId, payments, timestamp: ROUND_TIMESTAMP }));

  const sizes = world.farms.map((f) => `${f.name} (${f.accounts.length})`).join(", ");
  console.log(
    `  WORLD planted: farms ${sizes}; ${world.sponsor} funded ${world.sponsorFunded} accounts; ` +
      `${dao.accountId} named ${screener.accountId} by vote (proposal ${proposal}, Approved); ` +
      `round ${roundId.slice(0, 12)}... has ${payments.length} recipients`,
  );
});

after(async () => {
  await worker?.tearDown();
});

test("the screener reads the sandbox by scanning every block, and sees each key change the chain made", async () => {
  const started = Date.now();
  reader = await scanChain(rpc, { registrars: [root.accountId] });
  const elapsed = Date.now() - started;
  const { stats } = reader;
  assert.equal(stats.fromHeight, 0, "from genesis: a creation the scan missed would hide a link");
  assert.ok(stats.toHeight > 0 && stats.transactions >= 140, `read ${stats.transactions} transactions`);

  // The scan builds its own record of keys from AddKey and DeleteKey, including transactions an
  // account signs to itself, which NEAR's tx status lists without their receipt. It must match the
  // chain's own view of every recipient's keys, omar's swapped key included.
  for (const account of world.recipients) {
    const chain = await reader.fullAccessKeys(account);
    assert.deepEqual([...reader.heldKeys(account)].sort(), [...(chain ?? [])].sort(), `keys of ${account}`);
  }
  console.log(
    `  SCAN read blocks ${stats.fromHeight} to ${stats.toHeight}: ${stats.chunks} chunks, ${stats.transactions} transactions, ` +
      `in ${elapsed} ms; its record of every recipient's keys matches view_access_key_list`,
  );
});

test("scenario 3: the screener posts its verdict: it holds farms A, B, C and D and links none of the decoys", async () => {
  assert.ok(reader, "the scan ran");
  const round = await headcount.view<RoundView>("get_round", { round_id: roundId });
  const config: ScreenConfig = {
    serviceThreshold: SERVICE_THRESHOLD,
    // 0.01 NEAR, and 0.01 of the 6-decimal token: below either, a transfer is a tip, not a link.
    minTransfer: { [NEAR_ASSET]: DEFAULT_MIN_NEAR, [token.accountId]: 10n ** BigInt(DECIMALS - 2) },
    services: [
      { id: root.accountId, why: "the sandbox's registrar: it creates every account under it, as near does on mainnet" },
    ],
  };
  const result = await screenRound(
    {
      roundId,
      daoId: round.dao_id,
      tokenId: round.token_id,
      headcountId: headcount.accountId,
      recipients: round.payments.map((p) => p.recipient),
    },
    reader,
    config,
  );

  // Exactly the planted farms, each by the signal it was planted with, citing what was planted.
  assert.deepEqual(
    result.verdict.groups.map((g) => ({ accounts: g.accounts, signals: g.signals })),
    world.farms.map((f) => ({ accounts: f.accounts, signals: [f.signal] })),
    "the held groups are exactly the planted farms",
  );
  for (const [i, farm] of world.farms.entries()) {
    const evidence = result.verdict.groups[i]?.evidence ?? [];
    for (const item of farm.evidence) assert.ok(evidence.includes(item), `farm ${farm.name} cites ${item}`);
  }
  assert.deepEqual(result.screen.cleared, world.cleared, "every decoy is cleared");

  // Each decoy shape was seen, and each ran through a service.
  const notLinked = (signal: string, via: string) => result.screen.notLinked.find((n) => n.signal === signal && n.via === via);
  const sponsor = notLinked("same-funder", world.sponsor);
  const recoveryKey = notLinked("shared-key", world.recoveryKey);
  const exchange = notLinked("shared-collector", world.exchange);
  const daoItself = notLinked("shared-collector", dao.accountId);
  assert.match(sponsor?.why ?? "", new RegExp(`created more than ${SERVICE_THRESHOLD} accounts`));
  assert.match(recoveryKey?.why ?? "", new RegExp(`held by more than ${SERVICE_THRESHOLD} accounts`));
  assert.match(exchange?.why ?? "", new RegExp(`received funds from more than ${SERVICE_THRESHOLD} accounts`));
  assert.match(daoItself?.why ?? "", /this round's DAO/);
  const [uma, vik] = ["uma", "vik"].map((n) => `${n}.${root.accountId}`) as [string, string];
  assert.ok(
    ![...result.screen.groups.flatMap((g) => g.links), ...result.screen.notLinked].some(
      (l) => l.signal === "direct-transfer" && l.accounts.includes(uma) && l.accounts.includes(vik),
    ),
    "uma's 0.001 NEAR tip to vik is below the material amount",
  );

  // The files, and the hash that ties the verdict to the report.
  const written = writeScreenFiles(SCREEN_DIR, result);
  const reportBytes = readFileSync(written.reportJson);
  assert.equal(result.verdict.report_sha256, createHash("sha256").update(reportBytes).digest("hex"));
  assert.deepEqual(JSON.parse(readFileSync(written.verdictJson, "utf8")), result.verdict);
  assert.equal(result.verdict.screened_at_block, reader.headHeight);

  // The screener posts the verdict; the contract holds exactly the farms.
  await screener.call(
    headcount,
    "post_verdict",
    { round_id: roundId, verdict: result.verdict },
    { attachedDeposit: near("0.5"), gas: tgas(100) },
  );
  const posted = await headcount.view<RoundView>("get_round", { round_id: roundId });
  const held = posted.payments.filter((p) => p.state === "Held").map((p) => p.recipient);
  assert.deepEqual(held, world.farms.flatMap((f) => f.accounts).sort());
  assert.deepEqual(
    posted.payments.filter((p) => p.state === "Pending").map((p) => p.recipient),
    world.cleared,
  );

  for (const [i, group] of result.verdict.groups.entries()) {
    console.log(`  HELD group ${i + 1} (farm ${world.farms[i]?.name}): ${group.accounts.length} accounts, ${group.signals.join(", ")}`);
  }
  console.log(
    `  NOT LINKED: ${[sponsor, recoveryKey, exchange, daoItself].map((n) => `${n?.signal} through ${n?.via?.slice(0, 24)} (${n?.why})`).join("; ")}`,
  );
  console.log(
    `  VERDICT posted by ${screener.accountId}: ${result.verdict.groups.length} groups, ${held.length} of ${posted.payments.length} held, ` +
      `${world.cleared.length} cleared; report ${relative(ROOT, written.reportJson)} (sha256 ${result.verdict.report_sha256.slice(0, 12)}...)`,
  );
});
