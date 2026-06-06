# Electron SSH Client — Project Plan

## Overview

A lightweight Windows SSH client built with Electron, `ssh2`, and `xterm.js`.
Target: a working interactive terminal with multi-session tab support.

---

## Tech Stack

| Role | Library/Tool |
|---|---|
| App shell | [Electron](https://www.electronjs.org/) |
| SSH protocol | [ssh2](https://github.com/mscdex/ssh2) |
| Terminal emulator | [xterm.js](https://xtermjs.org/) |
| Xterm fit addon | `@xterm/addon-fit` |
| UI styling | Plain CSS or [Tailwind](https://tailwindcss.com/) |
| Packaging | [electron-builder](https://www.electron.build/) |

---

## Project Structure

```
electron-ssh/
├── package.json
├── main.js              # Electron main process — owns SSH connections
├── preload.js           # Context bridge (IPC between main & renderer)
├── renderer/
│   ├── index.html       # App shell — connection form + tab bar + terminal div
│   ├── renderer.js      # UI logic — xterm.js init, tab management, IPC calls
│   └── styles.css       # App styling
└── assets/
    └── icon.png         # App icon (for packaging)
```

---

## Architecture

```
┌─────────────────────────────────────┐
│  Renderer Process                   │
│  ┌─────────────┐  ┌──────────────┐  │
│  │ Connect Form│  │  xterm.js    │  │
│  │ (host/user/ │  │  Terminal    │  │
│  │  password)  │  │  Display     │  │
│  └──────┬──────┘  └──────┬───────┘  │
│         │  IPC            │  IPC     │
└─────────┼─────────────────┼──────────┘
          │                 │
┌─────────▼─────────────────▼──────────┐
│  Main Process (main.js)              │
│  ┌───────────────────────────────┐   │
│  │  ssh2 Client                  │   │
│  │  - Manages connections map    │   │
│  │  - Opens PTY shell stream     │   │
│  │  - Pipes data ↔ renderer      │   │
│  └───────────────────────────────┘   │
└──────────────────────────────────────┘
```

**IPC channels:**
- `ssh:connect` — renderer sends credentials → main opens SSH session
- `ssh:data` — main sends terminal output → renderer feeds to xterm.js
- `ssh:input` — renderer sends keystrokes → main writes to SSH stream
- `ssh:resize` — renderer sends terminal dimensions → main resizes PTY
- `ssh:disconnect` — renderer requests disconnect

---

## Implementation Phases

### Phase 1 — Scaffold & Hello World
- [ ] `npm init` and install dependencies
- [ ] Basic Electron window opens (`main.js` + `index.html`)
- [ ] Preload/context bridge wired up
- [ ] xterm.js renders in the window (even just a static prompt)

```bash
npm install electron ssh2 @xterm/xterm @xterm/addon-fit
npm install --save-dev electron-builder
```

---

### Phase 2 — SSH Connection
- [ ] Connection form UI (host, port, username, password fields)
- [ ] `ssh:connect` IPC handler in `main.js` using `ssh2`
- [ ] Open a PTY shell (`conn.shell()` with `{ term: 'xterm-color' }`)
- [ ] Pipe SSH stream data back to renderer via `ssh:data`
- [ ] Show connection errors in the UI

**Key ssh2 snippet:**
```javascript
conn.on('ready', () => {
  conn.shell({ term: 'xterm-color', rows: 24, cols: 80 }, (err, stream) => {
    stream.on('data', (data) => {
      win.webContents.send('ssh:data', sessionId, data.toString());
    });
  });
});
conn.connect({ host, port, username, password });
```

---

### Phase 3 — Live Terminal
- [ ] xterm.js instance created in renderer
- [ ] `ssh:data` events feed into `terminal.write()`
- [ ] Key input from xterm captured and sent via `ssh:input`
- [ ] `@xterm/addon-fit` used to fit terminal to window size
- [ ] Resize events trigger `ssh:resize` → ssh2 PTY resize

**Key xterm snippet:**
```javascript
const terminal = new Terminal({ cursorBlink: true });
terminal.open(document.getElementById('terminal'));
terminal.onData((data) => ipcRenderer.send('ssh:input', sessionId, data));
window.electronAPI.onSshData((sessionId, data) => terminal.write(data));
```

---

### Phase 4 — Tab Support (Multi-session)
- [ ] Tab bar UI with "+" button to open new connections
- [ ] Each tab has its own `sessionId`, xterm instance, and ssh2 connection
- [ ] Switching tabs shows/hides the correct terminal div
- [ ] Close tab triggers `ssh:disconnect` for that session
- [ ] Main process stores connections in a `Map<sessionId, stream>`

---

### Phase 5 — Polish & UX
- [ ] SSH key auth (load `.pem` / `id_rsa` via file picker)
- [ ] Remember recent connections (store in `localStorage` or a JSON file)
- [ ] Copy/paste support in terminal (`Ctrl+Shift+C/V`)
- [ ] Custom font size / theme toggle (xterm.js themes are easy)
- [ ] Keyboard shortcut: `Ctrl+T` new tab, `Ctrl+W` close tab
- [ ] Status bar showing connection state

---

### Phase 6 — Packaging
- [ ] Add `electron-builder` config to `package.json`
- [ ] Build a Windows `.exe` installer
- [ ] Test on a clean machine

```json
"build": {
  "appId": "com.yourname.ssh-client",
  "win": {
    "target": "nsis"
  }
}
```

---

## Key Gotchas to Watch For

1. **Context isolation** — Electron's security model means you need `preload.js` and `contextBridge` to expose IPC to the renderer. Don't disable `contextIsolation`.
2. **PTY dimensions** — Pass real `rows`/`cols` to `conn.shell()` from the start, and update on resize, or arrow keys and vim will behave strangely.
3. **Session IDs** — When you add tabs, every IPC message needs a `sessionId` so main.js knows which SSH stream to write to.
4. **Stream cleanup** — When a tab closes, make sure to `.end()` the SSH stream and `.destroy()` the connection, or you'll leak connections.
5. **ssh2 version** — Use `ssh2` v1.x (not v0.x). The API changed significantly.

---

## Suggested Development Order

```
Phase 1 → Phase 2 → Phase 3   (you now have a working SSH terminal)
         ↓
Phase 4                         (add tabs — nice to have early)
         ↓
Phase 5 → Phase 6               (polish, then ship)
```

Stop after Phase 3 and you have something genuinely usable.

---

## Useful References

- [ssh2 docs & examples](https://github.com/mscdex/ssh2#examples)
- [xterm.js API](https://xtermjs.org/docs/)
- [Electron IPC guide](https://www.electronjs.org/docs/latest/tutorial/ipc)
- [electron-builder docs](https://www.electron.build/configuration/configuration)