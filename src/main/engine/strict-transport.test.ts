// The hosts held as strict (HSTS), and the page of a certificate error on one of them: no « Continuer quand même », and a click forged for it does
// nothing. The page runs without Electron (page-errors.test-support.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ERROR_SCHEME } from '@shared/error-pages'
import { FakeContents, FakeCover, fakeHost } from './page-errors.test-support'
import { STRICT_HOSTS_MAX, StrictTransportHosts, isPreloadedStrictHost, noteStrictTransportAnswer, parseStrictTransport, strictTransportHeader, strictTransportHosts } from './strict-transport'

vi.mock('electron', () => ({ clipboard: { writeText: vi.fn() }, shell: { openExternal: vi.fn(async () => undefined) } }))
vi.mock('./page-cover', async () => ({ PageCover: (await import('./page-errors.test-support')).FakeCover }))

const { PageErrors, certificateExceptions } = await import('./error-pages')

describe('a Strict-Transport-Security header', () => {
  it.each([
    ['max-age=31536000', { maxAge: 31536000, includeSubDomains: false }],
    ['max-age=600; includeSubDomains', { maxAge: 600, includeSubDomains: true }],
    ['includeSubDomains ; MAX-AGE="60" ; preload', { maxAge: 60, includeSubDomains: true }],
    ['max-age=0', { maxAge: 0, includeSubDomains: false }]
  ])('is read (%s)', (header, policy) => {
    expect(parseStrictTransport(header)).toEqual(policy)
  })

  it('is bound to a year', () => {
    expect(parseStrictTransport('max-age=99999999999')?.maxAge).toBe(366 * 24 * 60 * 60)
  })

  it.each(['', 'includeSubDomains', 'max-age=abc', 'max-age=-1', 'max-age=10; max-age=20', 'max-age=10; includeSubDomains=1'])('is ignored when it is not valid (%j)', (header) => {
    expect(parseStrictTransport(header)).toBeNull()
  })
})

describe('the header among those of an answer', () => {
  it('is found under any case of its name, as a text or as the first of a list', () => {
    expect(strictTransportHeader({ 'Content-Type': ['text/html'], 'strict-transport-security': ['max-age=60', 'max-age=0'] })).toBe('max-age=60')
    expect(strictTransportHeader({ 'Strict-Transport-Security': 'max-age=600' })).toBe('max-age=600')
  })

  it('is null when the answer has none', () => {
    expect(strictTransportHeader({ 'Content-Type': ['text/html'] })).toBeNull()
    expect(strictTransportHeader({ 'Strict-Transport-Security': [] })).toBeNull()
    expect(strictTransportHeader(undefined)).toBeNull()
  })
})

describe('an answer that asks for strict transport security', () => {
  const session = {}
  const none = (): boolean => false

  it('makes its host strict when its certificate was valid', () => {
    const hosts = new StrictTransportHosts()
    noteStrictTransportAnswer(hosts, none, session, { url: 'https://Banque.exemple.fr/compte', responseHeaders: { 'Strict-Transport-Security': ['max-age=600; includeSubDomains'] } })
    expect(hosts.isStrict(session, 'banque.exemple.fr')).toBe(true)
    expect(hosts.isStrict(session, 'www.banque.exemple.fr')).toBe(true)
    expect(hosts.isStrict({}, 'banque.exemple.fr')).toBe(false)
  })

  it('changes nothing without the header, in http, or for an address that cannot be read', () => {
    const hosts = new StrictTransportHosts()
    noteStrictTransportAnswer(hosts, none, session, { url: 'https://exemple.fr/', responseHeaders: { 'Content-Type': ['text/html'] } })
    noteStrictTransportAnswer(hosts, none, session, { url: 'https://exemple.fr/' })
    noteStrictTransportAnswer(hosts, none, session, { url: 'http://exemple.fr/', responseHeaders: { 'Strict-Transport-Security': ['max-age=600'] } })
    noteStrictTransportAnswer(hosts, none, session, { url: 'pas une adresse', responseHeaders: { 'Strict-Transport-Security': ['max-age=600'] } })
    expect(hosts.isStrict(session, 'exemple.fr')).toBe(false)
  })

  it('is not believed from a host whose invalid certificate was let through: the one who intercepts could send it, or withdraw it', () => {
    const hosts = new StrictTransportHosts()
    const asked: string[] = []
    const letThrough = (host: string): boolean => (asked.push(host), host === 'nas.exemple.fr')
    noteStrictTransportAnswer(hosts, letThrough, session, { url: 'https://NAS.exemple.fr:8443/', responseHeaders: { 'Strict-Transport-Security': ['max-age=600'] } })
    expect(asked).toEqual(['nas.exemple.fr'])
    expect(hosts.isStrict(session, 'nas.exemple.fr')).toBe(false)
    // A host held as strict keeps it when an intercepted answer asks to withdraw it.
    hosts.note(session, 'https://nas.exemple.fr/', 'max-age=600')
    noteStrictTransportAnswer(hosts, letThrough, session, { url: 'https://nas.exemple.fr/', responseHeaders: { 'Strict-Transport-Security': ['max-age=0'] } })
    expect(hosts.isStrict(session, 'nas.exemple.fr')).toBe(true)
  })
})

describe('the hosts held as strict', () => {
  const session = {}

  it.each(['mon-app.dev', 'a.b.exemple.app', 'docs.page', 'ma.bank', 'EXEMPLE.DEV.'])('knows a name of a top-level domain preloaded as a whole (%s)', (host) => {
    expect(isPreloadedStrictHost(host)).toBe(true)
    expect(new StrictTransportHosts().isStrict(session, host)).toBe(true)
  })

  it.each(['exemple.fr', 'dev.exemple.com', 'localhost', 'app.local', '192.168.1.20', '[::1]', ''])('holds nothing against a name that never asked (%s)', (host) => {
    expect(new StrictTransportHosts().isStrict(session, host)).toBe(false)
  })

  it('holds a host that sent the header over https, for the time it asked, in the session that saw it', () => {
    let now = 1_000
    const hosts = new StrictTransportHosts(() => now)
    hosts.note(session, 'https://banque.exemple.fr/compte', 'max-age=60')
    expect(hosts.isStrict(session, 'banque.exemple.fr')).toBe(true)
    expect(hosts.isStrict(session, 'BANQUE.exemple.fr')).toBe(true)
    // Without includeSubDomains, the name alone.
    expect(hosts.isStrict(session, 'www.banque.exemple.fr')).toBe(false)
    expect(hosts.isStrict(session, 'exemple.fr')).toBe(false)
    // A private window has its own record.
    expect(hosts.isStrict({}, 'banque.exemple.fr')).toBe(false)
    now += 60_000
    expect(hosts.isStrict(session, 'banque.exemple.fr')).toBe(false)
  })

  it('covers the subdomains when the header asks for them', () => {
    const hosts = new StrictTransportHosts()
    hosts.note(session, 'https://exemple.fr/', 'max-age=600; includeSubDomains')
    expect(hosts.isStrict(session, 'a.b.exemple.fr')).toBe(true)
    expect(hosts.isStrict(session, 'autreexemple.fr')).toBe(false)
  })

  it('believes neither a header that came in http nor one of an address that is a number', () => {
    const hosts = new StrictTransportHosts()
    hosts.note(session, 'http://exemple.fr/', 'max-age=600')
    hosts.note(session, 'https://192.168.1.20/', 'max-age=600')
    hosts.note(session, 'pas une adresse', 'max-age=600')
    expect(hosts.isStrict(session, 'exemple.fr')).toBe(false)
    expect(hosts.isStrict(session, '192.168.1.20')).toBe(false)
  })

  it('forgets a host that withdraws with max-age=0', () => {
    const hosts = new StrictTransportHosts()
    hosts.note(session, 'https://exemple.fr/', 'max-age=600')
    hosts.note(session, 'https://exemple.fr/', 'max-age=0')
    expect(hosts.isStrict(session, 'exemple.fr')).toBe(false)
  })

  it('keeps a bounded number of hosts, the oldest leaving first', () => {
    const hosts = new StrictTransportHosts()
    for (let i = 0; i <= STRICT_HOSTS_MAX; i++) hosts.note(session, `https://h${i}.exemple.fr/`, 'max-age=600')
    expect(hosts.isStrict(session, 'h0.exemple.fr')).toBe(false)
    expect(hosts.isStrict(session, 'h1.exemple.fr')).toBe(true)
    expect(hosts.isStrict(session, `h${STRICT_HOSTS_MAX}.exemple.fr`)).toBe(true)
  })
})

describe('the hosts held as strict, handed out for the next run and read back', () => {
  const session = {}

  it('tells who writes them only when what would be written changed: a new host, a withdrawal, other subdomains, a much later end', () => {
    let now = 1_000
    const hosts = new StrictTransportHosts(() => now)
    const changed = vi.fn()
    hosts.onChange(changed)
    hosts.note(session, 'https://exemple.fr/', 'max-age=86400')
    expect(changed).toHaveBeenCalledExactlyOnceWith(session)
    // The same header a minute later: the end moves by a minute, which is not worth a write.
    now += 60_000
    hosts.note(session, 'https://exemple.fr/page', 'max-age=86400')
    hosts.note(session, 'http://exemple.fr/', 'max-age=86400')
    hosts.note(session, 'https://autre.exemple.fr/', 'max-age=0')
    expect(changed).toHaveBeenCalledTimes(1)
    hosts.note(session, 'https://exemple.fr/', 'max-age=86400; includeSubDomains')
    expect(changed).toHaveBeenCalledTimes(2)
    now += 2 * 60 * 60_000
    hosts.note(session, 'https://exemple.fr/', 'max-age=86400; includeSubDomains')
    expect(changed).toHaveBeenCalledTimes(3)
    hosts.note(session, 'https://exemple.fr/', 'max-age=0')
    expect(changed).toHaveBeenCalledTimes(4)
  })

  it('hands out the hosts still held, by the digest of their name, and takes them back in another run', () => {
    let now = 1_000
    const hosts = new StrictTransportHosts(() => now)
    hosts.note(session, 'https://exemple.fr/', 'max-age=600; includeSubDomains')
    hosts.note(session, 'https://court.exemple.org/', 'max-age=60')
    const records = hosts.records(session)
    expect(records).toHaveLength(2)
    expect(JSON.stringify(records)).not.toContain('exemple')
    now += 60_000
    expect(hosts.records(session)).toHaveLength(1)

    const next = new StrictTransportHosts(() => now)
    const later = {}
    expect(next.restore(later, records)).toBe(1)
    expect(next.isStrict(later, 'www.exemple.fr')).toBe(true)
    expect(next.isStrict(later, 'court.exemple.org')).toBe(false)
    expect(next.isStrict({}, 'www.exemple.fr')).toBe(false)
    expect(next.restore(later, 'not a list')).toBe(0)
  })

  it('keeps what the session learnt in this run over what an earlier run held, and never more hosts than its bound', () => {
    const now = 1_000
    const hosts = new StrictTransportHosts(() => now)
    const earlier = new StrictTransportHosts(() => now)
    earlier.note(session, 'https://exemple.fr/', 'max-age=600')
    hosts.note(session, 'https://exemple.fr/', 'max-age=600; includeSubDomains')
    expect(hosts.restore(session, earlier.records(session))).toBe(0)
    expect(hosts.isStrict(session, 'www.exemple.fr')).toBe(true)

    const many = Array.from({ length: STRICT_HOSTS_MAX + 10 }, (_, i) => ({ host: i.toString(16).padStart(64, '0'), until: now + 1000, includeSubDomains: false }))
    const full = {}
    expect(hosts.restore(full, many)).toBe(STRICT_HOSTS_MAX)
  })

  it('forgets the hosts of a session whose data is erased, and of that one only', () => {
    const hosts = new StrictTransportHosts()
    const other = {}
    hosts.note(session, 'https://exemple.fr/', 'max-age=600')
    hosts.note(other, 'https://exemple.fr/', 'max-age=600')
    hosts.forget(session)
    expect(hosts.isStrict(session, 'exemple.fr')).toBe(false)
    expect(hosts.records(session)).toEqual([])
    expect(hosts.isStrict(other, 'exemple.fr')).toBe(true)
  })
})

describe('the page of a certificate error', () => {
  const certificate = { fingerprint: 'sha256/AAAA', subjectName: 'autre.example', issuerName: 'X', validStart: 1, validExpiry: 2 }

  function page(url: string, before?: (wc: FakeContents) => void) {
    const wc = new FakeContents()
    const host = fakeHost()
    before?.(wc)
    new PageErrors(wc as never, host as never)
    const event = { preventDefault: vi.fn() }
    wc.emit('certificate-error', event, url, 'net::ERR_CERT_AUTHORITY_INVALID', certificate, vi.fn(), true)
    wc.fail(url, -202, 'net::ERR_CERT_AUTHORITY_INVALID')
    return { wc, host, event, written: wc.scripts.at(-1) ?? '' }
  }

  beforeEach(() => {
    FakeCover.made = []
  })

  it('offers « Continuer quand même » for a host that did not ask for strict transport, and a click keeps the exception', () => {
    const { wc, host, written } = page('https://exemple.fr/p')
    expect(written).toContain(`${ERROR_SCHEME}proceed?n=`)
    expect(written).not.toContain('exige une connexion sécurisée')
    wc.click('proceed')
    expect(certificateExceptions.isAllowed(wc.session, 'exemple.fr', 'sha256/AAAA')).toBe(true)
    expect(host.reload).toHaveBeenCalledTimes(1)
  })

  it('offers no way through for a host that asked for strict transport, and says why', () => {
    const { written } = page('https://compte.exemple.dev/p')
    expect(written).toContain('Votre connexion n’est pas privée')
    expect(written).toContain('exige une connexion sécurisée')
    expect(written).not.toContain(`${ERROR_SCHEME}proceed?n=`)
  })

  it('keeps no exception on a click forged for the missing button', () => {
    const { wc, host } = page('https://compte.exemple.dev/p')
    wc.click('proceed')
    expect(certificateExceptions.isAllowed(wc.session, 'compte.exemple.dev', 'sha256/AAAA')).toBe(false)
    expect(host.reload).not.toHaveBeenCalled()
  })

  it('keeps no exception when the host became strict while its page, drawn with the button, was on screen', () => {
    const { wc, host, written } = page('https://banque.exemple.fr/p')
    expect(written).toContain(`${ERROR_SCHEME}proceed?n=`)
    strictTransportHosts.note(wc.session, 'https://banque.exemple.fr/', 'max-age=600')
    wc.click('proceed')
    expect(certificateExceptions.isAllowed(wc.session, 'banque.exemple.fr', 'sha256/AAAA')).toBe(false)
    expect(host.reload).not.toHaveBeenCalled()
  })

  it('no longer honours an exception made before the host asked for strict transport', () => {
    const { event } = page('https://ancien.exemple.fr/p', (wc) => {
      certificateExceptions.allow(wc.session, 'ancien.exemple.fr', 'sha256/AAAA')
      strictTransportHosts.note(wc.session, 'https://ancien.exemple.fr/', 'max-age=600')
    })
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})
