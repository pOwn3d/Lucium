// The sections of the site panel: which are open, what each title says of its content, and how the choice is remembered.
//
// The state is a convenience of the person looking at the panel, kept in the storage of the panel's own page (never in the settings, never sent
// anywhere). Every access to the storage can fail (a refused origin, a full quota, a profile without storage): a read that fails gives the
// defaults, a write that fails is reported to the caller, and the panel works the same either way, only without the memory.

import { blockerIsOn, isBlockingExempt, normalizeBlockHost } from './blocker'
import type { Settings } from './model'
import { tp, t } from './i18n'

export const SITE_SECTION_IDS = ['blocking', 'permissions', 'data', 'display', 'boosts', 'extensions'] as const
export type SiteSectionId = (typeof SITE_SECTION_IDS)[number]

/** Whether each section is open. */
export type SectionState = Readonly<Record<SiteSectionId, boolean>>

/** The blocker is open the first time (it is what people come for); the rest is folded so that the panel stays short. */
export const DEFAULT_SECTIONS: SectionState = Object.freeze({ blocking: true, permissions: false, data: false, display: false, boosts: false, extensions: false })

/** The key under which the state is kept in the storage of the panel's page. */
export const SECTIONS_STORAGE_KEY = 'lucium.sitePanel.sections'

export type SectionStorage = Pick<Storage, 'getItem' | 'setItem'>

/**
 * The storage of the page, or null when the page has none (accessing `localStorage` itself throws in a sandboxed frame, with the site data
 * blocked, or in a preview).
 */
export function pageStorage(source: () => Storage = () => globalThis.localStorage): SectionStorage | null {
  try {
    return source()
  } catch (error) {
    console.debug('[site panel] no storage for the sections, the panel opens with the defaults:', error)
    return null
  }
}

/** The state that was remembered, completed with the defaults; whatever is unreadable, missing or not a flag gives the default of that section. */
export function readSections(storage: SectionStorage | null): SectionState {
  if (!storage) return DEFAULT_SECTIONS
  let raw: string | null
  try {
    raw = storage.getItem(SECTIONS_STORAGE_KEY)
  } catch (error) {
    console.debug('[site panel] the storage of the sections cannot be read, the defaults are used:', error)
    return DEFAULT_SECTIONS
  }
  if (raw === null) return DEFAULT_SECTIONS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    console.debug('[site panel] the remembered sections are damaged, the defaults are used:', error)
    return DEFAULT_SECTIONS
  }
  // An array, a number or a text has none of the keys: every section then takes its default, as it should.
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SECTIONS
  const stored = parsed as Record<string, unknown>
  return Object.fromEntries(SITE_SECTION_IDS.map((id) => [id, typeof stored[id] === 'boolean' ? stored[id] : DEFAULT_SECTIONS[id]])) as SectionState
}

/** Remembers the state. False when it could not be written: the panel keeps working, the next one opens with what was remembered before. */
export function writeSections(storage: SectionStorage | null, sections: SectionState): boolean {
  if (!storage) return false
  try {
    storage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify(sections))
    return true
  } catch (error) {
    console.debug('[site panel] the sections cannot be remembered:', error)
    return false
  }
}

/** The state with one section opened or folded. */
export const toggleSection = (sections: SectionState, id: SiteSectionId): SectionState => ({ ...sections, [id]: !sections[id] })

/** What the title of a section says of what is in it, read from the page and the settings. */
export interface SiteFacts {
  /** The blocker has something to switch for this site (a protection is on) and the site is not exempt. */
  blocking: 'on' | 'exempt' | 'off'
  /** Remembered answers of the site, the camera and microphone included. */
  allowed: number
  denied: number
  /** The site's cookies and storage are erased when its last tab closes. */
  clearOnClose: boolean
  /** The display settings of the site that are on (developer mode, forced dark mode, autoplay allowed). Automatic Picture in Picture is not one of them: it is one setting for every site. */
  displayOn: number
  /** The Tweaks of the site, and how many of them are on. */
  boosts: number
  boostsOn: number
  extensions: number
}

export interface SectionSummary {
  text: string
  /** A dot before the text: the colour is never the only signal, the text says the same. */
  tone?: 'ok' | 'warn'
}

/** The line at the right of a section's title, or null when there is nothing worth a line (the section then shows its title only). */
export function sectionSummary(id: SiteSectionId, facts: SiteFacts): SectionSummary | null {
  switch (id) {
    case 'blocking':
      return facts.blocking === 'on' ? { text: t('site-panel.active'), tone: 'ok' } : { text: t('menu.desactive'), tone: 'warn' }
    case 'permissions': {
      const parts = [facts.allowed > 0 ? tp('site-sections.autorisees', facts.allowed) : null, facts.denied > 0 ? tp('site-sections.refusees', facts.denied) : null].filter((part): part is string => part !== null)
      return parts.length > 0 ? { text: parts.join(' · ') } : null
    }
    case 'data':
      return facts.clearOnClose ? { text: t('site-sections.effacees-a-la-fermeture') } : null
    case 'display':
      return facts.displayOn > 0 ? { text: tp('site-sections.actifs', facts.displayOn) } : null
    case 'boosts':
      return facts.boostsOn > 0 ? { text: tp('site-sections.actifs', facts.boostsOn), tone: 'ok' } : facts.boosts > 0 ? { text: t('menu.desactive') } : null
    case 'extensions':
      return facts.extensions > 0 ? { text: String(facts.extensions) } : null
  }
}

/** The title of a section (the one of Tweaks and Extensions are the words the panel already used). */
export function sectionTitle(id: SiteSectionId): string {
  switch (id) {
    case 'blocking':
      return t('site-sections.blocage')
    case 'permissions':
      return t('site-sections.autorisations')
    case 'data':
      return t('site-sections.cookies-et-donnees')
    case 'display':
      return t('site-sections.affichage')
    case 'boosts':
      return t('site-panel.retouches')
    case 'extensions':
      return t('settings.extensions')
  }
}

/**
 * Whether the blocker's row exists for this page, and its state: the row is the one of `Shields` (an http(s) page, not a private tab while a protection is on).
 * `on` is what the title says: the protections are on and the site is not exempt.
 */
export function blockingFacts(url: string, privateTab: boolean, settings: Pick<Settings, 'blockAds' | 'blockTrackers' | 'blockCookieBanners' | 'reduceFingerprint' | 'blockExceptions'>): { shown: boolean; state: SiteFacts['blocking'] } {
  const anyProtection = blockerIsOn(settings) || settings.reduceFingerprint
  const host = /^https?:/.test(url) ? normalizeBlockHost(url) : null
  const shown = host !== null && !(anyProtection && privateTab)
  if (!anyProtection) return { shown, state: 'off' }
  return { shown, state: isBlockingExempt(url, settings.blockExceptions) ? 'exempt' : 'on' }
}
