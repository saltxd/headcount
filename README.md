# Headcount

**Reward payouts for Sputnik DAO and Trezu treasuries that pay each person once.**

Built at NEAR HACKATHON. Track: Social Money.

> **Status (2026-11-07).** What runs today, in a local `near-workspaces` sandbox: the real
> Sputnik DAO v3.2 contract, the exact bytes NEAR's mainnet factory deploys (code hash checked),
> with the three roles Trezu gives every treasury, and next to it the Headcount contract. A DAO
> names its screener by vote; a requestor turns a Trezu-format CSV into a round whose id is the id
> Trezu itself gives that list; the DAO funds the round by vote, in NEAR or in a token; the screener
> reads the chain and posts which recipients are linked; anyone pays the cleared recipients in
> batches; the council releases or returns each held group by vote; and whatever nobody decides in
> time goes back to the DAO. The screener runs against the sandbox chain (scenario 3); its mainnet
> read-only mode is not built yet, and parts marked **[NOT BUILT YET]** describe the intended shape,
> not working code. Nothing here claims something runs unless you can run it from the steps given.

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
                                               <- reads the list ----------- 3. reads the chain (sandbox; mainnet mode NOT BUILT YET)
                                               post_verdict(groups) <------- only this account
  4. vote: FunctionCall that funds the round (the call Trezu's bulk payments already file)
  5. anyone: payout_batch                   -> pays cleared recipients, keeps held groups
  6. vote: resolve_group, or after the hold window anyone calls refund_expired -> back to the DAO
```

Steps 1, 2, 4, 5 and 6 run in the sandbox today, and so does the contract's side of step 3: only the
DAO's named screener can post a verdict, once, within the round's window, about accounts on its list.

**Paying, deciding, returning.** Anyone can call `payout_batch`: it pays only recipients the verdict
cleared or the council released, in list order, as many as the attached gas covers (100 TGas paid six
token transfers in the sandbox; each `ft_transfer` burnt at most 1.75 TGas of the 10 it gets). A
NEAR payment to an implicit account counts for 10 TGas: NEAR charges every transfer to one as an
account creation, about 8.4 TGas in fees, whether or not the account exists yet. One callback per
batch records each transfer; one that fails, for example to a recipient who never
registered with the token, is marked `Failed`, and its amount can then only go back to the DAO. Only
the DAO itself can call `resolve_group`, so a held group takes a council vote: release all of it,
release one account and return the rest, or return all of it. Anyone can call `refund_expired`,
which sends back a funded round that got no verdict within its verdict window, every held group the
council left undecided past the hold window (counted from the later of the verdict and the funding),
and any failed payment. Each payment's state and each group's outcome stay on chain (`get_round`,
`get_rounds`), and a round is settled when what was paid plus what went back equals what was funded.

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

`npm test` first fetches Sputnik DAO v3.2 (and builds its test token; `npm run build:sputnik`) and the Headcount
contract (`npm run build:contract`), puts neard 2.13.4 in place, then runs the tests. The first run
takes a few minutes; most of it is compiling.

**What you should see.** `npm test` prints the story, then `pass 30`, `fail 0`. The Headcount part:

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
  RECONFIGURED by vote (proposal 3): 60-second windows for rounds created from now on; round16 keeps its 2 days
✔ the DAO shortens its windows to 60 s by vote; round16 keeps the 2 days it was created with
  REFUSED, deposit returned: the DAO's vote 1 yoctoNEAR short (proposal 4 Failed), NEAR for the token round (proposal 5 Failed), alice funding the DAO's round
✔ scenario 12: a NEAR deposit that is not exactly the DAO funding a NEAR round is refused
  FUNDED by vote: round16 with 114275001 of token.test.near, and the NEAR round with exactly 1 NEAR
✔ the right doors fund a round: the vote Trezu's template files (ft_transfer_call), and fund_round with the exact total
  Transfer{msg}, deciding vote 250 TGas: funded; ft_on_transfer was given 114.51 TGas and the receipt burnt 2.31 TGas
  Transfer{msg}, deciding vote 30 TGas: funded; ft_on_transfer was given 4.51 TGas and the receipt burnt 2.31 TGas
✔ a Sputnik Transfer proposal with msg also funds a round: Sputnik's 10 TGas is a floor, not a cap
  PAID by an outsider in 2 batches (6 with 100 TGas, then 5): 10 cleared recipients got exactly their amounts; r16.test.near is not registered with the token, so its transfer failed and is kept for the DAO; the 5 held got nothing. Each ft_transfer burnt 1.75 TGas at most, the callback 1.90
✔ scenario 6: once the vote Trezu's template files has funded round16, anyone pays its cleared recipients in batches; held ones are kept
  RETURNED: r16.test.near's failed 2250000 went back to dao.test.near; nothing else moved
✔ a payment that failed can only go back to the DAO: anyone sends it back at once
  REFUSED: another payout (only the 5 held are left), and resolve_group from an outsider, the Requestor and the screener: only a DAO vote decides a held group
✔ scenario 7: nobody can pay a held account, or decide a held group without a DAO vote
  COUNCIL VOTE (proposal 10, Approved), two decisions in one FunctionCall: group 1 pays r01 once (10500000, paid by the next batch) and 26250000 went back to the DAO. Round16 is settled
✔ the council decides both of round16's groups in one vote: group 1 pays r01 only, group 2 goes back
  RELEASED by vote (proposal 12): farm C (r09, r10) paid 12400000; the 4 cleared were paid first; farms A, B and D (10 accounts) still held, and refund_expired REFUSED inside the hold window
✔ scenario 8: on a fresh 60-second round, the council votes to release farm C (a couple who share a household); it is paid
  EXPIRED: past the hold window, an outsider's refund_expired sent farms A, B and D (85375001) back; the DAO's balance rose by exactly that
✔ scenario 9: farms A, B and D are left alone past the hold window; anyone sends them back, and the DAO is up by exactly that
  RETURNED WHOLE after the verdict window: the NEAR round (the DAO's NEAR up by exactly 1 NEAR; a late verdict refused) and both 100-recipient rounds (200000 of the token)
✔ scenario 10: rounds funded with no verdict go back whole once the verdict window closes
  NEW ROUND 61ca51b12e35...: r09's amount +1 unit gives another id; it has no verdict, and paying it is refused
✔ scenario 11: one amount edited after screening makes a new round; the old verdict does not apply
  BOOKS BALANCE over all 6 rounds get_rounds lists: the 5 funded are settled with paid + refunded = funded, and the edited one was never funded. Headcount holds 0 of each token, and its NEAR beyond storage is up 0.00225 NEAR since deployment: its gas rewards
✔ scenario 13: over every round Headcount lists, paid + refunded = funded, and Headcount keeps none of the money
```

(`2.3.1` is the `sputnikdao2` crate version; the factory calls this release v3.2. Gas figures move
by a few hundredths of a TGas from run to run, and the gas rewards in the last line by a little more.)

The scenario numbers are the design's. Every scenario runs. Scenario 3 is the screener reading the
sandbox chain and posting its own verdict; the others use verdicts written by hand. To run scenarios 9
and 10 past a deadline in seconds, the DAO first votes its windows down to 60 seconds, and the sandbox
clock is moved forward with empty blocks rather than waited out; round16 keeps the 2-day windows it
was created with.

| Tests | What they show |
|---|---|
| `ts/sandbox/dao.test.ts` (3) | The DAO alone: a `FunctionCall` proposal passes on the second Approver vote and runs in that same transaction; a vote must carry the stored proposal kind back (`ERR_WRONG_KIND`); a Requestor cannot approve and neither an Approver nor an Admin can file a payment |
| `ts/sandbox/headcount.test.ts` (20) | The scenarios above, against the real DAO. Each refused funding checks Headcount's own logged reason, not only the balances: a contract with no `ft_on_transfer` at all would also see tokens bounce. Every payout and refund is checked against the receiving account's balance, to the unit, and scenario 13 checks every round `get_rounds` lists |
| `ts/test/list-id.test.ts` (7) | The TypeScript list id against Trezu's own ids, and the CSV parser: Trezu's two columns, amounts in whole tokens, refusing rather than rounding an amount with more decimals than the token has |

`cargo test` runs the contract's 108 unit tests on near-sdk's mocked VM: who may configure, the list
checks, storage charged to the caller and the rest of the deposit returned, every funding refusal,
every verdict check, the three Trezu list-id vectors, and for payouts: batches in list order and
within their gas, each transfer recorded paid or failed, nothing paid twice or while held, only the
DAO deciding a group, every deadline to the second, and a round run through every path at once whose
transfers add up to its total.

Set `NEAR_PRINT_LOGS=1` to see every receipt log and refusal the sandbox prints.

### The DAO in the sandbox is the real one

- **Sputnik DAO v3.2, the factory's own bytes.** `sputnik-dao.near`, the mainnet factory, reports
  default version `[3, 2]` with code hash `DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF`.
  `scripts/build-sputnik.mjs` reads those bytes with one keyless view call (`get_code`) and refuses
  them unless they hash to that value; a sandbox test asserts the deployed DAO's code hash equals it.
  The factory maps the hash to commit `2b0f34a3` of
  [near-daos/sputnik-dao-contract](https://github.com/near-daos/sputnik-dao-contract) (MIT); the
  test token is built from that commit with its own `rust-toolchain.toml` and `Cargo.lock`
  (`--locked`) and lowered for NEAR's VM. The first run needs network access for the fetch.
- **Trezu's roles.** `trezuPolicy` in `ts/sandbox/harness.ts` writes the policy Trezu's backend
  writes when it creates a treasury (`build_policy` in
  [NEAR-DevHub/trezu](https://github.com/NEAR-DevHub/trezu), `nt-be/src/handlers/treasury/create.rs`):
  Requestor, Admin and Approver, a vote count for payments, a zero proposal bond and a seven-day
  voting period. It is rewritten, not copied.
- **The sandbox runs neard 2.13.4.** The neard that near-workspaces 5.0.0 installs, 2.6.2, cannot
  link Sputnik v3.2 (`UnknownImportError` for `promise_batch_action_deploy_global_contract`, from
  near-sdk's `global-contracts` feature). `scripts/ensure-sandbox.mjs` fetches 2.13.4 from NEAR's
  release bucket and checks the tarball's SHA-256 before using it.

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
                                 ft_on_transfer, post_verdict, payout_batch, resolve_group,
                                 refund_expired, views
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
ts/sandbox/dao.test.ts           the DAO alone in the sandbox
ts/sandbox/headcount.test.ts     Headcount next to the DAO: the design's scenarios
ts/sandbox/harness.ts            Trezu's policy, proposal shapes, test helpers
rust-toolchain.toml              Rust 1.86 with the wasm target, the toolchain Sputnik v3.2 pins
.nvmrc                           Node 22.18.0, the oldest Node that runs the TypeScript without a flag
```

## License

MIT. See [LICENSE](LICENSE).
