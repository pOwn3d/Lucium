// The ring of the resources at the foot of the sidebar and its panel (ResourcePanel.tsx), drawn to markup with the real components (no window),
// and the motion of the panel as its stylesheet says it.

import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { memoryGauge, type ResourceReport, type ResourceTab } from '@shared/resources'
import panelCss from './resource-panel.css?raw'
import sidebarSource from './Sidebar.tsx?raw'

const holder = vi.hoisted(() => ({ calls: [] as unknown[], fails: false }))
vi.mock('./api', () => ({
  api: () => ({
    resourcePanel: (open: boolean) => holder.calls.push(open),
    onResources: () => () => undefined,
    resourceAction: () => (holder.fails ? Promise.reject(new Error('the window is gone')) : Promise.resolve({ slept: 3 }))
  })
}))

import { FooterResources, ResourcePanelBody, ResourceRow, ask } from './ResourcePanel'
import { elementsOf } from './render.test-support'
import { frenchSpaces } from '@shared/french-typography'

const GB = 1024
const tab = (tabId: string, memoryMb: number, cpu: number, extra: Partial<ResourceTab> = {}): ResourceTab => ({ tabId, name: tabId, url: `https://${tabId.toLowerCase()}.example/`, memoryMb, cpu, ...extra })
const report = (patch: Partial<ResourceReport> = {}): ResourceReport => ({
  memoryMb: 8500,
  cpu: 33.4,
  gauge: memoryGauge(8.3 * GB, 16 * GB, 1),
  tabs: [tab('Twitch', 584, 7.4), tab('Perso', 278, 0.2, { where: 'Travail', pinned: true }), tab('Home', 1300, 1, { shared: true })],
  hidden: 2,
  ...patch
})
const body = (patch: Partial<Parameters<typeof ResourcePanelBody>[0]> = {}): string =>
  renderToStaticMarkup(createElement(ResourcePanelBody, { report: report(), notice: '', onShow: () => undefined, onSleep: () => undefined, onClose: () => undefined, onSleepHidden: () => undefined, onTaskManager: () => undefined, ...patch }))

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) })
  setLanguage('fr')
  holder.calls.length = 0
  holder.fails = false
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the ring at the foot of the sidebar', () => {
  const ring = (props: Partial<Parameters<typeof FooterResources>[0]> = {}): string =>
    renderToStaticMarkup(createElement(FooterResources, { enabled: true, gauge: memoryGauge(8.3 * GB, 16 * GB, 1), shown: true, forceReduceMotion: false, ...props }))

  it('is not drawn at all with its setting off', () => {
    expect(ring({ enabled: false })).toBe('')
  })

  it('fills with the share of the memory, says the figures in its tooltip, and is amber past half', () => {
    const markup = ring()
    expect(markup).toContain('style="--p:52"')
    expect(markup).toMatch(/class="footer-side rg-gauge warn /)
    expect(markup).toContain(frenchSpaces('data-tip="Mémoire du navigateur : 8,3 Go sur 16 Go (52 %)"'))
    expect(markup).toContain('aria-haspopup="dialog"')
    expect(markup).toContain('aria-expanded="false"')
    expect(ring({ gauge: memoryGauge(2 * GB, 16 * GB, 1) })).not.toMatch(/rg-gauge warn/)
    expect(ring({ gauge: memoryGauge(2 * GB, 16 * GB, 2) })).toMatch(/rg-gauge warn/)
  })

  it('is closed at first: no panel, so nothing asks the main process for figures', () => {
    const markup = ring()
    expect(markup).not.toContain('rp-panel')
    expect(holder.calls).toEqual([])
  })

  it('has a name before its first reading', () => {
    expect(ring({ gauge: undefined })).toContain('aria-label="Ressources du navigateur"')
  })

  it('is mounted in the footer of a normal window, after the downloads, with its setting', () => {
    expect(sidebarSource).toMatch(/<FooterDownloads[\s\S]*?\/>\s*\{\/\*[^*]*\*\/\}\s*\{!snapshot\.private && \(\s*<FooterResources enabled=\{state\.settings\.resourceGauge\}/)
  })
})

describe('the panel', () => {
  it('gives the totals, the share of the Mac’s memory and the heaviest tabs with their figures', () => {
    const markup = body()
    expect(markup).toContain(frenchSpaces('<b>Ressources</b><span>8,3 Go · 33 % d’un cœur</span>'))
    expect(markup).toContain('role="meter"')
    expect(markup).toContain('aria-valuenow="52"')
    expect(markup).toContain(frenchSpaces('<span class="rp-percent">52 %</span>'))
    expect(markup.match(/class="rp-row"/g)).toHaveLength(3)
    expect(markup).toContain(frenchSpaces('<span>584 Mo</span><span>7,4 %</span>'))
  })

  it('says it is measuring before the first figures, and that no tab is awake when none is', () => {
    expect(body({ report: null })).toContain('Mesure…')
    expect(body({ report: null })).toMatch(/class="rp-sleep-all"[^>]*disabled=""/)
    expect(body({ report: report({ tabs: [], hidden: 0 }) })).toContain('Aucun onglet éveillé')
  })

  it('greys « Tout endormir » when no awake tab is hidden', () => {
    expect(body({ report: report({ hidden: 0 }) })).toMatch(/class="rp-sleep-all"[^>]*disabled=""/)
    expect(body()).not.toMatch(/class="rp-sleep-all"[^>]*disabled=""/)
  })

  it('says what the last button did, to a screen reader too', () => {
    expect(body({ notice: '2 onglets mis en veille' })).toContain('<p class="rp-notice" role="status" aria-live="polite">2 onglets mis en veille</p>')
  })
})

describe('the rows under the pointer', () => {
  it('tell the panel when the pointer comes on them and leaves them', () => {
    const said: boolean[] = []
    const list = elementsOf(createElement(ResourcePanelBody, { report: report(), notice: '', onShow: () => undefined, onSleep: () => undefined, onClose: () => undefined, onSleepHidden: () => undefined, onTaskManager: () => undefined, onHold: (held) => said.push(held) })).find((element) => element.props['className'] === 'rp-rows')
    ;(list?.props['onPointerEnter'] as () => void)()
    ;(list?.props['onPointerLeave'] as () => void)()
    expect(said).toEqual([true, false])
  })

  it('keep their places meanwhile: the panel draws the figures through `heldReport`, without the rows it acted on', () => {
    const source = readFileSync(new URL('./ResourcePanel.tsx', import.meta.url), 'utf8')
    expect(source).toContain('act.onResources((next) => setReport((shown) => (held.current ? heldReport(shown, next, acted.current) : next)))')
    expect(source).toContain('onHold={hold}')
    // ☾ and ✕ go through one function, which marks the row it acts on.
    expect(source.match(/acted\.current\.add\(tab\.tabId\)/g)).toHaveLength(1)
    expect(source.match(/=> actOn\(tab, row, [12], '(?:sleep|close)'/g)).toHaveLength(2)
  })
})

describe('a row', () => {
  const row = (t: ResourceTab, tabs: ResourceTab[] = [t, tab('Big', 1200, 50)]): string =>
    renderToStaticMarkup(createElement('ul', null, createElement(ResourceRow, { tab: t, row: 0, tabs, onShow: () => undefined, onSleep: () => undefined, onClose: () => undefined })))

  it('names its three buttons: show the tab, put it to sleep, close it', () => {
    const markup = row(tab('Twitch', 584, 7.4, { where: 'Fenêtre 2' }))
    expect(markup).toContain(frenchSpaces('aria-label="Afficher « Twitch » · 584 Mo · 7,4 % · Fenêtre 2"'))
    expect(markup).toContain(frenchSpaces('aria-label="Mettre en veille « Twitch »"'))
    expect(markup).toContain(frenchSpaces('aria-label="Fermer « Twitch »"'))
    expect(markup).toContain('<span class="rp-where">Fenêtre 2</span>')
    expect(markup).toContain('data-col="0"')
    expect(markup).toContain('data-col="2"')
  })

  it('says what ✕ does: a Today tab is archived, an awake pinned one is closed and stays pinned (the sidebar’s cross)', () => {
    expect(row(tab('Today', 100, 0))).toContain('title="Archiver cet onglet"')
    expect(row(tab('Pin', 100, 0, { pinned: true }))).toContain('title="Fermer et garder épinglé"')
  })

  it('draws its meter against the heaviest tab, hot for a heavy or busy one', () => {
    expect(row(tab('Half', 600, 0))).toMatch(/<i class="" style="--w:0\.5"/)
    expect(row(tab('Heavy', 1200, 0))).toMatch(/<i class="hot" style="--w:1"/)
  })

  it('shows the emoji the user gave the tab in place of its favicon, and says a shared process', () => {
    const markup = row(tab('Notes', 100, 0, { icon: '📝', shared: true }))
    expect(markup).toContain('<span class="favicon emoji-icon">📝</span>')
    expect(markup).toContain(frenchSpaces('title="Processus partagé avec un autre onglet : ces chiffres sont ceux du processus"'))
  })
})

describe('a button of the panel', () => {
  it('gives the answer of the main process', async () => {
    expect(await ask({ kind: 'sleep-hidden' })).toEqual({ slept: 3 })
  })

  it('leaves the panel as it is when its request fails, and says so in the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    holder.fails = true
    expect(await ask({ kind: 'close', tabId: 't1' })).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the action close of the panel failed'), 'the window is gone')
  })
})

describe('the motion of the panel', () => {
  it('rises in about 0.2 s with a spring, moving only its transform and its opacity', () => {
    const rule = /\.sidebar \.rp-panel \{[^}]*\}/.exec(panelCss)![0]
    expect(rule).toMatch(/animation: rp-in 0\.2\ds cubic-bezier\(0\.34, 1\.\d+, 0\.64, 1\)/)
    const frames = /@keyframes rp-in \{([^}]*\}){2}/.exec(panelCss)![0]
    expect([...frames.matchAll(/([a-z-]+):/g)].map((m) => m[1]).filter((p) => p !== 'from' && p !== 'to')).toEqual(['opacity', 'transform', 'opacity', 'transform'])
  })

  it('does not move when the system asks for less motion, nor with the setting', () => {
    expect(panelCss).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.sidebar \.rp-panel, \.sidebar \.rp-panel\.closing \{ animation: none; \}\s*\}/)
    expect(panelCss).toMatch(/:root\[data-motion='reduce'\] \.sidebar \.rp-panel \{ animation: none; \}/)
  })
})
