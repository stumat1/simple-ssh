import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Stores secrets (passwords/passphrases) encrypted with the OS keystore via
 * Electron's safeStorage (DPAPI on Windows). Only ciphertext is written to
 * disk; plaintext is never persisted. Keyed by an opaque id (e.g.
 * `user@host:port`).
 */
export class SecretStore {
  private data: Record<string, string> = {} // id -> base64 ciphertext

  constructor(private readonly filePath: string) {
    this.load()
  }

  /** Whether OS-backed encryption is usable. If false, we refuse to persist. */
  get available(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        this.data = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, string>
      }
    } catch {
      this.data = {}
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), { mode: 0o600 })
  }

  has(id: string): boolean {
    return id in this.data
  }

  /** Encrypt and persist a secret. Returns false if encryption is unavailable. */
  set(id: string, plaintext: string): boolean {
    if (!this.available) return false
    this.data[id] = safeStorage.encryptString(plaintext).toString('base64')
    this.save()
    return true
  }

  /** Decrypt a stored secret, or null if absent/unavailable/corrupt. */
  get(id: string): string | null {
    if (!this.available) return null
    const ciphertext = this.data[id]
    if (!ciphertext) return null
    try {
      return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
    } catch {
      return null
    }
  }

  delete(id: string): void {
    if (id in this.data) {
      delete this.data[id]
      this.save()
    }
  }
}
