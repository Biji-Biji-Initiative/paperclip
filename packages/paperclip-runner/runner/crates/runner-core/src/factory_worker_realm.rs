//! Public realm selected by the trusted worker, never by run.prepare/provider JSON.
use serde::{Deserialize, Serialize};

pub const LEGACY_COMPANY_ID: &str = "740ad7ee-0c28-4e07-b9d1-ca7b35da820d";
const COMPANY_FLAG: &str = "--factory-company-id";
const AUTHORITY_FLAG: &str = "--factory-authority-id";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactoryWorkerRealm {
    schema: String,
    company_id: String,
    authority_id: String,
}

impl FactoryWorkerRealm {
    pub fn new(company_id: &str, authority_id: &str) -> Result<Self, &'static str> {
        let realm = Self {
            schema: "factory.worker-realm.v1".into(),
            company_id: company_id.into(),
            authority_id: authority_id.into(),
        };
        if !realm.valid() {
            return Err("factory_worker_realm_invalid");
        }
        Ok(realm)
    }

    fn valid(&self) -> bool {
        self.schema == "factory.worker-realm.v1"
            && self.company_id.len() == 36
            && self.company_id.bytes().enumerate().all(|(i, b)| {
                if matches!(i, 8 | 13 | 18 | 23) {
                    b == b'-'
                } else {
                    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
                }
            })
            && !self.authority_id.is_empty()
            && self.authority_id.len() <= 128
            && self
                .authority_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.:@+-".contains(&b))
    }

    /// Both selectors are worker-appended after its independently owned policy check.
    /// There is no fallback from an invalid/partial selection to the legacy realm.
    pub fn from_startup_args(
        args: &[String],
        protected: bool,
    ) -> Result<Option<Self>, &'static str> {
        let select = |flag: &str| -> Result<Option<&str>, &'static str> {
            if args.iter().any(|arg| arg.starts_with(&format!("{flag}="))) {
                return Err("factory_worker_realm_invalid");
            }
            let positions: Vec<_> = args
                .iter()
                .enumerate()
                .filter(|(_, arg)| arg.as_str() == flag)
                .collect();
            match positions.as_slice() {
                [] => Ok(None),
                [(index, _)] => args
                    .get(index + 1)
                    .map(|s| Some(s.as_str()))
                    .ok_or("factory_worker_realm_invalid"),
                _ => Err("factory_worker_realm_invalid"),
            }
        };
        match (select(COMPANY_FLAG)?, select(AUTHORITY_FLAG)?) {
            (None, None) => Ok(None),
            (Some(company), Some(authority)) if protected => {
                Self::new(company, authority).map(Some)
            }
            _ => Err("factory_worker_realm_invalid"),
        }
    }

    pub fn matches_expected(expected: Option<&Self>, company: &str, authority: &str) -> bool {
        match expected {
            Some(realm) => {
                realm.valid() && realm.company_id == company && realm.authority_id == authority
            }
            None => company == LEGACY_COMPANY_ID,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const BOT: &str = "a2b00000-0000-4000-8000-000000000001";
    const MER: &str = "a2b00000-0000-4000-8000-000000000002";
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[test]
    fn selected_realm_matches_both_independent_identities() {
        let realm = FactoryWorkerRealm::from_startup_args(
            &args(&[COMPANY_FLAG, BOT, AUTHORITY_FLAG, "factory-botak"]),
            true,
        )
        .unwrap()
        .unwrap();
        assert!(FactoryWorkerRealm::matches_expected(
            Some(&realm),
            BOT,
            "factory-botak"
        ));
        assert!(!FactoryWorkerRealm::matches_expected(
            Some(&realm),
            MER,
            "factory-botak"
        ));
        assert!(!FactoryWorkerRealm::matches_expected(
            Some(&realm),
            BOT,
            "factory-mereka"
        ));
        assert!(!FactoryWorkerRealm::matches_expected(
            None,
            BOT,
            "factory-botak"
        ));
        assert!(FactoryWorkerRealm::matches_expected(
            None,
            LEGACY_COMPANY_ID,
            "legacy-authority"
        ));
    }

    #[test]
    fn no_ambient_partial_wildcard_duplicate_or_assignment_selection() {
        assert_eq!(
            FactoryWorkerRealm::from_startup_args(&[], false).unwrap(),
            None
        );
        for values in [
            args(&[COMPANY_FLAG, BOT]),
            args(&[AUTHORITY_FLAG, "factory-botak"]),
            args(&[COMPANY_FLAG, "*", AUTHORITY_FLAG, "factory-botak"]),
            args(&[COMPANY_FLAG, BOT, AUTHORITY_FLAG, "*"]),
            args(&[
                COMPANY_FLAG,
                BOT,
                AUTHORITY_FLAG,
                "factory-botak",
                COMPANY_FLAG,
                MER,
            ]),
            args(&[
                "--factory-company-id=a2b00000-0000-4000-8000-000000000001",
                AUTHORITY_FLAG,
                "factory-botak",
            ]),
        ] {
            assert!(FactoryWorkerRealm::from_startup_args(&values, true).is_err());
        }
        assert!(FactoryWorkerRealm::from_startup_args(
            &args(&[COMPANY_FLAG, BOT, AUTHORITY_FLAG, "factory-botak"]),
            false
        )
        .is_err());
    }
}
