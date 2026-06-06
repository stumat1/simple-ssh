// Central registry of IPC channel names. Keeping these as string constants in one
// place keeps main, preload, and renderer in sync and avoids typo-based bugs.

export const IPC = {
  // Renderer -> Main, request/response via invoke/handle
  APP_VERSION: 'app:version',
  SSH_CONNECT: 'ssh:connect',
  SSH_DISCONNECT: 'ssh:disconnect',
  HOSTKEY_DECISION: 'hostkey:decision',
  KBD_RESPONSE: 'ssh:keyboard-interactive-response',

  // Secrets (passwords / key passphrases). Only presence/forget are exposed to
  // the renderer; plaintext never crosses the bridge.
  SECRET_HAS_PASSWORD: 'secret:has-password',
  SECRET_FORGET_PASSWORD: 'secret:forget-password',
  SECRET_HAS_PASSPHRASE: 'secret:has-passphrase',
  SECRET_FORGET_PASSPHRASE: 'secret:forget-passphrase',

  // Saved profiles + recent connections
  PROFILES_LIST: 'profiles:list',
  PROFILES_SAVE: 'profiles:save',
  PROFILES_DELETE: 'profiles:delete',
  RECENTS_LIST: 'recents:list',

  // Misc helpers
  KEY_PICK: 'key:pick',
  CLIPBOARD_READ: 'clipboard:read',
  CLIPBOARD_WRITE: 'clipboard:write',

  // Renderer -> Main, fire-and-forget via send/on
  SSH_INPUT: 'ssh:input',
  SSH_RESIZE: 'ssh:resize',

  // Main -> Renderer, streamed events via send/on
  SSH_DATA: 'ssh:data',
  SSH_STATUS: 'ssh:status',
  SSH_ERROR: 'ssh:error',
  HOSTKEY_PROMPT: 'ssh:hostkey-prompt',
  KBD_PROMPT: 'ssh:keyboard-interactive'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
