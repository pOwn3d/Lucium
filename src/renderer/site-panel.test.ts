// The extras of the site panel: the actions of the web tools appear only while their function is on, and the
// footer leaves for the settings about sites. Rendered with the real component and a state with one open page (no window). What a button asks of the
// bridge is read the way site-permissions.test.ts reads it: the component is called as a function, and the handler it hands to a button is called.

import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { OverlayRequest } from '@shared/ipc'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'
import { settingsHash } from '@shared/settings-target'

/** What the panel asked of the bridge, in order. */
const holder = vi.hoisted(() => ({ snapshot: null as unknown, asked: [] as Array<{ call: string; request?: unknown }> }))
vi.mock('./api', () => ({
  api: () => ({
    openOverlay: (request: unknown) => holder.asked.push({ call: 'openOverlay', request }),
    closeOverlay: () => holder.asked.push({ call: 'closeOverlay' }),
    shareSite: () => holder.asked.push({ call: 'shareSite' }),
    dispatch: (action: unknown) => holder.asked.push({ call: 'dispatch', request: action })
  }),
  useSnapshot: () => holder.snapshot
}))

import { SitePanel } from './SitePanel'

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }

/** The panel's state: one open tab on `open.url` (a private tab with `open.private`), in a private window with `open.window`. */
function snapshotWith(settings: Partial<SidebarState['settings']>, open: { url?: string; private?: boolean; window?: boolean } = {}): void {
  let state = createInitialState(ctx)
  state = reduce(state, { type: 'tab/open', url: open.url ?? 'https://exemple.fr/a', spaceId: state.spaces[0]!.id, ...(open.private ? { private: true } : {}) }, ctx)
  state = reduce(state, { type: 'settings/update', patch: settings }, ctx)
  holder.snapshot = { state, extensions: [], runtime: { tabs: {} }, private: open.window === true }
}

function page(settings: Partial<SidebarState['settings']> = {}, open: Parameters<typeof snapshotWith>[1] = {}): string {
  snapshotWith(settings, open)
  return renderToStaticMarkup(createElement(SitePanel))
}

/** Every element of a tree, depth first. */
function elementsOf(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elementsOf)
  if (!isValidElement(node)) return []
  const element = node as ReactElement<Record<string, unknown>>
  return [element, ...elementsOf(element.props['children'] as ReactNode)]
}

/** The panel as the elements it returns (it keeps state, so it is called while a render is going on), and a click on the button that `find` picks. */
function click(settings: Partial<SidebarState['settings']>, find: (props: Record<string, unknown>) => boolean, open: Parameters<typeof snapshotWith>[1] = {}): void {
  snapshotWith(settings, open)
  let tree: ReactNode = null
  const Probe = () => {
    tree = SitePanel({})
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  const button = elementsOf(tree).find((element) => element.type === 'button' && find(element.props))
  expect(button, 'the button is in the panel').toBeDefined()
  holder.asked.length = 0
  ;(button!.props['onClick'] as () => void)()
}

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
  setLanguage('fr')
  holder.asked.length = 0
})
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

describe('the actions of the site panel', () => {
  it('are the four default ones while the web tools are off', () => {
    const markup = page({ translateLocal: false })
    expect(markup.match(/class="scc-tile"/g)).toHaveLength(4)
    expect(markup).not.toContain('>Traduire<')
    expect(markup).not.toContain('>Code QR<')
  })

  it('gain Traduire with the local translation, and Code QR with the QR code, each by its own switch', () => {
    const translate = page({ translateLocal: true })
    expect(translate).toContain('>Traduire<')
    expect(translate).not.toContain('>Code QR<')
    const qr = page({ qrCode: true, translateLocal: false })
    expect(qr).toContain('>Code QR<')
    expect(qr).not.toContain('>Traduire<')
    expect(page({ translateLocal: true, qrCode: true }).match(/class="scc-tile"/g)).toHaveLength(6)
  })

  it('open the translation panel, and the QR code of the address of the page', () => {
    const on = { translateLocal: true, qrCode: true }
    click(on, (props) => props['className'] === 'scc-tile' && props['aria-label'] === 'Traduire')
    expect(holder.asked).toEqual([{ call: 'openOverlay', request: { panel: 'translate' } }])
    click(on, (props) => props['className'] === 'scc-tile' && props['aria-label'] === 'Code QR')
    expect(holder.asked).toEqual([{ call: 'openOverlay', request: { panel: 'qr', text: 'https://exemple.fr/a' } }])
  })
})

describe('"Réglages du site…" in the foot of the site panel', () => {
  it('is there, and leaves for the group of Réglages that holds the settings about sites', () => {
    expect(page()).toMatch(/class="scc-site-settings"[^>]*>Réglages du site…<\/button>/)
    click({}, (props) => props['className'] === 'scc-site-settings')
    // The panel is closed first, then the settings open.
    expect(holder.asked).toEqual([{ call: 'closeOverlay' }, { call: 'openOverlay', request: { panel: 'settings', pane: 'protection', anchor: 'permissions' } }])
    // The anchor is one the Settings window scrolls to (a wrong one would open the category at its top).
    const { pane, anchor } = holder.asked[1]!.request as Extract<OverlayRequest, { panel: 'settings' }>
    expect(settingsHash(pane!, anchor)).toBe('protection/permissions')
  })
})

describe('the rows of the site panel that are on or off', () => {
  // « Effacer à la fermeture » was a switch and its neighbours plain buttons whose text said the state: a screen reader now hears a state on each.
  const textOf = (node: ReactNode): string => (Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' ? node : isValidElement(node) ? textOf((node.props as { children?: ReactNode }).children) : '')
  /** The role and the state of the row whose text starts with `name` (a folded section holds its rows all the same). */
  function rowOf(settings: Partial<SidebarState['settings']>, name: string): unknown[] {
    snapshotWith(settings)
    let tree: ReactNode = null
    const Probe = () => {
      tree = SitePanel({})
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    const row = elementsOf(tree).find((element) => element.type === 'button' && element.props['className'] === 'scc-setting' && textOf(element.props['children'] as ReactNode).startsWith(name))
    return [row?.props['role'], row?.props['aria-checked']]
  }

  it('says the developer mode and the automatic picture in picture as switches, with their state', () => {
    expect(rowOf({ autoPictureInPicture: false }, 'Mode développeur')).toEqual(['switch', false])
    expect(rowOf({ developerHosts: ['exemple.fr'] }, 'Mode développeur')).toEqual(['switch', true])
    expect(rowOf({ autoPictureInPicture: false }, 'Image dans l’image automatique')).toEqual(['switch', false])
    expect(rowOf({ autoPictureInPicture: true }, 'Image dans l’image automatique')).toEqual(['switch', true])
  })
})

describe('the "Contraste de la page" row of the site panel', () => {
  const url = 'https://www.exemple.fr/a'
  const readableButton = (props: Record<string, unknown>) => props['className'] === 'scc-setting' && String(props['title']).startsWith('Contraste de la page pour ce site')

  /** The panel's elements (the folded section holds its rows all the same), as `click` reads them. */
  function panelElements(settings: Partial<SidebarState['settings']>, open: Parameters<typeof snapshotWith>[1] = {}): ReactElement<Record<string, unknown>>[] {
    snapshotWith(settings, open)
    let tree: ReactNode = null
    const Probe = () => {
      tree = SitePanel({})
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    return elementsOf(tree)
  }
  const textOf = (node: ReactNode): string => (Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' ? node : isValidElement(node) ? textOf((node.props as { children?: ReactNode }).children) : '')
  /** What the row says (its title and its two lines), or null when the panel has no such row. */
  const rowOf = (settings: Partial<SidebarState['settings']>, open: Parameters<typeof snapshotWith>[1] = {}) => {
    const button = panelElements(settings, open).find((element) => element.type === 'button' && readableButton(element.props))
    return button ? textOf(button.props['children'] as ReactNode) : null
  }

  it('says what the site has: the default while it has nothing of its own, then its own mode', () => {
    expect(rowOf({})).toBe('Contraste de la pagePar défaut · Original')
    expect(rowOf({ readableMode: 'dark' })).toBe('Contraste de la pagePar défaut · Sombre')
    expect(rowOf({ readableMode: 'auto' })).toBe('Contraste de la pagePar défaut · Automatique')
    expect(rowOf({ readableMode: 'dark', siteReadableMode: { 'exemple.fr': 'light' } })).toBe('Contraste de la pageClair')
    expect(rowOf({ siteReadableMode: { 'exemple.fr': 'original' } })).toBe('Contraste de la pageOriginal')
    // The parent domain’s mode is the page’s own.
    expect(rowOf({ siteReadableMode: { 'exemple.fr': 'dark' } }, { url: 'https://blog.exemple.fr/' })).toBe('Contraste de la pageSombre')
  })

  it('goes through the choices one click at a time: the default, Sombre, Clair, Original, and back to the default', () => {
    const own = (mode: 'dark' | 'light' | 'original') => ({ siteReadableMode: { 'exemple.fr': mode } })
    const steps: Array<[Partial<SidebarState['settings']>, 'dark' | 'light' | 'original' | null]> = [[{}, 'dark'], [own('dark'), 'light'], [own('light'), 'original'], [own('original'), null]]
    for (const [settings, next] of steps) {
      click(settings, readableButton, { url })
      const [{ call, request }] = holder.asked as [{ call: string; request: { type: string; site: string; mode: unknown; tabId: string } }]
      expect(call).toBe('dispatch')
      expect(request, JSON.stringify(settings)).toMatchObject({ type: 'readable/site', site: url, mode: next })
      expect(typeof request.tabId).toBe('string')
      expect(request.tabId).not.toBe('')
    }
  })

  it('is there for a web page whatever the default, with no switch to turn on first', () => {
    expect(rowOf({ readableMode: 'original' })).not.toBeNull()
    expect(rowOf({ readableMode: 'dark' })).not.toBeNull()
  })

  it('counts among the display settings that are on, in the title of the section, when the site is not left as it is', () => {
    const shown = (settings: Partial<SidebarState['settings']>) => page(settings).match(/Affichage<\/span>(?:<span class="scc-section-sum ">([^<]*)<\/span>)?/)?.[1]
    const base = shown({ autoPictureInPicture: false })
    expect(shown({ autoPictureInPicture: false, readableMode: 'dark' })).not.toBe(base)
    expect(shown({ autoPictureInPicture: false, siteReadableMode: { 'exemple.fr': 'light' } })).not.toBe(base)
    expect(shown({ autoPictureInPicture: false, readableMode: 'dark', siteReadableMode: { 'exemple.fr': 'original' } })).toBe(base)
  })

  it('is not there for a page that is no web page, a private tab, or a private window: their sites are not written to the settings', () => {
    expect(rowOf({}, { url: 'about:blank' })).toBeNull()
    expect(rowOf({}, { url: 'file:///tmp/a.html' })).toBeNull()
    expect(rowOf({}, { private: true })).toBeNull()
    expect(rowOf({}, { window: true })).toBeNull()
  })
})

// « Un réglage pour chaque site » is gone (a setting of a setting): the panel always offers the autoplay of the site, and the choice of the site
// applies, even for a state file that kept the old switch off.
describe('the "Lecture automatique" row of the site panel', () => {
  const autoplayButton = (props: Record<string, unknown>) => props['className'] === 'scc-setting' && String(props['title']).startsWith('Lecture automatique pour ce site')
  const elements = (settings: Partial<SidebarState['settings']>, open: Parameters<typeof snapshotWith>[1] = {}): ReactElement<Record<string, unknown>>[] => {
    snapshotWith(settings, open)
    let tree: ReactNode = null
    const Probe = () => {
      tree = SitePanel({})
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    return elementsOf(tree)
  }
  const textOf = (node: ReactNode): string => (Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' ? node : isValidElement(node) ? textOf((node.props as { children?: ReactNode }).children) : '')
  const row = (settings: Partial<SidebarState['settings']>, open: Parameters<typeof snapshotWith>[1] = {}) => elements(settings, open).find((element) => element.type === 'button' && autoplayButton(element.props))

  it('is offered for a web page whatever an older state file kept, and says the choice of the site', () => {
    expect(row({ autoplayPerSite: true })).toBeDefined()
    const kept = row({ autoplayPerSite: false, siteAutoplay: { 'exemple.fr': 'allow' } })
    expect(kept).toBeDefined()
    expect(textOf(kept!.props['children'] as ReactNode)).toContain('Autoriser')
  })

  it('is not offered for a private tab, whose sites are not kept', () => {
    expect(row({}, { private: true })).toBeUndefined()
  })
})
