// The passkey probe (passkey-probe.ts): what its page records of the engine, run here against a stand-in of a page, and what its server
// answers. What a real engine answers is what the probe is for, and is not tested here.

import { describe, expect, it, vi } from 'vitest'
import { PROBE_TIMEOUT_MS, probePage, probeResponse, probeRun, type ProbeReport } from './passkey-probe'

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const named = (name: string, message: string): Error => Object.assign(new Error(message), { name })

/** A page whose engine announces `announced` and answers a request with `credentials`. The clock moves 7 ms per reading. */
function fakePage(over: { announced?: Record<string, () => Promise<unknown>>; create?: (options: any) => Promise<unknown>; get?: (options: any) => Promise<unknown>; noWebAuthn?: boolean } = {}) {
  let clock = 0
  const create = vi.fn(over.create ?? (async () => ({ rawId: new Uint8Array([1, 2, 3]).buffer, authenticatorAttachment: 'cross-platform', response: { getTransports: () => ['usb'] } })))
  const get = vi.fn(over.get ?? (async () => ({ rawId: new Uint8Array([1, 2, 3]).buffer, authenticatorAttachment: 'cross-platform', response: {} })))
  const PublicKeyCredential = Object.assign(function PublicKeyCredential() {}, over.announced ?? { isUserVerifyingPlatformAuthenticatorAvailable: async () => false })
  const win: any = {
    navigator: { userAgent: 'Lucium/Test', ...(over.noWebAuthn ? {} : { credentials: { create, get } }) },
    location: { origin: 'http://localhost:8765' },
    isSecureContext: true,
    crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) },
    performance: { now: () => (clock += 7) },
    ...(over.noWebAuthn ? {} : { PublicKeyCredential })
  }
  const renders: string[] = []
  const report = probeRun(win, PROBE_TIMEOUT_MS, (now) => renders.push(JSON.stringify(now)))
  return { win, report, renders, create, get, probe: (what: string): Promise<void> => win.probe(what) }
}

describe('the passkey probe, in the page', () => {
  it('records what the engine announces before any request, a call that fails included', async () => {
    const page = fakePage({
      announced: {
        isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
        isConditionalMediationAvailable: async () => Promise.reject(named('NotSupportedError', 'no')),
        getClientCapabilities: async () => ({ hybridTransport: false })
      }
    })
    await settle()
    expect(page.report).toMatchObject({ userAgent: 'Lucium/Test', origin: 'http://localhost:8765', secureContext: true, attempts: [] })
    expect(page.report.capabilities).toEqual({
      PublicKeyCredential: true,
      'navigator.credentials': true,
      isUserVerifyingPlatformAuthenticatorAvailable: true,
      isConditionalMediationAvailable: 'NotSupportedError: no',
      getClientCapabilities: { hybridTransport: false }
    })
    // The page shows the report as it fills.
    expect(JSON.parse(page.renders.at(-1)!)).toEqual(page.report)
  })

  it('says a call the engine does not have is absent, and that an engine without WebAuthn has none', async () => {
    const page = fakePage()
    await settle()
    expect(page.report.capabilities['isConditionalMediationAvailable']).toBe('absent')
    expect(page.report.capabilities['getClientCapabilities']).toBe('absent')
    const none = fakePage({ noWebAuthn: true })
    expect(none.report.capabilities).toEqual({ PublicKeyCredential: false, 'navigator.credentials': false })
  })

  it('asks for a key on this Mac, on a key that travels, or on either, each as its button says', async () => {
    const page = fakePage()
    await page.probe('create-platform')
    await page.probe('create-roaming')
    await page.probe('create-any')
    const selections = page.create.mock.calls.map(([options]) => options.publicKey.authenticatorSelection.authenticatorAttachment)
    expect(selections).toEqual(['platform', 'cross-platform', undefined])
    const asked = page.create.mock.calls[0]![0].publicKey
    expect(asked).toMatchObject({ rp: { name: 'Sonde Lucium' }, timeout: PROBE_TIMEOUT_MS, attestation: 'none' })
    // No `rp.id`: the key is for the name the page is served under, whatever the port.
    expect(asked.rp.id).toBeUndefined()
    expect(asked.challenge).toHaveLength(32)
    expect(page.report.attempts).toEqual([
      { what: 'create-platform', durationMs: 7, outcome: 'ok', attachment: 'cross-platform', transports: ['usb'] },
      { what: 'create-roaming', durationMs: 7, outcome: 'ok', attachment: 'cross-platform', transports: ['usb'] },
      { what: 'create-any', durationMs: 7, outcome: 'ok', attachment: 'cross-platform', transports: ['usb'] }
    ])
  })

  it('records a refusal by its name, its message and the time it took, and goes on with the next request', async () => {
    const page = fakePage({ create: async () => Promise.reject(named('NotAllowedError', 'The operation either timed out or was not allowed.')) })
    await page.probe('create-platform')
    await page.probe('get-any')
    expect(page.report.attempts[0]).toEqual({ what: 'create-platform', durationMs: 7, outcome: 'error', errorName: 'NotAllowedError', errorMessage: 'The operation either timed out or was not allowed.' })
    expect(page.report.attempts[1]).toMatchObject({ what: 'get-any', outcome: 'ok' })
    expect(JSON.parse(page.renders.at(-1)!).attempts).toHaveLength(2)
  })

  it('records a request the engine throws at instead of refusing', async () => {
    const page = fakePage({
      get: () => {
        throw named('TypeError', 'publicKey is not supported')
      }
    })
    await page.probe('get-any')
    expect(page.report.attempts).toEqual([{ what: 'get-any', durationMs: 7, outcome: 'error', errorName: 'TypeError', errorMessage: 'publicKey is not supported' }])
  })

  it('signs in with the keys it created when asked to, and with any key otherwise', async () => {
    const page = fakePage()
    await page.probe('create-any')
    await page.probe('get-created')
    await page.probe('get-any')
    const [known, any] = page.get.mock.calls.map(([options]) => options.publicKey)
    expect(known.allowCredentials).toEqual([{ type: 'public-key', id: new Uint8Array([1, 2, 3]).buffer }])
    expect(any.allowCredentials).toBeUndefined()
  })

  it('does nothing for a button it does not know', async () => {
    const page = fakePage()
    await page.probe('delete-everything')
    expect(page.report.attempts).toEqual([])
    expect(page.create).not.toHaveBeenCalled()
  })
})

describe('the passkey probe, its page and its server', () => {
  it('serves a page that carries the whole probe, a button for each request, and a policy that lets it reach nothing', () => {
    const page = probePage()
    expect(page).toContain("default-src 'none'")
    expect(page).not.toMatch(/https?:\/\/(?!localhost)/)
    for (const what of ['create-platform', 'create-roaming', 'create-any', 'get-created', 'get-any']) expect(page, what).toContain(`data-what="${what}"`)
    // The text of the function is the page's script: it must run as it is, with nothing of the module around it.
    const script = /<script>\n([\s\S]*)<\/script>/.exec(page)![1]!
    const buttons = [{ dataset: { what: 'get-any' }, disabled: false, addEventListener: vi.fn() }]
    const node = { textContent: '', addEventListener: vi.fn() }
    const document = { getElementById: () => node, querySelectorAll: () => buttons }
    const window: any = { navigator: { userAgent: 'x' }, location: { origin: 'http://localhost:1' }, isSecureContext: true, crypto: {}, performance: { now: () => 0 } }
    new Function('window', 'document', 'navigator', script)(window, document, window.navigator)
    expect(typeof window.probe).toBe('function')
    expect(JSON.parse(node.textContent) satisfies ProbeReport).toMatchObject({ userAgent: 'x', attempts: [] })
    expect(buttons[0]!.addEventListener).toHaveBeenCalledWith('click', expect.any(Function))
  })

  it('answers the page only, to a request that names this machine', () => {
    const page = probeResponse('GET', '/', 'localhost:8765', 8765)
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(page.body).toBe(probePage())
    // Another name is another site for WebAuthn, and a page of the web that points a name at this machine gets nothing.
    expect(probeResponse('GET', '/', '127.0.0.1:8765', 8765).status).toBe(421)
    expect(probeResponse('GET', '/', 'evil.example:8765', 8765).status).toBe(421)
    expect(probeResponse('GET', '/', undefined, 8765).status).toBe(421)
    expect(probeResponse('GET', '/', 'localhost:9999', 8765).status).toBe(421)
    expect(probeResponse('POST', '/', 'localhost:8765', 8765).status).toBe(405)
    expect(probeResponse('GET', '/../package.json', 'localhost:8765', 8765).status).toBe(404)
    expect(probeResponse('GET', '/?x=1', 'localhost:8765', 8765).status).toBe(404)
  })
})
