/**
 * A round paid in NEAR, start to finish, against the real Sputnik DAO v3.2 with Trezu's roles.
 *
 *     npm test
 *
 * Eleven recipients, chosen to cover every way a NEAR payment can go:
 *   ana, ben          named accounts that exist                           paid
 *   six implicit      64-hex accounts that do not exist yet: the payment  paid, and created by it
 *                     creates each one, which NEAR charges as an account
 *                     creation (about 8.4 TGas)
 *   ghost             a named account that does not exist                 the transfer fails; back to the DAO
 *   kim, lee          held as a linked pair                               the council pays kim, returns lee's share
 *
 * A NEAR round is the one round no Trezu template can fund (a template fixes its deposit, and a NEAR
 * round's deposit is its total), so the DAO funds it with a FunctionCall proposal of its own.
 *
 * Nothing here touches a network: the sandbox is a local neard with throwaway accounts.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import nearApi from "near-api-js";
import type { NearAccount, Worker } from "near-workspaces";

import { jsonRpc } from "../screener/rpc.ts";
import { callKind, quietSandboxLogs, tgas, trezuPolicy, type FunctionCallKind, type ProposalView } from "./harness.ts";
import { startSandbox } from "./sandbox.ts";
import { createNamedAccounts, near, type NamedSpec } from "./world.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "out");
const WASM = { sputnik: join(OUT, "sputnikdao2.wasm"), headcount: join(OUT, "headcount.wasm") };

const VOTE_GAS = tgas(250);
/** Bound on what gas rewards add to an account whose code ran: far below any amount here. */
const GAS_SLACK = near("0.01");
/** The DAO's windows: the shortest Headcount allows, so a deadline can be passed in seconds. */
const WINDOW_SEC = 60;

interface RoundView {
  readonly total: string;
  readonly payments: readonly { readonly recipient: string; readonly amount: string; readonly state: string }[];
  readonly funded_at_sec: number | null;
  readonly groups: readonly { readonly state: string; readonly released: string | null }[];
  readonly paid: string;
  readonly refunded: string;
}

/** `get_account_record`: an account's record with one DAO, counted from that DAO's rounds. */
interface AccountRecordView {
  readonly rounds_listed: number;
  readonly rounds_held: number;
  readonly rounds_paid: number;
  readonly rounds_returned: number;
  readonly rounds_read: number;
  readonly rounds_total: number;
}

let worker: Worker | undefined;
let dao: NearAccount;
let headcount: NearAccount;
let treasurer: NearAccount;
let approvers: [NearAccount, NearAccount];
let screener: NearAccount;
let alice: NearAccount;
let roundId = "";
/** Six implicit accounts nobody has created: the payout creates them. */
const implicit = Array.from({ length: 6 }, () =>
  Buffer.from(nearApi.KeyPair.fromRandom("ed25519").getPublicKey().data).toString("hex"),
);
const ID = (name: string): string => `${name}.test.near`;
const AMOUNTS: Readonly<Record<string, bigint>> = {
  [ID("ana")]: near("0.5"),
  [ID("ben")]: near("0.25"),
  ...Object.fromEntries(implicit.map((id, i) => [id, near(String((i + 1) / 10))])),
  [ID("ghost")]: near("0.4"),
  [ID("kim")]: near("0.6"),
  [ID("lee")]: near("0.7"),
};
const TOTAL = Object.values(AMOUNTS).reduce((a, b) => a + b, 0n);
/** Headcount's NEAR beyond what its storage locks, before the round exists. */
let headcountFreeAtStart = 0n;

const key = (): nearApi.KeyPair => nearApi.KeyPair.fromRandom("ed25519");
/** yoctoNEAR as exact NEAR text, e.g. 3.05. */
const nearText = (yocto: bigint): string => nearApi.utils.format.formatNearAmount(String(yocto));

before(async () => {
  for (const wasm of Object.values(WASM)) {
    if (!existsSync(wasm)) throw new Error(`${wasm} is missing. Run npm test, whose pretest builds it.`);
  }
  quietSandboxLogs();
  worker = await startSandbox();
  const root = worker.rootAccount;
  const rpc = jsonRpc((worker.provider as unknown as { connection: { url: string } }).connection.url);
  const person = (name: string): NamedSpec => ({ name, balance: near("5"), keyPair: key() });
  const accounts = await createNamedAccounts(rpc, root, [
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
            requestors: [ID("treasurer")],
            admins: [ID("admin")],
            approvers: ["approver1", "approver2", "approver3", "approver4"].map(ID),
            paymentThreshold: 2,
            governanceThreshold: 1,
          }),
        },
      },
    },
    { name: "headcount", balance: near("10"), keyPair: key(), contract: { wasm: readFileSync(WASM.headcount), init: "new", args: {} } },
    ...["treasurer", "admin", "approver1", "approver2", "approver3", "approver4", "screener", "alice", "ana", "ben", "kim", "lee"].map(person),
  ]);
  const must = (name: string): NearAccount => {
    const account = accounts[name];
    if (!account) throw new Error(`${name} was not created`);
    return account;
  };
  [dao, headcount, treasurer, screener, alice] = ["dao", "headcount", "treasurer", "screener", "alice"].map(must) as [
    NearAccount,
    NearAccount,
    NearAccount,
    NearAccount,
    NearAccount,
  ];
  approvers = [must("approver1"), must("approver2")];
  headcountFreeAtStart = await freeNear(headcount.accountId);
});

after(async () => {
  await worker?.tearDown();
});

/**
 * An account's NEAR, or null if it does not exist. Read at the latest block, as near-workspaces' own
 * views are: a call returns once its receipts have run, a couple of blocks before they are final, and
 * a one-node sandbox never rolls a block back.
 */
async function nearOf(accountId: string): Promise<bigint | null> {
  try {
    return BigInt((await worker!.provider.viewAccount(accountId, { finality: "optimistic" })).amount);
  } catch {
    return null;
  }
}

/** NEAR an account holds beyond what its storage locks (10^19 yoctoNEAR a byte). */
async function freeNear(accountId: string): Promise<bigint> {
  const account = await worker!.provider.viewAccount(accountId, { finality: "optimistic" });
  return BigInt(account.amount) - BigInt(account.storage_usage) * 10n ** 19n;
}

const getRound = (): Promise<RoundView> => headcount.view<RoundView>("get_round", { round_id: roundId });
const stateOf = (round: RoundView, recipient: string): string => round.payments.find((p) => p.recipient === recipient)!.state;

const passVote = async (kind: FunctionCallKind, description: string): Promise<ProposalView> => {
  const id = await treasurer.call<number>(dao, "add_proposal", { proposal: { description, kind } });
  for (const voter of approvers) {
    await voter.call(dao, "act_proposal", { id, action: "VoteApprove", proposal: kind }, { gas: VOTE_GAS });
  }
  return dao.view<ProposalView>("get_proposal", { id });
};

/** Alice, who holds no role anywhere, pays the next batch with `gasTgas` of gas. */
const payoutBatch = async (gasTgas: number): Promise<number> => {
  const result = await alice.callRaw(headcount, "payout_batch", { round_id: roundId, limit: 100 }, { gas: tgas(gasTgas) });
  assert.ok(result.succeeded, `payout_batch with ${gasTgas} TGas failed: ${result.receiptFailureMessages.join("; ")}`);
  return result.parseResult<number>();
};

test("a NEAR round is funded by a vote that attaches exactly its total: the round no template can fund", async () => {
  const configured = await passVote(
    callKind(
      headcount.accountId,
      "configure",
      { dao_id: dao.accountId, screener_id: screener.accountId, verdict_window_sec: WINDOW_SEC, hold_window_sec: WINDOW_SEC },
      near("0.01"),
      30,
    ),
    "Name the screener; 60-second windows",
  );
  assert.equal(configured.status, "Approved");

  const payments = Object.entries(AMOUNTS).map(([recipient, amount]) => ({ recipient, amount: String(amount) }));
  roundId = await treasurer.call<string>(
    headcount,
    "create_round",
    { dao_id: dao.accountId, token_id: "native", payments, timestamp: 1_794_096_000_000 },
    { attachedDeposit: near("0.1"), gas: tgas(100) },
  );
  const groups = [{ accounts: [ID("kim"), ID("lee")], signals: ["shared-key"], evidence: ["written by hand for the sandbox"] }];
  await screener.call(
    headcount,
    "post_verdict",
    {
      round_id: roundId,
      verdict: {
        screened_at_block: 1,
        rule: "hold-linked-v1",
        groups,
        report_sha256: createHash("sha256").update(JSON.stringify(groups)).digest("hex"),
        report_url: null,
      },
    },
    { attachedDeposit: near("0.1"), gas: tgas(50) },
  );

  const hcBefore = (await nearOf(headcount.accountId))!;
  const funded = await passVote(
    callKind(headcount.accountId, "fund_round", { round_id: roundId }, TOTAL, 30),
    "Fund the NEAR round with its total",
  );
  assert.equal(funded.status, "Approved");
  const round = await getRound();
  assert.equal(round.total, String(TOTAL));
  assert.ok(round.funded_at_sec, "the round is funded");
  const received = (await nearOf(headcount.accountId))! - hcBefore;
  assert.ok(received >= TOTAL && received - TOTAL < GAS_SLACK, `Headcount received the round's ${TOTAL} yoctoNEAR (got ${received})`);
  console.log(
    `  NEAR ROUND ${roundId.slice(0, 12)}...: ${Object.keys(AMOUNTS).length} recipients, ${nearText(TOTAL)} NEAR, funded by a vote whose ` +
      `FunctionCall attached exactly that (proposal ${funded.id}); kim and lee held`,
  );
});

test("anyone pays it in batches sized to what each NEAR payment costs; a payment that creates an implicit account counts for 10 TGas", async () => {
  const cleared = [ID("ana"), ID("ben"), ...implicit, ID("ghost")];
  const payable = cleared.length;
  const before = new Map<string, bigint | null>();
  for (const r of cleared) before.set(r, await nearOf(r));
  for (const r of [...implicit, ID("ghost")]) assert.equal(before.get(r), null, `${r} does not exist yet`);

  // 40 TGas leaves about 16 for transfers: enough for one implicit account at its real cost, never
  // for all nine, whatever the list order. Counted at 1 TGas each, all nine would be scheduled, and
  // the six account creations (about 50 TGas) would run the call out of gas with nothing paid.
  const left = await payoutBatch(40);
  assert.ok(left >= 1 && left < payable, `a 40 TGas batch pays part of the ${payable}, not ${payable - left}`);
  const firstBatch = payable - left;
  assert.equal(await payoutBatch(300), 0, "the second batch pays the rest");

  const round = await getRound();
  for (const r of [ID("ana"), ID("ben"), ...implicit]) {
    const now = (await nearOf(r))!;
    assert.equal(now - (before.get(r) ?? 0n), AMOUNTS[r], `${r} got exactly its amount`);
    assert.equal(stateOf(round, r), "Paid");
  }
  assert.equal(await nearOf(ID("ghost")), null, "nothing created ghost");
  assert.equal(stateOf(round, ID("ghost")), "Failed");
  assert.deepEqual([stateOf(round, ID("kim")), stateOf(round, ID("lee"))], ["Held", "Held"]);
  console.log(
    `  PAID in 2 batches (${firstBatch} with 40 TGas, then ${payable - firstBatch}): ana and ben got exactly their NEAR, and ` +
      `six implicit accounts were created holding exactly theirs; the transfer to ghost.test.near, which does not ` +
      `exist, failed and came back to Headcount, marked Failed; kim and lee are held`,
  );
});

test("a NEAR payment that failed can only go back to the DAO, to the yoctoNEAR", async () => {
  const daoBefore = (await nearOf(dao.accountId))!;
  await alice.call(headcount, "refund_expired", { round_id: roundId }, { gas: tgas(100) });
  assert.equal((await nearOf(dao.accountId))! - daoBefore, AMOUNTS[ID("ghost")], "the DAO's NEAR is up by exactly ghost's share");
  const round = await getRound();
  assert.equal(stateOf(round, ID("ghost")), "Refunded");
  assert.equal(round.refunded, String(AMOUNTS[ID("ghost")]));
  console.log(`  RETURNED: ghost's ${nearText(AMOUNTS[ID("ghost")]!)} NEAR went back to ${dao.accountId}, to the yoctoNEAR`);
});

test("the council pays kim and returns lee's share; the books balance and Headcount keeps none of the NEAR", async () => {
  const daoBefore = (await nearOf(dao.accountId))!;
  const kimBefore = (await nearOf(ID("kim")))!;
  const decided = await passVote(
    callKind(headcount.accountId, "resolve_group", { round_id: roundId, group: 1, decision: { ReleaseOne: { account_id: ID("kim") } } }, 0n, 60),
    "Group 1: pay kim once, return lee's share",
  );
  assert.equal(decided.status, "Approved");
  const lee = AMOUNTS[ID("lee")]!;
  const daoGain = (await nearOf(dao.accountId))! - daoBefore;
  assert.ok(daoGain >= lee && daoGain - lee < GAS_SLACK, `the DAO got lee's ${lee} back, plus at most its gas rewards (got ${daoGain})`);
  assert.equal(await payoutBatch(30), 0);
  assert.equal((await nearOf(ID("kim")))! - kimBefore, AMOUNTS[ID("kim")], "kim got exactly its amount");

  const round = await getRound();
  assert.deepEqual(
    round.groups.map((g) => [g.state, g.released]),
    [["ReleasedOne", ID("kim")]],
  );
  assert.ok(round.payments.every((p) => p.state === "Paid" || p.state === "Refunded"));
  const paid = [ID("ana"), ID("ben"), ...implicit, ID("kim")].reduce((sum, r) => sum + AMOUNTS[r]!, 0n);
  assert.deepEqual([round.paid, round.refunded], [String(paid), String(AMOUNTS[ID("ghost")]! + lee)]);
  assert.equal(BigInt(round.paid) + BigInt(round.refunded), TOTAL, "paid + refunded = funded");
  const gained = (await freeNear(headcount.accountId)) - headcountFreeAtStart;
  assert.ok(gained >= 0n && gained < near("0.05"), `beyond its storage, Headcount kept ${gained} yoctoNEAR: gas rewards only`);

  // Each account's record with this DAO, read from its rounds: listed, held, paid, returned.
  const recordOf = async (account: string): Promise<number[]> => {
    const r = await headcount.view<AccountRecordView>("get_account_record", { dao_id: dao.accountId, account_id: account });
    assert.deepEqual([r.rounds_read, r.rounds_total], [1, 1], "the DAO's one round was read");
    return [r.rounds_listed, r.rounds_held, r.rounds_paid, r.rounds_returned];
  };
  assert.deepEqual(await recordOf(ID("ana")), [1, 0, 1, 0]);
  assert.deepEqual(await recordOf(implicit[0]!), [1, 0, 1, 0]);
  assert.deepEqual(await recordOf(ID("kim")), [1, 1, 1, 0], "held, then paid by the council's decision");
  assert.deepEqual(await recordOf(ID("lee")), [1, 1, 0, 1], "held, then returned");
  assert.deepEqual(await recordOf(ID("ghost")), [1, 0, 0, 1], "its failed payment went back");
  assert.deepEqual(await recordOf(alice.accountId), [0, 0, 0, 0], "not on the list");
  console.log(
    `  COUNCIL VOTE (proposal ${decided.id}): kim paid exactly ${nearText(AMOUNTS[ID("kim")]!)} NEAR, lee's ` +
      `${nearText(lee)} back to the DAO. BOOKS: paid ${nearText(paid)} + returned ` +
      `${nearText(BigInt(round.refunded))} = funded ${nearText(TOTAL)} NEAR; Headcount kept none of it`,
  );
  console.log(
    "  RECORDS with dao.test.near (get_account_record): kim listed 1, held 1, paid 1; lee listed 1, held 1, " +
      "returned 1; ghost listed 1, returned 1; ana listed 1, paid 1",
  );
});
