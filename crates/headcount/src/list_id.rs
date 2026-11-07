//! Trezu's list id: how a Headcount round is named.
//!
//! Trezu's bulk payments name a payment list by the lowercase hex SHA-256 of a compact JSON object,
//! its payments sorted by recipient and its keys in alphabetical order:
//!
//! ```text
//! {"payments":[{"amount":"<integer>","recipient":"<account>"},...],
//!  "submitter":"<DAO>","timestamp":<integer>,"token_id":"<native | token contract>"}
//! ```
//!
//! A Headcount round uses the same id with the DAO as the submitter, so a treasurer screens exactly
//! the list they would give Trezu. Recipients sort in byte order, as in Trezu's backend, which
//! verifies every id it is given (its frontend sorts with `localeCompare`, which disagrees on some
//! lists; see fixtures/trezu-list-ids.json).
//!
//! Nothing here needs escaping: every string is an `AccountId` (lowercase letters, digits, `-`,
//! `_`, `.`) or the literal `native`, and amounts are written by `u128`'s `Display`, which never
//! adds leading zeros.

use core::fmt::Write;

use near_sdk::{AccountId, env};

/// One payment in canonical form: Trezu writes the amount as a decimal string.
pub struct CanonicalPayment<'a> {
    pub recipient: &'a AccountId,
    pub amount: u128,
}

/// The exact string Trezu hashes. `payments` must already be sorted by recipient in byte order.
pub fn canonical_json(
    submitter: &AccountId,
    token_id: &str,
    payments: &[CanonicalPayment<'_>],
    timestamp: u64,
) -> String {
    let mut out = String::with_capacity(96 + payments.len() * 96);
    out.push_str("{\"payments\":[");
    for (i, p) in payments.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        // Writing to a String cannot fail.
        let _ = write!(
            out,
            "{{\"amount\":\"{}\",\"recipient\":\"{}\"}}",
            p.amount, p.recipient
        );
    }
    let _ = write!(
        out,
        "],\"submitter\":\"{submitter}\",\"timestamp\":{timestamp},\"token_id\":\"{token_id}\"}}"
    );
    out
}

/// Lowercase hex SHA-256 of `canonical_json`: Trezu's list id, and the round id.
pub fn list_id(
    submitter: &AccountId,
    token_id: &str,
    payments: &[CanonicalPayment<'_>],
    timestamp: u64,
) -> String {
    let digest =
        env::sha256_array(canonical_json(submitter, token_id, payments, timestamp).as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

#[cfg(test)]
mod tests {
    //! The ids in fixtures/trezu-list-ids.json were computed by Trezu's own code: `generateListId`
    //! in NEAR-DevHub/trezu `nt-fe/lib/bulk-payment-api.ts` at commit
    //! a6aaaf6742099069634a25fb20c4287a2852dd62, run on synthetic lists, and cross-checked against
    //! Trezu's backend `compute_list_hash` at the same commit. The TypeScript `listId` is tested
    //! against the same file (ts/test/list-id.test.ts).

    use super::*;
    use near_sdk::serde_json::{self, Value};

    const FIXTURE: &str = include_str!("../../../fixtures/trezu-list-ids.json");

    struct Case {
        name: String,
        submitter: AccountId,
        token_id: String,
        timestamp: u64,
        payments: Vec<(AccountId, u128)>,
    }

    fn case(v: &Value) -> Case {
        let text = |key: &str| {
            v[key]
                .as_str()
                .unwrap_or_else(|| panic!("{key} missing"))
                .to_string()
        };
        let mut payments: Vec<(AccountId, u128)> = v["payments"]
            .as_array()
            .expect("payments")
            .iter()
            .map(|p| {
                let recipient = p["recipient"]
                    .as_str()
                    .expect("recipient")
                    .parse()
                    .expect("account id");
                let amount = p["amount"].as_str().expect("amount").parse().expect("u128");
                (recipient, amount)
            })
            .collect();
        payments.sort_by(|a, b| a.0.as_str().cmp(b.0.as_str()));
        Case {
            name: text("name"),
            submitter: text("submitter").parse().expect("submitter"),
            token_id: text("token_id"),
            timestamp: v["timestamp"].as_u64().expect("timestamp"),
            payments,
        }
    }

    fn id_of(c: &Case) -> String {
        let canonical: Vec<CanonicalPayment<'_>> = c
            .payments
            .iter()
            .map(|(recipient, amount)| CanonicalPayment {
                recipient,
                amount: *amount,
            })
            .collect();
        list_id(&c.submitter, &c.token_id, &canonical, c.timestamp)
    }

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).expect("fixtures/trezu-list-ids.json parses")
    }

    #[test]
    fn three_list_ids_match_trezus_generate_list_id() {
        let fixture = fixture();
        let vectors = fixture["vectors"].as_array().expect("vectors");
        assert_eq!(vectors.len(), 3);
        for v in vectors {
            let c = case(v);
            assert_eq!(
                id_of(&c),
                v["list_id"].as_str().expect("list_id"),
                "{}",
                c.name
            );
        }
    }

    #[test]
    fn where_trezus_frontend_and_backend_disagree_the_backend_wins() {
        let fixture = fixture();
        let divergent = fixture["frontend_backend_divergence"]
            .as_array()
            .expect("divergence");
        assert_eq!(divergent.len(), 1);
        for v in divergent {
            let c = case(v);
            let ours = id_of(&c);
            assert_eq!(
                ours,
                v["trezu_backend_list_id"].as_str().expect("backend id"),
                "{}",
                c.name
            );
            assert_ne!(
                ours,
                v["trezu_frontend_list_id_en_us"]
                    .as_str()
                    .expect("frontend id")
            );
        }
    }

    #[test]
    fn canonical_json_is_compact_with_alphabetical_keys() {
        let dao: AccountId = "dao.test.near".parse().unwrap();
        let (a, b): (AccountId, AccountId) = (
            "a.test.near".parse().unwrap(),
            "b.test.near".parse().unwrap(),
        );
        let payments = [
            CanonicalPayment {
                recipient: &a,
                amount: 1,
            },
            CanonicalPayment {
                recipient: &b,
                amount: 2,
            },
        ];
        assert_eq!(
            canonical_json(&dao, "native", &payments, 1_794_009_600_000),
            "{\"payments\":[{\"amount\":\"1\",\"recipient\":\"a.test.near\"},{\"amount\":\"2\",\"recipient\":\"b.test.near\"}],\
             \"submitter\":\"dao.test.near\",\"timestamp\":1794009600000,\"token_id\":\"native\"}"
        );
    }
}
