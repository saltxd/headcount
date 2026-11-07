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
  trezuPolicy,
  type FunctionCallKind,
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
/** Gas for one vote: the vote itself, the DAO's call and Sputnik's callback. */
const VOTE_GAS = tgas(200);
/** The sandbox token stands in for a 6-decimal token such as USDC. */
const DECIMALS = 6;

interface DaoConfig {
  readonly screener_id: string;
  readonly verdict_window_sec: number;
  readonly hold_window_sec: number;
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
let headcount: NearAccount;
let treasurer: NearAccount;
let approvers: NearAccount[];
let screener: NearAccount;

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

  headcount = await root.createSubAccount("headcount", { initialBalance: BigInt(parseNEAR("10")) });
  await headcount.deploy(WASM.headcount);
  await root.call(headcount, "new", {});

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
const file = (kind: FunctionCallKind, description: string): Promise<number> =>
  treasurer.call<number>(dao, "add_proposal", { proposal: { description, kind } });

/** One Approver vote, carrying the stored kind back as Sputnik requires. */
const approve = (voter: NearAccount, id: number, kind: FunctionCallKind): Promise<unknown> =>
  voter.call(dao, "act_proposal", { id, action: "VoteApprove", proposal: kind }, { gas: VOTE_GAS });

/** Files a proposal and has two Approvers pass it; returns its id. */
const passVote = async (kind: FunctionCallKind, description: string): Promise<number> => {
  const [first, second] = approvers as [NearAccount, NearAccount];
  const id = await file(kind, description);
  await approve(first, id, kind);
  await approve(second, id, kind);
  return id;
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
