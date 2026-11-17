// The autoplay policy of a web page, as Electron names it. Electron's own default for a page is `no-user-gesture-required` (anything may
// start by itself), where Chromium's own policy waits for the user; every page of ours is created with a policy chosen here, so the looser
// one is only ever the user's explicit choice. See shared/autoplay.ts for what the two modes mean and why there are only two.

import { DEFAULT_AUTOPLAY, isAutoplayMode } from '@shared/autoplay'

export type ElectronAutoplayPolicy = 'no-user-gesture-required' | 'document-user-activation-required'

/** The `autoplayPolicy` web preference of a mode. A mode nobody knows is Chromium's policy, never the permissive one. */
export function webAutoplayPolicy(mode: unknown): ElectronAutoplayPolicy {
  return (isAutoplayMode(mode) ? mode : DEFAULT_AUTOPLAY) === 'allow' ? 'no-user-gesture-required' : 'document-user-activation-required'
}
