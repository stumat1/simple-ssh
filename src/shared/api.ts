// The contract for the privileged API exposed to the renderer as
// `window.ssh`, implemented over Tauri IPC in src/renderer/ssh-api.ts.
import type {
  ConnectRequest,
  HostKeyPrompt,
  KbdInteractiveRequest,
  Profile,
  RecentConnection,
  SessionStatus,
  TerminalSize
} from './types'

export type DataListener = (sessionId: string, data: Uint8Array) => void
export type StatusListener = (sessionId: string, status: SessionStatus) => void
export type ErrorListener = (sessionId: string, message: string) => void
export type HostKeyListener = (prompt: HostKeyPrompt) => void
export type KbdListener = (request: KbdInteractiveRequest) => void

export interface SshApi {
  getVersion(): Promise<string>

  /** Open an SSH session + PTY shell. Resolves with the new sessionId. */
  connect(req: ConnectRequest, size?: TerminalSize): Promise<string>

  /** Request a graceful disconnect of a session. */
  disconnect(sessionId: string): Promise<void>

  /** Send keystrokes to a session's shell. */
  sendInput(sessionId: string, data: string): void

  /** Notify the remote PTY of a new terminal size. */
  resize(sessionId: string, cols: number, rows: number): void

  /** Stream of raw output bytes from a session. Returns an unsubscribe fn. */
  onData(cb: DataListener): () => void

  /** Session lifecycle status updates. */
  onStatus(cb: StatusListener): () => void

  /** Connection/auth error messages for a session. */
  onError(cb: ErrorListener): () => void

  /** A host key needs the user's trust decision. */
  onHostKeyPrompt(cb: HostKeyListener): () => void

  /** Answer a host-key prompt for a session. */
  hostKeyDecision(sessionId: string, accept: boolean): Promise<void>

  /** A keyboard-interactive (MFA/OTP) challenge needs answers. */
  onKeyboardInteractive(cb: KbdListener): () => void

  /** Provide one answer per prompt for a keyboard-interactive challenge. */
  answerKeyboardInteractive(sessionId: string, answers: string[]): Promise<void>

  /** Whether a password is saved for these credentials (no plaintext exposed). */
  hasPassword(host: string, port: number, username: string): Promise<boolean>

  /** Forget a saved password. */
  forgetPassword(host: string, port: number, username: string): Promise<void>

  /** Whether a passphrase is saved for this key file. */
  hasPassphrase(keyPath: string): Promise<boolean>

  /** Forget a saved key passphrase. */
  forgetPassphrase(keyPath: string): Promise<void>

  /** List saved connection profiles. */
  listProfiles(): Promise<Profile[]>

  /** Create or update a profile; resolves with the stored profile. */
  saveProfile(profile: Profile): Promise<Profile>

  /** Delete a profile by id. */
  deleteProfile(id: string): Promise<void>

  /** List recent successful connections (most recent first). */
  listRecents(): Promise<RecentConnection[]>

  /** Open a native file picker for a private key; resolves with the path or null. */
  pickKeyFile(): Promise<string | null>

  /** Read the system clipboard as text. */
  clipboardRead(): Promise<string>

  /** Write text to the system clipboard. */
  clipboardWrite(text: string): Promise<void>
}
