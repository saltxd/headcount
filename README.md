# Headcount

**Reward payouts for Sputnik DAO and Trezu treasuries that pay each person once.**

Built at NEAR HACKATHON. Track: Social Money.

> **Status (2026-11-07).** What runs today, in a local `near-workspaces` sandbox: the real
> Sputnik DAO v3.2 contract, built from source at the commit NEAR's mainnet factory names for v3.2,
> with the three roles Trezu gives every treasury, and next to it the first half of the Headcount
> contract. A DAO names its screener by vote; a requestor turns a Trezu-format CSV into a round whose
> id is the id Trezu itself gives that list; the DAO funds the round by vote, in NEAR or in a token;
> the screener posts which recipients are linked. Paying the cleared recipients, council votes on
> held groups, refunds, and the screener program that reads the chain are not built yet: parts marked
> **[NOT BUILT YET]** describe the intended shape, not working code. Nothing here claims something
> runs unless you can run it from the steps given.

---

## The problem

A community votes to pay 40 people for a campaign. Six of those 40 accounts were created by one
person: the same account funded all six, and two of them share a key. The vote cannot see this.
The treasury pays that person six times, and the honest contributors' shares get smaller, now or
in the next round.

On NEAR today, the defences against this ask every recipient to prove they are human, with a face
scan or stamps. Small community rounds rarely ask that of contributors. **Headcount asks nothing
of the recipients.** It reads what the chain already records about each account, pays the accounts
that look independent, and asks the council about the rest.

## What it does

A community votes a reward round the way it already does. Before any money moves, a screener the
DAO names reads what NEAR already records about each recipient: who created and funded the
account, which keys control it, and where it sends money. It posts which recipients are linked.
The round pays the independent recipients automatically, holds each linked group for a normal
council vote, and sends anything unresolved back to the treasury.

Headcount never gets a role in the DAO. It only ever holds the amount the council voted for one
round, and it can only pay accounts on that round's list or return money to the DAO.

```
  DAO (Sputnik v3.2 / Trezu treasury)        Headcount contract              Screener (named by the DAO)
  -----------------------------------        ------------------              ---------------------------
  1. vote: FunctionCall configure(screener) -> config for this DAO
  2. requestor: create_round(list)          -> round id = Trezu's list id
                                               <- reads the list ----------- 3. reads the chain [NOT BUILT YET]
                                               post_verdict(groups) <------- only this account
  4. vote: FunctionCall that funds the round (the call Trezu's bulk payments already file)
  5. anyone: payout_batch                   -> pays cleared recipients, keeps held groups [NOT BUILT YET]
  6. vote: resolve_group, or after the hold window anyone calls refund_expired -> back to the DAO [NOT BUILT YET]
```

Steps 1, 2 and 4 run in the sandbox today, and so does the contract's side of step 3: only the DAO's
named screener can post a verdict, once, within the round's window, about accounts on its list.

**Why a separate contract.** Sputnik has no hook before a proposal executes, its roles combine
with OR, and the vote that reaches the threshold executes the proposal in the same call (the first
test below shows this). A screener cannot hold a Sputnik proposal; it could only race the council.
What does work is a `FunctionCall` that moves exactly one round's money into a contract whose code
fixes where that money can go.

**What the screen reads.** Same creator or funder, a shared full-access key, a direct transfer
between two recipients, and a shared collector. It never links accounts through a service: the
`near` registrar, the DAO factory, wallet sponsors or exchanges.

**The round id is Trezu's list id.** Trezu's bulk payments name a list by the SHA-256 of a compact
JSON object (payments sorted by recipient, then submitter, timestamp and token). A Headcount round
uses the same formula with the DAO as submitter, so a treasurer screens exactly the list they would
give Trezu. `fixtures/trezu-list-ids.json` holds three synthetic lists and the ids Trezu's own
`generateListId` returned for them; the contract and the TypeScript both reproduce them. Trezu's
backend sorts recipients in byte order and its frontend with `localeCompare`; the two disagree on
lists where one account has a `_` where another has a `-`, `.` or digit. Headcount follows the
backend, which is what checks a submitted id.

**Two ways to fund a token round.** Either the `FunctionCall` Trezu's bulk payments file (the
token's `ft_transfer_call` to Headcount with the round id as `msg`, 1 yoctoNEAR, 100 TGas), or
Sputnik's own `Transfer` proposal with the round id as `msg`. Sputnik gives that transfer a fixed
10 TGas of static gas, which looks too little, but near-sdk 5 also hands the call a share of the gas
the deciding vote leaves unused. Measured in the sandbox on a 100-recipient round: `ft_on_transfer`
was given 4.5 TGas under a 30 TGas vote and 114.5 TGas under a 250 TGas vote, and its receipt burns
2.24 TGas, fees included. That is with the sandbox's token (near-contract-standards 5.24.1); a token
whose `ft_transfer_call` keeps more gas for itself could leave too little, and then the transfer
fails or the token refunds it, so the funds stay with the DAO. Any other funding is sent back too: another token, a sender that is not the DAO, or an amount
that is not the round's exact total.

**What it cannot know.** The screen sees accounts, not people. A family or a team's own accounts
can be linked for good reasons, which is why a held group goes to a council vote and is never
forfeited.

---

## Run it yourself

**You need:** Node 22.18 or newer, git, and rustup. The repository's `rust-toolchain.toml` installs
Rust 1.86 with the wasm target on first use. macOS on Apple silicon or Linux x86-64, the platforms
NEAR publishes a sandbox for. The first run needs network access to fetch Sputnik's source from
GitHub, Rust crates, and the sandbox binary from NEAR's release bucket. No NEAR account, keys or
funds.

```bash
git clone https://github.com/saltxd/headcount
cd headcount
npm ci
npm test
cargo test
```

`npm test` first builds Sputnik DAO v3.2 from source (`npm run build:sputnik`) and the Headcount
contract (`npm run build:contract`), puts neard 2.13.4 in place, then runs the tests. The first run
takes a few minutes; most of it is compiling.

**What you should see.** `npm test` prints the story, then `pass 20`, `fail 0`. The Headcount part:

```
  dao.test.near: Sputnik 2.3.1 with Trezu roles; Headcount at headcount.test.near, which holds no role in the DAO
  CONFIGURED by vote (proposal 0, Approved): dao.test.near names screener.test.near, 2-day windows
✔ scenario 1: the DAO names its screener through a FunctionCall proposal and two approvals
  REFUSED: the Requestor calling configure for the DAO directly, outside a vote
✔ only the DAO itself can configure it: the Requestor's direct call is refused
  ROUND 90a14b05d807... created from fixtures/round-16.csv: 16 recipients, total 114275001 (= Trezu's generateListId for the same list)
✔ scenario 2: the Requestor creates a 16-recipient round from a Trezu-format CSV; its id is Trezu's list id
  REFUSED: verdicts from the Requestor and from an outsider: not this DAO's screener
✔ scenario 4: an account that is not the DAO's screener cannot post a verdict
  REFUSED: the screener's own verdict, because it names alice.test.near, who is not on the list
✔ scenario 5: a verdict naming an account that is not on the round's list is refused
  VERDICT posted by the screener: 2 groups, 5 of 16 held, 11 cleared; a second verdict REFUSED
✔ the screener's verdict holds the linked recipients, once: a second verdict is refused
  SENT BACK through NEP-141's refund: the DAO's vote in another token, alice's transfer, the DAO's vote one unit short
✔ scenario 12: token funding from the wrong token, a sender that is not the DAO, or a wrong amount goes back
  REFUSED, deposit returned: the DAO's vote 1 yoctoNEAR short (proposal 3 Failed), NEAR for the token round (proposal 4 Failed), alice funding the DAO's round
✔ scenario 12: a NEAR deposit that is not exactly the DAO funding a NEAR round is refused
  FUNDED by vote: round16 with 114275001 of token.test.near, and the NEAR round with exactly 1 NEAR
✔ the right doors fund a round: the vote Trezu's template files (ft_transfer_call), and fund_round with the exact total
  Transfer{msg}, deciding vote 250 TGas: funded; ft_on_transfer was given 114.51 TGas and the receipt burnt 2.24 TGas
  Transfer{msg}, deciding vote 30 TGas: funded; ft_on_transfer was given 4.51 TGas and the receipt burnt 2.24 TGas
✔ a Sputnik Transfer proposal with msg also funds a round: Sputnik's 10 TGas is a floor, not a cap
```

(`2.3.1` is the `sputnikdao2` crate version; the factory calls this release v3.2. Gas figures move
by a few hundredths of a TGas from run to run.)

The scenario numbers are the design's. Scenario 3 (the screener reads the chain) and scenarios 6 to
11 and 13 (payouts, council votes, refunds) arrive with the parts marked [NOT BUILT YET].

| Tests | What they show |
|---|---|
| `ts/sandbox/dao.test.ts` (3) | The DAO alone: a `FunctionCall` proposal passes on the second Approver vote and runs in that same transaction; a vote must carry the stored proposal kind back (`ERR_WRONG_KIND`); a Requestor cannot approve and neither an Approver nor an Admin can file a payment |
| `ts/sandbox/headcount.test.ts` (10) | The scenarios above, against the real DAO. Each refused funding checks Headcount's own logged reason, not only the balances: a contract with no `ft_on_transfer` at all would also see tokens bounce |
| `ts/test/list-id.test.ts` (7) | The TypeScript list id against Trezu's own ids, and the CSV parser: Trezu's two columns, amounts in whole tokens, refusing rather than rounding an amount with more decimals than the token has |

`cargo test` runs the contract's 62 unit tests on near-sdk's mocked VM: who may configure, the list
checks, storage charged to the caller and the rest of the deposit returned, every funding refusal,
every verdict check, and the three Trezu list-id vectors.

Set `NEAR_PRINT_LOGS=1` to see every receipt log and refusal the sandbox prints.

### The DAO in the sandbox is the real one

- **Sputnik DAO v3.2, built from source.** `sputnik-dao.near`, the mainnet factory, reports default
  version `[3, 2]` with code hash `DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF`, and maps that hash
  to commit `2b0f34a3` of
  [near-daos/sputnik-dao-contract](https://github.com/near-daos/sputnik-dao-contract).
  `scripts/build-sputnik.mjs` fetches that commit with git and refuses any other, builds
  `sputnikdao2` and its `test-token` with Sputnik's own `rust-toolchain.toml` and `Cargo.lock`
  (`--locked`), and lowers the wasm for NEAR's VM. It is an ordinary cargo build, not Sputnik's
  reproducible Docker build, so its code hash differs from the factory's; the script prints both.
- **Trezu's roles.** `trezuPolicy` in `ts/sandbox/harness.ts` writes the policy Trezu's backend
  writes when it creates a treasury (`build_policy` in
  [NEAR-DevHub/trezu](https://github.com/NEAR-DevHub/trezu), `nt-be/src/handlers/treasury/create.rs`):
  Requestor, Admin and Approver, a vote count for payments, a zero proposal bond and a seven-day
  voting period. It is rewritten, not copied.
- **The sandbox runs neard 2.13.4.** The neard that near-workspaces 5.0.0 installs, 2.6.2, cannot
  link Sputnik v3.2 (`UnknownImportError` for `promise_batch_action_deploy_global_contract`, from
  near-sdk's `global-contracts` feature). `scripts/ensure-sandbox.mjs` fetches 2.13.4 from NEAR's
  release bucket and checks the tarball's SHA-256 before using it.

### Mainnet, read-only (optional)

The judge's run never touches mainnet. For a treasurer who wants to try the screen on a real list,
the same screen can read mainnet through FastNEAR's keyless public endpoints. It sends no
transaction and holds no key.

```
npm run screen -- --trezu-list <64-hex list id>     recipients of a Trezu bulk-payment list (bulkpayment.near view_list)
npm run screen -- --accounts a.near,b.near          or an explicit list (--accounts-file for one id per line)
npm run screen -- --factory-daos 1000:12            or 12 public DAOs the Sputnik factory made
npm run screen:live                                 the by-hand check: 6 public DAOs that hold the factory's key; nothing may link
npm run board -- out/screens/<folder>               a local board.html over finished screens
```

Each run writes `report.md`, `report.json`, `verdict.json`, a `run.json` and a `board.html` (one
static page, no network) into `out/`. The pacing is enforced in code: one request at a time, at
least 500 ms apart (2 a second at most), doubling backoff on 429 and 5xx (a 429 also slows the rest of
the run), and only `free.rpc.fastnear.com`, `tx.main.fastnear.com` and `api.fastnear.com`.

The mainnet reader asks per account instead of scanning every block, so it reads a bounded slice
(the newest 400 transactions of each role per account) and says where it stopped in `run.json`, the
board and the terminal. Every shortcut errs toward treating an account as a service, which links fewer
recipients, never more: an account too busy to read within that slice counts as a service, and an
implicit account that received NEAR counts as created. `report.json` stays a pure function of what the
chain said; read limits live beside it in `run.json`. The key index lists current holders only, where
the sandbox reader also counts past ones.

`npm test` needs no network: the reader runs against a pretend FastNEAR (`ts/test/fastnear-world.ts`)
and one response recorded from the real service (`fixtures/fastnear/`, DAO accounts only, call
arguments removed).

---

## Disclosures

### Independent second project

> Independent second project (NEAR HACKATHON rule Q-015): the same person also entered **NEAR Payment Guard** (https://github.com/saltxd/near-payment-guard), a guard that lets an AI agent pay a third party only after a policy check and a signed risk verdict. The two share no contract, no keys, no service and no code beyond public libraries and generic build scripts; they solve different problems for different users.

The generic scripts, listed as the rule asks: `scripts/ensure-sandbox.mjs` and the wasm lowering
in `scripts/wasm.mjs` (used by both build scripts) are adapted from NEAR Payment Guard's build and
sandbox scripts. Nothing else is shared.

### Existing product on another chain

This project is built by **[ChainWard](https://chainward.ai)**, an existing, live product on
**Base**, not something created for this hackathon. Among other work, ChainWard screens reward and
payout lists on Base and BNB Chain for linked wallets. That is the know-how behind Headcount's
screen: the rule shapes (first funder, shared collector, never link through a service) carry over
to NEAR.

**What that means for this entry, stated plainly:** what is new, and built during the hackathon
window, is everything in this repository. Headcount's screen is written for NEAR's account model
(named and implicit accounts, access keys, sub-account parents). It uses no ChainWard code, API,
service or key, and needs none to run.

### Libraries, templates and prior art

- **Sputnik DAO v3.2** (MIT), near-daos/sputnik-dao-contract at `2b0f34a3`: the DAO contract and
  its NEP-141 test token, built from source and used unmodified in the sandbox
- **near-sdk** `=5.24.1` for the contract, the version Sputnik v3.2 locks
- **near-workspaces** `5.0.0` and **near-api-js** `5.1.1`, dev-only, for the sandbox tests
- **near-sandbox**: neard `2.13.4`, NEAR's official build
- **binaryen** `123.0.0` (`wasm-opt`), dev-only, to lower wasm features NEAR's VM rejects
- **Trezu** (NEAR DevHub): we read how it configures a treasury's roles and mirror that policy, and
  Headcount uses its list-id formula. To check that formula we ran Trezu's own `generateListId`
  (and its backend's `compute_list_hash`) on synthetic lists, outside this repository; only the
  resulting ids are here, in `fixtures/trezu-list-ids.json`. No Trezu code is copied
- **No project template was used.** The repository layout is our own
- **Prior art:** nada.bot (used by Potlock's funding rounds) and I-Am-Human (used for NDC
  elections) already defend NEAR communities against one person counting many times. Both ask each
  person to verify themselves; Headcount asks the recipients nothing and reads the chain instead

### AI-generated code

**Most of the code in this repository was written by an AI agent (Claude), directed, reviewed and
accepted by a human.** That applies to the scripts, the tests, the contract and this README.

---

## Repository layout

```
crates/headcount/src/lib.rs      the Headcount contract: configure, create_round, fund_round,
                                 ft_on_transfer, post_verdict, views
crates/headcount/src/list_id.rs  Trezu's list id in Rust
crates/headcount/src/tests.rs    the contract's unit tests (cargo test)
fixtures/trezu-list-ids.json     ids Trezu's own generateListId computed for synthetic lists
fixtures/round-16.csv            the sandbox's 16-recipient list, in Trezu's CSV format
scripts/build-sputnik.mjs        fetch Sputnik DAO v3.2 at 2b0f34a3, build it into out/
scripts/build-contract.mjs       build the Headcount contract into out/
scripts/wasm.mjs                 the wasm lowering and code hash both build scripts use
scripts/ensure-sandbox.mjs       put neard 2.13.4 where near-workspaces looks (tarball SHA-256 checked)
ts/src/list-id.ts                Trezu's list id and CSV parser in TypeScript
ts/test/list-id.test.ts          their tests
ts/screener/                     the screener: rule, report, the sandbox block scan, and mainnet mode
                                 (fastnear.ts reader, paced-fetch.ts pacing, trezu-list.ts, cli.ts, board.ts)
ts/test/fastnear*.test.ts        the mainnet reader on a pretend FastNEAR; mainnet-screen.test.ts runs the screen on it
fixtures/fastnear/               one recorded FastNEAR response (a DAO's creation), call arguments removed
ts/sandbox/dao.test.ts           the DAO alone in the sandbox
ts/sandbox/headcount.test.ts     Headcount next to the DAO: the design's scenarios
ts/sandbox/harness.ts            Trezu's policy, proposal shapes, test helpers
rust-toolchain.toml              Rust 1.86 with the wasm target, the toolchain Sputnik v3.2 pins
.nvmrc                           Node 22.18.0, the oldest Node that runs the TypeScript without a flag
```

## License

MIT. See [LICENSE](LICENSE).
