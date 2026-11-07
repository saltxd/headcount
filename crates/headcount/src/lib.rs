//! Headcount: screened reward rounds for Sputnik DAO and Trezu treasuries.
//!
//! A DAO names a screener by vote (`configure`). A requestor turns a payment list into a round
//! (`create_round`); the round's id is Trezu's list id for the same list, with the DAO as the
//! submitter. Built so far: `configure` and `create_round`, with storage paid by whoever causes it.
//! Still to come: funding, the screener's verdict, payouts, council resolutions and refunds.
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
        })
    }
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
