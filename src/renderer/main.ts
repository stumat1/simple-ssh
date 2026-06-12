import './styles.css'
import { tauriSshApi } from './ssh-api'
import { TabManager } from './tabs'
import { setupHostKeyDialog } from './host-key-dialog'
import { setupKbdDialog } from './kbd-dialog'
import { setupSettingsDialog } from './settings-dialog'
import { setupForwardsPanel } from './forwards-panel'
import { showContextMenu, type ContextMenuEntry } from './context-menu'
import { settings } from './settings'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing element #${id}`)
  return node as T
}

window.ssh = tauriSshApi

function bootstrap(): void {
  // Suppress the WebView2 default context menu everywhere; components that want
  // a menu (e.g. the terminal) attach their own contextmenu handlers.
  window.addEventListener('contextmenu', (e) => e.preventDefault())

  // App-level shortcuts shared by the window listener and each terminal so they
  // work whether the focus is on the terminal or the connect form.
  function appShortcut(e: KeyboardEvent): boolean {
    if (!e.ctrlKey || e.altKey || e.metaKey) return false
    switch (e.code) {
      case 'KeyT':
        if (e.shiftKey) return false
        tabs.newTab()
        return true
      case 'KeyW':
        if (e.shiftKey) return false
        tabs.closeActive()
        return true
      case 'KeyD':
        if (!e.shiftKey) return false
        tabs.duplicateActive()
        return true
      case 'Equal':
      case 'NumpadAdd':
        settings.bumpFont(1)
        return true
      case 'Minus':
      case 'NumpadSubtract':
        settings.bumpFont(-1)
        return true
      case 'Digit0':
      case 'Numpad0':
        settings.resetFont()
        return true
      default:
        return false
    }
  }

  const tabs = new TabManager(el('tabbar'), el('content'), el('new-tab'), el('status'), {
    getSettings: () => settings.get(),
    onAppShortcut: appShortcut
  })

  // Route SSH stream events to the owning tab by sessionId.
  window.ssh.onData((sid, data) => tabs.tabForSession(sid)?.write(data))
  window.ssh.onStatus((sid, status) => tabs.tabForSession(sid)?.setStatus(status))
  window.ssh.onError((sid, message) => tabs.tabForSession(sid)?.setError(message))
  window.ssh.onForwardStatus((event) => tabs.tabForSession(event.sessionId)?.updateForward(event))

  // Blocking auth modals (host-key trust, keyboard-interactive). Serialize so
  // concurrent handshakes (multiple tabs) queue their dialogs instead of overlapping.
  const hostKeyDialog = setupHostKeyDialog()
  const kbdDialog = setupKbdDialog()
  let modalChain: Promise<void> = Promise.resolve()
  const enqueueModal = (fn: () => Promise<void>): void => {
    modalChain = modalChain.then(fn).catch(() => {})
  }

  window.ssh.onHostKeyPrompt((prompt) => {
    enqueueModal(async () => {
      const owner = tabs.tabForSession(prompt.sessionId)
      if (owner) tabs.activate(owner)
      const accepted = await hostKeyDialog.prompt(prompt)
      await window.ssh.hostKeyDecision(prompt.sessionId, accepted)
    })
  })

  window.ssh.onKeyboardInteractive((request) => {
    enqueueModal(async () => {
      const owner = tabs.tabForSession(request.sessionId)
      if (owner) tabs.activate(owner)
      const answers = await kbdDialog.prompt(request)
      await window.ssh.answerKeyboardInteractive(request.sessionId, answers ?? [])
    })
  })

  // --- Status-bar controls: font size + theme ---
  const fontReadout = el('font-size')
  const applySettings = (): void => {
    const s = settings.get()
    document.body.dataset.theme = s.theme
    fontReadout.textContent = String(s.fontSize)
    tabs.applySettings(s)
  }
  settings.subscribe(applySettings)
  document.body.dataset.theme = settings.get().theme
  fontReadout.textContent = String(settings.get().fontSize)

  el<HTMLButtonElement>('font-dec').addEventListener('click', () => settings.bumpFont(-1))
  el<HTMLButtonElement>('font-inc').addEventListener('click', () => settings.bumpFont(1))
  el<HTMLButtonElement>('theme-toggle').addEventListener('click', () => settings.toggleTheme())

  const settingsDialog = setupSettingsDialog()
  el<HTMLButtonElement>('settings-open').addEventListener('click', () => settingsDialog.open())

  const forwardsPanel = setupForwardsPanel(() => tabs.activeForwardTarget())
  el<HTMLButtonElement>('forwards-open').addEventListener('click', () => forwardsPanel.open())

  // Recent connections live behind a status-bar button (keeps the connect form
  // uncluttered). One click on an entry connects, reusing the one-click logic.
  const recentsBtn = el<HTMLButtonElement>('recents-open')
  recentsBtn.addEventListener('click', () => {
    void window.ssh.listRecents().then((recents) => {
      const entries: ContextMenuEntry[] = recents.length
        ? recents.map((r) => ({
            label: `${r.username}@${r.host}:${r.port} · ${r.auth.kind}`,
            action: () => tabs.openRecent(r)
          }))
        : [{ label: 'No recent connections', enabled: false, action: () => {} }]
      const rect = recentsBtn.getBoundingClientRect()
      // Anchor at the button; showContextMenu clamps it on-screen (opens upward).
      showContextMenu(rect.left, rect.top, entries)
    })
  })

  // Window-level shortcuts (used when the terminal isn't focused, e.g. the form).
  window.addEventListener('keydown', (e) => {
    if (appShortcut(e)) e.preventDefault()
  })

  void window.ssh.getVersion().then((v) => {
    el('version').textContent = `v${v}`
  })

  tabs.newTab()
}

bootstrap()
