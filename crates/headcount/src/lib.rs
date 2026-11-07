//! Headcount: screened reward rounds for Sputnik DAO and Trezu treasuries.
//!
//! A DAO names a screener by vote (`configure`). A requestor turns a payment list into a round
//! (`create_round`); the round's id is Trezu's list id for the same list, with the DAO as the
//! submitter. The DAO funds the round by vote, in NEAR (`fund_round`) or in a NEP-141 token
//! (`ft_transfer_call`, received by `ft_on_transfer`), and its screener posts which listed
//! recipients are linked (`post_verdict`). Still to come: payouts, council resolutions and refunds.
//!
//! Every byte Headcount stores is paid for by the call that stores it, and any deposit beyond that
//! cost goes straight back. So the contract's own balance only ever covers its own code and state,
//! and money a round holds is never spent on storage.

mod list_id;

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, env, near, require,
};

/// `token_id` of a round paid in NEAR, as Trezu's list ids write it.
pub const NATIVE: &str = "native";

/// Most payments one round can carry. Trezu's bulk payments pay at most 100 per batch.
pub const MAX_PAYMENTS: usize = 100;

/// Shortest window a DAO can set. Anything shorter is almost certainly milliseconds by mistake.
pub const MIN_WINDOW_SEC: u64 = 60;

/// Longest window a DAO can set: a year (and a day).
pub const MAX_WINDOW_SEC: u64 = 366 * 86_400;

/// Bounds on what a verdict may carry, so its storage and the gas to check it stay small.
pub const MAX_RULE_LEN: usize = 64;
pub const MAX_URL_LEN: usize = 256;
pub const MAX_SIGNALS: usize = 5;
pub const MAX_SIGNAL_LEN: usize = 32;
pub const MAX_EVIDENCE: usize = 32;
pub const MAX_EVIDENCE_LEN: usize = 128;

/// What a DAO configures, by vote: who screens its rounds, and how long a round waits.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaoConfig {
    /// The only account that can post a verdict on this DAO's rounds.
    pub screener_id: AccountId,
    /// How long a funded round waits for a verdict before all of it can go back to the DAO.
    pub verdict_window_sec: u64,
    /// How long a held group waits for a council vote before it can go back to the DAO.
    pub hold_window_sec: u64,
}

/// One line of a payment list, as `create_round` takes it.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PaymentInput {
    pub recipient: AccountId,
    /// In the token's smallest unit (yoctoNEAR for NEAR).
    pub amount: U128,
}

/// Where one payment stands.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaymentState {
    /// Not paid yet, and not held.
    Pending,
    /// In a group the screener linked: waits for a council vote.
    Held,
}

/// Recipients the screener found linked, and why. A held group goes to a council vote.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldGroup {
    /// Two or more accounts from the round's list.
    pub accounts: Vec<AccountId>,
    /// What links them, e.g. "same-funder", "shared-key", "direct-transfer", "shared-collector".
    pub signals: Vec<String>,
    /// Where to look: transaction hashes, or "key:ed25519:..." for a shared key.
    pub evidence: Vec<String>,
}

/// A screener's verdict on one round. An empty `groups` clears every recipient.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verdict {
    /// The block the screen read the chain up to.
    pub screened_at_block: u64,
    /// The rule that formed the groups, e.g. "hold-linked-v1".
    pub rule: String,
    pub groups: Vec<HeldGroup>,
    /// SHA-256 of the full evidence report, lowercase hex.
    pub report_sha256: String,
    pub report_url: Option<String>,
}

/// A verdict as posted: who posted it, and when.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PostedVerdict {
    pub screener_id: AccountId,
    pub posted_at_sec: u64,
    pub verdict: Verdict,
}

/// One payment of a round, as stored.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
struct Payment {
    recipient: AccountId,
    amount: u128,
    state: PaymentState,
}

/// A round, as stored. Every field that changes after creation has a fixed size, so funding a
/// round, which carries no storage deposit, never grows storage.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
struct Round {
    dao_id: AccountId,
    token_id: String,
    /// Trezu's list timestamp: part of the id, nothing else.
    timestamp: u64,
    /// Sorted by recipient in byte order, the order the id hashes them in.
    payments: Vec<Payment>,
    total: u128,
    /// Who called `create_round` and paid `storage_deposit` for it.
    creator_id: AccountId,
    storage_deposit: u128,
    created_at_sec: u64,
    /// The DAO's windows when the round was created; a later `configure` does not move them.
    verdict_window_sec: u64,
    hold_window_sec: u64,
    /// When the DAO funded the round; 0 until then.
    funded_at_sec: u64,
    /// Posted once by the DAO's screener, who pays the storage it takes.
    verdict: Option<PostedVerdict>,
}

/// A payment, as the views return it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentView {
    pub recipient: AccountId,
    pub amount: U128,
    pub state: PaymentState,
}

/// A round, as the views return it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoundView {
    pub round_id: String,
    pub dao_id: AccountId,
    pub token_id: String,
    pub timestamp: u64,
    pub payments: Vec<PaymentView>,
    pub total: U128,
    pub creator_id: AccountId,
    pub storage_deposit: U128,
    pub created_at_sec: u64,
    pub verdict_window_sec: u64,
    pub hold_window_sec: u64,
    pub funded_at_sec: Option<u64>,
    pub verdict: Option<PostedVerdict>,
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Configs,
    Rounds,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Headcount {
    configs: LookupMap<AccountId, DaoConfig>,
    rounds: LookupMap<String, Round>,
}

#[near]
impl Headcount {
    #[init]
    pub fn new() -> Self {
        Self {
            configs: LookupMap::new(StorageKey::Configs),
            rounds: LookupMap::new(StorageKey::Rounds),
        }
    }

    /// Names the screener for `dao_id`'s rounds and sets its windows. Only `dao_id` itself can call
    /// this, so for a Sputnik DAO it takes a `FunctionCall` proposal and a vote. Payable: attach
    /// enough for the storage; the rest comes back.
    ///
    /// The DAO is named explicitly so that a member who calls this from their own account, rather
    /// than through a proposal, is refused instead of silently configuring their own account.
    #[payable]
    pub fn configure(
        &mut self,
        dao_id: AccountId,
        screener_id: AccountId,
        verdict_window_sec: u64,
        hold_window_sec: u64,
    ) {
        require!(
            env::predecessor_account_id() == dao_id,
            format!(
                "only {dao_id} itself can configure {dao_id}: file a FunctionCall proposal on the DAO"
            )
        );
        check_window("verdict_window_sec", verdict_window_sec);
        check_window("hold_window_sec", hold_window_sec);

        let before = env::storage_usage();
        self.configs.insert(
            dao_id.clone(),
            DaoConfig {
                screener_id: screener_id.clone(),
                verdict_window_sec,
                hold_window_sec,
            },
        );
        self.configs.flush();
        settle_storage(before, &dao_id);
        env::log_str(&format!(
            "configure: {dao_id} names {screener_id} as its screener; verdict window {verdict_window_sec} s, hold window {hold_window_sec} s"
        ));
    }

    /// Turns a payment list into a round of `dao_id`'s and returns its id: Trezu's list id for the
    /// same list with `dao_id` as the submitter. Anyone can create a round; only the DAO can fund it.
    /// Payable: the caller pays the round's storage, and the rest of the deposit comes back.
    ///
    /// `token_id` is `"native"` for NEAR or a NEP-141 contract; amounts are in its smallest unit.
    /// `timestamp` is Trezu's list timestamp, so the same list can be paid again as a new round.
    #[payable]
    pub fn create_round(
        &mut self,
        dao_id: AccountId,
        token_id: String,
        payments: Vec<PaymentInput>,
        timestamp: u64,
    ) -> String {
        let config = self
            .configs
            .get(&dao_id)
            .unwrap_or_else(|| {
                env::panic_str(&format!(
                    "{dao_id} has not named a screener: the DAO must call configure first"
                ))
            })
            .clone();
        let (payments, total) = checked_list(&token_id, payments);
        let round_id = id_of(&dao_id, &token_id, &payments, timestamp);
        require!(
            !self.rounds.contains_key(&round_id),
            format!("round {round_id} already exists")
        );

        let creator_id = env::predecessor_account_id();
        let before = env::storage_usage();
        self.rounds.insert(
            round_id.clone(),
            Round {
                dao_id: dao_id.clone(),
                token_id: token_id.clone(),
                timestamp,
                payments,
                total,
                creator_id: creator_id.clone(),
                // Rewritten below once the cost is known; a u128 takes the same bytes either way.
                storage_deposit: 0,
                created_at_sec: now_sec(),
                verdict_window_sec: config.verdict_window_sec,
                hold_window_sec: config.hold_window_sec,
                funded_at_sec: 0,
                verdict: None,
            },
        );
        self.rounds.flush();
        let cost = settle_storage(before, &creator_id);
        if let Some(round) = self.rounds.get_mut(&round_id) {
            round.storage_deposit = cost.as_yoctonear();
        }
        env::log_str(&format!(
            "create_round: {round_id} for {dao_id}, {} payments, total {total} {token_id}",
            self.rounds.get(&round_id).map_or(0, |r| r.payments.len())
        ));
        round_id
    }

    /// The id `create_round` would give this list, without creating anything.
    pub fn list_id(
        &self,
        dao_id: AccountId,
        token_id: String,
        payments: Vec<PaymentInput>,
        timestamp: u64,
    ) -> String {
        let (payments, _) = checked_list(&token_id, payments);
        id_of(&dao_id, &token_id, &payments, timestamp)
    }

    pub fn get_config(&self, dao_id: AccountId) -> Option<DaoConfig> {
        self.configs.get(&dao_id).cloned()
    }

    pub fn get_round(&self, round_id: String) -> Option<RoundView> {
        let round = self.rounds.get(&round_id)?;
        Some(RoundView {
            round_id,
            dao_id: round.dao_id.clone(),
            token_id: round.token_id.clone(),
            timestamp: round.timestamp,
            payments: round
                .payments
                .iter()
                .map(|p| PaymentView {
                    recipient: p.recipient.clone(),
                    amount: U128(p.amount),
                    state: p.state,
                })
                .collect(),
            total: U128(round.total),
            creator_id: round.creator_id.clone(),
            storage_deposit: U128(round.storage_deposit),
            created_at_sec: round.created_at_sec,
            verdict_window_sec: round.verdict_window_sec,
            hold_window_sec: round.hold_window_sec,
            funded_at_sec: (round.funded_at_sec != 0).then_some(round.funded_at_sec),
            verdict: round.verdict.clone(),
        })
    }

    pub fn get_verdict(&self, round_id: String) -> Option<PostedVerdict> {
        self.rounds.get(&round_id)?.verdict.clone()
    }

    /// Funds a NEAR round. Only the round's DAO can call it, attaching exactly the round's total,
    /// so for a Sputnik DAO it is a `FunctionCall` proposal with that deposit. Anything else is
    /// refused and the deposit goes back.
    #[payable]
    pub fn fund_round(&mut self, round_id: String) {
        let round = self.round_mut(&round_id);
        require!(
            round.token_id == NATIVE,
            format!(
                "round {round_id} pays in {token}: the DAO funds it with ft_transfer_call on {token}",
                token = round.token_id
            )
        );
        require!(
            env::predecessor_account_id() == round.dao_id,
            format!("only {} can fund its round", round.dao_id)
        );
        require!(
            round.funded_at_sec == 0,
            format!("round {round_id} is already funded")
        );
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached == round.total,
            format!(
                "attach exactly {} yoctoNEAR, the round's total; {attached} attached",
                round.total
            )
        );
        round.funded_at_sec = now_sec();
        env::log_str(&format!(
            "fund_round: {round_id} funded with {attached} yoctoNEAR"
        ));
    }

    /// NEP-141: a token round is funded by the DAO's `ft_transfer_call(headcount, total, msg =
    /// round_id)` on the round's token, the call Trezu's bulk payments already file. Keeps the
    /// tokens (returns 0) only when the token, the sender, the amount and the round all match;
    /// otherwise returns the full amount, which the token sends back.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let token = env::predecessor_account_id();
        match self.accept_token_funding(&token, &sender_id, amount.0, &msg) {
            Ok(()) => {
                env::log_str(&format!(
                    "ft_on_transfer: {msg} funded with {} of {token}",
                    amount.0
                ));
                U128(0)
            }
            Err(why) => {
                env::log_str(&format!("ft_on_transfer: refused, sent back: {why}"));
                amount
            }
        }
    }

    /// The DAO's screener posts its verdict on a round, once. Each held group names two or more
    /// accounts from the round's list, and no account is in two groups. The verdict must come
    /// within the round's verdict window, counted from its creation or, once funded, its funding.
    /// Payable: the screener pays the verdict's storage; the rest comes back.
    #[payable]
    pub fn post_verdict(&mut self, round_id: String, verdict: Verdict) {
        let screener_id = env::predecessor_account_id();
        let dao_id = self.round_mut(&round_id).dao_id.clone();
        let named = self.configs.get(&dao_id).map(|c| c.screener_id.clone());
        require!(
            named.as_ref() == Some(&screener_id),
            format!("{screener_id} is not this DAO's screener")
        );
        let now = now_sec();
        let round = self.round_mut(&round_id);
        require!(
            round.verdict.is_none(),
            format!("round {round_id} already has a verdict")
        );
        let deadline = round.created_at_sec.max(round.funded_at_sec) + round.verdict_window_sec;
        require!(
            now <= deadline,
            format!("the verdict window closed at {deadline} (unix seconds); it is now {now}")
        );
        check_verdict_fields(&verdict);
        let held = held_positions(&round.payments, &verdict.groups);

        let before = env::storage_usage();
        for i in held {
            round.payments[i].state = PaymentState::Held;
        }
        let groups = verdict.groups.len();
        round.verdict = Some(PostedVerdict {
            screener_id: screener_id.clone(),
            posted_at_sec: now,
            verdict,
        });
        self.rounds.flush();
        settle_storage(before, &screener_id);
        env::log_str(&format!(
            "post_verdict: {screener_id} holds {groups} group(s) in round {round_id}"
        ));
    }
}

impl Headcount {
    /// The round, for changing; refuses an id that names no round.
    fn round_mut(&mut self, round_id: &str) -> &mut Round {
        self.rounds
            .get_mut(round_id)
            .unwrap_or_else(|| env::panic_str(&format!("no round {round_id}")))
    }

    /// Marks a token round funded if `token` is its token, `sender` its DAO and `amount` its
    /// total, and it is not funded yet. Otherwise says why not and changes nothing.
    fn accept_token_funding(
        &mut self,
        token: &AccountId,
        sender: &AccountId,
        amount: u128,
        round_id: &str,
    ) -> Result<(), String> {
        let round = self
            .rounds
            .get_mut(round_id)
            .ok_or_else(|| format!("no round {round_id}"))?;
        if round.token_id != token.as_str() {
            return Err(format!(
                "round {round_id} pays in {}, not {token}",
                round.token_id
            ));
        }
        if *sender != round.dao_id {
            return Err(format!(
                "only {} can fund its round, not {sender}",
                round.dao_id
            ));
        }
        if round.funded_at_sec != 0 {
            return Err(format!("round {round_id} is already funded"));
        }
        if amount != round.total {
            return Err(format!(
                "round {round_id}'s total is {}, got {amount}",
                round.total
            ));
        }
        round.funded_at_sec = now_sec();
        Ok(())
    }
}

/// Refuses a verdict whose fields are out of bounds. The bounds keep its storage and checks small.
fn check_verdict_fields(verdict: &Verdict) {
    require!(
        (1..=MAX_RULE_LEN).contains(&verdict.rule.len()),
        format!("rule must be 1 to {MAX_RULE_LEN} characters")
    );
    require!(
        verdict.report_sha256.len() == 64
            && verdict
                .report_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "report_sha256 must be 64 lowercase hex characters"
    );
    require!(
        verdict
            .report_url
            .as_ref()
            .is_none_or(|url| url.len() <= MAX_URL_LEN),
        format!("report_url must be at most {MAX_URL_LEN} characters")
    );
    for (i, group) in verdict.groups.iter().enumerate() {
        let n = i + 1;
        require!(
            (1..=MAX_SIGNALS).contains(&group.signals.len())
                && group
                    .signals
                    .iter()
                    .all(|s| (1..=MAX_SIGNAL_LEN).contains(&s.len())),
            format!(
                "group {n} needs 1 to {MAX_SIGNALS} signals of 1 to {MAX_SIGNAL_LEN} characters"
            )
        );
        require!(
            group.evidence.len() <= MAX_EVIDENCE
                && group.evidence.iter().all(|e| e.len() <= MAX_EVIDENCE_LEN),
            format!(
                "group {n} may cite at most {MAX_EVIDENCE} pieces of evidence of up to {MAX_EVIDENCE_LEN} characters"
            )
        );
    }
}

/// Positions in `payments` (sorted by recipient) of every account the verdict holds. Refuses a
/// group of fewer than 2, an account that is not on the list, and an account named twice.
fn held_positions(payments: &[Payment], groups: &[HeldGroup]) -> Vec<usize> {
    let mut held: Vec<usize> = Vec::new();
    for (i, group) in groups.iter().enumerate() {
        require!(
            group.accounts.len() >= 2,
            format!(
                "a held group needs at least 2 accounts; group {} has {}",
                i + 1,
                group.accounts.len()
            )
        );
        for account in &group.accounts {
            let position = payments
                .binary_search_by(|p| p.recipient.as_str().cmp(account.as_str()))
                .unwrap_or_else(|_| {
                    env::panic_str(&format!("{account} is not on this round's list"))
                });
            require!(
                !held.contains(&position),
                format!("{account} appears twice in the verdict")
            );
            held.push(position);
        }
    }
    held
}

/// Current block time, in seconds.
fn now_sec() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn check_window(name: &str, seconds: u64) {
    require!(
        (MIN_WINDOW_SEC..=MAX_WINDOW_SEC).contains(&seconds),
        format!(
            "{name} must be between {MIN_WINDOW_SEC} and {MAX_WINDOW_SEC} seconds, got {seconds}"
        )
    );
}

/// Validates a payment list and returns it sorted by recipient in byte order, with its total.
fn checked_list(token_id: &str, payments: Vec<PaymentInput>) -> (Vec<Payment>, u128) {
    require!(
        token_id == NATIVE || token_id.parse::<AccountId>().is_ok(),
        format!(
            "token_id must be \"{NATIVE}\" (NEAR) or a NEP-141 token contract, not {token_id:?}"
        )
    );
    require!(
        (1..=MAX_PAYMENTS).contains(&payments.len()),
        format!(
            "a round pays 1 to {MAX_PAYMENTS} recipients, this list has {}",
            payments.len()
        )
    );
    let me = env::current_account_id();
    let mut sorted: Vec<Payment> = payments
        .into_iter()
        .map(|p| {
            require!(
                p.amount.0 > 0,
                format!("{} has an amount of 0", p.recipient)
            );
            require!(p.recipient != me, "Headcount itself cannot be a recipient");
            Payment {
                recipient: p.recipient,
                amount: p.amount.0,
                state: PaymentState::Pending,
            }
        })
        .collect();
    sorted.sort_by(|a, b| a.recipient.as_str().cmp(b.recipient.as_str()));
    for pair in sorted.windows(2) {
        require!(
            pair[0].recipient != pair[1].recipient,
            format!("{} is listed twice", pair[0].recipient)
        );
    }
    let total = sorted
        .iter()
        .try_fold(0u128, |sum, p| sum.checked_add(p.amount))
        .unwrap_or_else(|| env::panic_str("the total overflows"));
    (sorted, total)
}

/// Trezu's list id for a sorted list, with the DAO as the submitter.
fn id_of(dao_id: &AccountId, token_id: &str, sorted: &[Payment], timestamp: u64) -> String {
    let canonical: Vec<list_id::CanonicalPayment<'_>> = sorted
        .iter()
        .map(|p| list_id::CanonicalPayment {
            recipient: &p.recipient,
            amount: p.amount,
        })
        .collect();
    list_id::list_id(dao_id, token_id, &canonical, timestamp)
}

/// Charges `payer` for the bytes the current call added since `before`, out of the attached
/// deposit, and sends the rest of the deposit back. If the call freed bytes, their cost goes back
/// too. Every write must be flushed first. Returns the charge.
fn settle_storage(before: u64, payer: &AccountId) -> NearToken {
    let after = env::storage_usage();
    let byte_cost = env::storage_byte_cost();
    let deposit = env::attached_deposit();
    let cost = byte_cost.saturating_mul(u128::from(after.saturating_sub(before)));
    let freed = byte_cost.saturating_mul(u128::from(before.saturating_sub(after)));
    require!(
        deposit >= cost,
        format!(
            "attach at least {} yoctoNEAR for the {} bytes this stores; {} attached",
            cost.as_yoctonear(),
            after.saturating_sub(before),
            deposit.as_yoctonear()
        )
    );
    let refund = deposit.saturating_sub(cost).saturating_add(freed);
    if !refund.is_zero() {
        Promise::new(payer.clone()).transfer(refund).detach();
    }
    cost
}

#[cfg(test)]
mod tests;
