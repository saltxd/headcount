# Headcount

**Reward payouts for Sputnik DAO and Trezu treasuries that pay each person once.**

Built at NEAR HACKATHON. Track: Social Money.

```bash
git clone https://github.com/saltxd/headcount && cd headcount
npm ci && npm test   # 115 tests, about a minute from a fresh clone (Node 22.18+, rustup; macOS arm64 or Linux x86-64)
npm run demo         # one reward round, start to finish, told step by step
cargo test           # the contract's 122 unit tests
```

> **Status (2026-11-07).** What runs today, in a local `near-workspaces` sandbox: the real Sputnik
> DAO v3.2 contract, the exact bytes NEAR's mainnet factory deploys (code hash checked), with the
> three roles Trezu gives every treasury, and next to it the Headcount contract. A DAO names its
> screener and the token its rounds pay in by vote; a requestor turns a Trezu-format CSV into a
> round whose id is the id Trezu itself gives that list; the DAO funds the round by vote, in NEAR or
> in a token; the screener reads the chain and posts which recipients are linked; anyone pays the
> cleared recipients in batches; the council releases or returns each held group by vote; and
> whatever nobody decides in time goes back to the DAO. Each of the council's three votes can be
> filed through a Trezu custom proposal template (`templates/`), and `npm run demo` tells one
> round's whole story in about 15 seconds. The screener runs against the sandbox chain (scenario 3)
> and, read-only, against mainnet through free keyless endpoints (`screen --trezu-list`). Nothing
> here claims something runs unless you can run it from the steps given.

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
  1. vote: FunctionCall configure(...)      -> this DAO's screener, windows and round tokens
  2. requestor: create_round(list)          -> round id = Trezu's list id
                                               <- reads the list ----------- 3. reads the chain (sandbox, or mainnet read-only)
                                               post_verdict(groups) <------- only this account
  4. vote: FunctionCall that funds the round (the call Trezu's bulk payments already file)
  5. anyone: payout_batch                   -> pays cleared recipients, keeps held groups
  6. vote: resolve_group, or after the hold window anyone calls refund_expired -> back to the DAO
```

Steps 1, 2, 4, 5 and 6 run in the sandbox today, and so does the contract's side of step 3: only the
DAO's named screener can post a verdict, once, within the round's window, about accounts on its list.

**Paying, deciding, returning.** Anyone can call `payout_batch`: it pays only recipients the verdict
cleared or the council released, in list order, as many as the attached gas covers (100 TGas paid five
token transfers in the sandbox; each `ft_transfer` burnt at most 1.74 TGas of the 10 it gets). A
NEAR payment to an implicit account counts for 10 TGas: NEAR charges every transfer to one as an
account creation, about 8.4 TGas in fees, whether or not the account exists yet. One callback per
batch records each transfer; one that fails, for example to a recipient who never
registered with the token, is marked `Failed`, and its amount can then only go back to the DAO.
Anyone can pay the moment a round is funded and screened, so **register every recipient with the
token before the DAO funds the round**: an unregistered recipient's transfer fails and its share goes
back to the DAO. Only
the DAO itself can call `resolve_group`, so a held group takes a council vote: release all of it,
release one account and return the rest, or return all of it. Anyone can call `refund_expired`,
which sends back a funded round that got no verdict within its verdict window, every held group the
council left undecided past the hold window (counted from the later of the verdict and the funding),
and any failed payment. Each payment's state and each group's outcome stay on chain (`get_round`,
`get_rounds`), and a round is settled when what was paid plus what went back equals what was funded.

**No payment is left in flight.** Only the callback learns whether a transfer arrived, so it must
always have the gas to finish. Each paying, deciding or refunding call keeps 20 TGas for its
callback before it sends anything, and the callback reads only the round, never the verdict (the
verdict is stored apart, for the views). Measured on the largest rounds the bounds allow, 100
recipients with 64-character ids and a 220 KB verdict, each called with the least gas that succeeds
(33 TGas for a NEAR round, 44 TGas for a token round): every callback was still given at least
28.4 TGas and burnt at most 3.33 (`ts/sandbox/least-gas.test.ts`). On the old layout the same calls
left payments `Paying` and `Refunding` for good.

**Nothing is ever deleted.** A settled round keeps its list, verdict, payment states and group
outcomes on chain as its public record, so the storage its creator and its screener paid for is not
returned: about 0.011 NEAR for a 16-recipient round and 0.093 NEAR for 100 implicit recipients, plus
about 0.014 NEAR for a verdict like the demo's (up to 2.24 NEAR for one at every bound). That is a
choice: a lasting public record of who was paid and who was held is worth more than a small refund.

**An account's record with a DAO.** `get_account_record(dao_id, account_id)` counts, from the rounds
that DAO funded, how many listed an account, held it (whatever the council then decided), paid it
and returned its share. Anyone can create a round under a DAO, but only the DAO can fund it: in NEAR
with `fund_round`, or in a token the DAO listed by vote in `configure`. A token round counts as funded
when its token reports the DAO as the sender, and a token contract a stranger controls could report
anything, so a round in any token the DAO did not list cannot be created at all, and an unfunded
round counts nowhere. What a record can prove: in rounds this DAO paid for, with tokens it chose,
its own named screener held the account so many times, and so many payments arrived or went back.
What it cannot: anything about the account with another DAO; whether the screener was right; or
anything at all if the DAO itself listed a token that lies about senders. Records are kept per DAO
because any account can configure itself as a DAO and screen its own rounds, so check that the DAO
is the one you mean. It is a view computed from the stored rounds, so it costs no storage and no
payout has to update it.

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
was given 4.5 TGas under a 30 TGas vote and 114.5 TGas under a 250 TGas vote, and its receipt burnt
2.40 TGas, fees included; on the largest screened round the bounds allow, 3.25 TGas, because it
reads the round and never the verdict. That is with the sandbox's token (near-contract-standards
5.24.1); a token whose `ft_transfer_call` keeps more gas for itself could leave too little, and then
the transfer fails or the token refunds it, so the funds stay with the DAO. Any other funding is
sent back too: a token the round is not in, a sender that is not the DAO, or an amount that is not
the round's exact total.

**Never send NEAR or tokens to Headcount with a plain transfer** (a Sputnik `Transfer` proposal
without `msg`, or `ft_transfer`): Headcount has no owner, and nothing can return them. A round is
funded only through `fund_round` or `ft_transfer_call` with the round id, as above.

**What it cannot know.** The screen sees accounts, not people. A family or a team's own accounts
can be linked for good reasons, which is why a held group goes to a council vote and is never
forfeited.

**Limits: what the screen misses.**
- A creator, funder or collector that touched more than 20 accounts, and a key that more than 20
  accounts hold or have held, counts as a service and links nobody. So the same-funder signal misses a farm of more than
  20 accounts behind one funder, and a farmer can push any funder past 20 with throwaway accounts.
  Shared keys, direct transfers and shared collectors still apply to such a farm.
- Links are one hop. Funding that passes through an intermediate account or a service (an exchange,
  a wallet sponsor) is not followed.
- NEAR transfers under 0.01 NEAR are ignored. Only plain NEAR transfers and token transfers the
  account itself made count, so NEAR attached to a contract call, and tokens a contract moves on an
  account's behalf, are not seen as direct transfers or shared collectors.
- The sandbox reader needs every block from genesis. Mainnet mode reads the newest 400 transactions
  per account and role, counts a busier account as a service, and differs from the sandbox reader in
  two more ways (see "Mainnet, read-only").

---

## Run it yourself

**You need:** Node 22.18 or newer, git, and rustup. The repository's `rust-toolchain.toml` installs
Rust 1.86 with the wasm target on first use. macOS on Apple silicon or Linux x86-64, the platforms
NEAR publishes a sandbox for. The first run needs network access for Rust crates, the sandbox binary
from NEAR's release bucket, and one keyless view call that reads the Sputnik DAO bytes from NEAR's
mainnet factory. No NEAR account, keys or funds.

```bash
git clone https://github.com/saltxd/headcount
cd headcount
npm ci
npm test        # 115 tests: the unit tests, then each sandbox file's scenarios, one story line each
npm run demo    # one reward round, start to finish, told step by step
cargo test      # the contract's 122 unit tests
```

`npm test` and `npm run demo` first run `npm run build`: fetch the factory's Sputnik DAO v3.2 bytes
(`npm run fetch:sputnik`), build the Headcount contract and Sputnik's test token
(`npm run build:contracts`), and put neard 2.13.4 in place. From a fresh clone on an Apple M4 Pro
(12 cores), `npm ci && npm test` took 62 s on Node 26.13 (2026-11-07, 115 tests), the build
included (it was 329 s before the sandbox's block time changed); after that, `npm run demo` takes
about 15 s and `cargo test` about 15 s. The contracts build to the same bytes wherever the clone and
cargo's folders sit: the build remaps them out of the wasm (`scripts/wasm.mjs`), so a clone at
another path with an empty cargo registry gave Headcount's exact code hash.

### What `npm run demo` prints

Implicit account ids, keys, hashes and the round id change from run to run; nothing else does.

```
Headcount: one reward round, start to finish, on a local NEAR sandbox
Every account below is a throwaway on a sandbox chain running on this machine:
no real network, keys or funds.

1. A treasury, set up the way Trezu sets one up
   dao.test.near runs Sputnik DAO v3.2, the exact code NEAR's mainnet DAO factory deploys
   (code hash DtHZA1mU..., the factory's own). It has the three roles Trezu gives a treasury:
     Requestor  treasurer.test.near                  files payment proposals
     Approver   approver1.test.near to approver4     any 2 of the 4 pass a payment
     Admin      admin.test.near                      changes the rules
   Headcount is a separate contract, headcount.test.near. It holds no role in the DAO.
   The DAO holds 1,000,000 of token.test.near, a token with 6 decimals standing in for USDC.

2. The DAO names its screener, by vote
   Why: only an account the DAO itself picked may say which recipients are linked.
   The Requestor fills Trezu's "Name the screener" template, which files one proposal:
     headcount.test.near configure: screener screener.test.near, verdict and hold windows 10 minutes,
     rounds paid in NEAR or token.test.near
   Approver 1 votes yes: the proposal is still in progress, and nothing has changed.
   Approver 2 votes yes: proposal 0 is approved, and the DAO's call ran in that same transaction.
   From now on, only screener.test.near can post a verdict on this DAO's rounds, and nobody can
   create a round of the DAO's in a token it did not list.

3. What the chain already records
   Sixteen accounts took part in a campaign. Before anyone asks for money, NEAR already records
   how each account came to exist, which keys control it and where it sent funds. Planted here,
   and not told to the screener:
     farm A  quinn.test.near funded 5 brand-new implicit accounts
     farm B  kai.test.near, lena.test.near and omar.test.near were created with one shared key;
             omar later swapped it for a key of its own
     farm C  nia.test.near and ravi.test.near: one sent the other 1 NEAR
     farm D  sol.test.near and tara.test.near both sent tokens to wes.test.near
     and 4 independent accounts that only look linked: 2 of the 60 accounts wallet-sponsor.test.near
     funded, which all hold one wallet recovery key and deposit at exchange.test.near; and uma and vik,
     who use that exchange too, both donated to the DAO, and one tipped the other 0.001 NEAR.

4. The Requestor turns the payout list into a round
   The list is the CSV Trezu's bulk payments take: 16 lines of "account, amount".
   create_round returns a53b451bd1dfbd43...: Trezu's own list id for this list, with the DAO as
   submitter, so the treasurer screens exactly the list they would hand Trezu. Total: 114.275001 tokens.
   Nothing can be paid before the screen.

5. The screener reads the chain and posts its verdict
   It reads every block of the sandbox (a sandbox has no indexer): blocks 0 to 41,
   226 transactions, in 35 ms. For each recipient it asks who created and funded it,
   which keys control it and where it sent money, and links two recipients only through an account
   that is not a service.
     HELD   group 1: created by the same account, quinn.test.near (evidence: 5 transactions)
              3e93ca93..., 5a6a7073..., 668790ed..., ada1a0f4... and fbb7f325...
     HELD   group 2: share a full-access key, ed25519:J42fg4dw... (evidence: the key itself)
              kai.test.near, lena.test.near and omar.test.near
     HELD   group 3: one sent the other funds (evidence: 1 transaction)
              nia.test.near and ravi.test.near
     HELD   group 4: sent funds to the same account, wes.test.near (evidence: 2 transactions)
              sol.test.near and tara.test.near
     CLEAR  5904097e..., c84b6c1e..., uma.test.near and vik.test.near
     Seen, but not linked, because each runs through a service:
       wallet-sponsor.test.near: created more than 20 accounts
       the key ed25519:8zwf6Ym7...: held by more than 20 accounts
       exchange.test.near: received funds from more than 20 accounts
       dao.test.near: this round's DAO
   The full report is out/demo/report.md; the verdict carries the SHA-256 of report.json
   (bb0aa39a060b1e00...). post_verdict: 12 of 16 recipients held, 4 cleared.
   The contract would refuse a second verdict, a verdict from any other account, or one naming an
   account that is not on the list.

6. The council funds the round, by vote
   The Requestor fills Trezu's "Fund a screened round (USDC)" template: the token's ft_transfer_call to
   Headcount for the round's exact total, with the round id as its message, the same call Trezu's bulk
   payments file. Two approvals (proposal 1). Headcount keeps the tokens only because the token, the
   sender (the DAO) and the amount all match. It now holds 114.275001 tokens, for this round only.

7. Anyone pays the cleared recipients
   (Each recipient first registers with the token, as every NEP-141 recipient must.)
   alice.test.near, who holds no role anywhere, calls payout_batch: the 4 cleared recipients get
   exactly their amounts (33.15 tokens). The 12 held get nothing.
   alice.test.near tries again: refused, "its 12 held recipient(s) wait for a council vote".

8. The council decides one held group
   nia.test.near and ravi.test.near turn out to be a couple who share a household.
   The Requestor fills Trezu's "Decide a held group" template: group 3, "ReleaseAll". Two approvals
   (proposal 2). The next batch pays them both, exactly (13.25 tokens).

9. Nobody decides the other three groups
   The 10-minute hold window passes (the sandbox clock is moved forward rather than waited out).
   Now anyone may call refund_expired. It sends the 10 remaining held shares, 67.875001 tokens,
   back to dao.test.near: the DAO's balance rises by exactly that.

10. The books
   Funded 114.275001 = paid 46.4 (6 recipients) + returned 67.875001 (10 recipients).
   Headcount holds 0 tokens. get_round keeps each payment's state and each group's outcome on chain:
     group 1 Expired, group 2 Expired, group 3 ReleasedAll, group 4 Expired.
   get_account_record counts each account's record with this DAO, from the rounds the DAO funded:
     nia.test.near: listed 1, held 1, paid 1, returned 0
     3e93ca93... (farm A): listed 1, held 1, paid 0, returned 1
     uma.test.near: listed 1, held 0, paid 1, returned 0

Done in 11 s. Every step above was checked as it ran: a mismatch would have
stopped the demo with an error.
```

### What `npm test` prints

`npm test` ends with `pass 115` and `fail 0`. Node runs the test files side by side and prints each
file's lines together. The sandbox files print one story line per scenario:

| Tests | What they show |
|---|---|
| `ts/sandbox/dao.test.ts` (4) | The DAO alone: it runs the factory's exact v3.2 bytes; a `FunctionCall` proposal passes on the second Approver vote and runs in that same transaction; a vote must carry the stored proposal kind back (`ERR_WRONG_KIND`); a Requestor cannot approve, and neither an Approver nor an Admin can file a payment |
| `ts/sandbox/demo.test.ts` (1) | `npm run demo` with its narration collected instead of printed: every step checks out and the books close |
| `ts/sandbox/headcount.test.ts` (21) | The design's scenarios 1, 2 and 4 to 13 against the real DAO, on verdicts written by hand (lines below), and a round in a token the DAO did not list refused. Each refused funding checks Headcount's own logged reason, not only the balances: a contract with no `ft_on_transfer` at all would also see tokens bounce. Every payout and refund is checked against the receiving account's balance, to the unit, and scenario 13 checks every round `get_rounds` lists |
| `ts/sandbox/least-gas.test.ts` (4) | The largest rounds the bounds allow, in NEAR and in a token: 100 recipients with 64-character ids, 98 held, a 220 KB verdict. Paid, decided and refunded, each time with the least whole TGas that succeeds (found 1 TGas at a time); every callback still finishes, and no payment is left `Paying` or `Refunding` |
| `ts/sandbox/near-payout.test.ts` (4) | A round paid in NEAR: funded by a vote that attaches exactly its total; two named accounts paid exactly; six implicit accounts created by their own payments; a payment to an account that does not exist fails and goes back to the DAO to the yoctoNEAR; the council pays one held account and returns the other's share; then each account's record (`get_account_record`). The first batch gets gas for one account creation at its real cost, not for all nine |
| `ts/sandbox/screener.test.ts` (2) | Scenario 3: the screener scans every block of the sandbox, holds exactly the four planted farms, clears every decoy, and posts its verdict |
| `ts/sandbox/templates.test.ts` (3) | The three Trezu templates: each proposal filed exactly as Trezu's own engine built it, and what each vote did |
| `ts/test/templates.test.ts`, `templates-cli.test.ts` (9) | The manifests against Trezu's format, their proposals against Trezu's own output to the byte, and `npm run templates` |
| `ts/test/list-id.test.ts` (7) | The TypeScript list id against Trezu's own ids, and the CSV parser: Trezu's two columns, amounts in whole tokens, refusing rather than rounding an amount with more decimals than the token has |
| `ts/test/screener.test.ts`, `block-scan.test.ts` (20) | The screen's rule on in-memory chains, and the sandbox block scan on hand-written transactions |
| `ts/test/fastnear.test.ts`, `mainnet-screen.test.ts`, `paced-fetch.test.ts`, `screener-cli.test.ts`, `trezu-list.test.ts` (40) | Mainnet mode against a pretend FastNEAR: the reader, the pacing, the CLI and board, and Trezu's `view_list` |

<details>
<summary>The story lines <code>ts/sandbox/headcount.test.ts</code> prints</summary>

```
  dao.test.near: Sputnik 2.3.1 with Trezu roles; Headcount at headcount.test.near, which holds no role in the DAO
  CONFIGURED by vote (proposal 0, Approved): dao.test.near names screener.test.near, 2-day windows
✔ scenario 1: the DAO names its screener through a FunctionCall proposal and two approvals
  REFUSED: the Requestor calling configure for the DAO directly, outside a vote
✔ only the DAO itself can configure it: the Requestor's direct call is refused
  REFUSED: alice creating a round of the DAO's in her own "token": only token.test.near, which the DAO listed by vote, and NEAR
✔ a round of the DAO's in a token it did not list is refused, so a stranger's own token contract cannot fake the DAO's funding
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
  Transfer{msg}, deciding vote 250 TGas: funded; ft_on_transfer was given 114.52 TGas and the receipt burnt 2.40 TGas
  Transfer{msg}, deciding vote 30 TGas: funded; ft_on_transfer was given 4.52 TGas and the receipt burnt 2.40 TGas
✔ a Sputnik Transfer proposal with msg also funds a round: Sputnik's 10 TGas is a floor, not a cap
  PAID by an outsider in 2 batches (5 with 100 TGas, then 6): 10 cleared recipients got exactly their amounts; r16.test.near is not registered with the token, so its transfer failed and is kept for the DAO; the 5 held got nothing. Each ft_transfer burnt 1.74 TGas at most, the callback 1.84
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
  BOOKS BALANCE over all 6 rounds get_rounds lists: the 5 funded are settled with paid + refunded = funded, and the edited one was never funded. Headcount holds 0 of each token, and its NEAR beyond storage is up 0.00226 NEAR since deployment: its gas rewards
✔ scenario 13: over every round Headcount lists, paid + refunded = funded, and Headcount keeps none of the money
```

(`2.3.1` is the `sputnikdao2` crate version; the factory calls this release v3.2. Gas figures move
by a few hundredths of a TGas from run to run, and the gas rewards in the last line by a little more.)

</details>

The scenario numbers are the design's. Every scenario runs. Scenario 3 is the screener reading the
sandbox chain and posting its own verdict; the others use verdicts written by hand. To run scenarios 9
and 10 past a deadline in seconds, the DAO first votes its windows down to 60 seconds, and the sandbox
clock is moved forward with empty blocks rather than waited out; round16 keeps the 2-day windows it
was created with.

`cargo test` runs the contract's 122 unit tests on near-sdk's mocked VM: who may configure, the
tokens a DAO lists and the rounds they allow, the list checks, storage charged to the caller and the rest of the deposit returned, every funding refusal,
every verdict check, the three Trezu list-id vectors, and for payouts: batches in list order and
within their gas, each transfer recorded paid or failed, nothing paid twice or while held, only the
DAO deciding a group, every deadline to the second, a round run through every path at once whose
transfers add up to its total, every call that moves money costing the same gas whatever the
verdict's size, and each account's record with a DAO: read in pages, untouched by another DAO's
rounds, and empty of any round the DAO did not fund (a stranger's round in a token contract of
their own is refused outright).

Set `NEAR_PRINT_LOGS=1` to see every receipt log and refusal the sandbox prints.

### The DAO in the sandbox is the real one

- **Sputnik DAO v3.2, the factory's own bytes.** `sputnik-dao.near`, the mainnet factory, reports
  default version `[3, 2]` with code hash `DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF`.
  `scripts/fetch-sputnik.mjs` reads those bytes with one keyless view call (`get_code`) and refuses
  them unless they hash to that value; a sandbox test asserts the deployed DAO's code hash equals it.
  The factory maps the hash to commit `2b0f34a3` of
  [near-daos/sputnik-dao-contract](https://github.com/near-daos/sputnik-dao-contract) (MIT). The
  sandbox's round token is that commit's NEP-141 test token: its source is in `crates/test-token`,
  copied unmodified with Sputnik's license beside it, and it builds in this workspace with the same
  Rust, near-sdk and release profile, in a cargo build of its own so its near-sdk features never
  reach Headcount's. The first run needs network access for the fetch.
- **Trezu's roles.** `trezuPolicy` in `ts/sandbox/harness.ts` writes the policy Trezu's backend
  writes when it creates a treasury (`build_policy` in
  [NEAR-DevHub/trezu](https://github.com/NEAR-DevHub/trezu), `nt-be/src/handlers/treasury/create.rs`):
  Requestor, Admin and Approver, a vote count for payments, a zero proposal bond and a seven-day
  voting period. It is rewritten, not copied.
- **The sandbox runs neard 2.13.4.** The neard that near-workspaces 5.0.0 installs, 2.6.2, cannot
  link Sputnik v3.2 (`UnknownImportError` for `promise_batch_action_deploy_global_contract`, from
  near-sdk's `global-contracts` feature). `scripts/ensure-sandbox.mjs` fetches 2.13.4 from NEAR's
  release bucket and checks the tarball's SHA-256 before using it.
- **A block every 100 ms.** `ts/sandbox/sandbox.ts` starts each sandbox with neard's minimum block
  time at 100 ms instead of its default 600 ms, and refuses a sandbox whose `client_config` does
  not report it. A sandbox call waits for a few blocks, so this is most of how long the tests take
  (on a warm build the sandbox files went from 304 s to 44 s). Gas, fees and every protocol rule
  come from the genesis and protocol version, not from this setting: the gas figures in the story
  lines are the same either way. Moving the clock forward costs about 1 s of chain time per block.

### Trezu templates

Trezu lets a treasury add **custom proposal templates**: a JSON manifest that Trezu turns into a
form, which files one Sputnik `FunctionCall` proposal. `templates/` holds one for each vote
Headcount asks of a council:

| Template | What it files | What the form asks |
|---|---|---|
| "Name the screener" (`headcount-name-screener.json`) | `configure` on Headcount, listing the round token as the one token its rounds may pay in besides NEAR, with 0.01 NEAR for storage (the rest comes back), 30 TGas | the treasury's own account, the screener, the verdict and hold windows |
| "Fund a screened round (USDC)" (`headcount-fund-round-usdc.json`) | the token's `ft_transfer_call` to Headcount with the round id as `msg`, 1 yoctoNEAR, 100 TGas: the call Trezu's bulk payments already file | the round id, the round's total |
| "Decide a held group" (`headcount-resolve-group.json`) | `resolve_group` on Headcount, 60 TGas (the least that succeeds on the largest token round is 44 TGas) | the round id, the group number, the decision: `"ReleaseAll"`, `"Refund"` or `{"ReleaseOne": {"account_id": "..."}}` |

Trezu's hosted app needs a mainnet DAO, so the templates are checked this way instead:
- **Trezu's own code accepts them and builds the proposals.** Run outside this repository at
  NEAR-DevHub/trezu `a6aaaf67`, Trezu's `parseManifest` accepted all three manifests and its
  `buildTemplateProposal` built six proposals from sample form values (run again for "Name the
  screener" after its arguments gained the token list; the other four came out byte-identical);
  `fixtures/trezu-template-proposals.json` records those outputs and each manifest's hash.
  `ts/src/templates.ts` reproduces every one to the byte (`ts/test/templates.test.ts`), including
  how a form value becomes typed JSON: a lone `{{group}}` of a `number` field reaches the contract
  as a number, a `json` field's decision as an object, and amounts stay digit strings. No Trezu code
  is in this repository (Trezu publishes no license).
- **The sandbox files exactly those proposals.** `ts/sandbox/templates.test.ts` has the Requestor
  file each proposal Trezu built, kind and description, on the real Sputnik v3.2 with Trezu's roles,
  two Approvers pass it, and the test checks what the call did: the screener is named, the round is
  funded with its exact total, and one held group pays one account and returns the other's share.
  `npm run demo` files all three for its round.

The manifests in `templates/` name the sandbox's accounts. For a real deployment, write copies
pointed at it, then paste each one into Trezu (the DAO, Custom, New template, Code tab; authoring
a template needs the DAO's ChangePolicy permission). Both accounts are required; nothing is assumed.
The token also becomes the one token the "Name the screener" vote lists:

```
npm run templates -- --headcount <Headcount contract> --token <the round's token, for example USDC's>
```

A NEAR round cannot be a template: Trezu fixes a template's deposit, and a NEAR round's deposit is
its total (NEAR rounds need no token listed). The DAO funds it with a `FunctionCall` proposal of its own that calls `fund_round` with
exactly the total attached, as `ts/sandbox/near-payout.test.ts` does.

### Mainnet, read-only (optional)

The judge's run never writes to mainnet: its one mainnet read is the keyless fetch of the Sputnik
factory's bytes at build time, cached in `out/` after the first run. For a treasurer who wants to try the screen on a real list,
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
board and the terminal. Most of its shortcuts err toward treating an account as a service, which
links fewer recipients: an account too busy to read within that slice counts as a service, and an
implicit account that received NEAR counts as created. Two do not, so mainnet mode can also link
recipients the sandbox reader would not: the key index lists current holders only, so a key many
accounts were created with and later removed is not a service there and can still link two
recipients created with it; and an account deleted and created again is read as its first creation,
where the sandbox reader takes the latest. `report.json` stays a pure function of what the chain
said; read limits live beside it in `run.json`.

The mainnet-mode tests need no network: the reader runs against a pretend FastNEAR (`ts/test/fastnear-world.ts`)
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

- **Sputnik DAO v3.2** (MIT), near-daos/sputnik-dao-contract at `2b0f34a3`: the DAO contract, as the
  exact bytes the mainnet factory stores (fetched, hash checked), and its NEP-141 test token, built
  from that commit; both used unmodified in the sandbox
- **near-sdk** `=5.24.1` for the contract, the version Sputnik v3.2 locks
- **near-workspaces** `5.0.0` and **near-api-js** `5.1.1`, dev-only, for the sandbox tests
- **near-sandbox**: neard `2.13.4`, NEAR's official build
- **binaryen** `123.0.0` (`wasm-opt`), dev-only, to lower wasm features NEAR's VM rejects
- **Trezu** (NEAR DevHub): we read how it configures a treasury's roles and mirror that policy, and
  Headcount uses its list-id formula. To check that formula we ran Trezu's own `generateListId`
  (and its backend's `compute_list_hash`) on synthetic lists, outside this repository; only the
  resulting ids are here, in `fixtures/trezu-list-ids.json`. Our three custom proposal templates
  follow Trezu's documented manifest format; to check them we ran Trezu's own `parseManifest` and
  `buildTemplateProposal` outside this repository, and only their outputs are here, in
  `fixtures/trezu-template-proposals.json`. No Trezu code is copied
- **No starter project or scaffold was used.** The repository layout is our own
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
                                 refund_expired, views (get_round, get_rounds, get_account_record)
crates/headcount/src/list_id.rs  Trezu's list id in Rust
crates/headcount/src/tests.rs    the contract's unit tests (cargo test)
fixtures/trezu-list-ids.json     ids Trezu's own generateListId computed for synthetic lists
fixtures/round-16.csv            the sandbox's 16-recipient list, in Trezu's CSV format
fixtures/trezu-template-proposals.json  what Trezu's own engine built from our three templates
templates/                       the three Trezu custom proposal templates (sandbox accounts)
crates/test-token/               Sputnik v3.2's NEP-141 test token (MIT, unmodified), the sandbox's round token
scripts/fetch-sputnik.mjs        fetch the factory's Sputnik v3.2 bytes (hash checked) into out/
scripts/build-contracts.mjs      build Headcount and the test token into out/, one cargo build each
scripts/wasm.mjs                 the wasm lowering and code hash both build scripts use
scripts/ensure-sandbox.mjs       put neard 2.13.4 where near-workspaces looks (tarball SHA-256 checked)
ts/src/list-id.ts                Trezu's list id and CSV parser in TypeScript
ts/test/list-id.test.ts          their tests
ts/src/templates.ts              Trezu's template format: check a manifest, build its proposal, retarget it
ts/src/templates-cli.ts          npm run templates: the manifests pointed at a real deployment
ts/demo/                         npm run demo: story.ts runs and checks the story, demo.ts prints it
ts/screener/                     the screener: rule, report, the sandbox block scan, and mainnet mode
                                 (fastnear.ts reader, paced-fetch.ts pacing, trezu-list.ts, cli.ts, board.ts)
ts/test/fastnear*.test.ts        the mainnet reader on a pretend FastNEAR; mainnet-screen.test.ts runs the screen on it
fixtures/fastnear/               one recorded FastNEAR response (a DAO's creation), call arguments removed
ts/sandbox/sandbox.ts            starts each sandbox: a block every 100 ms, removed when it stops
ts/sandbox/dao.test.ts           the DAO alone in the sandbox
ts/sandbox/headcount.test.ts     Headcount next to the DAO: the design's scenarios
ts/sandbox/near-payout.test.ts   a round paid in NEAR, start to finish
ts/sandbox/least-gas.test.ts     the largest rounds, paid, decided and refunded at the least gas that succeeds
ts/sandbox/screener.test.ts      scenario 3: the screener reads the chain and holds the planted farms
ts/sandbox/templates.test.ts     the three Trezu templates, filed as Trezu files them
ts/sandbox/demo.test.ts          npm run demo, run inside npm test
ts/sandbox/world.ts, send.ts     the planted world, and a sender for many transactions at once
ts/sandbox/harness.ts            Trezu's policy, proposal shapes, test helpers
rust-toolchain.toml              Rust 1.86 with the wasm target, the toolchain Sputnik v3.2 pins
.nvmrc                           Node 22.18.0, the oldest Node that runs the TypeScript without a flag
```

## License

MIT. See [LICENSE](LICENSE).
