// Shared domain types used across main, preload, and renderer.

export type AuthMethod =
  | { kind: 'password'; password?: string }
  | { kind: 'key'; keyPath: string; passphrase?: string }
  | { kind: 'agent' }

export type AuthKind = AuthMethod['kind']

export interface Profile {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth: AuthMethod
  /** Persist the relevant secret (password or passphrase) on a successful connect. */
  saveSecret: boolean
}

/** A transient request to open a connection (not necessarily a saved profile). */
export interface ConnectRequest {
  host: string
  port: number
  username: string
  auth: AuthMethod
  /** Persist the relevant secret (encrypted) after a successful connection. */
  saveSecret?: boolean
}

/** An automatically recorded successful connection, for quick reconnect. */
export interface RecentConnection {
  host: string
  port: number
  username: string
  /** Auth method with secrets stripped (kind + keyPath only). */
  auth: AuthMethod
  /** Epoch milliseconds of the most recent successful connect. */
  lastUsed: number
}

/** Sent to the renderer when a host key needs the user's trust decision. */
export interface HostKeyPrompt {
  sessionId: string
  host: string
  port: number
  /** SHA256 fingerprint of the presented key. */
  fingerprint: string
  /** 'unknown' = never seen; 'changed' = differs from a previously trusted key. */
  status: 'unknown' | 'changed'
  /** For 'changed': the fingerprint we had on file. */
  knownFingerprint?: string
}

/** A single prompt within a keyboard-interactive (e.g. MFA/OTP) challenge. */
export interface KbdPrompt {
  prompt: string
  /** Whether the typed answer should be visible (false → password-style field). */
  echo: boolean
}

/** Sent to the renderer when the server issues a keyboard-interactive challenge. */
export interface KbdInteractiveRequest {
  sessionId: string
  name: string
  instructions: string
  prompts: KbdPrompt[]
}

/** Initial PTY dimensions sent with a connect request. */
export interface TerminalSize {
  cols: number
  rows: number
}

export type SessionStatus = 'connecting' | 'ready' | 'closed' | 'error'

/** A local (-L style) port forward through an SSH session. */
export interface ForwardSpec {
  localPort: number
  remoteHost: string
  remotePort: number
}

export type ForwardStatus = 'active' | 'error' | 'stopped'

/** Lifecycle update for a port forward. */
export interface ForwardStatusEvent {
  sessionId: string
  forwardId: string
  spec: ForwardSpec
  status: ForwardStatus
  message?: string
}
