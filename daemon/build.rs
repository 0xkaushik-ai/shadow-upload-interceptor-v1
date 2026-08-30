#[cfg(feature = "tauri-host")]
fn main() {
    tauri_build::build();
}

#[cfg(not(feature = "tauri-host"))]
fn main() {}
