// A line in the journal of Settings › Général › État de Lucium (and so in « Aide › Signaler un problème… ») for each change of the sidebar of a window, with
// what caused it, and for each touch of the window's edge that opened (or was refused to open) the floating sidebar. The journal is the one `console.error`
// feeds (error-log.ts: 50 lines of 300 characters, redacted, kept in memory only, never sent): a sidebar that blinks or goes away by itself can be read from a
// report afterwards. A line holds booleans, words of this file and the name of an action: no address, no title, no path. Cheap: a comparison of one
// string per layout, a line only when something changed, and the touches of the edge are limited: one line of each kind, then the wait before the next one doubles
// (1 s, 2 s, 4 s … 32 s, back to 1 s after a minute of quiet), so that a loop of reveals cannot push the real errors out of the journal: the next line says how
// many it held back.

import type { Action } from '@shared/sidebar'
import type { WindowSidebar, WindowSidebarChange } from '@shared/window-sidebar'
import type { Settings } from '@shared/model'
import { sidebarPlacement } from '@shared/window-sidebar'

/** What a line says of the sidebar of a window: what is on screen (the full sidebar, its column, nothing), the side, what the window chose, the compact mode. */
export interface SidebarFacts {
  shape: 'full' | 'column' | 'hidden'
  side: 'left' | 'right'
  /** What the window chose for itself (« Barre de cette fenêtre »): `docked`, `right`, both, or `none` when it follows the setting. */
  own: string
  /** Both bars away (the compact mode, whether the function is on or not). */
  barsAway: boolean
}

/** The facts of a window: its settings and its own choice. */
export function sidebarFacts(settings: Pick<Settings, 'sidebarRight' | 'sidebarVisible' | 'showToolbar'>, own: WindowSidebar): SidebarFacts {
  const placement = sidebarPlacement(settings, own)
  const chose = [own.docked === true ? 'docked' : '', own.side !== undefined ? own.side : ''].filter(Boolean).join('+')
  return {
    shape: !settings.sidebarVisible ? 'hidden' : placement.docked ? 'column' : 'full',
    side: placement.right ? 'right' : 'left',
    own: chose === '' ? 'none' : chose,
    barsAway: !settings.sidebarVisible && !settings.showToolbar
  }
}

const factsKey = (facts: SidebarFacts): string => `${facts.shape} ${facts.side} own=${facts.own}${facts.barsAway ? ' bars-away' : ''}`

/** The settings an action changes that decide where the sidebar is or what shows around it. */
const PLACEMENT_KEYS: readonly string[] = ['sidebarVisible', 'sidebarRight', 'showToolbar', 'compactMode']

/** What an action says of itself when it can change the sidebar of the window, null for every other action (so that most dispatches cost one comparison). */
export function sidebarCauseOf(action: Action): string | null {
  if (action.type === 'compact/toggle') return 'compact/toggle'
  if (action.type !== 'settings/update') return null
  const keys = Object.keys(action.patch).filter((key) => PLACEMENT_KEYS.includes(key))
  return keys.length > 0 ? `settings/update ${keys.map((key) => `${key}=${String((action.patch as Record<string, unknown>)[key])}`).join(',')}` : null
}

/** What a change of « Barre de cette fenêtre » says of itself. */
export function windowSidebarCause(change: WindowSidebarChange): string {
  switch (change.op) {
    case 'dock':
      return `window-sidebar dock=${change.docked}`
    case 'side':
      return `window-sidebar side=${change.side ?? 'setting'}`
    default:
      return `window-sidebar ${change.op}`
  }
}

/** Held back for this long (ms) after the first line of a kind: the touches of the edge. The wait doubles with each line that follows, up to `TRACE_EDGE_DOUBLINGS` times. */
export const TRACE_EDGE_INTERVAL_MS = 1000
export const TRACE_EDGE_DOUBLINGS = 5
/** A kind left alone for this long (ms) starts again at the short wait. */
export const TRACE_EDGE_QUIET_MS = 60_000

export class SidebarTrace {
  private last: string | null = null
  private causes: string[] = []
  private readonly edge = new Map<string, { at: number; held: number; lines: number }>()

  constructor(
    /** What the lines call the window: `main`, `window-2`, `private`. */
    private readonly label: () => string,
    /** Where a line goes: the journal (`console.error`). */
    private readonly write: (line: string) => void = (line) => console.error(line),
    private readonly now: () => number = Date.now
  ) {}

  /** Runs `run`, the changes of placement it makes being told with `cause` (nothing else is told with it once it has returned). */
  during<T>(cause: string | null, run: () => T): T {
    if (cause === null) return run()
    this.causes.push(cause)
    try {
      return run()
    } finally {
      this.causes.pop()
    }
  }

  /** The window was laid out: a line if its sidebar is not where it was last time (the first layout of the window says where it starts). */
  placement(facts: SidebarFacts): void {
    const key = factsKey(facts)
    if (key === this.last) return
    const was = this.last
    this.last = key
    const cause = this.causes.at(-1) ?? (was === null ? 'start' : 'state')
    this.write(`[sidebar] ${this.label()}: ${was === null ? '' : `${was} -> `}${key} (${cause})`)
  }

  /** The edge of the window was touched, or left (`hotEdge`): `opened`, `closing` (the pointer left the floating sidebar), `gone`, or `ignored` (a sidebar is on screen). */
  edgeEvent(event: 'opened' | 'closing' | 'gone' | 'ignored', facts: SidebarFacts): void {
    const at = this.now()
    const seen = this.edge.get(event)
    const lines = seen && at - seen.at < TRACE_EDGE_QUIET_MS ? seen.lines : 0
    if (seen && at - seen.at < TRACE_EDGE_INTERVAL_MS * 2 ** Math.min(lines - 1, TRACE_EDGE_DOUBLINGS)) {
      seen.held++
      return
    }
    const held = seen?.held ?? 0
    this.edge.set(event, { at, held: 0, lines: lines + 1 })
    this.write(`[sidebar] ${this.label()}: edge ${event} while ${factsKey(facts)}${held > 0 ? ` (+${held} more)` : ''}`)
  }
}
