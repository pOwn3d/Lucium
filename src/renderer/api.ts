import { useSyncExternalStore } from 'react'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import { applyAccessibility } from '@shared/accessibility'
import { applyScrollBars } from '@shared/scroll-bars'
import { followLanguage } from './document-language'

declare global {
  interface Window {
    lucium: LuciumApi
  }
}

export const api = (): LuciumApi => window.lucium

/**
 * The snapshot of this document, shared by every view that draws it: one listener and at most one read of the state for the whole document, where
 * each view used to ask the main process for its own copy of the state (`getSnapshot`) and to receive its own copy of every snapshot sent.
 */
const views = new Set<() => void>()
let current: UiSnapshot | null = null
let followers = 0
let stopListening: (() => void) | null = null
let firstRead: Promise<void> | null = null
/** The bridge listened to. A document has one; the tests of the interface give each view they mount a bridge of its own, with its own state. */
let source: LuciumApi | null = null

function publish(snapshot: UiSnapshot): void {
  current = snapshot
  for (const view of [...views]) view()
}

function listen(): void {
  const bridge = api()
  if (source !== bridge) {
    stopListening?.()
    stopListening = null
    current = null
    firstRead = null
    source = bridge
  }
  stopListening ??= bridge.onSnapshot(publish)
}

/** Asks for the state once, when no snapshot is known yet; a snapshot pushed in the meantime is newer, so the answer is then dropped. */
function readFirst(): void {
  if (current !== null || firstRead !== null) return
  const read: Promise<void> = api()
    .getSnapshot()
    .then((first) => {
      if (firstRead === read && current === null && first) publish(first)
    })
    // The views then wait for the next state the main process publishes; the cause is written, not lost in an unhandled rejection.
    .catch((error: unknown) => console.warn('[ui] the first state could not be read:', error))
    .finally(() => {
      if (firstRead === read) firstRead = null
    })
  firstRead = read
}

/**
 * Stops listening once nothing draws or keeps the snapshot, and forgets it: a view mounted later reads the state again instead of drawing an old
 * one. Checked a moment later, so that a view unmounted and mounted again at once (React's strict mode does it) keeps what it drew.
 */
function release(): void {
  queueMicrotask(() => {
    if (views.size > 0 || followers > 0 || stopListening === null) return
    stopListening()
    stopListening = null
    source = null
    current = null
    firstRead = null
  })
}

function subscribe(view: () => void): () => void {
  views.add(view)
  listen()
  readFirst()
  return () => {
    views.delete(view)
    release()
  }
}

const currentSnapshot = (): UiSnapshot | null => current

/**
 * Keeps the last snapshot the main process sends to this document, for the views mounted afterwards: they draw it from their first frame instead
 * of nothing until their own read of the state comes back. The layer of panels needs it: it mounts a panel at each request and none while it is
 * closed, and the state it missed meanwhile is sent just before the request, when no view of it is there to hear it. A popover placed from the
 * state (the downloads of a window whose sidebar is at the right) was first drawn where the default layout puts it. Answers the way to stop.
 */
export function followSnapshots(): () => void {
  followers += 1
  listen()
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    followers -= 1
    release()
  }
}

/** Latest snapshot pushed by the main process: the one this document keeps, else `null` until the first one arrives. */
export function useSnapshot(): UiSnapshot | null {
  // A view rendered to markup alone (the tests of the interface) draws what the document keeps, as on its first frame.
  const snapshot = useSyncExternalStore(subscribe, currentSnapshot, currentSnapshot)
  // The language of the interface follows the settings of the snapshot being drawn. It is set while rendering, before the texts below are read, and
  // every view that draws a snapshot sets the same one, so it is idempotent; a change reaches every view because a snapshot re-renders them all.
  if (snapshot) {
    followLanguage(document.documentElement, snapshot.state.settings, navigator.language)
    // The preferences the user forces (Réglages › Apparence › Accessibilité) are attributes of the root, on every surface that draws a snapshot.
    applyAccessibility(document.documentElement, snapshot.state.settings)
    // « Toujours afficher les barres de défilement » (macOS): the lists that hide their bar draw it (the stylesheets read `:root[data-scrollbars]`).
    applyScrollBars(document.documentElement, snapshot.scrollBarsAlways === true)
  }
  return snapshot
}
