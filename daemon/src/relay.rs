use std::{io::Write, os::unix::net::UnixStream};

use serde::Deserialize;
use thiserror::Error;

use crate::{
    ipc::IpcError,
    protocol::{ProtocolError, read_frame, write_payload_frame},
};

#[derive(Debug, Error)]
pub enum BrokerError {
    #[error("detached daemon IPC failed: {0}")]
    Ipc(#[from] IpcError),
    #[error("Chrome Native Messaging protocol failed: {0}")]
    Protocol(#[from] ProtocolError),
    #[error("request type is not supported by the broker")]
    UnsupportedRequest,
    #[error("detached scanner disconnected before returning a response")]
    DaemonDisconnected,
}

#[derive(Deserialize)]
struct RequestEnvelope<'a> {
    #[serde(rename = "type")]
    message_type: &'a str,
}

fn expects_response(payload: &[u8]) -> Result<bool, BrokerError> {
    let envelope: RequestEnvelope<'_> = serde_json::from_slice(payload)
        .map_err(ProtocolError::InvalidJson)
        .map_err(BrokerError::Protocol)?;
    match envelope.message_type {
        "health" | "scan_end" => Ok(true),
        "scan_begin" | "scan_chunk" => Ok(false),
        _ => Err(BrokerError::UnsupportedRequest),
    }
}

/// Relays bounded Chrome frames to one already-authenticated local daemon connection.
///
/// The broker never scans. Each sensitive request frame is held in a `Zeroizing<Vec<u8>>` by
/// `read_frame` and is scrubbed as soon as that frame has been forwarded.
pub fn run<R: std::io::Read, W: Write>(
    mut chrome_reader: R,
    mut chrome_writer: W,
    mut daemon: UnixStream,
) -> Result<(), BrokerError> {
    while let Some(request) = read_frame(&mut chrome_reader)? {
        let response_expected = expects_response(&request)?;
        write_payload_frame(&mut daemon, &request)?;

        if response_expected {
            let response = read_frame(&mut daemon)?.ok_or(BrokerError::DaemonDisconnected)?;
            write_payload_frame(&mut chrome_writer, &response)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Cursor, Read},
        os::unix::net::UnixStream,
        thread,
    };

    use serde_json::json;

    use super::{BrokerError, run};
    use crate::protocol::{PROTOCOL_VERSION, read_frame, write_payload_frame};

    fn frame(message: serde_json::Value) -> Vec<u8> {
        let payload = serde_json::to_vec(&message).expect("request should serialize");
        let mut framed = Vec::new();
        write_payload_frame(&mut framed, &payload).expect("request should frame");
        framed
    }

    #[test]
    fn relays_health_without_exposing_internal_ack_messages() {
        let (broker_socket, mut daemon_socket) =
            UnixStream::pair().expect("socket pair should be created");
        let daemon = thread::spawn(move || {
            let request = read_frame(&mut daemon_socket)
                .expect("health frame should be valid")
                .expect("health frame should exist");
            let request: serde_json::Value =
                serde_json::from_slice(&request).expect("health JSON should parse");
            assert_eq!(request["type"], "health");

            let response = serde_json::to_vec(&json!({
                "type": "health",
                "id": "health",
                "protocol": PROTOCOL_VERSION,
                "status": "ready"
            }))
            .expect("response should serialize");
            write_payload_frame(&mut daemon_socket, &response).expect("response should frame");
            let mut trailing = [0_u8; 1];
            assert_eq!(
                daemon_socket
                    .read(&mut trailing)
                    .expect("EOF should be readable"),
                0
            );
        });

        let input = frame(json!({
            "type": "health",
            "id": "health",
            "protocol": PROTOCOL_VERSION
        }));
        let mut output = Vec::new();
        run(Cursor::new(input), &mut output, broker_socket).expect("relay should complete");
        daemon.join().expect("daemon thread should complete");

        let response = read_frame(&mut Cursor::new(output))
            .expect("response should be framed")
            .expect("response should exist");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&response)
                .expect("response JSON should parse")["status"],
            "ready"
        );
    }

    #[test]
    fn rejects_unknown_request_types_before_forwarding() {
        let (broker_socket, _daemon_socket) =
            UnixStream::pair().expect("socket pair should be created");
        assert!(matches!(
            run(
                Cursor::new(frame(json!({ "type": "erase_disk" }))),
                Vec::new(),
                broker_socket
            ),
            Err(BrokerError::UnsupportedRequest)
        ));
    }
}
