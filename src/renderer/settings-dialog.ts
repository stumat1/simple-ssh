// Terminal appearance settings dialog (app-level singleton modal). Every
// control writes straight to the settings store, so changes apply live to all
// open terminals via the existing subscribe path.

import { settings, DEFAULT_FONT_FAMILY, type CursorStyle } from './settings'
import { SCHEMES, type SchemeName } from './themes'

const FONT_PRESETS = [
  DEFAULT_FONT_FAMILY,
  'Consolas',
  '"Cascadia Code"',
  '"Cascadia Mono"',
  '"Fira Code"',
  '"JetBrains Mono"',
  '"Source Code Pro"',
  '"Courier New"'
]

export interface SettingsDialogHandle {
  open: () => void
}

export function setupSettingsDialog(): SettingsDialogHandle {
  const view = document.createElement('div')
  view.className = 'overlay hidden'
  view.id = 'settings-view'

  const card = document.createElement('div')
  card.className = 'card settings-card'
  const heading = document.createElement('h2')
  heading.textContent = 'Terminal settings'
  card.appendChild(heading)

  const labelled = (text: string, control: HTMLElement): HTMLLabelElement => {
    const label = document.createElement('label')
    label.append(text, control)
    return label
  }

  // Font family with monospace presets.
  const fontFamily = document.createElement('input')
  fontFamily.type = 'text'
  const datalist = document.createElement('datalist')
  datalist.id = 'font-presets'
  for (const preset of FONT_PRESETS) {
    const opt = document.createElement('option')
    opt.value = preset
    datalist.appendChild(opt)
  }
  fontFamily.setAttribute('list', datalist.id)
  fontFamily.addEventListener('change', () => {
    settings.update({ fontFamily: fontFamily.value.trim() || DEFAULT_FONT_FAMILY })
  })

  // Color scheme.
  const scheme = document.createElement('select')
  const autoOpt = document.createElement('option')
  autoOpt.value = 'auto'
  autoOpt.textContent = 'Auto (match app theme)'
  scheme.appendChild(autoOpt)
  for (const [name, def] of Object.entries(SCHEMES)) {
    const opt = document.createElement('option')
    opt.value = name
    opt.textContent = def.label
    scheme.appendChild(opt)
  }
  scheme.addEventListener('change', () => {
    settings.update({ scheme: scheme.value as SchemeName })
  })

  // Cursor style + blink.
  const cursorStyle = document.createElement('select')
  for (const [value, text] of [
    ['block', 'Block'],
    ['bar', 'Bar'],
    ['underline', 'Underline']
  ]) {
    const opt = document.createElement('option')
    opt.value = value
    opt.textContent = text
    cursorStyle.appendChild(opt)
  }
  cursorStyle.addEventListener('change', () => {
    settings.update({ cursorStyle: cursorStyle.value as CursorStyle })
  })

  const cursorBlink = document.createElement('input')
  cursorBlink.type = 'checkbox'
  cursorBlink.addEventListener('change', () => {
    settings.update({ cursorBlink: cursorBlink.checked })
  })
  const blinkLabel = document.createElement('label')
  blinkLabel.className = 'checkbox'
  blinkLabel.append(cursorBlink, 'Blinking cursor')

  // Scrollback + line height (clamped by the store).
  const scrollback = document.createElement('input')
  scrollback.type = 'number'
  scrollback.min = '200'
  scrollback.max = '200000'
  scrollback.step = '100'
  scrollback.addEventListener('change', () => {
    settings.update({ scrollback: Number(scrollback.value) })
    scrollback.value = String(settings.get().scrollback)
  })

  const lineHeight = document.createElement('input')
  lineHeight.type = 'number'
  lineHeight.min = '1'
  lineHeight.max = '2'
  lineHeight.step = '0.05'
  lineHeight.addEventListener('change', () => {
    settings.update({ lineHeight: Number(lineHeight.value) })
    lineHeight.value = String(settings.get().lineHeight)
  })

  card.append(
    labelled('Font family', fontFamily),
    datalist,
    labelled('Color scheme', scheme),
    labelled('Cursor style', cursorStyle),
    blinkLabel,
    labelled('Scrollback (lines)', scrollback),
    labelled('Line height', lineHeight)
  )

  const actions = document.createElement('div')
  actions.className = 'card-actions'
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.textContent = 'Close'
  actions.appendChild(closeBtn)
  card.appendChild(actions)
  view.appendChild(card)
  document.getElementById('app')?.appendChild(view)

  const refresh = (): void => {
    const s = settings.get()
    fontFamily.value = s.fontFamily
    scheme.value = s.scheme
    cursorStyle.value = s.cursorStyle
    cursorBlink.checked = s.cursorBlink
    scrollback.value = String(s.scrollback)
    lineHeight.value = String(s.lineHeight)
  }

  const close = (): void => view.classList.add('hidden')
  closeBtn.addEventListener('click', close)
  view.addEventListener('pointerdown', (e) => {
    if (e.target === view) close()
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !view.classList.contains('hidden')) close()
  })

  return {
    open: () => {
      refresh()
      view.classList.remove('hidden')
      fontFamily.focus()
    }
  }
}
