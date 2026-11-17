import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { clientHintsOf, DEFAULT_CLIENT_HINTS, isTrustworthyWebUrl, takesNavigationHints, UA_DATA_LIMITS, UA_DATA_SCRIPT, withNavigationHints } from './client-hints'

// What a page of Chromium 156 read of navigator.userAgentData, and what Chromium put on the image, the script and the image of another site of
// that page, in every window measured on 13 November 2026 (Electron 45.2.1, Chromium 156.0.8078.75, macOS).
const READ = { brands: [{ brand: 'Not:A-Brand', version: '8' }, { brand: 'Chromium', version: '156' }], mobile: false, platform: 'macOS' }
const MEASURED = { 'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="156"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"' }
const HINTS = clientHintsOf(READ)!

describe('the Client Hints of the engine, from what a page of it reads', () => {
  it('are, from what the page read on 13 November, exactly the three headers Chromium sent, in the order it writes them on a navigation', () => {
    expect(HINTS).toEqual(MEASURED)
    expect(Object.keys(HINTS)).toEqual([...DEFAULT_CLIENT_HINTS])
  })

  it('keep the brands, their order and their versions as the engine gives them, and nothing is added or guessed', () => {
    const odd = clientHintsOf({ brands: [{ brand: 'Chromium', version: '157' }, { brand: 'Not.A/Brand', version: '99' }], mobile: true, platform: 'Linux' })
    expect(odd).toEqual({ 'sec-ch-ua': '"Chromium";v="157", "Not.A/Brand";v="99"', 'sec-ch-ua-mobile': '?1', 'sec-ch-ua-platform': '"Linux"' })
  })

  it('write a quote or a backslash of a value as a structured field does, escaped', () => {
    expect(clientHintsOf({ ...READ, brands: [{ brand: 'A"B\\C', version: '1' }] })!['sec-ch-ua']).toBe('"A\\"B\\\\C";v="1"')
  })

  it('give nothing when the brands were not read, or when what was read is not text a header can carry', () => {
    const bad: unknown[] = [
      null,
      undefined,
      'macOS',
      {},
      { ...READ, brands: [] },
      { ...READ, brands: undefined },
      { ...READ, brands: 'Chromium' },
      { ...READ, brands: [{ brand: '', version: '1' }] },
      { ...READ, brands: [{ brand: 'Chromium' }] },
      { ...READ, brands: [{ brand: 'Chromium', version: 156 }] },
      { ...READ, brands: [null] },
      { ...READ, brands: [{ brand: 'Chrömium', version: '1' }] },
      { ...READ, brands: [{ brand: 'A\r\nX-Evil: 1', version: '1' }] },
      { ...READ, brands: [{ brand: 'x'.repeat(UA_DATA_LIMITS.text + 1), version: '1' }] },
      { ...READ, brands: Array.from({ length: UA_DATA_LIMITS.brands + 1 }, () => READ.brands[0]) },
      { ...READ, mobile: 'false' },
      { ...READ, mobile: undefined },
      { ...READ, platform: undefined },
      { ...READ, platform: 'mac\nOS' }
    ]
    for (const read of bad) expect(clientHintsOf(read), JSON.stringify(read) ?? String(read)).toBeNull()
  })

  it('are read in the page by a script that answers plain values, or null in a page without navigator.userAgentData', () => {
    const userAgentData = { brands: READ.brands.map((entry) => ({ ...entry, extra: 'kept out' })), mobile: false, platform: 'macOS', getHighEntropyValues: () => Promise.resolve({}) }
    expect(runInNewContext(UA_DATA_SCRIPT, { navigator: { userAgentData } })).toEqual(READ)
    expect(runInNewContext(UA_DATA_SCRIPT, { navigator: {} })).toBeNull()
    expect(clientHintsOf(runInNewContext(UA_DATA_SCRIPT, { navigator: { userAgentData } }))).toEqual(MEASURED)
  })
})

describe('the addresses Chromium trusts with Client Hints', () => {
  it('are https, and http to this machine only', () => {
    for (const url of ['https://site.example/', 'https://site.example:8443/a?b', 'http://localhost:5173/', 'http://LOCALHOST/', 'http://localhost./', 'http://app.localhost/', 'http://127.0.0.1:8080/', 'http://127.1.2.3/', 'http://[::1]:3000/'])
      expect(isTrustworthyWebUrl(url), url).toBe(true)
    for (const url of ['http://site.example/', 'http://192.168.1.10/', 'http://10.0.0.2:8080/', 'http://localhost.site.example/', 'http://127.0.0.1.site.example/', 'ws://localhost/', 'wss://site.example/', 'file:///Users/me/page.html', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html', 'lucium://settings', 'data:text/html,x', 'about:blank', 'not a url'])
      expect(isTrustworthyWebUrl(url), url).toBe(false)
  })
})

describe('the hints on the navigations of a page', () => {
  const ASKED = { 'Upgrade-Insecure-Requests': '1', 'User-Agent': 'Mozilla/5.0 Chrome/156.0.0.0', Accept: 'text/html', 'Sec-Fetch-Dest': 'document' }

  it('go on the navigation of a tab and of a frame, in front of what Chromium wrote, and nothing else is changed', () => {
    for (const resourceType of ['mainFrame', 'subFrame']) {
      const sent = withNavigationHints({ url: 'https://site.example/', resourceType }, ASKED, HINTS)
      expect(sent, resourceType).toEqual({ ...MEASURED, ...ASKED })
      expect(Object.keys(sent), resourceType).toEqual([...DEFAULT_CLIENT_HINTS, ...Object.keys(ASKED)])
    }
    expect(takesNavigationHints({ url: 'http://localhost:5173/', resourceType: 'mainFrame' })).toBe(true)
  })

  it('never go on what Chromium already gives them to (an image, a script, a fetch), nor on a WebSocket or a request of the application', () => {
    for (const resourceType of ['image', 'script', 'stylesheet', 'xhr', 'font', 'media', 'ping', 'webSocket', 'other']) {
      expect(withNavigationHints({ url: 'https://site.example/a', resourceType }, ASKED, HINTS), resourceType).toBe(ASKED)
    }
  })

  it('never go to an address Chromium does not trust with them, nor to a page of the application, of an extension or of the disk', () => {
    for (const url of ['http://site.example/', 'http://192.168.1.10/', 'lucium://settings', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html', 'file:///Users/me/page.html', 'data:text/html,x']) {
      expect(withNavigationHints({ url, resourceType: 'mainFrame' }, ASKED, HINTS), url).toBe(ASKED)
    }
  })

  it('never replace a Sec-CH-UA header already there, whatever the case of its name, and add none beside it', () => {
    const present: Array<Record<string, string>> = [{ 'sec-ch-ua': '"Other";v="1"' }, { 'Sec-CH-UA': '"Other";v="1"' }, { 'sec-ch-ua-platform': '"Linux"' }, { 'SEC-CH-UA-MOBILE': '?1' }]
    for (const one of present) {
      const headers = { ...ASKED, ...one }
      expect(withNavigationHints({ url: 'https://site.example/', resourceType: 'mainFrame' }, headers, HINTS), JSON.stringify(one)).toBe(headers)
    }
    // Another hint (a preference of the page) is no hint of the user agent: the three still go.
    expect(withNavigationHints({ url: 'https://site.example/', resourceType: 'mainFrame' }, { 'sec-ch-prefers-color-scheme': 'dark' }, HINTS)).toEqual({ ...MEASURED, 'sec-ch-prefers-color-scheme': 'dark' })
  })

  it('are the three default ones only: never a hint a site asks for, and nothing at all from an engine that has no hints to give', () => {
    const sent = withNavigationHints({ url: 'https://site.example/', resourceType: 'mainFrame' }, {}, HINTS)
    expect(Object.keys(sent)).toEqual(['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'])
    expect(withNavigationHints({ url: 'https://site.example/', resourceType: 'mainFrame' }, ASKED, null)).toBe(ASKED)
  })
})
