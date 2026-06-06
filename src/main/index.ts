import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import icon from '../../resources/icon.png?asset'
import { IPC } from '@shared/ipc'
import type {
  ConnectRequest,
  HostKeyPrompt,
  KbdInteractiveRequest,
  KbdPrompt,
  Profile,
  TerminalSize
} from '@shared/types'
import { SessionManager } from './session-manager'
import { KnownHostsStore } from './known-hosts'
import { SecretStore } from './secrets'
import { ProfileStore } from './profiles'

let mainWindow: BrowserWindow | null = null

// Created on app-ready (paths/safeStorage depend on the app being initialized).
let knownHosts: KnownHostsStore
let secrets: SecretStore
let profiles: ProfileStore
let sessions: SessionManager

// Pending host-key trust decisions awaiting a renderer response, by sessionId.
const pendingHostKey = new Map<string, (accepted: boolean) => void>()
// Pending keyboard-interactive answers awaiting a renderer response, by sessionId.
const pendingKbd = new Map<string, (answers: string[]) => void>()
// Secret to persist iff the connection authenticates (reaches 'ready'), by sessionId.
const pendingSecretSaves = new Map<string, { id: string; value: string }>()
// Connection target recorded into "recents" once the session is ready, by sessionId.
const pendingRecents = new Map<string, ConnectRequest>()

/** Stable id for a stored password: pw:user@host:port. */
function passwordId(host: string, port: number, username: string): string {
  return `pw:${username}@${host}:${port}`
}
/** Stable id for a stored key passphrase, keyed by key path. */
function passphraseId(keyPath: string): string {
  return `pp:${keyPath}`
}

/** Send an event to the renderer if the window is still alive. */
function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

/**
 * Host-key trust policy: silent on a known match, otherwise ask the renderer and
 * (on accept) persist the key. Runs in the main process; the manager only calls it.
 */
async function verifyHostKey(
  sessionId: string,
  host: string,
  port: number,
  key: Buffer
): Promise<boolean> {
  const result = knownHosts.check(host, port, key)
  if (result.status === 'match') return true

  const prompt: HostKeyPrompt = {
    sessionId,
    host,
    port,
    fingerprint: result.fingerprint,
    status: result.status,
    knownFingerprint: result.status === 'changed' ? result.knownFingerprint : undefined
  }

  const accepted = await new Promise<boolean>((resolve) => {
    pendingHostKey.set(sessionId, resolve)
    sendToRenderer(IPC.HOSTKEY_PROMPT, prompt)
  })

  if (accepted) knownHosts.trust(host, port, key)
  return accepted
}

/** Forward a keyboard-interactive challenge to the renderer and await answers. */
function onKeyboardInteractive(
  sessionId: string,
  name: string,
  instructions: string,
  prompts: KbdPrompt[]
): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    pendingKbd.set(sessionId, resolve)
    const req: KbdInteractiveRequest = { sessionId, name, instructions, prompts }
    sendToRenderer(IPC.KBD_PROMPT, req)
  })
}

function buildSessionManager(): SessionManager {
  return new SessionManager({
    onData: (sessionId, data) => sendToRenderer(IPC.SSH_DATA, sessionId, data),
    onError: (sessionId, message) => sendToRenderer(IPC.SSH_ERROR, sessionId, message),
    verifyHostKey,
    onKeyboardInteractive,
    onStatus: (sessionId, status) => {
      if (status === 'ready') {
        // Auth succeeded — persist the secret (if requested) and record the recent.
        const pending = pendingSecretSaves.get(sessionId)
        if (pending) {
          secrets.set(pending.id, pending.value)
          pendingSecretSaves.delete(sessionId)
        }
        const recent = pendingRecents.get(sessionId)
        if (recent) {
          profiles.recordRecent(recent.host, recent.port, recent.username, recent.auth)
          pendingRecents.delete(sessionId)
        }
      } else if (status === 'closed' || status === 'error') {
        pendingSecretSaves.delete(sessionId)
        pendingRecents.delete(sessionId)
        // Abort any prompt still waiting for this session.
        const hk = pendingHostKey.get(sessionId)
        if (hk) {
          pendingHostKey.delete(sessionId)
          hk(false)
        }
        const kbd = pendingKbd.get(sessionId)
        if (kbd) {
          pendingKbd.delete(sessionId)
          kbd([])
        }
        if (!app.isPackaged) console.log(`[main] live sessions: ${sessions.size} (${status})`)
      }
      sendToRenderer(IPC.SSH_STATUS, sessionId, status)
    }
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 640,
    minHeight: 400,
    show: false,
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Security hardening (see plan §3). Do not relax these.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // In development (running unpackaged), surface renderer-side logs and crashes in
  // the main process stdout so they're visible without opening DevTools.
  if (!app.isPackaged) {
    win.webContents.on('console-message', (details) => {
      console.log(
        `[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`
      )
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error('[renderer gone]', details.reason, details.exitCode)
    })
  }

  // Open external links in the OS browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // electron-vite injects the renderer dev server URL in development;
  // in production we load the built HTML file from disk.
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.APP_VERSION, () => app.getVersion())

  ipcMain.handle(
    IPC.SSH_CONNECT,
    (_event: IpcMainInvokeEvent, req: ConnectRequest, size?: TerminalSize) => {
      // If a secret wasn't supplied but one is saved, inject it (the decrypted
      // value never leaves the main process).
      if (req.auth.kind === 'password' && !req.auth.password) {
        const saved = secrets.get(passwordId(req.host, req.port, req.username))
        if (saved) req.auth = { kind: 'password', password: saved }
      } else if (req.auth.kind === 'key' && !req.auth.passphrase) {
        const saved = secrets.get(passphraseId(req.auth.keyPath))
        if (saved) req.auth = { ...req.auth, passphrase: saved }
      }

      const sessionId = sessions.connect(req, size)

      if (req.saveSecret) {
        if (req.auth.kind === 'password' && req.auth.password) {
          pendingSecretSaves.set(sessionId, {
            id: passwordId(req.host, req.port, req.username),
            value: req.auth.password
          })
        } else if (req.auth.kind === 'key' && req.auth.passphrase) {
          pendingSecretSaves.set(sessionId, {
            id: passphraseId(req.auth.keyPath),
            value: req.auth.passphrase
          })
        }
      }
      pendingRecents.set(sessionId, req)
      if (!app.isPackaged) console.log(`[main] live sessions: ${sessions.size} (connect)`)
      return sessionId
    }
  )

  ipcMain.handle(IPC.SSH_DISCONNECT, (_event: IpcMainInvokeEvent, sessionId: string) => {
    sessions.disconnect(sessionId)
  })

  ipcMain.handle(
    IPC.HOSTKEY_DECISION,
    (_event: IpcMainInvokeEvent, sessionId: string, accept: boolean) => {
      const resolve = pendingHostKey.get(sessionId)
      if (resolve) {
        pendingHostKey.delete(sessionId)
        resolve(accept)
      }
    }
  )

  ipcMain.handle(
    IPC.KBD_RESPONSE,
    (_event: IpcMainInvokeEvent, sessionId: string, answers: string[]) => {
      const resolve = pendingKbd.get(sessionId)
      if (resolve) {
        pendingKbd.delete(sessionId)
        resolve(Array.isArray(answers) ? answers : [])
      }
    }
  )

  // --- Secrets (presence/forget only; plaintext never crosses the bridge) ---
  ipcMain.handle(
    IPC.SECRET_HAS_PASSWORD,
    (_e: IpcMainInvokeEvent, host: string, port: number, username: string) =>
      secrets.has(passwordId(host, port, username))
  )
  ipcMain.handle(
    IPC.SECRET_FORGET_PASSWORD,
    (_e: IpcMainInvokeEvent, host: string, port: number, username: string) =>
      secrets.delete(passwordId(host, port, username))
  )
  ipcMain.handle(IPC.SECRET_HAS_PASSPHRASE, (_e: IpcMainInvokeEvent, keyPath: string) =>
    secrets.has(passphraseId(keyPath))
  )
  ipcMain.handle(IPC.SECRET_FORGET_PASSPHRASE, (_e: IpcMainInvokeEvent, keyPath: string) =>
    secrets.delete(passphraseId(keyPath))
  )

  // --- Profiles + recents ---
  ipcMain.handle(IPC.PROFILES_LIST, () => profiles.list())
  ipcMain.handle(IPC.PROFILES_SAVE, (_e: IpcMainInvokeEvent, profile: Profile) =>
    profiles.save(profile)
  )
  ipcMain.handle(IPC.PROFILES_DELETE, (_e: IpcMainInvokeEvent, id: string) => profiles.delete(id))
  ipcMain.handle(IPC.RECENTS_LIST, () => profiles.recents())

  // --- Misc helpers ---
  ipcMain.handle(IPC.KEY_PICK, async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Select a private key file',
      properties: ['openFile'],
      filters: [
        { name: 'Private keys', extensions: ['pem', 'key', 'ppk', 'rsa', 'ed25519'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.CLIPBOARD_READ, () => clipboard.readText())
  ipcMain.handle(IPC.CLIPBOARD_WRITE, (_e: IpcMainInvokeEvent, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.on(IPC.SSH_INPUT, (_event: IpcMainEvent, sessionId: string, data: string) => {
    sessions.write(sessionId, data)
  })

  ipcMain.on(
    IPC.SSH_RESIZE,
    (_event: IpcMainEvent, sessionId: string, cols: number, rows: number) => {
      sessions.resize(sessionId, cols, rows)
    }
  )
}

app.whenReady().then(() => {
  const userData = app.getPath('userData')
  knownHosts = new KnownHostsStore(join(userData, 'known_hosts.json'))
  secrets = new SecretStore(join(userData, 'secrets.json'))
  profiles = new ProfileStore(join(userData, 'profiles.json'))
  sessions = buildSessionManager()

  if (!app.isPackaged) {
    console.log(`[main] userData: ${userData}`)
    console.log(`[main] safeStorage available: ${secrets.available}`)
  }

  registerIpcHandlers()
  mainWindow = createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

// Tear down all SSH connections before quitting so none are leaked.
app.on('before-quit', () => sessions?.disconnectAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
