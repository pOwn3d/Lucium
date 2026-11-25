// The ring of the resources at the foot of the sidebar and its panel (ResourcePanel.tsx), drawn to markup with the real components (no window),
// and the motion of the panel as its stylesheet says it.

import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { memoryGauge, type ReleasePreview, type ResourceReport, type ResourceTab } from '@shared/resources'
import panelCss from './resource-panel.css?raw'
import sidebarSource from './Sidebar.tsx?raw'

const holder = vi.hoisted(() => ({ calls: [] as unknown[], fails: false }))
vi.mock('./api', () => ({
  api: () => ({
    resourcePanel: (open: boolean) => holder.calls.push(open),
    onResources: () => () => undefined,
    resourceAction: () => (holder.fails ? Promise.reject(new Error('the window is gone')) : Promise.resolve({ released: { level: 'medium', slept: 3, refused: { unsent: 0, confirm: 0, other: 0 } } }))
  })
}))

import { FooterResources, ReleaseLevels, ResourcePanelBody, ResourceRow, ask } from './ResourcePanel'
import { elementsOf } from './render.test-support'
import { frenchSpaces } from '@shared/french-typography'

const GB = 1024
const tab = (tabId: string, memoryMb: number, cpu: number, extra: Partial<ResourceTab> = {}): ResourceTab => ({ tabId, name: tabId, url: `https://${tabId.toLowerCase()}.example/`, memoryMb, cpu, ...extra })
const levels = (patch: Partial<Record<ReleasePreview['level'], Partial<ReleasePreview>>> = {}): ReleasePreview[] => [
  { level: 'low', count: 4, memoryMb: 600, cpu: 1, siteTabs: 0, ...patch.low },
  { level: 'medium', count: 12, memoryMb: 2150, cpu: 3, siteTabs: 0, ...patch.medium },
  { level: 'high', count: 35, memoryMb: 4900, cpu: 5, siteTabs: 20, ...patch.high }
]
const OTHERS = { count: 38, memoryMb: 6338, cpu: 24.8, gpuMemoryMb: 1280, gpuCpu: 30 }
const report = (patch: Partial<ResourceReport> = {}): ResourceReport => {
  const tabs = [tab('Twitch', 584, 7.4), tab('Perso', 278, 0.2, { where: 'Travail', pinned: true }), tab('Home', 1300, 1, { shared: true })]
  return {
    memoryMb: 8500,
    cpu: 33.4,
    gauge: memoryGauge(8.3 * GB, 16 * GB, 1),
    tabs,
    others: OTHERS,
    byCpu: { tabs: [tabs[0]!, tabs[2]!, tabs[1]!], others: OTHERS },
    levels: levels(),
    ...patch
  }
}
const body = (patch: Partial<Parameters<typeof ResourcePanelBody>[0]> = {}): string =>
  renderToStaticMarkup(createElement(ResourcePanelBody, { report: report(), notice: '', onShow: () => undefined, onSleep: () => undefined, onClose: () => undefined, onRelease: () => undefined, onTaskManager: () => undefined, ...patch }))

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
    expect(body({ report: report({ tabs: [] }) })).toContain('Aucun onglet éveillé')
  })

  it('says what the last button did, to a screen reader too', () => {
    expect(body({ notice: '2 onglets mis en veille' })).toContain('<p class="rp-notice" role="status" aria-live="polite">2 onglets mis en veille</p>')
  })
})

describe('what the rows leave out and the ranking', () => {
  it('adds a row « Autres processus » that holds what the rows do not (the figures that make the total), with the graphic process on its own line', () => {
    const markup = body()
    const others = markup.slice(markup.indexOf('class="rp-others"'))
    expect(others).toContain('Autres processus')
    expect(others).toContain(frenchSpaces('Graphique, interface, onglets non listés · 38 processus'))
    expect(others).toContain(frenchSpaces('Dont processeur graphique : 1,3 Go · 30 %'))
    expect(others).toContain(frenchSpaces('<span>6,2 Go</span><span>25 %</span>'))
    // It is not a row of a tab: no button, and not counted among the rows the arrow keys walk.
    expect(markup.match(/class="rp-row"/g)).toHaveLength(3)
    expect(others.slice(0, others.indexOf('</div>'))).not.toContain('<button')
  })

  it('leaves out the line of the graphic process when it is not among the others, and shows nothing before the first figures', () => {
    expect(body({ report: report({ others: { ...OTHERS, gpuMemoryMb: 0, gpuCpu: 0 } }) })).not.toContain('Dont processeur graphique')
    expect(body({ report: null })).not.toContain('rp-others')
  })

  it('offers « Mémoire » and « Processeur », the ranking of the rows being the one pressed', () => {
    const markup = body({ onSort: () => undefined })
    expect(markup).toContain('role="group" aria-label="Trier par"')
    expect(markup).toContain('data-sort="memory" aria-pressed="true">Mémoire</button>')
    expect(markup).toContain('data-sort="cpu" aria-pressed="false">Processeur</button>')
    expect(body({ onSort: () => undefined, sort: 'cpu' })).toContain('data-sort="cpu" aria-pressed="true">Processeur</button>')
  })

  it('draws the rows of the chosen ranking, and names the list for a screen reader', () => {
    const names = (markup: string): string[] => [...markup.matchAll(/<span class="rp-name">([^<]*)<\/span>/g)].map((m) => m[1]!).filter((name) => name !== 'Autres processus')
    expect(names(body())).toEqual(['Twitch', 'Perso', 'Home'])
    const byCpu = body({ sort: 'cpu' })
    expect(names(byCpu)).toEqual(['Twitch', 'Home', 'Perso'])
    expect(byCpu).toContain('aria-label="Onglets qui utilisent le plus le processeur"')
    expect(body()).toContain('aria-label="Onglets qui consomment le plus"')
  })

  it('is written in English too', () => {
    setLanguage('en')
    const markup = body({ onSort: () => undefined })
    expect(markup).toContain('Other processes')
    expect(markup).toContain('Graphics, interface, tabs not listed · 38 processes')
    expect(markup).toContain('Of which graphics process: 1.3 GB · 30%')
    expect(markup).toContain('aria-label="Sort by"')
  })
})

describe('« Libérer maintenant »', () => {
  const release = (props: Partial<Parameters<typeof ReleaseLevels>[0]> = {}): string => renderToStaticMarkup(createElement(ReleaseLevels, { levels: levels(), running: null, onRelease: () => undefined, ...props }))
  const buttons = (markup: string): string[] => markup.match(/<button[^>]*class="rp-level[^"]*"[^>]*>.*?<\/button>/g) ?? []

  it('has three buttons, Faible, Moyen and Fort, each with what it takes and how much it frees', () => {
    const markup = release()
    const found = buttons(markup)
    expect(found).toHaveLength(3)
    expect(found[0]).toContain(frenchSpaces('<b>Faible</b><span>Cachés depuis 10 min ou plus</span>'))
    expect(found[0]).toContain(frenchSpaces('4 onglets · ≈ 600 Mo'))
    expect(found[1]).toContain('<b>Moyen</b>')
    expect(found[1]).toContain(frenchSpaces('12 onglets · ≈ 2,1 Go'))
    expect(found[2]).toContain('<b>Fort</b><span>Aussi les épinglés et les sites gardés éveillés</span>')
    expect(found[2]).toContain(frenchSpaces('35 onglets · ≈ 4,8 Go'))
    expect(markup).toContain('role="group"')
    expect(markup).toContain('aria-labelledby="rp-release-title"')
  })

  it('says in full what the strongest one costs, on screen and tied to its button, and what is always spared', () => {
    const markup = release()
    expect(markup).toContain(frenchSpaces('<p id="rp-release-warn" class="rp-warn">Dont 20 onglets de sites gardés éveillés : plus de notifications jusqu’à leur réveil.</p>'))
    expect(buttons(markup)[2]).toContain('aria-describedby="rp-release-warn"')
    expect(buttons(markup)[0]).not.toContain('aria-describedby')
    expect(markup).toContain(frenchSpaces('Toujours épargnés : l’onglet affiché, le son'))
    expect(markup).toContain('Ne jamais mettre cet onglet en veille')
    // Without a tab of a kept site, nothing to warn about.
    expect(release({ levels: levels({ high: { siteTabs: 0 } }) })).not.toContain('rp-warn')
    expect(release({ levels: levels({ high: { siteTabs: 1 } }) })).toContain(frenchSpaces('Dont 1 onglet d’un site gardé éveillé : plus de notifications jusqu’à son réveil.'))
  })

  it('names the memory only when some would really go (a process another tab keeps frees nothing)', () => {
    const markup = release({ levels: levels({ low: { count: 1, memoryMb: 0 } }) })
    expect(buttons(markup)[0]).toContain('<span class="rp-level-figures">1 onglet</span>')
  })

  it('greys a strength with nothing to take, and says so for all three when every tab is shown or protected', () => {
    const some = release({ levels: levels({ low: { count: 0, memoryMb: 0 } }) })
    expect(buttons(some)[0]).toMatch(/disabled=""/)
    expect(buttons(some)[0]).toContain('Aucun onglet')
    expect(buttons(some)[1]).not.toMatch(/disabled=""/)
    expect(some).not.toContain('rp-empty')
    const none = release({ levels: levels({ low: { count: 0 }, medium: { count: 0 }, high: { count: 0, siteTabs: 0 } }) })
    expect(buttons(none).every((button) => /disabled=""/.test(button))).toBe(true)
    expect(none).toContain(frenchSpaces('Aucun onglet à mettre en veille : ceux qui restent sont affichés ou protégés.'))
  })

  it('waits for the first figures: three buttons that cannot be pressed yet', () => {
    const markup = release({ levels: null })
    expect(buttons(markup).every((button) => /disabled=""/.test(button) && button.includes('Mesure…'))).toBe(true)
    expect(markup).not.toContain('rp-empty')
  })

  it('is marked busy while a run goes, the buttons stay in the tab order (aria-disabled) and the one that runs is marked', () => {
    const markup = release({ running: { level: 'high' } })
    expect(markup).toContain('aria-busy="true"')
    const found = buttons(markup)
    expect(found.every((button) => button.includes('aria-disabled="true"') && !/ disabled=""/.test(button))).toBe(true)
    expect(found[2]).toContain('rp-level running')
    expect(release()).toContain('aria-busy="false"')
  })

  it('asks for the strength of the button, and ignores a click while another run goes', () => {
    const asked: string[] = []
    const found = elementsOf(createElement(ReleaseLevels, { levels: levels(), running: null, onRelease: (preview) => asked.push(preview.level) })).filter((element) => element.type === 'button')
    ;(found[1]?.props['onClick'] as () => void)()
    ;(found[2]?.props['onClick'] as () => void)()
    expect(asked).toEqual(['medium', 'high'])
    const busy = elementsOf(createElement(ReleaseLevels, { levels: levels(), running: { level: 'low' }, onRelease: (preview) => asked.push(preview.level) })).filter((element) => element.type === 'button')
    ;(busy[1]?.props['onClick'] as () => void)()
    expect(asked).toHaveLength(2)
  })

  it('offers « Annuler » only while the last run can be taken back', () => {
    expect(body({ undoable: true })).toContain('class="rp-undo"')
    expect(body({ undoable: true })).toContain('>Annuler</button>')
    expect(body()).not.toContain('rp-undo')
  })

  it('is written in English too, with the same buttons', () => {
    setLanguage('en')
    const markup = release()
    expect(markup).toContain('<b>Light</b><span>Hidden for 10 min or more</span>')
    expect(markup).toContain('<b>Medium</b>')
    expect(markup).toContain('<b>Strong</b>')
    expect(markup).toContain('12 tabs · ≈ 2.1 GB')
    expect(markup).toContain('Including 20 tabs of kept-awake sites: no notifications until they wake.')
  })
})

describe('the rows under the pointer', () => {
  it('tell the panel when the pointer comes on them and leaves them', () => {
    const said: boolean[] = []
    const list = elementsOf(createElement(ResourcePanelBody, { report: report(), notice: '', onShow: () => undefined, onSleep: () => undefined, onClose: () => undefined, onRelease: () => undefined, onTaskManager: () => undefined, onHold: (held) => said.push(held) })).find((element) => element.props['className'] === 'rp-rows')
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
    expect(await ask({ kind: 'sleep-level', level: 'medium' })).toEqual({ released: { level: 'medium', slept: 3, refused: { unsent: 0, confirm: 0, other: 0 } } })
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
