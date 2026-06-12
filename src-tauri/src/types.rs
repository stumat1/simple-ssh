//! Serde mirrors of the renderer's domain types (src/shared/types.ts).
//! Field names must serialize exactly as the TypeScript shapes (camelCase,
//! `AuthMethod` internally tagged by `kind`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AuthMethod {
    Password {
        #[serde(skip_serializing_if = "Option::is_none")]
        password: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Key {
        key_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        passphrase: Option<String>,
    },
    Agent,
}

impl AuthMethod {
    /// Strip secrets before anything touches disk (mirrors `sanitizeAuth`).
    pub fn sanitized(&self) -> AuthMethod {
        match self {
            AuthMethod::Password { .. } => AuthMethod::Password { password: None },
            AuthMethod::Key { key_path, .. } => AuthMethod::Key {
                key_path: key_path.clone(),
                passphrase: None,
            },
            AuthMethod::Agent => AuthMethod::Agent,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    /// Persist the relevant secret (password or passphrase) on a successful connect.
    pub save_secret: bool,
}

/// A transient request to open a connection (not necessarily a saved profile).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    /// Persist the relevant secret (encrypted) after a successful connection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub save_secret: Option<bool>,
}

/// An automatically recorded successful connection, for quick reconnect.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentConnection {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// Auth method with secrets stripped (kind + keyPath only).
    pub auth: AuthMethod,
    /// Epoch milliseconds of the most recent successful connect.
    pub last_used: u64,
}

/// Sent to the renderer when a host key needs the user's trust decision.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPrompt {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    /// SHA256 fingerprint of the presented key.
    pub fingerprint: String,
    /// 'unknown' = never seen; 'changed' = differs from a previously trusted key.
    pub status: &'static str,
    /// For 'changed': the fingerprint we had on file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_fingerprint: Option<String>,
}

/// A single prompt within a keyboard-interactive (e.g. MFA/OTP) challenge.
#[derive(Debug, Clone, Serialize)]
pub struct KbdPrompt {
    pub prompt: String,
    /// Whether the typed answer should be visible (false → password-style field).
    pub echo: bool,
}

/// Sent to the renderer when the server issues a keyboard-interactive challenge.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbdInteractiveRequest {
    pub session_id: String,
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<KbdPrompt>,
}

/// A local (-L style) port forward: listen on 127.0.0.1:localPort, tunnel each
/// connection to remoteHost:remotePort through the SSH session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardSpec {
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

/// Initial PTY dimensions sent with a connect request.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TerminalSize {
    pub cols: u32,
    pub rows: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Connecting,
    Ready,
    Closed,
    Error,
}
