use crate::audit::{append_event, read_log, AuditEvent};
use crate::state::AppState;
use enigo::{Enigo, Key, KeyboardControllable, MouseButton, MouseControllable};
use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum InputEvent {
    MouseMove { x: i32, y: i32 },
    MouseDown { button: String },
    MouseUp { button: String },
    MouseWheel { delta_x: i32, delta_y: i32 },
    KeyDown { key: String },
    KeyUp { key: String },
}

fn map_button(button: &str) -> MouseButton {
    match button {
        "right" => MouseButton::Right,
        "middle" => MouseButton::Middle,
        _ => MouseButton::Left,
    }
}

fn map_key(key: &str) -> Option<Key> {
    match key {
        "Enter" => Some(Key::Return),
        "Backspace" => Some(Key::Backspace),
        "Tab" => Some(Key::Tab),
        "Escape" => Some(Key::Escape),
        " " => Some(Key::Space),
        "Shift" => Some(Key::Shift),
        "Control" => Some(Key::Control),
        "Alt" => Some(Key::Alt),
        "Meta" => Some(Key::Meta),
        "ArrowUp" => Some(Key::UpArrow),
        "ArrowDown" => Some(Key::DownArrow),
        "ArrowLeft" => Some(Key::LeftArrow),
        "ArrowRight" => Some(Key::RightArrow),
        _ => {
            if key.chars().count() == 1 {
                Some(Key::Layout(key.chars().next().unwrap()))
            } else {
                None
            }
        }
    }
}

#[tauri::command]
pub fn set_session_state(
    app: AppHandle,
    state: State<AppState>,
    session_id: String,
    controller_user_id: Option<String>,
    active: bool,
) -> Result<(), String> {
    {
        let mut session_active = state.session_active.lock().map_err(|_| "lock")?;
        *session_active = active;
        let mut stored_session = state.session_id.lock().map_err(|_| "lock")?;
        if active {
            *stored_session = Some(session_id.clone());
        } else {
            *stored_session = None;
        }
        let mut stored_controller = state.controller_user_id.lock().map_err(|_| "lock")?;
        *stored_controller = controller_user_id.clone();
        if !active {
            let mut override_until = state.local_override_until.lock().map_err(|_| "lock")?;
            *override_until = 0;
        }
    }

    let event = if active { "session_started" } else { "session_ended" };
    append_event(
        &app,
        AuditEvent {
            timestamp: chrono::Utc::now().to_rfc3339(),
            event: event.to_string(),
            session_id: Some(session_id),
            controller_user_id,
            details: serde_json::json!({}),
        },
    )?;

    Ok(())
}

#[tauri::command]
pub fn set_control_allowed(app: AppHandle, state: State<AppState>, allowed: bool) -> Result<(), String> {
    {
        let mut control = state.control_allowed.lock().map_err(|_| "lock")?;
        *control = allowed;
    }

    let session_id = state.session_id.lock().map_err(|_| "lock")?.clone();
    let controller = state.controller_user_id.lock().map_err(|_| "lock")?.clone();

    append_event(
        &app,
        AuditEvent {
            timestamp: chrono::Utc::now().to_rfc3339(),
            event: "control_permission".to_string(),
            session_id,
            controller_user_id: controller,
            details: serde_json::json!({ "allowed": allowed }),
        },
    )?;

    Ok(())
}

#[tauri::command]
pub fn inject_input(state: State<AppState>, event: InputEvent) -> Result<(), String> {
    let session_active = *state.session_active.lock().map_err(|_| "lock")?;
    let control_allowed = *state.control_allowed.lock().map_err(|_| "lock")?;
    let override_until = *state.local_override_until.lock().map_err(|_| "lock")?;
    let now = chrono::Utc::now().timestamp_millis();
    if !session_active || !control_allowed {
        return Err("control_not_allowed".to_string());
    }
    if override_until > now {
        return Err("local_override_active".to_string());
    }

    let mut enigo = Enigo::new();
    match event {
        InputEvent::MouseMove { x, y } => {
            enigo.mouse_move_to(x, y);
        }
        InputEvent::MouseDown { button } => {
            enigo.mouse_down(map_button(&button));
        }
        InputEvent::MouseUp { button } => {
            enigo.mouse_up(map_button(&button));
        }
        InputEvent::MouseWheel { delta_x, delta_y } => {
            if delta_x != 0 {
                enigo.mouse_scroll_x(delta_x);
            }
            if delta_y != 0 {
                enigo.mouse_scroll_y(delta_y);
            }
        }
        InputEvent::KeyDown { key } => {
            if let Some(mapped) = map_key(&key) {
                enigo.key_down(mapped);
            }
        }
        InputEvent::KeyUp { key } => {
            if let Some(mapped) = map_key(&key) {
                enigo.key_up(mapped);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn get_screen_size(app: AppHandle) -> Result<(u32, u32), String> {
    let window = app.get_window("main").ok_or_else(|| "window_not_found".to_string())?;
    let monitor = window
        .primary_monitor()
        .map_err(|err| format!("monitor_error: {err}"))?
        .ok_or_else(|| "monitor_not_found".to_string())?;
    let size = monitor.size();
    Ok((size.width, size.height))
}

#[tauri::command]
pub fn get_audit_log(app: AppHandle) -> Result<String, String> {
    read_log(&app)
}

#[tauri::command]
pub fn set_local_override(state: State<AppState>, duration_ms: i64) -> Result<(), String> {
    let mut override_until = state.local_override_until.lock().map_err(|_| "lock")?;
    let now = chrono::Utc::now().timestamp_millis();
    let until = now + duration_ms.max(0);
    if until > *override_until {
        *override_until = until;
    }
    Ok(())
}
