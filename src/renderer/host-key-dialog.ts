import type { HostKeyPrompt } from '@shared/types'

export interface HostKeyDialog {
  /** Show the prompt; resolves true if the user trusts the key. */
  prompt: (info: HostKeyPrompt) => Promise<boolean>
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing element #${id}`)
  return node as T
}

const UNKNOWN_MSG =
  'You are connecting to this server for the first time. Confirm the fingerprint matches the one shown by the server before continuing.'
const CHANGED_MSG =
  'WARNING: the host key does not match the one previously trusted. This may indicate a man-in-the-middle attack. Only continue if you know the key changed legitimately (e.g. the server was rebuilt).'

export function setupHostKeyDialog(): HostKeyDialog {
  const view = el<HTMLElement>('hostkey-view')
  const title = el<HTMLElement>('hostkey-title')
  const hostEl = el<HTMLElement>('hostkey-host')
  const fpEl = el<HTMLElement>('hostkey-fp')
  const knownLine = el<HTMLElement>('hostkey-known-line')
  const knownEl = el<HTMLElement>('hostkey-known')
  const warning = el<HTMLElement>('hostkey-warning')
  const acceptBtn = el<HTMLButtonElement>('hostkey-accept')
  const cancelBtn = el<HTMLButtonElement>('hostkey-cancel')

  let resolver: ((value: boolean) => void) | null = null

  function close(value: boolean): void {
    view.classList.add('hidden')
    const r = resolver
    resolver = null
    r?.(value)
  }

  acceptBtn.addEventListener('click', () => close(true))
  cancelBtn.addEventListener('click', () => close(false))

  return {
    prompt: (info) =>
      new Promise<boolean>((resolve) => {
        resolver = resolve
        const changed = info.status === 'changed'

        title.textContent = changed ? '⚠ Host key changed' : 'Unknown host key'
        title.classList.toggle('danger', changed)
        // textContent (not innerHTML) — never interpolate server data as markup.
        hostEl.textContent = `${info.host}:${info.port}`
        fpEl.textContent = `SHA256:${info.fingerprint}`
        warning.textContent = changed ? CHANGED_MSG : UNKNOWN_MSG

        if (changed && info.knownFingerprint) {
          knownEl.textContent = `SHA256:${info.knownFingerprint}`
          knownLine.classList.remove('hidden')
        } else {
          knownLine.classList.add('hidden')
        }

        view.classList.remove('hidden')
        cancelBtn.focus()
      })
  }
}
