# Simple SSH

A lightweight, secure SSH client for Windows — built with Electron, [ssh2](https://github.com/mscdex/ssh2), and [xterm.js](https://xtermjs.org/).

Simple SSH gives you a fast, tabbed terminal for connecting to remote hosts, with saved
connection profiles, OS-encrypted secret storage, and host-key verification — without the
weight of a full terminal suite.

## Features

- **Tabbed sessions** — open and switch between multiple SSH connections in one window.
- **Connection profiles** — save hosts, ports, usernames, and auth method for one-click reconnect.
- **Recent connections** — recently used targets are recorded automatically for quick access.
- **Multiple auth methods** — password, private key (with passphrase), and SSH agent.
- **Keyboard-interactive auth** — supports MFA/OTP challenges.
- **Encrypted secret storage** — passwords and key passphrases are encrypted with the OS
  keystore (Windows DPAPI via Electron `safeStorage`); plaintext is never written to disk.
- **Host-key verification** — unknown and changed host keys prompt for an explicit trust
  decision (TOFU), with SHA-256 fingerprints.
- **Terminal niceties** — in-terminal search, adjustable font size, and a light/dark theme toggle.

## Requirements

- Windows 10/11 (x64)
- [Node.js](https://nodejs.org/) 18+ and npm (for building from source)

## Getting started (development)

```bash
npm install
npm run dev
```

`npm run dev` launches the app via [electron-vite](https://electron-vite.org/) with hot reload.

> **Note:** If you launch the app from a tooling environment that sets
> `ELECTRON_RUN_AS_NODE`, clear that variable first or the GUI won't start.

## Building the installer

```bash
npm run package
```

This typechecks, bundles to `out/`, and runs [electron-builder](https://www.electron.build/)
to produce a Windows NSIS installer in `dist/`:

```
dist/
├── Simple SSH-<version>-setup.exe          # the installer
├── Simple SSH-<version>-setup.exe.blockmap
└── win-unpacked/                            # unpacked app (simple-ssh.exe) for quick testing
```

See [PACKAGING.md](PACKAGING.md) for build gotchas (winCodeSign symlink extraction) and
code-signing setup.

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Run the app in development with hot reload |
| `npm run build` | Typecheck and bundle to `out/` |
| `npm run package` | Build and produce the Windows installer in `dist/` |
| `npm run typecheck` | Typecheck the main/preload and renderer projects |
| `npm run lint` | Run ESLint |
| `npm run format` | Format sources with Prettier |

## Project structure

```
src/
├── main/        Electron main process — session manager, profiles, secrets, known-hosts
├── preload/     Context-isolated bridge exposing a typed API to the renderer
├── renderer/    UI — tabs, terminal, connect form, host-key & MFA dialogs
└── shared/      Types and IPC channel definitions shared across processes
```

## Security

- The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
- A strict Content-Security-Policy restricts the renderer to local content.
- Secrets are encrypted at rest via the OS keystore and are only persisted on a successful
  connection (and only when you opt in).
- Host keys are verified on every connection; changes are surfaced loudly.

## Author

stumat1 <stumat1@mailbox.org>

## License

MIT
