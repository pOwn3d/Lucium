// The tabs being dragged out of a window, as the main process remembers them while the drag lasts. A window never gets the ids of a drag from
// the drag itself: the data of a drag can be forged by a page, and the window the tabs land in does not always list them. So the window they come
// from says when a drag starts and ends, the other windows are told, and a drop on one of them is answered from here and nowhere else.
//
// The end of a drag and the drop it ended with reach the main process from two different windows, in either order: a drag that has ended can
// still be claimed for a short while, so that a drop is not lost to a message that happened to come first.

import { draggedTabs, type WindowTab } from './dnd'
import type { SidebarState } from './model'

/** A drop is still taken this long after the drag ended (the two windows' messages race). */
export const DROP_GRACE_MS = 1500
/** A drag nobody ended (a window gone mid-drag, a lost message) is forgotten after this long, so that no window shows its marks for ever. */
export const DRAG_TTL_MS = 120_000
/** The most tabs one drag holds: the same bound as a multiple selection. */
export const DRAG_TABS_MAX = 1000

/**
 * The tabs a window says it starts to drag, as the other windows will be told of them: those it lists (the ones it names that it does not have, a
 * page of a favourite, and what is beyond the bounds of a selection, are left out), from the space of the first, in the order of its sidebar.
 */
export function tabsToDrag(state: SidebarState, ids: unknown): WindowTab[] {
  if (!Array.isArray(ids) || ids.length > DRAG_TABS_MAX || !ids.every((id) => typeof id === 'string')) return []
  // `draggedTabs` takes rows of the sidebar only: the page of a favourite is none.
  return draggedTabs(state, ids as string[]).map((tab): WindowTab => ({ id: tab.id, ...(tab.private === true ? { private: true as const } : {}) }))
}

export interface TabDrag {
  /** Grows with every drag: lets a window that was told about one tell it from the next. */
  token: number
  /** The key of the window the tabs are dragged out of. */
  sourceKey: string
  tabs: WindowTab[]
}

interface Held extends TabDrag {
  startedAt: number
  /** Set once the source window said the drag is over. */
  endedAt?: number
}

export class TabDragLedger {
  private held: Held | null = null
  private counter = 0

  constructor(private readonly clock: () => number = Date.now) {}

  /** A window starts dragging `tabs`; an earlier drag that was never ended gives way. */
  begin(sourceKey: string, tabs: readonly WindowTab[]): TabDrag {
    const drag: Held = { token: ++this.counter, sourceKey, tabs: tabs.slice(0, DRAG_TABS_MAX), startedAt: this.clock() }
    this.held = drag
    return drag
  }

  /** The window says its drag is over (dropped or not). It stays claimable for the grace period. Answers whether there was a live drag of that window. */
  end(sourceKey: string): boolean {
    const held = this.held
    if (!held || held.sourceKey !== sourceKey || held.endedAt !== undefined) return false
    held.endedAt = this.clock()
    return true
  }

  /** The drag the other windows show marks for: one still going on (not ended, not too old). */
  live(): TabDrag | null {
    const held = this.held
    return held && held.endedAt === undefined && this.clock() - held.startedAt <= DRAG_TTL_MS ? held : null
  }

  /** What a drop is answered from: the drag going on, or one that ended a moment ago. Taken once: a second drop finds nothing. */
  claim(): TabDrag | null {
    const held = this.held
    if (!held) return null
    const now = this.clock()
    const usable = held.endedAt === undefined ? now - held.startedAt <= DRAG_TTL_MS : now - held.endedAt <= DROP_GRACE_MS
    this.held = null
    return usable ? held : null
  }

  /** A window is gone: its drag with it. Answers whether it had one. */
  forget(sourceKey: string): boolean {
    if (this.held?.sourceKey !== sourceKey) return false
    this.held = null
    return true
  }
}
