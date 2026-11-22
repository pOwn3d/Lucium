import { describe, expect, it } from 'vitest'
import { TOTP_LIMITS } from './totp'
import {
  NO_PASSWORDS_VIEW,
  PASSWORD_LIMITS,
  captureKind,
  checkedLogin,
  cleanPassword,
  cleanUsername,
  eligibleOriginOf,
  entriesForPage,
  fillVerdict,
  hostLabel,
  mayReportSubmit,
  parsePasswordRequest,
  parseSubmission,
  phraseProblem,
  rowOf,
  siteAddress,
  type FillContext,
  type PasswordEntry
} from './passwords'

const entry = (patch: Partial<PasswordEntry> = {}): PasswordEntry => ({ id: 'a'.repeat(32), origin: 'https://example.com', username: 'ana', password: 'p4ss-secret', createdAt: 1, updatedAt: 2, ...patch })

describe('which origins may hold a password', () => {
  it('accepts https anywhere and http on this machine only', () => {
    expect(eligibleOriginOf('https://example.com/login?x=1#y')).toBe('https://example.com')
    expect(eligibleOriginOf('https://example.com:8443/a')).toBe('https://example.com:8443')
    expect(eligibleOriginOf('http://localhost:3000/')).toBe('http://localhost:3000')
    expect(eligibleOriginOf('http://127.0.0.1/')).toBe('http://127.0.0.1')
    expect(eligibleOriginOf('http://[::1]:5173/')).toBe('http://[::1]:5173')
    expect(eligibleOriginOf('http://app.localhost/')).toBe('http://app.localhost')
  })

  it('refuses http to a remote host, other schemes, junk and look-alikes of localhost', () => {
    for (const bad of ['http://example.com/', 'http://localhost.evil.test/', 'http://notlocalhost/', 'file:///etc/passwd', 'data:text/html,x', 'about:blank', 'chrome-extension://abc/x.html', 'javascript:alert(1)', 'ftp://example.com/', '', 'not a url', 'https://']) {
      expect(eligibleOriginOf(bad), bad).toBeNull()
    }
    expect(eligibleOriginOf(undefined)).toBeNull()
    expect(eligibleOriginOf(42)).toBeNull()
    expect(eligibleOriginOf(`https://${'a'.repeat(400)}.com/`)).toBeNull()
  })

  it('keeps a host with letters outside ASCII as punycode, so a look-alike stays visible as one', () => {
    const origin = eligibleOriginOf('https://exаmple.com/')
    expect(origin).toBe('https://xn--exmple-4nf.com')
    expect(origin).not.toBe('https://example.com')
  })

  it('leaves name and password of an address out of the origin', () => {
    expect(eligibleOriginOf('https://me:secret@example.com/')).toBe('https://example.com')
  })

  it('reads what a person types: a bare host means https, credentials and other schemes are refused with their reason', () => {
    expect(siteAddress('example.com')).toEqual({ origin: 'https://example.com' })
    // Two addresses written as one: the URL parser would make a site called « a.example,https » of them.
    expect(siteAddress('https://a.example,https://b.example/login')).toEqual({ error: 'invalid' })
    expect(siteAddress('  example.com:8443/login ')).toEqual({ origin: 'https://example.com:8443' })
    expect(siteAddress('localhost:3000')).toEqual({ origin: 'https://localhost:3000' })
    expect(siteAddress('http://localhost:3000')).toEqual({ origin: 'http://localhost:3000' })
    expect(siteAddress('https://me:pw@example.com')).toEqual({ error: 'credentials' })
    expect(siteAddress('http://example.com')).toEqual({ error: 'unsupported' })
    expect(siteAddress('androidapp://com.example')).toEqual({ error: 'unsupported' })
    expect(siteAddress('a b')).toEqual({ error: 'invalid' })
    expect(siteAddress('')).toEqual({ error: 'invalid' })
    expect(siteAddress('exa\u0000mple.com')).toEqual({ error: 'invalid' })
    expect(siteAddress(5)).toEqual({ error: 'invalid' })
  })

  it('labels an origin with its host and port', () => {
    expect(hostLabel('https://example.com')).toBe('example.com')
    expect(hostLabel('https://example.com:8443')).toBe('example.com:8443')
  })
})

describe('the fields of a login', () => {
  it('bounds and cleans the username, and takes the password as it is', () => {
    expect(cleanUsername('  ana@example.com ')).toBe('ana@example.com')
    expect(cleanUsername('')).toBe('')
    expect(cleanUsername('a'.repeat(PASSWORD_LIMITS.username))).toBe('a'.repeat(PASSWORD_LIMITS.username))
    expect(cleanUsername('a'.repeat(PASSWORD_LIMITS.username + 1))).toBeNull()
    expect(cleanUsername('a\nb')).toBeNull()
    expect(cleanUsername(3)).toBeNull()
    expect(cleanPassword(' keeps spaces ')).toBe(' keeps spaces ')
    expect(cleanPassword('')).toBeNull()
    expect(cleanPassword('a\tb')).toBeNull()
    expect(cleanPassword('x'.repeat(PASSWORD_LIMITS.password + 1))).toBeNull()
    expect(cleanPassword('x'.repeat(PASSWORD_LIMITS.password))).not.toBeNull()
  })

  it('checks a whole login and names the first problem', () => {
    expect(checkedLogin({ address: 'example.com', username: 'ana', password: 'pw' })).toEqual({ ok: true, origin: 'https://example.com', username: 'ana', password: 'pw' })
    expect(checkedLogin({ address: 'http://example.com', username: 'ana', password: 'pw' })).toEqual({ ok: false, problem: 'unsupported' })
    expect(checkedLogin({ address: 'example.com', username: 'a\u0001', password: 'pw' })).toEqual({ ok: false, problem: 'username' })
    expect(checkedLogin({ address: 'example.com', username: 'ana', password: '' })).toEqual({ ok: false, problem: 'password' })
    expect(checkedLogin({ address: '', username: 'ana', password: 'pw' })).toEqual({ ok: false, problem: 'address' })
  })

  it('tells what a login seen on a page would do', () => {
    const entries = [entry()]
    expect(captureKind(entries, { origin: 'https://example.com', username: 'ana', password: 'p4ss-secret' })).toBe('same')
    expect(captureKind(entries, { origin: 'https://example.com', username: 'ana', password: 'other' })).toBe('update')
    expect(captureKind(entries, { origin: 'https://example.com', username: 'bob', password: 'x' })).toBe('new')
    expect(captureKind(entries, { origin: 'https://example.org', username: 'ana', password: 'x' })).toBe('new')
  })
})

describe('which entry may be filled where', () => {
  const entries = [entry({ id: '1'.repeat(32) }), entry({ id: '2'.repeat(32), origin: 'http://localhost:3000' }), entry({ id: '3'.repeat(32), origin: 'https://example.com:8443' }), entry({ id: '4'.repeat(32), origin: 'https://login.example.com' })]

  it('matches the origin exactly: neither the scheme, nor the port, nor a subdomain, nor a parent', () => {
    expect(entriesForPage(entries, 'https://example.com/login').map((e) => e.id)).toEqual(['1'.repeat(32)])
    expect(entriesForPage(entries, 'https://example.com:8443/').map((e) => e.id)).toEqual(['3'.repeat(32)])
    expect(entriesForPage(entries, 'http://localhost:3000/x').map((e) => e.id)).toEqual(['2'.repeat(32)])
    expect(entriesForPage(entries, 'http://example.com/')).toEqual([])
    expect(entriesForPage(entries, 'https://example.com.evil.test/')).toEqual([])
    expect(entriesForPage(entries, 'https://evil-example.com/')).toEqual([])
    expect(entriesForPage(entries, 'https://sub.login.example.com/')).toEqual([])
    expect(entriesForPage(entries, null)).toEqual([])
    expect(entriesForPage(entries, 'file:///x')).toEqual([])
  })

  it('merges a site with its `www.` twin, for the same scheme and the same port, and nothing wider', () => {
    expect(entriesForPage(entries, 'https://www.example.com/').map((e) => e.id)).toEqual(['1'.repeat(32)])
    expect(entriesForPage(entries, 'https://www.example.com:8443/').map((e) => e.id)).toEqual(['3'.repeat(32)])
    expect(entriesForPage([entry({ origin: 'https://www.example.com' })], 'https://example.com/').map((e) => e.id)).toEqual([entry().id])
    // Not another port, another scheme, a second `www.`, another label, nor a name that only ends alike.
    expect(entriesForPage(entries, 'https://www.example.com:9000/')).toEqual([])
    expect(entriesForPage([entry({ origin: 'https://example.com:8443' })], 'https://www.example.com/')).toEqual([])
    expect(entriesForPage(entries, 'https://www.www.example.com/')).toEqual([])
    expect(entriesForPage(entries, 'https://www2.example.com/')).toEqual([])
    expect(entriesForPage(entries, 'https://wwwexample.com/')).toEqual([])
    expect(entriesForPage(entries, 'https://www.example.com.evil.test/')).toEqual([])
    expect(entriesForPage([entry({ origin: 'http://localhost:3000' })], 'http://www.localhost:3000/')).toEqual([])
  })

  const ok: FillContext = { featureOn: true, privateTab: false, vaultUnlocked: true, pageUrl: 'https://example.com/login', entryOrigin: 'https://example.com' }
  const reasonOf = (patch: Partial<FillContext>) => {
    const verdict = fillVerdict({ ...ok, ...patch })
    return verdict.ok ? 'ok' : verdict.reason
  }

  it('lets a password reach a page only when every condition holds', () => {
    expect(fillVerdict(ok)).toEqual({ ok: true, origin: 'https://example.com' })
    expect(reasonOf({ featureOn: false })).toBe('off')
    expect(reasonOf({ privateTab: true })).toBe('private')
    expect(reasonOf({ untrustedCertificate: true })).toBe('untrusted')
    expect(reasonOf({ untrustedCertificate: false })).toBe('ok')
    // The exception is kept by host name: a page of the same host served over http came over no certificate, and is judged as before.
    expect(reasonOf({ untrustedCertificate: true, pageUrl: 'http://localhost:3000/login', entryOrigin: 'http://localhost:3000' })).toBe('ok')
    expect(reasonOf({ untrustedCertificate: true, pageUrl: 'https://localhost:8443/login', entryOrigin: 'https://localhost:8443' })).toBe('untrusted')
    expect(reasonOf({ vaultUnlocked: false })).toBe('locked')
    expect(reasonOf({ pageUrl: null })).toBe('no-page')
    expect(reasonOf({ pageUrl: 'http://example.com/login' })).toBe('not-eligible')
    expect(reasonOf({ pageUrl: 'about:blank' })).toBe('not-eligible')
    expect(reasonOf({ pageUrl: 'https://example.com.evil.test/login' })).toBe('origin-differs')
    expect(reasonOf({ pageUrl: 'https://example.com:8443/login' })).toBe('origin-differs')
    expect(reasonOf({ entryOrigin: 'http://example.com' })).toBe('origin-differs')
    expect(reasonOf({ pageUrl: 'https://www.www.example.com/login' })).toBe('origin-differs')
  })

  it('lets the entry of a site fill its `www.` twin, and hands over the origin of the page, not the entry’s', () => {
    expect(fillVerdict({ ...ok, pageUrl: 'https://www.example.com/login' })).toEqual({ ok: true, origin: 'https://www.example.com' })
    expect(fillVerdict({ ...ok, pageUrl: 'https://example.com/login', entryOrigin: 'https://www.example.com' })).toEqual({ ok: true, origin: 'https://example.com' })
    expect(reasonOf({ pageUrl: 'http://www.example.com/login' })).toBe('not-eligible')
    expect(reasonOf({ pageUrl: 'https://www.example.com:8443/login' })).toBe('origin-differs')
  })

  it('refuses a private tab before it looks at anything else', () => {
    expect(reasonOf({ privateTab: true, vaultUnlocked: false, pageUrl: null })).toBe('private')
  })

  it('gives every refusal a sentence', () => {
    const verdict = fillVerdict({ ...ok, pageUrl: 'https://evil.test/' })
    expect(!verdict.ok && verdict.message).toMatch(/rien n’a été rempli/)
  })
})

describe('what the interface is told', () => {
  it('never carries a password: a row has named fields and the password is not one', () => {
    const row = rowOf(entry({ password: 'TOP-SECRET-VALUE' }))
    expect(Object.keys(row).sort()).toEqual(['host', 'id', 'origin', 'reused', 'totp', 'updatedAt', 'username', 'weak'])
    expect(JSON.stringify(row)).not.toContain('TOP-SECRET-VALUE')
    expect(JSON.stringify(NO_PASSWORDS_VIEW)).not.toMatch(/password/i)
  })

  it('says that an entry has a key for one-time codes, and never what the key is', () => {
    const key = { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', algorithm: 'SHA1', digits: 6, period: 30 } as const
    expect(rowOf(entry()).totp).toBe(false)
    const row = rowOf(entry({ totp: key }))
    expect(row.totp).toBe(true)
    expect(JSON.stringify(row)).not.toContain(key.secret)
    expect(JSON.stringify(row)).not.toContain('SHA1')
  })
})

describe('what a page may send', () => {
  it('accepts a username and a password, nothing else', () => {
    expect(parseSubmission({ username: ' ana ', password: 'pw' })).toEqual({ username: 'ana', password: 'pw' })
    expect(parseSubmission({ username: '', password: 'pw' })).toEqual({ username: '', password: 'pw' })
    expect(parseSubmission({ username: 'ana', password: 'pw', origin: 'https://bank.example' })).toBeNull()
    expect(parseSubmission({ username: 'ana' })).toBeNull()
    expect(parseSubmission({ username: 'ana', password: '' })).toBeNull()
    expect(parseSubmission({ username: 'a\nb', password: 'pw' })).toBeNull()
    expect(parseSubmission({ username: 'ana', password: 'x'.repeat(PASSWORD_LIMITS.password + 1) })).toBeNull()
    expect(parseSubmission({ username: 1, password: 'pw' })).toBeNull()
    expect(parseSubmission(['ana', 'pw'])).toBeNull()
    expect(parseSubmission(null)).toBeNull()
    expect(parseSubmission('ana')).toBeNull()
  })
})

describe('which submit events count', () => {
  it('only those the browser made, after a gesture of the user', () => {
    expect(mayReportSubmit({ isTrusted: true }, { userActivation: { isActive: true } })).toBe(true)
    expect(mayReportSubmit({ isTrusted: true }, undefined)).toBe(true)
    expect(mayReportSubmit({ isTrusted: true }, {})).toBe(true)
    // A script's own event, or a submit from a timer with no gesture before it.
    expect(mayReportSubmit({ isTrusted: false }, { userActivation: { isActive: true } })).toBe(false)
    expect(mayReportSubmit({}, undefined)).toBe(false)
    expect(mayReportSubmit({ isTrusted: 'true' }, undefined)).toBe(false)
    expect(mayReportSubmit({ isTrusted: true }, { userActivation: { isActive: false } })).toBe(false)
    expect(mayReportSubmit({ isTrusted: true }, { userActivation: {} })).toBe(false)
  })
})

describe('what the panel may ask', () => {
  const id = '0123456789abcdef0123456789abcdef'

  it('knows each kind, with exactly its fields', () => {
    expect(parsePasswordRequest({ kind: 'status' })).toEqual({ kind: 'status' })
    expect(parsePasswordRequest({ kind: 'unlock', phrase: 'une phrase assez longue' })).toEqual({ kind: 'unlock', phrase: 'une phrase assez longue' })
    expect(parsePasswordRequest({ kind: 'fill', id })).toEqual({ kind: 'fill', id })
    expect(parsePasswordRequest({ kind: 'remove', id })).toEqual({ kind: 'remove', id })
    expect(parsePasswordRequest({ kind: 'capture', op: 'confirm', offer: 3 })).toEqual({ kind: 'capture', op: 'confirm', offer: 3 })
    // An answer names the offer it is for: without it, or with something that is not a number of an offer, it is no request.
    for (const offer of [undefined, 0, -1, 1.5, '3', null]) expect(parsePasswordRequest({ kind: 'capture', op: 'confirm', offer }), String(offer)).toBeNull()
    expect(parsePasswordRequest({ kind: 'add', address: 'example.com', username: 'ana', password: 'pw' })).toEqual({ kind: 'add', address: 'example.com', username: 'ana', password: 'pw' })
    expect(parsePasswordRequest({ kind: 'change-phrase', current: 'a', next: 'b' })).toEqual({ kind: 'change-phrase', current: 'a', next: 'b' })
    expect(parsePasswordRequest({ kind: 'import-csv' })).toEqual({ kind: 'import-csv' })
  })

  it('refuses an unknown kind, an extra field, a wrong type, an id that is not one, a phrase too long', () => {
    expect(parsePasswordRequest(null)).toBeNull()
    expect(parsePasswordRequest('status')).toBeNull()
    expect(parsePasswordRequest({ kind: 'delete-everything' })).toBeNull()
    expect(parsePasswordRequest({ kind: 'status', path: '/etc/passwd' })).toBeNull()
    // A path never comes from the panel: the file of an import is chosen in a dialog of the main process.
    expect(parsePasswordRequest({ kind: 'import-csv', path: '/tmp/x.csv' })).toBeNull()
    expect(parsePasswordRequest({ kind: 'fill', id: 'not-an-id' })).toBeNull()
    expect(parsePasswordRequest({ kind: 'fill', id: id.toUpperCase() })).toBeNull()
    expect(parsePasswordRequest({ kind: 'fill', id, origin: 'https://evil.test' })).toBeNull()
    expect(parsePasswordRequest({ kind: 'unlock', phrase: 5 })).toBeNull()
    expect(parsePasswordRequest({ kind: 'unlock', phrase: 'x'.repeat(PASSWORD_LIMITS.phraseMax + 1) })).toBeNull()
    expect(parsePasswordRequest({ kind: 'capture', op: 'save-silently', offer: 1 })).toBeNull()
    expect(parsePasswordRequest({ kind: 'add', address: 'x', username: 'u' })).toBeNull()
  })

  it('knows the requests about one-time codes, each with exactly its fields', () => {
    expect(parsePasswordRequest({ kind: 'totp-set', id, secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' })).toEqual({ kind: 'totp-set', id, secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' })
    for (const kind of ['totp-remove', 'totp-code', 'totp-copy']) expect(parsePasswordRequest({ kind, id })).toEqual({ kind, id })
    expect(parsePasswordRequest({ kind: 'totp-code', id, auto: true })).toEqual({ kind: 'totp-code', id, auto: true })
    for (const auto of [false, 'yes', 1, null]) expect(parsePasswordRequest({ kind: 'totp-code', id, auto }), String(auto)).toBeNull()
    expect(parsePasswordRequest({ kind: 'totp-copy', id, auto: true })).toBeNull()
    for (const bad of [
      { kind: 'totp-set', id },
      { kind: 'totp-set', id, secret: 5 },
      { kind: 'totp-set', id: 'not-an-id', secret: 'x' },
      { kind: 'totp-set', id, secret: 'x'.repeat(TOTP_LIMITS.inputMax + 1) },
      { kind: 'totp-set', id, secret: 'x', origin: 'https://evil.test' },
      { kind: 'totp-code' },
      { kind: 'totp-code', id: id.toUpperCase() },
      { kind: 'totp-code', id, digits: 8 },
      { kind: 'totp-copy', id, to: 'somewhere' },
      { kind: 'totp-remove', id: 5 }
    ]) expect(parsePasswordRequest(bad), JSON.stringify(bad)).toBeNull()
  })

  it('holds the generator options to their bounds and keeps one class on', () => {
    const parsed = parsePasswordRequest({ kind: 'generate', options: { length: 9999, lower: false, upper: false, digits: false, symbols: false } })
    expect(parsed).toEqual({ kind: 'generate', options: { length: 128, lower: true, upper: false, digits: false, symbols: false, noAmbiguous: false } })
  })

  it('says why a phrase is not one', () => {
    expect(phraseProblem('court')).toMatch(/au moins 12/)
    expect(phraseProblem('une phrase assez longue')).toBeNull()
    expect(phraseProblem(12)).toMatch(/invalide/)
    expect(phraseProblem('x'.repeat(PASSWORD_LIMITS.phraseMax + 1))).toMatch(/trop longue/)
  })

  it('takes a phrase of exactly the shortest and the longest length, and not one character less or more', () => {
    expect(phraseProblem('x'.repeat(PASSWORD_LIMITS.phraseMin))).toBeNull()
    expect(phraseProblem('x'.repeat(PASSWORD_LIMITS.phraseMin - 1))).toMatch(/au moins 12/)
    expect(phraseProblem('x'.repeat(PASSWORD_LIMITS.phraseMax))).toBeNull()
    // The longest phrase that can be chosen can also be typed to unlock the vault, or to change it.
    const longest = 'x'.repeat(PASSWORD_LIMITS.phraseMax)
    expect(parsePasswordRequest({ kind: 'unlock', phrase: longest })).toEqual({ kind: 'unlock', phrase: longest })
    expect(parsePasswordRequest({ kind: 'change-phrase', current: longest, next: longest })).toEqual({ kind: 'change-phrase', current: longest, next: longest })
    expect(parsePasswordRequest({ kind: 'change-phrase', current: `${longest}x`, next: 'une phrase assez longue' })).toBeNull()
  })

  it('counts the characters typed, not the units of their encoding: six emoji or six accented letters are six characters', () => {
    // Twelve UTF-16 units each, so `.length` would let them pass the minimum of twelve.
    expect(phraseProblem('🔒🔑🔐🔏🛡🧱')).toMatch(/au moins 12/)
    expect(phraseProblem('e\u0301'.repeat(6))).toMatch(/au moins 12/)
  })
})
