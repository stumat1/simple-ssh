//! Managed application state: the stores plus the pending-decision maps that
//! bridge async renderer round-trips (host-key trust, keyboard-interactive)
//! back into paused SSH handshakes. Mirrors the module-level maps in the
//! Electron main process (src/main/index.ts).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tokio::sync::oneshot;

use crate::known_hosts::KnownHostsStore;
use crate::profiles::ProfileStore;
use crate::secrets::SecretStore;
use crate::types::ConnectRequest;

/// Secret to persist iff the connection authenticates (reaches 'ready').
pub struct PendingSecretSave {
    pub id: String,
    pub value: String,
}

#[derive(Default)]
pub struct PendingPrompts {
    /// Host-key trust decisions awaiting a renderer response, by sessionId.
    pub host_key: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    /// Keyboard-interactive answers awaiting a renderer response, by sessionId.
    pub kbd: Mutex<HashMap<String, oneshot::Sender<Vec<String>>>>,
}

impl PendingPrompts {
    /// Abort any prompt still waiting for this session (deny / no answers).
    pub fn drain_session(&self, session_id: &str) {
        if let Some(tx) = self.host_key.lock().unwrap().remove(session_id) {
            let _ = tx.send(false);
        }
        if let Some(tx) = self.kbd.lock().unwrap().remove(session_id) {
            let _ = tx.send(Vec::new());
        }
    }
}

pub struct AppState {
    pub known_hosts: Mutex<KnownHostsStore>,
    pub profiles: Mutex<ProfileStore>,
    pub secrets: SecretStore,
    pub pending: PendingPrompts,
    /// Secrets to persist on successful auth, by sessionId.
    pub pending_secret_saves: Mutex<HashMap<String, PendingSecretSave>>,
    /// Connection targets recorded into "recents" once ready, by sessionId.
    pub pending_recents: Mutex<HashMap<String, ConnectRequest>>,
    pub sessions: crate::session::SessionManager,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        migrate_from_electron(&data_dir);
        Self {
            known_hosts: Mutex::new(KnownHostsStore::new(data_dir.join("known_hosts.json"))),
            profiles: Mutex::new(ProfileStore::new(data_dir.join("profiles.json"))),
            secrets: SecretStore,
            pending: PendingPrompts::default(),
            pending_secret_saves: Mutex::new(HashMap::new()),
            pending_recents: Mutex::new(HashMap::new()),
            sessions: crate::session::SessionManager::new(),
        }
    }
}

/// One-time copy of profiles.json / known_hosts.json from the old Electron
/// userData directory (%APPDATA%\simple-ssh). Secrets are intentionally not
/// migrated (they were DPAPI ciphertext tied to Electron's safeStorage).
fn migrate_from_electron(data_dir: &PathBuf) {
    let Some(old_dir) = std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("simple-ssh"))
    else {
        return;
    };
    for name in ["profiles.json", "known_hosts.json"] {
        let target = data_dir.join(name);
        let source = old_dir.join(name);
        if !target.exists() && source.exists() {
            let _ = std::fs::create_dir_all(data_dir);
            if std::fs::copy(&source, &target).is_ok() {
                log::info!("migrated {name} from Electron data dir");
            }
        }
    }
}
