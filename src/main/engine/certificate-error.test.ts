import { describe, expect, it, vi } from 'vitest'
import { CertificateExceptions, type CertificateFacts } from '@shared/error-pages'
import { isDeveloperUrl } from '@shared/developer-mode'
import { certificateErrorListener, type CertificateLike } from './certificate-error'

const session = {}
const certificate: CertificateLike = { fingerprint: 'sha256/AAAA', subjectName: 'ha.exemple.fr', issuerName: 'YE2', validStart: 1_700_000_000, validExpiry: 1_800_000_000 }
const URL_OF_SITE = 'https://ha.exemple.fr:8123/lovelace'

/** `developer`: the sites in Developer Mode (the setting `developerHosts`), the only ones whose invalid certificate goes through unasked. */
function setup(allowed: boolean, pageUrl = URL_OF_SITE, developer: readonly string[] = [], strict: readonly string[] = []) {
  const exceptions = new CertificateExceptions()
  if (allowed) exceptions.allow(session, 'ha.exemple.fr', certificate.fingerprint)
  const refused: Array<{ host: string; facts: CertificateFacts }> = []
  const accepted: string[] = []
  const queued: Array<() => void> = []
  const listener = certificateErrorListener({
    exceptions,
    session: () => session,
    pageUrl: () => pageUrl,
    developerSite: (url) => isDeveloperUrl(url, developer),
    strictTransport: (host) => strict.includes(host),
    refused: (host, facts) => refused.push({ host, facts }),
    accepted: (host) => accepted.push(host),
    defer: (run) => void queued.push(run)
  })
  const event = { preventDefault: vi.fn() }
  const callback = vi.fn()
  return { listener, event, callback, refused, accepted, queued, exceptions }
}

describe('certificate-error listener', () => {
  it('lets a certificate the user chose to trust through, and answers after the event is over', () => {
    const { listener, event, callback, queued } = setup(true)
    listener(event, URL_OF_SITE, 'net::ERR_CERT_COMMON_NAME_INVALID', certificate, callback, true)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    // Answering from inside the event took the application down (Electron 45.0.0, SIGSEGV in App::AllowCertificateError).
    expect(callback).not.toHaveBeenCalled()
    expect(queued).toHaveLength(1)
    queued[0]!()
    expect(callback).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('remembers the host whose certificate was let through, apart from the page that asked for it: what it answers is no longer proof', () => {
    const { listener, event, callback, exceptions } = setup(true, 'https://tableau.exemple.fr/')
    expect(exceptions.wasLetThrough(session, 'ha.exemple.fr')).toBe(false)
    listener(event, 'https://HA.exemple.fr:8123/api', 'net::ERR_CERT_COMMON_NAME_INVALID', certificate, callback, false)
    expect(exceptions.wasLetThrough(session, 'ha.exemple.fr')).toBe(true)
    expect(exceptions.wasLetThrough(session, 'HA.EXEMPLE.FR')).toBe(true)
    // The page is the one that reads « Non sécurisé »; its own certificate was not let through.
    expect(exceptions.isUntrusted(session, 'tableau.exemple.fr')).toBe(true)
    expect(exceptions.wasLetThrough(session, 'tableau.exemple.fr')).toBe(false)
    expect(exceptions.wasLetThrough({}, 'ha.exemple.fr')).toBe(false)
    expect(exceptions.wasLetThrough(session, '')).toBe(false)
  })

  it('remembers nothing of a host whose certificate was refused', () => {
    const { listener, event, callback, exceptions } = setup(false)
    listener(event, URL_OF_SITE, 'net::ERR_CERT_COMMON_NAME_INVALID', certificate, callback, true)
    expect(exceptions.wasLetThrough(session, 'ha.exemple.fr')).toBe(false)
  })

  it('answers on the next turn of the event loop by default, not within the event', async () => {
    const exceptions = new CertificateExceptions()
    exceptions.allow(session, 'ha.exemple.fr', certificate.fingerprint)
    const listener = certificateErrorListener({ exceptions, session: () => session, pageUrl: () => URL_OF_SITE, developerSite: () => false, refused: () => undefined })
    const callback = vi.fn()
    listener({ preventDefault: vi.fn() }, URL_OF_SITE, 'net::ERR_CERT_COMMON_NAME_INVALID', certificate, callback, true)
    expect(callback).not.toHaveBeenCalled()
    await new Promise((resolve) => setImmediate(resolve))
    expect(callback).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('leaves a certificate nobody vouched for refused, and hands it over for the error page of the main frame', () => {
    const { listener, event, callback, refused, queued } = setup(false)
    listener(event, URL_OF_SITE, 'net::ERR_CERT_COMMON_NAME_INVALID', certificate, callback, true)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(queued).toHaveLength(0)
    expect(callback).not.toHaveBeenCalled()
    expect(refused).toEqual([{ host: 'ha.exemple.fr', facts: { fingerprint: 'sha256/AAAA', subject: 'ha.exemple.fr', issuer: 'YE2', validFrom: 1_700_000_000, validUntil: 1_800_000_000 } }])
  })

  it('does not hand over a certificate refused for a subresource: the page shown is the main frame’s', () => {
    const { listener, event, callback, refused } = setup(false)
    listener(event, 'https://ha.exemple.fr/api.js', 'net::ERR_CERT_COMMON_NAME_INVALID', certificate, callback, false)
    expect(refused).toEqual([])
  })

  it('asks again for another certificate on the same host', () => {
    const { listener, event, callback, queued, refused } = setup(true)
    listener(event, URL_OF_SITE, 'net::ERR_CERT_COMMON_NAME_INVALID', { ...certificate, fingerprint: 'sha256/BBBB' }, callback, true)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(queued).toHaveLength(0)
    expect(refused).toHaveLength(1)
  })

  it('marks the page of a certificate the user chose to trust as not secure, for the rest of the session', () => {
    const { listener, event, callback, accepted, exceptions } = setup(true)
    expect(exceptions.isUntrusted(session, 'ha.exemple.fr')).toBe(false)
    listener(event, URL_OF_SITE, 'net::ERR_CERT_COMMON_NAME_INVALID', certificate, callback, true)
    expect(accepted).toEqual(['ha.exemple.fr'])
    expect(exceptions.isUntrusted(session, 'ha.exemple.fr')).toBe(true)
    // Another session (a private window) has its own record.
    expect(exceptions.isUntrusted({}, 'ha.exemple.fr')).toBe(false)
  })

  // Nothing of the local network or of this machine is trusted by its name or its address: a device on the Wi-Fi of a café can be anyone.
  it.each(['https://192.168.1.20:8123/', 'https://10.0.0.5/', 'https://172.20.1.1/', 'https://homeassistant.local:8123/', 'https://localhost:5173/', 'https://127.0.0.1:8443/'])(
    'refuses a private address, a .local name or this machine that is not in Developer Mode, and the error page follows (%s)',
    (url) => {
      const { listener, event, callback, queued, refused, accepted, exceptions } = setup(false, url)
      listener(event, url, 'net::ERR_CERT_AUTHORITY_INVALID', certificate, callback, true)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(queued).toHaveLength(0)
      expect(callback).not.toHaveBeenCalled()
      expect(refused).toHaveLength(1)
      expect(accepted).toEqual([])
      expect(exceptions.isUntrusted(session, new URL(url).hostname)).toBe(false)
    }
  )

  it.each([
    ['a .local preproduction', 'https://app.local:8443/', ['app.local']],
    ['localhost', 'https://localhost:5173/', ['localhost']],
    ['a private address', 'https://192.168.1.20:8123/', ['192.168.1.20']],
    ['a subdomain of a listed site', 'https://api.preprod.local/', ['preprod.local']]
  ])('lets %s in Developer Mode through, after the event is over, and marks its page as not secure', (_what, url, developer) => {
    const { listener, event, callback, queued, refused, accepted, exceptions } = setup(false, 'https://forum.exemple.com/thread/1', developer)
    listener(event, url, 'net::ERR_CERT_AUTHORITY_INVALID', certificate, callback, true)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(callback).not.toHaveBeenCalled()
    queued.forEach((run) => run())
    expect(callback).toHaveBeenCalledExactlyOnceWith(true)
    expect(refused).toEqual([])
    const host = new URL(url).hostname
    expect(accepted).toEqual([host])
    expect(exceptions.isUntrusted(session, host)).toBe(true)
  })

  // Developer Mode is also what reloads a site without the cache: listing a site of the internet must not open it to whoever intercepts it.
  it.each([
    ['a site of the internet', 'https://preprod.exemple.com/', ['preprod.exemple.com']],
    ['a subdomain of a listed site of the internet', 'https://compte.banque.exemple/', ['banque.exemple']],
    ['any site under a listed top-level name', 'https://banque.com/', ['com']],
    ['a public address', 'https://203.0.113.7/', ['203.0.113.7']]
  ])('refuses %s in Developer Mode, and hands its certificate over for the error page', (_what, url, developer) => {
    const { listener, event, callback, queued, refused, accepted, exceptions } = setup(false, url, developer)
    listener(event, url, 'net::ERR_CERT_AUTHORITY_INVALID', certificate, callback, true)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(queued).toHaveLength(0)
    expect(callback).not.toHaveBeenCalled()
    expect(refused).toHaveLength(1)
    expect(accepted).toEqual([])
    expect(exceptions.isUntrusted(session, new URL(url).hostname)).toBe(false)
  })

  it('refuses what a local page in Developer Mode loads from a listed site of the internet', () => {
    const { listener, event, callback, queued } = setup(false, 'https://app.local/', ['app.local', 'api.exemple.com'])
    listener(event, 'https://api.exemple.com/v1', 'net::ERR_CERT_AUTHORITY_INVALID', certificate, callback, false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(queued).toHaveLength(0)
  })

  it('refuses what a page of a listed site of the internet loads from a local site in Developer Mode', () => {
    const { listener, event, callback, queued } = setup(false, 'https://preprod.exemple.com/', ['app.local', 'preprod.exemple.com'])
    listener(event, 'https://app.local/api.js', 'net::ERR_CERT_AUTHORITY_INVALID', certificate, callback, false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(queued).toHaveLength(0)
  })

  it('still honours the exception the user made for the certificate of a listed site of the internet', () => {
    const { listener, event, callback, queued } = setup(true, URL_OF_SITE, ['ha.exemple.fr'])
    listener(event, URL_OF_SITE, 'net::ERR_CERT_AUTHORITY_INVALID', certificate, callback, true)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(queued).toHaveLength(1)
  })

  it('honours no exception for a host that asked for strict transport security, and hands the certificate over for the error page', () => {
    const { listener, event, callback, queued, refused, accepted } = setup(true, URL_OF_SITE, [], ['ha.exemple.fr'])
    listener(event, URL_OF_SITE, 'net::ERR_CERT_AUTHORITY_INVALID', certificate, callback, true)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(queued).toHaveLength(0)
    expect(refused).toHaveLength(1)
    expect(accepted).toEqual([])
  })

  it('refuses in Developer Mode too what nobody may click through (a revoked certificate)', () => {
    const { listener, event, callback, queued, refused } = setup(false, 'https://app.local/', ['app.local'])
    listener(event, 'https://app.local/', 'net::ERR_CERT_REVOKED', certificate, callback, true)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(queued).toHaveLength(0)
    expect(refused).toHaveLength(1)
  })

  // The pass is for the sites the user listed: what a page of such a site loads from another one, never what a page from elsewhere loads from them.
  describe('what a page loads from a site in Developer Mode', () => {
    const PREPROD = 'https://app.local:8443/dashboard'
    const LISTED = ['app.local', 'api.local', 'localhost']

    it.each(['https://app.local:8443/assets/app.js', 'wss://app.local:8443/socket', 'https://api.local/v1/items', 'https://localhost:9443/hmr'])(
      'is let through on a page of a listed site, after the event is over, and marks that page (%s)',
      (url) => {
        const { listener, event, callback, queued, refused, accepted, exceptions } = setup(false, PREPROD, LISTED)
        listener(event, url, 'net::ERR_CERT_AUTHORITY_INVALID', certificate, callback, false)
        expect(event.preventDefault).toHaveBeenCalledTimes(1)
        expect(callback).not.toHaveBeenCalled()
        queued.forEach((run) => run())
        expect(callback).toHaveBeenCalledExactlyOnceWith(true)
        expect(refused).toEqual([])
        // The page the request belongs to is the one that is not secure any more.
        expect(accepted).toEqual(['app.local'])
        expect(exceptions.isUntrusted(session, 'app.local')).toBe(true)
      }
    )

    it.each([
      ['a script', 'https://app.local:8443/admin.js'],
      ['a frame', 'https://api.local/embed'],
      ['a WebSocket', 'wss://app.local:8443/socket'],
      ['a loopback service', 'https://localhost:9443/']
    ])('is refused on a page of a site that is not listed (%s)', (_what, url) => {
      const { listener, event, callback, queued, refused, exceptions } = setup(false, 'https://pub.exemple.com/', LISTED)
      listener(event, url, 'net::ERR_CERT_AUTHORITY_INVALID', certificate, callback, false)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(queued).toHaveLength(0)
      expect(callback).not.toHaveBeenCalled()
      // Not the main frame: nothing is handed over for an error page either, and the public page is not marked.
      expect(refused).toEqual([])
      expect(exceptions.isUntrusted(session, 'pub.exemple.com')).toBe(false)
    })

    it('is refused on a listed page when the request goes to a site that is not listed', () => {
      const { listener, event, callback, queued } = setup(false, PREPROD, LISTED)
      listener(event, 'https://192.168.1.1/admin.js', 'net::ERR_CERT_AUTHORITY_INVALID', certificate, callback, false)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(queued).toHaveLength(0)
    })
  })

  it('marks the page, not the subresource, when a certificate the user trusted serves what a page loads', () => {
    const { listener, event, callback, accepted, exceptions } = setup(true, 'https://pub.exemple.com/')
    listener(event, 'https://ha.exemple.fr/api.js', 'net::ERR_CERT_COMMON_NAME_INVALID', certificate, callback, false)
    expect(accepted).toEqual(['pub.exemple.com'])
    expect(exceptions.isUntrusted(session, 'pub.exemple.com')).toBe(true)
  })
})
