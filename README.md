# Headcount

**Reward payouts for Sputnik DAO and Trezu treasuries that pay each person once.**

Built at NEAR HACKATHON. Track: Social Money.

> **Status: day 0 of the build (2026-11-06).** What runs today: the real Sputnik DAO v3.2
> contract, built from source at the commit NEAR's mainnet factory names for v3.2, inside a local
> `near-workspaces` sandbox with the three roles Trezu gives every treasury. A `FunctionCall`
> proposal goes from filing to execution there. The Headcount contract and the screener are not
> written yet: sections marked **[NOT BUILT YET]** describe the intended shape, not working code.
> Nothing here claims something runs unless you can run it from the steps given.

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

## What it will do [NOT BUILT YET]

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
                                               <- reads the list ----------- 3. reads the chain
                                               post_verdict(groups) <------- only this account
  4. vote: FunctionCall that funds the round (the call Trezu's bulk payments already file)
  5. anyone: payout_batch                   -> pays cleared recipients, keeps held groups
  6. vote: resolve_group, or after the hold window anyone calls refund_expired -> back to the DAO
```

**Why a separate contract.** Sputnik has no hook before a proposal executes, its roles combine
with OR, and the vote that reaches the threshold executes the proposal in the same call (the first
test below shows this). A screener cannot hold a Sputnik proposal; it could only race the council.
What does work is a `FunctionCall` that moves exactly one round's money into a contract whose code
fixes where that money can go.

**What the screen reads.** Same creator or funder, a shared full-access key, a direct transfer
between two recipients, and a shared collector. It never links accounts through a service: the
`near` registrar, the DAO factory, wallet sponsors or exchanges.

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

`npm test` first builds Sputnik DAO v3.2 from source (`npm run build:sputnik`), puts neard 2.13.4
in place, then runs the sandbox tests against them.

**What you should see.** `npm test` prints the story, then `pass 3`, `fail 0`:

```
  DAO dao.test.near: Sputnik 2.3.1 with Trezu roles Requestor (treasurer.test.near), Admin (admin.test.near), Approver (4 accounts, any 2 approve a payment)
  FILED proposal 0 by the Requestor: FunctionCall token.test.near.ft_transfer(alice, 25)
  VOTE 1 of 2 (approver1.test.near): still InProgress, nothing moved
  VOTE 2 of 2 (approver2.test.near): Approved, and the DAO's call ran in the same transaction (alice +25)
✔ a FunctionCall proposal passes add_proposal, then act_proposal with the proposal argument
  REFUSED a vote naming 500 instead of 5 (ERR_WRONG_KIND), and a vote with no proposal argument
✔ a vote that does not carry the stored proposal kind back is refused
  REFUSED: the Requestor's and the Admin's approvals, and an Approver's and an Admin's filings
✔ Trezu roles: the Requestor cannot approve, and neither Approver nor Admin can file a payment
```

(`2.3.1` is the `sputnikdao2` crate version; the factory calls this release v3.2.)

| # | Test | What it shows |
|---|---|---|
| 1 | A `FunctionCall` proposal passes | The Requestor files a proposal for the DAO to pay 25 of a NEP-141 token with `ft_transfer`. One Approver vote leaves it `InProgress` and nothing moves; the second approves it and the DAO's call runs in that same transaction. Only the DAO can move the DAO's tokens, so the balances prove the DAO made the call |
| 2 | A vote must carry the proposal back | `act_proposal` takes the stored proposal kind as an argument. A vote naming a different amount is refused (`ERR_WRONG_KIND`), and so is a vote without the `proposal` argument. An approver votes on exactly the call that will run |
| 3 | The roles are Trezu's | A Requestor cannot approve, an Admin cannot approve a payment, and neither an Approver nor an Admin can file one |

`cargo test` compiles the contract crate against the pinned near-sdk. It runs no tests yet because
the contract has no methods yet.

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

---

## Disclosures

### Independent second project

> Independent second project (NEAR HACKATHON rule Q-015): the same person also entered **NEAR Payment Guard** (https://github.com/saltxd/near-payment-guard), a guard that lets an AI agent pay a third party only after a policy check and a signed risk verdict. The two share no contract, no keys, no service and no code beyond public libraries and generic build scripts; they solve different problems for different users.

The generic scripts, listed as the rule asks: `scripts/ensure-sandbox.mjs` and the wasm lowering
step in `scripts/build-sputnik.mjs` are adapted from NEAR Payment Guard's build and sandbox
scripts. Nothing else is shared.

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
- **Trezu** (NEAR DevHub): we read how it configures a treasury's roles and mirror that policy. No
  Trezu code is copied
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
scripts/build-sputnik.mjs   fetch Sputnik DAO v3.2 at 2b0f34a3, build it, lower the wasm into out/
scripts/ensure-sandbox.mjs  put neard 2.13.4 where near-workspaces looks (tarball SHA-256 checked)
ts/sandbox/dao.test.ts      the sandbox tests (npm test)
ts/sandbox/harness.ts       Trezu's policy, FunctionCall shapes, test helpers
crates/headcount/           the Headcount contract (skeleton: pins near-sdk 5.24.1)
rust-toolchain.toml         Rust 1.86 with the wasm target, the toolchain Sputnik v3.2 pins
.nvmrc                      Node 22.18.0, the oldest Node that runs the TypeScript without a flag
```

## License

MIT. See [LICENSE](LICENSE).
