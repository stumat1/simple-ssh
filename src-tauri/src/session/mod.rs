//! Owns all live russh connections and their shell channels, keyed by
//! sessionId. The single place with network access. Port of the Electron
//! main-process SessionManager (src/main/session-manager.ts) plus the
//! host-key / ready-status policy that lived in src/main/index.ts.

mod auth;
mod forward;
mod handler;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use uuid::Uuid;

use tokio_util::sync::CancellationToken;

use crate::state::AppState;
use crate::types::{ConnectRequest, ForwardSpec, SessionStatus, TerminalSize};

/// Commands the rest of the app can send into a live session task.
enum SessionCmd {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    AddForward { forward_id: String, spec: ForwardSpec },
    StopForward { forward_id: String },
    Disconnect,
}

struct SessionHandle {
    cmd_tx: mpsc::UnboundedSender<SessionCmd>,
}

#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, SessionHandle>>,
}

/// Event payloads for the low-frequency renderer events. Terminal output does
/// not go through events — it streams over the per-session IPC `Channel`.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    session_id: String,
    status: SessionStatus,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ErrorEvent {
    session_id: String,
    message: String,
}

pub fn emit_status(app: &AppHandle, session_id: &str, status: SessionStatus) {
    let _ = app.emit(
        "ssh:status",
        StatusEvent {
            session_id: session_id.to_string(),
            status,
        },
    );
}

fn emit_error(app: &AppHandle, session_id: &str, message: String) {
    let _ = app.emit(
        "ssh:error",
        ErrorEvent {
            session_id: session_id.to_string(),
            message,
        },
    );
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of live sessions — used to assert no leaks after disconnects.
    pub fn size(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }

    /// Opens an SSH connection and a PTY shell. Returns the new sessionId
    /// immediately; connection progress is reported via status/error events
    /// and the data channel.
    pub fn connect(
        &self,
        app: AppHandle,
        req: ConnectRequest,
        size: Option<TerminalSize>,
        on_data: Channel<InvokeResponseBody>,
    ) -> String {
        let session_id = Uuid::new_v4().to_string();
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.clone(), SessionHandle { cmd_tx });
        emit_status(&app, &session_id, SessionStatus::Connecting);

        let id = session_id.clone();
        tauri::async_runtime::spawn(async move {
            run_session(app, id, req, size, on_data, cmd_rx).await;
        });

        session_id
    }

    /// Writes user keystrokes to the shell stream.
    pub fn write(&self, session_id: &str, data: &str) {
        if let Some(s) = self.sessions.lock().unwrap().get(session_id) {
            let _ = s.cmd_tx.send(SessionCmd::Write(data.as_bytes().to_vec()));
        }
    }

    /// Resizes the remote PTY to match the terminal grid.
    pub fn resize(&self, session_id: &str, cols: u32, rows: u32) {
        if let Some(s) = self.sessions.lock().unwrap().get(session_id) {
            let _ = s.cmd_tx.send(SessionCmd::Resize { cols, rows });
        }
    }

    /// Starts a local port forward on a live session; returns its new id, or
    /// None when the session doesn't exist. Outcome arrives via
    /// `ssh:forward-status` events ('active' / 'error').
    pub fn add_forward(&self, session_id: &str, spec: ForwardSpec) -> Option<String> {
        let sessions = self.sessions.lock().unwrap();
        let s = sessions.get(session_id)?;
        let forward_id = Uuid::new_v4().to_string();
        s.cmd_tx
            .send(SessionCmd::AddForward {
                forward_id: forward_id.clone(),
                spec,
            })
            .ok()?;
        Some(forward_id)
    }

    /// Stops a forward (its listener and any tunneled connections).
    pub fn stop_forward(&self, session_id: &str, forward_id: &str) {
        if let Some(s) = self.sessions.lock().unwrap().get(session_id) {
            let _ = s.cmd_tx.send(SessionCmd::StopForward {
                forward_id: forward_id.to_string(),
            });
        }
    }

    /// Requests a graceful disconnect; final cleanup happens in the session task.
    pub fn disconnect(&self, session_id: &str) {
        if let Some(s) = self.sessions.lock().unwrap().get(session_id) {
            let _ = s.cmd_tx.send(SessionCmd::Disconnect);
        }
    }

    /// Disconnects every live session (e.g. on app exit).
    pub fn disconnect_all(&self) {
        for s in self.sessions.lock().unwrap().values() {
            let _ = s.cmd_tx.send(SessionCmd::Disconnect);
        }
    }

    /// Remove a session from the registry; returns false if already removed
    /// (so callers can avoid emitting duplicate terminal status events).
    fn take(&self, session_id: &str) -> bool {
        self.sessions.lock().unwrap().remove(session_id).is_some()
    }
}

/// Final teardown: deregister, drop pending state, emit a single terminal
/// status. Mirrors SessionManager.cleanup + the status handler in index.ts.
fn cleanup(app: &AppHandle, session_id: &str, status: SessionStatus) {
    let state = app.state::<AppState>();
    if !state.sessions.take(session_id) {
        return; // already cleaned up — avoids duplicate status events
    }
    state.pending_secret_saves.lock().unwrap().remove(session_id);
    state.pending_recents.lock().unwrap().remove(session_id);
    state.pending.drain_session(session_id);
    emit_status(app, session_id, status);
    log::debug!("live sessions: {} ({:?})", state.sessions.size(), status);
}

fn fail(app: &AppHandle, session_id: &str, message: String) {
    // Match Electron ordering: error event first, then the 'error' status.
    if app
        .state::<AppState>()
        .sessions
        .sessions
        .lock()
        .unwrap()
        .contains_key(session_id)
    {
        emit_error(app, session_id, message);
        cleanup(app, session_id, SessionStatus::Error);
    }
}

/// Auth succeeded — persist the secret (if requested) and record the recent.
fn on_ready(app: &AppHandle, session_id: &str) {
    let state = app.state::<AppState>();
    if let Some(pending) = state.pending_secret_saves.lock().unwrap().remove(session_id) {
        state.secrets.set(&pending.id, &pending.value);
    }
    if let Some(recent) = state.pending_recents.lock().unwrap().remove(session_id) {
        state.profiles.lock().unwrap().record_recent(
            &recent.host,
            recent.port,
            &recent.username,
            &recent.auth,
        );
    }
    emit_status(app, session_id, SessionStatus::Ready);
}

/// The per-session task: connect, authenticate, open a PTY shell, then pump
/// bytes both ways until the channel closes or a disconnect is requested.
async fn run_session(
    app: AppHandle,
    session_id: String,
    req: ConnectRequest,
    size: Option<TerminalSize>,
    on_data: Channel<InvokeResponseBody>,
    mut cmd_rx: mpsc::UnboundedReceiver<SessionCmd>,
) {
    let config = Arc::new(russh::client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    });

    // No blanket timeout here: connect_and_auth may legitimately sit for
    // minutes inside a host-key or MFA prompt waiting on the user. The TCP
    // connect itself is bounded inside (ssh2's readyTimeout equivalent).
    // Arc so port-forward tasks can open channels concurrently with the shell
    // (russh Handle methods all take &self).
    let handle = match auth::connect_and_auth(&app, &session_id, &req, config).await {
        Ok(handle) => Arc::new(handle),
        Err(e) => {
            fail(&app, &session_id, e.to_string());
            return;
        }
    };

    // PTY + shell.
    let (cols, rows) = size.map(|s| (s.cols, s.rows)).unwrap_or((80, 24));
    let channel = match open_shell(&handle, cols, rows).await {
        Ok(ch) => ch,
        Err(e) => {
            fail(&app, &session_id, e.to_string());
            return;
        }
    };

    on_ready(&app, &session_id);

    // Active port forwards: cancelling a token stops that forward's listener
    // and all of its tunneled connections.
    let mut forwards: HashMap<String, CancellationToken> = HashMap::new();

    let mut channel = channel;
    loop {
        tokio::select! {
            msg = channel.wait() => {
                match msg {
                    // Server output is binary; forward raw bytes (never
                    // stringify) so multi-byte UTF-8 spanning chunk boundaries
                    // stays intact all the way to xterm.
                    Some(russh::ChannelMsg::Data { data }) => {
                        let _ = on_data.send(InvokeResponseBody::Raw(data.to_vec()));
                    }
                    Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = on_data.send(InvokeResponseBody::Raw(data.to_vec()));
                    }
                    Some(russh::ChannelMsg::Close) | Some(russh::ChannelMsg::Eof) | None => {
                        break;
                    }
                    Some(_) => {} // exit-status etc. — close follows
                }
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(SessionCmd::Write(bytes)) => {
                        if channel.data(&bytes[..]).await.is_err() {
                            break;
                        }
                    }
                    Some(SessionCmd::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                    Some(SessionCmd::AddForward { forward_id, spec }) => {
                        let cancel = CancellationToken::new();
                        forwards.insert(forward_id.clone(), cancel.clone());
                        tauri::async_runtime::spawn(forward::run_forward(
                            app.clone(),
                            session_id.clone(),
                            forward_id,
                            spec,
                            handle.clone(),
                            cancel,
                        ));
                    }
                    Some(SessionCmd::StopForward { forward_id }) => {
                        if let Some(cancel) = forwards.remove(&forward_id) {
                            cancel.cancel();
                        }
                    }
                    Some(SessionCmd::Disconnect) | None => {
                        let _ = channel.eof().await;
                        break;
                    }
                }
            }
        }
    }

    for cancel in forwards.values() {
        cancel.cancel();
    }
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;
    cleanup(&app, &session_id, SessionStatus::Closed);
}

async fn open_shell(
    handle: &russh::client::Handle<handler::ClientHandler>,
    cols: u32,
    rows: u32,
) -> Result<russh::Channel<russh::client::Msg>, russh::Error> {
    let channel = handle.channel_open_session().await?;
    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await?;
    channel.request_shell(false).await?;
    Ok(channel)
}
