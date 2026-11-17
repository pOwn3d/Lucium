import { describe, expect, it } from 'vitest'
import { addedAccess, cleanText, isExtensionId, resolveMessage, reviewManifest, siteKindOf, type ExtensionReview } from './extension-review'
import { frenchSpaces } from './french-typography'
import { MANIFEST_LIST_MAX, manifestListsTooLong, shimAllowed } from './chrome-compat'
import { accessOf } from './extension-access'
import { isPublicSuffix } from './party'

const manifest = (extra: Record<string, unknown> = {}) => ({ manifest_version: 3, name: 'Exemple', version: '1.2.3', ...extra })

function review(extra: Record<string, unknown> = {}, catalogue?: unknown): ExtensionReview {
  const outcome = reviewManifest(manifest(extra), catalogue)
  if (!outcome.ok) throw new Error(outcome.reason)
  return outcome.review
}

describe('siteKindOf', () => {
  it('knows the patterns that mean every site', () => {
    for (const p of ['<all_urls>', '*://*/*', 'https://*/*', 'http://*/*', 'https://*/foo']) expect(siteKindOf(p).kind, p).toBe('all')
  })
  it('tells a domain, local files and what it does not understand', () => {
    expect(siteKindOf('*://*.exemple.org/*')).toEqual({ kind: 'domain', host: 'exemple.org' })
    expect(siteKindOf('https://Mail.Exemple.org/inbox')).toEqual({ kind: 'domain', host: 'mail.exemple.org' })
    expect(siteKindOf('file:///*').kind).toBe('files')
    for (const p of ['', 'exemple.org', 'javascript:alert(1)', 'https:///x']) expect(siteKindOf(p).kind, p).toBe('other')
  })
})

describe('reviewManifest', () => {
  it('refuses what is not a Manifest V3 package, with a sentence that says why', () => {
    const v2 = reviewManifest({ manifest_version: 2, name: 'Ancien', version: '1' })
    expect(v2.ok).toBe(false)
    expect(!v2.ok && v2.reason).toContain('Manifest V2')
    for (const bad of [null, 'x', [], 42, { manifest_version: '3', name: 'x', version: '1' }, {}]) expect(reviewManifest(bad).ok, JSON.stringify(bad)).toBe(false)
  })

  it('refuses a package without a readable name or version', () => {
    expect(reviewManifest(manifest({ name: '   ' })).ok).toBe(false)
    expect(reviewManifest(manifest({ name: 5 })).ok).toBe(false)
    expect(reviewManifest(manifest({ version: '' })).ok).toBe(false)
    expect(reviewManifest(manifest({ name: '__MSG_missing__' })).ok).toBe(false)
  })

  it('puts the wide permissions first, then the sensitive ones, then the rest, each with a French sentence', () => {
    const r = review({ permissions: ['storage', 'tabs', 'nativeMessaging', 'alarms', 'history'] })
    expect(r.permissions.map((p) => p.id)).toEqual(['history', 'nativeMessaging', 'tabs', 'alarms', 'storage'])
    expect(r.permissions.map((p) => p.level)).toEqual(['broad', 'broad', 'sensitive', 'normal', 'normal'])
    expect(r.permissions.find((p) => p.id === 'nativeMessaging')?.label).toBe('Communiquer avec des programmes installés sur votre ordinateur')
    expect(r.broad).toBe(true)
    expect(r.warning).toBe('Cette extension demande des accès étendus à votre navigateur ou à votre ordinateur.')
  })

  it('classifies the permissions an ordinary extension asks for as not wide, with no warning', () => {
    const r = review({ permissions: ['storage', 'alarms', 'contextMenus'], host_permissions: ['https://api.exemple.org/*'] })
    expect(r.broad).toBe(false)
    expect(r.warning).toBe('')
    expect(r.sites).toMatchObject({ scope: 'specific', line: frenchSpaces('Lire et modifier vos données sur : api.exemple.org'), count: 1 })
  })

  it('does not read a host pattern written among the permissions of a Manifest V3 package as access to any site: the review says what the engine grants', () => {
    const r = review({ permissions: ['storage', '<all_urls>', 'https://*/*'] })
    expect(r.sites).toMatchObject({ scope: 'none', count: 0 })
    expect(r.broad).toBe(false)
    expect(r.warning).toBe('')
    // The same pattern in `host_permissions` is access to every site.
    expect(review({ host_permissions: ['<all_urls>'] }).sites.scope).toBe('all')
    // An update that only adds such a pattern among the permissions asks for nothing more of the engine.
    expect(addedAccess(manifest({ permissions: ['storage'] }), manifest({ permissions: ['storage', '<all_urls>'] }))?.sites.scope ?? 'none').not.toBe('all')
  })

  it('treats access to every site as wide, whichever way it is written, and widens the permissions that act on sites', () => {
    for (const hosts of [['<all_urls>'], ['*://*/*'], ['https://*/*', 'https://exemple.org/*']]) {
      const r = review({ host_permissions: hosts, permissions: ['cookies', 'storage', 'scripting'] })
      expect(r.sites.scope, JSON.stringify(hosts)).toBe('all')
      expect(r.broad).toBe(true)
      expect(r.warning).toBe('Cette extension peut lire et modifier vos données sur tous les sites web.')
      expect(r.permissions.find((p) => p.id === 'cookies')?.level).toBe('broad')
      expect(r.permissions.find((p) => p.id === 'scripting')?.level).toBe('broad')
      expect(r.permissions.find((p) => p.id === 'storage')?.level).toBe('normal')
    }
    // Without access to every site the same permission stays what it is.
    expect(review({ permissions: ['cookies'], host_permissions: ['https://exemple.org/*'] }).permissions[0]?.level).toBe('sensitive')
  })

  it('counts the pages a content script runs on as access to those sites', () => {
    const r = review({ content_scripts: [{ matches: ['https://*/*'], js: ['a.js'] }] })
    expect(r.sites.scope).toBe('all')
    expect(review({ content_scripts: [{ matches: ['*://*.exemple.org/*'] }] }).sites.line).toBe(frenchSpaces('Lire et modifier vos données sur : exemple.org'))
  })

  it('says so when there is no access to sites, and when local files are asked for', () => {
    expect(review().sites).toMatchObject({ scope: 'none', count: 0 })
    const files = review({ host_permissions: ['file:///*', 'https://exemple.org/*'] })
    expect(files.sites.files).toBe(true)
    expect(files.sites.line).toContain('fichiers de votre ordinateur')
  })

  it('does not list dozens of domains one by one', () => {
    const hosts = Array.from({ length: 30 }, (_, i) => `https://site${i}.example/*`)
    const r = review({ host_permissions: hosts })
    expect(r.sites.line).toBe('Lire et modifier vos données sur 30 domaines')
    expect(r.sites.patterns).toHaveLength(8)
    expect(r.sites.count).toBe(30)
  })

  it('shows an unknown permission with a generic sentence and treats it with caution', () => {
    const p = review({ permissions: ['cloudNinePlus'] }).permissions[0]!
    expect(p).toMatchObject({ id: 'cloudNinePlus', level: 'sensitive', unknown: true })
    expect(p.label).toContain('inconnue')
  })

  it('counts the facultative permissions without granting them', () => {
    expect(review({ optional_permissions: ['tabs', 'history'], optional_host_permissions: ['https://*/*'] }).optionalCount).toBe(3)
  })

  it('reads the name and description from the locale catalogue, and drops a key it cannot resolve', () => {
    const catalogue = { extName: { message: 'Mon extension' }, EXTDESC: { message: 'Fait des choses' } }
    const r = review({ name: '__MSG_extName__', description: '__MSG_extDesc__' }, catalogue)
    expect(r).toMatchObject({ name: 'Mon extension', description: 'Fait des choses' })
    expect(resolveMessage('__MSG_x__', null)).toBe('')
    expect(resolveMessage('texte simple', null)).toBe('texte simple')
    expect(resolveMessage(7, {})).toBe('')
  })

  it('is not fooled by hostile text: control characters, direction overrides, lengths and shapes', () => {
    const r = review({
      name: `Banque‮gnirts\n${'x'.repeat(500)}`,
      description: `a\u0000b​c${'y'.repeat(2000)}`,
      permissions: ['storage', 7, null, { evil: 1 }, 'storage', 'a'.repeat(300)],
      host_permissions: 'not a list'
    })
    expect(r.name).not.toMatch(/\p{Cc}|\p{Cf}/u)
    expect(r.name.length).toBeLessThanOrEqual(80)
    expect(r.description.length).toBeLessThanOrEqual(400)
    // The unknown one comes first (it is treated with caution) and is cut at 60 characters; the entries that are not text are dropped.
    expect(r.permissions.map((p) => p.id)).toEqual(['a'.repeat(60), 'storage'])
    expect(r.sites.scope).toBe('none')
    expect(cleanText(12, 10)).toBe('')
    expect(cleanText('  a \n\t b  ', 10)).toBe('a b')
  })

  it('does not choke on a permissions list of any other kind', () => {
    for (const permissions of [null, 'tabs', 12, { tabs: true }]) expect(review({ permissions }).permissions).toEqual([])
  })
})

describe('addedAccess (an update that asks for more)', () => {
  const old = manifest({ permissions: ['storage'], host_permissions: ['https://*.exemple.org/*'] })

  it('is null when the new version asks for nothing more, narrower sites included', () => {
    expect(addedAccess(old, manifest({ permissions: ['storage'], host_permissions: ['https://api.exemple.org/*'] }))).toBeNull()
    expect(addedAccess(old, manifest({ permissions: [], host_permissions: [] }))).toBeNull()
  })

  it('lists only the permissions that are new, and says whether one is wide', () => {
    const added = addedAccess(old, manifest({ permissions: ['storage', 'tabs', 'debugger'], host_permissions: ['https://*.exemple.org/*'] }))!
    expect(added.permissions.map((p) => p.id)).toEqual(['debugger', 'tabs'])
    expect(added.broad).toBe(true)
    expect(added.sites.scope).toBe('none')
  })

  it('lists the sites that are not covered by the old version, and the jump to every site', () => {
    const more = addedAccess(old, manifest({ permissions: ['storage'], host_permissions: ['https://*.exemple.org/*', 'https://autre.example/*'] }))!
    expect(more.sites).toMatchObject({ scope: 'specific', line: frenchSpaces('Lire et modifier vos données sur : autre.example') })
    const all = addedAccess(old, manifest({ permissions: ['storage'], host_permissions: ['<all_urls>'] }))!
    expect(all.sites.scope).toBe('all')
    expect(all.broad).toBe(true)
    expect(all.warning).toContain('plus larges')
  })

  it('counts nothing as new when the installed version already had every site', () => {
    const everywhere = manifest({ permissions: ['storage'], host_permissions: ['<all_urls>'] })
    expect(addedAccess(everywhere, manifest({ permissions: ['storage'], host_permissions: ['https://nouveau.example/*', 'file:///*'] }))).toBeNull()
  })

  it('still sees a wider permission when the name of the new version is a message key it cannot resolve', () => {
    const added = addedAccess(old, manifest({ name: '__MSG_appName__', permissions: ['storage', 'history'], host_permissions: ['https://*.exemple.org/*'] }))!
    expect(added.permissions.map((p) => p.id)).toEqual(['history'])
    expect(added.name).toBe('Extension')
    expect(added.version).toBe('1.2.3')
    expect(addedAccess(old, manifest({ name: '__MSG_appName__', permissions: ['storage'] }))).toBeNull()
  })

  it('compares with nothing known as an install of everything', () => {
    expect(addedAccess(undefined, manifest({ permissions: ['tabs'] }))?.permissions.map((p) => p.id)).toEqual(['tabs'])
  })
})

describe('isExtensionId', () => {
  it('accepts 32 letters from a to p, nothing else', () => {
    expect(isExtensionId('a'.repeat(32))).toBe(true)
    for (const bad of ['a'.repeat(31), 'a'.repeat(33), 'q'.repeat(32), 'A'.repeat(32), '', 7, null, `${'a'.repeat(31)}/`]) expect(isExtensionId(bad), String(bad)).toBe(false)
  })
})

describe('a manifest whose lists are longer than what is read of them', () => {
  const filler = (entry: string) => Array.from({ length: MANIFEST_LIST_MAX }, () => entry)

  it('is refused at install, with a sentence that says why: a permission or a site past the bound would be granted without being shown', () => {
    for (const extra of [
      { permissions: [...filler('storage'), 'debugger'] },
      { host_permissions: [...filler('https://example.com/*'), '<all_urls>'] },
      { content_scripts: [{ matches: [...filler('https://example.com/*'), '<all_urls>'] }] },
      { content_scripts: [...filler('x').map(() => ({ matches: ['https://example.com/*'] })), { matches: ['<all_urls>'] }] },
      { content_scripts: [{ matches: filler('https://example.com/*').slice(1) }, { matches: ['https://example.com/*', '<all_urls>'] }] }
    ]) {
      const outcome = reviewManifest(manifest(extra))
      expect(outcome.ok, JSON.stringify(Object.keys(extra))).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toContain(String(MANIFEST_LIST_MAX))
    }
  })

  it('shows the very last entry of a list that is exactly at the bound, doubles included', () => {
    const r = review({ permissions: [...filler('storage').slice(1), 'debugger'], host_permissions: [...filler('https://example.com/*').slice(1), '<all_urls>'] })
    expect(r.permissions.map((p) => p.id)).toEqual(['debugger', 'storage'])
    expect(r.sites.scope).toBe('all')
    expect(r.broad).toBe(true)
  })

  it('is never an update that asks for nothing more: it is held, with the reason', () => {
    const old = manifest({ permissions: ['storage'], host_permissions: ['https://example.com/*'] })
    const wide = addedAccess(old, manifest({ permissions: [...filler('storage'), 'debugger'], host_permissions: ['https://example.com/*'] }))
    expect(wide?.broad).toBe(true)
    expect(wide?.warning).toContain(String(MANIFEST_LIST_MAX))
    expect(addedAccess(old, manifest({ permissions: ['storage'], host_permissions: [...filler('https://example.com/*'), '<all_urls>'] }))).not.toBeNull()
  })

  it('is read to the same entry by the sheet and by the rules that grant: what one does not see, the others do not grant', () => {
    const atBound = { manifest_version: 3, permissions: [...filler('storage').slice(1), 'debugger'], host_permissions: [...filler('https://example.com/*').slice(1), 'https://last.example/*'] }
    expect(shimAllowed(atBound, 'debugger', 'attach')).toBe(true)
    expect(accessOf(atBound).permissions.has('debugger')).toBe(true)
    expect(accessOf(atBound).hosts).toContain('https://last.example/*')
    const past = { manifest_version: 3, permissions: [...filler('storage'), 'debugger', 'nativeMessaging'], host_permissions: [...filler('https://example.com/*'), '<all_urls>'] }
    expect(manifestListsTooLong(past)).toBe(true)
    expect(shimAllowed(past, 'debugger', 'attach')).toBe(false)
    expect(shimAllowed(past, 'nativeMessaging', 'connectNative')).toBe(false)
    expect(accessOf(past).permissions.has('debugger')).toBe(false)
    expect(accessOf(past).hosts).not.toContain('<all_urls>')
    // Entries of another kind count as written: they cannot push a permission out of the part that is read without the manifest being refused.
    const padded = { manifest_version: 3, permissions: [...filler('storage').map(() => 1), 'debugger'] }
    expect(manifestListsTooLong(padded)).toBe(true)
    expect(shimAllowed(padded, 'debugger', 'attach')).toBe(false)
    expect(accessOf(padded).permissions.has('debugger')).toBe(false)
  })
})

describe('addedAccess, pattern by pattern', () => {
  const sites = (...host_permissions: string[]) => manifest({ host_permissions })
  const added = (before: string[], after: string[]) => addedAccess(sites(...before), sites(...after))?.sites.patterns ?? []

  it('sees the subdomains of a host that was exact as new', () => {
    expect(added(['https://google.com/*'], ['https://*.google.com/*'])).toEqual(['https://*.google.com/*'])
    expect(added(['https://google.com/*'], ['https://mail.google.com/*'])).toEqual(['https://mail.google.com/*'])
  })

  it('does not see as new what a wildcard host already covered: the domain itself, a subdomain, the subdomains of a subdomain', () => {
    expect(added(['https://*.google.com/*'], ['https://google.com/*', 'https://mail.google.com/inbox', 'https://*.mail.google.com/*'])).toEqual([])
    expect(added(['https://*.google.com/*'], ['https://notgoogle.com/*'])).toEqual(['https://notgoogle.com/*'])
  })

  it('sees a wider scheme, a wider path and another port as new', () => {
    expect(added(['https://example.com/*'], ['*://example.com/*'])).toEqual(['*://example.com/*'])
    expect(added(['https://example.com/*'], ['http://example.com/*'])).toEqual(['http://example.com/*'])
    expect(added(['*://example.com/*'], ['https://example.com/*', 'http://example.com/a'])).toEqual([])
    expect(added(['https://example.com/app/*'], ['https://example.com/*'])).toEqual(['https://example.com/*'])
    expect(added(['https://example.com/*'], ['https://example.com/app/*'])).toEqual([])
    expect(added(['https://example.com:8443/*'], ['https://example.com/*'])).toEqual(['https://example.com/*'])
    expect(added(['https://example.com/*'], ['https://example.com:8443/*'])).toEqual([])
  })

  it('sees the jump from one scheme of every site to all of them as new', () => {
    expect(addedAccess(sites('https://*/*'), sites('<all_urls>'))?.sites.scope).toBe('all')
    expect(addedAccess(sites('*://*/*'), sites('<all_urls>', 'https://*/*', 'https://example.com/*'))).toBeNull()
  })
})

describe('a pattern over a whole public suffix', () => {
  it('is every site, not a domain called « com »: with the list of suffixes, or without it for a name of one label', () => {
    expect(siteKindOf('*://*.com/*').kind).toBe('all')
    expect(siteKindOf('https://*.fr/*').kind).toBe('all')
    expect(siteKindOf('*://*.co.uk/*', isPublicSuffix).kind).toBe('all')
    expect(siteKindOf('*://*.com:8080/*', isPublicSuffix).kind).toBe('all')
    expect(siteKindOf('*://*.example.co.uk/*', isPublicSuffix)).toEqual({ kind: 'domain', host: 'example.co.uk' })
    expect(siteKindOf('*://*.github.io/*', isPublicSuffix)).toEqual({ kind: 'domain', host: 'github.io' })
    expect(siteKindOf('https://com/*', isPublicSuffix)).toEqual({ kind: 'domain', host: 'com' })
    expect(siteKindOf('https://*.localhost/*')).toEqual({ kind: 'domain', host: 'localhost' })
    expect(siteKindOf('https://*.localhost/*', isPublicSuffix)).toEqual({ kind: 'domain', host: 'localhost' })
  })

  it('leads the sheet with the warning of every site', () => {
    const outcome = reviewManifest(manifest({ host_permissions: ['*://*.co.uk/*'] }), undefined, isPublicSuffix)
    expect(outcome.ok && outcome.review.sites.scope).toBe('all')
    expect(outcome.ok && outcome.review.broad).toBe(true)
    expect(review({ host_permissions: ['*://*.com/*'] }).sites.scope).toBe('all')
    expect(addedAccess(manifest({ host_permissions: ['https://example.com/*'] }), manifest({ host_permissions: ['*://*.com/*'] }))?.broad).toBe(true)
  })

  it('counts the web sockets of every site as every site', () => {
    expect(siteKindOf('wss://*/*').kind).toBe('all')
    expect(siteKindOf('ws://*/*').kind).toBe('all')
    expect(siteKindOf('ftp://*/*').kind).toBe('other')
  })
})
