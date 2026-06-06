import type { SshApi } from './index'

// Makes `window.ssh` strongly typed in the renderer.
declare global {
  interface Window {
    ssh: SshApi
  }
}

export {}
