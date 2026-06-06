// App-wide UI preferences (terminal font size + theme), persisted to
// localStorage. No secrets here — just display settings.

export type ThemeName = 'dark' | 'light'

export interface AppSettings {
  fontSize: number
  theme: ThemeName
}

const STORAGE_KEY = 'ssh-terminal.settings'
const MIN_FONT = 8
const MAX_FONT = 32
const DEFAULTS: AppSettings = { fontSize: 14, theme: 'dark' }

function clampFont(px: number): number {
  if (!Number.isFinite(px)) return DEFAULTS.fontSize
  return Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(px)))
}

type Listener = (settings: AppSettings) => void

class SettingsStore {
  private settings: AppSettings
  private readonly listeners = new Set<Listener>()

  constructor() {
    let loaded: AppSettings = { ...DEFAULTS }
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) loaded = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) }
    } catch {
      /* malformed — fall back to defaults */
    }
    loaded.fontSize = clampFont(loaded.fontSize)
    if (loaded.theme !== 'light' && loaded.theme !== 'dark') loaded.theme = DEFAULTS.theme
    this.settings = loaded
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

  private update(patch: Partial<AppSettings>): void {
    const next = { ...this.settings, ...patch }
    if (next.fontSize === this.settings.fontSize && next.theme === this.settings.theme) return
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
