import type { AuthKind, AuthMethod, ConnectRequest, Profile } from '@shared/types'

export interface ConnectFormHandle {
  /** Root element to mount into a tab pane. */
  element: HTMLElement
  show: () => void
  hide: () => void
  focus: () => void
  setError: (message: string) => void
  setBusy: (busy: boolean) => void
  /** Pre-fill the fields from a previous request (secrets are not restored into inputs). */
  prefill: (req: ConnectRequest) => void
  /**
   * Load a target (e.g. a recent connection) and connect immediately when no
   * secret is needed; otherwise focus the secret field.
   */
  openTarget: (host: string, port: number, username: string, auth: AuthMethod) => void
  dispose: () => void
}

/** Broadcast so every open connect form refreshes its saved-profile list. */
const PROFILES_CHANGED = 'ssh-terminal:profiles-changed'
function announceProfilesChanged(): void {
  window.dispatchEvent(new CustomEvent(PROFILES_CHANGED))
}

// Static markup (no interpolation of untrusted data; CSP-safe).
const TEMPLATE = `
  <form class="card connect-card" autocomplete="off">
    <h2>New SSH Connection</h2>

    <section class="saved-section hidden">
      <div class="section-label">Saved profiles</div>
      <ul class="profile-list"></ul>
    </section>
    <button type="button" class="f-import btn-secondary">Import from ~/.ssh/config</button>
    <p class="hint f-import-hint hidden"></p>

    <label>Host <input class="f-host" type="text" placeholder="example.com" required /></label>
    <label>Port <input class="f-port" type="number" value="22" min="1" max="65535" /></label>
    <label>Username <input class="f-user" type="text" required /></label>
    <label>Authentication
      <select class="f-auth">
        <option value="password">Password</option>
        <option value="key">Private key</option>
        <option value="agent">SSH agent</option>
      </select>
    </label>

    <div class="auth-group auth-password">
      <label>Password <input class="f-pass" type="password" /></label>
      <label class="checkbox"><input class="f-save-pass" type="checkbox" /> Save password</label>
    </div>
    <div class="auth-group auth-key hidden">
      <label>Key file
        <span class="file-row">
          <input class="f-keypath" type="text" placeholder="C:\\Users\\you\\.ssh\\id_ed25519" />
          <button type="button" class="f-browse btn-secondary">Browse…</button>
        </span>
      </label>
      <label>Passphrase <input class="f-passphrase" type="password" placeholder="(blank if unencrypted)" /></label>
      <label class="checkbox"><input class="f-save-passphrase" type="checkbox" /> Save passphrase</label>
    </div>
    <div class="auth-group auth-agent hidden">
      <p class="hint">Uses the Windows OpenSSH agent (\\\\.\\pipe\\openssh-ssh-agent) or $SSH_AUTH_SOCK.</p>
    </div>

    <label class="checkbox"><input class="f-save-profile" type="checkbox" /> Save as profile</label>
    <label class="profile-name-row hidden">Profile name <input class="f-profile-name" type="text" placeholder="My server" /></label>

    <p class="hint f-hint"></p>
    <p class="error" role="alert"></p>
    <button type="submit">Connect</button>
  </form>
`

/**
 * Creates a self-contained connect view (its own DOM) so each tab can host one.
 * Supports password / private-key / agent auth, lists saved profiles + recents
 * for one-click reconnect, and calls `onConnect` with a validated request.
 */
export function createConnectForm(onConnect: (req: ConnectRequest) => void): ConnectFormHandle {
  const view = document.createElement('div')
  view.className = 'overlay'
  view.innerHTML = TEMPLATE

  const q = <T extends HTMLElement>(sel: string): T => {
    const node = view.querySelector<T>(sel)
    if (!node) throw new Error(`connect-form: missing ${sel}`)
    return node
  }

  const form = q<HTMLFormElement>('form')
  const host = q<HTMLInputElement>('.f-host')
  const port = q<HTMLInputElement>('.f-port')
  const user = q<HTMLInputElement>('.f-user')
  const authSelect = q<HTMLSelectElement>('.f-auth')
  const pass = q<HTMLInputElement>('.f-pass')
  const savePass = q<HTMLInputElement>('.f-save-pass')
  const keyPath = q<HTMLInputElement>('.f-keypath')
  const browse = q<HTMLButtonElement>('.f-browse')
  const passphrase = q<HTMLInputElement>('.f-passphrase')
  const savePassphrase = q<HTMLInputElement>('.f-save-passphrase')
  const saveProfile = q<HTMLInputElement>('.f-save-profile')
  const profileNameRow = q<HTMLElement>('.profile-name-row')
  const profileName = q<HTMLInputElement>('.f-profile-name')
  const hintEl = q<HTMLElement>('.f-hint')
  const errorEl = q<HTMLElement>('.error')
  const submit = q<HTMLButtonElement>('button[type="submit"]')

  const groups: Record<AuthKind, HTMLElement> = {
    password: q<HTMLElement>('.auth-password'),
    key: q<HTMLElement>('.auth-key'),
    agent: q<HTMLElement>('.auth-agent')
  }

  const savedSection = q<HTMLElement>('.saved-section')
  const profileList = q<HTMLUListElement>('.profile-list')

  const selectedKind = (): AuthKind => authSelect.value as AuthKind

  function applyAuthVisibility(): void {
    const kind = selectedKind()
    for (const [k, group] of Object.entries(groups)) {
      group.classList.toggle('hidden', k !== kind)
    }
    void refreshHint()
  }

  authSelect.addEventListener('change', applyAuthVisibility)
  saveProfile.addEventListener('change', () => {
    profileNameRow.classList.toggle('hidden', !saveProfile.checked)
  })

  const importBtn = q<HTMLButtonElement>('.f-import')
  const importHint = q<HTMLElement>('.f-import-hint')
  importBtn.addEventListener('click', () => {
    importBtn.disabled = true
    importHint.classList.remove('hidden')
    importHint.textContent = 'Importing…'
    window.ssh
      .importSshConfig()
      .then(({ imported, skipped }) => {
        importHint.textContent =
          imported === 0 && skipped === 0
            ? 'No importable Host entries found.'
            : `Imported ${imported} host${imported === 1 ? '' : 's'}` +
              (skipped ? ` (${skipped} already existed)` : '') +
              '.'
        if (imported > 0) announceProfilesChanged()
      })
      .catch((err: unknown) => {
        importHint.textContent = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        importBtn.disabled = false
      })
  })

  browse.addEventListener('click', () => {
    void window.ssh.pickKeyFile().then((path) => {
      if (path) {
        keyPath.value = path
        void refreshHint()
      }
    })
  })

  // --- Saved-secret hints --------------------------------------------------
  async function refreshHint(): Promise<void> {
    const kind = selectedKind()
    if (kind === 'password') {
      const h = host.value.trim()
      const u = user.value.trim()
      const p = Number(port.value) || 22
      if (h && u && (await window.ssh.hasPassword(h, p, u))) {
        hintEl.textContent = 'A saved password will be used. Type a new one to replace it.'
        pass.placeholder = '•••••••• (saved)'
        return
      }
      pass.placeholder = ''
    } else if (kind === 'key' && keyPath.value.trim()) {
      if (await window.ssh.hasPassphrase(keyPath.value.trim())) {
        hintEl.textContent = 'A saved passphrase will be used. Type a new one to replace it.'
        passphrase.placeholder = '•••••••• (saved)'
        return
      }
      passphrase.placeholder = '(blank if unencrypted)'
    }
    hintEl.textContent = ''
  }

  for (const inputEl of [host, port, user, keyPath]) {
    inputEl.addEventListener('change', () => void refreshHint())
  }

  // --- Building requests ---------------------------------------------------
  function readAuthFromFields(): AuthMethod {
    switch (selectedKind()) {
      case 'password':
        return { kind: 'password', password: pass.value || undefined }
      case 'key':
        return {
          kind: 'key',
          keyPath: keyPath.value.trim(),
          passphrase: passphrase.value || undefined
        }
      case 'agent':
        return { kind: 'agent' }
    }
  }

  function saveSecretFlag(): boolean {
    switch (selectedKind()) {
      case 'password':
        return savePass.checked
      case 'key':
        return savePassphrase.checked
      case 'agent':
        return false
    }
  }

  /** Strip secrets from an auth method for storage in a profile. */
  function sanitizeAuth(auth: AuthMethod): AuthMethod {
    switch (auth.kind) {
      case 'password':
        return { kind: 'password' }
      case 'key':
        return { kind: 'key', keyPath: auth.keyPath }
      case 'agent':
        return { kind: 'agent' }
    }
  }

  async function handleSubmit(): Promise<void> {
    errorEl.textContent = ''
    const h = host.value.trim()
    const u = user.value.trim()
    const p = Number(port.value) || 22
    const kind = selectedKind()

    if (!h || !u) {
      errorEl.textContent = 'Host and username are required.'
      return
    }
    if (kind === 'key' && !keyPath.value.trim()) {
      errorEl.textContent = 'Choose a private key file.'
      return
    }
    if (kind === 'password' && !pass.value && !(await window.ssh.hasPassword(h, p, u))) {
      errorEl.textContent = 'Enter a password (none is saved for these credentials).'
      return
    }

    const auth = readAuthFromFields()

    if (saveProfile.checked) {
      const name = profileName.value.trim()
      if (!name) {
        errorEl.textContent = 'Enter a name for the profile.'
        return
      }
      const profile: Profile = {
        id: '',
        name,
        host: h,
        port: p,
        username: u,
        auth: sanitizeAuth(auth),
        saveSecret: saveSecretFlag()
      }
      await window.ssh.saveProfile(profile)
      announceProfilesChanged()
    }

    onConnect({ host: h, port: p, username: u, auth, saveSecret: saveSecretFlag() })
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void handleSubmit()
  })

  // --- Profiles + recents --------------------------------------------------

  /** Populate fields from a saved profile or recent (no secrets). */
  function loadInto(host_: string, port_: number, user_: string, auth: AuthMethod): void {
    host.value = host_
    port.value = String(port_)
    user.value = user_
    authSelect.value = auth.kind
    pass.value = ''
    passphrase.value = ''
    keyPath.value = auth.kind === 'key' ? auth.keyPath : ''
    applyAuthVisibility()
  }

  function reqFor(host_: string, port_: number, user_: string, auth: AuthMethod): ConnectRequest {
    return { host: host_, port: port_, username: user_, auth, saveSecret: false }
  }

  /**
   * Load a target into the form, then connect immediately when no secret is
   * needed (agent, or a saved password/passphrase). Otherwise focus the secret
   * field so the user just types it and presses Connect.
   */
  async function activate(
    host_: string,
    port_: number,
    user_: string,
    auth: AuthMethod
  ): Promise<void> {
    loadInto(host_, port_, user_, auth)
    if (auth.kind === 'agent') {
      onConnect(reqFor(host_, port_, user_, auth))
      return
    }
    if (auth.kind === 'password') {
      if (await window.ssh.hasPassword(host_, port_, user_)) {
        onConnect(reqFor(host_, port_, user_, auth))
      } else {
        pass.focus()
      }
      return
    }
    // key
    if (await window.ssh.hasPassphrase(auth.keyPath)) {
      onConnect(reqFor(host_, port_, user_, auth))
    } else {
      passphrase.focus()
    }
  }

  function authLabel(auth: AuthMethod): string {
    switch (auth.kind) {
      case 'password':
        return 'password'
      case 'key':
        return 'key'
      case 'agent':
        return 'agent'
    }
  }

  function renderProfiles(profiles: Profile[]): void {
    profileList.replaceChildren()
    savedSection.classList.toggle('hidden', profiles.length === 0)
    for (const profile of profiles) {
      const li = document.createElement('li')
      li.className = 'list-row'

      const openBtn = document.createElement('button')
      openBtn.type = 'button'
      openBtn.className = 'list-main'
      const nameSpan = document.createElement('span')
      nameSpan.className = 'list-name'
      nameSpan.textContent = profile.name
      const metaSpan = document.createElement('span')
      metaSpan.className = 'list-meta'
      metaSpan.textContent = `${profile.username}@${profile.host}:${profile.port} · ${authLabel(profile.auth)}`
      openBtn.append(nameSpan, metaSpan)
      openBtn.addEventListener('click', () => {
        void activate(profile.host, profile.port, profile.username, profile.auth)
      })

      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'list-del'
      del.title = 'Delete profile'
      del.textContent = '×'
      del.addEventListener('click', (e) => {
        e.stopPropagation()
        void window.ssh.deleteProfile(profile.id).then(announceProfilesChanged)
      })

      li.append(openBtn, del)
      profileList.appendChild(li)
    }
  }

  async function refreshLists(): Promise<void> {
    renderProfiles(await window.ssh.listProfiles())
  }

  const onProfilesChanged = (): void => void refreshLists()
  window.addEventListener(PROFILES_CHANGED, onProfilesChanged)

  applyAuthVisibility()

  return {
    element: view,
    show: () => {
      view.style.display = 'flex'
      void refreshLists()
      void refreshHint()
    },
    hide: () => {
      view.style.display = 'none'
    },
    focus: () => host.focus(),
    setError: (message) => {
      errorEl.textContent = message
    },
    setBusy: (busy) => {
      submit.disabled = busy
      submit.textContent = busy ? 'Connecting…' : 'Connect'
    },
    prefill: (req) => loadInto(req.host, req.port, req.username, req.auth),
    openTarget: (host_, port_, user_, auth) => void activate(host_, port_, user_, auth),
    dispose: () => {
      window.removeEventListener(PROFILES_CHANGED, onProfilesChanged)
    }
  }
}
