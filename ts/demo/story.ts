/**
 * The Headcount story, start to finish, in one local sandbox: what `npm run demo` prints and what
 * ts/sandbox/demo.test.ts runs inside `npm test`.
 *
 * Every step is checked as it runs (the vote's status, each balance to the unit, the screen against
 * the answer that was planted), so a mismatch stops the story with an error instead of printing a
 * line that is not true. The votes go through the three Trezu templates in templates/, filed the way
 * Trezu files them; the verdict comes from the real screener reading the sandbox chain.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import nearApi from "near-api-js";
import type { NearAccount } from "near-workspaces";

import { listId, parseTrezuCsv } from "../src/list-id.ts";
import { buildTemplateProposal, type FieldValues, type Manifest } from "../src/templates.ts";
import { scanChain } from "../screener/block-scan.ts";
import { writeScreenFiles } from "../screener/report.ts";
import { jsonRpc } from "../screener/rpc.ts";
import { DEFAULT_MIN_NEAR, DEFAULT_SERVICE_THRESHOLD, screenRound } from "../screener/screen.ts";
import { NEAR_ASSET, isImplicit } from "../screener/types.ts";
import { quietSandboxLogs, tgas, trezuPolicy, type ProposalView } from "../sandbox/harness.ts";
import { startSandbox } from "../sandbox/sandbox.ts";
import { createNamedAccounts, near, planWorld, seedWorld, type NamedSpec } from "../sandbox/world.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "out");
const WASM = {
  sputnik: join(OUT, "sputnikdao2.wasm"),
  token: join(OUT, "test_token.wasm"),
  headcount: join(OUT, "headcount.wasm"),
};

/** `sputnik-dao.near`'s recorded code hash for v3.2, as `get_default_code_hash` returns it on mainnet. */
const FACTORY_V3_2_CODE_HASH = "DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF";
/** The demo DAO's windows. A real DAO would pick days; ten minutes keeps the demo short. */
const WINDOW_SEC = 600;
/** The round's token stands in for USDC: 6 decimals. */
const DECIMALS = 6;
/** Trezu's list timestamp for the round: 2026-11-09 00:00 UTC, in milliseconds. */
const ROUND_TIMESTAMP = 1_794_182_400_000;
const VOTE_GAS = tgas(250);

/** What the story ended with, for the test that runs it. */
export interface DemoResult {
  readonly roundId: string;
  readonly groups: number;
  readonly held: number;
  readonly cleared: number;
  readonly paidAccounts: number;
  readonly returnedAccounts: number;
  readonly total: bigint;
  readonly paid: bigint;
  readonly returned: bigint;
  readonly seconds: number;
}

interface RoundView {
  readonly total: string;
  readonly payments: readonly { readonly recipient: string; readonly amount: string; readonly state: string }[];
  readonly groups: readonly { readonly group: number; readonly accounts: readonly string[]; readonly state: string }[];
  readonly funded_at_sec: number | null;
  readonly hold_deadline_sec: number | null;
  readonly paid: string;
  readonly refunded: string;
}

/** An amount of the 6-decimal token, as text: 113775001 is "113.775001". */
const tokens = (units: bigint): string => {
  const whole = units / 10n ** BigInt(DECIMALS);
  const fraction = (units % 10n ** BigInt(DECIMALS)).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
};

/** An account as the story names it: implicit accounts by their first 8 characters. */
const short = (id: string): string => (isImplicit(id) ? `${id.slice(0, 8)}...` : id);
const list = (ids: readonly string[]): string => {
  const names = ids.map(short);
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};

const SIGNAL_WORDS: Readonly<Record<string, string>> = {
  "same-funder": "created by the same account",
  "shared-key": "share a full-access key",
  "direct-transfer": "one sent the other funds",
  "shared-collector": "sent funds to the same account",
};

const loadTemplate = (id: string): Manifest =>
  JSON.parse(readFileSync(join(ROOT, "templates", `${id}.json`), "utf8")) as Manifest;

/**
 * Runs the story in a fresh sandbox, narrating through `say`, and returns how it ended. Throws if any
 * step does not do what the story says it does.
 */
export const runDemo = async (say: (line?: string) => void): Promise<DemoResult> => {
  const started = Date.now();
  const step = (n: number, title: string): void => {
    say();
    say(`${n}. ${title}`);
  };
  const line = (text: string): void => say(`   ${text}`);

  quietSandboxLogs();
  const worker = await startSandbox();
  try {
    const root = worker.rootAccount;
    const rpc = jsonRpc((worker.provider as unknown as { connection: { url: string } }).connection.url);
    const id = (name: string): string => `${name}.${root.accountId}`;
    const key = (): nearApi.KeyPair => nearApi.KeyPair.fromRandom("ed25519");

    // --- 1. The treasury ---------------------------------------------------------------------
    const approverNames = ["approver1", "approver2", "approver3", "approver4"];
    const person = (name: string): NamedSpec => ({ name, balance: near("5"), keyPair: key() });
    const plan = planWorld();
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
              approvers: approverNames.map(id),
              paymentThreshold: 2,
              governanceThreshold: 1,
            }),
          },
        },
      },
      { name: "token", balance: near("10"), keyPair: key(), contract: { wasm: readFileSync(WASM.token), init: "new", args: {} } },
      { name: "headcount", balance: near("10"), keyPair: key(), contract: { wasm: readFileSync(WASM.headcount), init: "new", args: {} } },
      ...["treasurer", "admin", ...approverNames, "screener", "alice"].map(person),
      ...plan.named,
    ]);
    const must = (name: string): NearAccount => {
      const account = accounts[name];
      if (!account) throw new Error(`${name} was not created`);
      return account;
    };
    const [dao, token, headcount, treasurer, screener, alice] = ["dao", "token", "headcount", "treasurer", "screener", "alice"].map(
      must,
    ) as [NearAccount, NearAccount, NearAccount, NearAccount, NearAccount, NearAccount];
    const approvers = [must("approver1"), must("approver2")] as const;
    const setup = await root
      .batch(token)
      .functionCall("mint", { account_id: dao.accountId, amount: String(1_000_000n * 10n ** BigInt(DECIMALS)) }, { gas: tgas(10) })
      .functionCall("storage_deposit", { account_id: headcount.accountId, registration_only: true }, { attachedDeposit: near("0.01"), gas: tgas(10) })
      .transact();
    assert.ok(setup.succeeded, `setting up the token failed: ${setup.summary()}`);
    const { code_hash: codeHash } = (await dao.accountView()) as { code_hash: string };
    assert.equal(codeHash, FACTORY_V3_2_CODE_HASH);

    step(1, "A treasury, set up the way Trezu sets one up");
    line(`${dao.accountId} runs Sputnik DAO v3.2, the exact code NEAR's mainnet DAO factory deploys`);
    line(`(code hash ${codeHash.slice(0, 8)}..., the factory's own). It has the three roles Trezu gives a treasury:`);
    const role = (name: string, who: string, does: string): void => line(`  ${name.padEnd(10)} ${who.padEnd(36)} ${does}`);
    role("Requestor", treasurer.accountId, "files payment proposals");
    role("Approver", `${id("approver1")} to approver4`, "any 2 of the 4 pass a payment");
    role("Admin", id("admin"), "changes the rules");
    line(`Headcount is a separate contract, ${headcount.accountId}. It holds no role in the DAO.`);
    line(`The DAO holds 1,000,000 of ${token.accountId}, a token with 6 decimals standing in for USDC.`);

    const getProposal = (n: number): Promise<ProposalView> => dao.view<ProposalView>("get_proposal", { id: n });
    const getRound = (roundId: string): Promise<RoundView> => headcount.view<RoundView>("get_round", { round_id: roundId });
    const balanceOf = async (accountId: string): Promise<bigint> =>
      BigInt(await token.view<string>("ft_balance_of", { account_id: accountId }));
    /** The Requestor files what a Trezu template builds; two Approvers pass it. Returns its id. */
    const fileTemplate = async (template: string, values: FieldValues, afterFirstVote?: () => Promise<void>): Promise<number> => {
      const proposal = buildTemplateProposal(loadTemplate(template), values);
      const n = await treasurer.call<number>(dao, "add_proposal", { proposal });
      await approvers[0].call(dao, "act_proposal", { id: n, action: "VoteApprove", proposal: proposal.kind }, { gas: VOTE_GAS });
      assert.equal((await getProposal(n)).status, "InProgress");
      await afterFirstVote?.();
      await approvers[1].call(dao, "act_proposal", { id: n, action: "VoteApprove", proposal: proposal.kind }, { gas: VOTE_GAS });
      assert.equal((await getProposal(n)).status, "Approved");
      return n;
    };

    // --- 2. The DAO names its screener -------------------------------------------------------
    step(2, "The DAO names its screener, by vote");
    line("Why: only an account the DAO itself picked may say which recipients are linked.");
    line(`The Requestor fills Trezu's "Name the screener" template, which files one proposal:`);
    line(`  ${headcount.accountId} configure: screener ${screener.accountId}, verdict and hold windows ${WINDOW_SEC / 60} minutes`);
    const configured = await fileTemplate(
      "headcount-name-screener",
      { dao_id: dao.accountId, screener_id: screener.accountId, verdict_window_sec: WINDOW_SEC, hold_window_sec: WINDOW_SEC },
      async () => {
        assert.equal(await headcount.view("get_config", { dao_id: dao.accountId }), null);
        line("Approver 1 votes yes: the proposal is still in progress, and nothing has changed.");
      },
    );
    assert.equal((await headcount.view<{ screener_id: string }>("get_config", { dao_id: dao.accountId })).screener_id, screener.accountId);
    line(`Approver 2 votes yes: proposal ${configured} is approved, and the DAO's call ran in that same transaction.`);
    line(`From now on, only ${screener.accountId} can post a verdict on this DAO's rounds.`);

    // --- 3. The world ------------------------------------------------------------------------
    const world = await seedWorld(rpc, plan, { root, daoId: dao.accountId, tokenId: token.accountId });
    const farm = (name: string) => world.farms.find((f) => f.name === name)!;
    step(3, "What the chain already records");
    line("Sixteen accounts took part in a campaign. Before anyone asks for money, NEAR already records");
    line("how each account came to exist, which keys control it and where it sent funds. Planted here,");
    line("and not told to the screener:");
    line(`  farm A  ${short(farm("A").via!)} funded 5 brand-new implicit accounts`);
    line(`  farm B  ${list(farm("B").accounts)} were created with one shared key;`);
    line("          omar later swapped it for a key of its own");
    line(`  farm C  ${list(farm("C").accounts)}: one sent the other 1 NEAR`);
    line(`  farm D  ${list(farm("D").accounts)} both sent tokens to ${short(farm("D").via!)}`);
    line(`  and 4 independent accounts that only look linked: 2 of the ${world.sponsorFunded} accounts ${world.sponsor}`);
    line(`  funded, which all hold one wallet recovery key and deposit at ${world.exchange}; and uma and vik,`);
    line("  who use that exchange too, both donated to the DAO, and one tipped the other 0.001 NEAR.");

    // --- 4. The round ------------------------------------------------------------------------
    const payments = parseTrezuCsv(world.csv, DECIMALS);
    const roundId = await treasurer.call<string>(
      headcount,
      "create_round",
      { dao_id: dao.accountId, token_id: token.accountId, payments, timestamp: ROUND_TIMESTAMP },
      { attachedDeposit: near("0.1"), gas: tgas(100) },
    );
    assert.equal(roundId, listId({ submitter: dao.accountId, tokenId: token.accountId, payments, timestamp: ROUND_TIMESTAMP }));
    const total = BigInt((await getRound(roundId)).total);
    step(4, "The Requestor turns the payout list into a round");
    line(`The list is the CSV Trezu's bulk payments take: ${payments.length} lines of "account, amount".`);
    line(`create_round returns ${roundId.slice(0, 16)}...: Trezu's own list id for this list, with the DAO as`);
    line(`submitter, so the treasurer screens exactly the list they would hand Trezu. Total: ${tokens(total)} tokens.`);
    line("Nothing can be paid before the screen.");

    // --- 5. The screen -----------------------------------------------------------------------
    const scanStarted = Date.now();
    const reader = await scanChain(rpc, { registrars: [root.accountId] });
    const scanMs = Date.now() - scanStarted;
    const result = await screenRound(
      { roundId, daoId: dao.accountId, tokenId: token.accountId, headcountId: headcount.accountId, recipients: payments.map((p) => p.recipient) },
      reader,
      {
        serviceThreshold: DEFAULT_SERVICE_THRESHOLD,
        minTransfer: { [NEAR_ASSET]: DEFAULT_MIN_NEAR, [token.accountId]: 10n ** BigInt(DECIMALS - 2) },
        services: [{ id: root.accountId, why: "the sandbox's registrar: it creates every account under it, as near does on mainnet" }],
      },
    );
    assert.deepEqual(
      result.verdict.groups.map((g) => g.accounts),
      world.farms.map((f) => f.accounts),
      "the screen holds exactly the planted farms",
    );
    assert.deepEqual(result.screen.cleared, world.cleared, "and clears every independent account");
    const files = writeScreenFiles(join(OUT, "demo"), result);
    await screener.call(headcount, "post_verdict", { round_id: roundId, verdict: result.verdict }, { attachedDeposit: near("0.5"), gas: tgas(100) });
    const screened = await getRound(roundId);
    const held = screened.payments.filter((p) => p.state === "Held");
    assert.equal(held.length, 12);

    step(5, "The screener reads the chain and posts its verdict");
    line(`It reads every block of the sandbox (a sandbox has no indexer): blocks ${reader.stats.fromHeight} to ${reader.stats.toHeight},`);
    line(`${reader.stats.transactions} transactions, in ${scanMs} ms. For each recipient it asks who created and funded it,`);
    line("which keys control it and where it sent money, and links two recipients only through an account");
    line("that is not a service.");
    for (const [i, group] of result.verdict.groups.entries()) {
      const links = result.screen.groups[i]?.links ?? [];
      const words = links
        .map((l) => `${SIGNAL_WORDS[l.signal] ?? l.signal}${l.via ? `, ${l.via.startsWith("ed25519:") ? `${l.via.slice(0, 16)}...` : short(l.via)}` : ""}`)
        .join("; ");
      const n = group.evidence.length;
      const evidence = group.evidence[0]?.startsWith("key:") ? "the key itself" : `${n} transaction${n === 1 ? "" : "s"}`;
      line(`  HELD   group ${i + 1}: ${words} (evidence: ${evidence})`);
      line(`           ${list(group.accounts)}`);
    }
    line(`  CLEAR  ${list(result.screen.cleared)}`);
    line("  Seen, but not linked, because each runs through a service:");
    const services = [world.sponsor, world.recoveryKey, world.exchange, dao.accountId];
    for (const via of services) {
      const shape = result.screen.notLinked.find((n) => n.via === via);
      assert.ok(shape, `the screen reports the shape through ${via}`);
      const name = via.startsWith("ed25519:") ? `the key ${via.slice(0, 16)}...` : via;
      line(`    ${name}: ${shape.why}`);
    }
    line(`The full report is ${relative(ROOT, files.reportMd)}; the verdict carries the SHA-256 of report.json`);
    line(`(${result.verdict.report_sha256.slice(0, 16)}...). post_verdict: ${held.length} of ${payments.length} recipients held, ${result.screen.cleared.length} cleared.`);
    line("The contract would refuse a second verdict, a verdict from any other account, or one naming an");
    line("account that is not on the list.");

    // --- 6. Funding --------------------------------------------------------------------------
    step(6, "The council funds the round, by vote");
    const daoBeforeFunding = await balanceOf(dao.accountId);
    const funded = await fileTemplate("headcount-fund-round-usdc", { round_id: roundId, amount: String(total) });
    assert.ok((await getRound(roundId)).funded_at_sec);
    assert.equal(daoBeforeFunding - (await balanceOf(dao.accountId)), total);
    assert.equal(await balanceOf(headcount.accountId), total);
    line(`The Requestor fills Trezu's "Fund a screened round (USDC)" template: the token's ft_transfer_call to`);
    line("Headcount for the round's exact total, with the round id as its message, the same call Trezu's bulk");
    line(`payments file. Two approvals (proposal ${funded}). Headcount keeps the tokens only because the token, the`);
    line(`sender (the DAO) and the amount all match. It now holds ${tokens(total)} tokens, for this round only.`);

    // --- 7. Payouts --------------------------------------------------------------------------
    step(7, "Anyone pays the cleared recipients");
    const recipients = payments.map((p) => p.recipient);
    let register = root.batch(token);
    for (const accountId of recipients) {
      register = register.functionCall("storage_deposit", { account_id: accountId, registration_only: true }, { attachedDeposit: near("0.01"), gas: tgas(10) });
    }
    assert.ok((await register.transact()).succeeded, "registering the recipients with the token failed");
    const amountOf = (r: string): bigint => BigInt(payments.find((p) => p.recipient === r)!.amount);
    const before = new Map<string, bigint>();
    for (const r of recipients) before.set(r, await balanceOf(r));
    const received = async (r: string): Promise<bigint> => (await balanceOf(r)) - (before.get(r) ?? 0n);
    const paidBatch = await alice.callRaw(headcount, "payout_batch", { round_id: roundId, limit: 100 }, { gas: tgas(300) });
    assert.ok(paidBatch.succeeded, paidBatch.receiptFailureMessages.join("; "));
    for (const r of recipients) {
      const expected = world.cleared.includes(r) ? amountOf(r) : 0n;
      assert.equal(await received(r), expected, `${r} after the first batch`);
    }
    line("(Each recipient first registers with the token, as every NEP-141 recipient must.)");
    line(`${alice.accountId}, who holds no role anywhere, calls payout_batch: the ${world.cleared.length} cleared recipients get`);
    line(`exactly their amounts (${tokens(world.cleared.reduce((s, r) => s + amountOf(r), 0n))} tokens). The ${held.length} held get nothing.`);
    try {
      await alice.call(headcount, "payout_batch", { round_id: roundId, limit: 100 }, { gas: tgas(100) });
      assert.fail("a second payout should have been refused");
    } catch (error) {
      const message = String((error as Error).message);
      assert.ok(message.includes("wait for a council vote"), message);
    }
    line(`${alice.accountId} tries again: refused, "its ${held.length} held recipient(s) wait for a council vote".`);

    // --- 8. The council decides one group ----------------------------------------------------
    step(8, "The council decides one held group");
    const farmC = farm("C").accounts;
    const groupC = screened.groups.find((g) => g.accounts.join() === farmC.join())!.group;
    const resolved = await fileTemplate("headcount-resolve-group", { round_id: roundId, group: groupC, decision: '"ReleaseAll"' });
    assert.equal((await getRound(roundId)).groups[groupC - 1]?.state, "ReleasedAll");
    const second = await alice.callRaw(headcount, "payout_batch", { round_id: roundId, limit: 100 }, { gas: tgas(100) });
    assert.ok(second.succeeded, second.receiptFailureMessages.join("; "));
    for (const r of farmC) assert.equal(await received(r), amountOf(r), `${r} is paid`);
    line(`${list(farmC)} turn out to be a couple who share a household.`);
    line(`The Requestor fills Trezu's "Decide a held group" template: group ${groupC}, "ReleaseAll". Two approvals`);
    line(`(proposal ${resolved}). The next batch pays them both, exactly (${tokens(farmC.reduce((s, r) => s + amountOf(r), 0n))} tokens).`);

    // --- 9. The rest expires -----------------------------------------------------------------
    step(9, "Nobody decides the other three groups");
    const deadline = (await getRound(roundId)).hold_deadline_sec;
    assert.ok(deadline);
    const chainNow = async (): Promise<number> =>
      Number(BigInt((await rpc.call<{ header: { timestamp_nanosec: string } }>("block", { finality: "optimistic" })).header.timestamp_nanosec) / 1_000_000_000n);
    for (let i = 0; i < 10 && (await chainNow()) <= deadline + 1; i += 1) {
      await worker.provider.fastForward(Math.max(5, deadline + 2 - (await chainNow())));
    }
    assert.ok((await chainNow()) > deadline + 1, "the sandbox clock is past the hold window");
    const daoBeforeRefund = await balanceOf(dao.accountId);
    await alice.call(headcount, "refund_expired", { round_id: roundId }, { gas: tgas(100) });
    const back = held.filter((p) => !farmC.includes(p.recipient)).reduce((s, p) => s + BigInt(p.amount), 0n);
    assert.equal((await balanceOf(dao.accountId)) - daoBeforeRefund, back, "the DAO is up by exactly the returned shares");
    line(`The ${WINDOW_SEC / 60}-minute hold window passes (the sandbox clock is moved forward rather than waited out).`);
    line(`Now anyone may call refund_expired. It sends the ${held.length - farmC.length} remaining held shares, ${tokens(back)} tokens,`);
    line(`back to ${dao.accountId}: the DAO's balance rises by exactly that.`);

    // --- 10. The books -----------------------------------------------------------------------
    const final = await getRound(roundId);
    const paid = BigInt(final.paid);
    const returned = BigInt(final.refunded);
    assert.equal(paid + returned, total, "paid + returned = funded");
    assert.ok(final.payments.every((p) => p.state === "Paid" || p.state === "Refunded"));
    assert.equal(await balanceOf(headcount.accountId), 0n, "Headcount holds none of the round's tokens");
    const paidAccounts = final.payments.filter((p) => p.state === "Paid").length;
    const returnedAccounts = final.payments.filter((p) => p.state === "Refunded").length;
    const recordOf = async (account: string): Promise<string> => {
      const r = await headcount.view<{ rounds_listed: number; rounds_held: number; rounds_paid: number; rounds_returned: number }>(
        "get_account_record",
        { dao_id: dao.accountId, account_id: account },
      );
      return `listed ${r.rounds_listed}, held ${r.rounds_held}, paid ${r.rounds_paid}, returned ${r.rounds_returned}`;
    };
    const farmAFirst = farm("A").accounts[0]!;
    const records = {
      nia: await recordOf(farmC[0]!),
      farmA: await recordOf(farmAFirst),
      uma: await recordOf(id("uma")),
    };
    assert.equal(records.nia, "listed 1, held 1, paid 1, returned 0");
    assert.equal(records.farmA, "listed 1, held 1, paid 0, returned 1");
    assert.equal(records.uma, "listed 1, held 0, paid 1, returned 0");
    step(10, "The books");
    line(`Funded ${tokens(total)} = paid ${tokens(paid)} (${paidAccounts} recipients) + returned ${tokens(returned)} (${returnedAccounts} recipients).`);
    line("Headcount holds 0 tokens. get_round keeps each payment's state and each group's outcome on chain:");
    line(`  ${final.groups.map((g) => `group ${g.group} ${g.state}`).join(", ")}.`);
    line("get_account_record counts each account's rounds with this DAO, from those rounds:");
    line(`  ${short(farmC[0]!)}: ${records.nia}`);
    line(`  ${short(farmAFirst)} (farm A): ${records.farmA}`);
    line(`  ${id("uma")}: ${records.uma}`);

    return {
      roundId,
      groups: result.verdict.groups.length,
      held: held.length,
      cleared: result.screen.cleared.length,
      paidAccounts,
      returnedAccounts,
      total,
      paid,
      returned,
      seconds: Math.round((Date.now() - started) / 1000),
    };
  } finally {
    await worker.tearDown();
  }
};
