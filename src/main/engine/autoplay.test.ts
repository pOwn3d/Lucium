import { describe, expect, it } from 'vitest'
import { webAutoplayPolicy } from './autoplay'

describe('the autoplay policy given to Electron', () => {
  it('is Chromium\'s for the mode "block", and Electron\'s own default only for "allow"', () => {
    expect(webAutoplayPolicy('block')).toBe('document-user-activation-required')
    expect(webAutoplayPolicy('allow')).toBe('no-user-gesture-required')
  })

  it('is Chromium\'s for anything else, so a page made without a choice (a popup, an old call) never gets the permissive policy', () => {
    for (const unknown of [undefined, null, '', 'always', 'no-user-gesture-required', 'user-gesture-required', 0, {}]) expect(webAutoplayPolicy(unknown), String(unknown)).toBe('document-user-activation-required')
  })
})
