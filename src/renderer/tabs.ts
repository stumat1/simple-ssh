import { createTerminal, type TerminalHandle, type TerminalInit } from './terminal'
import { createConnectForm, type ConnectFormHandle } from './connect-form'
import { showContextMenu } from './context-menu'
import type {
  AuthMethod,
  ConnectRequest,
  ForwardSpec,
  ForwardStatus,
  ForwardStatusEvent,
  RecentConnection,
  SessionStatus
} from '@shared/types'
import type { AppSettings } from './settings'

type TabState = 'form' | 'connecting' | 'connected' | 'disconnected'

export interface ForwardInfo {
  id: string
  spec: ForwardSpec
  status: ForwardStatus
  message?: string
}

/** Fired on `window` whenever any tab's forward list changes. */
export const FORWARDS_CHANGED = 'ssh-terminal:forwards-changed'

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
  // Last request actually sent, kept for one-click reconnect / duplicate-tab.
  // May hold an unsaved typed password in renderer memory — accepted trade-off
  // for a personal-use app.
  private lastReq: ConnectRequest | null = null
  private wasConnected = false
  private customTitle = false
  private tooltip = ''
  private readonly forwards = new Map<string, Omit<ForwardInfo, 'id'>>()

  readonly pane: HTMLElement
  readonly button: HTMLElement
  private readonly titleEl: HTMLElement
  private readonly dot: HTMLElement
  private readonly termContainer: HTMLElement
  private readonly form: ConnectFormHandle
  private readonly reconnectOverlay: HTMLElement
  private readonly reconnectMsg: HTMLElement
  private readonly reconnectBtn: HTMLButtonElement
  private terminal: TerminalHandle | null = null

  constructor(private readonly mgr: TabManager) {
    // Pane: terminal container with the connect form overlaid on top.
    this.pane = document.createElement('div')
    this.pane.className = 'tab-pane'
    this.termContainer = document.createElement('div')
    this.termContainer.className = 'tab-terminal'
    this.form = createConnectForm((req) => void this.connect(req))

    // Reconnect overlay, shown instead of the form when a live session drops.
    this.reconnectOverlay = document.createElement('div')
    this.reconnectOverlay.className = 'overlay'
    this.reconnectOverlay.style.display = 'none'
    const card = document.createElement('div')
    card.className = 'card'
    const heading = document.createElement('h2')
    heading.textContent = 'Connection closed'
    this.reconnectMsg = document.createElement('p')
    this.reconnectMsg.className = 'hint'
    const actions = document.createElement('div')
    actions.className = 'card-actions'
    this.reconnectBtn = document.createElement('button')
    this.reconnectBtn.type = 'button'
    this.reconnectBtn.textContent = 'Reconnect'
    this.reconnectBtn.addEventListener('click', () => {
      if (this.lastReq) void this.connect(this.lastReq)
    })
    const editBtn = document.createElement('button')
    editBtn.type = 'button'
    editBtn.className = 'btn-secondary'
    editBtn.textContent = 'Edit connection'
    editBtn.addEventListener('click', () => {
      this.wasConnected = false
      if (this.lastReq) this.form.prefill(this.lastReq)
      this.applyState('disconnected')
      this.form.focus()
    })
    actions.append(this.reconnectBtn, editBtn)
    card.append(heading, this.reconnectMsg, actions)
    this.reconnectOverlay.appendChild(card)

    this.pane.append(this.termContainer, this.form.element, this.reconnectOverlay)

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
    this.button.addEventListener('click', () => {
      if (this.mgr.consumeDragClick()) return
      this.mgr.activate(this)
    })
    // Middle-click closes the tab.
    this.button.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault()
        this.mgr.closeTab(this)
      }
    })
    this.button.addEventListener('dblclick', (e) => {
      e.preventDefault()
      this.startRename()
    })
    this.button.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      showContextMenu(e.clientX, e.clientY, [
        {
          label: 'Duplicate',
          enabled: this.lastReq !== null,
          action: () => this.mgr.duplicate(this)
        },
        { label: 'Rename', action: () => this.startRename() },
        'separator',
        { label: 'Close', action: () => this.mgr.closeTab(this) }
      ])
    })
    this.mgr.attachDrag(this)

    this.setTitle('New tab')
    this.applyState('form')
  }

  private setTitle(title: string, opts?: { force?: boolean }): void {
    if (this.customTitle && !opts?.force) return
    this.title = title
    this.titleEl.textContent = title
    this.button.title = this.tooltip || title
  }

  /** Inline-rename the tab; a manual name survives later auto-titling. */
  private startRename(): void {
    const input = document.createElement('input')
    input.className = 'tab-rename'
    input.value = this.title
    // Keep clicks/drags inside the input from activating or dragging the tab.
    input.addEventListener('pointerdown', (e) => e.stopPropagation())
    input.addEventListener('click', (e) => e.stopPropagation())
    input.addEventListener('dblclick', (e) => e.stopPropagation())
    let done = false
    const finish = (commit: boolean): void => {
      if (done) return
      done = true
      const name = input.value.trim()
      input.remove()
      if (commit && name) {
        this.customTitle = true
        this.setTitle(name, { force: true })
      } else {
        this.titleEl.textContent = this.title
      }
      if (this.mgr.isActive(this)) this.mgr.refreshStatusBar()
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') finish(true)
      else if (e.key === 'Escape') finish(false)
    })
    input.addEventListener('blur', () => finish(true))
    this.titleEl.textContent = ''
    this.titleEl.appendChild(input)
    input.focus()
    input.select()
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
    this.lastReq = req
    this.form.setError('')
    this.form.setBusy(true)
    this.tooltip = `${req.username}@${req.host}:${req.port}`
    this.button.title = this.tooltip
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
      // Fall back to the form (prefilled — it may be blank in a duplicated tab).
      this.wasConnected = false
      this.form.prefill(req)
      this.form.setError(err instanceof Error ? err.message : String(err))
      this.applyState('form')
    }
  }

  /** Connect using a request captured from another tab (duplicate-tab). */
  connectWith(req: ConnectRequest): void {
    void this.connect(req)
  }

  /** Whether this tab is still an unused "new tab" (form shown, never connected). */
  isFresh(): boolean {
    return this.state === 'form' && this.sessionId === null
  }

  /** Load a recent target into this tab's form, auto-connecting when possible. */
  openTarget(host: string, port: number, username: string, auth: AuthMethod): void {
    this.form.openTarget(host, port, username, auth)
  }

  /** The last request sent from this tab, if any (used by duplicate-tab). */
  get lastRequest(): ConnectRequest | null {
    return this.lastReq
  }

  write(data: Uint8Array): void {
    this.terminal?.term.write(data)
  }

  setError(message: string): void {
    this.form.setError(message)
    this.reconnectMsg.textContent = message
  }

  /** Apply a forward lifecycle event ('stopped' removes it from the list). */
  updateForward(event: ForwardStatusEvent): void {
    if (event.status === 'stopped') {
      this.forwards.delete(event.forwardId)
    } else {
      this.forwards.set(event.forwardId, {
        spec: event.spec,
        status: event.status,
        message: event.message
      })
    }
    window.dispatchEvent(new CustomEvent(FORWARDS_CHANGED))
  }

  listForwards(): ForwardInfo[] {
    return [...this.forwards.entries()].map(([id, f]) => ({ id, ...f }))
  }

  setStatus(status: SessionStatus): void {
    this.dot.dataset.status = status
    switch (status) {
      case 'connecting':
        break
      case 'ready':
        this.form.setBusy(false)
        this.wasConnected = true
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
        if (status === 'closed') this.reconnectMsg.textContent = 'The session ended.'
        if (this.forwards.size > 0) {
          // The backend cancels the listeners on teardown; reflect that here.
          this.forwards.clear()
          window.dispatchEvent(new CustomEvent(FORWARDS_CHANGED))
        }
        this.applyState('disconnected')
        break
    }
    if (this.mgr.isActive(this)) this.mgr.refreshStatusBar()
  }

  /** Toggle form / reconnect overlay / terminal within the pane based on state. */
  private applyState(state: TabState): void {
    this.state = state
    // After a live session drops, offer one-click reconnect instead of the form.
    const useOverlay = state === 'disconnected' && this.wasConnected && this.lastReq !== null
    this.reconnectOverlay.style.display = useOverlay ? 'flex' : 'none'
    const showForm = (state === 'form' || state === 'disconnected') && !useOverlay
    if (showForm) this.form.show()
    else this.form.hide()
  }

  /** Apply appearance settings to this tab's terminal (if any). */
  applySettings(s: AppSettings): void {
    this.terminal?.applySettings(s)
  }

  show(): void {
    this.pane.style.display = 'block'
    if (this.state === 'connected') {
      this.terminal?.fit()
      this.terminal?.term.focus()
    } else if (this.reconnectOverlay.style.display !== 'none') {
      this.reconnectBtn.focus()
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
    return { settings: this.options.getSettings(), onAppShortcut: this.options.onAppShortcut }
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

  /** Open a new tab connected with the same request as `tab`. */
  duplicate(tab: Tab): void {
    const req = tab.lastRequest
    if (!req) return
    this.newTab().connectWith(req)
  }

  /** Duplicate the active tab (Ctrl+Shift+D). */
  duplicateActive(): void {
    if (this.active) this.duplicate(this.active)
  }

  /**
   * Open a recent connection: reuse the active tab when it's still an unused
   * "new tab", otherwise open a fresh one (never steal a live session's tab).
   */
  openRecent(recent: RecentConnection): void {
    const tab = this.active?.isFresh() ? this.active : this.newTab()
    this.activate(tab)
    tab.openTarget(recent.host, recent.port, recent.username, recent.auth)
  }

  // --- Drag-to-reorder -------------------------------------------------------
  // Pointer-event based: a horizontal move beyond a small threshold starts the
  // drag; the button is repositioned live in the tab bar, and on release the
  // tabs array is re-synced to DOM order. The click that follows a drag is
  // swallowed so it doesn't also activate the tab.

  private dragJustEnded = false

  consumeDragClick(): boolean {
    return this.dragJustEnded
  }

  attachDrag(tab: Tab): void {
    const btn = tab.button
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      if ((e.target as HTMLElement).closest('.tab-close, .tab-rename')) return
      const startX = e.clientX
      let dragging = false

      const onMove = (ev: PointerEvent): void => {
        if (!dragging) {
          if (Math.abs(ev.clientX - startX) < 5) return
          dragging = true
          btn.classList.add('dragging')
        }
        // Insert before the first tab whose midpoint is right of the pointer.
        const others = Array.from(this.tabBar.querySelectorAll<HTMLElement>('.tab')).filter(
          (b) => b !== btn
        )
        let target: HTMLElement | null = null
        for (const other of others) {
          const rect = other.getBoundingClientRect()
          if (ev.clientX < rect.left + rect.width / 2) {
            target = other
            break
          }
        }
        this.tabBar.insertBefore(btn, target ?? this.newTabButton)
      }

      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        if (!dragging) return
        btn.classList.remove('dragging')
        const order = Array.from(this.tabBar.querySelectorAll<HTMLElement>('.tab'))
        this.tabs.sort((a, b) => order.indexOf(a.button) - order.indexOf(b.button))
        this.dragJustEnded = true
        setTimeout(() => {
          this.dragJustEnded = false
        }, 0)
      }

      // Window-level listeners: pointer capture on the button is unreliable in
      // WebView2 once the pointer leaves the button's original bounds, so use
      // the classic document-wide drag pattern instead.
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    })
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

  /** Snapshot of the active tab's live session for the forwards panel. */
  activeForwardTarget(): { sessionId: string; label: string; forwards: ForwardInfo[] } | null {
    const tab = this.active
    if (!tab?.sessionId) return null
    return { sessionId: tab.sessionId, label: tab.statusText(), forwards: tab.listForwards() }
  }

  refreshStatusBar(): void {
    this.statusEl.textContent = this.active ? this.active.statusText() : 'No tabs'
  }
}
