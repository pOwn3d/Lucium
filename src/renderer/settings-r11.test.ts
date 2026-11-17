// The Settings panes tell the truth about a value they cannot show and about a switch that does nothing alone.
// The panes are rendered to markup (no window): what is checked is what the person would see, not the code that draws it.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { BlockingSettings, FilterListsSettings } from './BlockingSettings'
import { CustomEngineAddress, clearProfileData } from './CurrentProfileSettings'
import { GuardSettings } from './GuardSettings'
import { eraseFailureText } from '@shared/history-scope'
import { PrivacyExtraSettings } from './PrivacyExtraSettings'
import { PrivacySettings } from './PrivacySettings'
import { ProxyEditor } from './ProxyEditor'
import { SYSTEM_PROXY } from '@shared/proxy'
import { Choice } from './settings-parts'
import { frenchSpaces } from '@shared/french-typography'

const ctx = { now: 1, newId: () => 'id' }

/** A snapshot holding only what the Settings panes read: the state with these settings. */
const snapshotWith = (patch: Partial<Settings>): UiSnapshot => {
  const state = createInitialState(ctx)
  return { state: { ...state, settings: { ...state.settings, ...patch } } } as unknown as UiSnapshot
}

const render = (patch: Partial<Settings>): string => renderToStaticMarkup(createElement(BlockingSettings, { snapshot: snapshotWith(patch), update: () => undefined }))

/** The markup of the checkbox inside the row that holds `text`. */
const switchOf = (markup: string, text: string): string => {
  const row = markup.split('<label').find((part) => part.includes(text))
  if (!row) throw new Error(`no row says ${text}`)
  return /<input[^>]*type="checkbox"[^>]*>/.exec(row)![0]
}

describe('Choice', () => {
  const choices: Array<[number, string]> = [[0, 'Jamais'], [5, '5 minutes'], [30, '30 minutes']]
  const show = (value: number): string => renderToStaticMarkup(createElement(Choice, { value, choices, onChange: () => undefined }))

  it('selects the entry of the value it has', () => {
    expect(show(30)).toMatch(/<option value="30" selected="">30 minutes<\/option>/)
    expect(show(30)).not.toContain('<option value="30">30</option>')
  })

  it('shows a value the menu does not list as it is, instead of passing it off as the first choice', () => {
    const markup = show(7)
    expect(markup).toMatch(/<option value="7" selected="">7<\/option>/)
    expect(markup).not.toMatch(/<option value="0" selected/)
  })
})

describe('Settings › Vie privée et sécurité › Plus de réglages › Filtrage cosmétique', () => {
  const COSMETIC = 'Masquer les encarts publicitaires'

  it('is off the table while the ads are not blocked, and says why (the hiding rides on the ad blocking)', () => {
    const markup = render({ blockAds: false, blockTrackers: false, blockCosmetic: true })
    expect(switchOf(markup, COSMETIC)).toContain('disabled')
    expect(markup).toContain(frenchSpaces('Demande « Bloquer les publicités et les traqueurs »'))
  })

  it('is a working switch once the ads are blocked, with nothing to explain', () => {
    const markup = render({ blockAds: true })
    expect(switchOf(markup, COSMETIC)).not.toContain('disabled')
    expect(markup).not.toContain('Demande « Bloquer les publicités et les traqueurs »')
  })
})

describe('Settings › Vie privée et sécurité › Plus de réglages › Mode de blocage', () => {
  /** The pop-up button of the mode, as it is drawn. */
  const modeSelect = (markup: string): string => /<select[^>]*aria-label="Mode de blocage"[^>]*>/.exec(markup)![0]

  it('is a working choice when only the cookie banners are blocked: the mode judges the requests of their lists too', () => {
    const select = modeSelect(render({ blockAds: false, blockTrackers: false, blockCookieBanners: true }))
    expect(select).not.toContain('disabled')
  })

  it('is a working choice when only the ads are blocked', () => {
    expect(modeSelect(render({ blockAds: true, blockCookieBanners: false }))).not.toContain('disabled')
  })

  it('is off the table when nothing is blocked', () => {
    expect(modeSelect(render({ blockAds: false, blockTrackers: false, blockCookieBanners: false }))).toContain('disabled')
  })

  it('dims its row only when nothing is blocked', () => {
    const row = (patch: Partial<Settings>): string => render(patch).split('<div class="pref-row').find((part) => part.includes('Mode de blocage"'))!.slice(0, 40)
    expect(row({ blockAds: false, blockTrackers: false, blockCookieBanners: true })).not.toContain('shields-dim')
    expect(row({ blockAds: false, blockTrackers: false, blockCookieBanners: false })).toContain('shields-dim')
  })
})

describe('Settings › Vie privée et sécurité › Plus de réglages › Scriptlets et règles étendues', () => {
  const hint = (patch: Partial<Settings>): string => /Applique les règles \+js\(\)|Demande l’un des deux blocages/.exec(renderToStaticMarkup(createElement(GuardSettings, { snapshot: snapshotWith(patch), update: () => undefined })))![0]

  it.each([
    { blockAds: false, blockTrackers: false, blockCookieBanners: false, text: 'Demande l’un des deux blocages' },
    { blockAds: true, blockTrackers: false, blockCookieBanners: false, text: 'Applique les règles +js()' },
    { blockAds: false, blockTrackers: true, blockCookieBanners: false, text: 'Applique les règles +js()' },
    { blockAds: false, blockTrackers: false, blockCookieBanners: true, text: 'Applique les règles +js()' }
  ])('reads the blocker as the filter does (ads $blockAds, trackers $blockTrackers, banners $blockCookieBanners): "$text"', ({ text, ...switches }) => {
    expect(hint(switches)).toBe(text)
  })
})

describe('Settings › Vie privée et sécurité › Exceptions par site › Sites sans blocage', () => {
  it('says that these sites also lose the fingerprint protection, which reads the same list', () => {
    const markup = render({ blockExceptions: ['exemple.org'] })
    expect(markup).toContain('la protection contre l’empreinte numérique est aussi désactivée')
  })
})

describe('the network row of the proxy editor', () => {
  const editor = (title?: string): string => renderToStaticMarkup(createElement(ProxyEditor, { value: SYSTEM_PROXY, onChange: () => undefined, name: 'Travail', ...(title ? { title } : {}) }))

  it('is a profile\'s network by default (the editor of the Profils pane)', () => {
    expect(editor()).toContain('Réseau de ce profil')
  })

  it('takes the name it is given', () => {
    expect(editor('Réseau de Lucium')).toContain('Réseau de Lucium')
    expect(editor('Réseau de Lucium')).not.toContain('ce profil')
  })

  it('does not call the general proxy of Vie privée et sécurité a profile\'s: it is the one the profiles without their own, private windows and the application use', () => {
    const markup = renderToStaticMarkup(createElement(PrivacyExtraSettings, { snapshot: snapshotWith({ proxyEnabled: true }), update: () => undefined }))
    expect(markup).toContain('Réseau de Lucium')
    expect(markup).not.toContain('Réseau de ce profil')
  })
})

describe('Settings › Profils › moteur de recherche personnalisé', () => {
  const show = (value: string): string => renderToStaticMarkup(createElement(CustomEngineAddress, { value, onValid: () => undefined }))

  it('shows the address it holds, and no complaint about a good one or an empty one', () => {
    expect(show('https://exemple.org/?q=%s')).toContain('value="https://exemple.org/?q=%s"')
    expect(show('https://exemple.org/?q=%s')).not.toContain('role="alert"')
    expect(show('')).not.toContain('role="alert"')
  })

  it('says what is missing from an address that cannot search (no %s, no http), which the settings would refuse', () => {
    for (const bad of ['h', 'https://exemple.org/?q=', 'exemple.org/?q=%s', 'https://exemple.org/?q= %s']) {
      const markup = show(bad)
      expect(markup, bad).toContain('aria-invalid="true"')
      expect(markup, bad).toContain('role="alert"')
    }
  })
})

describe('the switches that were named only by the text around them', () => {
  // The text is read as it is: a label may hold brackets (« (signal GPC) »).
  const labelOf = (markup: string, text: string): string | undefined => new RegExp(`aria-label="(${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*)"`).exec(markup)?.[1]

  it('carry their own label, so that a screen reader says the label and not the label with its whole explanation', () => {
    const blocking = render({ blockAds: true })
    expect(labelOf(blocking, 'Masquer les encarts publicitaires')).toBe('Masquer les encarts publicitaires dans les pages')
    const privacy = renderToStaticMarkup(createElement(PrivacySettings, { snapshot: snapshotWith({}), update: () => undefined }))
    for (const text of ['Toujours essayer HTTPS d’abord', 'Demander aux sites de ne pas me suivre (signal GPC)', 'Retirer les paramètres de suivi des adresses']) expect(labelOf(privacy, text), text).toBe(text)
  })
})

describe('the note on the syntax of the filter lists (BlockingSettings.tsx)', () => {
  it('is one sentence in one element: a row puts its children side by side, and the code in the middle would cut it in three columns', () => {
    const markup = renderToStaticMarkup(createElement(FilterListsSettings, { snapshot: snapshotWith({ blockAds: true }), update: () => undefined }))
    const note = /<div class="pref-row pref-message">(<span>[^<]*<code>##\+js\(…\)<\/code>[^<]*<\/span>)<\/div>/.exec(markup)?.[1]
    expect(note).toBeDefined()
    expect(note!.startsWith('<span>Syntaxe des filtres')).toBe(true)
  })
})

describe('"Effacer les données de navigation" (CurrentProfileSettings.tsx)', () => {
  it('says that the data was cleared, or why it could not be: a refusal of the main process reaches the row as a sentence', async () => {
    const said: string[] = []
    await clearProfileData(() => Promise.resolve(), 'default', 'Perso', (text) => said.push(text))
    expect(said).toEqual([frenchSpaces('Données du profil « Perso » effacées.')])
    await clearProfileData(() => Promise.reject(new Error('EBUSY: locked')), 'default', 'Perso', (text) => said.push(text))
    expect(said).toHaveLength(2)
    expect(said[1]).toBe(eraseFailureText(new Error('EBUSY: locked')))
    expect(said[1]!.length).toBeGreaterThan(10)
  })
})
