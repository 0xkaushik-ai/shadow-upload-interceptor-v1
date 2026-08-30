use std::{
    env, fs, io,
    os::unix::{
        fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt},
        io::{AsRawFd, RawFd},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
};

use thiserror::Error;

pub const SOCKET_PATH_ENV: &str = "SECUREINTENT_SHADOW_SOCKET";
const SOCKET_DIRECTORY_NAME: &str = "secureintent-shadow";
const SOCKET_FILENAME: &str = "daemon.sock";

#[derive(Debug, Error)]
pub enum IpcError {
    #[error("a secure runtime directory is unavailable; cannot create a private daemon socket")]
    MissingRuntimeDirectory,
    #[error("daemon socket path must be absolute and have a parent directory")]
    InvalidSocketPath,
    #[error("daemon socket directory is not a private directory owned by this user")]
    InsecureSocketDirectory,
    #[error("daemon socket path is occupied by a non-socket or foreign-owned file")]
    UnsafeExistingSocket,
    #[error("another SecureIntent daemon is already listening")]
    AlreadyRunning,
    #[error("local IPC peer is not owned by the current user")]
    UnauthorizedPeer,
    #[error("local IPC failed: {0}")]
    Io(#[from] io::Error),
}

fn effective_uid() -> u32 {
    // SAFETY: geteuid has no arguments and no memory-safety preconditions.
    unsafe { libc::geteuid() }
}

#[cfg(target_os = "linux")]
fn peer_uid(fd: RawFd) -> Result<u32, IpcError> {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: fd is an open Unix socket, credentials points to writable storage of `length`
    // bytes, and getsockopt initializes it when the call succeeds.
    let result = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            std::ptr::addr_of_mut!(credentials).cast(),
            std::ptr::addr_of_mut!(length),
        )
    };
    if result != 0 {
        return Err(IpcError::Io(io::Error::last_os_error()));
    }
    if length as usize != std::mem::size_of::<libc::ucred>() {
        return Err(IpcError::UnauthorizedPeer);
    }
    Ok(credentials.uid)
}

#[cfg(target_os = "macos")]
fn peer_uid(fd: RawFd) -> Result<u32, IpcError> {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    // SAFETY: fd is an open Unix socket and getpeereid initializes the supplied uid/gid storage.
    if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0 {
        return Err(IpcError::Io(io::Error::last_os_error()));
    }
    Ok(uid)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn peer_uid(_fd: RawFd) -> Result<u32, IpcError> {
    Err(IpcError::Io(io::Error::new(
        io::ErrorKind::Unsupported,
        "peer credential verification is implemented only for Linux and macOS",
    )))
}

fn verify_peer(stream: &UnixStream) -> Result<(), IpcError> {
    if peer_uid(stream.as_raw_fd())? != effective_uid() {
        return Err(IpcError::UnauthorizedPeer);
    }
    Ok(())
}

pub fn socket_path() -> Result<PathBuf, IpcError> {
    if let Some(configured) = env::var_os(SOCKET_PATH_ENV) {
        if configured.is_empty() {
            return Err(IpcError::InvalidSocketPath);
        }
        return Ok(PathBuf::from(configured));
    }

    #[cfg(target_os = "linux")]
    {
        let runtime_directory = env::var_os("XDG_RUNTIME_DIR")
            .filter(|value| !value.is_empty())
            .ok_or(IpcError::MissingRuntimeDirectory)?;
        Ok(PathBuf::from(runtime_directory)
            .join(SOCKET_DIRECTORY_NAME)
            .join(SOCKET_FILENAME))
    }

    #[cfg(target_os = "macos")]
    {
        // Caches is per-user on supported macOS installations.  We create and validate the final
        // 0700 directory below; unlike /tmp, this base is not a shared sticky directory.
        let home = env::var_os("HOME")
            .filter(|value| !value.is_empty())
            .ok_or(IpcError::MissingRuntimeDirectory)?;
        Ok(PathBuf::from(home)
            .join("Library/Caches")
            .join(SOCKET_DIRECTORY_NAME)
            .join(SOCKET_FILENAME))
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    Err(IpcError::MissingRuntimeDirectory)
}

fn socket_parent(path: &Path) -> Result<&Path, IpcError> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(IpcError::InvalidSocketPath);
    }
    path.parent().ok_or(IpcError::InvalidSocketPath)
}

fn validate_private_directory(path: &Path) -> Result<(), IpcError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_dir()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(IpcError::InsecureSocketDirectory);
    }
    Ok(())
}

fn prepare_private_directory(path: &Path) -> Result<(), IpcError> {
    match fs::symlink_metadata(path) {
        Ok(_) => validate_private_directory(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let ancestor = path.parent().ok_or(IpcError::InvalidSocketPath)?;
            validate_private_directory(ancestor)?;
            fs::DirBuilder::new().mode(0o700).create(path)?;
            validate_private_directory(path)
        }
        Err(error) => Err(IpcError::Io(error)),
    }
}

fn validate_socket_file(path: &Path) -> Result<fs::Metadata, IpcError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_socket()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o777 != 0o600
    {
        return Err(IpcError::UnsafeExistingSocket);
    }
    Ok(metadata)
}

pub fn connect(path: &Path) -> Result<UnixStream, IpcError> {
    let parent = socket_parent(path)?;
    validate_private_directory(parent)?;
    validate_socket_file(path)?;
    let stream = UnixStream::connect(path)?;
    verify_peer(&stream)?;
    Ok(stream)
}

fn remove_stale_socket(path: &Path) -> Result<(), IpcError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(IpcError::Io(error)),
    };
    if !metadata.file_type().is_socket() || metadata.uid() != effective_uid() {
        return Err(IpcError::UnsafeExistingSocket);
    }

    match UnixStream::connect(path) {
        Ok(stream) => {
            verify_peer(&stream)?;
            Err(IpcError::AlreadyRunning)
        }
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
            ) =>
        {
            fs::remove_file(path)?;
            Ok(())
        }
        Err(error) => Err(IpcError::Io(error)),
    }
}

pub struct DaemonListener {
    listener: UnixListener,
    path: PathBuf,
    device: u64,
    inode: u64,
}

impl DaemonListener {
    pub fn bind(path: &Path) -> Result<Self, IpcError> {
        let parent = socket_parent(path)?;
        prepare_private_directory(parent)?;
        remove_stale_socket(path)?;

        let listener = UnixListener::bind(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        let metadata = validate_socket_file(path)?;
        Ok(Self {
            listener,
            path: path.to_owned(),
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }

    pub fn accept(&self) -> Result<UnixStream, IpcError> {
        let (stream, _) = self.listener.accept()?;
        verify_peer(&stream)?;
        Ok(stream)
    }
}

impl Drop for DaemonListener {
    fn drop(&mut self) {
        let Ok(metadata) = fs::symlink_metadata(&self.path) else {
            return;
        };
        if metadata.file_type().is_socket()
            && metadata.dev() == self.device
            && metadata.ino() == self.inode
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::{DaemonListener, IpcError, connect};

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let id = TEST_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("secureintent-ipc-test-{}-{id}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&path)
                .expect("private test directory should be created");
            Self(path)
        }

        fn socket(&self) -> PathBuf {
            self.0.join("daemon.sock")
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn creates_a_private_same_user_socket() {
        let directory = TestDirectory::new();
        let socket = directory.socket();
        let listener = DaemonListener::bind(&socket).expect("listener should bind");
        let client = connect(&socket).expect("same-user client should connect");
        let accepted = listener
            .accept()
            .expect("same-user peer should be accepted");

        assert!(client.peer_addr().is_ok());
        assert!(accepted.peer_addr().is_ok());
        assert_eq!(
            fs::symlink_metadata(&socket)
                .expect("socket metadata should exist")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        drop(listener);
        assert!(!socket.exists());
    }

    #[test]
    fn rejects_an_insecure_socket_directory() {
        let directory = TestDirectory::new();
        fs::set_permissions(&directory.0, fs::Permissions::from_mode(0o755))
            .expect("mode should change");
        assert!(matches!(
            DaemonListener::bind(&directory.socket()),
            Err(IpcError::InsecureSocketDirectory)
        ));
    }

    #[test]
    fn never_replaces_a_regular_file_at_the_socket_path() {
        let directory = TestDirectory::new();
        let socket = directory.socket();
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&socket)
            .expect("sentinel file should be created");
        assert!(matches!(
            DaemonListener::bind(&socket),
            Err(IpcError::UnsafeExistingSocket)
        ));
        assert!(socket.is_file());
    }

    #[test]
    fn rejects_a_second_live_daemon() {
        let directory = TestDirectory::new();
        let socket = directory.socket();
        let _listener = DaemonListener::bind(&socket).expect("first listener should bind");
        assert!(matches!(
            DaemonListener::bind(&socket),
            Err(IpcError::AlreadyRunning)
        ));
    }

    #[test]
    fn safely_reclaims_an_owned_stale_socket() {
        let directory = TestDirectory::new();
        let socket = directory.socket();
        let stale =
            std::os::unix::net::UnixListener::bind(&socket).expect("stale listener should bind");
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))
            .expect("stale socket mode should be private");
        drop(stale);

        let listener = DaemonListener::bind(&socket).expect("stale socket should be reclaimed");
        let client = connect(&socket).expect("replacement listener should accept connections");
        let _accepted = listener.accept().expect("replacement should accept client");
        drop(client);
    }
}
