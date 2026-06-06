import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type {
  AuthMethod,
  ConnectRequest,
  KbdPrompt,
  SessionStatus,
  TerminalSize
} from '@shared/types'

interface Session {
  conn: Client
  stream?: ClientChannel
  /** True once the connection password has been auto-supplied to a kbd prompt. */
  kbdAutoUsed?: boolean
}

/**
 * Event sinks the manager pushes to. Injected (rather than referencing Electron
 * directly) so the manager stays decoupled and unit-testable.
 */
export interface SessionCallbacks {
  onData: (sessionId: string, data: Uint8Array) => void
  onStatus: (sessionId: string, status: SessionStatus) => void
  onError: (sessionId: string, message: string) => void
  /**
   * Decide whether to trust the server's host key. Host-key policy (known-hosts
   * lookup + user prompt) lives outside the manager. Resolve true to continue
   * the handshake, false to abort.
   */
  verifyHostKey: (sessionId: string, host: string, port: number, key: Buffer) => Promise<boolean>
  /**
   * Answer a keyboard-interactive (MFA/OTP) challenge. Resolve with one response
   * per prompt; resolve [] to decline (which aborts auth).
   */
  onKeyboardInteractive: (
    sessionId: string,
    name: string,
    instructions: string,
    prompts: KbdPrompt[]
  ) => Promise<string[]>
}

/** Path to the SSH agent endpoint for the current platform. */
function resolveAgent(): string {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK
  // Windows OpenSSH agent named pipe. (Use 'pageant' instead for PuTTY's agent.)
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent'
  return ''
}

/**
 * Translate our AuthMethod into ssh2 connect options. Private keys are read here
 * (main process only). May throw (e.g. unreadable key file) — the caller treats
 * that as a connection failure.
 */
function applyAuth(cfg: ConnectConfig, auth: AuthMethod): void {
  switch (auth.kind) {
    case 'password':
      cfg.password = auth.password
      break
    case 'key':
      cfg.privateKey = readFileSync(auth.keyPath)
      if (auth.passphrase) cfg.passphrase = auth.passphrase
      break
    case 'agent':
      cfg.agent = resolveAgent()
      break
  }
}

/**
 * Owns all live ssh2 connections and their shell streams, keyed by sessionId.
 * The single place with network access (lives in the Electron main process).
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly callbacks: SessionCallbacks) {}

  /** Number of live sessions — used to assert no leaks after disconnects. */
  get size(): number {
    return this.sessions.size
  }

  /**
   * Opens an SSH connection and a PTY shell. Returns the new sessionId
   * immediately; connection progress is reported via the status/error/data
   * callbacks.
   */
  connect(req: ConnectRequest, size?: TerminalSize): string {
    const sessionId = randomUUID()
    const conn = new Client()
    this.sessions.set(sessionId, { conn })
    this.callbacks.onStatus(sessionId, 'connecting')

    conn.on('ready', () => {
      conn.shell(
        { term: 'xterm-256color', cols: size?.cols ?? 80, rows: size?.rows ?? 24 },
        (err, stream) => {
          if (err) {
            this.fail(sessionId, err.message)
            return
          }
          const session = this.sessions.get(sessionId)
          if (!session) {
            // Disconnected before the shell opened — close the orphan stream.
            stream.close()
            return
          }
          session.stream = stream
          this.callbacks.onStatus(sessionId, 'ready')

          // Server output is binary; forward raw bytes (never .toString()) so
          // multi-byte UTF-8 spanning chunk boundaries stays intact.
          stream.on('data', (chunk: Buffer) => {
            this.callbacks.onData(sessionId, new Uint8Array(chunk))
          })
          stream.stderr.on('data', (chunk: Buffer) => {
            this.callbacks.onData(sessionId, new Uint8Array(chunk))
          })
          stream.on('close', () => this.cleanup(sessionId, 'closed'))
        }
      )
    })

    conn.on('error', (err) => this.fail(sessionId, err.message))
    conn.on('close', () => this.cleanup(sessionId, 'closed'))

    // MFA / OTP challenges. Surfaced to the renderer via the injected callback;
    // requires tryKeyboard below for the server to offer this method.
    conn.on('keyboard-interactive', (name, instructions, _lang, prompts, finish) => {
      const session = this.sessions.get(sessionId)
      // Many OpenSSH servers implement password auth *via* keyboard-interactive
      // (PAM). When we have a password and the server asks a single hidden
      // prompt, answer it automatically once — so the user isn't re-prompted for
      // a password they already typed. Subsequent rounds (true MFA/OTP) still
      // surface to the renderer.
      if (
        session &&
        !session.kbdAutoUsed &&
        req.auth.kind === 'password' &&
        req.auth.password &&
        prompts.length === 1 &&
        prompts[0].echo === false
      ) {
        session.kbdAutoUsed = true
        finish([req.auth.password])
        return
      }
      this.callbacks
        .onKeyboardInteractive(
          sessionId,
          name,
          instructions,
          prompts.map((p) => ({ prompt: p.prompt, echo: p.echo !== false }))
        )
        .then(finish)
        .catch(() => finish([]))
    })

    try {
      const cfg: ConnectConfig = {
        host: req.host,
        port: req.port,
        username: req.username,
        // Allow MFA/OTP regardless of the primary method.
        tryKeyboard: true,
        // Delegate host-key trust to the injected policy (known-hosts + prompt).
        hostVerifier: (key: Buffer, verify: (valid: boolean) => void): void => {
          this.callbacks
            .verifyHostKey(sessionId, req.host, req.port, key)
            .then(verify)
            .catch(() => verify(false))
        },
        keepaliveInterval: 30_000,
        readyTimeout: 20_000
      }
      applyAuth(cfg, req.auth)
      conn.connect(cfg)
    } catch (err) {
      // e.g. private key file missing/unreadable.
      this.fail(sessionId, err instanceof Error ? err.message : String(err))
    }

    return sessionId
  }

  /** Writes user keystrokes to the shell stream. */
  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.stream?.write(data)
  }

  /** Resizes the remote PTY to match the terminal grid. */
  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.stream?.setWindow(rows, cols, 0, 0)
  }

  /** Requests a graceful disconnect; final cleanup happens on the 'close' event. */
  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.stream?.end()
    session.conn.end()
  }

  /** Disconnects every live session (e.g. on app quit). */
  disconnectAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.disconnect(sessionId)
    }
  }

  private fail(sessionId: string, message: string): void {
    if (!this.sessions.has(sessionId)) return
    this.callbacks.onError(sessionId, message)
    this.cleanup(sessionId, 'error')
  }

  private cleanup(sessionId: string, status: SessionStatus): void {
    const session = this.sessions.get(sessionId)
    if (!session) return // already cleaned up — avoids duplicate status events
    this.sessions.delete(sessionId)
    try {
      session.conn.end()
    } catch {
      /* connection already torn down */
    }
    this.callbacks.onStatus(sessionId, status)
  }
}
