/**
 * Day 0: the real Sputnik DAO contract in a local near-workspaces sandbox, with the roles Trezu
 * gives every treasury it creates.
 *
 *     npm test
 *
 * The DAO is Sputnik DAO v3.2, the exact bytes the `sputnik-dao.near` factory deploys today
 * (scripts/fetch-sputnik.mjs; the first test checks the code hash). The token is the NEP-141 test
 * token from the commit the factory names for v3.2, near-daos/sputnik-dao-contract 2b0f34a3
 * (crates/test-token).
 *
 * Headcount rests on one Sputnik feature: the FunctionCall proposal. A council votes once and the
 * DAO itself makes the call, so a Headcount round can only ever hold what a vote sent it. These
 * tests prove that path end to end before any Headcount code exists, and pin the two Sputnik
 * behaviours the design depends on:
 *   - a vote must carry the stored proposal kind back (`act_proposal`'s `proposal` argument);
 *   - the vote that reaches the threshold executes the call in the same transaction.
 *
 * Nothing here touches a network: the sandbox is a local neard with throwaway accounts.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseNEAR } from "near-workspaces";
import type { NearAccount, Worker } from "near-workspaces";

import {
  expectReject,
  ftTransferKind,
  quietSandboxLogs,
  tgas,
  trezuPolicy,
  type FunctionCallKind,
  type ProposalView,
} from "./harness.ts";
import { startSandbox } from "./sandbox.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", "out");
const SPUTNIK_WASM = join(OUT, "sputnikdao2.wasm");
const TOKEN_WASM = join(OUT, "test_token.wasm");

/** Gas for one vote: the vote itself, the DAO's call (20 TGas) and Sputnik's 10 TGas callback. */
const VOTE_GAS = tgas(150);

let worker: Worker | undefined;
let dao: NearAccount;
let token: NearAccount;
let treasurer: NearAccount;
let admin: NearAccount;
let approvers: NearAccount[];
let alice: NearAccount;

before(async () => {
  for (const wasm of [SPUTNIK_WASM, TOKEN_WASM]) {
    if (!existsSync(wasm)) {
      throw new Error(`${wasm} is missing. Run npm test, whose pretest builds it (or npm run build).`);
    }
  }
  quietSandboxLogs();
  worker = await startSandbox();
  const root = worker.rootAccount;

  treasurer = await root.createSubAccount("treasurer");
  admin = await root.createSubAccount("admin");
  // Four approvers, any two of whom approve a payment. With three, Sputnik's default 1/2 ratio
  // also comes to two votes, so a policy whose `call` threshold silently fell back to the default
  // would pass unnoticed; with four, the default needs three and the first test catches it.
  approvers = [
    await root.createSubAccount("approver1"),
    await root.createSubAccount("approver2"),
    await root.createSubAccount("approver3"),
    await root.createSubAccount("approver4"),
  ];
  alice = await root.createSubAccount("alice");

  dao = await root.createSubAccount("dao", { initialBalance: BigInt(parseNEAR("30")) });
  await dao.deploy(SPUTNIK_WASM);
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
  await token.deploy(TOKEN_WASM);
  await root.call(token, "new", {});
  await root.call(token, "mint", { account_id: dao.accountId, amount: "1000" });
  await alice.call(
    token,
    "storage_deposit",
    { account_id: alice.accountId },
    { attachedDeposit: BigInt(parseNEAR("0.01")) },
  );

  console.log(
    `  DAO ${dao.accountId}: Sputnik ${await dao.view<string>("version")} with Trezu roles ` +
      `Requestor (${treasurer.accountId}), Admin (${admin.accountId}), Approver (4 accounts, any 2 approve a payment)`,
  );
});

after(async () => {
  await worker?.tearDown();
});

/** `sputnik-dao.near`'s recorded default code hash (v3.2): `get_default_code_hash` on mainnet. */
const FACTORY_V3_2_CODE_HASH = "DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF";

test("the sandbox DAO runs the exact bytes the mainnet factory deploys for v3.2", async () => {
  const { code_hash } = (await dao.accountView()) as { code_hash: string };
  assert.equal(code_hash, FACTORY_V3_2_CODE_HASH);
  console.log(`  DAO code hash ${code_hash} equals the factory's v3.2 hash`);
});

const getProposal = (id: number): Promise<ProposalView> => dao.view<ProposalView>("get_proposal", { id });

const balanceOf = async (account: NearAccount): Promise<bigint> =>
  BigInt(await token.view<string>("ft_balance_of", { account_id: account.accountId }));

/** The Requestor files a FunctionCall proposal. Trezu's bond is zero, so nothing is attached. */
const file = (kind: FunctionCallKind, description: string): Promise<number> =>
  treasurer.call<number>(dao, "add_proposal", { proposal: { description, kind } });

/** A vote, carrying the stored proposal kind back as `act_proposal` requires. */
const approve = (voter: NearAccount, id: number, kind: FunctionCallKind): Promise<unknown> =>
  voter.call(dao, "act_proposal", { id, action: "VoteApprove", proposal: kind }, { gas: VOTE_GAS });

test("a FunctionCall proposal passes add_proposal, then act_proposal with the proposal argument", async () => {
  const [first, second] = approvers as [NearAccount, NearAccount];
  const kind = ftTransferKind(token.accountId, alice.accountId, "25");
  const aliceBefore = await balanceOf(alice);
  const daoBefore = await balanceOf(dao);

  const id = await file(kind, "Pay alice 25 for the October campaign");
  const filed = await getProposal(id);
  assert.equal(filed.status, "InProgress");
  assert.equal(filed.proposer, treasurer.accountId);
  console.log(`  FILED proposal ${id} by the Requestor: FunctionCall ${token.accountId}.ft_transfer(alice, 25)`);

  await approve(first, id, kind);
  assert.equal((await getProposal(id)).status, "InProgress", "one approval is not enough: Trezu's threshold is 2");
  assert.equal(await balanceOf(alice), aliceBefore, "nothing moves before the threshold");
  console.log(`  VOTE 1 of 2 (${first.accountId}): still InProgress, nothing moved`);

  await approve(second, id, kind);
  assert.equal((await getProposal(id)).status, "Approved");
  assert.equal((await balanceOf(alice)) - aliceBefore, 25n, "alice was paid by the DAO's call");
  assert.equal(daoBefore - (await balanceOf(dao)), 25n, "the 25 came out of the DAO's own balance");
  console.log(`  VOTE 2 of 2 (${second.accountId}): Approved, and the DAO's call ran in the same transaction (alice +25)`);
});

test("a vote that does not carry the stored proposal kind back is refused", async () => {
  const [first] = approvers as [NearAccount];
  const kind = ftTransferKind(token.accountId, alice.accountId, "5");
  const id = await file(kind, "Pay alice 5");

  const swapped = ftTransferKind(token.accountId, alice.accountId, "500");
  await expectReject(
    () => first.call(dao, "act_proposal", { id, action: "VoteApprove", proposal: swapped }, { gas: VOTE_GAS }),
    "ERR_WRONG_KIND",
  );
  await expectReject(
    () => first.call(dao, "act_proposal", { id, action: "VoteApprove" }, { gas: VOTE_GAS }),
    "missing field `proposal`",
  );

  const proposal = await getProposal(id);
  assert.equal(proposal.status, "InProgress");
  assert.deepEqual(proposal.votes, {}, "neither refused vote was counted");
  console.log("  REFUSED a vote naming 500 instead of 5 (ERR_WRONG_KIND), and a vote with no proposal argument");
});

test("Trezu roles: the Requestor cannot approve, and neither Approver nor Admin can file a payment", async () => {
  const [first] = approvers as [NearAccount];
  const kind = ftTransferKind(token.accountId, alice.accountId, "7");
  const id = await file(kind, "Pay alice 7");

  await expectReject(() => approve(treasurer, id, kind), "ERR_PERMISSION_DENIED");
  await expectReject(() => approve(admin, id, kind), "ERR_PERMISSION_DENIED");
  await expectReject(
    () => first.call(dao, "add_proposal", { proposal: { description: "Pay me", kind } }),
    "ERR_PERMISSION_DENIED",
  );
  await expectReject(
    () => admin.call(dao, "add_proposal", { proposal: { description: "Pay me", kind } }),
    "ERR_PERMISSION_DENIED",
  );

  assert.deepEqual((await getProposal(id)).votes, {}, "no refused vote was counted");
  console.log("  REFUSED: the Requestor's and the Admin's approvals, and an Approver's and an Admin's filings");
});
