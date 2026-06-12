//! Tauri command surface — the port of registerIpcHandlers in
//! src/main/index.ts. Thin: validate, delegate to state.

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

use crate::secrets::{passphrase_id, password_id};
use crate::state::{AppState, PendingSecretSave};
use crate::types::{ConnectRequest, ForwardSpec, Profile, RecentConnection, TerminalSize};

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

// --- Local port forwarding ---

/// Start a local (-L) forward on a live session. Returns the forwardId; the
/// listener's outcome arrives via `ssh:forward-status` events.
#[tauri::command]
pub fn forward_add(
    state: State<'_, AppState>,
    session_id: String,
    spec: ForwardSpec,
) -> Result<String, String> {
    if spec.local_port == 0 || spec.remote_port == 0 {
        return Err("Ports must be between 1 and 65535.".into());
    }
    if spec.remote_host.trim().is_empty() {
        return Err("Remote host is required.".into());
    }
    state
        .sessions
        .add_forward(&session_id, spec)
        .ok_or_else(|| "Session is not connected.".to_string())
}

#[tauri::command]
pub fn forward_stop(state: State<'_, AppState>, session_id: String, forward_id: String) {
    state.sessions.stop_forward(&session_id, &forward_id);
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

/// Result of a one-way `~/.ssh/config` import.
#[derive(serde::Serialize)]
pub struct SshConfigImportResult {
    pub imported: usize,
    pub skipped: usize,
}

/// Import Host blocks from the user's OpenSSH config as saved profiles.
/// Hosts whose alias matches an existing profile name (case-insensitive) are
/// skipped, so re-importing never duplicates or overwrites.
#[tauri::command]
pub fn ssh_config_import(state: State<'_, AppState>) -> Result<SshConfigImportResult, String> {
    let path = crate::ssh_config::default_config_path()
        .ok_or_else(|| "Could not determine the home directory.".to_string())?;
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let home = crate::ssh_config::home_dir().unwrap_or_default();
    let hosts = crate::ssh_config::parse(&text, &home);

    // Hosts without a User directive default to the local username.
    let local_user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default();

    let mut profiles = state.profiles.lock().unwrap();
    let mut existing: std::collections::HashSet<String> = profiles
        .list()
        .iter()
        .map(|p| p.name.to_ascii_lowercase())
        .collect();

    let mut imported = 0;
    let mut skipped = 0;
    for host in hosts {
        if !existing.insert(host.name.to_ascii_lowercase()) {
            skipped += 1;
            continue;
        }
        let auth = match &host.identity_file {
            Some(key_path) => crate::types::AuthMethod::Key {
                key_path: key_path.clone(),
                passphrase: None,
            },
            None => crate::types::AuthMethod::Agent,
        };
        let username = if host.username.is_empty() {
            local_user.clone()
        } else {
            host.username
        };
        profiles.save(Profile {
            id: String::new(),
            name: host.name,
            host: host.host,
            port: host.port,
            username,
            auth,
            save_secret: false,
        });
        imported += 1;
    }
    Ok(SshConfigImportResult { imported, skipped })
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
        forward_add,
        forward_stop,
        secret_has_password,
        secret_forget_password,
        secret_has_passphrase,
        secret_forget_passphrase,
        profiles_list,
        profiles_save,
        profiles_delete,
        recents_list,
        ssh_config_import
    ]
}

/// Initialize managed state once the app (and its paths) are ready.
pub fn init_state(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    app.manage(AppState::new(data_dir));
    Ok(())
}
