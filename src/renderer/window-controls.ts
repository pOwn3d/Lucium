// The buttons of the system laid over this window (Windows: minimise, maximise, close at the right end; the page draws the rest of the title bar). The page learns
// it from the system itself: `navigator.windowControlsOverlay` exists and is visible only in a window made with a title bar overlay, so a window of another kind
// (the system's own bar, the mini window, Réglages) and every other system answer false without a test of the platform. While they are there the root carries
// `data-controls="overlay"` and the stylesheets (window-controls.css) leave the room, reading its width from `env(titlebar-area-*)`: a number written here would be
// a guess about this machine's scale and settings.

import { useLayoutEffect, useSyncExternalStore } from 'react'
import type { PlatformId } from '@shared/platform'

/** The part of the Window Controls Overlay API this reads (it is not in the DOM typings of the compiler). */
interface WindowControlsOverlay {
  readonly visible: boolean
  addEventListener(type: 'geometrychange', listener: () => void): void
  removeEventListener(type: 'geometrychange', listener: () => void): void
}

const overlay = (): WindowControlsOverlay | undefined => (typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay)

/** Whether the buttons of the system lie over this document's window right now. */
export const controlsVisible = (): boolean => overlay()?.visible === true

function subscribe(onChange: () => void): () => void {
  const api = overlay()
  api?.addEventListener('geometrychange', onChange)
  return () => api?.removeEventListener('geometrychange', onChange)
}

/** The attribute of the root the stylesheets read, set while the buttons are there. */
export function markControls(root: HTMLElement, on: boolean): void {
  if (on) root.setAttribute('data-controls', 'overlay')
  else root.removeAttribute('data-controls')
}

/**
 * True while the buttons of the system lie over this window; follows the window being resized or the system changing them. `mark`: this is the view that
 * puts the attribute on the root (one per document: a second one would take it off when it goes).
 */
export function useControlsOverlay(mark = false): boolean {
  // A view rendered to markup alone (the tests of the interface) reads the same answer, as `useSnapshot` does.
  const on = useSyncExternalStore(subscribe, controlsVisible, controlsVisible)
  useLayoutEffect(() => {
    if (!mark) return
    markControls(document.documentElement, on)
    return () => markControls(document.documentElement, false)
  }, [on, mark])
  return on
}

/**
 * The system the window runs on, as an attribute of the root (`data-platform`), for the stylesheets that keep room only where it is needed: the room for the traffic
 * lights is macOS's alone. Set with the snapshot, which carries the platform, before the first frame is drawn.
 */
export function markPlatform(root: HTMLElement, platform: PlatformId): void {
  root.setAttribute('data-platform', platform)
}
