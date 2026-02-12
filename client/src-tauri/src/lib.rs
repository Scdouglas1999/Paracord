#[cfg(windows)]
mod audio_capture;
mod commands;

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init());

    #[cfg(windows)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::greet,
        commands::get_app_version,
        audio_capture::start_system_audio_capture,
        audio_capture::stop_system_audio_capture,
    ]);

    #[cfg(not(windows))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::greet,
        commands::get_app_version,
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
