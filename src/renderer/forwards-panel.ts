// Port-forwarding panel (app-level singleton modal). Acts on the active tab's
// session; the forward list lives on the Tab and is re-rendered on every
// FORWARDS_CHANGED event while the panel is open.

import { FORWARDS_CHANGED, type ForwardInfo } from './tabs'

export interface ForwardTarget {
  sessionId: string
  label: string
  forwards: ForwardInfo[]
}

export interface ForwardsPanelHandle {
  open: () => void
}

export function setupForwardsPanel(getTarget: () => ForwardTarget | null): ForwardsPanelHandle {
  const view = document.createElement('div')
  view.className = 'overlay hidden'
  view.id = 'forwards-view'

  const card = document.createElement('div')
  card.className = 'card forwards-card'
  const heading = document.createElement('h2')
  heading.textContent = 'Port forwarding'
  const subtitle = document.createElement('p')
  subtitle.className = 'hint'
  const list = document.createElement('ul')
  list.className = 'forward-list'
  const empty = document.createElement('p')
  empty.className = 'hint'

  // Add-forward row: local port → remote host : remote port.
  const addRow = document.createElement('div')
  addRow.className = 'forward-add-row'
  const localPort = document.createElement('input')
  localPort.type = 'number'
  localPort.min = '1'
  localPort.max = '65535'
  localPort.placeholder = 'Local port'
  localPort.title = 'Local port (listens on 127.0.0.1)'
  const arrow = document.createElement('span')
  arrow.textContent = '→'
  const remoteHost = document.createElement('input')
  remoteHost.type = 'text'
  remoteHost.placeholder = 'Remote host'
  remoteHost.title = 'Destination host, as seen from the server (e.g. localhost)'
  const remotePort = document.createElement('input')
  remotePort.type = 'number'
  remotePort.min = '1'
  remotePort.max = '65535'
  remotePort.placeholder = 'Port'
  const addBtn = document.createElement('button')
  addBtn.type = 'button'
  addBtn.textContent = 'Add'
  addRow.append(localPort, arrow, remoteHost, remotePort, addBtn)

  const errorEl = document.createElement('p')
  errorEl.className = 'error'
  errorEl.setAttribute('role', 'alert')

  const actions = document.createElement('div')
  actions.className = 'card-actions'
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'btn-secondary'
  closeBtn.textContent = 'Close'
  actions.appendChild(closeBtn)

  card.append(heading, subtitle, list, empty, addRow, errorEl, actions)
  view.appendChild(card)
  document.getElementById('app')?.appendChild(view)

  function render(): void {
    const target = getTarget()
    list.replaceChildren()
    if (!target) {
      subtitle.textContent = 'No connected session in the active tab.'
      empty.textContent = ''
      addRow.classList.add('hidden')
      return
    }
    addRow.classList.remove('hidden')
    subtitle.textContent = target.label
    empty.textContent = target.forwards.length === 0 ? 'No forwards yet.' : ''
    for (const fwd of target.forwards) {
      const li = document.createElement('li')
      li.className = 'list-row'

      const main = document.createElement('div')
      main.className = 'list-main forward-row'
      const nameSpan = document.createElement('span')
      nameSpan.className = 'list-name'
      nameSpan.textContent = `127.0.0.1:${fwd.spec.localPort} → ${fwd.spec.remoteHost}:${fwd.spec.remotePort}`
      const metaSpan = document.createElement('span')
      metaSpan.className = 'list-meta'
      metaSpan.textContent = fwd.status === 'error' ? (fwd.message ?? 'error') : fwd.status
      if (fwd.status === 'error') metaSpan.classList.add('forward-error')
      main.append(nameSpan, metaSpan)

      const stop = document.createElement('button')
      stop.type = 'button'
      stop.className = 'list-del'
      stop.title = fwd.status === 'error' ? 'Dismiss' : 'Stop forward'
      stop.textContent = '×'
      stop.addEventListener('click', () => {
        void window.ssh.stopForward(target.sessionId, fwd.id)
      })

      li.append(main, stop)
      list.appendChild(li)
    }
  }

  function add(): void {
    errorEl.textContent = ''
    const target = getTarget()
    if (!target) return
    const lp = Number(localPort.value)
    const rp = Number(remotePort.value)
    const rh = remoteHost.value.trim()
    if (!lp || lp < 1 || lp > 65535 || !rp || rp < 1 || rp > 65535) {
      errorEl.textContent = 'Ports must be between 1 and 65535.'
      return
    }
    if (!rh) {
      errorEl.textContent = 'Enter the remote host (e.g. localhost).'
      return
    }
    addBtn.disabled = true
    window.ssh
      .addForward(target.sessionId, { localPort: lp, remoteHost: rh, remotePort: rp })
      .then(() => {
        localPort.value = ''
        // Keep host/port — adding several forwards to one service is common.
      })
      .catch((err: unknown) => {
        errorEl.textContent = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        addBtn.disabled = false
      })
  }

  addBtn.addEventListener('click', add)
  for (const input of [localPort, remoteHost, remotePort]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        add()
      }
    })
  }

  const isOpen = (): boolean => !view.classList.contains('hidden')
  window.addEventListener(FORWARDS_CHANGED, () => {
    if (isOpen()) render()
  })

  const close = (): void => view.classList.add('hidden')
  closeBtn.addEventListener('click', close)
  view.addEventListener('pointerdown', (e) => {
    if (e.target === view) close()
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) close()
  })

  return {
    open: () => {
      errorEl.textContent = ''
      render()
      view.classList.remove('hidden')
      localPort.focus()
    }
  }
}
