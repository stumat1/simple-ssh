// App-wide UI preferences (terminal appearance + theme), persisted to
// localStorage. No secrets here — just display settings.

import { isSchemeName, type SchemeName } from './themes'

export type ThemeName = 'dark' | 'light'
export type CursorStyle = 'block' | 'bar' | 'underline'

export interface AppSettings {
  fontSize: number
  theme: ThemeName
  fontFamily: string
  cursorStyle: CursorStyle
  cursorBlink: boolean
  scrollback: number
  lineHeight: number
  scheme: SchemeName
}

const STORAGE_KEY = 'ssh-terminal.settings'
const MIN_FONT = 8
const MAX_FONT = 32
const MIN_SCROLLBACK = 200
const MAX_SCROLLBACK = 200000
const MIN_LINE_HEIGHT = 1.0
const MAX_LINE_HEIGHT = 2.0

export const DEFAULT_FONT_FAMILY =
  '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace'

const DEFAULTS: AppSettings = {
  fontSize: 14,
  theme: 'dark',
  fontFamily: DEFAULT_FONT_FAMILY,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 5000,
  lineHeight: 1.0,
  scheme: 'auto'
}

function clampFont(px: number): number {
  if (!Number.isFinite(px)) return DEFAULTS.fontSize
  return Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(px)))
}

function clampScrollback(lines: number): number {
  if (!Number.isFinite(lines)) return DEFAULTS.scrollback
  return Math.min(MAX_SCROLLBACK, Math.max(MIN_SCROLLBACK, Math.round(lines)))
}

function clampLineHeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULTS.lineHeight
  return Math.min(MAX_LINE_HEIGHT, Math.max(MIN_LINE_HEIGHT, Math.round(value * 100) / 100))
}

/** Coerce arbitrary (possibly stale/malformed) stored data into valid settings. */
function sanitize(raw: Partial<AppSettings>): AppSettings {
  const s: AppSettings = { ...DEFAULTS, ...raw }
  s.fontSize = clampFont(s.fontSize)
  if (s.theme !== 'light' && s.theme !== 'dark') s.theme = DEFAULTS.theme
  if (typeof s.fontFamily !== 'string' || !s.fontFamily.trim()) s.fontFamily = DEFAULTS.fontFamily
  if (s.cursorStyle !== 'block' && s.cursorStyle !== 'bar' && s.cursorStyle !== 'underline') {
    s.cursorStyle = DEFAULTS.cursorStyle
  }
  s.cursorBlink = !!s.cursorBlink
  s.scrollback = clampScrollback(s.scrollback)
  s.lineHeight = clampLineHeight(s.lineHeight)
  if (!isSchemeName(s.scheme)) s.scheme = DEFAULTS.scheme
  return s
}

type Listener = (settings: AppSettings) => void

class SettingsStore {
  private settings: AppSettings
  private readonly listeners = new Set<Listener>()

  constructor() {
    let raw: Partial<AppSettings> = {}
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) raw = JSON.parse(stored) as Partial<AppSettings>
    } catch {
      /* malformed — fall back to defaults */
    }
    this.settings = sanitize(raw)
  }

  get(): AppSettings {
    return this.settings
  }

  /** Subscribe to changes; returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  update(patch: Partial<AppSettings>): void {
    const next = sanitize({ ...this.settings, ...patch })
    const changed = (Object.keys(next) as (keyof AppSettings)[]).some(
      (k) => next[k] !== this.settings[k]
    )
    if (!changed) return
    this.settings = next
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* storage unavailable — keep in-memory only */
    }
    for (const listener of this.listeners) listener(next)
  }

  setFontSize(px: number): void {
    this.update({ fontSize: clampFont(px) })
  }

  bumpFont(delta: number): void {
    this.setFontSize(this.settings.fontSize + delta)
  }

  resetFont(): void {
    this.setFontSize(DEFAULTS.fontSize)
  }

  setTheme(theme: ThemeName): void {
    this.update({ theme })
  }

  toggleTheme(): void {
    this.setTheme(this.settings.theme === 'dark' ? 'light' : 'dark')
  }
}

export const settings = new SettingsStore()
