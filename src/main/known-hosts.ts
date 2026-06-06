import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** OpenSSH-style SHA256 fingerprint (base64, no padding) of a raw host key. */
export function fingerprintOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

export type HostKeyCheck =
  | { status: 'match' }
  | { status: 'unknown'; fingerprint: string }
  | { status: 'changed'; fingerprint: string; knownFingerprint: string }

interface StoredEntry {
  /** Base64 of the raw host key (authoritative for comparison). */
  key: string
  /** Cached fingerprint for display. */
  fingerprint: string
}

/**
 * Persistent known-hosts store keyed by `host:port`, backed by a JSON file.
 * Compares the full key (not just the fingerprint) to decide match/changed.
 * Pure (fs + crypto only) so it can be unit-tested with a temp path.
 */
export class KnownHostsStore {
  private entries: Record<string, StoredEntry> = {}

  constructor(private readonly filePath: string) {
    this.load()
  }

  private static id(host: string, port: number): string {
    return `${host}:${port}`
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        this.entries = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<
          string,
          StoredEntry
        >
      }
    } catch {
      // Corrupt/unreadable store — start empty rather than crash.
      this.entries = {}
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), { mode: 0o600 })
  }

  /** Classify a presented host key against what we have stored. */
  check(host: string, port: number, key: Buffer): HostKeyCheck {
    const fingerprint = fingerprintOf(key)
    const existing = this.entries[KnownHostsStore.id(host, port)]
    if (!existing) return { status: 'unknown', fingerprint }
    if (existing.key === key.toString('base64')) return { status: 'match' }
    return { status: 'changed', fingerprint, knownFingerprint: existing.fingerprint }
  }

  /** Persist (or replace) the trusted key for a host. */
  trust(host: string, port: number, key: Buffer): void {
    this.entries[KnownHostsStore.id(host, port)] = {
      key: key.toString('base64'),
      fingerprint: fingerprintOf(key)
    }
    this.save()
  }
}
