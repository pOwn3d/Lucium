// The schemes declared before the application is ready. A scheme that is missing from the list is one Chromium treats as unknown: the icons
// of sites the interface draws would not load, nor the stand-in resources of the blocker on an https page.

import { describe, expect, it } from 'vitest'
import { INTERNAL_SCHEME } from './internal-page'
import { PRIVILEGED_SCHEMES } from './privileged-schemes'
import { STAND_IN_SCHEME } from './redirect-resources'
import { ICON_SCHEME } from './site-icon'

describe('the schemes declared before the application is ready', () => {
  it('are the stand-in resources of the blocker, the copies of the icons of sites and the Extensions page, each once', () => {
    expect(PRIVILEGED_SCHEMES.map((entry) => entry.scheme)).toEqual([STAND_IN_SCHEME, ICON_SCHEME, INTERNAL_SCHEME])
  })

  it('are all secure, so that a page loaded over https or from the application may draw them', () => {
    for (const entry of PRIVILEGED_SCHEMES) expect(entry.privileges.secure, entry.scheme).toBe(true)
  })

  it('read the address of an icon like a web address: the copy is named by a query', () => {
    expect(PRIVILEGED_SCHEMES.find((entry) => entry.scheme === ICON_SCHEME)?.privileges).toEqual({ standard: true, secure: true })
    // The stand-ins keep the privileges they had: nothing more than secure.
    expect(PRIVILEGED_SCHEMES.find((entry) => entry.scheme === STAND_IN_SCHEME)?.privileges).toEqual({ secure: true })
  })

  it('give the Extensions page what makes its address read like a web one and its origin exact, and nothing that opens it to a page or to the policy of content', () => {
    const privileges = PRIVILEGED_SCHEMES.find((entry) => entry.scheme === INTERNAL_SCHEME)?.privileges
    // A privilege more (supportFetchAPI, corsEnabled, bypassCSP…) would be a way for another origin to fetch it, to read it, or to bypass the content policy of its own page.
    expect(privileges).toEqual({ standard: true, secure: true })
  })
})
