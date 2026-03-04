use std::sync::Mutex;

#[derive(Default)]
pub struct AppState {
    pub session_active: Mutex<bool>,
    pub control_allowed: Mutex<bool>,
    pub session_id: Mutex<Option<String>>,
    pub controller_user_id: Mutex<Option<String>>,
    pub local_override_until: Mutex<i64>,
}
