pub const PEM_PRIVATE_KEY_RULE: &str = "pem_private_key";
pub const PKCS8_PRIVATE_KEY_RULE: &str = "pkcs8_private_key";
pub const OPENSSH_PRIVATE_KEY_RULE: &str = "openssh_private_key";
pub const AWS_ACCESS_KEY_RULE: &str = "aws_access_key_id";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Block,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleId {
    PemPrivateKey,
    Pkcs8PrivateKey,
    OpensshPrivateKey,
    AwsAccessKeyId,
}

impl RuleId {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PemPrivateKey => PEM_PRIVATE_KEY_RULE,
            Self::Pkcs8PrivateKey => PKCS8_PRIVATE_KEY_RULE,
            Self::OpensshPrivateKey => OPENSSH_PRIVATE_KEY_RULE,
            Self::AwsAccessKeyId => AWS_ACCESS_KEY_RULE,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScanResult {
    pub decision: Decision,
    pub rule: Option<RuleId>,
}

struct Rule {
    id: RuleId,
    pattern: Pattern,
}

enum Pattern {
    Literal(&'static [u8]),
    AwsAccessKeyId,
}

const RULES: &[Rule] = &[
    Rule {
        id: RuleId::PemPrivateKey,
        pattern: Pattern::Literal(b"BEGIN RSA PRIVATE KEY"),
    },
    Rule {
        id: RuleId::Pkcs8PrivateKey,
        pattern: Pattern::Literal(b"BEGIN PRIVATE KEY"),
    },
    Rule {
        id: RuleId::OpensshPrivateKey,
        pattern: Pattern::Literal(b"BEGIN OPENSSH PRIVATE KEY"),
    },
    Rule {
        id: RuleId::AwsAccessKeyId,
        pattern: Pattern::AwsAccessKeyId,
    },
];

fn matches(bytes: &[u8], pattern: &Pattern) -> bool {
    match pattern {
        Pattern::Literal(needle) => memchr::memmem::find(bytes, needle).is_some(),
        Pattern::AwsAccessKeyId => bytes.windows(20).any(|candidate| {
            (&candidate[..4] == b"AKIA" || &candidate[..4] == b"ASIA")
                && candidate[4..]
                    .iter()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
        }),
    }
}

/// Scans borrowed bytes directly: the complete file is never converted to a String.
pub fn scan(bytes: &[u8]) -> ScanResult {
    for rule in RULES {
        if matches(bytes, &rule.pattern) {
            return ScanResult {
                decision: Decision::Block,
                rule: Some(rule.id),
            };
        }
    }

    ScanResult {
        decision: Decision::Allow,
        rule: None,
    }
}

#[cfg(test)]
mod tests {
    use super::{Decision, RuleId, ScanResult, scan};

    #[test]
    fn blocks_the_fake_pem_fixture() {
        let fixture = include_bytes!("../../testdata/block.pem");
        assert_eq!(
            scan(fixture),
            ScanResult {
                decision: Decision::Block,
                rule: Some(RuleId::PemPrivateKey),
            }
        );
    }

    #[test]
    fn detects_each_registered_rule_from_content() {
        let cases = [
            (b"BEGIN RSA PRIVATE KEY".as_slice(), RuleId::PemPrivateKey),
            (b"BEGIN PRIVATE KEY".as_slice(), RuleId::Pkcs8PrivateKey),
            (
                b"BEGIN OPENSSH PRIVATE KEY".as_slice(),
                RuleId::OpensshPrivateKey,
            ),
        ];

        for (bytes, expected_rule) in cases {
            assert_eq!(
                scan(bytes),
                ScanResult {
                    decision: Decision::Block,
                    rule: Some(expected_rule),
                }
            );
        }

        let fake_access_key = [b"AKIA".as_slice(), b"1234567890ABCDEF"].concat();
        assert_eq!(
            scan(&fake_access_key),
            ScanResult {
                decision: Decision::Block,
                rule: Some(RuleId::AwsAccessKeyId),
            }
        );
    }

    #[test]
    fn allows_the_harmless_fixture_regardless_of_filename() {
        let fixture = include_bytes!("../../testdata/allow.txt");
        assert_eq!(
            scan(fixture),
            ScanResult {
                decision: Decision::Allow,
                rule: None,
            }
        );
    }

    #[test]
    fn allows_empty_input() {
        assert_eq!(
            scan(&[]),
            ScanResult {
                decision: Decision::Allow,
                rule: None,
            }
        );
    }

    #[test]
    fn allows_binary_noise_without_a_registered_marker() {
        let fixture = [0, 159, 146, 150, 255, 12, 0, 44, 8];
        assert_eq!(
            scan(&fixture),
            ScanResult {
                decision: Decision::Allow,
                rule: None,
            }
        );
    }

    #[test]
    fn does_not_block_an_aws_environment_variable_name_without_a_key() {
        assert_eq!(
            scan(b"AWS_ACCESS_KEY_ID=replace-me"),
            ScanResult {
                decision: Decision::Allow,
                rule: None,
            }
        );
    }
}
