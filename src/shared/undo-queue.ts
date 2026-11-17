// A deletion that can be taken back for a few seconds (decision R6c: the same gesture in every list panel). The row leaves the list at once and a
// notice offers "Annuler" (or ⌘Z); only when the delay has passed, or when the panel is left, is the deletion really made. The delay is the one of every
// notice with an action (ACTION_NOTICE_MS), and it waits while the pointer or the focus is on the notice (`hold`).
//
//   const queue = createUndoQueue()
//   queue.remove('bookmark-7', 'Signet supprimé', () => act.dispatch({ type: 'bookmark/delete', id: 'bookmark-7' }))
//   queue.pending()  -> ['bookmark-7']: the panel does not draw it
//   queue.undo()     -> the row is back, nothing was deleted        (or 8 s later: the deletion is made)
//
// Pure, with no React: the panel binds it with `useUndoQueue` (src/renderer/templates).

import { ACTION_NOTICE_MS, NoticeTimer, type NoticeTimers } from './toast'

export interface UndoEntry {
  id: string
  /** The sentence of the notice: "Signet supprimé". */
  message: string
}

export interface UndoQueue {
  /** Hides `id` and runs `commit` after the delay, unless `undo()` came first. Removing the same id twice keeps the first. */
  remove(id: string, message: string, commit: () => void): void
  /** Takes back the last removal still waiting. False when there is none. */
  undo(): boolean
  /** Makes every waiting deletion now: the panel is being left, and what the person saw go is gone. */
  flush(): void
  /**
   * The pointer or the focus is on the notice (`true`) or left it: the time of every waiting deletion stops, and goes on with what it had left. A removal made
   * while the notice is held waits too. Once nothing waits any more the notice is gone and the queue is not held.
   */
  hold(held: boolean): void
  /** The ids hidden now, oldest first. */
  pending(): readonly string[]
  /** What the notice says: the last removal waiting, or null. */
  last(): UndoEntry | null
  subscribe(listener: () => void): () => void
}

interface Waiting extends UndoEntry {
  commit: () => void
  timer: NoticeTimer
}

export type UndoTimers = NoticeTimers

export function createUndoQueue(delayMs: number = ACTION_NOTICE_MS, timers?: UndoTimers): UndoQueue {
  let waiting: Waiting[] = []
  let held = false
  const listeners = new Set<() => void>()
  const changed = (): void => listeners.forEach((listener) => listener())
  // Nothing waits: the notice is gone, and with it what held it (its element leaves without telling).
  const settled = (): void => {
    if (waiting.length === 0) held = false
  }

  const commitNow = (entry: Waiting): void => {
    entry.timer.cancel()
    waiting = waiting.filter((other) => other !== entry)
    settled()
    changed()
    entry.commit()
  }

  return {
    remove(id, message, commit) {
      if (waiting.some((entry) => entry.id === id)) return
      const entry: Waiting = { id, message, commit, timer: new NoticeTimer(delayMs, () => commitNow(entry), timers).start() }
      if (held) entry.timer.hold()
      waiting = [...waiting, entry]
      changed()
    },
    undo() {
      const entry = waiting[waiting.length - 1]
      if (!entry) return false
      entry.timer.cancel()
      waiting = waiting.slice(0, -1)
      settled()
      changed()
      return true
    },
    flush() {
      for (const entry of [...waiting]) commitNow(entry)
    },
    hold(now) {
      if (now === held || (now && waiting.length === 0)) return
      held = now
      for (const entry of waiting) {
        if (now) entry.timer.hold()
        else entry.timer.release()
      }
    },
    pending: () => waiting.map((entry) => entry.id),
    last() {
      const entry = waiting[waiting.length - 1]
      return entry ? { id: entry.id, message: entry.message } : null
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
