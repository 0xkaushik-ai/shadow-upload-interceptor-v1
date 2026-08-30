fn main() {
    if let Err(error) = secureintent_shadow_host::run_daemon() {
        eprintln!("SecureIntent detached daemon stopped: {error}");
        std::process::exit(1);
    }
}
