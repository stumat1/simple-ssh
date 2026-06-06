import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AuthMethod, Profile, RecentConnection } from '@shared/types'

interface PersistShape {
  profiles: Profile[]
  recents: RecentConnection[]
}

const MAX_RECENTS = 8

/** Strip secrets from an auth method before it touches disk. */
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

function recentKey(host: string, port: number, username: string): string {
  return `${username}@${host}:${port}`
}

/**
 * Persists saved connection profiles and a capped most-recent-used list to a
 * JSON file in userData. Secrets are never stored here — only references
 * (host/port/user/keyPath); passwords/passphrases live in the SecretStore.
 * Pure (fs only) so it can be unit-tested with a temp path.
 */
export class ProfileStore {
  private data: PersistShape = { profiles: [], recents: [] }

  constructor(private readonly filePath: string) {
    this.load()
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PersistShape>
        this.data = {
          profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
          recents: Array.isArray(parsed.recents) ? parsed.recents : []
        }
      }
    } catch {
      // Corrupt/unreadable store — start empty rather than crash.
      this.data = { profiles: [], recents: [] }
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), { mode: 0o600 })
  }

  list(): Profile[] {
    return this.data.profiles
  }

  /** Create or update a profile (upsert by id). Returns the stored profile. */
  save(input: Profile): Profile {
    const profile: Profile = {
      ...input,
      id: input.id || randomUUID(),
      auth: sanitizeAuth(input.auth)
    }
    const index = this.data.profiles.findIndex((p) => p.id === profile.id)
    if (index >= 0) this.data.profiles[index] = profile
    else this.data.profiles.push(profile)
    this.persist()
    return profile
  }

  delete(id: string): void {
    const next = this.data.profiles.filter((p) => p.id !== id)
    if (next.length !== this.data.profiles.length) {
      this.data.profiles = next
      this.persist()
    }
  }

  recents(): RecentConnection[] {
    return this.data.recents
  }

  /** Record a successful connection at the head of the recents list (deduped). */
  recordRecent(host: string, port: number, username: string, auth: AuthMethod): void {
    const key = recentKey(host, port, username)
    const filtered = this.data.recents.filter((r) => recentKey(r.host, r.port, r.username) !== key)
    filtered.unshift({ host, port, username, auth: sanitizeAuth(auth), lastUsed: Date.now() })
    this.data.recents = filtered.slice(0, MAX_RECENTS)
    this.persist()
  }
}
