// The tooltips of the site panel. A tooltip opens under the pointer and covers some 30 px: on a line whose name is already written (the header « Blocage »
// with its chevron, a tile, a row, a switch beside its name), « Replier la section Blocage » only hid the line under it. Those lines have none any more,
// and keep their name for a screen reader; a tooltip that says more than the line (what a row does, the shortcut of an icon) stays.
// Rendered with the real component, every section open (no window).

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import { NEUTRAL_TINT, type Boost } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'
import { SECTIONS_STORAGE_KEY, SITE_SECTION_IDS, sectionTitle } from '@shared/site-sections'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => ({ dispatch: () => Promise.resolve(), openOverlay: () => undefined, closeOverlay: () => undefined }), useSnapshot: () => holder.snapshot }))

import { SitePanel } from './SitePanel'

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const boost: Boost = { id: 'b1', name: 'Zoom doux', host: 'exemple.fr', enabled: true, css: 'body { zoom: 1.1 }', js: '', zoom: 1, zap: [], tint: NEUTRAL_TINT }

/** The panel on https://exemple.fr/a, with a Tweak and an answer of the site to forget, every section open. */
function panel(): string {
  let state = createInitialState(ctx)
  state = reduce(state, { type: 'tab/open', url: 'https://exemple.fr/a', spaceId: state.spaces[0]!.id }, ctx)
  holder.snapshot = { state: { ...state, boosts: [boost], sitePermissions: { 'https://exemple.fr': { geolocation: 'deny' } } }, extensions: [], runtime: { tabs: {} }, private: false }
  return renderToStaticMarkup(createElement(SitePanel))
}

type Button = { attributes: string; text: string }

/** The buttons of the markup: their opening tag, and the text a person reads in them (the tags taken out). */
function buttonsOf(markup: string): Button[] {
  return [...markup.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => ({ attributes: match[1]!, text: match[2]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }))
}
const attribute = (button: Button, name: string): string | null => new RegExp(`\\s${name}="([^"]*)"`).exec(button.attributes)?.[1] ?? null
const withClass = (buttons: Button[], name: string): Button[] => buttons.filter((button) => (attribute(button, 'class') ?? '').split(' ').includes(name))

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
  const open = JSON.stringify(Object.fromEntries(SITE_SECTION_IDS.map((id) => [id, true])))
  vi.stubGlobal('localStorage', { getItem: (key: string) => (key === SECTIONS_STORAGE_KEY ? open : null), setItem: () => undefined })
  setLanguage('fr')
})
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

describe('the headers of the sections of the site panel', () => {
  it('have no tooltip, and keep their state and their name: the title they show', () => {
    const heads = withClass(buttonsOf(panel()), 'scc-section-head')
    expect(heads.length, 'the sections drawn').toBeGreaterThanOrEqual(4)
    for (const head of heads) {
      expect(attribute(head, 'title'), head.text).toBeNull()
      expect(attribute(head, 'aria-expanded'), head.text).toBe('true')
      expect(SITE_SECTION_IDS.some((id) => head.text.startsWith(sectionTitle(id))), `${head.text}: named by its title`).toBe(true)
    }
  })
})

describe('the lines of the site panel whose name is written', () => {
  it('a tile, the row that opens the data of the site, the switch of a Tweak and « Oublier » have no tooltip, and keep their name', () => {
    const buttons = buttonsOf(panel())
    const tiles = withClass(buttons, 'scc-tile').filter((tile) => !(attribute(tile, 'class') ?? '').includes('small'))
    expect(tiles.length).toBeGreaterThanOrEqual(4)
    for (const tile of tiles) {
      expect(attribute(tile, 'title'), tile.text).toBeNull()
      expect(attribute(tile, 'aria-label'), 'the name of the tile is what it shows').toBe(tile.text)
    }
    const erase = buttons.find((button) => button.text.startsWith(t('site-panel.effacer-les-donnees')))
    expect(erase, 'the row « Effacer les données… »').toBeDefined()
    expect(attribute(erase!, 'title')).toBeNull()
    const tweak = withClass(buttons, 'scc-boost')
    expect(tweak).toHaveLength(1)
    expect(attribute(tweak[0]!, 'title')).toBeNull()
    expect(attribute(tweak[0]!, 'role')).toBe('switch')
    expect(attribute(tweak[0]!, 'aria-checked')).toBe('true')
    expect(tweak[0]!.text).toContain(boost.name)
    const forget = withClass(buttons, 'scc-perm-forget')
    expect(forget).toHaveLength(1)
    expect(attribute(forget[0]!, 'title')).toBeNull()
    expect(attribute(forget[0]!, 'aria-label')).toContain(t('site-panel.oublier'))
  })

  it('keep a tooltip that says more than the line: what the readable mode row does at a click, the name of an icon', () => {
    const buttons = buttonsOf(panel())
    const readable = buttons.find((button) => button.text.startsWith(t('site-panel.contraste-de-la-page')))
    expect(attribute(readable!, 'title') ?? '').toMatch(/^Contraste de la page pour ce site/)
    const edit = buttons.find((button) => attribute(button, 'aria-label') === t('site-panel.modifier-name', { name: boost.name }))
    expect(attribute(edit!, 'title'), 'the pencil of a Tweak is an icon: its tooltip is its name').toBe(t('site-panel.modifier-name', { name: boost.name }))
  })
})
