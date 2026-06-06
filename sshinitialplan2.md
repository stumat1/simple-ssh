# Windows SSH Client — Detailed Build Plan (v2)

A lightweight but secure Windows SSH client: Electron shell, `ssh2` for the protocol,
`xterm.js` for the terminal, TypeScript throughout, bundled with electron-vite.
Goal: a genuinely usable multi-tab interactive terminal with safe credential handling.

> This is the working build plan, expanded from `sshinitialplan.md`. Key changes from v1:
> security is first-class (host-key verification + OS-encrypted secrets), a UTF-8 IPC
> correctness bug is fixed (carry bytes, not strings), and tooling is pinned (TypeScript +
> electron-vite).

## 1. Decisions & rationale

| Decision | Choice | Why |
|---|---|---|
| Language | **TypeScript** | Type the IPC contract + ssh2 config + session state; kills a class of messaging bugs |
| Bundler | **electron-vite** | Purpose-built for Electron; bundles main/preload/renderer, handles xterm ESM, fast HMR |
| Terminal | **@xterm/xterm** + addons | `addon-fit`, `addon-webgl` (perf), `addon-web-links`, `addon-unicode11`, `addon-search` |
| SSH | **ssh2 v1.x** | Pure-JS, supports password/publickey/agent/keyboard-interactive + `hostVerifier` |
| Secrets | **Electron `safeStorage`** | OS-backed encryption (Windows DPAPI). Never plaintext on disk |
| Packaging | **electron-builder** (NSIS) | Windows installer; note code-signing to avoid SmartScreen |

Scope = core usable client. SFTP, port forwarding, jump hosts, and session logging are
explicitly **out of scope** for now (see §10) but the architecture leaves room for them.

## 2. Architecture

Three Electron contexts, strict separation:

- **Main process** — owns all `ssh2` Client objects and shell streams. Only place with Node
  access to network, filesystem, and `safeStorage`. Holds a `SessionManager`.
- **Preload** — `contextBridge` exposes a small, typed `window.ssh` API. `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`.
- **Renderer** — UI only: connection form, tab bar, xterm instances. No Node, no secrets.

```
Renderer (UI + xterm)  ──invoke/send──►  Preload (contextBridge)  ──ipc──►  Main (SessionManager + ssh2)
        ◄──────────── events (data/status/error) ────────────────────────────────────┘
```

### IPC contract (typed, in a shared `src/shared/ipc.ts`)

Request/response via `ipcRenderer.invoke` / `ipcMain.handle`:
- `ssh:connect(profile) → { sessionId }` — opens connection + PTY shell
- `ssh:disconnect(sessionId) → void`
- `profiles:list / save / delete` — saved connection profiles
- `secret:store / get / delete` — wraps `safeStorage`
- `hostkey:decision(sessionId, accept)` — user's answer to an unknown/changed host key

Streaming via `send` / `on` (each message carries `sessionId`):
- renderer→main: `ssh:input` (keystrokes), `ssh:resize` (cols/rows)
- main→renderer: `ssh:data` (**`Uint8Array`, not string**), `ssh:status`
  (`connecting|ready|closed|error`), `ssh:error`, `ssh:banner`,
  `ssh:hostkey-prompt`, `ssh:keyboard-interactive`

> **Critical fix vs v1:** carry raw bytes over IPC and call `terminal.write(uint8array)`.
> `Buffer.toString()` on arbitrary stream chunks splits multi-byte UTF-8 → garbled output.

## 3. Security model (first-class, not Phase 5)

1. **Host-key verification.** Implement ssh2's `hostVerifier`. Maintain a known-hosts store
   (parse/append OpenSSH `~/.ssh/known_hosts`, or an app-managed JSON keyed by `host:port`).
   - Unknown host → prompt user (show fingerprint SHA256) → on accept, persist.
   - **Changed** key → loud warning (possible MITM); require explicit confirmation.
2. **Credential storage.** Passwords/passphrases via `safeStorage.encryptString` only; store
   ciphertext in the profile file. Never `localStorage`. Offer "don't save" as default.
3. **Renderer lockdown.** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
   a restrictive **CSP** meta tag, and no remote content loaded.
4. **Key files.** Read private keys in main only; support passphrase-protected keys
   (`privateKey` + `passphrase`).

## 4. Authentication methods (ssh2)

- **Password** (Phase 2 baseline).
- **Public key** — `.pem` / `id_rsa` / `id_ed25519` via file picker; handle passphrase.
- **SSH agent** — Windows OpenSSH agent pipe `\\.\pipe\openssh-ssh-agent`, or `'pageant'`.
  Use ssh2's `agent` option (ssh2 picks PageantAgent/OpenSSHAgent automatically).
- **keyboard-interactive** — handle the `keyboard-interactive` event for MFA/OTP prompts;
  surface prompts to the renderer via `ssh:keyboard-interactive`.

## 5. Project structure

```
ssh-terminal/
├── package.json
├── tsconfig.json
├── electron.vite.config.ts
├── electron-builder.yml
├── src/
│   ├── main/
│   │   ├── index.ts            # app lifecycle, BrowserWindow, register IPC handlers
│   │   ├── session-manager.ts  # Map<sessionId, {conn, stream}>; connect/resize/write/close
│   │   ├── known-hosts.ts      # host-key load/verify/persist
│   │   ├── secrets.ts          # safeStorage wrapper
│   │   └── profiles.ts         # saved-connection CRUD (app userData JSON)
│   ├── preload/
│   │   └── index.ts            # contextBridge → window.ssh (typed)
│   ├── renderer/
│   │   ├── index.html          # CSP + #app
│   │   ├── main.ts             # bootstrap UI
│   │   ├── terminal.ts         # xterm factory + addons + fit/resize wiring
│   │   ├── tabs.ts             # tab bar + per-tab session/terminal lifecycle
│   │   ├── connect-form.ts     # host/port/user/auth UI
│   │   └── styles.css
│   └── shared/
│       ├── ipc.ts              # channel names + payload types
│       └── types.ts            # Profile, SessionStatus, AuthMethod, etc.
└── resources/icon.ico
```

## 6. Data model (`src/shared/types.ts`)

```ts
type AuthMethod =
  | { kind: 'password'; password?: string }            // password may be loaded from safeStorage
  | { kind: 'key'; keyPath: string; passphrase?: string }
  | { kind: 'agent' };

interface Profile {
  id: string; name: string;
  host: string; port: number; username: string;
  auth: AuthMethod;
  savePassword: boolean;
}
```
Profiles persisted as JSON in `app.getPath('userData')`; secrets stored separately as
safeStorage ciphertext referenced by profile id.

## 7. Implementation phases (each ends with explicit acceptance criteria)

### Phase 0 — Tooling baseline
- `npm create @quick-start/electron` (electron-vite TS template) or manual scaffold.
- Install: `ssh2`, `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`,
  `@xterm/addon-web-links`, `@xterm/addon-unicode11`, `@xterm/addon-search`;
  dev: `electron`, `electron-vite`, `electron-builder`, `typescript`, `@types/ssh2`,
  ESLint + Prettier.
- **Accept:** `npm run dev` opens a window with HMR; `tsc --noEmit` clean.

### Phase 1 — Shell + static terminal
- BrowserWindow with the secure webPreferences above + CSP.
- Preload exposes a stub `window.ssh`. xterm renders with fit + webgl addons; resizes with window.
- **Accept:** Terminal visible, fills window, echoes typed chars locally (loopback), no console
  security warnings.

### Phase 2 — Single SSH session (password)
- `connect-form` collects host/port/user/password → `ssh:connect`.
- `SessionManager.connect`: create ssh2 Client, **wire `hostVerifier`** (Phase 3 store, but
  stub-accept with fingerprint log first), on `ready` open `conn.shell({ term:'xterm-256color',
  cols, rows })`.
- Stream data → `ssh:data` as `Uint8Array`; renderer `terminal.write()`.
- `terminal.onData` → `ssh:input` → `stream.write`. `ssh:resize` → `stream.setWindow(rows,cols)`.
- Surface `ssh:status` / `ssh:error` in a status bar.
- **Accept:** Connect to a real host, run `vim`/`htop`/`top`, arrow keys + resize behave;
  UTF-8 (e.g. `echo €✓中`) renders correctly; disconnect cleans up (no leaked connections).

### Phase 3 — Host-key verification + secrets
- Implement `known-hosts.ts` + `secrets.ts`.
- `hostVerifier` → prompt on unknown (show SHA256 fingerprint), hard-warn on changed.
- "Save password" path uses `safeStorage`.
- **Accept:** First connect prompts to trust key; second connect is silent; tampering with the
  stored key triggers the change warning; saved password survives app restart and is ciphertext
  on disk.

### Phase 4 — Multi-session tabs
- Tab bar with `+`; each tab = `{ sessionId, Terminal, addons }`. `SessionManager` keyed by id.
- Switch tabs shows/hides terminals (call `fit()` on show); close tab → `ssh:disconnect` +
  dispose terminal.
- **Accept:** ≥3 concurrent sessions to different hosts, independent I/O, closing one doesn't
  affect others, no leaks (verify connection map shrinks on close).

### Phase 5 — Auth breadth + profiles + UX
- Key-file auth (with passphrase), SSH-agent auth, keyboard-interactive prompts.
- Saved profiles (list/create/edit/delete) + "recent connections".
- Copy/paste (`Ctrl+Shift+C/V`), font-size control, theme toggle, `addon-search` (`Ctrl+Shift+F`).
- Shortcuts: `Ctrl+T` new tab, `Ctrl+W` close tab. `keepaliveInterval` to hold idle sessions.
- **Accept:** Connect via agent and via passphrase-protected key; an MFA host prompts correctly;
  a saved profile one-click reconnects.

### Phase 6 — Packaging
- `electron-builder.yml` → NSIS Windows installer; app icon.
- Note: **code-sign** the exe (else SmartScreen warns); document the unsigned-for-dev caveat.
- **Accept:** Installer produced; installs + runs on a clean Windows VM; a real SSH session works.

## 8. Key gotchas (revised from v1)

1. **Bytes over IPC**, not strings — see §2. Biggest correctness item.
2. **PTY dimensions** — pass real cols/rows to `shell()` and call `stream.setWindow` on every
   resize (debounced) or full-screen apps misrender.
3. **Backpressure** — high-volume output (`cat bigfile`) can flood IPC. Respect ssh2 stream
   `pause()/resume()` and avoid per-byte IPC chatter; batch if needed.
4. **xterm ESM** — import via electron-vite; don't hand-wire `<script>` tags.
5. **Stream cleanup** — on tab close, `stream.end()` + `conn.end()` and delete from the map.
6. **ssh2 v1.x** API (not v0.x). Use `@types/ssh2`.
7. **webgl addon** — guard for context-loss; fall back to canvas/DOM renderer if unavailable.
8. **safeStorage availability** — check `safeStorage.isEncryptionAvailable()`; degrade to
   "don't persist secrets" rather than writing plaintext.

## 9. Verification / testing strategy

- **Manual smoke (primary):** real SSH host per phase using the Accept criteria above; test
  vim/htop/resize/UTF-8/copy-paste.
- **Local test server:** a Docker `linuxserver/openssh-server` (or WSL `sshd`) for repeatable
  password + key + known-hosts-change testing.
- **Unit tests (vitest):** pure logic — known_hosts parse/compare, profile CRUD, IPC payload
  type guards, secrets wrapper (mock safeStorage).
- **Static:** `tsc --noEmit`, ESLint, and Electron's own console security-warning check (must
  be clean).

## 10. Out of scope (future roadmap)

SFTP file browser/transfer (ssh2 `sftp`), local/remote/dynamic (SOCKS) port forwarding,
ProxyJump/bastion chaining, session/output logging to file, split panes, broadcast-to-all-tabs.
Architecture (SessionManager + typed IPC) is designed to accommodate these later.

## 11. References

- ssh2 (auth methods, `hostVerifier`, agent): https://github.com/mscdex/ssh2
- xterm.js docs: https://xtermjs.org/docs/
- electron-vite: https://electron-vite.org/
- Electron security + `safeStorage`: https://www.electronjs.org/docs/latest/tutorial/security
- electron-builder: https://www.electron.build/
