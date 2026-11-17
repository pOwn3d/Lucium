import { beforeEach, describe, expect, it } from 'vitest'
import { shimAllowed } from './chrome-compat'
import { accessOf, hasHostAccess } from './extension-access'
import { setLanguage } from './i18n'
import {
  PERMISSION_SET_MAX,
  grantedFacts,
  heldBy,
  isOptional,
  missingFrom,
  optionalOf,
  originCovered,
  readPermissionSet,
  readStoredGrant,
  reviewOfRequest,
  storeGrant,
  withGranted,
  withinOptional,
  withoutRemoved
} from './optional-permissions'

beforeEach(() => setLanguage('fr'))

const MANIFEST = {
  manifest_version: 3,
  name: 'Sonde',
  version: '1.0',
  permissions: ['storage'],
  host_permissions: ['https://own.example/*'],
  optional_permissions: ['history', 'cookies', 'https://written-in-the-wrong-list.example/*'],
  optional_host_permissions: ['https://*.shop.example/*', 'https://one.example/a/*']
}

describe('a request or a stored grant, read as hostile input', () => {
  it('keeps the names and the match patterns, once each', () => {
    expect(readPermissionSet({ permissions: ['history', 'history'], origins: ['https://a.example/*'] })).toEqual({ permissions: ['history'], origins: ['https://a.example/*'] })
    expect(readPermissionSet({})).toEqual({ permissions: [], origins: [] })
  })

  it('refuses the whole of anything else: nothing is taken from a request that is half readable', () => {
    expect(readPermissionSet(undefined)).toBeNull()
    expect(readPermissionSet('history')).toBeNull()
    expect(readPermissionSet({ permissions: 'history' })).toBeNull()
    expect(readPermissionSet({ permissions: ['history', 7] })).toBeNull()
    expect(readPermissionSet({ permissions: [''] })).toBeNull()
    // A site among the names, a name among the sites.
    expect(readPermissionSet({ permissions: ['https://a.example/*'] })).toBeNull()
    expect(readPermissionSet({ origins: ['history'] })).toBeNull()
    expect(readPermissionSet({ origins: ['https://a.example'] })).toBeNull()
    // A text that would be shown to the person with something invisible in it, or too long to be shown.
    expect(readPermissionSet({ permissions: ['his‮tory'] })).toBeNull()
    expect(readPermissionSet({ permissions: ['x'.repeat(61)] })).toBeNull()
    expect(readPermissionSet({ origins: [`https://a.example/${'x'.repeat(300)}`] })).toBeNull()
    expect(readPermissionSet({ permissions: Array.from({ length: PERMISSION_SET_MAX + 1 }, (_v, i) => `p${i}`) })).toBeNull()
  })
})

describe('what a manifest lists as facultative', () => {
  it('is its facultative names and its facultative sites; a site written among the names of a Manifest V3 counts for nothing', () => {
    expect(optionalOf(MANIFEST)).toEqual({ permissions: ['history', 'cookies'], origins: ['https://*.shop.example/*', 'https://one.example/a/*'] })
    expect(optionalOf({ manifest_version: 2, optional_permissions: ['history', 'https://old.example/*'] })).toEqual({ permissions: ['history'], origins: ['https://old.example/*'] })
    expect(optionalOf(null)).toEqual({ permissions: [], origins: [] })
  })

  it('covers a site written the same or narrower, never a wider one', () => {
    expect(originCovered(['https://*.shop.example/*'], 'https://*.shop.example/*')).toBe(true)
    expect(originCovered(['https://*.shop.example/*'], 'https://pay.shop.example/*')).toBe(true)
    expect(originCovered(['https://*.shop.example/*'], 'https://pay.shop.example/cart/*')).toBe(true)
    expect(originCovered(['https://*.shop.example/*'], '*://*.shop.example/*')).toBe(false)
    expect(originCovered(['https://*.shop.example/*'], 'https://*/*')).toBe(false)
    expect(originCovered(['https://one.example/a/*'], 'https://one.example/*')).toBe(false)
    expect(originCovered(['https://*.shop.example/*'], '<all_urls>')).toBe(false)
  })

  it('never lets a request go past it', () => {
    expect(isOptional(MANIFEST, { permissions: ['history'], origins: ['https://pay.shop.example/*'] })).toBe(true)
    expect(isOptional(MANIFEST, { permissions: ['debugger'], origins: [] })).toBe(false)
    expect(isOptional(MANIFEST, { permissions: [], origins: ['https://bank.example/*'] })).toBe(false)
    expect(isOptional(MANIFEST, { permissions: [], origins: ['https://written-in-the-wrong-list.example/*'] })).toBe(false)
    expect(withinOptional(MANIFEST, { permissions: ['history', 'debugger'], origins: ['https://bank.example/*', 'https://pay.shop.example/*'] })).toEqual({ permissions: ['history'], origins: ['https://pay.shop.example/*'] })
  })
})

describe('the manifest the access rules read', () => {
  it('is the very manifest of the extension while nothing is granted', () => {
    expect(withGranted(MANIFEST, { permissions: [], origins: [] })).toBe(MANIFEST)
    // A grant the manifest does not list as facultative is nothing.
    expect(withGranted(MANIFEST, { permissions: ['debugger'], origins: ['https://bank.example/*'] })).toBe(MANIFEST)
  })

  it('holds what was granted, for the rules of the library and for the APIs Lucium provides', () => {
    const held = withGranted(MANIFEST, { permissions: ['history'], origins: ['https://pay.shop.example/*'] })
    expect(shimAllowed(MANIFEST, 'history', 'search')).toBe(false)
    expect(shimAllowed(held, 'history', 'search')).toBe(true)
    expect(hasHostAccess(accessOf(MANIFEST), 'https://pay.shop.example/cart')).toBe(false)
    expect(hasHostAccess(accessOf(held), 'https://pay.shop.example/cart')).toBe(true)
    expect(hasHostAccess(accessOf(held), 'https://own.example/x')).toBe(true)
    // Never the manifest of the extension itself.
    expect(MANIFEST.permissions).toEqual(['storage'])
  })

  it('drops a grant the new version of the manifest no longer lists as facultative, and a part that went past it', () => {
    const updated = { ...MANIFEST, optional_permissions: ['cookies'], optional_host_permissions: [] }
    const held = withGranted(updated, { permissions: ['history', 'cookies', 'debugger'], origins: ['https://pay.shop.example/*'] })
    expect(heldBy(held)).toEqual({ permissions: ['storage', 'cookies'], origins: ['https://own.example/*'] })
  })

  it('answers what is held and what is missing from the same reading', () => {
    const held = withGranted(MANIFEST, { permissions: ['history'], origins: ['https://*.shop.example/*'] })
    expect(heldBy(held)).toEqual({ permissions: ['storage', 'history'], origins: ['https://own.example/*', 'https://*.shop.example/*'] })
    expect(missingFrom(held, { permissions: ['storage', 'history', 'cookies'], origins: ['https://own.example/page', 'https://pay.shop.example/*', 'https://one.example/a/*'] })).toEqual({ permissions: ['cookies'], origins: ['https://one.example/a/*'] })
  })
})

describe('giving a permission back', () => {
  const granted = { permissions: ['history', 'cookies'], origins: ['https://pay.shop.example/*', 'https://one.example/a/*'] }

  it('takes the names asked for, and every granted site the pattern asked for covers', () => {
    expect(withoutRemoved(MANIFEST, granted, { permissions: ['history'], origins: ['https://*.shop.example/*'] })).toEqual({
      kept: { permissions: ['cookies'], origins: ['https://one.example/a/*'] },
      removed: { permissions: ['history'], origins: ['https://pay.shop.example/*'] }
    })
    expect(withoutRemoved(MANIFEST, granted, { permissions: ['tabs'], origins: [] })).toEqual({ kept: granted, removed: { permissions: [], origins: [] } })
  })

  it('refuses what the manifest gives by itself: that is not a grant', () => {
    expect(withoutRemoved(MANIFEST, granted, { permissions: ['storage'], origins: [] })).toBeNull()
    expect(withoutRemoved(MANIFEST, granted, { permissions: [], origins: ['https://own.example/*'] })).toBeNull()
  })
})

describe('the sheet of a request', () => {
  it('lists only what is asked and not held, with the sentences and the levels of the sheet of an installation', () => {
    const review = reviewOfRequest(MANIFEST, { permissions: ['cookies'], origins: [] }, { permissions: ['history'], origins: ['https://pay.shop.example/*'] }, 'Sonde API')
    expect(review).toMatchObject({ name: 'Sonde API', version: '1.0', optionalCount: 0, broad: true })
    expect(review!.permissions).toEqual([{ id: 'history', label: 'Lire et modifier votre historique de navigation', level: 'broad' }])
    expect(review!.sites).toMatchObject({ scope: 'specific', patterns: ['https://pay.shop.example/*'], count: 1 })
    expect(review!.warning).toBe('Cette extension demande des accès étendus à votre navigateur ou à votre ordinateur.')
  })

  it('says every site when every site is asked for, and shows a site a content script already runs on as new', () => {
    const wide = { ...MANIFEST, optional_host_permissions: ['*://*/*'], content_scripts: [{ matches: ['https://news.example/*'], js: ['c.js'] }] }
    const all = reviewOfRequest(wide, { permissions: [], origins: [] }, { permissions: [], origins: ['*://*/*'] }, 'Sonde')
    expect(all!.sites.scope).toBe('all')
    expect(all!.warning).toBe('Cette extension peut lire et modifier vos données sur tous les sites web.')
    const one = reviewOfRequest(wide, { permissions: [], origins: [] }, { permissions: [], origins: ['https://news.example/*'] }, 'Sonde')
    expect(one!.sites.patterns).toEqual(['https://news.example/*'])
  })

  it('raises a permission that reaches every site because the extension already holds them all', () => {
    const everywhere = { ...MANIFEST, host_permissions: ['<all_urls>'] }
    expect(reviewOfRequest(everywhere, { permissions: [], origins: [] }, { permissions: ['cookies'], origins: [] }, 'Sonde')!.permissions).toEqual([expect.objectContaining({ id: 'cookies', level: 'broad' })])
    expect(reviewOfRequest(MANIFEST, { permissions: [], origins: [] }, { permissions: ['cookies'], origins: [] }, 'Sonde')!.permissions).toEqual([expect.objectContaining({ id: 'cookies', level: 'sensitive' })])
  })

  it('has nothing to show, and so nothing to grant, for what the manifest does not list', () => {
    expect(reviewOfRequest(MANIFEST, { permissions: [], origins: [] }, { permissions: ['debugger'], origins: [] }, 'Sonde')).toBeNull()
    expect(reviewOfRequest(null, { permissions: [], origins: [] }, { permissions: ['history'], origins: [] }, 'Sonde')).toBeNull()
  })
})

describe('what the Extensions page lists of a grant', () => {
  it('is each permission with its sentence and its level, and each site as it was asked for', () => {
    expect(grantedFacts(MANIFEST, { permissions: ['cookies', 'debugger'], origins: ['https://pay.shop.example/*', 'https://bank.example/*'] })).toEqual({
      permissions: [{ id: 'cookies', label: 'Lire et modifier vos cookies sur les sites autorisés', level: 'sensitive' }],
      origins: ['https://pay.shop.example/*']
    })
    expect(grantedFacts(undefined, { permissions: ['cookies'], origins: [] })).toEqual({ permissions: [], origins: [] })
  })
})

describe('a grant kept on disk', () => {
  it('comes back as it was written', () => {
    const grant = { permissions: ['history'], origins: ['https://pay.shop.example/*'] }
    expect(readStoredGrant(storeGrant(grant))).toEqual(grant)
  })

  it('throws for a text that is not one, so that the reader says so', () => {
    expect(() => readStoredGrant('{"permissions":"all"}')).toThrow('not a list of permissions')
    expect(() => readStoredGrant('not json')).toThrow()
  })
})
