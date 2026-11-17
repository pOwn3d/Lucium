// The keys of the layer that the panel of ⌃Tab hands to the shell (overlay.tsx). The panel has the keyboard while it is up, and the shell needs to
// hear ⌃ go up: the page is not told, Chromium keeps from the shell every key that goes up after one the shell took.
//
// The main process gives the layer the keyboard as it asks for the panel, but the request and the keys reach the layer by two different routes,
// and a key can come first. Closing a panel tells the layer (it then draws nothing), so between two panels the layer does not know which one is
// next: a key that reaches it then can only be for the panel on its way (a closed layer is out of the window and gets no key). Such a key is kept
// until the request says which panel that is, handed over if it is the panel of ⌃Tab and dropped otherwise. A quick ⌃Tab, or an Escape typed as
// the panel appears, is not lost, and no other panel's keys are ever reported.

import type { CycleKey } from '@shared/tab-cycle'

/** What the relay reads of a keyboard event (a DOM `KeyboardEvent` is one). */
export interface RelayedKeyEvent {
  type: string
  code: string
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
  preventDefault(): void
}

/** The most keys kept while the layer waits for its request: a quick tap is four (⌃ down, Tab down, Tab up, ⌃ up). */
export const HELD_KEYS_MAX = 16

export interface CycleKeyRelay {
  /** The layer was asked for a panel, or told that its panel is closed (null). */
  show(request: { panel: string } | null): void
  /** A key press or release that reached the layer. */
  key(event: RelayedKeyEvent): void
}

export function cycleKeyRelay(report: (key: CycleKey) => void): CycleKeyRelay {
  // 'waiting': no panel is shown, the next request is on its way; 'cycle': the panel of ⌃Tab is up; 'other': another panel has the keys.
  let mode: 'waiting' | 'cycle' | 'other' = 'waiting'
  let held: CycleKey[] = []
  return {
    show(request) {
      const waited = held
      held = []
      mode = request === null ? 'waiting' : request.panel === 'tabcycle' ? 'cycle' : 'other'
      if (mode === 'cycle') for (const key of waited) report(key)
    },
    key(event) {
      if (mode === 'other') return
      const key: CycleKey = { type: event.type === 'keyup' ? 'keyUp' : 'keyDown', code: event.code, key: event.key, meta: event.metaKey, control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, isAutoRepeat: event.repeat }
      if (mode === 'cycle') {
        // The panel has no use for its keys (Tab would move the focus in it): the shell has them.
        event.preventDefault()
        report(key)
        return
      }
      if (held.length < HELD_KEYS_MAX) held.push(key)
    }
  }
}
