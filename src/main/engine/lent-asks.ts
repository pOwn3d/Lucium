// What the main process has asked the worker of an extension for the scripts it runs in lent tabs (a message for its listeners, a call of its storage), and has not had the answer to.
// A script of a tab can write as fast as it likes, and an answer may never come (a listener that returns true and forgets), so what is kept is bounded: for each extension in each profile, a few
// asks run at once and a few more wait their turn, the text they carry has a budget, and each ask ends after a time, when its tab goes to another document or closes, when the worker that held
// it stops, or when the extension is unloaded. What cannot be kept is answered at once, with the words of a port that closed. The answer of a worker is read by the engine (shared/lent-tab-runtime.ts).

import { randomUUID } from 'node:crypto'
import { LENT_BUDGET_CHARACTERS, PORT_CLOSED, TOO_LONG } from '@shared/lent-tab-runtime'

/** How long an ask waits (its turn included) for the answer: a listener that returns true may answer late, and never answering must not hold a promise, a timer and a text for ever. */
export const ANSWER_WAIT_MS = 5 * 60 * 1000

/** What is kept for one extension in one profile: asks at the worker at once, asks waiting for their turn, and the characters of the JSON of all of them (the text of the message, kept until it is sent). */
export const LENT_ASK_LIMITS = { running: 32, waiting: 256, characters: LENT_BUDGET_CHARACTERS } as const

type Answer = unknown

interface Entry {
  id: string
  profileId: string
  extensionId: string
  /** `profile:extension`. */
  key: string
  tab: number
  op: 'message' | 'storage'
  /** What the worker is sent; let go of once it has been. */
  payload: unknown
  characters: number
  started: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  settle: (answer: Answer) => void
}

/** What the worker is asked with: its extension, the id the answer will carry, the operation and its text. Rejects when the worker does not start. */
export type LentAskSender = (profileId: string, extensionId: string, id: string, op: 'message' | 'storage', payload: unknown) => Promise<void>

const refused = (): Answer => ({ ok: false, error: PORT_CLOSED })
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class LentAsks {
  private readonly entries = new Map<string, Entry>()
  private readonly queues = new Map<string, Entry[]>()
  private readonly books = new Map<string, { running: number; characters: number }>()

  constructor(
    private readonly send: LentAskSender,
    private readonly limits: { readonly running: number; readonly waiting: number; readonly characters: number } = LENT_ASK_LIMITS,
    private readonly waitMs: number = ANSWER_WAIT_MS
  ) {}

  /** How many asks are kept, running or waiting. */
  get size(): number {
    return this.entries.size
  }

  /**
   * Asks the worker of the extension, now if it has a free place, after the others otherwise. Always resolves: with what the worker answers, or with the words of a port that closed when the
   * ask could not be kept, was not answered in time, or lost its tab or its worker, or with the reason the worker could not be asked.
   */
  ask(profileId: string, extensionId: string, tabNumber: number, op: 'message' | 'storage', payload: unknown, characters: number): Promise<Answer> {
    if (!this.canKeep(profileId, extensionId, characters)) return Promise.resolve(refused())
    const key = `${profileId}:${extensionId}`
    const book = this.books.get(key) ?? { running: 0, characters: 0 }
    const queue = this.queues.get(key) ?? []
    return new Promise<Answer>((resolve) => {
      const entry: Entry = { id: randomUUID(), profileId, extensionId, key, tab: tabNumber, op, payload, characters, started: false, timer: undefined, settle: resolve }
      entry.timer = setTimeout(() => this.finish(entry, refused()), this.waitMs)
      this.entries.set(entry.id, entry)
      book.characters += characters
      this.books.set(key, book)
      if (book.running < this.limits.running) this.start(entry)
      else {
        queue.push(entry)
        this.queues.set(key, queue)
      }
    })
  }

  /**
   * Whether an ask of this many characters would be kept now. Asked before the text of a call is parsed: what would be refused is refused without paying for reading it.
   */
  canKeep(profileId: string, extensionId: string, characters: number): boolean {
    const key = `${profileId}:${extensionId}`
    const book = this.books.get(key) ?? { running: 0, characters: 0 }
    return !(book.characters + characters > this.limits.characters || (book.running >= this.limits.running && (this.queues.get(key)?.length ?? 0) >= this.limits.waiting))
  }

  /**
   * The answer of a worker, with its size in characters (`sizeAtMost`: `Infinity` when it is over what is handed over). Only for an ask that was sent, to the extension and the profile it was sent for.
   * The answer counts in the budget of the extension, as the text of the ask does while it is kept: one that would pass it, or that is too long, is replaced by an error, before anything is written out of it.
   */
  answer(profileId: string, extensionId: string, id: unknown, answer: Answer, characters: number): boolean {
    const entry = typeof id === 'string' ? this.entries.get(id) : undefined
    if (!entry || !entry.started || entry.key !== `${profileId}:${extensionId}`) return false
    const book = this.books.get(entry.key)
    const over = !(characters >= 0) || (book !== undefined && book.characters - entry.characters + characters > this.limits.characters)
    this.finish(entry, over ? { ok: false, error: TOO_LONG } : answer)
    return true
  }

  /** The tab goes to another document or closes: what its script asked can no longer be answered to anyone. */
  tabGone(tabNumber: number): void {
    for (const entry of [...this.entries.values()]) if (entry.tab === tabNumber) this.finish(entry, refused())
  }

  /** A worker of the extension stops: what it was asked and had not answered goes with the listener that held it. What waits for its turn is asked of the next one. */
  workerGone(profileId: string, extensionId: string): void {
    // Those that were sent, read before any is ended: ending one sends the next that waits, which the worker that stops was never asked.
    const held = [...this.entries.values()].filter((entry) => entry.started && entry.key === `${profileId}:${extensionId}`)
    for (const entry of held) this.finish(entry, refused())
  }

  /** The extension is unloaded from the profile: nothing it was asked is kept. */
  extensionGone(profileId: string, extensionId: string): void {
    for (const entry of [...this.entries.values()]) if (entry.key === `${profileId}:${extensionId}`) this.finish(entry, refused())
  }

  private start(entry: Entry): void {
    const book = this.books.get(entry.key)!
    book.running++
    entry.started = true
    const payload = entry.payload
    entry.payload = undefined
    this.send(entry.profileId, entry.extensionId, entry.id, entry.op, payload).catch((error: unknown) => this.finish(entry, { ok: false, error: reasonOf(error) }))
  }

  private finish(entry: Entry, answer: Answer): void {
    if (this.entries.get(entry.id) !== entry) return
    this.entries.delete(entry.id)
    clearTimeout(entry.timer)
    const book = this.books.get(entry.key)
    const queue = this.queues.get(entry.key)
    if (book) {
      book.characters -= entry.characters
      if (entry.started) book.running--
    }
    if (!entry.started && queue) {
      const at = queue.indexOf(entry)
      if (at >= 0) queue.splice(at, 1)
    }
    entry.payload = undefined
    entry.settle(answer)
    this.pump(entry.key)
  }

  /** A place was freed: the asks that waited for it are sent, in the order they came. */
  private pump(key: string): void {
    const book = this.books.get(key)
    const queue = this.queues.get(key)
    while (book && queue && queue.length > 0 && book.running < this.limits.running) {
      this.start(queue.shift()!)
    }
    if (book && book.running === 0 && book.characters === 0 && (!queue || queue.length === 0)) {
      this.books.delete(key)
      this.queues.delete(key)
    }
  }
}
