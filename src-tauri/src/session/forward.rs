//! Local (-L style) port forwarding: a TCP listener on 127.0.0.1 whose
//! connections are tunneled through the session via direct-tcpip channels.
//! One task per forward (the accept loop) plus one task per live connection;
//! all are tied to a CancellationToken owned by the session task.

use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use super::handler::ClientHandler;
use crate::types::ForwardSpec;

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ForwardStatusEvent {
    session_id: String,
    forward_id: String,
    spec: ForwardSpec,
    /// 'active' | 'error' | 'stopped'
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

fn emit_forward_status(
    app: &AppHandle,
    session_id: &str,
    forward_id: &str,
    spec: &ForwardSpec,
    status: &'static str,
    message: Option<String>,
) {
    let _ = app.emit(
        "ssh:forward-status",
        ForwardStatusEvent {
            session_id: session_id.to_string(),
            forward_id: forward_id.to_string(),
            spec: spec.clone(),
            status,
            message,
        },
    );
}

/// Bind the local listener and serve until cancelled. Emits 'active' once
/// listening, 'error' if the bind fails, and 'stopped' on the way out.
pub async fn run_forward(
    app: AppHandle,
    session_id: String,
    forward_id: String,
    spec: ForwardSpec,
    handle: Arc<russh::client::Handle<ClientHandler>>,
    cancel: CancellationToken,
) {
    let listener = match TcpListener::bind(("127.0.0.1", spec.local_port)).await {
        Ok(listener) => listener,
        Err(e) => {
            emit_forward_status(
                &app,
                &session_id,
                &forward_id,
                &spec,
                "error",
                Some(format!("Could not listen on 127.0.0.1:{}: {e}", spec.local_port)),
            );
            return;
        }
    };
    emit_forward_status(&app, &session_id, &forward_id, &spec, "active", None);

    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            accepted = listener.accept() => {
                let (socket, peer) = match accepted {
                    Ok(pair) => pair,
                    Err(e) => {
                        log::warn!("forward {}: accept failed: {e}", spec.local_port);
                        continue;
                    }
                };
                tokio::spawn(tunnel_connection(
                    handle.clone(),
                    spec.clone(),
                    socket,
                    peer,
                    cancel.clone(),
                ));
            }
        }
    }
    emit_forward_status(&app, &session_id, &forward_id, &spec, "stopped", None);
}

/// Pump one accepted local connection over a fresh direct-tcpip channel.
async fn tunnel_connection(
    handle: Arc<russh::client::Handle<ClientHandler>>,
    spec: ForwardSpec,
    mut socket: tokio::net::TcpStream,
    peer: std::net::SocketAddr,
    cancel: CancellationToken,
) {
    let channel = match handle
        .channel_open_direct_tcpip(
            spec.remote_host.clone(),
            spec.remote_port as u32,
            peer.ip().to_string(),
            peer.port() as u32,
        )
        .await
    {
        Ok(channel) => channel,
        Err(e) => {
            log::warn!(
                "forward {} -> {}:{}: channel open failed: {e}",
                spec.local_port,
                spec.remote_host,
                spec.remote_port
            );
            return;
        }
    };
    let mut stream = channel.into_stream();
    tokio::select! {
        _ = cancel.cancelled() => {}
        result = tokio::io::copy_bidirectional(&mut socket, &mut stream) => {
            if let Err(e) = result {
                log::debug!("forward {}: connection ended: {e}", spec.local_port);
            }
        }
    }
}
