fn main() {
    let (daemon_result_sender, daemon_result_receiver) = std::sync::mpsc::channel();
    if let Err(error) = std::thread::Builder::new()
        .name("secureintent-daemon".to_owned())
        .spawn(move || {
            // Bind before initializing the desktop runtime. GTK/Tauri initialization may wait for
            // desktop services in a headless login, but local upload protection must not wait with
            // it. Tauri still owns this process's main-thread application lifecycle.
            let _ = daemon_result_sender.send(secureintent_shadow_host::run_daemon());
        })
    {
        eprintln!("SecureIntent could not start the detached daemon thread: {error}");
        std::process::exit(1);
    }

    let application = match tauri::Builder::default().build(tauri::generate_context!()) {
        Ok(application) => application,
        Err(error) => {
            eprintln!("SecureIntent detached daemon failed to initialize Tauri: {error}");
            std::process::exit(1);
        }
    };

    let handle = application.handle().clone();
    if let Err(error) = std::thread::Builder::new()
        .name("secureintent-daemon-monitor".to_owned())
        .spawn(move || {
            // Client disconnects are handled inside the listener and never reach here. Exit Tauri
            // only when the persistent listener itself cannot continue.
            let exit_code = match daemon_result_receiver.recv() {
                Ok(Ok(())) => 0,
                Ok(Err(error)) => {
                    eprintln!("SecureIntent detached Tauri daemon stopped: {error}");
                    1
                }
                Err(error) => {
                    eprintln!("SecureIntent detached daemon monitor stopped: {error}");
                    1
                }
            };
            handle.exit(exit_code);
        })
    {
        eprintln!("SecureIntent could not start the detached daemon monitor: {error}");
        std::process::exit(1);
    }

    // Tauri owns the main-thread application lifecycle. systemd owns this process; Chrome owns
    // only temporary Native Messaging broker processes.
    application.run(|_, _| {});
}
