/**
 * Headcount next to the real Sputnik DAO v3.2, in a local near-workspaces sandbox, with the roles
 * Trezu gives every treasury. The tests are the design's numbered scenarios, in order: each one
 * builds on the state the previous one left.
 *
 *     npm test
 *
 * Nothing here touches a network: the sandbox is a local neard with throwaway accounts.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseNEAR } from "near-workspaces";
import type { NearAccount, Worker } from "near-workspaces";

import { listId, parseTrezuCsv, type Payment } from "../src/list-id.ts";
import {
  b64json,
  callKind,
  expectReject,
  quietSandboxLogs,
  tgas,
  transferKind,
  trezuPolicy,
  type ActionCall,
  type FunctionCallKind,
  type ProposalKind,
  type ProposalView,
} from "./harness.ts";
import { startSandbox } from "./sandbox.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "out");
const FIXTURES = join(ROOT, "fixtures");
const WASM = {
  sputnik: join(OUT, "sputnikdao2.wasm"),
  token: join(OUT, "test_token.wasm"),
  headcount: join(OUT, "headcount.wasm"),
};

const DAY = 86_400;
/** Gas for one vote: the vote itself, the DAO's call (up to 100 TGas) and Sputnik's callback. */
const VOTE_GAS = tgas(250);
/** Slack for gas and contract rewards when a NEAR balance is compared: far below any deposit here. */
const GAS_SLACK = BigInt(parseNEAR("0.01"));
/** The sandbox token stands in for a 6-decimal token such as USDC. */
const DECIMALS = 6;

interface DaoConfig {
  readonly screener_id: string;
  readonly verdict_window_sec: number;
  readonly hold_window_sec: number;
}

interface HeldGroup {
  readonly accounts: readonly string[];
  readonly signals: readonly string[];
  readonly evidence: readonly string[];
}

interface Verdict {
  readonly screened_at_block: number;
  readonly rule: string;
  readonly groups: readonly HeldGroup[];
  readonly report_sha256: string;
  readonly report_url: string | null;
}

interface PostedVerdict {
  readonly screener_id: string;
  readonly posted_at_sec: number;
  readonly verdict: Verdict;
}

/** Where a payment stands, as the contract's `PaymentState` names it. */
type PaymentState = "Pending" | "Held" | "Released" | "Paying" | "Paid" | "Failed" | "Refunding" | "Refunded";

interface GroupView {
  readonly group: number;
  readonly accounts: readonly string[];
  readonly state: "Open" | "ReleasedAll" | "ReleasedOne" | "Refunded" | "Expired";
  readonly released: string | null;
  readonly decided_at_sec: number | null;
}

interface RoundView {
  readonly round_id: string;
  readonly dao_id: string;
  readonly token_id: string;
  readonly payments: readonly { readonly recipient: string; readonly amount: string; readonly state: PaymentState }[];
  readonly total: string;
  readonly creator_id: string;
  readonly storage_deposit: string;
  readonly verdict_window_sec: number;
  readonly hold_window_sec: number;
  readonly funded_at_sec: number | null;
  readonly verdict: PostedVerdict | null;
  readonly groups: readonly GroupView[];
  readonly paid: string;
  readonly refunded: string;
  readonly verdict_deadline_sec: number;
  readonly hold_deadline_sec: number | null;
}

/** The council's decision on a held group, as `resolve_group` takes it. */
type Decision = "ReleaseAll" | "Refund" | { readonly ReleaseOne: { readonly account_id: string } };

/** The sandbox round's vector: the id Trezu's own generateListId gave this list. */
const sandboxVector = (() => {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, "trezu-list-ids.json"), "utf8")) as {
    readonly vectors: readonly {
      readonly submitter: string;
      readonly token_id: string;
      readonly timestamp: number;
      readonly payments: readonly Payment[];
      readonly list_id: string;
    }[];
  };
  const vector = fixture.vectors.find((v) => v.submitter === "dao.test.near");
  if (!vector) throw new Error("fixtures/trezu-list-ids.json has no sandbox round");
  return vector;
})();

let worker: Worker | undefined;
let dao: NearAccount;
let token: NearAccount;
/** A second NEP-141 token the DAO also holds: the wrong token for every round here. */
let otherToken: NearAccount;
let headcount: NearAccount;
let treasurer: NearAccount;
let approvers: NearAccount[];
let screener: NearAccount;
/** Not in the DAO: holds tokens and NEAR of her own. */
let alice: NearAccount;
/** The 16-recipient token round scenario 2 creates; later scenarios act on it. */
let round16 = "";
/** Headcount's NEAR beyond what its storage locks, before any round exists (scenario 13 compares). */
let headcountFreeAtStart = 0n;

before(async () => {
  for (const wasm of Object.values(WASM)) {
    if (!existsSync(wasm)) throw new Error(`${wasm} is missing. Run npm test, whose pretest builds it.`);
  }
  quietSandboxLogs();
  worker = await startSandbox();
  const root = worker.rootAccount;

  treasurer = await root.createSubAccount("treasurer");
  const admin = await root.createSubAccount("admin");
  approvers = [
    await root.createSubAccount("approver1"),
    await root.createSubAccount("approver2"),
    await root.createSubAccount("approver3"),
    await root.createSubAccount("approver4"),
  ];
  screener = await root.createSubAccount("screener");
  alice = await root.createSubAccount("alice", { initialBalance: BigInt(parseNEAR("20")) });

  dao = await root.createSubAccount("dao", { initialBalance: BigInt(parseNEAR("50")) });
  await dao.deploy(WASM.sputnik);
  await root.call(dao, "new", {
    config: { name: "community", purpose: "pays contributors for campaigns", metadata: "" },
    policy: trezuPolicy({
      requestors: [treasurer.accountId],
      admins: [admin.accountId],
      approvers: approvers.map((a) => a.accountId),
      paymentThreshold: 2,
      governanceThreshold: 1,
    }),
  });

  token = await root.createSubAccount("token", { initialBalance: BigInt(parseNEAR("10")) });
  await token.deploy(WASM.token);
  await root.call(token, "new", {});
  await root.call(token, "mint", { account_id: dao.accountId, amount: String(1_000_000n * 10n ** BigInt(DECIMALS)) });
  await root.call(token, "mint", { account_id: alice.accountId, amount: String(1_000n * 10n ** BigInt(DECIMALS)) });

  otherToken = await root.createSubAccount("othertoken", { initialBalance: BigInt(parseNEAR("10")) });
  await otherToken.deploy(WASM.token);
  await root.call(otherToken, "new", {});
  await root.call(otherToken, "mint", { account_id: dao.accountId, amount: String(1_000_000n * 10n ** BigInt(DECIMALS)) });

  headcount = await root.createSubAccount("headcount", { initialBalance: BigInt(parseNEAR("10")) });
  await headcount.deploy(WASM.headcount);
  await root.call(headcount, "new", {});
  // Headcount needs a balance record on a token before it can receive it, as any NEP-141 receiver does.
  for (const t of [token, otherToken]) {
    await root.call(t, "storage_deposit", { account_id: headcount.accountId }, { attachedDeposit: BigInt(parseNEAR("0.01")) });
  }
  headcountFreeAtStart = await freeNear(headcount);

  console.log(
    `  ${dao.accountId}: Sputnik ${await dao.view<string>("version")} with Trezu roles; ` +
      `Headcount at ${headcount.accountId}, which holds no role in the DAO`,
  );
});

after(async () => {
  await worker?.tearDown();
});

const getProposal = (id: number): Promise<ProposalView> => dao.view<ProposalView>("get_proposal", { id });
const getConfig = (): Promise<DaoConfig | null> => headcount.view<DaoConfig | null>("get_config", { dao_id: dao.accountId });
const getRound = (id: string): Promise<RoundView | null> => headcount.view<RoundView | null>("get_round", { round_id: id });

/** The Requestor files a proposal; Trezu's bond is zero. */
const file = (kind: ProposalKind, description: string): Promise<number> =>
  treasurer.call<number>(dao, "add_proposal", { proposal: { description, kind } });

/** One Approver vote, carrying the stored kind back as Sputnik requires. */
const approve = (voter: NearAccount, id: number, kind: ProposalKind): Promise<unknown> =>
  voter.call(dao, "act_proposal", { id, action: "VoteApprove", proposal: kind }, { gas: VOTE_GAS });

/** Files a proposal and has two Approvers pass it; returns its id. */
const passVote = async (kind: ProposalKind, description: string): Promise<number> =>
  (await passVoteWithLogs(kind, description)).id;

/**
 * Files a proposal and has two Approvers pass it. Returns its id and every log of the deciding
 * vote's transaction, which include the logs of the DAO's call and whatever that call reached.
 */
const passVoteWithLogs = async (kind: ProposalKind, description: string): Promise<{ id: number; logs: string[] }> => {
  const [first, second] = approvers as [NearAccount, NearAccount];
  const id = await file(kind, description);
  await approve(first, id, kind);
  const deciding = await second.callRaw(dao, "act_proposal", { id, action: "VoteApprove", proposal: kind }, { gas: VOTE_GAS });
  return { id, logs: deciding.logs };
};

/** Asserts Headcount logged that it refused a token transfer and sent it back, for `why`. */
const assertSentBack = (logs: readonly string[], why: string): void => {
  const line = `ft_on_transfer: refused, sent back: ${why}`;
  assert.ok(logs.includes(line), `expected the log line\n  ${line}\ngot\n  ${logs.join("\n  ")}`);
};

const configureKind = (windowSec: number = 2 * DAY): FunctionCallKind =>
  callKind(
    headcount.accountId,
    "configure",
    { dao_id: dao.accountId, screener_id: screener.accountId, verdict_window_sec: windowSec, hold_window_sec: windowSec },
    BigInt(parseNEAR("0.01")),
    30,
  );

/**
 * The windows the DAO moves to before the NEAR round is created, so that scenarios 9 and 10 can run
 * past a deadline in seconds: the sandbox clock is moved forward rather than waited out.
 */
const SHORT_WINDOW_SEC = 60;

test("scenario 1: the DAO names its screener through a FunctionCall proposal and two approvals", async () => {
  const [first, second] = approvers as [NearAccount, NearAccount];
  const kind = configureKind();
  const id = await file(kind, "Name the screener for our Headcount rounds");

  await approve(first, id, kind);
  assert.equal((await getProposal(id)).status, "InProgress");
  assert.equal(await getConfig(), null, "nothing is configured before the threshold");

  await approve(second, id, kind);
  assert.equal((await getProposal(id)).status, "Approved");
  assert.deepEqual(await getConfig(), {
    screener_id: screener.accountId,
    verdict_window_sec: 2 * DAY,
    hold_window_sec: 2 * DAY,
  });
  console.log(`  CONFIGURED by vote (proposal ${id}, Approved): ${dao.accountId} names ${screener.accountId}, 2-day windows`);
});

test("only the DAO itself can configure it: the Requestor's direct call is refused", async () => {
  await expectReject(
    () =>
      treasurer.call(
        headcount,
        "configure",
        { dao_id: dao.accountId, screener_id: treasurer.accountId, verdict_window_sec: DAY, hold_window_sec: DAY },
        { attachedDeposit: BigInt(parseNEAR("0.01")) },
      ),
    `only ${dao.accountId} itself can configure ${dao.accountId}`,
  );
  assert.equal((await getConfig())?.screener_id, screener.accountId, "the DAO's screener is unchanged");
  console.log("  REFUSED: the Requestor calling configure for the DAO directly, outside a vote");
});

test("scenario 2: the Requestor creates a 16-recipient round from a Trezu-format CSV; its id is Trezu's list id", async () => {
  const payments = parseTrezuCsv(readFileSync(join(FIXTURES, "round-16.csv"), "utf8"), DECIMALS);
  assert.equal(payments.length, 16);
  const args = { dao_id: dao.accountId, token_id: token.accountId, payments, timestamp: sandboxVector.timestamp };

  const roundId = await treasurer.call<string>(headcount, "create_round", args, {
    attachedDeposit: BigInt(parseNEAR("0.1")),
    gas: tgas(100),
  });

  assert.equal(roundId, sandboxVector.list_id, "the id Trezu's own generateListId gave this list");
  round16 = roundId;
  assert.equal(roundId, listId({ submitter: dao.accountId, tokenId: token.accountId, payments, timestamp: args.timestamp }));
  const round = await getRound(roundId);
  assert.ok(round);
  assert.equal(round.payments.length, 16);
  assert.deepEqual(
    round.payments.map((p) => p.recipient),
    payments.map((p) => p.recipient).sort(),
    "stored in byte order, the order the id hashes",
  );
  assert.equal(round.total, String(payments.reduce((sum, p) => sum + BigInt(p.amount), 0n)));
  assert.equal(round.creator_id, treasurer.accountId);
  assert.equal(round.funded_at_sec, null);
  assert.ok(BigInt(round.storage_deposit) > 0n, "the Requestor paid the round's storage");
  console.log(
    `  ROUND ${roundId.slice(0, 12)}... created from fixtures/round-16.csv: 16 recipients, total ${round.total} ` +
      `(= Trezu's generateListId for the same list)`,
  );
});

// --- Nov 6: the screener's verdict, and funding through the right door only ---------------------

const balanceOf = async (t: NearAccount, who: NearAccount): Promise<bigint> =>
  BigInt(await t.view<string>("ft_balance_of", { account_id: who.accountId }));

const nearOf = async (who: NearAccount): Promise<bigint> => BigInt((await who.balance()).total);

/**
 * The FunctionCall Trezu's bulk payments file to fund a token list, pointed at Headcount: the
 * token's ft_transfer_call with the round id as msg, 1 yoctoNEAR and 100 TGas.
 */
const ftTransferCall = (t: NearAccount, amount: bigint, roundId: string): FunctionCallKind =>
  callKind(t.accountId, "ft_transfer_call", { receiver_id: headcount.accountId, amount: String(amount), msg: roundId }, 1n, 100);

const fundRoundCall = (roundId: string, deposit: bigint): FunctionCallKind =>
  callKind(headcount.accountId, "fund_round", { round_id: roundId }, deposit, 30);

const linked = (names: readonly string[], signal: string): HeldGroup => ({
  accounts: names.map((n) => `${n}.test.near`),
  signals: [signal],
  evidence: ["written by hand for the sandbox; the screener writes real evidence"],
});

/** A verdict written by hand. The screener that reads the chain and writes one comes later. */
const handVerdict = async (groups: readonly HeldGroup[]): Promise<Verdict> => ({
  screened_at_block: (await worker!.provider.viewAccount(headcount.accountId, { finality: "final" })).block_height,
  rule: "hold-linked-v1",
  groups,
  report_sha256: createHash("sha256").update(JSON.stringify(groups)).digest("hex"),
  report_url: null,
});

const postVerdict = (who: NearAccount, roundId: string, verdict: Verdict): Promise<unknown> =>
  who.call(headcount, "post_verdict", { round_id: roundId, verdict }, { attachedDeposit: BigInt(parseNEAR("0.1")), gas: tgas(50) });

const createRound = (tokenId: string, payments: readonly Payment[], timestamp: number): Promise<string> =>
  treasurer.call<string>(
    headcount,
    "create_round",
    { dao_id: dao.accountId, token_id: tokenId, payments, timestamp },
    { attachedDeposit: BigInt(parseNEAR("0.1")), gas: tgas(100) },
  );

/** The NEAR round scenario 12 creates: 1 NEAR to three recipients. */
let nearRound = "";
const NEAR_ROUND_TOTAL = BigInt(parseNEAR("1"));
/** The two 100-recipient token rounds the Transfer{msg} test funds and nobody screens. */
const transferRounds: string[] = [];

test("scenario 4: an account that is not the DAO's screener cannot post a verdict", async () => {
  await expectReject(async () => postVerdict(treasurer, round16, await handVerdict([])), `${treasurer.accountId} is not this DAO's screener`);
  await expectReject(async () => postVerdict(alice, round16, await handVerdict([])), `${alice.accountId} is not this DAO's screener`);
  assert.equal((await getRound(round16))?.verdict, null, "no verdict was stored");
  console.log("  REFUSED: verdicts from the Requestor and from an outsider: not this DAO's screener");
});

test("scenario 5: a verdict naming an account that is not on the round's list is refused", async () => {
  await expectReject(
    async () => postVerdict(screener, round16, await handVerdict([linked(["r01", "alice"], "same-funder")])),
    `${alice.accountId} is not on this round's list`,
  );
  assert.equal((await getRound(round16))?.verdict, null, "no verdict was stored");
  console.log(`  REFUSED: the screener's own verdict, because it names ${alice.accountId}, who is not on the list`);
});

test("the screener's verdict holds the linked recipients, once: a second verdict is refused", async () => {
  const groups = [linked(["r01", "r02"], "same-funder"), linked(["r05", "r09", "r13"], "shared-key")];
  await postVerdict(screener, round16, await handVerdict(groups));

  const round = await getRound(round16);
  assert.ok(round?.verdict);
  assert.equal(round.verdict.screener_id, screener.accountId);
  assert.deepEqual(
    round.payments.filter((p) => p.state === "Held").map((p) => p.recipient),
    ["r01.test.near", "r02.test.near", "r05.test.near", "r09.test.near", "r13.test.near"],
  );
  assert.equal(round.payments.filter((p) => p.state === "Pending").length, 11);

  await expectReject(async () => postVerdict(screener, round16, await handVerdict([])), "already has a verdict");
  assert.deepEqual((await getRound(round16))?.verdict, round.verdict, "the first verdict stands");
  console.log("  VERDICT posted by the screener: 2 groups, 5 of 16 held, 11 cleared; a second verdict REFUSED");
});

test("scenario 12: token funding from the wrong token, a sender that is not the DAO, or a wrong amount goes back", async () => {
  const total = BigInt((await getRound(round16))!.total);
  const before = {
    daoToken: await balanceOf(token, dao),
    daoOther: await balanceOf(otherToken, dao),
    aliceToken: await balanceOf(token, alice),
    hcToken: await balanceOf(token, headcount),
    hcOther: await balanceOf(otherToken, headcount),
  };

  const wrongToken = await passVoteWithLogs(ftTransferCall(otherToken, total, round16), "Fund the round (in another token)");
  assert.equal((await getProposal(wrongToken.id)).status, "Approved", "the DAO's call ran; Headcount sent the tokens back");
  assertSentBack(wrongToken.logs, `round ${round16} pays in ${token.accountId}, not ${otherToken.accountId}`);
  assert.equal(await balanceOf(otherToken, dao), before.daoOther, "the other token is back with the DAO");
  assert.equal(await balanceOf(otherToken, headcount), before.hcOther);

  const fromAlice = await alice.callRaw(
    token,
    "ft_transfer_call",
    { receiver_id: headcount.accountId, amount: String(total), msg: round16 },
    { attachedDeposit: 1n, gas: tgas(100) },
  );
  assertSentBack(fromAlice.logs, `only ${dao.accountId} can fund its round, not ${alice.accountId}`);
  assert.equal(await balanceOf(token, alice), before.aliceToken, "alice's tokens are back with her");

  const short = await passVoteWithLogs(ftTransferCall(token, total - 1n, round16), "Fund the round (one unit short)");
  assert.equal((await getProposal(short.id)).status, "Approved");
  assertSentBack(short.logs, `round ${round16}'s total is ${total}, got ${total - 1n}`);
  assert.equal(await balanceOf(token, dao), before.daoToken, "the DAO's tokens are back with it");
  assert.equal(await balanceOf(token, headcount), before.hcToken, "Headcount kept nothing");

  assert.equal((await getRound(round16))?.funded_at_sec, null);
  console.log(
    "  SENT BACK through NEP-141's refund: the DAO's vote in another token, alice's transfer, the DAO's vote one unit short",
  );
});

test("the DAO shortens its windows to 60 s by vote; round16 keeps the 2 days it was created with", async () => {
  const id = await passVote(configureKind(SHORT_WINDOW_SEC), "Shorten the verdict and hold windows to 60 seconds");
  assert.equal((await getProposal(id)).status, "Approved");
  assert.deepEqual(await getConfig(), {
    screener_id: screener.accountId,
    verdict_window_sec: SHORT_WINDOW_SEC,
    hold_window_sec: SHORT_WINDOW_SEC,
  });
  const round = await getRound(round16);
  assert.deepEqual([round?.verdict_window_sec, round?.hold_window_sec], [2 * DAY, 2 * DAY], "a round keeps its windows");
  console.log(
    `  RECONFIGURED by vote (proposal ${id}): 60-second windows for rounds created from now on; round16 keeps its 2 days`,
  );
});

test("scenario 12: a NEAR deposit that is not exactly the DAO funding a NEAR round is refused", async () => {
  nearRound = await createRound(
    "native",
    [
      { recipient: "r01.test.near", amount: parseNEAR("0.5") },
      { recipient: "r02.test.near", amount: parseNEAR("0.3") },
      { recipient: "r03.test.near", amount: parseNEAR("0.2") },
    ],
    sandboxVector.timestamp + 1,
  );
  assert.equal((await getRound(nearRound))?.total, String(NEAR_ROUND_TOTAL));
  const daoBefore = await nearOf(dao);
  const hcBefore = await nearOf(headcount);
  const aliceBefore = await nearOf(alice);

  const short = await passVote(fundRoundCall(nearRound, NEAR_ROUND_TOTAL - 1n), "Fund the NEAR round (one yoctoNEAR short)");
  assert.equal((await getProposal(short)).status, "Failed", "Headcount refused the call, so Sputnik marks it Failed");

  const tokenInNear = await passVote(fundRoundCall(round16, NEAR_ROUND_TOTAL), "Fund the token round in NEAR");
  assert.equal((await getProposal(tokenInNear)).status, "Failed");

  await expectReject(
    () => alice.call(headcount, "fund_round", { round_id: nearRound }, { attachedDeposit: NEAR_ROUND_TOTAL }),
    `only ${dao.accountId} can fund its round`,
  );

  assert.ok((await nearOf(dao)) + GAS_SLACK >= daoBefore, "both refused deposits are back with the DAO");
  assert.ok(aliceBefore - (await nearOf(alice)) < GAS_SLACK, "alice paid gas, not the 1 NEAR");
  assert.ok((await nearOf(headcount)) - hcBefore < GAS_SLACK, "Headcount kept no deposit");
  assert.equal((await getRound(nearRound))?.funded_at_sec, null);
  assert.equal((await getRound(round16))?.funded_at_sec, null);
  console.log(
    `  REFUSED, deposit returned: the DAO's vote 1 yoctoNEAR short (proposal ${short} Failed), ` +
      `NEAR for the token round (proposal ${tokenInNear} Failed), alice funding the DAO's round`,
  );
});

test("the right doors fund a round: the vote Trezu's template files (ft_transfer_call), and fund_round with the exact total", async () => {
  const total = BigInt((await getRound(round16))!.total);
  const daoToken = await balanceOf(token, dao);
  const hcToken = await balanceOf(token, headcount);
  const hcNear = await nearOf(headcount);

  const tokenVote = await passVote(ftTransferCall(token, total, round16), "Fund the screened round");
  assert.equal((await getProposal(tokenVote)).status, "Approved");
  assert.ok((await getRound(round16))?.funded_at_sec);
  assert.equal(daoToken - (await balanceOf(token, dao)), total);
  assert.equal((await balanceOf(token, headcount)) - hcToken, total);

  const nearVote = await passVote(fundRoundCall(nearRound, NEAR_ROUND_TOTAL), "Fund the NEAR round");
  assert.equal((await getProposal(nearVote)).status, "Approved");
  assert.ok((await getRound(nearRound))?.funded_at_sec);
  assert.ok((await nearOf(headcount)) - hcNear >= NEAR_ROUND_TOTAL, "Headcount holds the round's 1 NEAR");
  console.log(`  FUNDED by vote: round16 with ${total} of ${token.accountId}, and the NEAR round with exactly 1 NEAR`);
});

/** The receipts of a transaction as `EXPERIMENTAL_tx_status` returns them (the fields read here). */
interface TxReceipts {
  readonly receipts?: readonly {
    readonly receipt_id: string;
    readonly receiver_id: string;
    readonly receipt: { readonly Action?: { readonly actions: readonly Record<string, { method_name?: string; gas?: number }>[] } };
  }[];
  readonly receipts_outcome: readonly { readonly id: string; readonly outcome: { readonly gas_burnt: number } }[];
}

/** The gas a transaction attached to Headcount's ft_on_transfer, and the gas it burnt, in TGas. */
const ftOnTransferGas = async (txHash: string, signerId: string): Promise<{ attached: number; burnt: number }> => {
  const rpc = worker!.provider as unknown as { sendJsonRpc<T>(method: string, params: object): Promise<T> };
  const tx = await rpc.sendJsonRpc<TxReceipts>("EXPERIMENTAL_tx_status", {
    tx_hash: txHash,
    sender_account_id: signerId,
    wait_until: "FINAL",
  });
  for (const r of tx.receipts ?? []) {
    const call = r.receipt.Action?.actions.map((a) => a["FunctionCall"]).find((f) => f?.method_name === "ft_on_transfer");
    if (r.receiver_id !== headcount.accountId || !call?.gas) continue;
    const burnt = tx.receipts_outcome.find((o) => o.id === r.receipt_id)?.outcome.gas_burnt ?? NaN;
    return { attached: call.gas / 1e12, burnt: burnt / 1e12 };
  }
  throw new Error(`no ft_on_transfer receipt in ${txHash}`);
};

test("a Sputnik Transfer proposal with msg also funds a round: Sputnik's 10 TGas is a floor, not a cap", async () => {
  // Sputnik v3.2 sends the transfer as ft_transfer_call with static gas GAS_FOR_FT_TRANSFER (10 TGas,
  // sputnikdao2/src/types.rs:16). near-sdk 5's call builder also gives every call an unused-gas weight
  // of 1 by default, so the promise gets a share of whatever the deciding vote leaves unused, and the
  // sandbox token (near-contract-standards 5.24.1) forwards what it does not need to ft_on_transfer.
  // How much reaches Headcount therefore depends on the gas of the vote that passes the proposal.
  // Measured on the largest round Headcount accepts, 100 recipients.
  const [first, second] = approvers as [NearAccount, NearAccount];
  const cases = [
    { voteTgas: 250, check: (given: number) => given > 100, what: "more than 100 TGas" },
    { voteTgas: 30, check: (given: number) => given < 10, what: "under 10 TGas (30 TGas is near-api-js's default for a call)" },
  ];
  for (const [i, { voteTgas, check, what }] of cases.entries()) {
    const payments = Array.from({ length: 100 }, (_, k) => ({ recipient: `p${String(k).padStart(3, "0")}.test.near`, amount: "1000" }));
    const total = 100_000n;
    const roundId = await treasurer.call<string>(
      headcount,
      "create_round",
      { dao_id: dao.accountId, token_id: token.accountId, payments, timestamp: sandboxVector.timestamp + 100 + i },
      { attachedDeposit: BigInt(parseNEAR("0.5")), gas: tgas(300) },
    );
    transferRounds.push(roundId);
    const daoToken = await balanceOf(token, dao);
    const hcToken = await balanceOf(token, headcount);

    const kind = transferKind(token.accountId, headcount.accountId, String(total), roundId);
    const id = await file(kind, `Fund the 100-recipient round with a Transfer proposal (deciding vote: ${voteTgas} TGas)`);
    await approve(first, id, kind);
    const deciding = await second.callRaw(dao, "act_proposal", { id, action: "VoteApprove", proposal: kind }, { gas: tgas(voteTgas) });

    assert.equal((await getProposal(id)).status, "Approved");
    assert.ok((await getRound(roundId))?.funded_at_sec, "the round is funded");
    assert.equal(daoToken - (await balanceOf(token, dao)), total);
    assert.equal((await balanceOf(token, headcount)) - hcToken, total);
    const gas = await ftOnTransferGas(deciding.result.transaction.hash, second.accountId);
    assert.ok(check(gas.attached), `ft_on_transfer was given ${gas.attached} TGas; expected ${what}`);
    console.log(
      `  Transfer{msg}, deciding vote ${voteTgas} TGas: funded; ft_on_transfer was given ${gas.attached.toFixed(2)} TGas ` +
        `and the receipt burnt ${gas.burnt.toFixed(2)} TGas`,
    );
  }
});

// --- Nov 7: payouts in batches, the council's decisions, deadlines, and the books ---------------

/** Never registers with round16's token, so its payout fails and the money has to go back. */
const UNREGISTERED = "r16.test.near";

/** Round16's list again, at a new timestamp: a fresh 60-second round with four planted farms. */
let farmsRound = "";
const FARMS = {
  A: ["r01", "r02", "r03", "r04", "r05"],
  B: ["r06", "r07", "r08"],
  C: ["r09", "r10"],
  D: ["r11", "r12"],
} as const;

const tokenBalance = async (t: NearAccount, accountId: string): Promise<bigint> =>
  BigInt(await t.view<string>("ft_balance_of", { account_id: accountId }));

/** NEAR an account holds beyond what its storage locks (10^19 yoctoNEAR a byte). */
async function freeNear(who: NearAccount): Promise<bigint> {
  const account = await worker!.provider.viewAccount(who.accountId, { finality: "final" });
  return BigInt(account.amount) - BigInt(account.storage_usage) * 10n ** 19n;
}

const amountOf = (round: RoundView, recipient: string): bigint => {
  const payment = round.payments.find((p) => p.recipient === recipient);
  if (!payment) throw new Error(`${recipient} is not on round ${round.round_id}`);
  return BigInt(payment.amount);
};

const sumOf = (round: RoundView, recipients: readonly string[]): bigint =>
  recipients.reduce((sum, r) => sum + amountOf(round, r), 0n);

const accountsOf = (names: readonly string[]): string[] => names.map((n) => `${n}.test.near`);

/** Registers `accounts` with the token in one transaction, as any NEP-141 recipient must be. */
const registerOnToken = async (accounts: readonly string[]): Promise<void> => {
  let tx = worker!.rootAccount.batch(token);
  for (const accountId of accounts) {
    tx = tx.functionCall(
      "storage_deposit",
      { account_id: accountId, registration_only: true },
      { attachedDeposit: BigInt(parseNEAR("0.01")), gas: tgas(10) },
    );
  }
  const result = await tx.transact();
  assert.ok(result.succeeded, `registering ${accounts.length} accounts failed: ${result.summary()}`);
};

/**
 * Alice, who holds no role anywhere, pays the next batch: anyone can. Returns how many payable
 * recipients are left, and the transaction.
 */
const payoutBatch = async (roundId: string, limit: number, gasTgas = 300) => {
  const result = await alice.callRaw(headcount, "payout_batch", { round_id: roundId, limit }, { gas: tgas(gasTgas) });
  assert.ok(result.succeeded, `payout_batch failed: ${result.receiptFailureMessages.join("; ")}`);
  return { left: result.parseResult<number>(), hash: result.result.transaction.hash };
};

const refundExpired = (roundId: string): Promise<unknown> =>
  alice.call(headcount, "refund_expired", { round_id: roundId }, { gas: tgas(100) });

/** One `resolve_group` call inside a DAO FunctionCall proposal. */
const resolveAction = (roundId: string, group: number, decision: Decision): ActionCall => ({
  method_name: "resolve_group",
  args: b64json({ round_id: roundId, group, decision }),
  deposit: "0",
  gas: String(tgas(60)),
});

const resolveKind = (...actions: ActionCall[]): FunctionCallKind => ({
  FunctionCall: { receiver_id: headcount.accountId, actions },
});

const isSettled = (round: RoundView): boolean => round.payments.every((p) => p.state === "Paid" || p.state === "Refunded");

/** The sandbox's JSON-RPC, for the methods near-workspaces does not type. */
const rpc = <T>(method: string, params: object): Promise<T> =>
  (worker!.provider as unknown as { sendJsonRpc<R>(method: string, params: object): Promise<R> }).sendJsonRpc<T>(
    method,
    params,
  );

/** The sandbox clock at the latest block, in unix seconds. */
const chainNowSec = async (): Promise<number> => {
  const block = await rpc<{ header: { timestamp_nanosec: string } }>("block", { finality: "optimistic" });
  return Number(BigInt(block.header.timestamp_nanosec) / 1_000_000_000n);
};

/** Moves the sandbox clock past `deadlineSec` with empty blocks (about 1 s of chain time each) instead of waiting. */
const passDeadline = async (deadlineSec: number): Promise<void> => {
  for (let i = 0; i < 10 && (await chainNowSec()) <= deadlineSec + 1; i += 1) {
    await worker!.provider.fastForward(Math.max(5, deadlineSec + 2 - (await chainNowSec())));
  }
  assert.ok((await chainNowSec()) > deadlineSec + 1, "the sandbox clock is past the deadline");
};

interface ReceiptGas {
  readonly receiver: string;
  readonly method: string | undefined;
  readonly attached: number;
  readonly burnt: number;
}

/** Every receipt of a transaction: who ran it, which method, the gas it was given and burnt (TGas). */
const receiptsOf = async (txHash: string, signerId: string): Promise<ReceiptGas[]> => {
  const tx = await rpc<TxReceipts>("EXPERIMENTAL_tx_status", {
    tx_hash: txHash,
    sender_account_id: signerId,
    wait_until: "FINAL",
  });
  return (tx.receipts ?? []).map((r) => {
    const call = r.receipt.Action?.actions.map((a) => a["FunctionCall"]).find((f) => f?.method_name);
    const burnt = tx.receipts_outcome.find((o) => o.id === r.receipt_id)?.outcome.gas_burnt ?? NaN;
    return { receiver: r.receiver_id, method: call?.method_name, attached: (call?.gas ?? 0) / 1e12, burnt: burnt / 1e12 };
  });
};

test("scenario 6: once the vote Trezu's template files has funded round16, anyone pays its cleared recipients in batches; held ones are kept", async () => {
  const round = (await getRound(round16))!;
  assert.ok(round.funded_at_sec, "funded earlier by the DAO's ft_transfer_call vote");
  const cleared = round.payments.filter((p) => p.state === "Pending").map((p) => p.recipient);
  assert.equal(cleared.length, 11);
  await registerOnToken(round.payments.map((p) => p.recipient).filter((r) => r !== UNREGISTERED));
  const before = new Map<string, bigint>();
  for (const p of round.payments) before.set(p.recipient, await tokenBalance(token, p.recipient));
  const hcBefore = await tokenBalance(token, headcount.accountId);

  // Gas decides the first batch's size: the contract pays what 100 TGas covers at protocol 86's fees.
  const first = await payoutBatch(round16, 100, 100);
  const firstPaid = cleared.length - first.left;
  assert.ok(firstPaid >= 2 && firstPaid < cleared.length, `a 100 TGas call pays part of the round, not ${firstPaid}`);
  const gas = await receiptsOf(first.hash, alice.accountId);
  const transfers = gas.filter((r) => r.method === "ft_transfer");
  const callback = gas.find((r) => r.method === "on_payouts");
  assert.equal(transfers.length, firstPaid);
  assert.ok(callback, "one callback for the whole batch");
  const ftBurnt = Math.max(...transfers.map((r) => r.burnt));
  assert.ok(ftBurnt < 10, `each ft_transfer burnt under its 10 TGas: ${ftBurnt}`);
  assert.ok(callback.burnt < 20, `the callback burnt under its 20 TGas of static gas: ${callback.burnt}`);
  const second = await payoutBatch(round16, 100);
  assert.equal(second.left, 0);

  const after = (await getRound(round16))!;
  for (const p of after.payments) {
    const got = (await tokenBalance(token, p.recipient)) - (before.get(p.recipient) ?? 0n);
    const expected: [PaymentState, bigint] =
      p.recipient === UNREGISTERED
        ? ["Failed", 0n]
        : cleared.includes(p.recipient)
          ? ["Paid", BigInt(p.amount)]
          : ["Held", 0n];
    assert.deepEqual([p.state, got], expected, p.recipient);
  }
  const paid = sumOf(after, cleared.filter((r) => r !== UNREGISTERED));
  assert.equal(after.paid, String(paid));
  assert.equal(hcBefore - (await tokenBalance(token, headcount.accountId)), paid, "only what was paid left Headcount");
  console.log(
    `  PAID by an outsider in 2 batches (${firstPaid} with 100 TGas, then ${cleared.length - firstPaid}): ` +
      `10 cleared recipients got exactly their amounts; ${UNREGISTERED} is not registered with the token, so its ` +
      `transfer failed and is kept for the DAO; the 5 held got nothing. Each ft_transfer burnt ${ftBurnt.toFixed(2)} ` +
      `TGas at most, the callback ${callback.burnt.toFixed(2)}`,
  );
});

test("a payment that failed can only go back to the DAO: anyone sends it back at once", async () => {
  const round = (await getRound(round16))!;
  const daoBefore = await balanceOf(token, dao);
  await refundExpired(round16);

  const share = amountOf(round, UNREGISTERED);
  assert.equal((await balanceOf(token, dao)) - daoBefore, share, "the DAO got exactly r16's share back");
  const after = (await getRound(round16))!;
  assert.equal(after.payments.find((p) => p.recipient === UNREGISTERED)?.state, "Refunded");
  assert.equal(after.refunded, String(share));
  assert.equal(after.payments.filter((p) => p.state === "Held").length, 5, "the held groups wait: 2 days to go");
  console.log(`  RETURNED: ${UNREGISTERED}'s failed ${share} went back to ${dao.accountId}; nothing else moved`);
});

test("scenario 7: nobody can pay a held account, or decide a held group without a DAO vote", async () => {
  const held = (await getRound(round16))!.payments.filter((p) => p.state === "Held").map((p) => p.recipient);
  await expectReject(
    () => alice.call(headcount, "payout_batch", { round_id: round16, limit: 100 }, { gas: tgas(100) }),
    "its 5 held recipient(s) wait for a council vote",
  );
  for (const who of [alice, treasurer, screener]) {
    await expectReject(
      () =>
        who.call(
          headcount,
          "resolve_group",
          { round_id: round16, group: 1, decision: "ReleaseAll" satisfies Decision },
          { gas: tgas(100) },
        ),
      `only ${dao.accountId} can resolve a held group of its round: file a FunctionCall proposal on the DAO`,
    );
  }
  const round = (await getRound(round16))!;
  assert.deepEqual(
    round.payments.filter((p) => p.state === "Held").map((p) => p.recipient),
    held,
  );
  assert.ok(round.groups.every((g) => g.state === "Open"));
  for (const r of held) assert.equal(await tokenBalance(token, r), 0n, `${r} got nothing`);
  console.log(
    "  REFUSED: another payout (only the 5 held are left), and resolve_group from an outsider, the Requestor " +
      "and the screener: only a DAO vote decides a held group",
  );
});

test("the council decides both of round16's groups in one vote: group 1 pays r01 only, group 2 goes back", async () => {
  const round = (await getRound(round16))!;
  const daoBefore = await balanceOf(token, dao);
  const r01Before = await tokenBalance(token, "r01.test.near");

  const id = await passVote(
    resolveKind(
      resolveAction(round16, 1, { ReleaseOne: { account_id: "r01.test.near" } }),
      resolveAction(round16, 2, "Refund"),
    ),
    "Group 1: pay r01 once. Group 2: back to the treasury.",
  );
  assert.equal((await getProposal(id)).status, "Approved");
  const back = sumOf(round, accountsOf(["r02", "r05", "r09", "r13"]));
  assert.equal((await balanceOf(token, dao)) - daoBefore, back, "r02 and group 2 are back with the DAO, exactly");
  const decided = (await getRound(round16))!;
  assert.deepEqual(
    decided.groups.map((g) => [g.state, g.released]),
    [
      ["ReleasedOne", "r01.test.near"],
      ["Refunded", null],
    ],
  );

  assert.equal((await payoutBatch(round16, 100)).left, 0);
  assert.equal((await tokenBalance(token, "r01.test.near")) - r01Before, amountOf(round, "r01.test.near"));
  const settled = (await getRound(round16))!;
  assert.ok(isSettled(settled), "every payment of round16 is paid or back with the DAO");
  assert.equal(BigInt(settled.paid) + BigInt(settled.refunded), BigInt(settled.total));
  console.log(
    `  COUNCIL VOTE (proposal ${id}, Approved), two decisions in one FunctionCall: group 1 pays r01 once ` +
      `(${amountOf(round, "r01.test.near")}, paid by the next batch) and ${back} went back to the DAO. Round16 is settled`,
  );
});

test("scenario 8: on a fresh 60-second round, the council votes to release farm C (a couple who share a household); it is paid", async () => {
  await registerOnToken([UNREGISTERED]);
  const payments = parseTrezuCsv(readFileSync(join(FIXTURES, "round-16.csv"), "utf8"), DECIMALS);
  farmsRound = await createRound(token.accountId, payments, sandboxVector.timestamp + 2);
  await postVerdict(
    screener,
    farmsRound,
    await handVerdict([
      linked(FARMS.A, "same-funder"),
      linked(FARMS.B, "shared-key"),
      linked(FARMS.C, "direct-transfer"),
      linked(FARMS.D, "shared-collector"),
    ]),
  );
  const round = (await getRound(farmsRound))!;
  assert.equal(round.hold_window_sec, SHORT_WINDOW_SEC);
  await passVote(ftTransferCall(token, BigInt(round.total), farmsRound), "Fund the screened round");
  // Within the hold window, nothing held can be sent back: only a council vote can decide it.
  await expectReject(() => refundExpired(farmsRound), "held groups wait for a council vote until");
  const cleared = accountsOf(["r13", "r14", "r15", "r16"]);
  const clearedBefore = await Promise.all(cleared.map((r) => tokenBalance(token, r)));
  assert.equal((await payoutBatch(farmsRound, 100)).left, 0, "the four cleared recipients are paid");
  for (const [i, r] of cleared.entries()) {
    assert.equal((await tokenBalance(token, r)) - (clearedBefore[i] ?? 0n), amountOf(round, r), `${r} is paid`);
  }

  const farmC = accountsOf(FARMS.C);
  const cBefore = await Promise.all(farmC.map((r) => tokenBalance(token, r)));
  const id = await passVote(
    resolveKind(resolveAction(farmsRound, 3, "ReleaseAll")),
    "Release farm C: a couple who share a household",
  );
  assert.equal((await getProposal(id)).status, "Approved");
  assert.equal((await getRound(farmsRound))!.groups[2]?.state, "ReleasedAll");
  assert.equal((await payoutBatch(farmsRound, 100)).left, 0);
  for (const [i, r] of farmC.entries()) {
    assert.equal((await tokenBalance(token, r)) - (cBefore[i] ?? 0n), amountOf(round, r), `${r} is paid`);
  }
  const after = (await getRound(farmsRound))!;
  assert.deepEqual(
    after.payments.filter((p) => p.state === "Held").map((p) => p.recipient),
    accountsOf([...FARMS.A, ...FARMS.B, ...FARMS.D]),
  );
  console.log(
    `  RELEASED by vote (proposal ${id}): farm C (r09, r10) paid ${sumOf(round, farmC)}; the 4 cleared were ` +
      `paid first; farms A, B and D (10 accounts) still held, and refund_expired REFUSED inside the hold window`,
  );
});

test("scenario 9: farms A, B and D are left alone past the hold window; anyone sends them back, and the DAO is up by exactly that", async () => {
  const round = (await getRound(farmsRound))!;
  const deadline = round.hold_deadline_sec;
  assert.ok(deadline, "a funded, screened round has a hold deadline");
  await passDeadline(deadline);

  const daoBefore = await balanceOf(token, dao);
  await refundExpired(farmsRound);
  const back = sumOf(round, accountsOf([...FARMS.A, ...FARMS.B, ...FARMS.D]));
  assert.equal((await balanceOf(token, dao)) - daoBefore, back, "the DAO's balance is up by exactly the three farms");
  const after = (await getRound(farmsRound))!;
  assert.deepEqual(
    after.groups.map((g) => g.state),
    ["Expired", "Expired", "ReleasedAll", "Expired"],
  );
  assert.ok(isSettled(after));
  assert.equal(BigInt(after.paid) + BigInt(after.refunded), BigInt(after.total));
  console.log(
    `  EXPIRED: past the hold window, an outsider's refund_expired sent farms A, B and D (${back}) back; ` +
      `the DAO's balance rose by exactly that`,
  );
});

test("scenario 10: rounds funded with no verdict go back whole once the verdict window closes", async () => {
  const nearView = (await getRound(nearRound))!;
  assert.equal(nearView.verdict, null);
  await passDeadline(nearView.verdict_deadline_sec);
  await expectReject(async () => postVerdict(screener, nearRound, await handVerdict([])), "the verdict window closed");

  const daoNear = await nearOf(dao);
  await refundExpired(nearRound);
  assert.equal((await nearOf(dao)) - daoNear, NEAR_ROUND_TOTAL, "the DAO's NEAR is up by exactly the round's 1 NEAR");

  const daoToken = await balanceOf(token, dao);
  let back = 0n;
  for (const id of transferRounds) {
    const round = (await getRound(id))!;
    await passDeadline(round.verdict_deadline_sec);
    await refundExpired(id);
    back += BigInt(round.total);
  }
  assert.equal(transferRounds.length, 2);
  assert.equal((await balanceOf(token, dao)) - daoToken, back, "both 100-recipient rounds are back, exactly");
  for (const id of [nearRound, ...transferRounds]) {
    const round = (await getRound(id))!;
    assert.ok(round.payments.every((p) => p.state === "Refunded"), id);
    assert.equal(round.refunded, round.total);
  }
  console.log(
    `  RETURNED WHOLE after the verdict window: the NEAR round (the DAO's NEAR up by exactly 1 NEAR; a late verdict ` +
      `refused) and both 100-recipient rounds (${back} of the token)`,
  );
});

test("scenario 11: one amount edited after screening makes a new round; the old verdict does not apply", async () => {
  const payments = parseTrezuCsv(readFileSync(join(FIXTURES, "round-16.csv"), "utf8"), DECIMALS);
  const edited = payments.map((p) => (p.recipient === "r09.test.near" ? { ...p, amount: String(BigInt(p.amount) + 1n) } : p));
  const id = await createRound(token.accountId, edited, sandboxVector.timestamp + 2);
  assert.notEqual(id, farmsRound, "same list and timestamp but one amount: another id");
  const round = (await getRound(id))!;
  assert.equal(round.verdict, null);
  assert.ok(
    round.payments.every((p) => p.state === "Pending"),
    "no hold carries over, not even r09's",
  );
  await expectReject(
    () => alice.call(headcount, "payout_batch", { round_id: id, limit: 100 }, { gas: tgas(100) }),
    "has no verdict yet: nothing is paid before the screen",
  );
  assert.ok((await getRound(farmsRound))!.verdict, "the screened round keeps its verdict");
  console.log(
    `  NEW ROUND ${id.slice(0, 12)}...: r09's amount +1 unit gives another id; it has no verdict, and paying it is refused`,
  );
});

test("scenario 13: over every round Headcount lists, paid + refunded = funded, and Headcount keeps none of the money", async () => {
  const rounds = await headcount.view<RoundView[]>("get_rounds", { dao_id: dao.accountId, from_index: 0, limit: 100 });
  assert.equal(rounds.length, 6, "round16, the NEAR round, two 100-recipient rounds, the farms round, the edited one");
  let settled = 0;
  for (const round of rounds) {
    if (round.funded_at_sec) {
      assert.ok(isSettled(round), `${round.round_id}: every payment paid or back with the DAO`);
      assert.equal(BigInt(round.paid) + BigInt(round.refunded), BigInt(round.total), `${round.round_id}: paid + refunded = funded`);
      settled += 1;
    } else {
      assert.deepEqual([round.paid, round.refunded], ["0", "0"], `${round.round_id} was never funded`);
    }
  }
  assert.equal(settled, 5);
  assert.equal(await tokenBalance(token, headcount.accountId), 0n, "Headcount holds none of the token");
  assert.equal(await tokenBalance(otherToken, headcount.accountId), 0n, "nor of the other token");
  const gained = (await freeNear(headcount)) - headcountFreeAtStart;
  assert.ok(
    gained >= 0n && gained < BigInt(parseNEAR("0.05")),
    `beyond its storage, Headcount's NEAR moved by ${gained} yoctoNEAR since it was deployed: gas rewards only`,
  );
  console.log(
    `  BOOKS BALANCE over all ${rounds.length} rounds get_rounds lists: the 5 funded are settled with paid + refunded = ` +
      `funded, and the edited one was never funded. Headcount holds 0 of each token, and its NEAR beyond storage ` +
      `is up ${(Number(gained) / 1e24).toFixed(5)} NEAR since deployment: its gas rewards`,
  );
});
