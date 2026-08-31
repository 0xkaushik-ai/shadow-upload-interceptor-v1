use base64::{Engine as _, decoded_len_estimate, engine::general_purpose::STANDARD};
use thiserror::Error;
use zeroize::Zeroizing;

use crate::scan::{ScanResult, scan};

pub const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SessionError {
    #[error("a scan is already active")]
    AlreadyActive,
    #[error("no scan is active")]
    NotActive,
    #[error("scan identifier does not match")]
    WrongIdentifier,
    #[error("declared file size exceeds the limit")]
    TooLarge,
    #[error("chunk offset is not contiguous")]
    InvalidOffset,
    #[error("decoded chunks exceed the declared file size")]
    SizeExceeded,
    #[error("received file size does not match the declaration")]
    SizeMismatch,
    #[error("chunk is not valid base64")]
    InvalidBase64,
}

struct ActiveScan {
    id: String,
    declared_size: usize,
    // Exact preallocation avoids reallocating sensitive bytes into abandoned buffers.
    bytes: Zeroizing<Vec<u8>>,
}

#[derive(Default)]
pub struct ScanSession {
    active: Option<ActiveScan>,
}

impl ScanSession {
    pub fn begin(&mut self, id: &str, declared_size: u64) -> Result<(), SessionError> {
        if self.active.is_some() {
            return Err(SessionError::AlreadyActive);
        }
        let declared_size = usize::try_from(declared_size).map_err(|_| SessionError::TooLarge)?;
        if declared_size > MAX_FILE_BYTES {
            return Err(SessionError::TooLarge);
        }
        self.active = Some(ActiveScan {
            id: id.to_owned(),
            declared_size,
            bytes: Zeroizing::new(Vec::with_capacity(declared_size)),
        });
        Ok(())
    }

    pub fn append_base64(
        &mut self,
        id: &str,
        offset: u64,
        encoded: &str,
    ) -> Result<(), SessionError> {
        let active = self.active.as_mut().ok_or(SessionError::NotActive)?;
        if active.id != id {
            return Err(SessionError::WrongIdentifier);
        }
        let offset = usize::try_from(offset).map_err(|_| SessionError::InvalidOffset)?;
        if offset != active.bytes.len() {
            return Err(SessionError::InvalidOffset);
        }

        // Decode directly into memory we own so even a partially decoded invalid chunk is scrubbed.
        let mut decoded = Zeroizing::new(vec![0_u8; decoded_len_estimate(encoded.len())]);
        let decoded_length = STANDARD
            .decode_slice(encoded, decoded.as_mut_slice())
            .map_err(|_| SessionError::InvalidBase64)?;
        decoded.truncate(decoded_length);
        let next_size = active
            .bytes
            .len()
            .checked_add(decoded.len())
            .ok_or(SessionError::SizeExceeded)?;
        if next_size > active.declared_size {
            return Err(SessionError::SizeExceeded);
        }
        active.bytes.extend_from_slice(&decoded);
        Ok(())
    }

    pub fn finish(&mut self, id: &str) -> Result<ScanResult, SessionError> {
        let active = self.active.take().ok_or(SessionError::NotActive)?;
        if active.id != id {
            return Err(SessionError::WrongIdentifier);
        }
        if active.bytes.len() != active.declared_size {
            return Err(SessionError::SizeMismatch);
        }
        let decision = scan(&active.bytes);
        // Explicit drop guarantees our reassembled allocation is scrubbed before a verdict is sent.
        drop(active);
        Ok(decision)
    }
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    use super::{MAX_FILE_BYTES, ScanSession, SessionError};
    use crate::scan::{Decision, RuleId, ScanResult};

    #[test]
    fn detects_a_marker_split_across_chunks() {
        let first = b"prefix BEGIN RSA ";
        let second = b"PRIVATE KEY suffix";
        let mut session = ScanSession::default();
        session
            .begin("split", (first.len() + second.len()) as u64)
            .expect("begin should succeed");
        session
            .append_base64("split", 0, &STANDARD.encode(first))
            .expect("first chunk should succeed");
        session
            .append_base64("split", first.len() as u64, &STANDARD.encode(second))
            .expect("second chunk should succeed");
        assert_eq!(
            session.finish("split"),
            Ok(ScanResult {
                decision: Decision::Block,
                rule: Some(RuleId::PemPrivateKey),
            })
        );
    }

    #[test]
    fn rejects_non_contiguous_offsets() {
        let mut session = ScanSession::default();
        session.begin("id", 3).expect("begin should succeed");
        assert_eq!(
            session.append_base64("id", 2, &STANDARD.encode(b"abc")),
            Err(SessionError::InvalidOffset)
        );
    }

    #[test]
    fn rejects_a_size_mismatch() {
        let mut session = ScanSession::default();
        session.begin("id", 3).expect("begin should succeed");
        session
            .append_base64("id", 0, &STANDARD.encode(b"ab"))
            .expect("chunk should succeed");
        assert_eq!(session.finish("id"), Err(SessionError::SizeMismatch));
    }

    #[test]
    fn rejects_oversized_declarations() {
        let mut session = ScanSession::default();
        assert_eq!(
            session.begin("id", (MAX_FILE_BYTES + 1) as u64),
            Err(SessionError::TooLarge)
        );
    }

    #[test]
    fn rejects_duplicate_begin() {
        let mut session = ScanSession::default();
        session
            .begin("first", 0)
            .expect("first begin should succeed");
        assert_eq!(session.begin("second", 0), Err(SessionError::AlreadyActive));
    }

    #[test]
    fn rejects_invalid_base64() {
        let mut session = ScanSession::default();
        session.begin("id", 3).expect("begin should succeed");
        assert_eq!(
            session.append_base64("id", 0, "%%%"),
            Err(SessionError::InvalidBase64)
        );
    }

    #[test]
    fn supports_two_sequential_scans() {
        let mut session = ScanSession::default();
        session
            .begin("first", 0)
            .expect("first begin should succeed");
        assert_eq!(
            session.finish("first"),
            Ok(ScanResult {
                decision: Decision::Allow,
                rule: None,
            })
        );

        let secret = b"BEGIN OPENSSH PRIVATE KEY";
        session
            .begin("second", secret.len() as u64)
            .expect("second begin should succeed");
        session
            .append_base64("second", 0, &STANDARD.encode(secret))
            .expect("second chunk should succeed");
        assert_eq!(
            session.finish("second"),
            Ok(ScanResult {
                decision: Decision::Block,
                rule: Some(RuleId::OpensshPrivateKey),
            })
        );
    }
}
