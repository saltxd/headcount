/**
 * The three Trezu custom proposal templates, filed in the sandbox the way Trezu files them.
 *
 *     npm test
 *
 * Trezu's hosted app needs a mainnet DAO, so this test replays what it would send instead: for each
 * template in templates/, the proposal (kind and description) that Trezu's own engine built from the
 * manifest and a member's form values (fixtures/trezu-template-proposals.json; ts/test/templates.test.ts
 * holds ts/src/templates.ts to the same bytes). The Requestor files each one on the real Sputnik DAO
 * v3.2 with Trezu's roles, two Approvers pass it, and the test checks what the call did:
 *   1. "Name the screener"         configure: the DAO names its screener and windows
 *   2. "Fund a screened round"     the token's ft_transfer_call: the round is funded with its total
 *   3. "Decide a held group"       resolve_group: one account released, the other's share returned
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

import { parseTrezuCsv } from "../src/list-id.ts";
import type { FieldValues, TemplateProposal } from "../src/templates.ts";
import { jsonRpc } from "../screener/rpc.ts";
import { quietSandboxLogs, tgas, trezuPolicy, type ProposalView } from "./harness.ts";
import { startSandbox } from "./sandbox.ts";
import { createNamedAccounts, near, type NamedSpec } from "./world.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "out");
const FIXTURES = join(ROOT, "fixtures");
const WASM = {
  sputnik: join(OUT, "sputnikdao2.wasm"),
  token: join(OUT, "test_token.wasm"),
  headcount: join(OUT, "headcount.wasm"),
};

/** Gas for one vote: the vote, the DAO's call and Sputnik's callback. */
const VOTE_GAS = tgas(250);
const DECIMALS = 6;
/** Trezu's list timestamp of the sandbox round in fixtures/trezu-list-ids.json. */
const ROUND_TIMESTAMP = 1_794_009_600_000;

interface Vector {
  readonly template: string;
  readonly what: string;
  readonly values: FieldValues;
  readonly proposal: TemplateProposal;
}

const vectors = (
  JSON.parse(readFileSync(join(FIXTURES, "trezu-template-proposals.json"), "utf8")) as { readonly vectors: readonly Vector[] }
).vectors;

/** The vector the sandbox files for `template`: the one marked for this run. */
const filed = (template: string): Vector => {
  const vector = vectors.find((v) => v.template === template && v.what.startsWith("sandbox:"));
  if (!vector) throw new Error(`fixtures/trezu-template-proposals.json has no sandbox vector for ${template}`);
  return vector;
};

interface RoundView {
  readonly round_id: string;
  readonly total: string;
  readonly payments: readonly { readonly recipient: string; readonly amount: string; readonly state: string }[];
  readonly funded_at_sec: number | null;
  readonly groups: readonly { readonly group: number; readonly state: string; readonly released: string | null }[];
  readonly paid: string;
  readonly refunded: string;
}

let worker: Worker | undefined;
let dao: NearAccount;
let token: NearAccount;
let headcount: NearAccount;
let treasurer: NearAccount;
let approvers: [NearAccount, NearAccount];
let screener: NearAccount;
let alice: NearAccount;
let roundId = "";

const key = (): nearApi.KeyPair => nearApi.KeyPair.fromRandom("ed25519");

before(async () => {
  for (const wasm of Object.values(WASM)) {
    if (!existsSync(wasm)) throw new Error(`${wasm} is missing. Run npm test, whose pretest builds it.`);
  }
  quietSandboxLogs();
  worker = await startSandbox();
  const root = worker.rootAccount;
  const rpc = jsonRpc((worker.provider as unknown as { connection: { url: string } }).connection.url);
  const id = (name: string): string => `${name}.${root.accountId}`;
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
            requestors: [id("treasurer")],
            admins: [id("admin")],
            approvers: ["approver1", "approver2", "approver3", "approver4"].map(id),
            paymentThreshold: 2,
            governanceThreshold: 1,
          }),
        },
      },
    },
    { name: "token", balance: near("10"), keyPair: key(), contract: { wasm: readFileSync(WASM.token), init: "new", args: {} } },
    { name: "headcount", balance: near("10"), keyPair: key(), contract: { wasm: readFileSync(WASM.headcount), init: "new", args: {} } },
    ...["treasurer", "admin", "approver1", "approver2", "approver3", "approver4", "screener", "alice"].map(person),
  ]);
  const must = (name: string): NearAccount => {
    const account = accounts[name];
    if (!account) throw new Error(`${name} was not created`);
    return account;
  };
  [dao, token, headcount, treasurer, screener, alice] = ["dao", "token", "headcount", "treasurer", "screener", "alice"].map(must) as [
    NearAccount,
    NearAccount,
    NearAccount,
    NearAccount,
    NearAccount,
    NearAccount,
  ];
  approvers = [must("approver1"), must("approver2")];

  // The DAO holds the round's token; Headcount and the round's recipients are registered with it.
  const recipients = parseTrezuCsv(readFileSync(join(FIXTURES, "round-16.csv"), "utf8"), DECIMALS).map((p) => p.recipient);
  let tx = root.batch(token).functionCall("mint", { account_id: dao.accountId, amount: String(1_000_000n * 10n ** BigInt(DECIMALS)) }, { gas: tgas(10) });
  for (const accountId of [headcount.accountId, ...recipients]) {
    tx = tx.functionCall("storage_deposit", { account_id: accountId, registration_only: true }, { attachedDeposit: near("0.01"), gas: tgas(10) });
  }
  const result = await tx.transact();
  assert.ok(result.succeeded, `setting up the token failed: ${result.summary()}`);
});

after(async () => {
  await worker?.tearDown();
});

const getProposal = (id: number): Promise<ProposalView> => dao.view<ProposalView>("get_proposal", { id });
const getRound = (id: string): Promise<RoundView> => headcount.view<RoundView>("get_round", { round_id: id });
const balanceOf = async (accountId: string): Promise<bigint> => BigInt(await token.view<string>("ft_balance_of", { account_id: accountId }));

/**
 * The Requestor files the proposal a template built, exactly as Trezu would (its kind and its
 * description); two Approvers pass it. Returns the proposal as Sputnik stored it.
 */
const fileAndPass = async (proposal: TemplateProposal): Promise<{ id: number; stored: ProposalView }> => {
  const id = await treasurer.call<number>(dao, "add_proposal", { proposal });
  await approvers[0].call(dao, "act_proposal", { id, action: "VoteApprove", proposal: proposal.kind }, { gas: VOTE_GAS });
  const pending = await getProposal(id);
  assert.equal(pending.status, "InProgress", "one Approver is not enough");
  await approvers[1].call(dao, "act_proposal", { id, action: "VoteApprove", proposal: proposal.kind }, { gas: VOTE_GAS });
  const stored = await getProposal(id);
  assert.deepEqual(stored.kind, proposal.kind, "Sputnik stored the template's call unchanged");
  assert.equal(stored.description, proposal.description);
  return { id, stored };
};

test('template "Name the screener": the vote Trezu files names the DAO\'s screener', async () => {
  const vector = filed("headcount-name-screener");
  assert.equal(await headcount.view("get_config", { dao_id: dao.accountId }), null);
  const { id, stored } = await fileAndPass(vector.proposal);
  assert.equal(stored.status, "Approved");
  assert.match(stored.description, /\[trezu-tmpl:headcount-name-screener\]/, "the tag Trezu reads to show which template filed it");
  assert.deepEqual(await headcount.view("get_config", { dao_id: dao.accountId }), {
    screener_id: screener.accountId,
    verdict_window_sec: vector.values["verdict_window_sec"],
    hold_window_sec: vector.values["hold_window_sec"],
    tokens: [token.accountId],
  });
  console.log(`  TEMPLATE "Name the screener" (proposal ${id}, Approved): ${dao.accountId} names ${screener.accountId}, 2-day windows`);
});

test('template "Fund a screened round (USDC)": the vote Trezu files funds the round with its exact total', async () => {
  const vector = filed("headcount-fund-round-usdc");
  const payments = parseTrezuCsv(readFileSync(join(FIXTURES, "round-16.csv"), "utf8"), DECIMALS);
  roundId = await treasurer.call<string>(
    headcount,
    "create_round",
    { dao_id: dao.accountId, token_id: token.accountId, payments, timestamp: ROUND_TIMESTAMP },
    { attachedDeposit: near("0.1"), gas: tgas(100) },
  );
  assert.equal(roundId, vector.values["round_id"], "the round the template's form names");
  const groups = [
    { accounts: ["r01.test.near", "r02.test.near"], signals: ["same-funder"], evidence: ["written by hand for the sandbox"] },
  ];
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

  const total = BigInt((await getRound(roundId)).total);
  assert.equal(String(total), vector.values["amount"], "the amount the form names is the round's total");
  const daoBefore = await balanceOf(dao.accountId);
  const { id, stored } = await fileAndPass(vector.proposal);
  assert.equal(stored.status, "Approved");
  assert.ok((await getRound(roundId)).funded_at_sec, "the round is funded");
  assert.equal(daoBefore - (await balanceOf(dao.accountId)), total);
  assert.equal(await balanceOf(headcount.accountId), total);

  const result = await alice.callRaw(headcount, "payout_batch", { round_id: roundId, limit: 100 }, { gas: tgas(300) });
  assert.ok(result.succeeded, result.receiptFailureMessages.join("; "));
  const paid = (await getRound(roundId)).payments.filter((p) => p.state === "Paid").length;
  assert.equal(paid, 14, "the 14 cleared recipients are paid; r01 and r02 are held");
  console.log(
    `  TEMPLATE "Fund a screened round (USDC)" (proposal ${id}, Approved): ${token.accountId}.ft_transfer_call moved ` +
      `${total}, the round's total, to Headcount; anyone then paid the 14 cleared recipients`,
  );
});

test('template "Decide a held group": the vote Trezu files releases r01 and sends r02\'s share back', async () => {
  const vector = filed("headcount-resolve-group");
  const before = await getRound(roundId);
  const share = (r: string): bigint => BigInt(before.payments.find((p) => p.recipient === r)!.amount);
  const daoBefore = await balanceOf(dao.accountId);

  const { id, stored } = await fileAndPass(vector.proposal);
  assert.equal(stored.status, "Approved");
  const decided = await getRound(roundId);
  assert.deepEqual(decided.groups.map((g) => [g.group, g.state, g.released]), [[1, "ReleasedOne", "r01.test.near"]]);
  assert.equal((await balanceOf(dao.accountId)) - daoBefore, share("r02.test.near"), "r02's share is back with the DAO, exactly");

  const result = await alice.callRaw(headcount, "payout_batch", { round_id: roundId, limit: 100 }, { gas: tgas(100) });
  assert.ok(result.succeeded, result.receiptFailureMessages.join("; "));
  assert.equal(await balanceOf("r01.test.near"), share("r01.test.near"), "r01 is paid its amount");
  const settled = await getRound(roundId);
  assert.ok(settled.payments.every((p) => p.state === "Paid" || p.state === "Refunded"));
  assert.equal(BigInt(settled.paid) + BigInt(settled.refunded), BigInt(settled.total));
  console.log(
    `  TEMPLATE "Decide a held group" (proposal ${id}, Approved): group 1 ReleaseOne r01; r01 paid ` +
      `${share("r01.test.near")}, r02's ${share("r02.test.near")} back to the DAO; the round is settled`,
  );
});
