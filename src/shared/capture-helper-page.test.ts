// The address of the helper of a capture of the sound of a tab (`lucium-ui://capture-helper/`, capture-helper-page.ts): a secure context the engine alone loads. What is said here:
// who is served it (the engine's own load, with the secret of the session, and nobody else), and that no other part of the application takes it for a page: it is no page of
// Extensions, no tab, no address a page of the web, a frame, a redirect or an extension can reach, nothing a state remembers.

import { describe, expect, it } from 'vitest'
import { CAPTURE_HELPER_DOCUMENT, CAPTURE_HELPER_URL, captureHelperHeaders, captureHelperRefusal, capturePcmSenderRefusal, namesCaptureHelper } from './capture-helper-page'
import { ActiveTabGrants, accessOf, canCaptureTab, canReadTab, extensionNavigableUrl } from './extension-access'
import { INTERNAL_PAGES_MATCH, INTERNAL_SCHEME, chromeAddressOf, displayAddress, internalPageParts, isInternalOrigin, isInternalPageUrl, isInternalScheme } from './internal-page'
import { INTERNAL_LOAD_HEADER, internalFileOf, internalRequestRefusal } from './internal-serve'
import { createInitialState, reduce, type Action } from './sidebar'
import { cleanTabUpdate } from './sidebar-helpers'
import { cleanTabs } from './state-clean'
import { isNavigableUrl, isViewSourceUrl } from './url'

const LOAD = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
const HERE = { [INTERNAL_LOAD_HEADER]: LOAD }
const request = (url: string, headers: Record<string, string> = {}, method = 'GET') => ({ method, url, headers: new Headers(headers) })
const navigation = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', ...HERE }
const ID = 'a'.repeat(32)

describe('the address of the helper page', () => {
  it('is on the scheme of the Extensions page, which is a secure one, on a host of its own', () => {
    expect(CAPTURE_HELPER_URL).toBe('lucium-ui://capture-helper/')
    expect(CAPTURE_HELPER_URL.startsWith(`${INTERNAL_SCHEME}://`)).toBe(true)
    // The preload of the Extensions page is registered for its address alone: the helper page runs none.
    expect(CAPTURE_HELPER_URL.startsWith(INTERNAL_PAGES_MATCH.replace('*', ''))).toBe(false)
  })

  it('is exactly that text: a path, a query, a fragment, another spelling or another host is another address', () => {
    expect(namesCaptureHelper(CAPTURE_HELPER_URL)).toBe(true)
    for (const other of ['lucium-ui://capture-helper', 'lucium-ui://capture-helper/x', 'lucium-ui://capture-helper/?a=1', 'lucium-ui://capture-helper/#a', 'lucium-ui://capture-helper:80/', 'lucium-ui://capture-helper@evil/', 'LUCIUM-UI://CAPTURE-HELPER/', 'lucium-ui://capture-helper.evil.com/', 'lucium-ui://extensions/', 'about:blank', 'https://capture-helper/', '', undefined, null, 5, {}]) {
      expect(namesCaptureHelper(other), String(other)).toBe(false)
    }
  })

  it('is a document that holds nothing: no script, no file, no name of the application', () => {
    expect(CAPTURE_HELPER_DOCUMENT).not.toMatch(/<script|<link|<img|src=|href=/i)
    expect(CAPTURE_HELPER_DOCUMENT.toLowerCase()).not.toContain('lucium')
  })
})

describe('who is served the helper page', () => {
  it('is the load of the engine, with the secret of the session', () => {
    expect(captureHelperRefusal(request(CAPTURE_HELPER_URL, HERE), LOAD)).toBeNull()
    expect(captureHelperRefusal(request(CAPTURE_HELPER_URL, navigation), LOAD)).toBeNull()
    expect(captureHelperRefusal(request(CAPTURE_HELPER_URL, HERE, 'HEAD'), LOAD)).toBeNull()
  })

  it('is no one without the secret: a frame, a script, an image or a fetch of a web page carries none', () => {
    const cases: Array<Record<string, string>> = [{}, { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-dest': 'script', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors' }, { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' }, { [INTERNAL_LOAD_HEADER]: '' }, { [INTERNAL_LOAD_HEADER]: 'nope' }, { [INTERNAL_LOAD_HEADER]: LOAD.toUpperCase() }, { [INTERNAL_LOAD_HEADER]: `${LOAD}x` }, { [INTERNAL_LOAD_HEADER]: LOAD.slice(1) }]
    for (const headers of cases) {
      expect(captureHelperRefusal(request(CAPTURE_HELPER_URL, headers), LOAD), JSON.stringify(headers)).toMatch(/engine only/)
    }
  })

  it('is no one when the session has no secret, or a short one: the empty secret opens nothing', () => {
    for (const load of ['', 'short', '0123456789abcde']) expect(captureHelperRefusal(request(CAPTURE_HELPER_URL, { [INTERNAL_LOAD_HEADER]: load }), load), load).not.toBeNull()
  })

  it('is refused what is not a load of a page, even with the secret: the method, a frame, a fetch, another site, an origin, a referrer', () => {
    for (const [headers, method] of [[HERE, 'POST'], [HERE, 'PUT'], [HERE, 'DELETE'], [{ ...HERE, 'sec-fetch-dest': 'iframe' }, 'GET'], [{ ...HERE, 'sec-fetch-dest': 'script' }, 'GET'], [{ ...HERE, 'sec-fetch-dest': 'empty' }, 'GET'], [{ ...HERE, 'sec-fetch-mode': 'cors' }, 'GET'], [{ ...HERE, 'sec-fetch-mode': 'no-cors' }, 'GET'], [{ ...HERE, 'sec-fetch-site': 'same-origin' }, 'GET'], [{ ...HERE, 'sec-fetch-site': 'cross-site' }, 'GET'], [{ ...HERE, origin: 'https://evil.example' }, 'GET'], [{ ...HERE, origin: 'lucium-ui://capture-helper' }, 'GET'], [{ ...HERE, referer: 'https://evil.example/' }, 'GET'], [{ ...HERE, referer: CAPTURE_HELPER_URL }, 'GET']] as const) {
      expect(captureHelperRefusal(request(CAPTURE_HELPER_URL, headers, method), LOAD), `${method} ${JSON.stringify(headers)}`).not.toBeNull()
    }
  })

  it('answers with headers that let nothing frame it, sniff it, keep it or read it from another origin', () => {
    const headers = captureHelperHeaders()
    expect(headers['content-type']).toBe('text/html; charset=utf-8')
    expect(headers['cache-control']).toBe('no-store')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['cross-origin-resource-policy']).toBe('same-origin')
    expect(headers['content-security-policy']).toBe("frame-ancestors 'none'")
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['referrer-policy']).toBe('no-referrer')
    expect(Object.keys(headers).some((name) => name.startsWith('access-control-'))).toBe(false)
  })
})

describe('what is not the helper page, as the rest of the application reads its address', () => {
  it('is no address of the Extensions page: it is not served as that page, and the page is not served for it', () => {
    expect(isInternalPageUrl(CAPTURE_HELPER_URL)).toBe(false)
    expect(internalPageParts(CAPTURE_HELPER_URL)).toBeNull()
    expect(isInternalOrigin('lucium-ui://capture-helper')).toBe(false)
    expect(isInternalOrigin('lucium-ui://extensions')).toBe(true)
    expect(internalFileOf(CAPTURE_HELPER_URL, { key: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', projectRoot: '/Users/jane/lucium' })).toBeNull() // gitleaks:allow (invented for this test, the key of no session)
    // The server of the Extensions page refuses it, whoever asks and with whatever secret.
    expect(internalRequestRefusal(request(CAPTURE_HELPER_URL, navigation), { load: LOAD, key: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' })).toBe('it names no file of the page') // gitleaks:allow (invented for this test, the key of no session)
    expect(chromeAddressOf(CAPTURE_HELPER_URL)).toBe(CAPTURE_HELPER_URL)
    expect(displayAddress(CAPTURE_HELPER_URL)).toBe(CAPTURE_HELPER_URL)
  })

  it('is on the scheme no page of the web may reach, by a link, a frame, a redirect or a window it opens', () => {
    expect(isInternalScheme(CAPTURE_HELPER_URL)).toBe(true)
    expect(isNavigableUrl(CAPTURE_HELPER_URL)).toBe(false)
    expect(isViewSourceUrl(CAPTURE_HELPER_URL)).toBe(false)
  })

  it('is no tab: the shell does not open it, with the flag that opens the Extensions page or without', () => {
    const base = createInitialState({ now: 1, newId: () => 'id' })
    for (const flags of [{}, { allowInternalPages: true }, { allowExtensionPages: true }, { allowInternalPages: true, allowExtensionPages: true }]) {
      const next = reduce(base, { type: 'tab/open', url: CAPTURE_HELPER_URL, ...flags } as Action, { now: 2, newId: () => 'id2' })
      expect(next.tabs, JSON.stringify(flags)).toEqual(base.tabs)
    }
  })

  it('is not an address a tab moves to, nor one a saved state keeps', () => {
    const tab = { id: 't', spaceId: 's', url: 'https://example.org/', title: 'x', pinned: false, createdAt: 0, lastActiveAt: 0 }
    expect(cleanTabUpdate({ url: CAPTURE_HELPER_URL }, tab).url).toBeUndefined()
    expect(cleanTabUpdate({ url: CAPTURE_HELPER_URL }, { ...tab, url: 'lucium-ui://extensions/' }).url).toBeUndefined()
    expect(cleanTabs([{ ...tab, url: CAPTURE_HELPER_URL }], new Set(['s']), new Map())).toEqual([])
  })

  it('is no address an extension opens a tab on (chrome.tabs.create, chrome.tabs.update)', () => {
    for (const url of [CAPTURE_HELPER_URL, `${CAPTURE_HELPER_URL}?x=1`, 'lucium-ui://capture-helper']) expect(extensionNavigableUrl(url, ID), url).toBeNull()
  })

  it('is no page an extension is handed, reads or captures', () => {
    const grants = new ActiveTabGrants()
    grants.grant(ID, 7, CAPTURE_HELPER_URL)
    expect(grants.has(ID, 7, CAPTURE_HELPER_URL)).toBe(false)
    // An extension with every host and the hand-over of the tab: no host pattern covers the scheme, and the hand-over was not made.
    const context = { extensionId: ID, access: accessOf({ manifest_version: 3, permissions: ['activeTab', 'tabCapture'], host_permissions: ['<all_urls>'] }), grants }
    expect(canReadTab(context, { id: 1, url: CAPTURE_HELPER_URL, title: 'x' })).toBe(false)
    expect(canCaptureTab(context, { id: 1, url: CAPTURE_HELPER_URL })).toBe(false)
  })
})

describe('who is taken for the sender of a chunk of sound', () => {
  const facts = { isHelper: true, frameOrigin: 'lucium-ui://capture-helper', frameUrl: CAPTURE_HELPER_URL, topFrame: true }

  it('is the main frame of a helper page that exists, at its own origin and address', () => {
    expect(capturePcmSenderRefusal(facts)).toBeNull()
  })

  it('is no web contents that is not a helper page: a tab, a page of an extension, the interface, whatever frame it speaks from', () => {
    expect(capturePcmSenderRefusal({ ...facts, isHelper: false })).toBe('the sender is no helper page')
    for (const origin of ['https://evil.example', `chrome-extension://${ID}`, 'lucium-ui://extensions', 'null', 'file://']) {
      expect(capturePcmSenderRefusal({ ...facts, isHelper: false, frameOrigin: origin, frameUrl: `${origin}/` }), origin).toBe('the sender is no helper page')
    }
  })

  it('is no frame that has no origin, or not exactly the origin of the helper page: not a look-alike, not another host of the scheme', () => {
    expect(capturePcmSenderRefusal({ ...facts, frameOrigin: undefined })).toBe('no sender frame')
    expect(capturePcmSenderRefusal({ ...facts, frameOrigin: null })).toBe('no sender frame')
    for (const origin of ['lucium-ui://extensions', 'lucium-ui://capture-helper.evil.com', 'lucium-ui://capture-helper/', 'lucium-ui://capture-helper:80', 'https://capture-helper', 'null', '', 5]) {
      expect(capturePcmSenderRefusal({ ...facts, frameOrigin: origin }), String(origin)).toBe('the sender frame is not at the origin of the helper page')
    }
  })

  it('is no frame inside the page: only its main frame', () => {
    expect(capturePcmSenderRefusal({ ...facts, topFrame: false })).toBe('the sender is not the main frame of the helper page')
  })

  it('is no document that is not at the address of the helper page: a page that went elsewhere keeps its origin out of its address', () => {
    for (const url of [undefined, null, 'about:blank', 'lucium-ui://capture-helper/x', 'lucium-ui://capture-helper/?a=1', 'https://evil.example/']) {
      expect(capturePcmSenderRefusal({ ...facts, frameUrl: url }), String(url)).toBe('the sender document is not at the address of the helper page')
    }
  })
})
