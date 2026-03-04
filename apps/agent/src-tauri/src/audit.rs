use serde::{Deserialize, Serialize};
use std::fs::{create_dir_all, OpenOptions};
use std::io::{Read, Write};
use tauri::api::path::app_data_dir;
use tauri::AppHandle;

#[derive(Debug, Serialize, Deserialize)]
pub struct AuditEvent {
    pub timestamp: String,
    pub event: String,
    pub session_id: Option<String>,
    pub controller_user_id: Option<String>,
    pub details: serde_json::Value,
}

fn audit_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app_data_dir(&app.config()).ok_or_else(|| "app data dir not found".to_string())?;
    let dir = base.join("audit");
    create_dir_all(&dir).map_err(|err| format!("create_dir: {err}"))?;
    Ok(dir.join("agent.jsonl"))
}

pub fn append_event(app: &AppHandle, event: AuditEvent) -> Result<(), String> {
    let path = audit_path(app)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("open_log: {err}"))?;
    let line = serde_json::to_string(&event).map_err(|err| format!("serialize: {err}"))?;
    file.write_all(line.as_bytes()).map_err(|err| format!("write: {err}"))?;
    file.write_all(b"\n").map_err(|err| format!("write: {err}"))?;
    Ok(())
}

pub fn read_log(app: &AppHandle) -> Result<String, String> {
    let path = audit_path(app)?;
    if !path.exists() {
        return Ok(String::new());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|err| format!("open_log: {err}"))?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)
        .map_err(|err| format!("read: {err}"))?;
    Ok(contents)
}
