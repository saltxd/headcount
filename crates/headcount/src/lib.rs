//! Headcount: screened reward rounds for Sputnik DAO and Trezu treasuries.
//!
//! A DAO names a screener by vote (`configure`). A requestor turns a payment list into a round
//! (`create_round`); the round's id is Trezu's list id for the same list, with the DAO as the
//! submitter. The DAO funds the round by vote, in NEAR (`fund_round`) or in a NEP-141 token
//! (`ft_transfer_call`, received by `ft_on_transfer`), and its screener posts which listed
//! recipients are linked (`post_verdict`).
//!
//! Then anyone can pay the cleared recipients, in batches (`payout_batch`). Each held group waits
//! for a council vote (`resolve_group`): release all of it, release one account and return the
//! rest, or return all of it. Whatever nobody decides in time, a funded round that never got a
//! verdict, and any payment whose transfer failed, anyone can send back to the DAO
//! (`refund_expired`). So money leaves Headcount only to a listed recipient the verdict cleared, to
//! a held recipient the council released, or to the DAO.
//!
//! Every byte Headcount stores is paid for by the call that stores it, and any deposit beyond that
//! cost goes straight back. So the contract's own balance only ever covers its own code and state,
//! and money a round holds is never spent on storage: funding, paying and refunding a round never
//! grow it. Headcount's own balance only pays the 1 yoctoNEAR each token transfer attaches, which
//! the gas rewards of its calls cover many times over.

mod list_id;

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseError,
    env, near, require,
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

/// Gas each `ft_transfer` gets: the static gas Sputnik DAO gives its own token transfers.
pub const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(10);

/// What one payment adds to a batch: its transfer receipt's fees (about 1.3 TGas on protocol 86),
/// the `ft_transfer`'s own gas for a token, and a margin.
pub const GAS_PER_FT_PAYMENT: Gas = Gas::from_tgas(12);
pub const GAS_PER_NEAR_PAYMENT: Gas = Gas::from_tgas(1);

/// Static gas for the callback that records how a batch of transfers went. It also gets every
/// unit of gas the calling method leaves unused.
pub const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(10);

/// Gas a paying or refunding method keeps back for its own remaining work: writing the round and
/// the callback receipt's fees.
pub const GAS_RESERVE: Gas = Gas::from_tgas(10);

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

/// Where one payment stands. Every variant is a bare tag of the same size, so a payment changing
/// state never grows storage.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaymentState {
    /// Not paid yet, and not held: `payout_batch` pays it once the round is funded and screened.
    Pending,
    /// In a group the screener linked: waits for a council vote, or for the hold window to end.
    Held,
    /// Held, then released by a council vote: `payout_batch` pays it.
    Released,
    /// A transfer to the recipient is in flight.
    Paying,
    /// The recipient was paid.
    Paid,
    /// A transfer failed (for example, the recipient never registered with the token, or the
    /// account does not exist). The amount can only go back to the DAO, through `refund_expired`.
    Failed,
    /// A transfer back to the DAO is in flight.
    Refunding,
    /// Back with the DAO.
    Refunded,
}

/// The council's decision on one held group, passed to `resolve_group`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Pay every account in the group.
    ReleaseAll,
    /// Pay this one account of the group, and send the others' amounts back to the DAO.
    ReleaseOne { account_id: AccountId },
    /// Send the whole group's amounts back to the DAO.
    Refund,
}

/// What became of a held group.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GroupState {
    /// Waiting for a council vote.
    Open,
    /// The council released every account.
    ReleasedAll,
    /// The council released one account and sent the rest back to the DAO.
    ReleasedOne,
    /// The council sent the whole group back to the DAO.
    Refunded,
    /// Nobody decided within the hold window; the group went back to the DAO.
    Expired,
}

/// A held group's outcome, as stored. Fixed size, so recording a decision never grows storage;
/// the screener pays for one per group when posting the verdict.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug)]
struct GroupRecord {
    state: GroupState,
    /// For `ReleasedOne`: the released account's position in the group's `accounts`.
    released: u32,
    /// When the council decided, or the group expired; 0 while open.
    decided_at_sec: u64,
}

/// A held group, as the views return it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GroupView {
    /// The group's number, counting from 1 in the verdict's order: what `resolve_group` takes.
    pub group: u32,
    pub accounts: Vec<AccountId>,
    pub state: GroupState,
    /// For `ReleasedOne`: the account the council released.
    pub released: Option<AccountId>,
    pub decided_at_sec: Option<u64>,
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
    /// One per held group of the verdict, in its order; added with the verdict.
    groups: Vec<GroupRecord>,
    /// What reached recipients, and what reached the DAO back, as each transfer confirmed. A
    /// settled round has `paid + refunded == total`.
    paid: u128,
    refunded: u128,
}

impl Round {
    /// The last second a verdict can be posted: the verdict window counts from the round's
    /// creation or, once it is funded, from its funding.
    fn verdict_deadline(&self) -> u64 {
        self.created_at_sec.max(self.funded_at_sec) + self.verdict_window_sec
    }

    /// The last second a held group waits for the council before anyone can send it back to the
    /// DAO. The hold window counts from the later of the verdict and the funding.
    fn hold_deadline(&self) -> Option<u64> {
        let posted = self.verdict.as_ref()?;
        (self.funded_at_sec != 0)
            .then(|| posted.posted_at_sec.max(self.funded_at_sec) + self.hold_window_sec)
    }

    fn count(&self, state: PaymentState) -> usize {
        self.payments.iter().filter(|p| p.state == state).count()
    }

    fn view(&self, round_id: String) -> RoundView {
        let groups = match &self.verdict {
            None => Vec::new(),
            Some(posted) => posted
                .verdict
                .groups
                .iter()
                .zip(&self.groups)
                .zip(1..)
                .map(|((group, record), number)| GroupView {
                    group: number,
                    accounts: group.accounts.clone(),
                    state: record.state,
                    released: (record.state == GroupState::ReleasedOne)
                        .then(|| group.accounts[record.released as usize].clone()),
                    decided_at_sec: (record.decided_at_sec != 0).then_some(record.decided_at_sec),
                })
                .collect(),
        };
        RoundView {
            round_id,
            dao_id: self.dao_id.clone(),
            token_id: self.token_id.clone(),
            timestamp: self.timestamp,
            payments: self
                .payments
                .iter()
                .map(|p| PaymentView {
                    recipient: p.recipient.clone(),
                    amount: U128(p.amount),
                    state: p.state,
                })
                .collect(),
            total: U128(self.total),
            creator_id: self.creator_id.clone(),
            storage_deposit: U128(self.storage_deposit),
            created_at_sec: self.created_at_sec,
            verdict_window_sec: self.verdict_window_sec,
            hold_window_sec: self.hold_window_sec,
            funded_at_sec: (self.funded_at_sec != 0).then_some(self.funded_at_sec),
            verdict: self.verdict.clone(),
            groups,
            paid: U128(self.paid),
            refunded: U128(self.refunded),
            verdict_deadline_sec: self.verdict_deadline(),
            hold_deadline_sec: self.hold_deadline(),
        }
    }
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
    /// The verdict's held groups and what became of each.
    pub groups: Vec<GroupView>,
    /// Confirmed paid to recipients, and confirmed back with the DAO.
    pub paid: U128,
    pub refunded: U128,
    /// The last second a verdict can be posted (unix seconds).
    pub verdict_deadline_sec: u64,
    /// Once the round is funded and screened: the last second its held groups wait for a council
    /// vote before anyone can send them back to the DAO.
    pub hold_deadline_sec: Option<u64>,
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Configs,
    Rounds,
    RoundCounts,
    RoundIndex,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Headcount {
    configs: LookupMap<AccountId, DaoConfig>,
    rounds: LookupMap<String, Round>,
    /// How many rounds each DAO has, and their ids in creation order, for `get_rounds`.
    round_counts: LookupMap<AccountId, u32>,
    round_index: LookupMap<(AccountId, u32), String>,
}

#[near]
impl Headcount {
    #[init]
    pub fn new() -> Self {
        Self {
            configs: LookupMap::new(StorageKey::Configs),
            rounds: LookupMap::new(StorageKey::Rounds),
            round_counts: LookupMap::new(StorageKey::RoundCounts),
            round_index: LookupMap::new(StorageKey::RoundIndex),
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
                groups: Vec::new(),
                paid: 0,
                refunded: 0,
            },
        );
        let n = self.round_counts.get(&dao_id).copied().unwrap_or(0);
        self.round_index
            .insert((dao_id.clone(), n), round_id.clone());
        self.round_counts.insert(dao_id.clone(), n + 1);
        self.rounds.flush();
        self.round_index.flush();
        self.round_counts.flush();
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
        Some(round.view(round_id))
    }

    /// `dao_id`'s rounds in the order they were created, `limit` of them from `from_index`.
    pub fn get_rounds(&self, dao_id: AccountId, from_index: u32, limit: u32) -> Vec<RoundView> {
        let count = self.round_counts.get(&dao_id).copied().unwrap_or(0);
        (from_index..count.min(from_index.saturating_add(limit)))
            .filter_map(|i| {
                let id = self.round_index.get(&(dao_id.clone(), i))?;
                Some(self.rounds.get(id)?.view(id.clone()))
            })
            .collect()
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
        let deadline = round.verdict_deadline();
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
        round.groups = vec![
            GroupRecord {
                state: GroupState::Open,
                released: 0,
                decided_at_sec: 0,
            };
            groups
        ];
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

    /// Pays the next recipients of a funded, screened round that the verdict cleared or the council
    /// released: at most `limit` of them, as many as the attached gas covers, in list order. Anyone
    /// can call it; it pays only what the round's list and verdict allow, and never a held
    /// recipient. Returns how many payable recipients are left after this batch.
    pub fn payout_batch(&mut self, round_id: String, limit: u32) -> u32 {
        require!(limit >= 1, "limit must be at least 1");
        let before = env::storage_usage();
        let round = self.round_mut(&round_id);
        require!(
            round.verdict.is_some(),
            format!("round {round_id} has no verdict yet: nothing is paid before the screen")
        );
        require!(
            round.funded_at_sec != 0,
            format!("round {round_id} is not funded yet")
        );
        let payable: Vec<usize> = (0..round.payments.len())
            .filter(|&i| {
                matches!(
                    round.payments[i].state,
                    PaymentState::Pending | PaymentState::Released
                )
            })
            .collect();
        if payable.is_empty() {
            let held = round.count(PaymentState::Held);
            env::panic_str(&if held > 0 {
                format!(
                    "nothing to pay in round {round_id}: its {held} held recipient(s) wait for a council vote"
                )
            } else {
                format!(
                    "nothing to pay in round {round_id}: every payment is paid, in flight or going back to the DAO"
                )
            });
        }
        let per_payment = gas_per_payment(&round.token_id);
        let n = payable
            .len()
            .min(limit as usize)
            .min(payments_gas_covers(per_payment));
        require!(
            n >= 1,
            format!(
                "attach more gas: a batch keeps {} TGas for itself and one payment needs {} TGas more",
                (GAS_RESERVE.as_gas() + GAS_FOR_CALLBACK.as_gas()) / 1_000_000_000_000,
                per_payment.as_tgas()
            )
        );

        let memo = format!("Headcount round {round_id}");
        let mut batch: Vec<u32> = Vec::with_capacity(n);
        let mut transfers: Option<Promise> = None;
        let mut sum: u128 = 0;
        for &i in &payable[..n] {
            let payment = &mut round.payments[i];
            payment.state = PaymentState::Paying;
            sum += payment.amount;
            let one = transfer(&round.token_id, &payment.recipient, payment.amount, &memo);
            transfers = Some(match transfers {
                None => one,
                Some(all) => all.and(one),
            });
            batch.push(i as u32);
        }
        let token = round.token_id.clone();
        let left = payable.len() - n;
        if let Some(all) = transfers {
            all.then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_CALLBACK)
                    .with_unused_gas_weight(1)
                    .on_payouts(round_id.clone(), batch),
            )
            .detach();
        }
        self.rounds.flush();
        require_no_new_storage(before);
        env::log_str(&format!(
            "payout_batch: round {round_id}: paying {n} recipient(s) {sum} {token}; {left} more payable"
        ));
        left as u32
    }

    /// The council's decision on held group `group` (numbered from 1, in the verdict's order).
    /// Only the round's DAO can call it, so for a Sputnik DAO it takes a `FunctionCall` proposal
    /// and a vote. Released accounts are then paid by `payout_batch`; returned amounts go back to
    /// the DAO at once.
    pub fn resolve_group(&mut self, round_id: String, group: u32, decision: Decision) {
        let before = env::storage_usage();
        let now = now_sec();
        let round = self.round_mut(&round_id);
        require!(
            env::predecessor_account_id() == round.dao_id,
            format!(
                "only {} can resolve a held group of its round: file a FunctionCall proposal on the DAO",
                round.dao_id
            )
        );
        let Some(posted) = round.verdict.as_ref() else {
            env::panic_str(&format!(
                "round {round_id} has no verdict, so no held groups"
            ))
        };
        let count = posted.verdict.groups.len();
        require!(
            group >= 1 && group as usize <= count,
            format!(
                "round {round_id} has no group {group}: its verdict holds {count} group(s), numbered from 1"
            )
        );
        require!(
            round.funded_at_sec != 0,
            format!(
                "round {round_id} is not funded yet: the DAO funds it before deciding its held groups"
            )
        );
        let g = group as usize - 1;
        require!(
            round.groups[g].state == GroupState::Open,
            format!(
                "group {group} of round {round_id} is already resolved: {:?}",
                round.groups[g].state
            )
        );
        let accounts = posted.verdict.groups[g].accounts.clone();

        let (state, released) = match &decision {
            Decision::ReleaseAll => (GroupState::ReleasedAll, None),
            Decision::ReleaseOne { account_id } => {
                let k = accounts
                    .iter()
                    .position(|a| a == account_id)
                    .unwrap_or_else(|| {
                        env::panic_str(&format!("{account_id} is not in group {group}"))
                    });
                (GroupState::ReleasedOne, Some(k))
            }
            Decision::Refund => (GroupState::Refunded, None),
        };
        let mut back: Vec<u32> = Vec::new();
        for (k, account) in accounts.iter().enumerate() {
            let i = position(&round.payments, account);
            let release = match state {
                GroupState::ReleasedAll => true,
                GroupState::ReleasedOne => released == Some(k),
                _ => false,
            };
            if release {
                round.payments[i].state = PaymentState::Released;
            } else {
                back.push(i as u32);
            }
        }
        round.groups[g] = GroupRecord {
            state,
            released: released.unwrap_or(0) as u32,
            decided_at_sec: now,
        };
        let returned = if back.is_empty() {
            0
        } else {
            Self::send_back(round, &round_id, back)
        };
        let token = round.token_id.clone();
        self.rounds.flush();
        require_no_new_storage(before);
        env::log_str(&format!(
            "resolve_group: round {round_id} group {group}: {state:?}; {returned} {token} back to the DAO"
        ));
    }

    /// Sends back to the DAO whatever in a funded round can no longer be paid: the whole round if
    /// no verdict came within the verdict window, every held group the council left undecided past
    /// the hold window, and any payment whose transfer failed. Anyone can call it; the money only
    /// ever goes to the DAO.
    pub fn refund_expired(&mut self, round_id: String) {
        let before = env::storage_usage();
        let now = now_sec();
        let round = self.round_mut(&round_id);
        require!(
            round.funded_at_sec != 0,
            format!("round {round_id} is not funded: there is nothing to return")
        );
        let mut back: Vec<u32> = Vec::new();
        let mut expired_groups = 0;
        let mut reason = None;
        match (&round.verdict, round.hold_deadline()) {
            (None, _) => {
                let deadline = round.verdict_deadline();
                if now > deadline {
                    // Without a verdict nothing was ever paid: every payment is still pending.
                    back.extend(
                        (0..round.payments.len() as u32)
                            .filter(|&i| round.payments[i as usize].state == PaymentState::Pending),
                    );
                } else {
                    reason = Some(format!(
                        "nothing to return yet: round {round_id} waits for a verdict until {deadline} (unix seconds); it is now {now}"
                    ));
                }
            }
            (Some(posted), Some(deadline)) => {
                let open = round.groups.iter().any(|g| g.state == GroupState::Open);
                if open && now > deadline {
                    for (g, record) in round.groups.iter_mut().enumerate() {
                        if record.state != GroupState::Open {
                            continue;
                        }
                        *record = GroupRecord {
                            state: GroupState::Expired,
                            released: 0,
                            decided_at_sec: now,
                        };
                        expired_groups += 1;
                        for account in &posted.verdict.groups[g].accounts {
                            back.push(position(&round.payments, account) as u32);
                        }
                    }
                } else if open {
                    reason = Some(format!(
                        "nothing to return yet: round {round_id}'s held groups wait for a council vote until {deadline} (unix seconds); it is now {now}"
                    ));
                }
            }
            (Some(_), None) => unreachable!("a funded round with a verdict has a hold deadline"),
        }
        back.extend(
            (0..round.payments.len() as u32)
                .filter(|&i| round.payments[i as usize].state == PaymentState::Failed),
        );
        if back.is_empty() {
            env::panic_str(&reason.unwrap_or_else(|| {
                format!("nothing to return: round {round_id} owes the DAO nothing")
            }));
        }
        back.sort_unstable();
        let returned = Self::send_back(round, &round_id, back);
        let token = round.token_id.clone();
        self.rounds.flush();
        require_no_new_storage(before);
        env::log_str(&format!(
            "refund_expired: round {round_id}: {returned} {token} back to the DAO ({expired_groups} expired group(s))"
        ));
    }

    /// Records how a batch of payouts went: one result per position, in order. A transfer that
    /// failed leaves its amount with Headcount, marked `Failed`, for `refund_expired` to return.
    #[private]
    pub fn on_payouts(&mut self, round_id: String, positions: Vec<u32>) {
        require_self("on_payouts");
        let before = env::storage_usage();
        let round = self.round_mut(&round_id);
        let (mut paid, mut failed) = (0u128, Vec::new());
        for (k, &i) in positions.iter().enumerate() {
            let payment = &mut round.payments[i as usize];
            if payment.state != PaymentState::Paying {
                continue; // only payout_batch schedules this callback, for payments it set Paying
            }
            if succeeded(k as u64) {
                payment.state = PaymentState::Paid;
                paid += payment.amount;
            } else {
                payment.state = PaymentState::Failed;
                failed.push(payment.recipient.to_string());
            }
        }
        round.paid += paid;
        let token = round.token_id.clone();
        self.rounds.flush();
        require_no_new_storage(before);
        env::log_str(&format!(
            "on_payouts: round {round_id}: paid {paid} {token}; {} failed{}",
            failed.len(),
            if failed.is_empty() {
                String::new()
            } else {
                format!(
                    " ({}): refund_expired sends their amounts back to the DAO",
                    failed.join(", ")
                )
            }
        ));
    }

    /// Records how a transfer back to the DAO went, for every position it carried. If it failed,
    /// those payments are marked `Failed`, so `refund_expired` can send them again.
    #[private]
    pub fn on_refund(&mut self, round_id: String, positions: Vec<u32>) {
        require_self("on_refund");
        let before = env::storage_usage();
        let ok = succeeded(0);
        let round = self.round_mut(&round_id);
        let mut amount = 0u128;
        for &i in &positions {
            let payment = &mut round.payments[i as usize];
            if payment.state != PaymentState::Refunding {
                continue; // only send_back schedules this callback, for payments it set Refunding
            }
            amount += payment.amount;
            payment.state = if ok {
                PaymentState::Refunded
            } else {
                PaymentState::Failed
            };
        }
        if ok {
            round.refunded += amount;
        }
        let (dao, token) = (round.dao_id.clone(), round.token_id.clone());
        self.rounds.flush();
        require_no_new_storage(before);
        env::log_str(&format!(
            "on_refund: round {round_id}: {amount} {token} {}",
            if ok {
                format!("back with {dao}")
            } else {
                "did not reach the DAO; refund_expired can send it again".to_string()
            }
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

    /// Sends the amounts at `positions` back to the round's DAO in one transfer, marks them
    /// `Refunding`, and has `on_refund` record how it went. Returns the amount sent.
    fn send_back(round: &mut Round, round_id: &str, positions: Vec<u32>) -> u128 {
        let per_payment = gas_per_payment(&round.token_id);
        require!(
            payments_gas_covers(per_payment) >= 1,
            format!(
                "attach more gas: sending money back to the DAO needs {} TGas more than this call has left",
                (GAS_RESERVE.as_gas() + GAS_FOR_CALLBACK.as_gas() + per_payment.as_gas())
                    / 1_000_000_000_000
            )
        );
        let mut sum: u128 = 0;
        for &i in &positions {
            let payment = &mut round.payments[i as usize];
            payment.state = PaymentState::Refunding;
            sum += payment.amount;
        }
        transfer(
            &round.token_id,
            &round.dao_id,
            sum,
            &format!("Headcount refund, round {round_id}"),
        )
        .then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_CALLBACK)
                .with_unused_gas_weight(1)
                .on_refund(round_id.to_string(), positions),
        )
        .detach();
        sum
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
            let at = position(payments, account);
            require!(
                !held.contains(&at),
                format!("{account} appears twice in the verdict")
            );
            held.push(at);
        }
    }
    held
}

/// Where `account` sits in a round's list, which is sorted by recipient.
fn position(payments: &[Payment], account: &AccountId) -> usize {
    payments
        .binary_search_by(|p| p.recipient.as_str().cmp(account.as_str()))
        .unwrap_or_else(|_| env::panic_str(&format!("{account} is not on this round's list")))
}

/// One transfer of `amount` to `receiver`: NEAR, or the round's token through `ft_transfer` with
/// the 1 yoctoNEAR NEP-141 asks for and static gas only, so the callback gets the unused gas.
///
/// The arguments are written directly: an account id, a decimal amount and a memo of plain words
/// and a hex round id never need JSON escaping.
fn transfer(token_id: &str, receiver: &AccountId, amount: u128, memo: &str) -> Promise {
    if token_id == NATIVE {
        return Promise::new(receiver.clone()).transfer(NearToken::from_yoctonear(amount));
    }
    let token: AccountId = token_id
        .parse()
        .unwrap_or_else(|_| env::panic_str(&format!("{token_id} is not a token contract")));
    let args = format!(r#"{{"receiver_id":"{receiver}","amount":"{amount}","memo":"{memo}"}}"#);
    Promise::new(token).function_call_weight(
        "ft_transfer",
        args.into_bytes(),
        NearToken::from_yoctonear(1),
        GAS_FOR_FT_TRANSFER,
        GasWeight(0),
    )
}

fn gas_per_payment(token_id: &str) -> Gas {
    if token_id == NATIVE {
        GAS_PER_NEAR_PAYMENT
    } else {
        GAS_PER_FT_PAYMENT
    }
}

/// How many payments of `per_payment` gas the gas this call has left covers, after keeping
/// `GAS_RESERVE` for its own remaining work and `GAS_FOR_CALLBACK` for the callback.
fn payments_gas_covers(per_payment: Gas) -> usize {
    let left = env::prepaid_gas()
        .as_gas()
        .saturating_sub(env::used_gas().as_gas());
    let spare = left.saturating_sub(GAS_RESERVE.as_gas() + GAS_FOR_CALLBACK.as_gas());
    (spare / per_payment.as_gas()) as usize
}

/// Whether the `k`-th transfer a callback waited on went through. Any successful result counts,
/// whatever data it returned; only a failed receipt is a failure.
fn succeeded(k: u64) -> bool {
    !matches!(env::promise_result_checked(k, 0), Err(PromiseError::Failed))
}

/// Refuses a callback from anyone but Headcount itself. near-sdk's `#[private]` makes the same
/// check on chain; this one also holds in unit tests, which call methods directly.
fn require_self(method: &str) {
    require!(
        env::predecessor_account_id() == env::current_account_id(),
        format!("Method {method} is private")
    );
}

/// Refuses a call that leaves more storage than it found. Paying, deciding and refunding carry no
/// deposit, so any byte they added would be paid out of Headcount's balance, which holds rounds'
/// money. Every write must be flushed first.
fn require_no_new_storage(before: u64) {
    let after = env::storage_usage();
    require!(
        after <= before,
        format!(
            "this call would store {} more bytes, and it carries no deposit to pay for them",
            after - before
        )
    );
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
