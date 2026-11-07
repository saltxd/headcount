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

import { Worker, parseNEAR } from "near-workspaces";
import type { NearAccount } from "near-workspaces";

import { listId, parseTrezuCsv, type Payment } from "../src/list-id.ts";
import {
  callKind,
  expectReject,
  quietSandboxLogs,
  tgas,
  transferKind,
  trezuPolicy,
  type FunctionCallKind,
  type ProposalKind,
  type ProposalView,
} from "./harness.ts";

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

interface RoundView {
  readonly round_id: string;
  readonly dao_id: string;
  readonly token_id: string;
  readonly payments: readonly { readonly recipient: string; readonly amount: string; readonly state: string }[];
  readonly total: string;
  readonly creator_id: string;
  readonly storage_deposit: string;
  readonly funded_at_sec: number | null;
  readonly verdict: PostedVerdict | null;
}

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

before(async () => {
  for (const wasm of Object.values(WASM)) {
    if (!existsSync(wasm)) throw new Error(`${wasm} is missing. Run npm test, whose pretest builds it.`);
  }
  quietSandboxLogs();
  worker = await Worker.init();
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

const configureKind = (): FunctionCallKind =>
  callKind(
    headcount.accountId,
    "configure",
    { dao_id: dao.accountId, screener_id: screener.accountId, verdict_window_sec: 2 * DAY, hold_window_sec: 2 * DAY },
    BigInt(parseNEAR("0.01")),
    30,
  );

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
