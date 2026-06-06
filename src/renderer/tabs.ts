import { createTerminal, type TerminalHandle, type TerminalInit } from './terminal'
import { createConnectForm, type ConnectFormHandle } from './connect-form'
import type { ConnectRequest, SessionStatus } from '@shared/types'
import type { AppSettings } from './settings'

type TabState = 'form' | 'connecting' | 'connected' | 'disconnected'

let tabSeq = 0

/**
 * One tab = one pane containing a connect form and (once connected) an xterm
 * terminal, plus its button in the tab bar. Owns a single SSH session at a time.
 */
class Tab {
  readonly key = `tab-${++tabSeq}`
  sessionId: string | null = null
  private state: TabState = 'form'
  private title = 'New tab'

  readonly pane: HTMLElement
  readonly button: HTMLElement
  private readonly titleEl: HTMLElement
  private readonly dot: HTMLElement
  private readonly termContainer: HTMLElement
  private readonly form: ConnectFormHandle
  private terminal: TerminalHandle | null = null

  constructor(private readonly mgr: TabManager) {
    // Pane: terminal container with the connect form overlaid on top.
    this.pane = document.createElement('div')
    this.pane.className = 'tab-pane'
    this.termContainer = document.createElement('div')
    this.termContainer.className = 'tab-terminal'
    this.form = createConnectForm((req) => void this.connect(req))
    this.pane.append(this.termContainer, this.form.element)

    // Tab bar button: status dot + title + close.
    this.button = document.createElement('div')
    this.button.className = 'tab'
    this.button.setAttribute('role', 'tab')
    this.dot = document.createElement('span')
    this.dot.className = 'tab-dot'
    this.titleEl = document.createElement('span')
    this.titleEl.className = 'tab-title'
    const closeBtn = document.createElement('button')
    closeBtn.className = 'tab-close'
    closeBtn.textContent = '×'
    closeBtn.title = 'Close tab'
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.mgr.closeTab(this)
    })
    this.button.append(this.dot, this.titleEl, closeBtn)
    this.button.addEventListener('click', () => this.mgr.activate(this))

    this.setTitle('New tab')
    this.applyState('form')
  }

  private setTitle(title: string): void {
    this.title = title
    this.titleEl.textContent = title
    this.button.title = title
  }

  private ensureTerminal(): TerminalHandle {
    if (this.terminal) return this.terminal
    const handle = createTerminal(this.termContainer, this.mgr.terminalInit())
    handle.term.onData((data) => {
      if (this.sessionId) window.ssh.sendInput(this.sessionId, data)
    })
    handle.term.onResize(({ cols, rows }) => {
      if (this.sessionId) window.ssh.resize(this.sessionId, cols, rows)
    })
    this.terminal = handle
    return handle
  }

  private async connect(req: ConnectRequest): Promise<void> {
    this.form.setError('')
    this.form.setBusy(true)
    this.setTitle(`${req.username}@${req.host}`)
    const handle = this.ensureTerminal()
    handle.term.clear()
    this.applyState('connecting')
    // Reflect connecting state on the tab dot locally — the main-process
    // 'connecting' status event fires before this tab is registered by sessionId.
    this.dot.dataset.status = 'connecting'
    try {
      const sessionId = await window.ssh.connect(req, {
        cols: handle.term.cols,
        rows: handle.term.rows
      })
      this.sessionId = sessionId
      this.mgr.registerSession(sessionId, this)
    } catch (err) {
      this.form.setBusy(false)
      this.form.setError(err instanceof Error ? err.message : String(err))
      this.applyState('form')
    }
  }

  write(data: Uint8Array): void {
    this.terminal?.term.write(data)
  }

  setError(message: string): void {
    this.form.setError(message)
  }

  setStatus(status: SessionStatus): void {
    this.dot.dataset.status = status
    switch (status) {
      case 'connecting':
        break
      case 'ready':
        this.form.setBusy(false)
        this.applyState('connected')
        if (this.mgr.isActive(this)) {
          this.terminal?.fit()
          this.terminal?.term.focus()
        }
        break
      case 'closed':
      case 'error':
        if (this.sessionId) {
          this.mgr.unregisterSession(this.sessionId)
          this.sessionId = null
        }
        this.form.setBusy(false)
        this.terminal?.term.writeln('\r\n\x1b[90m[session closed]\x1b[0m')
        this.applyState('disconnected')
        break
    }
    if (this.mgr.isActive(this)) this.mgr.refreshStatusBar()
  }

  /** Toggle form vs terminal within the pane based on connection state. */
  private applyState(state: TabState): void {
    this.state = state
    const showForm = state === 'form' || state === 'disconnected'
    if (showForm) this.form.show()
    else this.form.hide()
  }

  /** Apply font-size / theme changes to this tab's terminal (if any). */
  applySettings(s: AppSettings): void {
    this.terminal?.setFontSize(s.fontSize)
    this.terminal?.setTheme(s.theme)
  }

  show(): void {
    this.pane.style.display = 'block'
    if (this.state === 'connected') {
      this.terminal?.fit()
      this.terminal?.term.focus()
    } else {
      this.form.focus()
    }
  }

  hide(): void {
    this.pane.style.display = 'none'
  }

  statusText(): string {
    switch (this.state) {
      case 'connected':
        return `Connected — ${this.title}`
      case 'connecting':
        return `Connecting — ${this.title}…`
      case 'disconnected':
        return `Disconnected — ${this.title}`
      default:
        return 'Not connected'
    }
  }

  /** Disconnect (if live) and tear down all DOM/resources. */
  dispose(): void {
    if (this.sessionId) {
      void window.ssh.disconnect(this.sessionId)
      this.mgr.unregisterSession(this.sessionId)
      this.sessionId = null
    }
    this.terminal?.dispose()
    this.terminal = null
    this.form.dispose()
    this.pane.remove()
    this.button.remove()
  }
}

export interface TabManagerOptions {
  /** Current UI settings (font size + theme) for new terminals. */
  getSettings: () => AppSettings
  /** Shared app-shortcut handler delegated to each terminal. */
  onAppShortcut: (e: KeyboardEvent) => boolean
}

/**
 * Manages the set of tabs: the tab bar, the active pane, and routing of SSH
 * stream events to the owning tab by sessionId.
 */
export class TabManager {
  private readonly tabs: Tab[] = []
  private active: Tab | null = null
  private readonly bySessionId = new Map<string, Tab>()

  constructor(
    private readonly tabBar: HTMLElement,
    private readonly content: HTMLElement,
    private readonly newTabButton: HTMLElement,
    private readonly statusEl: HTMLElement,
    private readonly options: TabManagerOptions
  ) {
    this.newTabButton.addEventListener('click', () => this.newTab())
  }

  /** Terminal construction options reflecting current settings. */
  terminalInit(): TerminalInit {
    const s = this.options.getSettings()
    return { fontSize: s.fontSize, theme: s.theme, onAppShortcut: this.options.onAppShortcut }
  }

  newTab(): Tab {
    const tab = new Tab(this)
    this.tabs.push(tab)
    this.content.appendChild(tab.pane)
    this.tabBar.insertBefore(tab.button, this.newTabButton)
    this.activate(tab)
    return tab
  }

  activate(tab: Tab): void {
    if (this.active === tab) {
      tab.show()
      return
    }
    if (this.active) {
      this.active.hide()
      this.active.button.classList.remove('active')
    }
    this.active = tab
    tab.button.classList.add('active')
    tab.show()
    this.refreshStatusBar()
  }

  isActive(tab: Tab): boolean {
    return this.active === tab
  }

  closeTab(tab: Tab): void {
    const index = this.tabs.indexOf(tab)
    if (index < 0) return
    tab.dispose()
    this.tabs.splice(index, 1)

    if (this.active === tab) {
      this.active = null
      const next = this.tabs[index] ?? this.tabs[index - 1] ?? null
      if (next) this.activate(next)
      else this.newTab() // always keep at least one tab open
    }
    this.refreshStatusBar()
  }

  /** Close the active tab (Ctrl+W). */
  closeActive(): void {
    if (this.active) this.closeTab(this.active)
  }

  /** Apply changed UI settings to every open terminal. */
  applySettings(s: AppSettings): void {
    for (const tab of this.tabs) tab.applySettings(s)
  }

  registerSession(sessionId: string, tab: Tab): void {
    this.bySessionId.set(sessionId, tab)
  }

  unregisterSession(sessionId: string): void {
    this.bySessionId.delete(sessionId)
  }

  tabForSession(sessionId: string): Tab | undefined {
    return this.bySessionId.get(sessionId)
  }

  refreshStatusBar(): void {
    this.statusEl.textContent = this.active ? this.active.statusText() : 'No tabs'
  }
}
