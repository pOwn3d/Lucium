// `sync.json` of the data folder (docs/synchronisation.md §3.3): the switch of the synchronisation (OFF by default, on every device), what is synchronised, the
// port the Mac listens on, and the devices it is paired with. It is next to state.json and never part of it: no export, no backup and no copy of the session carries
// it, and the list of the devices and the settings of the synchronisation are never themselves synchronised (§10.5).
//
// The file is hostile input like any other (bounded, strictly read). A file that cannot be read is moved aside and the synchronisation starts again from its
// defaults: OFF, nothing paired. A device is known by its fingerprint: the name it gave is only what the person reads, and never what recognises it.

import { existsSync } from 'node:fs'
import { replaceFileDurably } from '../durable-write'
import { readTextBounded, setAsideOrHold, SMALL_FILE_MAX_BYTES } from '../persist'
import { DEFAULT_SYNC_CATEGORIES, SYNC_CATEGORIES, type SyncCategory } from '@shared/sync-ipc'
import { MAX_DEVICE_ID_CHARS, MAX_DEVICE_NAME_CHARS } from './limits'

const VERSION = 1

export { SYNC_CATEGORIES, type SyncCategory } from '@shared/sync-ipc'
/** [Q2]: only the structure is ticked by default (shared/sync-ipc.ts: the page shows the same figures). */
export const DEFAULT_CATEGORIES: Readonly<Record<SyncCategory, boolean>> = DEFAULT_SYNC_CATEGORIES

/** The ports the Mac may listen on: chosen once at random in the range of the dynamic ports, kept, and drawn again only when it is taken. */
export const PORT_MIN = 49_152
export const PORT_MAX = 65_535

const isPort = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= PORT_MIN && value <= PORT_MAX

/** A person has a Mac and a few iPhones: a list longer than this is a file that is not one of ours. */
export const MAX_PEERS = 16

export interface PeerRecord {
  id: string
  name: string
  platform: 'mac' | 'ios'
  /** The SHA-256 of the certificate of the device, in lower-case hexadecimal (64 characters). */
  fingerprint: string
  pairedAt: number
  lastSessionAt: number | null
}

export interface SyncConfig {
  version: typeof VERSION
  enabled: boolean
  categories: Record<SyncCategory, boolean>
  port: number | null
  peers: PeerRecord[]
}

const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/
const FINGERPRINT = /^[0-9a-f]{64}$/

const defaults = (): SyncConfig => ({ version: VERSION, enabled: false, categories: { ...DEFAULT_CATEGORIES }, port: null, peers: [] })

function readPeer(value: unknown): PeerRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { id, name, platform, fingerprint, pairedAt, lastSessionAt } = value as Record<string, unknown>
  if (typeof id !== 'string' || !DEVICE_ID.test(id) || id.length > MAX_DEVICE_ID_CHARS) return null
  if (typeof name !== 'string' || name.length === 0 || [...name].length > MAX_DEVICE_NAME_CHARS) return null
  if (platform !== 'mac' && platform !== 'ios') return null
  if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) return null
  if (typeof pairedAt !== 'number' || !Number.isFinite(pairedAt)) return null
  if (lastSessionAt !== null && (typeof lastSessionAt !== 'number' || !Number.isFinite(lastSessionAt))) return null
  return { id, name, platform, fingerprint, pairedAt, lastSessionAt }
}

/** The configuration a text holds. Throws on anything that is not a file of this version: the caller sets the file aside. */
function parseConfig(text: string): SyncConfig {
  const raw: unknown = JSON.parse(text)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('not an object')
  const r = raw as Record<string, unknown>
  if (r['version'] !== VERSION) throw new Error(`version ${String(r['version'])} is not ${VERSION}`)
  const categories = { ...DEFAULT_CATEGORIES }
  const given = r['categories']
  if (typeof given === 'object' && given !== null && !Array.isArray(given)) {
    for (const category of SYNC_CATEGORIES) if (typeof (given as Record<string, unknown>)[category] === 'boolean') categories[category] = (given as Record<string, boolean>)[category] as boolean
  }
  const port = r['port']
  if (port !== null && !isPort(port)) throw new Error('port out of range')
  if (!Array.isArray(r['peers']) || r['peers'].length > MAX_PEERS) throw new Error('peers is not a short list')
  const peers = r['peers'].map(readPeer)
  if (peers.some((peer) => peer === null)) throw new Error('a device of the list is not valid')
  const list = peers as PeerRecord[]
  if (new Set(list.map((peer) => peer.fingerprint)).size !== list.length || new Set(list.map((peer) => peer.id)).size !== list.length) throw new Error('a device is listed twice')
  return { version: VERSION, enabled: r['enabled'] === true, categories, port, peers: list }
}

export class SyncStore {
  private current: SyncConfig

  constructor(private readonly path: string) {
    this.current = this.read()
  }

  private read(): SyncConfig {
    if (!existsSync(this.path)) return defaults()
    try {
      return parseConfig(readTextBounded(this.path, SMALL_FILE_MAX_BYTES))
    } catch (error) {
      // Never silently discarded: the file is moved aside (and the person told, persistence-notices.ts), and the synchronisation starts again OFF with nothing paired.
      setAsideOrHold(this.path, error, 'sync')
      return defaults()
    }
  }

  /** A copy: what the caller changes is not the store's. */
  config(): SyncConfig {
    return { ...this.current, categories: { ...this.current.categories }, peers: this.current.peers.map((peer) => ({ ...peer })) }
  }

  /** The new configuration is written first and only then becomes the current one: a write that fails leaves the store as it was, and throws. */
  private commit(next: SyncConfig): void {
    replaceFileDurably(this.path, `${JSON.stringify(next, null, 2)}\n`)
    this.current = next
  }

  private change(edit: (draft: SyncConfig) => void): void {
    const draft = this.config()
    edit(draft)
    this.commit(draft)
  }

  setEnabled(enabled: boolean): void {
    this.change((draft) => void (draft.enabled = enabled))
  }

  setCategory(category: SyncCategory, on: boolean): void {
    this.change((draft) => void (draft.categories[category] = on))
  }

  /** The port: drawn once with `pick` and kept. `replacePort` draws another one, when the first is taken at the launch. */
  port(pick: () => number): number {
    if (this.current.port !== null) return this.current.port
    const port = pick()
    this.replacePort(port)
    return port
  }

  replacePort(port: number): void {
    if (!isPort(port)) throw new Error(`${String(port)} is not a port of the dynamic range`)
    this.change((draft) => void (draft.port = port))
  }

  peers(): PeerRecord[] {
    return this.config().peers
  }

  findByFingerprint(fingerprint: string): PeerRecord | undefined {
    return this.current.peers.find((peer) => peer.fingerprint === fingerprint)
  }

  /**
   * Keeps a device paired. The same device paired again (same identifier, or same fingerprint) takes the place of its old entry, which is how a person pairs again
   * after a reinstallation; another device is added. Throws when the list is full: the person forgets one first.
   */
  addPeer(peer: PeerRecord): void {
    this.change((draft) => {
      draft.peers = draft.peers.filter((one) => one.id !== peer.id && one.fingerprint !== peer.fingerprint)
      if (draft.peers.length >= MAX_PEERS) throw new Error(`more than ${MAX_PEERS} devices are paired`)
      draft.peers.push({ ...peer })
    })
  }

  /** Whether the device was in the list. A device forgotten here is refused at the next connection, whatever the other side still believes (§12). */
  forgetPeer(id: string): boolean {
    if (!this.current.peers.some((peer) => peer.id === id)) return false
    this.change((draft) => void (draft.peers = draft.peers.filter((peer) => peer.id !== id)))
    return true
  }

  /** The list is forgotten whole (an identity that was replaced: the fingerprints it listed were of the old one). */
  clearPeers(): void {
    if (this.current.peers.length > 0) this.change((draft) => void (draft.peers = []))
  }

  /** The end of a session that went through: when the list shows « il y a 2 min ». */
  touchSession(id: string, at: number): void {
    if (!this.current.peers.some((peer) => peer.id === id)) return
    this.change((draft) => {
      const peer = draft.peers.find((one) => one.id === id)
      if (peer !== undefined) peer.lastSessionAt = at
    })
  }
}
