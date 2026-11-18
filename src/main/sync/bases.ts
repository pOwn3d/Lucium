// The base of each paired device (docs/synchronisation.md §11.8, §3.3): the merged snapshot of the last session that went through, the « base » of the next three-way
// merge. One file per device, next to state.json and never inside it (`sync-base-<id>.json`). A file is hostile input: bounded, and read through `parseSnapshot`.
// A base older than thirty days is not used: the tombstones that told the deletions have been purged (§11.5), and the merge starts from an empty base.

import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson } from '@shared/sync-canonical'
import { parseSnapshot, type SyncSnapshot } from '@shared/sync-snapshot'
import { replaceFileDurably } from '../durable-write'
import { readTextBounded } from '../persist'
import { MAX_SNAPSHOT_BYTES, TOMBSTONE_DAYS } from './limits'

const VERSION = 1
const DAY_MS = 86_400_000
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/

export interface StoredBase {
  snapshot: SyncSnapshot
  savedAt: number
  /** The SHA-256 of the canonical form of the snapshot: what `hello.baseHash` carries. */
  hash: string
}

export const hashOfSnapshot = (snapshot: SyncSnapshot): string => createHash('sha256').update(canonicalJson(snapshot)).digest('hex')

export class BaseStore {
  constructor(private readonly dir: string) {}

  private path(peerId: string): string {
    if (!DEVICE_ID.test(peerId)) throw new Error('a device identifier is not a file name')
    return join(this.dir, `sync-base-${peerId}.json`)
  }

  /** The base of a device, or null when there is none, when it is older than thirty days, or when the file cannot be used (the reason is logged: the merge then starts empty). */
  get(peerId: string, now: number): StoredBase | null {
    const path = this.path(peerId)
    if (!existsSync(path)) return null
    try {
      const raw = JSON.parse(readTextBounded(path, MAX_SNAPSHOT_BYTES)) as { version?: unknown; savedAt?: unknown; snapshot?: unknown }
      if (raw.version !== VERSION || typeof raw.savedAt !== 'number' || !Number.isFinite(raw.savedAt)) throw new Error('not a base of this version')
      const parsed = parseSnapshot(raw.snapshot)
      if ('problem' in parsed) throw new Error(parsed.problem)
      if (now - raw.savedAt > TOMBSTONE_DAYS * DAY_MS) return null
      return { snapshot: parsed.snapshot, savedAt: raw.savedAt, hash: hashOfSnapshot(parsed.snapshot) }
    } catch (error) {
      console.error(`[sync] the base of ${peerId} cannot be used, the next merge starts from an empty one:`, error)
      return null
    }
  }

  /** Written whole and moved into place (a crash leaves the old base); throws when it cannot be written, so that the session says `internal` instead of `commit`. */
  save(peerId: string, snapshot: SyncSnapshot, now: number): StoredBase {
    replaceFileDurably(this.path(peerId), `${JSON.stringify({ version: VERSION, savedAt: now, snapshot })}\n`)
    return { snapshot, savedAt: now, hash: hashOfSnapshot(snapshot) }
  }

  remove(peerId: string): void {
    rmSync(this.path(peerId), { force: true })
  }
}
