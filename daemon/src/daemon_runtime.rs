use std::{
    io::{BufReader, BufWriter},
    os::unix::net::UnixStream,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};

use thiserror::Error;

use crate::{
    ipc::{DaemonListener, IpcError},
    protocol::{ProtocolError, run_scanner_protocol},
};

const MAX_CONCURRENT_CLIENTS: usize = 8;
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Error)]
pub enum DaemonError {
    #[error("detached daemon IPC failed: {0}")]
    Ipc(#[from] IpcError),
    #[error("could not start a scanner connection thread: {0}")]
    Thread(#[from] std::io::Error),
}

struct ConnectionPermit(Arc<AtomicUsize>);

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn acquire_connection(active: &Arc<AtomicUsize>) -> Option<ConnectionPermit> {
    active
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            (current < MAX_CONCURRENT_CLIENTS).then_some(current + 1)
        })
        .ok()
        .map(|_| ConnectionPermit(Arc::clone(active)))
}

pub(crate) fn serve_connection(stream: UnixStream) -> Result<(), ProtocolError> {
    stream.set_read_timeout(Some(CONNECTION_TIMEOUT))?;
    stream.set_write_timeout(Some(CONNECTION_TIMEOUT))?;
    let writer = stream.try_clone()?;
    run_scanner_protocol(BufReader::new(stream), BufWriter::new(writer))
}

pub fn run(path: &Path) -> Result<(), DaemonError> {
    let listener = DaemonListener::bind(path)?;
    let active_connections = Arc::new(AtomicUsize::new(0));

    loop {
        let stream = match listener.accept() {
            Ok(stream) => stream,
            Err(IpcError::UnauthorizedPeer) => {
                eprintln!("SecureIntent rejected a local IPC client owned by another user.");
                continue;
            }
            Err(IpcError::Io(error)) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(DaemonError::Ipc(error)),
        };

        let Some(permit) = acquire_connection(&active_connections) else {
            eprintln!("SecureIntent rejected a local IPC connection: concurrency limit reached.");
            continue;
        };

        thread::Builder::new()
            .name("secureintent-scan".to_owned())
            .spawn(move || {
                let _permit = permit;
                if let Err(error) = serve_connection(stream) {
                    // Errors contain protocol categories only; file contents are never logged.
                    eprintln!("SecureIntent scanner connection closed: {error}");
                }
            })?;
    }
}
