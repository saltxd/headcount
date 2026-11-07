//! Unit tests on near-sdk's mocked VM. Each `ctx` call starts a new call from `predecessor` with
//! `deposit` attached; storage carries over between calls, as on chain.

use super::*;
use near_sdk::PromiseResult;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{Value, json};
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::testing_env;

const HEADCOUNT: &str = "headcount.test.near";
const DAO: &str = "dao.test.near";
const SCREENER: &str = "screener.test.near";
const REQUESTOR: &str = "treasurer.test.near";
const TOKEN: &str = "token.test.near";
/// Someone with no role anywhere: payouts and refunds are open to anyone.
const ANYONE: &str = "anyone.test.near";

/// 2026-11-07T00:00:00Z, in nanoseconds.
const NOW_NS: u64 = 1_794_009_600_000_000_000;
const NOW_SEC: u64 = NOW_NS / 1_000_000_000;
const DAY: u64 = 86_400;

fn acc(id: &str) -> AccountId {
    id.parse().unwrap()
}

fn near(milli: u128) -> NearToken {
    NearToken::from_millinear(milli)
}

fn ctx(predecessor: &str, deposit: NearToken) {
    ctx_at(predecessor, deposit, NOW_SEC);
}

/// A call made at `now_sec` (unix seconds).
fn ctx_at(predecessor: &str, deposit: NearToken, now_sec: u64) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acc(HEADCOUNT))
            .predecessor_account_id(acc(predecessor))
            .signer_account_id(acc(predecessor))
            .attached_deposit(deposit)
            .block_timestamp(now_sec * 1_000_000_000)
            .build()
    );
}

fn yocto(n: u128) -> NearToken {
    NearToken::from_yoctonear(n)
}

/// NEAR transfers the last call made: (receiver, yoctoNEAR).
fn transfers() -> Vec<(AccountId, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit.as_yoctonear())),
                _ => None,
            })
        })
        .collect()
}

fn fresh() -> Headcount {
    ctx(HEADCOUNT, NearToken::from_yoctonear(0));
    Headcount::new()
}

/// A Headcount where `dao.test.near` has named `screener.test.near`, with 2-day windows.
fn configured() -> Headcount {
    let mut h = fresh();
    ctx(DAO, near(10));
    h.configure(acc(DAO), acc(SCREENER), 2 * DAY, 2 * DAY);
    h
}

fn pay(recipient: &str, amount: u128) -> PaymentInput {
    PaymentInput {
        recipient: acc(recipient),
        amount: U128(amount),
    }
}

fn three() -> Vec<PaymentInput> {
    vec![
        pay("carol.test.near", 30),
        pay("alice.test.near", 10),
        pay("bob.test.near", 20),
    ]
}

/// The requestor creates a round of `payments` for the DAO with 0.1 NEAR attached.
fn create(h: &mut Headcount, token: &str, payments: Vec<PaymentInput>) -> String {
    ctx(REQUESTOR, near(100));
    h.create_round(acc(DAO), token.to_string(), payments, 1_794_009_600_000)
}

// --- configure -------------------------------------------------------------------------------

#[test]
fn the_dao_configures_itself() {
    let mut h = fresh();
    assert_eq!(h.get_config(acc(DAO)), None);

    ctx(DAO, near(10));
    h.configure(acc(DAO), acc(SCREENER), 2 * DAY, 3 * DAY);

    assert_eq!(
        h.get_config(acc(DAO)),
        Some(DaoConfig {
            screener_id: acc(SCREENER),
            verdict_window_sec: 2 * DAY,
            hold_window_sec: 3 * DAY
        })
    );
}

#[test]
#[should_panic(expected = "only dao.test.near itself can configure dao.test.near")]
fn a_requestor_cannot_configure_the_dao() {
    let mut h = fresh();
    ctx(REQUESTOR, near(10));
    h.configure(acc(DAO), acc(REQUESTOR), 2 * DAY, 2 * DAY);
}

#[test]
#[should_panic(expected = "only dao.test.near itself can configure dao.test.near")]
fn a_screener_cannot_reconfigure_the_dao() {
    let mut h = configured();
    ctx(SCREENER, near(10));
    h.configure(acc(DAO), acc(SCREENER), 300 * DAY, 300 * DAY);
}

#[test]
fn the_dao_can_name_a_new_screener() {
    let mut h = configured();
    ctx(DAO, near(10));
    h.configure(acc(DAO), acc("screener2.test.near"), DAY, DAY);
    assert_eq!(
        h.get_config(acc(DAO)).unwrap().screener_id,
        acc("screener2.test.near")
    );
}

#[test]
fn configure_charges_the_dao_its_storage_and_returns_the_rest() {
    let mut h = fresh();
    ctx(DAO, near(10));
    let before = env::storage_usage();
    h.configure(acc(DAO), acc(SCREENER), DAY, DAY);
    let cost = env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage() - before);
    assert!(cost > 0);
    assert_eq!(
        transfers(),
        vec![(acc(DAO), near(10).as_yoctonear() - cost)]
    );
}

#[test]
#[should_panic(expected = "attach at least")]
fn configure_needs_its_storage_paid() {
    let mut h = fresh();
    ctx(DAO, NearToken::from_yoctonear(1));
    h.configure(acc(DAO), acc(SCREENER), DAY, DAY);
}

#[test]
#[should_panic(expected = "verdict_window_sec must be between 60 and 31622400 seconds")]
fn a_window_in_milliseconds_is_refused() {
    let mut h = fresh();
    ctx(DAO, near(10));
    h.configure(acc(DAO), acc(SCREENER), 2 * DAY * 1000, DAY);
}

#[test]
#[should_panic(expected = "hold_window_sec must be between 60 and 31622400 seconds")]
fn a_zero_hold_window_is_refused() {
    let mut h = fresh();
    ctx(DAO, near(10));
    h.configure(acc(DAO), acc(SCREENER), DAY, 0);
}

// --- create_round: the id ----------------------------------------------------------------------

#[test]
fn create_round_returns_trezus_list_id_for_the_sandbox_round() {
    let fixture: near_sdk::serde_json::Value =
        near_sdk::serde_json::from_str(include_str!("../../../fixtures/trezu-list-ids.json"))
            .unwrap();
    let vector = fixture["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["submitter"] == "dao.test.near")
        .expect("the sandbox round's vector");
    let payments: Vec<PaymentInput> = vector["payments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            pay(
                p["recipient"].as_str().unwrap(),
                p["amount"].as_str().unwrap().parse().unwrap(),
            )
        })
        .collect();
    assert_eq!(payments.len(), 16);

    let mut h = configured();
    ctx(REQUESTOR, near(100));
    let id = h.create_round(
        acc(DAO),
        TOKEN.into(),
        payments.clone(),
        vector["timestamp"].as_u64().unwrap(),
    );

    assert_eq!(
        id,
        vector["list_id"].as_str().unwrap(),
        "Trezu's generateListId gave this id"
    );
    assert_eq!(
        h.list_id(
            acc(DAO),
            TOKEN.into(),
            payments,
            vector["timestamp"].as_u64().unwrap()
        ),
        id
    );
}

#[test]
fn the_same_list_at_another_timestamp_is_another_round() {
    let mut h = configured();
    let first = create(&mut h, NATIVE, three());
    ctx(REQUESTOR, near(100));
    let second = h.create_round(acc(DAO), NATIVE.into(), three(), 1_794_009_600_001);
    assert_ne!(first, second);
}

#[test]
fn one_changed_amount_is_another_round() {
    let mut h = configured();
    let first = create(&mut h, NATIVE, three());
    let mut edited = three();
    edited[0].amount = U128(31);
    assert_ne!(create(&mut h, NATIVE, edited), first);
}

#[test]
fn the_order_of_the_list_does_not_change_the_id() {
    let h = configured();
    let mut reversed = three();
    reversed.reverse();
    assert_eq!(
        h.list_id(acc(DAO), NATIVE.into(), three(), 7),
        h.list_id(acc(DAO), NATIVE.into(), reversed, 7)
    );
}

// --- create_round: what is stored ----------------------------------------------------------------

#[test]
fn a_round_stores_its_list_sorted_with_its_total_and_creator() {
    let mut h = configured();
    let id = create(&mut h, NATIVE, three());
    let round = h.get_round(id.clone()).expect("stored");

    assert_eq!(round.round_id, id);
    assert_eq!(round.dao_id, acc(DAO));
    assert_eq!(round.token_id, NATIVE);
    assert_eq!(round.timestamp, 1_794_009_600_000);
    assert_eq!(
        round
            .payments
            .iter()
            .map(|p| (p.recipient.to_string(), p.amount.0, p.state))
            .collect::<Vec<_>>(),
        vec![
            ("alice.test.near".to_string(), 10, PaymentState::Pending),
            ("bob.test.near".to_string(), 20, PaymentState::Pending),
            ("carol.test.near".to_string(), 30, PaymentState::Pending),
        ]
    );
    assert_eq!(round.total, U128(60));
    assert_eq!(round.creator_id, acc(REQUESTOR));
    assert_eq!(round.created_at_sec, NOW_SEC);
    assert_eq!(
        (round.verdict_window_sec, round.hold_window_sec),
        (2 * DAY, 2 * DAY)
    );
    assert_eq!(round.funded_at_sec, None);
    assert_eq!(h.get_round("0".repeat(64)), None);
}

#[test]
fn a_later_configure_does_not_move_an_existing_rounds_windows() {
    let mut h = configured();
    let id = create(&mut h, NATIVE, three());
    ctx(DAO, near(10));
    h.configure(acc(DAO), acc(SCREENER), 60, 60);
    let round = h.get_round(id).unwrap();
    assert_eq!(
        (round.verdict_window_sec, round.hold_window_sec),
        (2 * DAY, 2 * DAY)
    );
}

#[test]
fn create_round_charges_the_creator_its_storage_and_returns_the_rest() {
    let mut h = configured();
    // The mock resets its storage-usage counter with each new context, so measure inside the call's.
    ctx(REQUESTOR, near(100));
    let before = env::storage_usage();
    let id = h.create_round(acc(DAO), NATIVE.into(), three(), 1_794_009_600_000);
    let cost = env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage() - before);

    assert_eq!(h.get_round(id).unwrap().storage_deposit, U128(cost));
    assert_eq!(
        transfers(),
        vec![(acc(REQUESTOR), near(100).as_yoctonear() - cost)]
    );
}

#[test]
#[should_panic(expected = "attach at least")]
fn create_round_needs_its_storage_paid() {
    let mut h = configured();
    ctx(REQUESTOR, NearToken::from_yoctonear(1));
    h.create_round(acc(DAO), NATIVE.into(), three(), 1);
}

// --- create_round: refusals ------------------------------------------------------------------------

#[test]
#[should_panic(expected = "dao.test.near has not named a screener")]
fn a_round_for_a_dao_without_a_screener_is_refused() {
    let mut h = fresh();
    create(&mut h, NATIVE, three());
}

#[test]
#[should_panic(expected = "already exists")]
fn the_same_round_twice_is_refused() {
    let mut h = configured();
    create(&mut h, NATIVE, three());
    create(&mut h, NATIVE, three());
}

#[test]
#[should_panic(expected = "a round pays 1 to 100 recipients, this list has 0")]
fn an_empty_list_is_refused() {
    let mut h = configured();
    create(&mut h, NATIVE, vec![]);
}

#[test]
#[should_panic(expected = "a round pays 1 to 100 recipients, this list has 101")]
fn a_list_over_100_is_refused() {
    let mut h = configured();
    let list = (0..101)
        .map(|i| pay(&format!("r{i}.test.near"), 1))
        .collect();
    create(&mut h, NATIVE, list);
}

#[test]
#[should_panic(expected = "bob.test.near is listed twice")]
fn a_recipient_listed_twice_is_refused() {
    let mut h = configured();
    create(
        &mut h,
        NATIVE,
        vec![
            pay("bob.test.near", 1),
            pay("alice.test.near", 1),
            pay("bob.test.near", 2),
        ],
    );
}

#[test]
#[should_panic(expected = "alice.test.near has an amount of 0")]
fn a_zero_amount_is_refused() {
    let mut h = configured();
    create(&mut h, NATIVE, vec![pay("alice.test.near", 0)]);
}

#[test]
#[should_panic(expected = "Headcount itself cannot be a recipient")]
fn headcount_as_a_recipient_is_refused() {
    let mut h = configured();
    create(&mut h, NATIVE, vec![pay(HEADCOUNT, 1)]);
}

#[test]
#[should_panic(expected = "the total overflows")]
fn a_total_past_u128_is_refused() {
    let mut h = configured();
    create(
        &mut h,
        NATIVE,
        vec![pay("alice.test.near", u128::MAX), pay("bob.test.near", 1)],
    );
}

#[test]
#[should_panic(
    expected = "token_id must be \"native\" (NEAR) or a NEP-141 token contract, not \"\""
)]
fn sputniks_empty_token_id_for_near_is_refused() {
    let mut h = configured();
    create(&mut h, "", three());
}

#[test]
#[should_panic(
    expected = "token_id must be \"native\" (NEAR) or a NEP-141 token contract, not \"nep141:usdc.test.near\""
)]
fn an_intents_token_id_is_refused() {
    let mut h = configured();
    create(&mut h, "nep141:usdc.test.near", three());
}

#[test]
fn a_nep141_token_contract_is_a_valid_token() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, three());
    assert_eq!(h.get_round(id).unwrap().token_id, TOKEN);
}

// --- fund_round: NEAR rounds ---------------------------------------------------------------------

#[test]
fn the_dao_funds_a_near_round_with_exactly_its_total() {
    let mut h = configured();
    let id = create(&mut h, NATIVE, three());
    ctx(DAO, yocto(60));
    let before = env::storage_usage();
    h.fund_round(id.clone());
    h.rounds.flush(); // writes land at flush; on chain that is the end of the call
    assert_eq!(env::storage_usage(), before, "funding never grows storage");
    assert_eq!(h.get_round(id).unwrap().funded_at_sec, Some(NOW_SEC));
    assert!(transfers().is_empty(), "the deposit stays in the round");
}

#[test]
#[should_panic(expected = "attach exactly 60 yoctoNEAR, the round's total; 59 attached")]
fn a_near_round_funded_short_is_refused() {
    let mut h = configured();
    let id = create(&mut h, NATIVE, three());
    ctx(DAO, yocto(59));
    h.fund_round(id);
}

#[test]
#[should_panic(expected = "attach exactly 60 yoctoNEAR, the round's total; 61 attached")]
fn a_near_round_funded_over_is_refused() {
    let mut h = configured();
    let id = create(&mut h, NATIVE, three());
    ctx(DAO, yocto(61));
    h.fund_round(id);
}

#[test]
#[should_panic(expected = "only dao.test.near can fund its round")]
fn only_the_dao_funds_its_round() {
    let mut h = configured();
    let id = create(&mut h, NATIVE, three());
    ctx(REQUESTOR, yocto(60));
    h.fund_round(id);
}

#[test]
#[should_panic(
    expected = "pays in token.test.near: the DAO funds it with ft_transfer_call on token.test.near"
)]
fn a_token_round_cannot_be_funded_in_near() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, three());
    ctx(DAO, yocto(60));
    h.fund_round(id);
}

#[test]
#[should_panic(expected = "is already funded")]
fn a_near_round_is_funded_once() {
    let mut h = configured();
    let id = create(&mut h, NATIVE, three());
    ctx(DAO, yocto(60));
    h.fund_round(id.clone());
    ctx(DAO, yocto(60));
    h.fund_round(id);
}

#[test]
#[should_panic(expected = "no round ffff")]
fn funding_an_unknown_round_is_refused() {
    let mut h = configured();
    ctx(DAO, yocto(60));
    h.fund_round("f".repeat(64));
}

// --- ft_on_transfer: token rounds ----------------------------------------------------------------

/// `token` calls ft_on_transfer, reporting `sender` sent `amount` with `msg`.
fn ft(h: &mut Headcount, token: &str, sender: &str, amount: u128, msg: &str) -> U128 {
    ctx(token, yocto(0));
    h.ft_on_transfer(acc(sender), U128(amount), msg.to_string())
}

#[test]
fn the_dao_funds_a_token_round_with_ft_transfer_call() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, three());
    ctx(TOKEN, yocto(0));
    let before = env::storage_usage();
    assert_eq!(
        h.ft_on_transfer(acc(DAO), U128(60), id.clone()),
        U128(0),
        "keeps all of it"
    );
    h.rounds.flush();
    assert_eq!(env::storage_usage(), before, "funding never grows storage");
    assert_eq!(h.get_round(id).unwrap().funded_at_sec, Some(NOW_SEC));
}

#[test]
fn wrong_token_funding_is_sent_back_and_changes_nothing() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, three());
    let near_round = create(&mut h, NATIVE, three());
    let cases: [(&str, &str, u128, &str, String); 6] = [
        (
            "other.test.near",
            DAO,
            60,
            &id,
            format!("round {id} pays in token.test.near, not other.test.near"),
        ),
        (
            TOKEN,
            "alice.test.near",
            60,
            &id,
            "only dao.test.near can fund its round, not alice.test.near".into(),
        ),
        (
            TOKEN,
            DAO,
            59,
            &id,
            format!("round {id}'s total is 60, got 59"),
        ),
        (
            TOKEN,
            DAO,
            61,
            &id,
            format!("round {id}'s total is 60, got 61"),
        ),
        (
            TOKEN,
            DAO,
            60,
            "not a round id",
            "no round not a round id".into(),
        ),
        (
            TOKEN,
            DAO,
            60,
            &near_round,
            format!("round {near_round} pays in native, not token.test.near"),
        ),
    ];
    for (token, sender, amount, msg, why) in cases {
        assert_eq!(
            ft(&mut h, token, sender, amount, msg),
            U128(amount),
            "sent back: {why}"
        );
        let logs = near_sdk::test_utils::get_logs();
        assert!(
            logs.iter().any(|l| l.contains(&why)),
            "the log says why ({why}): {logs:?}"
        );
    }
    assert_eq!(h.get_round(id).unwrap().funded_at_sec, None);
    assert_eq!(h.get_round(near_round).unwrap().funded_at_sec, None);
}

#[test]
fn a_token_round_funded_twice_sends_the_second_back() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, three());
    assert_eq!(ft(&mut h, TOKEN, DAO, 60, &id), U128(0));
    assert_eq!(ft(&mut h, TOKEN, DAO, 60, &id), U128(60));
    assert!(
        near_sdk::test_utils::get_logs()
            .iter()
            .any(|l| l.contains("is already funded"))
    );
}

// --- post_verdict ---------------------------------------------------------------------------------

fn five() -> Vec<PaymentInput> {
    ["alice", "bob", "carol", "dave", "erin"]
        .iter()
        .zip(1..)
        .map(|(name, i)| pay(&format!("{name}.test.near"), 10 * i))
        .collect()
}

fn group(names: &[&str], signal: &str) -> HeldGroup {
    HeldGroup {
        accounts: names
            .iter()
            .map(|n| acc(&format!("{n}.test.near")))
            .collect(),
        signals: vec![signal.to_string()],
        evidence: vec!["9Gq1sQ8dWnB5xC1kA7fTvZ2uY3rE4wP6mN8bJ0hL5iK".to_string()],
    }
}

fn verdict(groups: Vec<HeldGroup>) -> Verdict {
    Verdict {
        screened_at_block: 4_242,
        rule: "hold-linked-v1".to_string(),
        groups,
        report_sha256: "ab".repeat(32),
        report_url: Some("https://example.org/report.json".to_string()),
    }
}

/// The screener posts `v` on `id` at `now_sec`, with 0.1 NEAR for storage.
fn post_at(h: &mut Headcount, id: &str, v: Verdict, now_sec: u64) {
    ctx_at(SCREENER, near(100), now_sec);
    h.post_verdict(id.to_string(), v);
}

fn post(h: &mut Headcount, id: &str, v: Verdict) {
    post_at(h, id, v, NOW_SEC);
}

fn states(h: &Headcount, id: &str) -> Vec<(String, PaymentState)> {
    h.get_round(id.to_string())
        .unwrap()
        .payments
        .into_iter()
        .map(|p| (p.recipient.to_string().replace(".test.near", ""), p.state))
        .collect()
}

#[test]
fn the_screener_posts_a_verdict_and_the_linked_recipients_are_held() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    let v = verdict(vec![
        group(&["alice", "bob"], "same-funder"),
        group(&["dave", "erin"], "shared-key"),
    ]);
    post(&mut h, &id, v.clone());

    use PaymentState::{Held, Pending};
    assert_eq!(
        states(&h, &id),
        vec![
            ("alice".into(), Held),
            ("bob".into(), Held),
            ("carol".into(), Pending),
            ("dave".into(), Held),
            ("erin".into(), Held)
        ]
    );
    let posted = PostedVerdict {
        screener_id: acc(SCREENER),
        posted_at_sec: NOW_SEC,
        verdict: v,
    };
    assert_eq!(h.get_verdict(id.clone()), Some(posted.clone()));
    assert_eq!(h.get_round(id).unwrap().verdict, Some(posted));
}

#[test]
fn a_verdict_with_no_groups_clears_everyone() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    post(&mut h, &id, verdict(vec![]));
    assert!(
        states(&h, &id)
            .iter()
            .all(|(_, s)| *s == PaymentState::Pending)
    );
    assert!(h.get_verdict(id).is_some());
}

#[test]
fn the_screener_pays_for_the_verdicts_storage() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    ctx(SCREENER, near(100));
    let before = env::storage_usage();
    h.post_verdict(id, verdict(vec![group(&["alice", "bob"], "same-funder")]));
    let cost = env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage() - before);
    assert!(cost > 0);
    assert_eq!(
        transfers(),
        vec![(acc(SCREENER), near(100).as_yoctonear() - cost)]
    );
}

#[test]
#[should_panic(expected = "attach at least")]
fn a_verdict_needs_its_storage_paid() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    ctx(SCREENER, yocto(1));
    h.post_verdict(id, verdict(vec![group(&["alice", "bob"], "same-funder")]));
}

#[test]
#[should_panic(expected = "treasurer.test.near is not this DAO's screener")]
fn scenario_4_an_account_that_is_not_the_screener_is_refused() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    ctx(REQUESTOR, near(100));
    h.post_verdict(id, verdict(vec![]));
}

#[test]
#[should_panic(expected = "dao.test.near is not this DAO's screener")]
fn not_even_the_dao_posts_a_verdict_unless_it_named_itself() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    ctx(DAO, near(100));
    h.post_verdict(id, verdict(vec![]));
}

#[test]
#[should_panic(expected = "screener.test.near is not this DAO's screener")]
fn a_replaced_screener_can_no_longer_post() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    ctx(DAO, near(10));
    h.configure(acc(DAO), acc("screener2.test.near"), 2 * DAY, 2 * DAY);
    post(&mut h, &id, verdict(vec![]));
}

#[test]
fn the_newly_named_screener_posts_instead() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    ctx(DAO, near(10));
    h.configure(acc(DAO), acc("screener2.test.near"), 2 * DAY, 2 * DAY);
    ctx("screener2.test.near", near(100));
    h.post_verdict(id.clone(), verdict(vec![]));
    assert_eq!(
        h.get_verdict(id).unwrap().screener_id,
        acc("screener2.test.near")
    );
}

#[test]
#[should_panic(expected = "mallory.test.near is not on this round's list")]
fn scenario_5_a_verdict_naming_an_account_off_the_list_is_refused() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    post(
        &mut h,
        &id,
        verdict(vec![group(&["alice", "mallory"], "same-funder")]),
    );
}

#[test]
#[should_panic(expected = "a held group needs at least 2 accounts; group 2 has 1")]
fn a_group_of_one_is_refused() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    post(
        &mut h,
        &id,
        verdict(vec![
            group(&["alice", "bob"], "same-funder"),
            group(&["carol"], "shared-key"),
        ]),
    );
}

#[test]
#[should_panic(expected = "bob.test.near appears twice in the verdict")]
fn an_account_in_two_groups_is_refused() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    post(
        &mut h,
        &id,
        verdict(vec![
            group(&["alice", "bob"], "same-funder"),
            group(&["bob", "carol"], "shared-key"),
        ]),
    );
}

#[test]
#[should_panic(expected = "alice.test.near appears twice in the verdict")]
fn an_account_twice_in_one_group_is_refused() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    post(
        &mut h,
        &id,
        verdict(vec![group(&["alice", "alice"], "same-funder")]),
    );
}

#[test]
#[should_panic(expected = "already has a verdict")]
fn a_verdict_is_posted_once() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    post(&mut h, &id, verdict(vec![]));
    post(
        &mut h,
        &id,
        verdict(vec![group(&["alice", "bob"], "same-funder")]),
    );
}

#[test]
#[should_panic(expected = "no round ffff")]
fn a_verdict_on_an_unknown_round_is_refused() {
    let mut h = configured();
    post(&mut h, &"f".repeat(64), verdict(vec![]));
}

#[test]
fn a_verdict_on_the_windows_last_second_is_accepted() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    post_at(&mut h, &id, verdict(vec![]), NOW_SEC + 2 * DAY);
    assert_eq!(h.get_verdict(id).unwrap().posted_at_sec, NOW_SEC + 2 * DAY);
}

#[test]
#[should_panic(expected = "the verdict window closed")]
fn a_verdict_after_the_window_is_refused() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    post_at(&mut h, &id, verdict(vec![]), NOW_SEC + 2 * DAY + 1);
}

#[test]
fn funding_reopens_the_verdict_window() {
    let mut h = configured();
    let id = create(&mut h, NATIVE, five());
    ctx_at(DAO, yocto(150), NOW_SEC + 3 * DAY);
    h.fund_round(id.clone());
    post_at(&mut h, &id, verdict(vec![]), NOW_SEC + 5 * DAY);
    assert!(h.get_verdict(id).is_some());
}

#[test]
#[should_panic(expected = "report_sha256 must be 64 lowercase hex characters")]
fn an_uppercase_report_hash_is_refused() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    let mut v = verdict(vec![]);
    v.report_sha256 = "AB".repeat(32);
    post(&mut h, &id, v);
}

#[test]
#[should_panic(expected = "rule must be 1 to 64 characters")]
fn an_empty_rule_is_refused() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    let mut v = verdict(vec![]);
    v.rule = String::new();
    post(&mut h, &id, v);
}

#[test]
#[should_panic(expected = "report_url must be at most 256 characters")]
fn an_overlong_report_url_is_refused() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    let mut v = verdict(vec![]);
    v.report_url = Some(format!("https://example.org/{}", "a".repeat(240)));
    post(&mut h, &id, v);
}

#[test]
#[should_panic(expected = "group 1 needs 1 to 5 signals of 1 to 32 characters")]
fn a_group_without_signals_is_refused() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    let mut g = group(&["alice", "bob"], "same-funder");
    g.signals.clear();
    post(&mut h, &id, verdict(vec![g]));
}

#[test]
#[should_panic(expected = "group 1 may cite at most 32 pieces of evidence of up to 128 characters")]
fn overlong_evidence_is_refused() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    let mut g = group(&["alice", "bob"], "same-funder");
    g.evidence.push("x".repeat(129));
    post(&mut h, &id, verdict(vec![g]));
}

// --- payouts, council decisions, refunds ----------------------------------------------------------
//
// five() sorts to positions alice 0 (10), bob 1 (20), carol 2 (30), dave 3 (40), erin 4 (50).

use PaymentState::{Failed, Held, Paid, Paying, Pending, Refunded, Refunding, Released};

/// A call from `predecessor` with `gas` attached and no deposit, charged no receipt fees. The
/// mock's default fees are NEAR's original ones (2.3 TGas per function call, 4.7 TGas per data
/// receipt), several times protocol 86's, so these tests check the batch arithmetic on its own;
/// the sandbox checks it against real fees.
fn ctx_gas(predecessor: &str, gas: Gas) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acc(HEADCOUNT))
            .predecessor_account_id(acc(predecessor))
            .signer_account_id(acc(predecessor))
            .block_timestamp(NOW_SEC * 1_000_000_000)
            .prepaid_gas(gas)
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::free()
    );
}

/// A callback run by `predecessor` with `results` from the transfers it waited on.
fn ctx_results_from(predecessor: &str, results: Vec<PromiseResult>) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acc(HEADCOUNT))
            .predecessor_account_id(acc(predecessor))
            .signer_account_id(acc(ANYONE))
            .block_timestamp(NOW_SEC * 1_000_000_000)
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

/// Headcount's own callback, with these results.
fn ctx_results(results: Vec<PromiseResult>) {
    ctx_results_from(HEADCOUNT, results);
}

const OK: fn() -> PromiseResult = || PromiseResult::Successful(vec![]);
const FAIL: fn() -> PromiseResult = || PromiseResult::Failed;

fn results(outcomes: &[fn() -> PromiseResult]) -> Vec<PromiseResult> {
    outcomes.iter().map(|f| f()).collect()
}

/// Token transfers the last call scheduled: (token, receiver, amount).
fn ft_transfers() -> Vec<(String, String, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let token = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight {
                    method_name, args, ..
                } if method_name == b"ft_transfer" => {
                    let v: Value = near_sdk::serde_json::from_slice(&args).unwrap();
                    Some((
                        token.clone(),
                        v["receiver_id"].as_str().unwrap().to_string(),
                        v["amount"].as_str().unwrap().parse().unwrap(),
                    ))
                }
                _ => None,
            })
        })
        .collect()
}

/// The one callback the last call scheduled on Headcount itself: its method, its arguments, how
/// many transfers it waits on, and its static gas and unused-gas weight.
fn callback() -> (String, Value, usize, Gas, u64) {
    let receipts: Vec<_> = get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id == acc(HEADCOUNT))
        .collect();
    assert_eq!(receipts.len(), 1, "one callback: {receipts:?}");
    let r = &receipts[0];
    match &r.actions[..] {
        [
            MockAction::FunctionCallWeight {
                method_name,
                args,
                prepaid_gas,
                gas_weight,
                ..
            },
        ] => (
            String::from_utf8(method_name.clone()).unwrap(),
            near_sdk::serde_json::from_slice(args).unwrap(),
            r.receipt_indices.len(),
            *prepaid_gas,
            gas_weight.0,
        ),
        other => panic!("not a single call: {other:?}"),
    }
}

fn st(expected: &[(&str, PaymentState)]) -> Vec<(String, PaymentState)> {
    expected.iter().map(|(n, s)| (n.to_string(), *s)).collect()
}

/// The DAO funds round `id` with exactly its total, in its token.
fn fund(h: &mut Headcount, id: &str) {
    let round = h.get_round(id.to_string()).unwrap();
    if round.token_id == NATIVE {
        ctx(DAO, yocto(round.total.0));
        h.fund_round(id.to_string());
    } else {
        assert_eq!(ft(h, &round.token_id, DAO, round.total.0, id), U128(0));
    }
}

/// A round of five() in `token`, screened with `groups` held, then funded: all at NOW.
fn screened_and_funded(token: &str, groups: Vec<HeldGroup>) -> (Headcount, String) {
    let mut h = configured();
    let id = create(&mut h, token, five());
    post(&mut h, &id, verdict(groups));
    fund(&mut h, &id);
    (h, id)
}

fn two_groups() -> Vec<HeldGroup> {
    vec![
        group(&["alice", "bob"], "same-funder"),
        group(&["dave", "erin"], "shared-key"),
    ]
}

/// Anyone pays the next batch.
fn pay_batch(h: &mut Headcount, id: &str, limit: u32) -> u32 {
    ctx(ANYONE, yocto(0));
    h.payout_batch(id.to_string(), limit)
}

/// The DAO decides group `n`: the call its FunctionCall proposal makes.
fn decide(h: &mut Headcount, id: &str, n: u32, decision: Decision) {
    ctx(DAO, yocto(0));
    h.resolve_group(id.to_string(), n, decision);
}

/// Anyone asks for what can no longer be paid to go back, at `now_sec`.
fn refund_at(h: &mut Headcount, id: &str, now_sec: u64) {
    ctx_at(ANYONE, yocto(0), now_sec);
    h.refund_expired(id.to_string());
}

fn released_one(name: &str) -> Decision {
    Decision::ReleaseOne {
        account_id: acc(&format!("{name}.test.near")),
    }
}

// --- payout_batch ----------------------------------------------------------------------------

#[test]
fn a_batch_pays_cleared_recipients_in_list_order_up_to_its_limit() {
    let (mut h, id) = screened_and_funded(NATIVE, vec![group(&["alice", "bob"], "same-funder")]);
    assert_eq!(pay_batch(&mut h, &id, 2), 1, "erin is still to pay");

    assert_eq!(
        transfers(),
        vec![(acc("carol.test.near"), 30), (acc("dave.test.near"), 40)]
    );
    let (method, args, waits_on, gas, weight) = callback();
    assert_eq!(method, "on_payouts");
    assert_eq!(args, json!({ "round_id": id, "positions": [2, 3] }));
    assert_eq!(waits_on, 2, "one callback waits on both transfers");
    assert_eq!(
        (gas, weight),
        (GAS_FOR_CALLBACK, 1),
        "the callback gets the unused gas"
    );
    assert_eq!(
        states(&h, &id),
        st(&[
            ("alice", Held),
            ("bob", Held),
            ("carol", Paying),
            ("dave", Paying),
            ("erin", Pending)
        ])
    );
}

#[test]
fn a_token_round_pays_with_ft_transfer_one_yoctonear_and_the_round_in_the_memo() {
    let (mut h, id) = screened_and_funded(TOKEN, vec![]);
    assert_eq!(pay_batch(&mut h, &id, 2), 3);
    assert_eq!(
        ft_transfers(),
        vec![
            (TOKEN.into(), "alice.test.near".into(), 10),
            (TOKEN.into(), "bob.test.near".into(), 20)
        ]
    );
    let calls: Vec<_> = get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id == acc(TOKEN))
        .collect();
    assert_eq!(calls.len(), 2);
    for r in calls {
        match &r.actions[..] {
            [
                MockAction::FunctionCallWeight {
                    args,
                    attached_deposit,
                    prepaid_gas,
                    gas_weight,
                    ..
                },
            ] => {
                assert_eq!(*attached_deposit, yocto(1), "NEP-141 asks for 1 yoctoNEAR");
                assert_eq!(*prepaid_gas, GAS_FOR_FT_TRANSFER);
                assert_eq!(gas_weight.0, 0, "a transfer gets static gas only");
                let v: Value = near_sdk::serde_json::from_slice(args).unwrap();
                assert_eq!(v["memo"], format!("Headcount round {id}"));
            }
            other => panic!("{other:?}"),
        }
    }
    assert!(transfers().is_empty(), "no NEAR moves in a token round");
}

#[test]
fn the_callback_marks_each_payment_paid_or_failed() {
    let (mut h, id) = screened_and_funded(TOKEN, vec![group(&["alice", "bob"], "same-funder")]);
    pay_batch(&mut h, &id, 3);
    ctx_results(results(&[OK, FAIL, OK]));
    h.on_payouts(id.clone(), vec![2, 3, 4]);

    assert_eq!(
        states(&h, &id),
        st(&[
            ("alice", Held),
            ("bob", Held),
            ("carol", Paid),
            ("dave", Failed),
            ("erin", Paid)
        ])
    );
    let round = h.get_round(id).unwrap();
    assert_eq!((round.paid, round.refunded), (U128(80), U128(0)));
    let logs = get_logs().join("\n");
    assert!(
        logs.contains("dave.test.near") && logs.contains("refund_expired"),
        "the log says the failed payment can go back to the DAO: {logs}"
    );
}

#[test]
fn a_payment_in_flight_or_paid_is_never_paid_again() {
    let (mut h, id) = screened_and_funded(NATIVE, vec![]);
    assert_eq!(pay_batch(&mut h, &id, 2), 3, "alice and bob in flight");
    assert_eq!(pay_batch(&mut h, &id, 2), 1, "carol and dave in flight");
    assert_eq!(
        transfers(),
        vec![(acc("carol.test.near"), 30), (acc("dave.test.near"), 40)]
    );
    ctx_results(results(&[OK, OK]));
    h.on_payouts(id.clone(), vec![0, 1]);
    assert_eq!(pay_batch(&mut h, &id, 5), 0);
    assert_eq!(transfers(), vec![(acc("erin.test.near"), 50)]);
}

#[test]
#[should_panic(expected = "its 2 held recipient(s) wait for a council vote")]
fn scenario_7_a_held_recipient_is_never_paid() {
    let (mut h, id) = screened_and_funded(NATIVE, vec![group(&["alice", "bob"], "same-funder")]);
    assert_eq!(pay_batch(&mut h, &id, 100), 0);
    let paid: Vec<AccountId> = transfers().into_iter().map(|(to, _)| to).collect();
    assert_eq!(
        paid,
        vec![
            acc("carol.test.near"),
            acc("dave.test.near"),
            acc("erin.test.near")
        ]
    );
    pay_batch(&mut h, &id, 100);
}

#[test]
#[should_panic(expected = "every payment is paid, in flight or going back to the DAO")]
fn a_round_with_nothing_left_to_pay_says_so() {
    let (mut h, id) = screened_and_funded(NATIVE, vec![]);
    pay_batch(&mut h, &id, 5);
    pay_batch(&mut h, &id, 5);
}

#[test]
#[should_panic(expected = "has no verdict yet: nothing is paid before the screen")]
fn nothing_is_paid_before_the_verdict() {
    let mut h = configured();
    let id = create(&mut h, NATIVE, five());
    fund(&mut h, &id);
    pay_batch(&mut h, &id, 5);
}

#[test]
#[should_panic(expected = "is not funded yet")]
fn nothing_is_paid_before_the_dao_funds_the_round() {
    let mut h = configured();
    let id = create(&mut h, NATIVE, five());
    post(&mut h, &id, verdict(vec![]));
    pay_batch(&mut h, &id, 5);
}

#[test]
#[should_panic(expected = "limit must be at least 1")]
fn a_limit_of_0_is_refused() {
    let (mut h, id) = screened_and_funded(NATIVE, vec![]);
    pay_batch(&mut h, &id, 0);
}

#[test]
fn a_batch_pays_only_as_many_as_its_gas_covers() {
    let (mut h, id) = screened_and_funded(TOKEN, vec![]);
    let per = GAS_PER_FT_PAYMENT.as_gas();
    let room = GAS_RESERVE.as_gas() + GAS_FOR_CALLBACK.as_gas() + 2 * per + per / 2;
    ctx_gas(ANYONE, Gas::from_gas(room));
    assert_eq!(h.payout_batch(id, 5), 3, "two paid, three left");
    assert_eq!(ft_transfers().len(), 2);
}

/// A NEAR-implicit account: 64 hex characters, created by the first NEAR transfer it receives.
const IMPLICIT: &str = "00000000000000000000000000000000000000000000000000000000000000a1";

#[test]
fn a_near_payout_to_an_implicit_account_is_counted_at_what_creating_it_costs() {
    // NEAR charges every NEAR transfer to an implicit account the fees of creating it and adding
    // its key (about 8.4 TGas on protocol 86), whether or not it exists yet. The implicit account
    // sorts first; the room left after it is less than one more payment, so the batch stops there.
    let mut h = configured();
    let list = vec![
        pay("alice.test.near", 20),
        pay(IMPLICIT, 10),
        pay("bob.test.near", 30),
    ];
    let id = create(&mut h, NATIVE, list);
    post(&mut h, &id, verdict(vec![]));
    fund(&mut h, &id);
    let base = GAS_RESERVE.as_gas() + GAS_FOR_CALLBACK.as_gas();
    let room = GAS_PER_NEAR_PAYMENT_TO_IMPLICIT.as_gas() + GAS_PER_NEAR_PAYMENT.as_gas() / 2;
    ctx_gas(ANYONE, Gas::from_gas(base + room));
    assert_eq!(h.payout_batch(id, 3), 2, "only the implicit account fits");
    assert_eq!(transfers(), vec![(acc(IMPLICIT), 10)]);
}

#[test]
fn a_near_payout_to_a_named_account_is_counted_as_a_plain_transfer() {
    let (mut h, id) = screened_and_funded(NATIVE, vec![]);
    let base = GAS_RESERVE.as_gas() + GAS_FOR_CALLBACK.as_gas();
    let room = GAS_PER_NEAR_PAYMENT.as_gas() * 5 / 2;
    ctx_gas(ANYONE, Gas::from_gas(base + room));
    assert_eq!(
        h.payout_batch(id, 5),
        3,
        "two named accounts fit, three left"
    );
    assert_eq!(
        transfers(),
        vec![(acc("alice.test.near"), 10), (acc("bob.test.near"), 20)]
    );
}

#[test]
#[should_panic(expected = "attach more gas")]
fn a_batch_without_gas_for_one_payment_is_refused() {
    let (mut h, id) = screened_and_funded(TOKEN, vec![]);
    ctx_gas(ANYONE, Gas::from_tgas(25));
    h.payout_batch(id, 5);
}

#[test]
fn paying_and_recording_payments_never_grow_storage() {
    let (mut h, id) = screened_and_funded(TOKEN, vec![group(&["alice", "bob"], "same-funder")]);
    ctx(ANYONE, yocto(0));
    let before = env::storage_usage();
    h.payout_batch(id.clone(), 5);
    h.rounds.flush();
    assert_eq!(env::storage_usage(), before, "payout_batch");

    ctx_results(results(&[OK, FAIL, OK]));
    let before = env::storage_usage();
    h.on_payouts(id, vec![2, 3, 4]);
    h.rounds.flush();
    assert_eq!(env::storage_usage(), before, "on_payouts");
}

#[test]
#[should_panic(expected = "Method on_payouts is private")]
fn only_headcount_reports_how_its_payouts_went() {
    let (mut h, id) = screened_and_funded(TOKEN, vec![]);
    pay_batch(&mut h, &id, 1);
    ctx_results_from(ANYONE, results(&[OK]));
    h.on_payouts(id, vec![0]);
}

#[test]
#[should_panic(expected = "Method on_refund is private")]
fn only_headcount_reports_how_a_refund_went() {
    let (mut h, id) = screened_and_funded(TOKEN, two_groups());
    decide(&mut h, &id, 1, Decision::Refund);
    ctx_results_from(DAO, results(&[OK]));
    h.on_refund(id, vec![0, 1]);
}

// --- resolve_group: the council's decision on a held group --------------------------------------

#[test]
#[should_panic(
    expected = "only dao.test.near can resolve a held group of its round: file a FunctionCall proposal on the DAO"
)]
fn scenario_7_the_requestor_cannot_resolve_a_group_without_a_vote() {
    let (mut h, id) = screened_and_funded(NATIVE, two_groups());
    ctx(REQUESTOR, yocto(0));
    h.resolve_group(id, 1, Decision::ReleaseAll);
}

#[test]
#[should_panic(expected = "only dao.test.near can resolve a held group of its round")]
fn scenario_7_the_screener_cannot_resolve_a_group_either() {
    let (mut h, id) = screened_and_funded(NATIVE, two_groups());
    ctx(SCREENER, yocto(0));
    h.resolve_group(id, 1, Decision::ReleaseAll);
}

#[test]
#[should_panic(expected = "only dao.test.near can resolve a held group of its round")]
fn scenario_7_a_held_recipient_cannot_release_itself() {
    let (mut h, id) = screened_and_funded(NATIVE, two_groups());
    ctx("alice.test.near", yocto(0));
    h.resolve_group(id, 1, released_one("alice"));
}

#[test]
fn release_all_makes_the_whole_group_payable() {
    let (mut h, id) = screened_and_funded(NATIVE, two_groups());
    decide(&mut h, &id, 2, Decision::ReleaseAll);
    assert!(
        get_created_receipts().is_empty(),
        "nothing moves until payout_batch"
    );
    assert_eq!(
        states(&h, &id),
        st(&[
            ("alice", Held),
            ("bob", Held),
            ("carol", Pending),
            ("dave", Released),
            ("erin", Released)
        ])
    );
    let groups = h.get_round(id.clone()).unwrap().groups;
    assert_eq!(
        (groups[0].state, groups[1].state),
        (GroupState::Open, GroupState::ReleasedAll)
    );
    assert_eq!(
        (groups[1].released.clone(), groups[1].decided_at_sec),
        (None, Some(NOW_SEC))
    );

    assert_eq!(pay_batch(&mut h, &id, 5), 0);
    assert_eq!(
        transfers(),
        vec![
            (acc("carol.test.near"), 30),
            (acc("dave.test.near"), 40),
            (acc("erin.test.near"), 50)
        ]
    );
}

#[test]
fn release_one_pays_one_account_and_sends_the_others_back_to_the_dao() {
    let (mut h, id) = screened_and_funded(TOKEN, two_groups());
    decide(&mut h, &id, 2, released_one("erin"));

    assert_eq!(
        ft_transfers(),
        vec![(TOKEN.into(), DAO.into(), 40)],
        "dave's 40 goes back to the DAO"
    );
    let (method, args, waits_on, _, _) = callback();
    assert_eq!(
        (method.as_str(), args, waits_on),
        ("on_refund", json!({ "round_id": id, "positions": [3] }), 1)
    );
    assert_eq!(
        states(&h, &id),
        st(&[
            ("alice", Held),
            ("bob", Held),
            ("carol", Pending),
            ("dave", Refunding),
            ("erin", Released)
        ])
    );
    let group = h.get_round(id.clone()).unwrap().groups[1].clone();
    assert_eq!(
        (group.state, group.released),
        (GroupState::ReleasedOne, Some(acc("erin.test.near")))
    );

    ctx_results(results(&[OK]));
    h.on_refund(id.clone(), vec![3]);
    assert_eq!(h.get_round(id).unwrap().refunded, U128(40));
}

#[test]
fn refund_sends_the_whole_group_back_to_the_dao() {
    let (mut h, id) = screened_and_funded(NATIVE, two_groups());
    decide(&mut h, &id, 1, Decision::Refund);
    assert_eq!(transfers(), vec![(acc(DAO), 30)]);
    let (method, args, _, _, _) = callback();
    assert_eq!(
        (method.as_str(), args),
        ("on_refund", json!({ "round_id": id, "positions": [0, 1] }))
    );
    assert_eq!(
        h.get_round(id.clone()).unwrap().groups[0].state,
        GroupState::Refunded
    );
    assert_eq!(
        states(&h, &id)[..2],
        st(&[("alice", Refunding), ("bob", Refunding)])
    );
}

#[test]
#[should_panic(expected = "is already resolved: ReleasedAll")]
fn a_group_is_decided_once() {
    let (mut h, id) = screened_and_funded(NATIVE, two_groups());
    decide(&mut h, &id, 1, Decision::ReleaseAll);
    decide(&mut h, &id, 1, Decision::Refund);
}

#[test]
#[should_panic(expected = "carol.test.near is not in group 1")]
fn release_one_must_name_an_account_of_the_group() {
    let (mut h, id) = screened_and_funded(NATIVE, two_groups());
    decide(&mut h, &id, 1, released_one("carol"));
}

#[test]
#[should_panic(expected = "has no group 0: its verdict holds 2 group(s), numbered from 1")]
fn groups_are_numbered_from_1() {
    let (mut h, id) = screened_and_funded(NATIVE, two_groups());
    decide(&mut h, &id, 0, Decision::ReleaseAll);
}

#[test]
#[should_panic(expected = "has no group 3: its verdict holds 2 group(s), numbered from 1")]
fn there_is_no_group_past_the_last() {
    let (mut h, id) = screened_and_funded(NATIVE, two_groups());
    decide(&mut h, &id, 3, Decision::ReleaseAll);
}

#[test]
#[should_panic(expected = "is not funded yet: the DAO funds it before deciding its held groups")]
fn a_group_of_an_unfunded_round_cannot_be_decided() {
    let mut h = configured();
    let id = create(&mut h, NATIVE, five());
    post(&mut h, &id, verdict(two_groups()));
    decide(&mut h, &id, 1, Decision::ReleaseAll);
}

#[test]
#[should_panic(expected = "has no verdict, so no held groups")]
fn a_round_without_a_verdict_has_no_group_to_decide() {
    let mut h = configured();
    let id = create(&mut h, NATIVE, five());
    fund(&mut h, &id);
    decide(&mut h, &id, 1, Decision::ReleaseAll);
}

#[test]
fn the_council_can_still_decide_after_the_hold_window_until_someone_sends_the_group_back() {
    let (mut h, id) = screened_and_funded(NATIVE, two_groups());
    ctx_at(DAO, yocto(0), NOW_SEC + 3 * DAY);
    h.resolve_group(id.clone(), 1, Decision::ReleaseAll);
    assert_eq!(
        states(&h, &id)[..2],
        st(&[("alice", Released), ("bob", Released)])
    );
}

#[test]
fn deciding_a_group_never_grows_storage() {
    let (mut h, id) = screened_and_funded(TOKEN, two_groups());
    ctx(DAO, yocto(0));
    let before = env::storage_usage();
    h.resolve_group(id.clone(), 2, released_one("erin"));
    h.rounds.flush();
    assert_eq!(env::storage_usage(), before);
}

// --- refund_expired --------------------------------------------------------------------------------

#[test]
fn scenario_10_a_funded_round_that_never_gets_a_verdict_goes_back_whole() {
    let mut h = configured();
    let id = create(&mut h, NATIVE, five());
    fund(&mut h, &id);
    refund_at(&mut h, &id, NOW_SEC + 2 * DAY + 1);

    assert_eq!(
        transfers(),
        vec![(acc(DAO), 150)],
        "one transfer, the whole total"
    );
    let (method, args, waits_on, _, _) = callback();
    assert_eq!(
        (method.as_str(), args, waits_on),
        (
            "on_refund",
            json!({ "round_id": id, "positions": [0, 1, 2, 3, 4] }),
            1
        )
    );
    assert!(
        states(&h, &id).iter().all(|(_, s)| *s == Refunding),
        "{:?}",
        states(&h, &id)
    );

    ctx_results(results(&[OK]));
    h.on_refund(id.clone(), vec![0, 1, 2, 3, 4]);
    let round = h.get_round(id.clone()).unwrap();
    assert!(round.payments.iter().all(|p| p.state == Refunded));
    assert_eq!((round.paid, round.refunded), (U128(0), U128(150)));
}

#[test]
#[should_panic(expected = "waits for a verdict until 1794182400 (unix seconds)")]
fn an_unscreened_round_waits_out_its_verdict_window() {
    let mut h = configured();
    let id = create(&mut h, NATIVE, five());
    fund(&mut h, &id);
    refund_at(&mut h, &id, NOW_SEC + 2 * DAY);
}

#[test]
fn scenario_9_held_groups_left_undecided_go_back_after_the_hold_window() {
    let (mut h, id) = screened_and_funded(TOKEN, two_groups());
    pay_batch(&mut h, &id, 5);
    ctx_results(results(&[OK]));
    h.on_payouts(id.clone(), vec![2]);

    refund_at(&mut h, &id, NOW_SEC + 2 * DAY + 1);
    assert_eq!(
        ft_transfers(),
        vec![(TOKEN.into(), DAO.into(), 10 + 20 + 40 + 50)]
    );
    let (_, args, _, _, _) = callback();
    assert_eq!(args["positions"], json!([0, 1, 3, 4]));
    let groups = h.get_round(id.clone()).unwrap().groups;
    assert!(
        groups
            .iter()
            .all(|g| g.state == GroupState::Expired
                && g.decided_at_sec == Some(NOW_SEC + 2 * DAY + 1)),
        "{groups:?}"
    );

    ctx_results(results(&[OK]));
    h.on_refund(id.clone(), vec![0, 1, 3, 4]);
    let round = h.get_round(id).unwrap();
    assert_eq!((round.paid, round.refunded), (U128(30), U128(120)));
}

#[test]
#[should_panic(expected = "held groups wait for a council vote until 1794182400 (unix seconds)")]
fn held_groups_wait_out_the_hold_window() {
    let (mut h, id) = screened_and_funded(TOKEN, two_groups());
    refund_at(&mut h, &id, NOW_SEC + 2 * DAY);
}

#[test]
fn the_hold_window_counts_from_the_later_of_the_verdict_and_the_funding() {
    let mut h = configured();
    let id = create(&mut h, NATIVE, five());
    post(&mut h, &id, verdict(two_groups()));
    ctx_at(DAO, yocto(150), NOW_SEC + DAY);
    h.fund_round(id.clone());
    assert_eq!(
        h.get_round(id.clone()).unwrap().hold_deadline_sec,
        Some(NOW_SEC + 3 * DAY)
    );
    refund_at(&mut h, &id, NOW_SEC + 3 * DAY + 1);
    assert_eq!(transfers(), vec![(acc(DAO), 10 + 20 + 40 + 50)]);
}

#[test]
fn cleared_recipients_stay_payable_after_the_held_groups_go_back() {
    let (mut h, id) = screened_and_funded(TOKEN, two_groups());
    refund_at(&mut h, &id, NOW_SEC + 2 * DAY + 1);
    assert_eq!(pay_batch(&mut h, &id, 5), 0);
    assert_eq!(
        ft_transfers(),
        vec![(TOKEN.into(), "carol.test.near".into(), 30)]
    );
}

#[test]
fn a_failed_payment_goes_back_to_the_dao_at_any_time() {
    let (mut h, id) = screened_and_funded(TOKEN, vec![]);
    pay_batch(&mut h, &id, 5);
    ctx_results(results(&[OK, OK, FAIL, OK, OK]));
    h.on_payouts(id.clone(), vec![0, 1, 2, 3, 4]);

    refund_at(&mut h, &id, NOW_SEC);
    assert_eq!(ft_transfers(), vec![(TOKEN.into(), DAO.into(), 30)]);
    assert_eq!(states(&h, &id)[2], ("carol".to_string(), Refunding));
}

#[test]
fn a_refund_that_fails_can_be_sent_again() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    fund(&mut h, &id);
    refund_at(&mut h, &id, NOW_SEC + 2 * DAY + 1);
    ctx_results(results(&[FAIL]));
    h.on_refund(id.clone(), vec![0, 1, 2, 3, 4]);
    assert!(states(&h, &id).iter().all(|(_, s)| *s == Failed));
    assert_eq!(h.get_round(id.clone()).unwrap().refunded, U128(0));

    refund_at(&mut h, &id, NOW_SEC + 2 * DAY + 2);
    assert_eq!(ft_transfers(), vec![(TOKEN.into(), DAO.into(), 150)]);
    ctx_results(results(&[OK]));
    h.on_refund(id.clone(), vec![0, 1, 2, 3, 4]);
    assert_eq!(h.get_round(id).unwrap().refunded, U128(150));
}

#[test]
#[should_panic(expected = "is not funded: there is nothing to return")]
fn an_unfunded_round_has_nothing_to_return() {
    let mut h = configured();
    let id = create(&mut h, NATIVE, five());
    refund_at(&mut h, &id, NOW_SEC + 300 * DAY);
}

#[test]
#[should_panic(expected = "owes the DAO nothing")]
fn a_settled_round_has_nothing_to_return() {
    let (mut h, id) = screened_and_funded(NATIVE, vec![]);
    pay_batch(&mut h, &id, 5);
    ctx_results(results(&[OK, OK, OK, OK, OK]));
    h.on_payouts(id.clone(), vec![0, 1, 2, 3, 4]);
    refund_at(&mut h, &id, NOW_SEC + 300 * DAY);
}

#[test]
fn refunding_never_grows_storage() {
    let mut h = configured();
    let id = create(&mut h, TOKEN, five());
    fund(&mut h, &id);
    ctx_at(ANYONE, yocto(0), NOW_SEC + 2 * DAY + 1);
    let before = env::storage_usage();
    h.refund_expired(id.clone());
    h.rounds.flush();
    assert_eq!(env::storage_usage(), before, "refund_expired");

    ctx_results(results(&[OK]));
    let before = env::storage_usage();
    h.on_refund(id, vec![0, 1, 2, 3, 4]);
    h.rounds.flush();
    assert_eq!(env::storage_usage(), before, "on_refund");
}

// --- scenario 11: an edited list is another round ----------------------------------------------

#[test]
#[should_panic(expected = "has no verdict yet: nothing is paid before the screen")]
fn scenario_11_an_edited_amount_is_a_new_round_that_the_old_verdict_does_not_cover() {
    let mut h = configured();
    let screened = create(&mut h, TOKEN, five());
    post(&mut h, &screened, verdict(two_groups()));

    let mut edited = five();
    edited[2].amount = U128(31);
    let id = create(&mut h, TOKEN, edited);
    assert_ne!(id, screened, "one edited amount, another round id");
    let round = h.get_round(id.clone()).unwrap();
    assert_eq!(round.verdict, None);
    assert!(
        round.payments.iter().all(|p| p.state == Pending),
        "no hold carries over"
    );
    assert!(
        h.get_verdict(screened).is_some(),
        "the old round keeps its verdict"
    );

    fund(&mut h, &id);
    pay_batch(&mut h, &id, 5);
}

// --- views ---------------------------------------------------------------------------------------

#[test]
fn get_round_shows_each_group_the_totals_and_the_deadlines() {
    let (h, id) = screened_and_funded(NATIVE, two_groups());
    let round = h.get_round(id).unwrap();
    assert_eq!(round.verdict_deadline_sec, NOW_SEC + 2 * DAY);
    assert_eq!(round.hold_deadline_sec, Some(NOW_SEC + 2 * DAY));
    assert_eq!((round.paid, round.refunded), (U128(0), U128(0)));
    assert_eq!(
        round.groups,
        vec![
            GroupView {
                group: 1,
                accounts: vec![acc("alice.test.near"), acc("bob.test.near")],
                state: GroupState::Open,
                released: None,
                decided_at_sec: None,
            },
            GroupView {
                group: 2,
                accounts: vec![acc("dave.test.near"), acc("erin.test.near")],
                state: GroupState::Open,
                released: None,
                decided_at_sec: None,
            },
        ]
    );
}

#[test]
fn a_round_without_a_verdict_or_funding_has_no_hold_deadline() {
    let mut h = configured();
    let id = create(&mut h, NATIVE, five());
    post(&mut h, &id, verdict(two_groups()));
    assert_eq!(
        h.get_round(id).unwrap().hold_deadline_sec,
        None,
        "not funded yet"
    );
}

#[test]
fn get_rounds_lists_a_daos_rounds_in_the_order_they_were_created() {
    let mut h = configured();
    let a = create(&mut h, NATIVE, three());
    let b = create(&mut h, TOKEN, five());
    ctx(REQUESTOR, near(100));
    let c = h.create_round(acc(DAO), NATIVE.into(), three(), 99);
    ctx("other-dao.test.near", near(10));
    h.configure(acc("other-dao.test.near"), acc(SCREENER), DAY, DAY);
    ctx(REQUESTOR, near(100));
    let other = h.create_round(acc("other-dao.test.near"), NATIVE.into(), three(), 1);

    let ids = |dao: &str, from: u32, limit: u32| -> Vec<String> {
        h.get_rounds(acc(dao), from, limit)
            .into_iter()
            .map(|r| r.round_id)
            .collect()
    };
    assert_eq!(ids(DAO, 0, 10), vec![a, b.clone(), c]);
    assert_eq!(ids(DAO, 1, 1), vec![b]);
    assert_eq!(ids(DAO, 3, 10), Vec::<String>::new());
    assert_eq!(ids("other-dao.test.near", 0, 10), vec![other]);
    assert_eq!(ids("nobody.test.near", 0, 10), Vec::<String>::new());
}

// --- scenario 13: the books balance, whatever the path --------------------------------------------

#[test]
fn scenario_13_every_unit_funded_is_paid_or_refunded_exactly_once_whatever_the_path() {
    // Eight recipients, positions 0..8, amounts 10..80. Group 1 (alice, bob): the council releases
    // bob, and the refund of alice's share fails once. Group 2 (dave, erin, frank): nobody decides.
    // Group 3 (grace, heidi): released. Carol is cleared, but her transfer fails.
    let names = [
        "alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi",
    ];
    let list: Vec<PaymentInput> = names
        .iter()
        .zip(1..)
        .map(|(n, i)| pay(&format!("{n}.test.near"), 10 * i))
        .collect();
    let mut h = configured();
    let id = create(&mut h, TOKEN, list);
    post(
        &mut h,
        &id,
        verdict(vec![
            group(&["alice", "bob"], "same-funder"),
            group(&["dave", "erin", "frank"], "shared-key"),
            group(&["grace", "heidi"], "direct-transfer"),
        ]),
    );
    fund(&mut h, &id);

    // Every token transfer that went through, as (receiver, amount).
    let mut moved: Vec<(String, u128)> = Vec::new();
    let mut settle = |h: &mut Headcount, outcomes: &[fn() -> PromiseResult], method: &str| {
        let sent = ft_transfers();
        let (called, args, _, _, _) = callback();
        assert_eq!(called, method);
        let positions: Vec<u32> =
            near_sdk::serde_json::from_value(args["positions"].clone()).unwrap();
        for ((_, to, amount), outcome) in sent.iter().zip(outcomes) {
            if matches!(outcome(), PromiseResult::Successful(_)) {
                moved.push((to.clone(), *amount));
            }
        }
        ctx_results(results(outcomes));
        match method {
            "on_payouts" => h.on_payouts(id.clone(), positions),
            _ => h.on_refund(id.clone(), positions),
        }
    };

    decide(&mut h, &id, 3, Decision::ReleaseAll);
    decide(&mut h, &id, 1, released_one("bob"));
    settle(&mut h, &[FAIL], "on_refund"); // alice's 10 does not reach the DAO
    assert_eq!(pay_batch(&mut h, &id, 10), 0); // bob, carol, grace, heidi
    settle(&mut h, &[OK, FAIL, OK, OK], "on_payouts"); // carol's 30 fails
    refund_at(&mut h, &id, NOW_SEC + 2 * DAY + 1); // group 2 expires; alice and carol go back too
    settle(&mut h, &[OK], "on_refund");

    let round = h.get_round(id.clone()).unwrap();
    assert!(
        round
            .payments
            .iter()
            .all(|p| matches!(p.state, Paid | Refunded)),
        "every payment settled: {:?}",
        round.payments
    );
    assert_eq!(round.paid.0, 20 + 70 + 80, "bob, grace, heidi");
    assert_eq!(
        round.refunded.0,
        10 + 30 + 40 + 50 + 60,
        "alice, carol, dave, erin, frank"
    );
    assert_eq!(
        round.paid.0 + round.refunded.0,
        round.total.0,
        "paid + refunded = funded"
    );
    assert_eq!(
        moved.iter().map(|(_, a)| a).sum::<u128>(),
        round.total.0,
        "the transfers that went through add up to the total: nothing twice, nothing left"
    );
    assert_eq!(
        moved,
        vec![
            ("bob.test.near".into(), 20),
            ("grace.test.near".into(), 70),
            ("heidi.test.near".into(), 80),
            (DAO.into(), 190)
        ]
    );
    let outcomes: Vec<GroupState> = round.groups.iter().map(|g| g.state).collect();
    assert_eq!(
        outcomes,
        vec![
            GroupState::ReleasedOne,
            GroupState::Expired,
            GroupState::ReleasedAll
        ]
    );
}

// --- get_account_record: an account's record with one DAO, read from that DAO's rounds ----------

fn record(h: &Headcount, dao: &str, name: &str) -> AccountRecord {
    h.get_account_record(acc(dao), acc(&format!("{name}.test.near")), None, None)
}

/// (listed, held, paid, returned): the counts, without the paging fields.
fn counts(r: &AccountRecord) -> (u32, u32, u32, u32) {
    (
        r.rounds_listed,
        r.rounds_held,
        r.rounds_paid,
        r.rounds_returned,
    )
}

/// Two rounds of five() for the DAO. Round 1 holds alice and bob; the council pays alice and
/// returns bob's share; carol, dave and erin are paid. Round 2 holds no one; every transfer arrives
/// but alice's, which fails and goes back to the DAO.
fn two_settled_rounds() -> (Headcount, String, String) {
    let (mut h, first) = screened_and_funded(TOKEN, vec![group(&["alice", "bob"], "same-funder")]);
    pay_batch(&mut h, &first, 5);
    ctx_results(results(&[OK, OK, OK]));
    h.on_payouts(first.clone(), vec![2, 3, 4]);
    decide(&mut h, &first, 1, released_one("alice"));
    ctx_results(results(&[OK]));
    h.on_refund(first.clone(), vec![1]);
    pay_batch(&mut h, &first, 5);
    ctx_results(results(&[OK]));
    h.on_payouts(first.clone(), vec![0]);

    ctx(REQUESTOR, near(100));
    let second = h.create_round(acc(DAO), TOKEN.to_string(), five(), 1_794_009_600_001);
    post(&mut h, &second, verdict(vec![]));
    fund(&mut h, &second);
    pay_batch(&mut h, &second, 5);
    ctx_results(results(&[FAIL, OK, OK, OK, OK]));
    h.on_payouts(second.clone(), vec![0, 1, 2, 3, 4]);
    refund_at(&mut h, &second, NOW_SEC);
    ctx_results(results(&[OK]));
    h.on_refund(second.clone(), vec![0]);
    (h, first, second)
}

#[test]
fn an_account_in_no_round_has_an_empty_record() {
    let h = configured();
    assert_eq!(
        record(&h, DAO, "alice"),
        AccountRecord {
            rounds_listed: 0,
            rounds_held: 0,
            rounds_paid: 0,
            rounds_returned: 0,
            rounds_read: 0,
            rounds_total: 0
        }
    );
}

#[test]
fn a_record_counts_the_daos_rounds_that_list_hold_pay_or_return_an_account() {
    let (h, first, second) = two_settled_rounds();
    assert!(
        h.get_round(first)
            .unwrap()
            .payments
            .iter()
            .all(|p| matches!(p.state, Paid | Refunded))
    );
    assert!(
        h.get_round(second)
            .unwrap()
            .payments
            .iter()
            .all(|p| matches!(p.state, Paid | Refunded))
    );

    assert_eq!(
        counts(&record(&h, DAO, "alice")),
        (2, 1, 1, 1),
        "held and paid once, returned once"
    );
    assert_eq!(
        counts(&record(&h, DAO, "bob")),
        (2, 1, 1, 1),
        "held and returned once, paid once"
    );
    assert_eq!(counts(&record(&h, DAO, "carol")), (2, 0, 2, 0));
    assert_eq!(
        counts(&record(&h, DAO, "frank")),
        (0, 0, 0, 0),
        "listed in neither"
    );
    let r = record(&h, DAO, "carol");
    assert_eq!((r.rounds_read, r.rounds_total), (2, 2));
}

#[test]
fn a_round_not_yet_screened_or_funded_counts_only_as_listed() {
    let mut h = configured();
    create(&mut h, NATIVE, five());
    assert_eq!(counts(&record(&h, DAO, "alice")), (1, 0, 0, 0));
}

#[test]
fn a_held_account_counts_as_held_before_the_council_decides() {
    let (h, _) = screened_and_funded(NATIVE, two_groups());
    assert_eq!(counts(&record(&h, DAO, "dave")), (1, 1, 0, 0));
    assert_eq!(counts(&record(&h, DAO, "carol")), (1, 0, 0, 0));
}

#[test]
fn records_are_kept_per_dao_so_another_account_screening_its_own_rounds_changes_nothing() {
    // Any account can configure itself as a DAO and name itself screener. Its rounds and verdicts
    // show in its own records, never in another DAO's.
    let (mut h, _, _) = two_settled_rounds();
    let before = record(&h, DAO, "carol");
    const SELF_DAO: &str = "self-dao.test.near";
    ctx(SELF_DAO, near(10));
    h.configure(acc(SELF_DAO), acc(SELF_DAO), 2 * DAY, 2 * DAY);
    ctx(SELF_DAO, near(100));
    let own = h.create_round(acc(SELF_DAO), TOKEN.to_string(), five(), 1_794_009_600_000);
    ctx(SELF_DAO, near(100));
    h.post_verdict(own, verdict(vec![group(&["carol", "dave"], "same-funder")]));

    assert_eq!(
        record(&h, DAO, "carol"),
        before,
        "the DAO's record of carol is untouched"
    );
    assert_eq!(counts(&record(&h, SELF_DAO, "carol")), (1, 1, 0, 0));
}

#[test]
fn a_record_can_be_read_in_pages_of_the_daos_rounds() {
    let (h, _, _) = two_settled_rounds();
    let alice = acc("alice.test.near");
    let page = |from: u32, limit: u32| {
        h.get_account_record(acc(DAO), alice.clone(), Some(from), Some(limit))
    };
    let first = page(0, 1);
    let second = page(1, 1);
    assert_eq!(
        (counts(&first), first.rounds_read, first.rounds_total),
        ((1, 1, 1, 0), 1, 2),
        "round 1 only"
    );
    assert_eq!(
        (counts(&second), second.rounds_read, second.rounds_total),
        ((1, 0, 0, 1), 1, 2),
        "round 2 only"
    );
    assert_eq!(page(2, 10).rounds_read, 0, "past the last round");
}

// --- the verdict: written by post_verdict, read by the views, never by a call that moves money -----

/// A group of the same accounts as `group(names, ..)`, at every bound a verdict allows: 5 signals of
/// 32 characters and 32 pieces of evidence of 128.
fn largest_group(names: &[&str]) -> HeldGroup {
    HeldGroup {
        signals: (0..MAX_SIGNALS)
            .map(|k| format!("{:s<w$}", format!("signal-{k}"), w = MAX_SIGNAL_LEN))
            .collect(),
        evidence: (0..MAX_EVIDENCE)
            .map(|k| format!("{:e<w$}", format!("evidence-{k}"), w = MAX_EVIDENCE_LEN))
            .collect(),
        ..group(names, "same-funder")
    }
}

impl Headcount {
    /// Writes every cached change to storage, as the end of a real call does.
    fn flush_all(&mut self) {
        self.configs.flush();
        self.rounds.flush();
        self.round_counts.flush();
        self.round_index.flush();
        self.verdicts.flush();
    }
}

/// The gas `call` uses when it runs on the contract as a real call finds it: read fresh from
/// storage, with nothing cached from earlier calls. Set the call's context first.
fn gas_of(h: &mut Headcount, call: impl FnOnce(&mut Headcount)) -> u64 {
    h.flush_all();
    env::state_write(h);
    let mut fresh: Headcount = env::state_read().expect("the contract's state");
    let before = env::used_gas().as_gas();
    call(&mut fresh);
    let used = env::used_gas().as_gas() - before;
    fresh.flush_all();
    *h = fresh;
    used
}

/// Every call that moves money, on a round of five() whose verdict holds alice and bob as `first`
/// and dave and erin as a small second group, with the gas each used: the token funding, a batch and
/// its callback, a council decision and its refund's callback, then the expired group's refund and
/// its callback. The mock keeps storage between calls, so each run takes its own `timestamp` and
/// with it a round of its own.
fn money_path_gas(first: HeldGroup, timestamp: u64) -> Vec<(&'static str, u64)> {
    let mut h = configured();
    ctx(REQUESTOR, near(100));
    let id = h.create_round(acc(DAO), TOKEN.to_string(), five(), timestamp);
    post(
        &mut h,
        &id,
        verdict(vec![first, group(&["dave", "erin"], "shared-key")]),
    );
    let mut gas = Vec::new();
    ctx(TOKEN, yocto(0));
    let funded = gas_of(&mut h, |h| {
        assert_eq!(h.ft_on_transfer(acc(DAO), U128(150), id.clone()), U128(0));
    });
    gas.push(("ft_on_transfer", funded));
    ctx(ANYONE, yocto(0));
    let batch = gas_of(&mut h, |h| assert_eq!(h.payout_batch(id.clone(), 5), 0));
    gas.push(("payout_batch", batch));
    ctx_results(results(&[OK]));
    gas.push((
        "on_payouts",
        gas_of(&mut h, |h| h.on_payouts(id.clone(), vec![2])),
    ));
    ctx(DAO, yocto(0));
    let decided = gas_of(&mut h, |h| {
        h.resolve_group(id.clone(), 1, released_one("alice"))
    });
    gas.push(("resolve_group", decided));
    ctx_results(results(&[OK]));
    gas.push((
        "on_refund",
        gas_of(&mut h, |h| h.on_refund(id.clone(), vec![1])),
    ));
    ctx_at(ANYONE, yocto(0), NOW_SEC + 3 * DAY);
    gas.push((
        "refund_expired",
        gas_of(&mut h, |h| h.refund_expired(id.clone())),
    ));
    ctx_results(results(&[OK]));
    gas.push((
        "on_refund",
        gas_of(&mut h, |h| h.on_refund(id.clone(), vec![3, 4])),
    ));
    assert_eq!(
        states(&h, &id),
        st(&[
            ("alice", Released),
            ("bob", Refunded),
            ("carol", Paid),
            ("dave", Refunded),
            ("erin", Refunded)
        ])
    );
    gas
}

#[test]
fn no_call_that_moves_money_reads_the_verdict_so_its_size_never_changes_their_gas() {
    // A callback gets a fixed amount of gas when its caller attaches the least that succeeds. If a
    // callback read the verdict, a large verdict could run it out of gas after its transfers left,
    // stranding their payments in Paying or Refunding. So nothing that moves money may read it.
    let small = money_path_gas(group(&["alice", "bob"], "same-funder"), 1);
    let large = money_path_gas(largest_group(&["alice", "bob"]), 2);
    assert!(
        small.iter().all(|(_, gas)| *gas > 0),
        "the mock counts gas: {small:?}"
    );
    assert_eq!(small, large);
}
