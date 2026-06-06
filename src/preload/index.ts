import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  ConnectRequest,
  HostKeyPrompt,
  KbdInteractiveRequest,
  Profile,
  RecentConnection,
  SessionStatus,
  TerminalSize
} from '@shared/types'

type DataListener = (sessionId: string, data: Uint8Array) => void
type StatusListener = (sessionId: string, status: SessionStatus) => void
type ErrorListener = (sessionId: string, message: string) => void
type HostKeyListener = (prompt: HostKeyPrompt) => void
type KbdListener = (request: KbdInteractiveRequest) => void

/** Subscribe to a main->renderer channel; returns an unsubscribe function. */
function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]): void => {
    cb(...(args as A))
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

// The single, typed surface exposed to the renderer. Everything privileged
// (network, fs, secrets) stays in the main process behind these calls.
const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke(IPC.APP_VERSION),

  /** Open an SSH session + PTY shell. Resolves with the new sessionId. */
  connect: (req: ConnectRequest, size?: TerminalSize): Promise<string> =>
    ipcRenderer.invoke(IPC.SSH_CONNECT, req, size),

  /** Request a graceful disconnect of a session. */
  disconnect: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.SSH_DISCONNECT, sessionId),

  /** Send keystrokes to a session's shell. */
  sendInput: (sessionId: string, data: string): void =>
    ipcRenderer.send(IPC.SSH_INPUT, sessionId, data),

  /** Notify the remote PTY of a new terminal size. */
  resize: (sessionId: string, cols: number, rows: number): void =>
    ipcRenderer.send(IPC.SSH_RESIZE, sessionId, cols, rows),

  /** Stream of raw output bytes from a session. */
  onData: (cb: DataListener): (() => void) => on(IPC.SSH_DATA, cb),

  /** Session lifecycle status updates. */
  onStatus: (cb: StatusListener): (() => void) => on(IPC.SSH_STATUS, cb),

  /** Connection/auth error messages for a session. */
  onError: (cb: ErrorListener): (() => void) => on(IPC.SSH_ERROR, cb),

  /** A host key needs the user's trust decision. */
  onHostKeyPrompt: (cb: HostKeyListener): (() => void) => on(IPC.HOSTKEY_PROMPT, cb),

  /** Answer a host-key prompt for a session. */
  hostKeyDecision: (sessionId: string, accept: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.HOSTKEY_DECISION, sessionId, accept),

  /** A keyboard-interactive (MFA/OTP) challenge needs answers. */
  onKeyboardInteractive: (cb: KbdListener): (() => void) => on(IPC.KBD_PROMPT, cb),

  /** Provide one answer per prompt for a keyboard-interactive challenge. */
  answerKeyboardInteractive: (sessionId: string, answers: string[]): Promise<void> =>
    ipcRenderer.invoke(IPC.KBD_RESPONSE, sessionId, answers),

  /** Whether a password is saved for these credentials (no plaintext exposed). */
  hasPassword: (host: string, port: number, username: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.SECRET_HAS_PASSWORD, host, port, username),

  /** Forget a saved password. */
  forgetPassword: (host: string, port: number, username: string): Promise<void> =>
    ipcRenderer.invoke(IPC.SECRET_FORGET_PASSWORD, host, port, username),

  /** Whether a passphrase is saved for this key file. */
  hasPassphrase: (keyPath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.SECRET_HAS_PASSPHRASE, keyPath),

  /** Forget a saved key passphrase. */
  forgetPassphrase: (keyPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.SECRET_FORGET_PASSPHRASE, keyPath),

  /** List saved connection profiles. */
  listProfiles: (): Promise<Profile[]> => ipcRenderer.invoke(IPC.PROFILES_LIST),

  /** Create or update a profile; resolves with the stored profile. */
  saveProfile: (profile: Profile): Promise<Profile> =>
    ipcRenderer.invoke(IPC.PROFILES_SAVE, profile),

  /** Delete a profile by id. */
  deleteProfile: (id: string): Promise<void> => ipcRenderer.invoke(IPC.PROFILES_DELETE, id),

  /** List recent successful connections (most recent first). */
  listRecents: (): Promise<RecentConnection[]> => ipcRenderer.invoke(IPC.RECENTS_LIST),

  /** Open a native file picker for a private key; resolves with the path or null. */
  pickKeyFile: (): Promise<string | null> => ipcRenderer.invoke(IPC.KEY_PICK),

  /** Read the system clipboard as text. */
  clipboardRead: (): Promise<string> => ipcRenderer.invoke(IPC.CLIPBOARD_READ),

  /** Write text to the system clipboard. */
  clipboardWrite: (text: string): Promise<void> => ipcRenderer.invoke(IPC.CLIPBOARD_WRITE, text)
}

export type SshApi = typeof api

contextBridge.exposeInMainWorld('ssh', api)
