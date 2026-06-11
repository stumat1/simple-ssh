//! Connection + authentication orchestration. Port of applyAuth and the
//! keyboard-interactive handling in src/main/session-manager.ts. russh drives
//! keyboard-interactive from the caller (not a callback), so the
//! auto-answer-once rule and the renderer round-trip both live in the kbd loop
//! here.

use std::sync::Arc;

use russh::client::{AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::PrivateKeyWithHashAlg;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use super::handler::ClientHandler;
use crate::error::{Error, Result};
use crate::state::AppState;
use crate::types::{AuthMethod, ConnectRequest, KbdInteractiveRequest, KbdPrompt};

pub async fn connect_and_auth(
    app: &AppHandle,
    session_id: &str,
    req: &ConnectRequest,
    config: Arc<russh::client::Config>,
) -> Result<Handle<ClientHandler>> {
    let handler = ClientHandler {
        app: app.clone(),
        session_id: session_id.to_string(),
        host: req.host.clone(),
        port: req.port,
    };

    // Bound only the TCP connect (ssh2's readyTimeout): everything after it
    // can block on user prompts (host-key trust, MFA) with their own timeouts.
    let stream = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        tokio::net::TcpStream::connect((req.host.as_str(), req.port)),
    )
    .await
    .map_err(|_| Error::msg("Timed out while connecting"))?
    .map_err(|e| Error::msg(format!("Cannot connect to {}:{}: {e}", req.host, req.port)))?;

    let mut handle = russh::client::connect_stream(config, stream, handler)
        .await
        .map_err(|e| Error::msg(e.to_string()))?;

    // Primary method first; if the server still wants more (or the primary
    // failed), fall back to keyboard-interactive — mirroring ssh2's
    // tryKeyboard: true behavior.
    let primary_ok = match &req.auth {
        AuthMethod::Password { password } => match password {
            Some(password) => auth_password(&mut handle, &req.username, password).await?,
            None => false,
        },
        AuthMethod::Key {
            key_path,
            passphrase,
        } => auth_key(&mut handle, &req.username, key_path, passphrase.as_deref()).await?,
        AuthMethod::Agent => auth_agent(&mut handle, &req.username).await?,
    };

    if primary_ok {
        return Ok(handle);
    }

    // The connection password, for the kbd auto-answer rule.
    let password = match &req.auth {
        AuthMethod::Password {
            password: Some(password),
        } => Some(password.clone()),
        _ => None,
    };
    if keyboard_interactive(app, session_id, &mut handle, &req.username, password).await? {
        return Ok(handle);
    }

    Err(Error::msg("All configured authentication methods failed"))
}

async fn auth_password(
    handle: &mut Handle<ClientHandler>,
    username: &str,
    password: &str,
) -> Result<bool> {
    let result = handle
        .authenticate_password(username, password)
        .await
        .map_err(|e| Error::msg(e.to_string()))?;
    Ok(matches!(result, AuthResult::Success))
}

async fn auth_key(
    handle: &mut Handle<ClientHandler>,
    username: &str,
    key_path: &str,
    passphrase: Option<&str>,
) -> Result<bool> {
    let raw = std::fs::read_to_string(key_path)
        .map_err(|e| Error::msg(format!("Cannot read key file {key_path}: {e}")))?;
    if raw.starts_with("PuTTY-User-Key-File") {
        return Err(Error::msg(
            "PuTTY .ppk keys are not supported — export the key in OpenSSH format \
             with PuTTYgen (Conversions → Export OpenSSH key) and try again",
        ));
    }
    let key = russh::keys::decode_secret_key(&raw, passphrase)
        .map_err(|e| Error::msg(format!("Cannot parse key file {key_path}: {e}")))?;

    let hash_alg = handle
        .best_supported_rsa_hash()
        .await
        .map_err(|e| Error::msg(e.to_string()))?
        .flatten();
    let result = handle
        .authenticate_publickey(
            username,
            PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
        )
        .await
        .map_err(|e| Error::msg(e.to_string()))?;
    Ok(matches!(result, AuthResult::Success))
}

/// Path to the SSH agent endpoint for the current platform.
fn agent_pipe_path() -> String {
    if let Ok(sock) = std::env::var("SSH_AUTH_SOCK") {
        if !sock.is_empty() {
            return sock;
        }
    }
    // Windows OpenSSH agent named pipe.
    r"\\.\pipe\openssh-ssh-agent".to_string()
}

#[cfg(windows)]
async fn auth_agent(handle: &mut Handle<ClientHandler>, username: &str) -> Result<bool> {
    use russh::keys::agent::client::AgentClient;

    let pipe = agent_pipe_path();
    let stream = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(&pipe)
        .map_err(|e| Error::msg(format!("Cannot reach SSH agent at {pipe}: {e}")))?;
    let mut agent = AgentClient::connect(stream);

    let identities = agent
        .request_identities()
        .await
        .map_err(|e| Error::msg(format!("SSH agent error: {e}")))?;
    if identities.is_empty() {
        return Err(Error::msg("The SSH agent holds no identities"));
    }

    let hash_alg = handle
        .best_supported_rsa_hash()
        .await
        .map_err(|e| Error::msg(e.to_string()))?
        .flatten();
    for identity in identities {
        let key = identity.public_key().into_owned();
        let result = handle
            .authenticate_publickey_with(username, key, hash_alg, &mut agent)
            .await
            .map_err(|e| Error::msg(e.to_string()))?;
        if matches!(result, AuthResult::Success) {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(not(windows))]
async fn auth_agent(handle: &mut Handle<ClientHandler>, username: &str) -> Result<bool> {
    use russh::keys::agent::client::AgentClient;

    let sock = agent_pipe_path();
    let mut agent = AgentClient::connect_uds(&sock)
        .await
        .map_err(|e| Error::msg(format!("Cannot reach SSH agent at {sock}: {e}")))?;

    let identities = agent
        .request_identities()
        .await
        .map_err(|e| Error::msg(format!("SSH agent error: {e}")))?;
    if identities.is_empty() {
        return Err(Error::msg("The SSH agent holds no identities"));
    }

    let hash_alg = handle
        .best_supported_rsa_hash()
        .await
        .map_err(|e| Error::msg(e.to_string()))?
        .flatten();
    for identity in identities {
        let key = identity.public_key().into_owned();
        let result = handle
            .authenticate_publickey_with(username, key, hash_alg, &mut agent)
            .await
            .map_err(|e| Error::msg(e.to_string()))?;
        if matches!(result, AuthResult::Success) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Drive a keyboard-interactive exchange. Many OpenSSH servers implement
/// password auth *via* keyboard-interactive (PAM): when we hold a password and
/// the server asks a single hidden prompt, answer it automatically once — so
/// the user isn't re-prompted for a password they already typed. Subsequent
/// rounds (true MFA/OTP) surface to the renderer.
async fn keyboard_interactive(
    app: &AppHandle,
    session_id: &str,
    handle: &mut Handle<ClientHandler>,
    username: &str,
    password: Option<String>,
) -> Result<bool> {
    let mut auto_used = false;
    let mut response = handle
        .authenticate_keyboard_interactive_start(username, None)
        .await
        .map_err(|e| Error::msg(e.to_string()))?;

    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let answers = if let (false, Some(pw), 1) =
                    (auto_used, password.as_deref(), prompts.len())
                {
                    if !prompts[0].echo {
                        auto_used = true;
                        vec![pw.to_string()]
                    } else {
                        ask_renderer(app, session_id, &name, &instructions, &prompts).await
                    }
                } else if prompts.is_empty() {
                    // Informational round — respond with no answers to continue.
                    Vec::new()
                } else {
                    ask_renderer(app, session_id, &name, &instructions, &prompts).await
                };

                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(|e| Error::msg(e.to_string()))?;
            }
        }
    }
}

/// Forward a keyboard-interactive challenge to the renderer and await answers.
/// An empty answer list (cancel/teardown) lets the round fail server-side.
async fn ask_renderer(
    app: &AppHandle,
    session_id: &str,
    name: &str,
    instructions: &str,
    prompts: &[russh::client::Prompt],
) -> Vec<String> {
    let state = app.state::<AppState>();
    let (tx, rx) = oneshot::channel();
    state
        .pending
        .kbd
        .lock()
        .unwrap()
        .insert(session_id.to_string(), tx);

    let request = KbdInteractiveRequest {
        session_id: session_id.to_string(),
        name: name.to_string(),
        instructions: instructions.to_string(),
        prompts: prompts
            .iter()
            .map(|p| KbdPrompt {
                prompt: p.prompt.clone(),
                echo: p.echo,
            })
            .collect(),
    };
    let _ = app.emit("ssh:kbd-prompt", request);

    let answers = rx.await.unwrap_or_default();
    state.pending.kbd.lock().unwrap().remove(session_id);
    answers
}
