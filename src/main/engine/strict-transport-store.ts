// The hosts a session holds as strict (strict-transport.ts), kept from one run to the next: one small file in the folder Chromium gives the
// session, read when the session is set up and written a moment after what it holds changed. Only a session that keeps its data on disk has
// one. A write that still waits when the application quits is made then (`flushPending`). The file names no site: each host is there as the SHA-256 of its name. It is erased with the data of the session.
// No Electron here: the engine hands the folder in, so the rules are tested against real files.

import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '@shared/record'
import { replaceFileDurably } from '../durable-write'
import { strictTransportHosts, type StrictTransportHosts } from './strict-transport'

/** The name of the file, in the storage folder of the session. */
export const STRICT_TRANSPORT_FILE = 'Strict Transport Hosts.json'

/** The file is not written at each answer: once, this long after the first change. A quit in between writes it at once (`flushPending`); only a crash loses that last moment. */
const WRITE_DELAY_MS = 1000

/** The part of an Electron `Session` read here: the folder of its data, null for a session that lives in memory (a private window). */
export interface StoredSession {
  getStoragePath(): string | null
}

const fileOf = (session: StoredSession): string | null => {
  const folder = session.getStoragePath()
  return folder ? join(folder, STRICT_TRANSPORT_FILE) : null
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class StrictTransportStore {
  private readonly files = new WeakMap<object, string>()
  private readonly timers = new WeakMap<object, ReturnType<typeof setTimeout>>()
  /** The sessions whose write waits: a weak map cannot be listed, and the quit has to find them. Held only for that moment. */
  private readonly waiting = new Set<object>()

  constructor(
    private readonly hosts: Pick<StrictTransportHosts, 'records' | 'restore' | 'forget' | 'onChange'>,
    private readonly delayMs = WRITE_DELAY_MS
  ) {
    hosts.onChange((session) => this.schedule(session))
  }

  /**
   * A session that keeps its data on disk: what an earlier run held is read back, once, and what this run learns is written in its folder. A
   * session in memory has no file. A file that is not there yet is the first run. One that cannot be read or is not what this module writes is
   * said in the journal, and the session starts with nothing held: the next write replaces it.
   */
  attach(session: StoredSession): void {
    if (this.files.has(session)) return
    const file = fileOf(session)
    if (file === null) return
    this.files.set(session, file)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[engine] cannot read the hosts held to strict transport security (${file}), so none is held until they are seen again:`, messageOf(error))
      return
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (!isRecord(parsed) || parsed['version'] !== 1 || !Array.isArray(parsed['hosts'])) throw new Error('not a list of hosts of version 1')
      this.hosts.restore(session, parsed['hosts'])
    } catch (error) {
      console.error(`[engine] the file of the hosts held to strict transport security is damaged (${file}), so none is held until they are seen again:`, messageOf(error))
    }
  }

  private schedule(session: object): void {
    if (!this.files.has(session) || this.timers.has(session)) return
    const timer = setTimeout(() => this.flush(session), this.delayMs)
    // A write that waits must not keep the application from quitting.
    timer.unref()
    this.timers.set(session, timer)
    this.waiting.add(session)
  }

  /**
   * The application quits: every write that waited is made now, so that a host first seen in the last moment is still held at the next launch.
   * The timers do not keep the process alive, so without this they would never fire. A session whose file cannot be written is said in the
   * journal (`flush`) and the others are still written. Answers how many files were written or tried.
   */
  flushPending(): number {
    const sessions = [...this.waiting]
    for (const session of sessions) this.flush(session)
    return sessions.length
  }

  /** Writes what the session holds now, whole, in place of its file. A failure is said in the journal; the next change tries again. */
  flush(session: object): void {
    const timer = this.timers.get(session)
    if (timer) clearTimeout(timer)
    this.timers.delete(session)
    this.waiting.delete(session)
    const file = this.files.get(session)
    if (file === undefined) return
    try {
      // Whole beside the file, then moved over it: a crash in the middle leaves the file as it was, and a failure leaves no copy beside it.
      replaceFileDurably(file, JSON.stringify({ version: 1, hosts: this.hosts.records(session) }))
    } catch (error) {
      console.error(`[engine] cannot write the hosts held to strict transport security (${file}), so they will be forgotten at the next launch:`, messageOf(error))
    }
  }

  /**
   * The data of the session is erased: the hosts it held go, in memory and on disk (also for a session nothing was read for in this run: a
   * container erased while closed), and a write that waited is dropped. Throws when the file cannot be removed, so that nobody says "erased"
   * for a session that kept it.
   */
  forget(session: StoredSession): void {
    const timer = this.timers.get(session)
    if (timer) clearTimeout(timer)
    this.timers.delete(session)
    this.waiting.delete(session)
    this.hosts.forget(session)
    const file = this.files.get(session) ?? fileOf(session)
    if (file !== null) rmSync(file, { force: true })
  }
}

/** The store of the application, on the record the certificate errors read. */
export const strictTransportStore = new StrictTransportStore(strictTransportHosts)
