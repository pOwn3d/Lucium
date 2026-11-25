// What the panel of the resources remembers of « Libérer maintenant » while it is closed: the run that goes on, and the sentence that says how it ended
// (« N sur M mis en veille : … »). A run does not stop when the panel closes (the main process finishes it), so its answer must have somewhere to land
// and the panel that opens next must find it: the sentence stays until the person dismisses it or a new run replaces it. Window-wide, never persisted.

import type { ReleaseOutcome, ReleasePreview, ResourceAction, ResourceActionReply } from '@shared/resources'
import type { ReleaseLevel } from '@shared/sleep'

/** The last run that ended, with what the panel needs to say about it. */
export interface ReleaseDone {
  outcome: ReleaseOutcome
  /** The memory total when the run was asked for (to measure what it freed), or null when it was not known. */
  before: number | null
  /** What was really freed, measured a few seconds after the run; null until then or when it was not measurable. */
  freedMb: number | null
  /** « Annuler » is still offered. */
  undoable: boolean
  /** When the answer came (`Date.now()`): the timers of the measure and of « Annuler » count from it, also for a panel that opens later. */
  at: number
}

export interface ReleaseMemory {
  /** The strength that runs, with the number of tabs it takes. */
  running: { level: ReleaseLevel; count: number } | null
  done: ReleaseDone | null
  /** The notice of a run that could not even be asked (« Impossible de libérer »): kept like a result. */
  failed: boolean
}

const EMPTY: ReleaseMemory = { running: null, done: null, failed: false }
let memory: ReleaseMemory = EMPTY
const listeners = new Set<() => void>()
/** Which run the answers belong to: an answer that comes after a newer run was asked for is not the one on screen. */
let generation = 0

function set(next: ReleaseMemory): void {
  memory = next
  for (const listener of [...listeners]) listener()
}

/** The current memory: the same object until something changes (what `useSyncExternalStore` needs). */
export function releaseMemory(): ReleaseMemory {
  return memory
}

export function subscribeRelease(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Forgets everything (tests; a run that belongs to a window that is gone). */
export function resetReleaseMemory(): void {
  generation++
  listeners.clear()
  memory = EMPTY
}

/**
 * Asks for a run and keeps what comes of it, whether or not a panel is open when the answer arrives. One run at a time: a second request while one
 * goes on is ignored. A new run replaces the sentence of the previous one at once.
 */
export function startRelease(preview: Pick<ReleasePreview, 'level' | 'count'>, before: number | null, send: (action: ResourceAction) => Promise<ResourceActionReply>): void {
  if (memory.running) return
  const mine = ++generation
  set({ running: { level: preview.level, count: preview.count }, done: null, failed: false })
  void send({ kind: 'sleep-level', level: preview.level }).then((reply) => {
    if (mine !== generation) return
    if (!reply || !('released' in reply)) return set({ running: null, done: null, failed: true })
    set({ running: null, failed: false, done: { outcome: reply.released, before, freedMb: null, undoable: reply.released.slept > 0, at: Date.now() } })
  })
}

/** The person closes the sentence, or an action of their own replaces it (the sentence and « Annuler » go together). */
export function dismissRelease(): void {
  if (!memory.done && !memory.failed) return
  set({ ...memory, done: null, failed: false })
}

/** Changes the run on screen, unless another one replaced it meanwhile (`ran` is the outcome the change was meant for). */
export function patchRelease(ran: ReleaseOutcome, patch: Partial<Pick<ReleaseDone, 'freedMb' | 'undoable'>>): void {
  if (memory.done?.outcome !== ran) return
  set({ ...memory, done: { ...memory.done, ...patch } })
}
