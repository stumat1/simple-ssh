//! Tauri command surface — the port of registerIpcHandlers in
//! src/main/index.ts. Thin: validate, delegate to state.

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

use crate::secrets::{passphrase_id, password_id};
use crate::state::{AppState, PendingSecretSave};
use crate::types::{ConnectRequest, Profile, RecentConnection, TerminalSize};

#[tauri::command]
pub fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    mut req: ConnectRequest,
    size: Option<TerminalSize>,
    on_data: Channel<InvokeResponseBody>,
) -> String {
    // If a secret wasn't supplied but one is saved, inject it (the decrypted
    // value never leaves the backend).
    match &req.auth {
        crate::types::AuthMethod::Password { password: None } => {
            if let Some(saved) = state
                .secrets
                .get(&password_id(&req.host, req.port, &req.username))
            {
                req.auth = crate::types::AuthMethod::Password {
                    password: Some(saved),
                };
            }
        }
        crate::types::AuthMethod::Key {
            key_path,
            passphrase: None,
        } => {
            if let Some(saved) = state.secrets.get(&passphrase_id(key_path)) {
                req.auth = crate::types::AuthMethod::Key {
                    key_path: key_path.clone(),
                    passphrase: Some(saved),
                };
            }
        }
        _ => {}
    }

    let session_id = state
        .sessions
        .connect(app.clone(), req.clone(), size, on_data);

    if req.save_secret == Some(true) {
        let pending = match &req.auth {
            crate::types::AuthMethod::Password {
                password: Some(password),
            } => Some(PendingSecretSave {
                id: password_id(&req.host, req.port, &req.username),
                value: password.clone(),
            }),
            crate::types::AuthMethod::Key {
                key_path,
                passphrase: Some(passphrase),
            } => Some(PendingSecretSave {
                id: passphrase_id(key_path),
                value: passphrase.clone(),
            }),
            _ => None,
        };
        if let Some(pending) = pending {
            state
                .pending_secret_saves
                .lock()
                .unwrap()
                .insert(session_id.clone(), pending);
        }
    }
    state
        .pending_recents
        .lock()
        .unwrap()
        .insert(session_id.clone(), req);
    log::debug!("live sessions: {} (connect)", state.sessions.size());
    session_id
}

#[tauri::command]
pub fn ssh_disconnect(state: State<'_, AppState>, session_id: String) {
    state.sessions.disconnect(&session_id);
}

#[tauri::command]
pub fn ssh_input(state: State<'_, AppState>, session_id: String, data: String) {
    state.sessions.write(&session_id, &data);
}

#[tauri::command]
pub fn ssh_resize(state: State<'_, AppState>, session_id: String, cols: u32, rows: u32) {
    state.sessions.resize(&session_id, cols, rows);
}

#[tauri::command]
pub fn hostkey_decision(state: State<'_, AppState>, session_id: String, accept: bool) {
    if let Some(tx) = state.pending.host_key.lock().unwrap().remove(&session_id) {
        let _ = tx.send(accept);
    }
}

#[tauri::command]
pub fn kbd_answer(state: State<'_, AppState>, session_id: String, answers: Vec<String>) {
    if let Some(tx) = state.pending.kbd.lock().unwrap().remove(&session_id) {
        let _ = tx.send(answers);
    }
}

// --- Secrets (presence/forget only; plaintext never crosses the bridge) ---

#[tauri::command]
pub fn secret_has_password(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: String,
) -> bool {
    state.secrets.has(&password_id(&host, port, &username))
}

#[tauri::command]
pub fn secret_forget_password(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: String,
) {
    state.secrets.delete(&password_id(&host, port, &username));
}

#[tauri::command]
pub fn secret_has_passphrase(state: State<'_, AppState>, key_path: String) -> bool {
    state.secrets.has(&passphrase_id(&key_path))
}

#[tauri::command]
pub fn secret_forget_passphrase(state: State<'_, AppState>, key_path: String) {
    state.secrets.delete(&passphrase_id(&key_path));
}

// --- Profiles + recents ---

#[tauri::command]
pub fn profiles_list(state: State<'_, AppState>) -> Vec<Profile> {
    state.profiles.lock().unwrap().list()
}

#[tauri::command]
pub fn profiles_save(state: State<'_, AppState>, profile: Profile) -> Profile {
    state.profiles.lock().unwrap().save(profile)
}

#[tauri::command]
pub fn profiles_delete(state: State<'_, AppState>, id: String) {
    state.profiles.lock().unwrap().delete(&id);
}

#[tauri::command]
pub fn recents_list(state: State<'_, AppState>) -> Vec<RecentConnection> {
    state.profiles.lock().unwrap().recents()
}

/// Everything `run()` registers, in one place.
pub fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![
        ssh_connect,
        ssh_disconnect,
        ssh_input,
        ssh_resize,
        hostkey_decision,
        kbd_answer,
        secret_has_password,
        secret_forget_password,
        secret_has_passphrase,
        secret_forget_passphrase,
        profiles_list,
        profiles_save,
        profiles_delete,
        recents_list
    ]
}

/// Initialize managed state once the app (and its paths) are ready.
pub fn init_state(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    app.manage(AppState::new(data_dir));
    Ok(())
}
