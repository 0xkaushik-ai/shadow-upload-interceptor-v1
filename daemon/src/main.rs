fn main() {
    if let Err(error) = secureintent_shadow_host::run_stdio() {
        eprintln!("SecureIntent Native Messaging broker stopped: {error}");
        std::process::exit(1);
    }
}
