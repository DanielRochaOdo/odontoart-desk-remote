#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audit;
mod capture;
mod commands;
mod state;

use capture::CaptureState;
use state::AppState;

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .manage(CaptureState::default())
        .invoke_handler(tauri::generate_handler![
            commands::set_session_state,
            commands::set_control_allowed,
            commands::inject_input,
            commands::get_screen_size,
            commands::get_audit_log,
            commands::set_local_override,
            capture::start_native_capture,
            capture::stop_native_capture,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
