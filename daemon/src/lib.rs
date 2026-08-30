mod daemon_runtime;
mod ipc;
mod protocol;
mod relay;
mod scan;
mod session;

#[cfg(not(target_endian = "little"))]
compile_error!("SecureIntent Native Messaging framing currently supports little-endian targets");

#[cfg(not(unix))]
compile_error!("SecureIntent detached local IPC is currently implemented for Unix targets");

use std::io::{self, BufReader, BufWriter};

pub use daemon_runtime::DaemonError;
pub use ipc::{IpcError, SOCKET_PATH_ENV};
pub use protocol::ProtocolError;
pub use relay::BrokerError;

/// Runs the short-lived Chrome Native Messaging broker on inherited stdin/stdout.
///
/// The broker forwards bounded frames to the independently managed scanner daemon. stdout is
/// reserved exclusively for Chrome-framed protocol messages.
pub fn run_stdio() -> Result<(), BrokerError> {
    let path = ipc::socket_path()?;
    let daemon = ipc::connect(&path)?;
    let stdin = io::stdin();
    let stdout = io::stdout();
    relay::run(
        BufReader::new(stdin.lock()),
        BufWriter::new(stdout.lock()),
        daemon,
    )
}

/// Runs the persistent scanner listener at the secure per-user socket selected by the environment.
pub fn run_daemon() -> Result<(), DaemonError> {
    let path = ipc::socket_path()?;
    daemon_runtime::run(&path)
}
