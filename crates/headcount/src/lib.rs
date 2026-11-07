//! Headcount: screened reward rounds for Sputnik DAO and Trezu treasuries.
//!
//! Skeleton only. It fixes the toolchain and the near-sdk version the contract builds with. The
//! contract's methods arrive one at a time, each behind a test written first: `configure` and
//! `create_round`, then `fund_round`, `ft_on_transfer` and `post_verdict`, then `payout_batch`,
//! `resolve_group` and `refund_expired`.

use near_sdk::near;

#[near(contract_state)]
#[derive(Default)]
pub struct Headcount {}
