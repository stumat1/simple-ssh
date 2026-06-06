import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import type { ThemeName } from './settings'

// Dark theme aligned with the app shell (see styles.css).
const darkTheme: ITheme = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f78',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff'
}

const lightTheme: ITheme = {
  background: '#ffffff',
  foreground: '#333333',
  cursor: '#333333',
  cursorAccent: '#ffffff',
  selectionBackground: '#add6ff',
  black: '#000000',
  red: '#cd3131',
  green: '#107c10',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5'
}

const THEMES: Record<ThemeName, ITheme> = { dark: darkTheme, light: lightTheme }

export interface TerminalInit {
  fontSize: number
  theme: ThemeName
  /**
   * App-level shortcut handler (new tab, close tab, font size, …). Return true
   * if the key was consumed, in which case it is kept out of the PTY.
   */
  onAppShortcut: (e: KeyboardEvent) => boolean
}

export interface TerminalHandle {
  term: Terminal
  /** Refit the terminal grid to the current container size. */
  fit: () => void
  /** Apply a new terminal font size (px) and refit. */
  setFontSize: (px: number) => void
  /** Switch the terminal color theme. */
  setTheme: (theme: ThemeName) => void
  /** Show the in-terminal search bar and focus it. */
  openSearch: () => void
  /** Tear down the terminal and its observers/DOM. */
  dispose: () => void
}

/** Build the floating find bar (CSP-safe DOM, no innerHTML of dynamic data). */
function buildSearchBar(): {
  bar: HTMLElement
  input: HTMLInputElement
  prev: HTMLButtonElement
  next: HTMLButtonElement
  close: HTMLButtonElement
} {
  const bar = document.createElement('div')
  bar.className = 'search-bar hidden'

  const input = document.createElement('input')
  input.className = 'search-input'
  input.type = 'text'
  input.placeholder = 'Find'

  const prev = document.createElement('button')
  prev.type = 'button'
  prev.className = 'search-btn'
  prev.title = 'Previous (Shift+Enter)'
  prev.textContent = '▲'

  const next = document.createElement('button')
  next.type = 'button'
  next.className = 'search-btn'
  next.title = 'Next (Enter)'
  next.textContent = '▼'

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'search-btn'
  close.title = 'Close (Esc)'
  close.textContent = '✕'

  bar.append(input, prev, next, close)
  return { bar, input, prev, next, close }
}

/**
 * Creates an xterm terminal mounted in `container`, wired with the fit, unicode11,
 * web-links, search, and (when available) GPU-accelerated WebGL renderer addons.
 * Handles copy/paste (Ctrl+Shift+C/V), find (Ctrl+Shift+F), and delegates other
 * app shortcuts. Keeps the grid fitted to the container via a ResizeObserver.
 */
export function createTerminal(container: HTMLElement, init: TerminalInit): TerminalHandle {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
    fontSize: init.fontSize,
    scrollback: 5000,
    // Required by the unicode11 addon, which uses xterm's proposed unicode API.
    allowProposedApi: true,
    theme: THEMES[init.theme]
  })

  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)

  const searchAddon = new SearchAddon()
  term.loadAddon(searchAddon)

  // Correct wide/emoji character widths (Unicode 11).
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'

  term.open(container)

  // Prefer the WebGL renderer for performance; fall back to the default DOM
  // renderer if a GL context can't be created or is later lost (plan gotcha #7).
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => webgl.dispose())
    term.loadAddon(webgl)
  } catch (err) {
    console.warn('WebGL renderer unavailable; using DOM renderer.', err)
  }

  term.loadAddon(new WebLinksAddon())

  // --- Find bar ---
  const { bar, input, prev, next, close } = buildSearchBar()
  container.appendChild(bar)

  const findNext = (): void => {
    if (input.value) searchAddon.findNext(input.value)
  }
  const findPrevious = (): void => {
    if (input.value) searchAddon.findPrevious(input.value)
  }
  const closeSearch = (): void => {
    bar.classList.add('hidden')
    searchAddon.clearDecorations()
    term.focus()
  }
  const openSearch = (): void => {
    bar.classList.remove('hidden')
    input.focus()
    input.select()
  }

  input.addEventListener('input', () => {
    if (input.value) searchAddon.findNext(input.value, { incremental: true })
    else searchAddon.clearDecorations()
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) findPrevious()
      else findNext()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeSearch()
    }
  })
  prev.addEventListener('click', findPrevious)
  next.addEventListener('click', findNext)
  close.addEventListener('click', closeSearch)

  // --- Keyboard: copy/paste, find, and app shortcuts ---
  term.attachCustomKeyEventHandler((e): boolean => {
    if (e.type !== 'keydown') return true
    const ctrlShift = e.ctrlKey && e.shiftKey

    if (ctrlShift && e.code === 'KeyC') {
      const selection = term.getSelection()
      if (selection) void window.ssh.clipboardWrite(selection)
      e.preventDefault()
      return false
    }
    if (ctrlShift && e.code === 'KeyV') {
      void window.ssh.clipboardRead().then((text) => {
        if (text) term.paste(text)
      })
      e.preventDefault()
      return false
    }
    if (ctrlShift && e.code === 'KeyF') {
      openSearch()
      e.preventDefault()
      return false
    }

    // App-level shortcuts: let the shared handler act, then keep the key out of
    // the PTY and stop it from also bubbling to the window-level listener.
    if (init.onAppShortcut(e)) {
      e.preventDefault()
      e.stopPropagation()
      return false
    }
    return true
  })

  const fit = (): void => {
    // Skip when the container has no layout box (hidden/background tab); fitting
    // a zero-size element would resize the terminal — and the remote PTY — wrongly.
    if (!container.clientWidth || !container.clientHeight) return
    try {
      fitAddon.fit()
    } catch {
      /* not measurable yet — ignore */
    }
  }

  const resizeObserver = new ResizeObserver(() => fit())
  resizeObserver.observe(container)

  fit()

  const setFontSize = (px: number): void => {
    term.options.fontSize = px
    fit()
  }
  const setTheme = (theme: ThemeName): void => {
    term.options.theme = THEMES[theme]
  }

  const dispose = (): void => {
    resizeObserver.disconnect()
    bar.remove()
    term.dispose()
  }

  return { term, fit, setFontSize, setTheme, openSearch, dispose }
}
