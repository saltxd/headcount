/**
 * The least gas that succeeds, on the largest rounds the contract's bounds allow: no payment is ever
 * left in flight.
 *
 *     npm test
 *
 * `payout_batch`, `resolve_group` and `refund_expired` each schedule one callback (`on_payouts`,
 * `on_refund`) that records how their transfers went. A callback gets a fixed amount of gas plus
 * whatever its caller leaves unused, so a caller who attaches the least gas that succeeds leaves it
 * little more than the fixed amount. If that is not enough, the callback fails after the money has
 * moved, and its payments stay `Paying` or `Refunding` for good: nothing on chain can tell
 * afterwards whether those transfers arrived.
 *
 * So this file builds the worst case the bounds allow, twice: a round paid in NEAR and a round paid
 * in a token whose id is 64 characters. No DAO contract is needed (any account can configure itself
 * as a DAO). Each round lists 100 recipients whose ids are 64 characters, the longest NEAR allows;
 * 98 of them are held in 49 linked pairs; and its verdict is at every bound, each pair citing
 * 5 signals of 32 characters and 32 pieces of evidence of 128, about 220 KB. Then, each time with
 * the least whole TGas that succeeds (found by raising the gas 1 TGas at a time), an outsider pays
 * the 2 cleared recipients, the DAO releases one account of the first pair and returns the other's
 * share, the outsider pays the released account, and after the hold window sends the other 48 pairs
 * back to the DAO. Every payment must end `Paid` or `Refunded`, to the unit.
 *
 * Nothing here touches a network: the sandbox is a local neard with throwaway accounts.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import nearApi from "near-api-js";
import type { NearAccount, TransactionResult, Worker } from "near-workspaces";

import { jsonRpc } from "../screener/rpc.ts";
import { quietSandboxLogs, tgas } from "./harness.ts";
import { startSandbox } from "./sandbox.ts";
import { createNamedAccounts, near } from "./world.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WASM = { headcount: join(ROOT, "out", "headcount.wasm"), token: join(ROOT, "out", "test_token.wasm") };

/** The longest account id NEAR allows. */
const ID_LEN = 64;
const SUFFIX = ".test.near";
/** The shortest window Headcount allows, so the hold window can be passed in seconds. */
const WINDOW_SEC = 60;
/** Every payment's amount, in the round's smallest unit: amounts do not change what a call costs. */
const AMOUNT = 1_000_000n;
const HELD_PAIRS = 49;
const RECIPIENTS = 2 + 2 * HELD_PAIRS;

/** The bounds `post_verdict` enforces (crates/headcount/src/lib.rs, MAX_*). */
const BOUNDS = { rule: 64, url: 256, signals: 5, signal: 32, evidence: 32, evidenceLen: 128 } as const;

/** A 64-character sub-account of the sandbox root, made of `prefix` and padding. */
const longId = (prefix: string): string => `${prefix.padEnd(ID_LEN - SUFFIX.length, "x")}${SUFFIX}`;
const nameOf = (id: string): string => id.slice(0, -SUFFIX.length);
const CLEARED = ["c0", "c1"].map(longId);
/** Held in pairs: [h00, h01], [h02, h03], ... Only h00 exists, the account the DAO releases. */
const HELD = Array.from({ length: 2 * HELD_PAIRS }, (_, i) => longId(`h${String(i).padStart(2, "0")}`));
const RELEASED = HELD[0]!;
const RETURNED_BY_VOTE = HELD[1]!;
const TOKEN_ID = longId("token");

let worker: Worker | undefined;
let dao: NearAccount;
let headcount: NearAccount;
let token: NearAccount;
let screener: NearAccount;
let alice: NearAccount;

interface Round {
  /** "NEAR" or "token", for the story lines. */
  readonly label: string;
  readonly tokenId: string;
  id: string;
}
const ROUNDS: readonly Round[] = [
  { label: "NEAR", tokenId: "native", id: "" },
  { label: "token", tokenId: TOKEN_ID, id: "" },
];

interface RoundView {
  readonly payments: readonly { readonly recipient: string; readonly state: string }[];
  readonly funded_at_sec: number | null;
  readonly paid: string;
  readonly refunded: string;
  readonly hold_deadline_sec: number | null;
}

before(async () => {
  for (const wasm of Object.values(WASM)) {
    if (!existsSync(wasm)) throw new Error(`${wasm} is missing. Run npm test, whose pretest builds it.`);
  }
  quietSandboxLogs();
  worker = await startSandbox();
  const rpc = jsonRpc((worker.provider as unknown as { connection: { url: string } }).connection.url);
  const key = (): nearApi.KeyPair => nearApi.KeyPair.fromRandom("ed25519");
  const accounts = await createNamedAccounts(rpc, worker.rootAccount, [
    { name: "headcount", balance: near("10"), keyPair: key(), contract: { wasm: readFileSync(WASM.headcount), init: "new", args: {} } },
    { name: nameOf(TOKEN_ID), balance: near("10"), keyPair: key(), contract: { wasm: readFileSync(WASM.token), init: "new", args: {} } },
    { name: "dao", balance: near("10"), keyPair: key() },
    { name: "screener", balance: near("20"), keyPair: key() },
    { name: "alice", balance: near("10"), keyPair: key() },
    ...[...CLEARED, RELEASED].map((id) => ({ name: nameOf(id), balance: near("1"), keyPair: key() })),
  ]);
  const must = (name: string): NearAccount => {
    const account = accounts[name];
    if (!account) throw new Error(`${name} was not created`);
    return account;
  };
  [headcount, token, dao, screener, alice] = ["headcount", nameOf(TOKEN_ID), "dao", "screener", "alice"].map(must) as [
    NearAccount,
    NearAccount,
    NearAccount,
    NearAccount,
    NearAccount,
  ];
  const root = worker.rootAccount;
  await root.call(token, "mint", { account_id: dao.accountId, amount: String(AMOUNT * BigInt(RECIPIENTS)) });
  // Every account a token round pays must hold a balance record on the token, as any NEP-141 receiver must.
  let register = root.batch(token);
  for (const accountId of [headcount.accountId, ...CLEARED, RELEASED]) {
    register = register.functionCall("storage_deposit", { account_id: accountId }, { attachedDeposit: near("0.01"), gas: tgas(10) });
  }
  assert.ok((await register.transact()).succeeded, "registered with the token");
});

after(async () => {
  await worker?.tearDown();
});

/** The verdict at every bound: 49 pairs, each with 5 signals of 32 characters and 32 pieces of evidence of 128. */
const largestVerdict = () => ({
  screened_at_block: 1,
  rule: "hold-linked-v1".padEnd(BOUNDS.rule, "-"),
  groups: Array.from({ length: HELD_PAIRS }, (_, g) => ({
    accounts: [HELD[2 * g]!, HELD[2 * g + 1]!],
    signals: Array.from({ length: BOUNDS.signals }, (_, k) => `signal-${g}-${k}`.padEnd(BOUNDS.signal, "s")),
    evidence: Array.from({ length: BOUNDS.evidence }, (_, k) => `evidence-${g}-${k}`.padEnd(BOUNDS.evidenceLen, "e")),
  })),
  report_sha256: "ab".repeat(32),
  report_url: "https://example.org/".padEnd(BOUNDS.url, "u"),
});

const getRound = (round: Round): Promise<RoundView> => headcount.view<RoundView>("get_round", { round_id: round.id });
const countIn = (view: RoundView, state: string): number => view.payments.filter((p) => p.state === state).length;
const stateOf = (view: RoundView, recipient: string): string | undefined => view.payments.find((p) => p.recipient === recipient)?.state;

/** What `who` holds of the round's money: NEAR (yoctoNEAR) or the token. */
const holding = async (round: Round, who: string): Promise<bigint> =>
  round.tokenId === "native"
    ? BigInt((await worker!.provider.viewAccount(who, { finality: "optimistic" })).amount)
    : BigInt(await token.view<string>("ft_balance_of", { account_id: who }));

/** The receipts of a transaction as `EXPERIMENTAL_tx_status` returns them (the fields read here). */
interface TxReceipts {
  readonly receipts?: readonly {
    readonly receipt_id: string;
    readonly receiver_id: string;
    readonly receipt: { readonly Action?: { readonly actions: readonly Record<string, { method_name?: string; gas?: number }>[] } };
  }[];
  readonly receipts_outcome: readonly {
    readonly id: string;
    readonly outcome: { readonly gas_burnt: number; readonly status: Record<string, unknown> };
  }[];
}

interface CallbackGas {
  /** The gas the callback was given, in TGas: its static gas plus what the caller left unused. */
  readonly given: number;
  readonly burnt: number;
  /** The callback's failure, as the chain recorded it; null if it succeeded. */
  readonly failure: string | null;
}

/** What Headcount's callback `method` in `result` was given and burnt, and whether it failed. */
const callbackOf = async (result: TransactionResult, method: string): Promise<CallbackGas> => {
  const rpc = worker!.provider as unknown as { sendJsonRpc<T>(method: string, params: object): Promise<T> };
  const tx = await rpc.sendJsonRpc<TxReceipts>("EXPERIMENTAL_tx_status", {
    tx_hash: result.result.transaction.hash,
    sender_account_id: result.result.transaction.signer_id,
    wait_until: "FINAL",
  });
  for (const r of tx.receipts ?? []) {
    const call = r.receipt.Action?.actions.map((a) => a["FunctionCall"]).find((f) => f?.method_name === method);
    if (r.receiver_id !== headcount.accountId || !call?.gas) continue;
    const outcome = tx.receipts_outcome.find((o) => o.id === r.receipt_id)?.outcome;
    assert.ok(outcome, `the outcome of ${method}`);
    const failure = "Failure" in outcome.status ? JSON.stringify(outcome.status["Failure"]) : null;
    return { given: call.gas / 1e12, burnt: outcome.gas_burnt / 1e12, failure };
  }
  throw new Error(`no ${method} receipt in ${result.result.transaction.hash}`);
};

/**
 * Has `caller` call `method` with the least whole TGas that succeeds, and returns that gas and the
 * call. A refused call changes nothing on chain, so only the last call moves money.
 *
 * The search starts low. When the contract refuses for want of gas, it says how much it keeps back
 * for itself, its callback and the next transfer; with the gas the refusal burnt (which also counts
 * the receipt's own fees, so it errs high), that puts the least gas within a few TGas, and the
 * search jumps to 6 TGas below that before going up 1 TGas at a time. It asserts that the call
 * 1 TGas below the one that succeeded was refused.
 */
const withLeastGas = async (
  caller: NearAccount,
  method: string,
  args: Record<string, unknown>,
): Promise<{ tgas: number; result: TransactionResult }> => {
  let g = 20;
  let lastRefused = -1;
  while (g <= 300) {
    const result = await caller.callRaw(headcount, method, args, { gas: tgas(g) });
    if (result.succeeded) {
      assert.equal(lastRefused, g - 1, `${method} succeeded at ${g} TGas, but ${g - 1} TGas was never tried: start lower`);
      return { tgas: g, result };
    }
    lastRefused = g;
    const message = JSON.stringify(result.failures);
    const keeps = /keeps (\d+) TGas for itself and the next payment needs (\d+) TGas more/.exec(message);
    const needs = /needs (\d+) TGas more than this call has left/.exec(message);
    const reserved = keeps ? Number(keeps[1]) + Number(keeps[2]) : needs ? Number(needs[1]) : null;
    if (reserved === null) {
      assert.match(message, /Exceeded the prepaid gas/, `${method} at ${g} TGas was refused for another reason: ${message}`);
      g += 1;
      continue;
    }
    const burnt = (result.result.receipts_outcome[0]?.outcome.gas_burnt ?? 0) / 1e12;
    g = Math.max(g + 1, Math.floor(burnt + reserved) - 6);
  }
  assert.fail(`${method} did not succeed with 300 TGas`);
};

/**
 * `method` with the least gas that succeeds, then its callback checked: it ran, and no payment of the
 * round is left Paying or Refunding. Returns a few words for the story line.
 */
const leastGasStep = async (round: Round, caller: NearAccount, method: string, args: Record<string, unknown>, callbackName: string) => {
  const { tgas: least, result } = await withLeastGas(caller, method, { round_id: round.id, ...args });
  const callback = await callbackOf(result, callbackName);
  const view = await getRound(round);
  const inFlight = countIn(view, "Paying") + countIn(view, "Refunding");
  assert.equal(
    inFlight,
    0,
    `${round.label} round: ${method} at its least gas (${least} TGas) left ${inFlight} payment(s) in flight: ` +
      `${callbackName} was given ${callback.given.toFixed(2)} TGas and failed: ${callback.failure}`,
  );
  assert.equal(callback.failure, null);
  return { least, callback, text: `${method} ${least} TGas (${callbackName} given ${callback.given.toFixed(1)}, burnt ${callback.burnt.toFixed(2)})` };
};

test("the largest rounds the bounds allow: 100 recipients with 64-character ids and a 220 KB verdict, in NEAR and in a token", async () => {
  await dao.call(
    headcount,
    "configure",
    {
      dao_id: dao.accountId,
      screener_id: screener.accountId,
      verdict_window_sec: WINDOW_SEC,
      hold_window_sec: WINDOW_SEC,
      tokens: [TOKEN_ID],
    },
    { attachedDeposit: near("0.01"), gas: tgas(30) },
  );
  const payments = [...CLEARED, ...HELD].map((recipient) => ({ recipient, amount: String(AMOUNT) }));
  assert.ok(payments.every((p) => p.recipient.length === ID_LEN) && TOKEN_ID.length === ID_LEN);
  const verdict = largestVerdict();
  const bytes = JSON.stringify(verdict).length;
  assert.ok(bytes > 210_000, `the verdict is at its bounds: ${bytes} bytes of JSON`);
  for (const round of ROUNDS) {
    round.id = await dao.call<string>(
      headcount,
      "create_round",
      { dao_id: dao.accountId, token_id: round.tokenId, payments, timestamp: 1_794_096_000_000 },
      { attachedDeposit: near("1"), gas: tgas(300) },
    );
    await screener.call(headcount, "post_verdict", { round_id: round.id, verdict }, { attachedDeposit: near("3"), gas: tgas(300) });
    const total = String(AMOUNT * BigInt(RECIPIENTS));
    if (round.tokenId === "native") {
      await dao.call(headcount, "fund_round", { round_id: round.id }, { attachedDeposit: BigInt(total), gas: tgas(30) });
    } else {
      await dao.call(token, "ft_transfer_call", { receiver_id: headcount.accountId, amount: total, msg: round.id }, { attachedDeposit: 1n, gas: tgas(100) });
    }
    const view = await getRound(round);
    assert.deepEqual([countIn(view, "Held"), countIn(view, "Pending")], [98, 2], `${round.label} round`);
    assert.ok(view.funded_at_sec, `${round.label} round funded`);
  }
  assert.equal(await holding(ROUNDS[1]!, headcount.accountId), AMOUNT * BigInt(RECIPIENTS), "Headcount holds the token round's total");
  console.log(
    `  LARGEST ROUNDS: in NEAR and in a token with a 64-character id, each 100 recipients with 64-character ids, ` +
      `98 held in 49 pairs, and a verdict of ${Math.round(bytes / 1000)} KB (every group at the bounds: 5 signals of ` +
      "32 characters, 32 pieces of evidence of 128); both funded",
  );
});

test("payout_batch with the least gas that succeeds: on_payouts still records every transfer, nothing is left Paying", async () => {
  for (const round of ROUNDS) {
    const before = new Map<string, bigint>();
    for (const r of CLEARED) before.set(r, await holding(round, r));
    const steps: string[] = [];
    for (let batch = 0; batch < CLEARED.length && countIn(await getRound(round), "Pending") > 0; batch += 1) {
      steps.push((await leastGasStep(round, alice, "payout_batch", { limit: 100 }, "on_payouts")).text);
    }
    const view = await getRound(round);
    assert.deepEqual([countIn(view, "Paid"), countIn(view, "Held")], [2, 98], `${round.label} round`);
    for (const r of CLEARED) assert.equal((await holding(round, r)) - before.get(r)!, AMOUNT, `${r} got exactly its amount`);
    console.log(`  PAID, ${round.label} round, at the least gas that succeeds: ${steps.join("; ")}. Both cleared recipients got exactly their amounts`);
  }
});

test("resolve_group with the least gas that succeeds: the DAO releases one account and returns the other's share; on_refund records it", async () => {
  for (const round of ROUNDS) {
    const daoBefore = await holding(round, dao.accountId);
    const decided = await leastGasStep(
      round,
      dao,
      "resolve_group",
      { group: 1, decision: { ReleaseOne: { account_id: RELEASED } } },
      "on_refund",
    );
    const view = await getRound(round);
    assert.deepEqual([stateOf(view, RETURNED_BY_VOTE), view.refunded], ["Refunded", String(AMOUNT)]);
    // The DAO signed this call, so its NEAR also paid the gas; its token balance moved by the share alone.
    if (round.tokenId !== "native") assert.equal((await holding(round, dao.accountId)) - daoBefore, AMOUNT, "the DAO got exactly the share back");
    const releasedBefore = await holding(round, RELEASED);
    const paid = await leastGasStep(round, alice, "payout_batch", { limit: 100 }, "on_payouts");
    assert.equal(stateOf(await getRound(round), RELEASED), "Paid");
    assert.equal((await holding(round, RELEASED)) - releasedBefore, AMOUNT, "the released account got exactly its amount");
    console.log(`  DECIDED, ${round.label} round, at the least gas that succeeds: ${decided.text}; then ${paid.text}`);
  }
});

test("refund_expired with the least gas that succeeds: on_refund still records the transfer, nothing is left Refunding", async () => {
  const deadline = Math.max(...(await Promise.all(ROUNDS.map(async (r) => (await getRound(r)).hold_deadline_sec ?? Infinity))));
  assert.ok(Number.isFinite(deadline), "both rounds are funded and screened");
  const rpc = worker!.provider as unknown as { sendJsonRpc<T>(method: string, params: object): Promise<T> };
  const chainNow = async (): Promise<number> => {
    const block = await rpc.sendJsonRpc<{ header: { timestamp_nanosec: string } }>("block", { finality: "optimistic" });
    return Number(BigInt(block.header.timestamp_nanosec) / 1_000_000_000n);
  };
  for (let i = 0; i < 10 && (await chainNow()) <= deadline + 1; i += 1) {
    await worker!.provider.fastForward(Math.max(5, deadline + 2 - (await chainNow())));
  }
  assert.ok((await chainNow()) > deadline + 1, "the sandbox clock is past the hold window");

  for (const round of ROUNDS) {
    const daoBefore = await holding(round, dao.accountId);
    const step = await leastGasStep(round, alice, "refund_expired", {}, "on_refund");
    const view = await getRound(round);
    assert.deepEqual([countIn(view, "Paid"), countIn(view, "Refunded")], [3, 97], `${round.label} round is settled`);
    assert.deepEqual([view.paid, view.refunded], [String(3n * AMOUNT), String(97n * AMOUNT)]);
    assert.equal((await holding(round, dao.accountId)) - daoBefore, 96n * AMOUNT, "the DAO got exactly the 96 expired shares back");
    console.log(
      `  RETURNED, ${round.label} round, at the least gas that succeeds: ${step.text}: the 96 expired shares went back ` +
        "to the DAO in one transfer, to the unit. Settled: 3 Paid, 97 Refunded",
    );
  }
});
