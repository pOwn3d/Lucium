// The foldable sections of the site panel: what is remembered, what happens when the storage fails, what each title says.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from './model'
import { blockingFacts, DEFAULT_SECTIONS, pageStorage, readSections, sectionSummary, sectionTitle, SECTIONS_STORAGE_KEY, SITE_SECTION_IDS, toggleSection, writeSections, type SectionStorage, type SiteFacts } from './site-sections'

afterEach(() => vi.restoreAllMocks())

/** A storage in memory, or one that throws where asked. */
function storage(initial: Record<string, string> = {}, failing: { get?: boolean; set?: boolean } = {}): SectionStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem(key) {
      if (failing.get) throw new Error('storage refused')
      return data[key] ?? null
    },
    setItem(key, value) {
      if (failing.set) throw new DOMException('quota', 'QuotaExceededError')
      data[key] = value
    }
  }
}

describe('the defaults', () => {
  it('open the blocker and fold the rest, so that the panel stays short', () => {
    expect(DEFAULT_SECTIONS).toEqual({ blocking: true, permissions: false, data: false, display: false, boosts: false, extensions: false })
    expect(Object.keys(DEFAULT_SECTIONS)).toEqual([...SITE_SECTION_IDS])
  })
})

describe('what is remembered', () => {
  it('comes back as it was written', () => {
    const store = storage()
    const opened = toggleSection(toggleSection(DEFAULT_SECTIONS, 'data'), 'blocking')
    expect(writeSections(store, opened)).toBe(true)
    expect(readSections(store)).toEqual({ ...DEFAULT_SECTIONS, data: true, blocking: false })
  })

  it('completes a state that lacks sections, and ignores what is not a flag or not a section', () => {
    const store = storage({ [SECTIONS_STORAGE_KEY]: JSON.stringify({ data: true, display: 'yes', blocking: 0, unknown: true }) })
    expect(readSections(store)).toEqual({ ...DEFAULT_SECTIONS, data: true })
  })

  it('gives the defaults when nothing was remembered, and when there is no storage at all', () => {
    expect(readSections(storage())).toEqual(DEFAULT_SECTIONS)
    expect(readSections(null)).toEqual(DEFAULT_SECTIONS)
  })

  it('gives the defaults, and says why in the log, when the remembered text is damaged or is not a record', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    expect(readSections(storage({ [SECTIONS_STORAGE_KEY]: '{not json' }))).toEqual(DEFAULT_SECTIONS)
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('damaged'), expect.anything())
    expect(readSections(storage({ [SECTIONS_STORAGE_KEY]: '[true, true]' }))).toEqual(DEFAULT_SECTIONS)
    expect(readSections(storage({ [SECTIONS_STORAGE_KEY]: 'null' }))).toEqual(DEFAULT_SECTIONS)
  })

  it('gives the defaults, and says why in the log, when the storage refuses to be read', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    expect(readSections(storage({}, { get: true }))).toEqual(DEFAULT_SECTIONS)
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('cannot be read'), expect.any(Error))
  })

  it('reports that it could not write (a full quota) instead of throwing, so that the panel still opens and folds', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    expect(writeSections(storage({}, { set: true }), DEFAULT_SECTIONS)).toBe(false)
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('cannot be remembered'), expect.any(DOMException))
    expect(writeSections(null, DEFAULT_SECTIONS)).toBe(false)
  })

  it('finds no storage when the page itself refuses to give it (a sandboxed frame throws on access)', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    expect(pageStorage(() => { throw new DOMException('denied', 'SecurityError') })).toBeNull()
    const fine = storage() as unknown as Storage
    expect(pageStorage(() => fine)).toBe(fine)
  })
})

describe('toggleSection', () => {
  it('opens what was folded and folds what was open, one section at a time', () => {
    const open = toggleSection(DEFAULT_SECTIONS, 'extensions')
    expect(open.extensions).toBe(true)
    expect(open.blocking).toBe(true)
    expect(toggleSection(open, 'extensions')).toEqual(DEFAULT_SECTIONS)
  })
})

describe('sectionSummary', () => {
  const none: SiteFacts = { blocking: 'on', allowed: 0, denied: 0, clearOnClose: false, displayOn: 0, boosts: 0, boostsOn: 0, extensions: 0 }

  it('says whether the blocker works on this site, with a dot that the words repeat', () => {
    expect(sectionSummary('blocking', none)).toEqual({ text: 'Activé', tone: 'ok' })
    expect(sectionSummary('blocking', { ...none, blocking: 'exempt' })).toEqual({ text: 'Désactivé', tone: 'warn' })
    expect(sectionSummary('blocking', { ...none, blocking: 'off' })).toEqual({ text: 'Désactivé', tone: 'warn' })
  })

  it('counts the permissions answered, in the singular and the plural', () => {
    expect(sectionSummary('permissions', none)).toBeNull()
    expect(sectionSummary('permissions', { ...none, allowed: 1, denied: 1 })).toEqual({ text: '1 autorisée · 1 refusée' })
    expect(sectionSummary('permissions', { ...none, allowed: 2 })).toEqual({ text: '2 autorisées' })
    expect(sectionSummary('permissions', { ...none, denied: 3 })).toEqual({ text: '3 refusées' })
  })

  it('says what is on in Display, in the Tweaks and in the data, and counts the extensions', () => {
    expect(sectionSummary('data', none)).toBeNull()
    expect(sectionSummary('data', { ...none, clearOnClose: true })).toEqual({ text: 'Effacées à la fermeture' })
    expect(sectionSummary('display', { ...none, displayOn: 1 })).toEqual({ text: '1 actif' })
    expect(sectionSummary('display', { ...none, displayOn: 3 })).toEqual({ text: '3 actifs' })
    expect(sectionSummary('boosts', { ...none, boosts: 2, boostsOn: 1 })).toEqual({ text: '1 actif', tone: 'ok' })
    expect(sectionSummary('boosts', { ...none, boosts: 2, boostsOn: 0 })).toEqual({ text: 'Désactivé' })
    expect(sectionSummary('extensions', { ...none, extensions: 4 })).toEqual({ text: '4' })
    expect(sectionSummary('extensions', none)).toBeNull()
  })

  it('has a title for each section, in the words the panel already used for Tweaks and Extensions', () => {
    expect(SITE_SECTION_IDS.map(sectionTitle)).toEqual(['Blocage', 'Autorisations', 'Cookies et données', 'Affichage', 'Retouches', 'Extensions'])
  })
})

describe('blockingFacts', () => {
  const settings = { ...defaultSettings(), blockAds: true, blockCookieBanners: false, reduceFingerprint: false, blockExceptions: ['exempt.example'] }

  it('shows the row for a web page and tells the state of the site', () => {
    expect(blockingFacts('https://example.org/page', false, settings)).toEqual({ shown: true, state: 'on' })
    expect(blockingFacts('https://exempt.example/', false, settings)).toEqual({ shown: true, state: 'exempt' })
  })

  it('shows no row for a page that is not on the web, and none for a private tab while a protection is on (nothing is written for it)', () => {
    expect(blockingFacts('about:blank', false, settings).shown).toBe(false)
    expect(blockingFacts('file:///tmp/a.html', false, settings).shown).toBe(false)
    expect(blockingFacts('https://example.org/', true, settings).shown).toBe(false)
  })

  it('is "off" when no protection is on (the row then leads to the settings), private tab or not', () => {
    const none = { ...settings, blockAds: false, blockTrackers: false }
    expect(blockingFacts('https://example.org/', false, none)).toEqual({ shown: true, state: 'off' })
    expect(blockingFacts('https://example.org/', true, none)).toEqual({ shown: true, state: 'off' })
  })

  // The row reads the gate of the blocker (shared/blocker.ts): the ads and trackers pair, either one, and the banners.
  it.each([
    { blockAds: false, blockTrackers: false, blockCookieBanners: false, state: 'off' },
    { blockAds: true, blockTrackers: false, blockCookieBanners: false, state: 'on' },
    { blockAds: false, blockTrackers: true, blockCookieBanners: false, state: 'on' },
    { blockAds: false, blockTrackers: false, blockCookieBanners: true, state: 'on' }
  ])('says $state for blockAds $blockAds, blockTrackers $blockTrackers, banners $blockCookieBanners', ({ state, ...switches }) => {
    expect(blockingFacts('https://example.org/', false, { ...settings, ...switches }).state).toBe(state)
  })
})
