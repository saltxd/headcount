//! Unit tests on near-sdk's mocked VM. Each `ctx` call starts a new call from `predecessor` with
//! `deposit` attached; storage carries over between calls, as on chain.

use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts};
use near_sdk::testing_env;

const HEADCOUNT: &str = "headcount.test.near";
const DAO: &str = "dao.test.near";
const SCREENER: &str = "screener.test.near";
const REQUESTOR: &str = "treasurer.test.near";
const TOKEN: &str = "token.test.near";

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
