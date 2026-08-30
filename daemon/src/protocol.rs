use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroizing;

use crate::{
    scan::ScanResult,
    session::{ScanSession, SessionError},
};

// A 256 KiB raw chunk becomes about 342 KiB of base64 plus a small JSON envelope.
pub(crate) const MAX_FRAME_BYTES: usize = 512 * 1024;
pub const PROTOCOL_VERSION: u16 = 1;
const MAX_IDENTIFIER_BYTES: usize = 64;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum NativeRequest<'a> {
    Health {
        id: &'a str,
        protocol: u16,
    },
    #[serde(rename = "scan_begin")]
    Begin {
        id: &'a str,
        size: u64,
        protocol: u16,
    },
    #[serde(rename = "scan_chunk")]
    Chunk {
        id: &'a str,
        offset: u64,
        data: &'a str,
    },
    #[serde(rename = "scan_end")]
    End {
        id: &'a str,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum NativeResponse<'a> {
    Health {
        id: &'a str,
        protocol: u16,
        status: &'static str,
    },
    Verdict {
        id: &'a str,
        decision: &'static str,
        rule: Option<&'static str>,
    },
}

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("native message I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("native message frame is empty or too large")]
    InvalidFrameLength,
    #[error("native message JSON is invalid: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("scan identifier is empty or too long")]
    InvalidIdentifier,
    #[error("unsupported protocol version")]
    UnsupportedProtocol,
    #[error("scan protocol is invalid: {0}")]
    InvalidSession(#[from] SessionError),
}

pub(crate) fn read_frame<R: Read>(
    reader: &mut R,
) -> Result<Option<Zeroizing<Vec<u8>>>, ProtocolError> {
    let mut length = [0_u8; 4];
    match reader.read(&mut length[..1])? {
        0 => return Ok(None),
        1 => reader.read_exact(&mut length[1..])?,
        _ => unreachable!("a one-byte buffer cannot receive more than one byte"),
    }
    // The demo's Chrome targets use the protocol's four-byte little-endian length prefix.
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(ProtocolError::InvalidFrameLength);
    }
    let mut payload = Zeroizing::new(vec![0_u8; length]);
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

pub(crate) fn write_payload_frame<W: Write>(
    writer: &mut W,
    payload: &[u8],
) -> Result<(), ProtocolError> {
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::InvalidFrameLength);
    }
    let length = u32::try_from(payload.len()).map_err(|_| ProtocolError::InvalidFrameLength)?;
    writer.write_all(&length.to_le_bytes())?;
    writer.write_all(payload)?;
    writer.flush()?;
    Ok(())
}

fn write_frame<W: Write, T: Serialize>(writer: &mut W, message: &T) -> Result<(), ProtocolError> {
    let payload = serde_json::to_vec(message)?;
    write_payload_frame(writer, &payload)
}

fn validate_identifier(id: &str) -> Result<(), ProtocolError> {
    if id.is_empty()
        || id.len() > MAX_IDENTIFIER_BYTES
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ProtocolError::InvalidIdentifier);
    }
    Ok(())
}

pub fn run_scanner_protocol<R: Read, W: Write>(
    mut reader: R,
    mut writer: W,
) -> Result<(), ProtocolError> {
    let mut session = ScanSession::default();
    while let Some(payload) = read_frame(&mut reader)? {
        // Borrowing fields avoids copying the base64 text out of this zeroizing frame.
        let request: NativeRequest<'_> = serde_json::from_slice(&payload)?;
        match request {
            NativeRequest::Health { id, protocol } => {
                validate_identifier(id)?;
                let status = if protocol == PROTOCOL_VERSION {
                    "ready"
                } else {
                    "incompatible"
                };
                write_frame(
                    &mut writer,
                    &NativeResponse::Health {
                        id,
                        protocol: PROTOCOL_VERSION,
                        status,
                    },
                )?;
            }
            NativeRequest::Begin { id, size, protocol } => {
                validate_identifier(id)?;
                if protocol != PROTOCOL_VERSION {
                    return Err(ProtocolError::UnsupportedProtocol);
                }
                session.begin(id, size)?;
            }
            NativeRequest::Chunk { id, offset, data } => {
                validate_identifier(id)?;
                session.append_base64(id, offset, data)?;
            }
            NativeRequest::End { id } => {
                validate_identifier(id)?;
                let result = session.finish(id)?;
                let response = match result {
                    ScanResult::Block(rule) => NativeResponse::Verdict {
                        id,
                        decision: "block",
                        rule: Some(rule.as_str()),
                    },
                    ScanResult::Allow => NativeResponse::Verdict {
                        id,
                        decision: "allow",
                        rule: None,
                    },
                };
                write_frame(&mut writer, &response)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use serde_json::json;

    use super::{
        MAX_FRAME_BYTES, PROTOCOL_VERSION, ProtocolError, read_frame, run_scanner_protocol,
    };
    use crate::session::SessionError;

    fn append_request(output: &mut Vec<u8>, message: serde_json::Value) {
        let payload = serde_json::to_vec(&message).expect("request should serialize");
        output.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        output.extend_from_slice(&payload);
    }

    fn append_scan(output: &mut Vec<u8>, id: &str, bytes: &[u8]) {
        append_request(
            output,
            json!({
                "type": "scan_begin",
                "id": id,
                "size": bytes.len(),
                "protocol": PROTOCOL_VERSION
            }),
        );
        if !bytes.is_empty() {
            append_request(
                output,
                json!({
                    "type": "scan_chunk",
                    "id": id,
                    "offset": 0,
                    "data": STANDARD.encode(bytes)
                }),
            );
        }
        append_request(output, json!({ "type": "scan_end", "id": id }));
    }

    fn decode_responses(output: Vec<u8>) -> Vec<serde_json::Value> {
        let mut cursor = Cursor::new(output);
        let mut responses = Vec::new();
        while let Some(frame) = read_frame(&mut cursor).expect("response frame should be valid") {
            responses.push(
                serde_json::from_slice(&frame).expect("response JSON should deserialize cleanly"),
            );
        }
        responses
    }

    #[test]
    fn framed_protocol_returns_only_the_verdict() {
        let bytes = b"safe prefix BEGIN RSA PRIVATE KEY safe suffix";
        let mut input = Vec::new();
        append_scan(&mut input, "scan-1", bytes);

        let mut output = Vec::new();
        run_scanner_protocol(Cursor::new(input), &mut output).expect("protocol should complete");

        let responses = decode_responses(output);
        assert_eq!(
            responses,
            vec![json!({
                "type": "verdict",
                "id": "scan-1",
                "decision": "block",
                "rule": "pem_private_key"
            })]
        );
    }

    #[test]
    fn health_reports_ready_and_protocol_mismatch() {
        let mut input = Vec::new();
        append_request(
            &mut input,
            json!({ "type": "health", "id": "ready", "protocol": PROTOCOL_VERSION }),
        );
        append_request(
            &mut input,
            json!({ "type": "health", "id": "old-client", "protocol": 0 }),
        );

        let mut output = Vec::new();
        run_scanner_protocol(Cursor::new(input), &mut output)
            .expect("health checks should complete");

        assert_eq!(
            decode_responses(output),
            vec![
                json!({
                    "type": "health",
                    "id": "ready",
                    "protocol": PROTOCOL_VERSION,
                    "status": "ready"
                }),
                json!({
                    "type": "health",
                    "id": "old-client",
                    "protocol": PROTOCOL_VERSION,
                    "status": "incompatible"
                }),
            ]
        );
    }

    #[test]
    fn supports_multiple_sequential_scans_without_extra_stdout() {
        let mut input = Vec::new();
        append_scan(&mut input, "safe", b"ordinary source code");
        append_scan(&mut input, "secret", b"BEGIN OPENSSH PRIVATE KEY");

        let mut output = Vec::new();
        run_scanner_protocol(Cursor::new(input), &mut output).expect("both scans should complete");

        assert_eq!(
            decode_responses(output),
            vec![
                json!({ "type": "verdict", "id": "safe", "decision": "allow", "rule": null }),
                json!({
                    "type": "verdict",
                    "id": "secret",
                    "decision": "block",
                    "rule": "openssh_private_key"
                }),
            ]
        );
    }

    #[test]
    fn rejects_empty_and_oversized_frames_before_allocation() {
        let empty = 0_u32.to_le_bytes();
        assert!(matches!(
            read_frame(&mut Cursor::new(empty)),
            Err(ProtocolError::InvalidFrameLength)
        ));

        let oversized = ((MAX_FRAME_BYTES + 1) as u32).to_le_bytes();
        assert!(matches!(
            read_frame(&mut Cursor::new(oversized)),
            Err(ProtocolError::InvalidFrameLength)
        ));
    }

    #[test]
    fn rejects_truncated_headers_and_payloads() {
        assert!(matches!(
            read_frame(&mut Cursor::new([1_u8, 0])),
            Err(ProtocolError::Io(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof
        ));

        let mut truncated_payload = Vec::from(10_u32.to_le_bytes());
        truncated_payload.extend_from_slice(b"short");
        assert!(matches!(
            read_frame(&mut Cursor::new(truncated_payload)),
            Err(ProtocolError::Io(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof
        ));
    }

    #[test]
    fn rejects_invalid_json_and_unknown_fields() {
        let mut invalid_json = Vec::new();
        let payload = b"{not-json";
        invalid_json.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        invalid_json.extend_from_slice(payload);
        assert!(matches!(
            run_scanner_protocol(Cursor::new(invalid_json), Vec::new()),
            Err(ProtocolError::InvalidJson(_))
        ));

        let mut unknown_field = Vec::new();
        append_request(
            &mut unknown_field,
            json!({
                "type": "health",
                "id": "id",
                "protocol": PROTOCOL_VERSION,
                "unexpected": true
            }),
        );
        assert!(matches!(
            run_scanner_protocol(Cursor::new(unknown_field), Vec::new()),
            Err(ProtocolError::InvalidJson(_))
        ));
    }

    #[test]
    fn rejects_invalid_identifiers_and_filename_fields() {
        let mut invalid_identifier = Vec::new();
        append_request(
            &mut invalid_identifier,
            json!({ "type": "health", "id": "bad/id", "protocol": PROTOCOL_VERSION }),
        );
        assert!(matches!(
            run_scanner_protocol(Cursor::new(invalid_identifier), Vec::new()),
            Err(ProtocolError::InvalidIdentifier)
        ));

        // Metadata is intentionally absent from the byte-only wire protocol. Unknown fields are
        // denied by serde rather than accepted and ignored.
        let mut unknown_metadata = Vec::new();
        append_request(
            &mut unknown_metadata,
            json!({
                "type": "scan_begin", "id": "id", "name": "private.pem",
                "size": 0, "protocol": PROTOCOL_VERSION
            }),
        );
        assert!(matches!(
            run_scanner_protocol(Cursor::new(unknown_metadata), Vec::new()),
            Err(ProtocolError::InvalidJson(_))
        ));
    }

    #[test]
    fn rejects_invalid_base64_and_protocol_versions() {
        let mut invalid_base64 = Vec::new();
        append_request(
            &mut invalid_base64,
            json!({
                "type": "scan_begin",
                "id": "id",
                "size": 3,
                "protocol": PROTOCOL_VERSION
            }),
        );
        append_request(
            &mut invalid_base64,
            json!({ "type": "scan_chunk", "id": "id", "offset": 0, "data": "%%%" }),
        );
        assert!(matches!(
            run_scanner_protocol(Cursor::new(invalid_base64), Vec::new()),
            Err(ProtocolError::InvalidSession(SessionError::InvalidBase64))
        ));

        let mut wrong_protocol = Vec::new();
        append_request(
            &mut wrong_protocol,
            json!({
                "type": "scan_begin",
                "id": "id",
                "size": 0,
                "protocol": 0
            }),
        );
        assert!(matches!(
            run_scanner_protocol(Cursor::new(wrong_protocol), Vec::new()),
            Err(ProtocolError::UnsupportedProtocol)
        ));
    }
}
