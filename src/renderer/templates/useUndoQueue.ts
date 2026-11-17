// The deletion that can be taken back for eight seconds, waiting while the pointer or the focus is on its notice, as a panel uses it (src/shared/undo-queue.ts is the rule, this is the binding):
//
//   const undo = useUndoQueue()
//   const rows = items.filter((item) => !undo.hidden.has(item.id))
//   <button onClick={() => undo.remove(item.id, t('…', { name }), () => act.dispatch({ type: '…/delete', id: item.id }))}>
//   <ListPanel undo={undo.panel}>

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { ACTION_NOTICE_MS } from '@shared/toast'
import { createUndoQueue, type UndoEntry } from '@shared/undo-queue'

export interface UndoBinding {
  /** The ids that are gone from the list for now. */
  hidden: ReadonlySet<string>
  /** The last deletion that can still be taken back, for the notice. */
  notice: UndoEntry | null
  remove(id: string, message: string, commit: () => void): void
  undo(): boolean
  /** Makes the waiting deletions now: a new action that has its own notice ends the window of the one before. */
  flush(): void
  /** The pointer or the focus is on the notice (or left it): the deletions wait. `ListPanel` gives it to its notice (`undo.onHold`). */
  hold(held: boolean): void
  /** What `ListPanel` takes as its `undo`: the notice with its button and its pause, or null. */
  panel: { message: string; onUndo: () => void; onHold: (held: boolean) => void } | null
}

export function useUndoQueue(delayMs: number = ACTION_NOTICE_MS): UndoBinding {
  const queue = useMemo(() => createUndoQueue(delayMs), [delayMs])
  // What the panel draws depends on the ids hidden and on the notice: a string of both says when it changes.
  const snapshot = (): string => `${queue.pending().join('\u0000')}|${queue.last()?.message ?? ''}`
  const version = useSyncExternalStore(queue.subscribe, snapshot, snapshot)
  // Leaving the panel makes the waiting deletions: what the person saw go does not come back.
  useEffect(() => () => queue.flush(), [queue])
  return useMemo(
    () => {
      const notice = queue.last()
      return {
        hidden: new Set(queue.pending()),
        notice,
        remove: queue.remove,
        undo: queue.undo,
        flush: queue.flush,
        hold: queue.hold,
        panel: notice && { message: notice.message, onUndo: queue.undo, onHold: queue.hold }
      }
    },
    // `version` is the reason to compute again; the queue's own methods do not change.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `version` is the reason to compute again
    [queue, version]
  )
}
