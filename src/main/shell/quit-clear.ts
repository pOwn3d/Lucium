// "Effacer à la fermeture de Lucium" is held to a few seconds when the application quits (a site that does not answer must not keep it open).
// What that cut short is not lost: a marker is written before the erasure starts and removed once it is whole; a marker found at the next launch
// means the erasure did not finish, and it is done then, before the listed sites are opened again. Only node:fs here.

import { existsSync, rmSync } from 'node:fs'
import { writeDurableFile } from '../durable-write'

export const QUIT_CLEAR_MARKER = 'clear-on-quit.pending'

/** Writes the marker. False when it cannot be written: the erasure goes on, but a cut one will not be resumed (the failure is logged). */
export function markQuitClear(path: string, now = Date.now()): boolean {
  try {
    writeDurableFile(path, JSON.stringify({ at: now }))
    return true
  } catch (error) {
    console.error(`[quit] cannot write ${path}; an erasure cut short at quit will not be resumed:`, error)
    return false
  }
}

/** The erasure was whole: the marker goes. */
export function finishQuitClear(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch (error) {
    // Left behind, it would only make the next launch erase the listed sites once more.
    console.error(`[quit] cannot remove ${path}:`, error)
  }
}

export type QuitClearReplay = 'none' | 'dropped' | 'done' | 'incomplete'

/**
 * At launch: the erasure that was cut short at the last quit, done now. `enabled` says whether the erasure at quit is still asked for (the sites may have
 * been taken off the list since: then nothing is erased, the marker only goes). `clear` is the erasure itself, answering the sites it did not fully erase,
 * and tells those to the user itself. The marker is removed after one attempt, whatever came of it: a failure that lasts is told each time it happens, not
 * retried at every launch.
 */
export async function replayQuitClear(path: string, deps: { enabled: () => boolean; clear: () => Promise<string[]> }): Promise<QuitClearReplay> {
  if (!existsSync(path)) return 'none'
  if (!deps.enabled()) {
    finishQuitClear(path)
    return 'dropped'
  }
  try {
    const failed = await deps.clear()
    if (failed.length > 0) console.error('[quit] the erasure cut short at the last quit was resumed, and these sites were not fully erased:', failed.join(', '))
    finishQuitClear(path)
    return failed.length > 0 ? 'incomplete' : 'done'
  } catch (error) {
    console.error('[quit] cannot resume the erasure cut short at the last quit:', error)
    finishQuitClear(path)
    return 'incomplete'
  }
}
