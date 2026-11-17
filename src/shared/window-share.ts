// The annotated window share (docs/design/annotation-partage-fenetre.md, « Fenêtre annotée »): the rules that decide what can be listed and
// shared, and the names the windows use to talk to each other. Pure on purpose: the capture itself is in main/shell/window-share.ts.
// On unless the development variable LUCIUM_ANNOTATE is 0 (see main/index.ts): nothing is built then.

import type { Brush, DrawAction, EditCommand } from './window-share-draw'
import type { PassClick, PassNote } from './window-share-pass'

/**
 * On by default in every build; LUCIUM_ANNOTATE=0 turns it off, from the sources or in a smoke run: the built application drops the variable at
 * start-up (main/runtime.ts, `dropDevelopmentEnv`). Nothing else switches it.
 */
export function annotateShareEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env['LUCIUM_ANNOTATE'] !== '0'
}

/** The channels between the command window (its preload) and the main process. */
export const WINDOW_SHARE_CHANNEL = {
  list: 'window-share:list',
  start: 'window-share:start',
  stop: 'window-share:stop',
  state: 'window-share:state',
  /** Command window to main: the brush the drawing uses (checked against the palette in main). */
  brush: 'window-share:brush',
  /** Command window to main: an edit of the whole picture (undo, redo, clear), checked against the list of commands in main. */
  edit: 'window-share:edit',
  /** Command window to main: the passage mode on or off (a click is sent to the source window only in that mode). */
  pass: 'window-share:pass',
  /** Command window to main: the system-wide shortcut on or off. */
  shortcut: 'window-share:shortcut',
  /** View window to main, and only in the passage mode: a click, with the place of the picture (checked in main). */
  click: 'window-share:click',
  /** View window to main: whether the picture is black (the window is on the screen but sends no picture), sent when it changes. */
  picture: 'window-share:picture',
  /** Main to the view window only: a drawing action. */
  draw: 'window-share:draw'
} as const

/** A window that can be captured: the id desktopCapturer gives it, and its title. Nothing else leaves the main process. */
export interface ShareSource {
  id: string
  name: string
}

/** Why a window cannot be shared. `private`: a private window of Lucium; `own`: one of the share's own windows; `unknown`: not a window now. */
export type ShareRefusal = 'permission' | 'private' | 'own' | 'unknown' | 'failed'

export type ShareList = { ok: true; windows: ShareSource[] } | { ok: false; reason: 'permission' | 'failed' }
export type ShareStart = { ok: true } | { ok: false; reason: ShareRefusal }
/**
 * What the command window shows: the window being shared, or null. `missing`: that window is no longer in the list of the windows (it was
 * closed while shared); the view keeps its last picture until another window is chosen.
 */
export interface ShareState {
  sharing: ShareSource | null
  missing: boolean
  /** The passage mode: the clicks of the view go to the shared window. Always false while nothing is shared. */
  pass: boolean
  /** Why the passage mode or a click did not happen (the Accessibility permission, or the window gone), or null. */
  passNote: PassNote | null
  /**
   * The shortcut ⌥⌘P: `on` (held), `off` (switched off in the command window), `taken` (wanted, but another application holds it), `own` (wanted, but
   * the annotation of a page, which has the same shortcut, holds it).
   */
  shortcut: 'on' | 'off' | 'taken' | 'own'
  /** The shared window is listed but not on the screen: minimized, hidden, or on another desktop. macOS tells it; false when it cannot tell. */
  hidden: boolean
  /** The picture of the view is black for BLANK_ROUNDS samples in a row (see window-share-picture.ts): no picture reaches the share. */
  blank: boolean
}

/**
 * What the share says to the user about its source, or null: `closed` (the window is no longer in the list), `away` (it is listed, but it sends
 * no picture: minimized, hidden, on another desktop, or black). `closed` comes first: a window that is gone is not also away.
 */
export type ShareNotice = 'closed' | 'away' | null

export function shareNoticeOf(state: Pick<ShareState, 'missing' | 'hidden' | 'blank'>): ShareNotice {
  if (state.missing) return 'closed'
  return state.hidden || state.blank ? 'away' : null
}

/**
 * The text under the switch of ⌥⌘P when the shortcut is wanted and not held, by its key: another application has it, or the annotation of a
 * page (Lucium itself, which must not be called « another application »). Null when there is nothing to say.
 */
export function shortcutHintKey(shortcut: ShareState['shortcut']): 'window-share.raccourci-pris' | 'window-share.raccourci-pris-annotation' | null {
  if (shortcut === 'taken') return 'window-share.raccourci-pris'
  return shortcut === 'own' ? 'window-share.raccourci-pris-annotation' : null
}

/** The API the command window's preload gives its page, and nothing more. */
export interface WindowShareApi {
  list(): Promise<ShareList>
  start(id: string): Promise<ShareStart>
  stop(): Promise<void>
  onState(listener: (state: ShareState) => void): () => void
  setBrush(brush: Brush): Promise<void>
  edit(command: EditCommand): Promise<void>
  setPass(on: boolean): Promise<void>
  setShortcut(on: boolean): Promise<void>
}

/** The API the view window's preload gives its page: the drawing actions, and nothing else. */
export interface WindowShareViewApi {
  onDraw(listener: (action: DrawAction) => void): () => void
  /** Only in the passage mode: the click goes to main, which sends it to the shared window if it is on it. */
  sendClick(click: PassClick): void
  /** Whether the picture is black for a while (see ShareState.blank). Sent when it changes, to main only. */
  sendPicture(blank: boolean): void
}

/**
 * Whether the windows cannot be listed for a screen permission. `status` is what macOS says of the screen (`getMediaAccessStatus`); `count` is
 * the number of windows the system gave back, or null when nothing was asked yet.
 *
 * macOS answers "denied" for the screen both when the user refused and when nobody ever asked: the listing is what makes the system ask (and
 * put the app in Réglages Système › Enregistrement de l'écran), so before it only a restriction stops. After it, `status` is read again: still
 * not granted, a "denied" or an empty list is the system's refusal.
 */
export function listingRefusedForPermission(status: string, count: number | null): boolean {
  if (status === 'restricted') return true
  if (count === null || status === 'granted') return false
  return status === 'denied' || count === 0
}

/** The native number of a window in a desktopCapturer id (`window:XX:YY`, where XX is the window), or null for a screen or another format. */
export function nativeWindowId(sourceId: string): string | null {
  return /^window:(-?\d+):/.exec(sourceId)?.[1] ?? null
}

/**
 * The windows Lucium does not offer, by native number. `privateWindows`: the private windows of Lucium (never listed, never captured).
 * `ownWindows`: the share's own view and command windows (a window that shows the share of itself would loop).
 */
export interface WindowExclusions {
  privateWindows: ReadonlySet<string>
  ownWindows: ReadonlySet<string>
}

/** The windows that may be listed: the window sources that are neither private nor the share's own. Screens are left out. */
export function capturableWindows(sources: readonly ShareSource[], excluded: WindowExclusions): ShareSource[] {
  return sources
    .filter((source) => {
      const native = nativeWindowId(source.id)
      return native !== null && !excluded.privateWindows.has(native) && !excluded.ownWindows.has(native)
    })
    .map(({ id, name }) => ({ id, name }))
}

/**
 * Why `sourceId` cannot be shared now, or null when it can. The private check comes first and holds even when the window is in `sources`: a
 * private window is refused whatever list it appears in.
 */
export function refusalOf(sourceId: string, sources: readonly ShareSource[], excluded: WindowExclusions): ShareRefusal | null {
  const native = nativeWindowId(sourceId)
  if (native !== null && excluded.privateWindows.has(native)) return 'private'
  if (native !== null && excluded.ownWindows.has(native)) return 'own'
  return capturableWindows(sources, excluded).some((source) => source.id === sourceId) ? null : 'unknown'
}
