// The marks of `tabStateBadges` and `downloadStatusChip`, rendered to markup (no window, as templates.test.ts does): the state marks of a tab row,
// the legend of the hover card, the downloads button and its chip, the footer, the sections of the site panel. What each switch does when it is off is checked here with the same inputs.

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DownloadInfo, RuntimeState, TabItem, TabRuntime } from '@shared/model'
import { BUBBLE_MS, bubbleView, chipView, noStatus } from '@shared/download-status'
import { DEFAULT_SECTIONS } from '@shared/site-sections'
import { failedAfter } from '@shared/tab-state'
import { UNREAD_HOLD_MS } from '@shared/tab-messages'
import { defaultTheme } from '@shared/theme'
import { DownloadBubble, DownloadChip, FooterDownloads, PlainDownloadsButton, type FooterDownloadsProps } from './DownloadStatus'
import { HoverCard } from './HoverCard'
import { FaviconIcon } from './components/favicon-icon'
import { Toolbar } from './Toolbar'
import { SidebarUiContext, TabRow, type SidebarUi } from './SidebarRows'
import { SiteSection } from './SitePanel'
import { elementsOf } from './render.test-support'
import { frenchSpaces } from '@shared/french-typography'

// The shell (browser.ts) reaches Electron only when a method runs; the import itself needs the names.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('../main/shell/browser')
const { UnreadWatch } = await import('../main/shell/unread-watch')
const shellMethods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

beforeEach(() => vi.stubGlobal('window', { lucium: {} }))
afterEach(() => vi.unstubAllGlobals())

const noop = (): void => undefined
const html = (node: ReactElement): string => renderToStaticMarkup(node)

const tab: TabItem = { id: 'a', spaceId: 's', url: 'https://notes.local/reunion', title: 'Notes de réunion', pinned: false, createdAt: 1, lastActiveAt: 2 }
const awake: TabRuntime = { loading: false, audible: false, muted: false, awake: true }
const runtimeOf = (info: TabRuntime): RuntimeState => ({ tabs: { a: info }, canGoBack: false, canGoForward: false })

function ui(badges: boolean): SidebarUi {
  return { selected: new Set(), dragging: new Set(), mark: null, developerHosts: [], containers: [], badges, clickRow: noop, menuRow: noop, dragStartRow: noop, dragStartFolder: noop, dragEnd: noop, clearSelection: noop, hoverStart: noop, hoverEnd: noop }
}
const row = (badges: boolean, info: TabRuntime, extra: { active?: boolean } = {}): string =>
  html(createElement(SidebarUiContext.Provider, { value: ui(badges) }, createElement(TabRow, { tab, active: extra.active ?? false, inSplit: false, runtime: runtimeOf(info) })))
const classesOf = (markup: string): string[] => /<div class="([^"]*)"/.exec(markup)![1]!.split(' ')

describe('a tab row, with the state marks on', () => {
  it('draws a ring that is larger while the page loads (a class of the row, and the ring the row always had)', () => {
    const markup = row(true, { ...awake, loading: true })
    expect(classesOf(markup)).toContain('st-loading')
    expect(markup).toContain('<span class="spinner" role="img" aria-label="Chargement">')
  })

  it('dims a sleeping page and adds "zz" (shown on the pointer and the focus by CSS), and names the state in the row', () => {
    const markup = row(true, { ...awake, awake: false })
    expect(classesOf(markup)).toEqual(expect.arrayContaining(['asleep', 'st-asleep']))
    expect(markup).toContain('<span class="tab-zz" aria-hidden="true">zz</span>')
    expect(markup).toContain('aria-label="Notes de réunion, En veille"')
  })

  it('shows a frozen page as frozen, not as asleep: not dimmed, a snowflake, no "zz"', () => {
    const markup = row(true, { ...awake, awake: false, frozen: true })
    expect(classesOf(markup)).toContain('st-frozen')
    expect(classesOf(markup)).not.toContain('asleep')
    expect(markup).toContain('class="tab-frozen"')
    expect(markup).not.toContain('tab-zz')
    expect(markup).toContain('aria-label="Notes de réunion, Gelé"')
  })

  it('makes the snowflake of a frozen page the button « Dégeler l’onglet », with the drop it turns into under the pointer or the focus', () => {
    const markup = row(true, { ...awake, awake: false, frozen: true })
    expect(markup).toMatch(/<button type="button" class="tab-button tab-thaw marked" title="Dégeler l’onglet" aria-label="Dégeler l’onglet"><span class="tab-frozen" aria-hidden="true">.*<\/span><span class="tab-thaw-glyph" aria-hidden="true">/)
    // The cross keeps its place while the button is there, so that nothing moves under the pointer.
    expect(classesOf(markup)).toContain('has-aux')
    expect(row(true, awake)).not.toContain('tab-thaw')
  })

  it('marks a page that did not load with a red dot on its icon, and says so in the name of the row (the colour is not the only signal)', () => {
    const markup = row(true, { ...awake, failed: true })
    expect(classesOf(markup)).toContain('st-error')
    expect(markup).toContain('class="tab-error-dot"')
    expect(markup).toContain('aria-label="Notes de réunion, Erreur"')
  })

  it('gives the sound button its bubble ("Couper le son de l’onglet") in place of the slow native title, and the name of its state once muted', () => {
    const playing = row(true, { ...awake, audible: true })
    expect(playing).toMatch(/class="tab-button tab-sound"[^>]*data-label="Couper le son de l’onglet"/)
    expect(playing).not.toMatch(/class="tab-button tab-sound"[^>]*title=/)
    expect(row(true, { ...awake, muted: true })).toContain('data-label="Réactiver le son de l’onglet"')
  })

  it('names the sound button by what it does, with its pressed state: a state alone ("Son coupé") does not say that a press brings the sound back', () => {
    expect(row(true, { ...awake, audible: true })).toMatch(/class="tab-button tab-sound"[^>]*aria-label="Couper le son de l’onglet" aria-pressed="false"/)
    expect(row(true, { ...awake, muted: true })).toMatch(/class="tab-button tab-sound"[^>]*aria-label="Couper le son de l’onglet" aria-pressed="true"/)
  })

  it('does not dim the page on screen (as before) and draws nothing for a tab with nothing to tell', () => {
    expect(classesOf(row(true, { ...awake, awake: false }, { active: true }))).not.toContain('asleep')
    const quiet = row(true, awake)
    expect(quiet).not.toMatch(/st-|tab-zz|tab-frozen|tab-error-dot|data-label/)
  })
})

describe('« Dégeler l’onglet » on the row of a frozen tab', () => {
  it('is there with the state marks off too, as a button that shows under the pointer or the focus like the cross, and nothing marks the row at rest', () => {
    const markup = row(false, { ...awake, awake: false, frozen: true })
    expect(markup).toContain('class="tab-button tab-thaw hover-only" title="Dégeler l’onglet" aria-label="Dégeler l’onglet"')
    expect(markup).not.toContain('tab-frozen')
    expect(classesOf(markup)).toContain('has-aux')
  })

  it('asks the main process to thaw that tab, and the click goes no further than the button (the row is not selected)', () => {
    const thawTab = vi.fn()
    vi.stubGlobal('window', { lucium: { thawTab } })
    for (const badges of [true, false]) {
      thawTab.mockClear()
      const elements = elementsOf(createElement(TabRow, { tab, active: false, inSplit: false, runtime: runtimeOf({ ...awake, awake: false, frozen: true }) }), undefined, (probe) => createElement(SidebarUiContext.Provider, { value: ui(badges) }, probe))
      const button = elements.find((element) => String(element.props['className']).includes('tab-thaw'))!
      const stopPropagation = vi.fn()
      ;(button.props['onClick'] as (event: { stopPropagation(): void }) => void)({ stopPropagation })
      expect(thawTab, String(badges)).toHaveBeenCalledExactlyOnceWith('a')
      expect(stopPropagation).toHaveBeenCalled()
    }
  })
})

// The shell cannot be built without Electron: the events of a page are replayed with the function it calls, up to the row on screen.
describe('the failed and frozen marks, from the events of the page to the row', () => {
  it('shows a failed load from the end of that load to the start of the next one, and an update that says nothing of loading changes nothing', () => {
    let failed = false
    const updates: Array<[loading: boolean | undefined, showsError: boolean]> = [[true, false], [false, true], [undefined, true], [true, true], [false, false]]
    const marks = updates.map(([loading, showsError]) => {
      failed = failedAfter(failed, loading, loading === false && showsError)
      return row(true, { ...awake, ...(failed ? { failed: true as const } : {}) }).includes('class="tab-error-dot"')
    })
    expect(marks).toEqual([false, true, true, false, false])
  })
})

// The real methods of the shell that write the marks run on a stand-in for the window: what they need is given, the rest answers nothing.
describe('the marks, as the shell writes them where the row reads them', () => {
  /** Anything a method reaches that the test does not care for: callable, with any property, and answering nothing. */
  const nothing: unknown = new Proxy(() => undefined, { get: (_target, key) => (key === 'then' ? undefined : nothing) })
  const REAL = new Set(['onPageUpdate', 'handlePageUpdate', 'readTitleUnread', 'markIcon', 'showIcon', 'setAwake', 'thawPage', 'freezePage'])

  /** A window with the tab `a` in the background, its page showing an error page when `error.on` says so. */
  function shell(badges = true) {
    const error = { on: false }
    const page = { showsError: () => error.on, freeze: async () => true, thaw: async () => undefined }
    const state = { settings: { tabStateBadges: badges, siteUnreadOff: [] as string[] }, tabs: [{ ...tab }] }
    const target: Record<string, unknown> = {
      runtime: { tabs: { a: { ...awake } }, canGoBack: false, canGoForward: false },
      store: { get: () => state, dispatch: () => undefined },
      pages: new Map([['a', page]]),
      frozen: new Set<string>(),
      committed: new Set<string>(),
      iconBase: new Map<string, string>(),
      // The unread memory of the window, with nobody looking at the tab.
      unread: new UnreadWatch({ now: () => Date.now(), attended: () => false, changed: () => undefined }),
      shownTabId: 'b'
    }
    const self = new Proxy(target, { get: (t, key) => (key in t ? t[key as string] : typeof key === 'string' && REAL.has(key) ? shellMethods[key] : nothing) })
    const update = (patch: Record<string, unknown>) => shellMethods['onPageUpdate']!.call(self, 'a', patch)
    const marks = () => (target['runtime'] as RuntimeState).tabs['a']!
    return { self, error, page, update, marks }
  }

  it('marks a load that ended on an error page as failed until the next load, and an update that says nothing of loading keeps it', () => {
    const window = shell()
    window.error.on = true
    window.update({ loading: false })
    expect(window.marks().failed).toBe(true)
    window.update({ title: 'Autre titre' })
    expect(window.marks().failed).toBe(true)
    window.update({ loading: true })
    expect(window.marks().failed).toBeUndefined()
    window.error.on = false
    window.update({ loading: false })
    expect(window.marks().failed).toBeUndefined()
  })

  it('marks a frozen page as frozen and asleep, and clears the mark when it runs again', async () => {
    const window = shell()
    expect(await shellMethods['freezePage']!.call(window.self, 'a', window.page)).toBe(true)
    expect(window.marks()).toMatchObject({ awake: false, frozen: true })
    await shellMethods['thawPage']!.call(window.self, 'a')
    expect(window.marks().awake).toBe(true)
    expect(window.marks().frozen).toBeUndefined()
  })

  it('marks the icon a background page changed, only with the switch on, and clears the mark where the tab is shown', () => {
    const on = shell(true)
    on.update({ faviconUrl: 'https://notes.local/a.png' })
    on.update({ faviconUrl: 'https://notes.local/b.png' })
    expect(on.marks().changedIcon).toBe(true)
    shellMethods['showIcon']!.call(on.self, 'a', 'https://notes.local/b.png')
    expect(on.marks().changedIcon).toBeUndefined()
    const off = shell(false)
    off.update({ faviconUrl: 'https://notes.local/a.png' })
    off.update({ faviconUrl: 'https://notes.local/b.png' })
    expect(off.marks().changedIcon).toBeUndefined()
  })

  it('reads the unread count from the title the page sent, holds it through a title that says no count, and clears it once that title has stayed silent', () => {
    vi.useFakeTimers()
    try {
      const window = shell()
      window.update({ title: '(3) Slack' })
      expect(window.marks().unread).toBe(3)
      window.update({ loading: false })
      expect(window.marks().unread).toBe(3)
      window.update({ title: 'Slack' })
      expect(window.marks().unread).toBe(3)
      vi.advanceTimersByTime(UNREAD_HOLD_MS - 1)
      expect(window.marks().unread).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a tab row, with the state marks off', () => {
  const busy: TabRuntime = { loading: true, audible: true, muted: false, awake: false, failed: true }

  it('is the row it was: no class, no mark, no label, the same native title on the sound button', () => {
    const markup = row(false, busy)
    expect(classesOf(markup).filter((name) => name.startsWith('st-'))).toEqual([])
    expect(markup).not.toMatch(/tab-zz|tab-frozen|tab-error-dot|data-label/)
    expect(markup).toContain('aria-label="Notes de réunion"')
    expect(markup).toMatch(/class="tab-button tab-sound"[^>]*title="Couper le son de l’onglet"/)
    // A sleeping page is dimmed whatever the switch says (it always was), and a frozen one, which it never told apart, too.
    expect(classesOf(markup)).toContain('asleep')
    expect(classesOf(row(false, { ...awake, awake: false, frozen: true }))).toContain('asleep')
  })
})

// The count of unread messages is read from the title the page sent (the shell writes it in the runtime entry), so a pinned tab, whose title is tidied
// and keeps no count, still shows its badge.
// The dot of a row whose page icon moved while the tab was in the background (shared/icon-mark.ts): drawn with the switch on, only when marked.
describe('the icon dot of a row', () => {
  it('draws a dot, named for a screen reader, when the icon of the page changed in the background', () => {
    const markup = row(true, { ...awake, changedIcon: true })
    expect(markup).toContain('<span class="tab-icon-dot" role="img" title="Icône changée depuis la dernière ouverture" aria-label="Icône changée depuis la dernière ouverture"></span>')
  })

  it('draws no dot for a row that is not marked, nor with the switch off', () => {
    expect(row(true, awake)).not.toContain('tab-icon-dot')
    expect(row(false, { ...awake, changedIcon: true })).not.toContain('tab-icon-dot')
  })
})

describe('the globe that stands for a missing icon', () => {
  // It was an image named « Icône de globe »: a screen reader said it before the title of the page, in every button that draws it without a name of its own.
  it('is hidden from a screen reader, like the other glyphs of a row', () => {
    const markup = html(createElement(FaviconIcon, { className: 'favicon' }))
    expect(markup).toMatch(/^<svg [^>]*aria-hidden="true"/)
    expect(markup).not.toMatch(/role="img"|aria-label/)
  })
})

describe('the unread badge of a row', () => {
  const pinnedSlack: TabItem = { ...tab, pinned: true, url: 'https://app.slack.com/client/T1', title: 'Slack' }
  const badgeOf = (info: TabRuntime): string =>
    html(createElement(SidebarUiContext.Provider, { value: ui(false) }, createElement(TabRow, { tab: pinnedSlack, active: false, inSplit: false, runtime: runtimeOf(info) })))

  it('shows the count the page sent, on a pinned tab whose tidied title has none', () => {
    expect(badgeOf({ ...awake, unread: 3 })).toMatch(/<span class="tab-message-badge"[^>]*>3<\/span>/)
  })

  it('shows the mark of a site that says it without a number: ! for a mention or a direct message, a dot for any unread message', () => {
    expect(badgeOf({ ...awake, unreadMark: '!' })).toMatch(/<span class="tab-message-badge"[^>]*>!<\/span>/)
    expect(badgeOf({ ...awake, unreadMark: '*' })).toMatch(/<span class="tab-message-badge"[^>]*>•<\/span>/)
    expect(badgeOf({ ...awake, unreadMark: '!' })).toContain('aria-label="Messages non lus"')
  })

  // An `aria-label` on a span with no role is not read: the marks are images, and the count is said in the singular or the plural.
  it('names the badge for a screen reader: an image, « 1 message non lu » and « 12 messages non lus »', () => {
    expect(badgeOf({ ...awake, unread: 1 })).toContain(`<span class="tab-message-badge" role="img" title="Messages non lus" aria-label="1 message non lu">`)
    expect(badgeOf({ ...awake, unread: 12 })).toContain(`<span class="tab-message-badge" role="img" title="Messages non lus" aria-label="12 messages non lus">`)
    expect(badgeOf({ ...awake, unreadMark: '*' })).toContain(`<span class="tab-message-badge" role="img" title="Messages non lus" aria-label="Messages non lus">`)
  })

  it('shows the count rather than the mark when the page has both', () => {
    const markup = badgeOf({ ...awake, unread: 3, unreadMark: '!' })
    expect(markup).toMatch(/<span class="tab-message-badge"[^>]*>3<\/span>/)
    expect(markup.match(/tab-message-badge/g)).toHaveLength(1)
  })

  it('shows nothing for a title that said no count, even when the tab title says one (the row does not read the tab title)', () => {
    expect(row(true, awake)).not.toContain('tab-message-badge')
    const withCountInTitle = html(createElement(SidebarUiContext.Provider, { value: ui(false) }, createElement(TabRow, { tab: { ...tab, title: '(3) Slack' }, active: false, inSplit: false, runtime: runtimeOf(awake) })))
    expect(withCountInTitle).not.toContain('tab-message-badge')
  })
})

describe('the bar above the page', () => {
  const bar = (badges: boolean, info: TabRuntime): string =>
    html(createElement(Toolbar, { space: { id: 's', name: 'Travail', emoji: '💼', theme: defaultTheme(), profileId: 'default' } as never, current: tab, runtime: runtimeOf(info), sidebarVisible: true, fullUrl: false, draggable: false, canSplit: true, badges }))

  it('draws a line of loading under it while the page loads, with the marks on', () => {
    expect(bar(true, { ...awake, loading: true })).toContain('<div class="tb-progress" role="progressbar" aria-label="Chargement"></div>')
  })

  it('draws nothing for it with the marks off, or while the page is not loading', () => {
    expect(bar(false, { ...awake, loading: true })).not.toContain('tb-progress')
    expect(bar(true, awake)).not.toContain('tb-progress')
  })
})

describe('the hover card', () => {
  const anchor = { tabId: 'a', top: 100, bottom: 136, x: 50 }
  const card = (badges: boolean, info: TabRuntime, resources = false): string => html(createElement(HoverCard, { tab, anchor, runtime: info, sidebarWidth: 323, preview: true, resources, badges }))

  it('carries the legend of the five marks and a line for a failed load when the marks are on', () => {
    const markup = card(true, { ...awake, failed: true })
    expect(markup).toContain('class="hover-card-legend"')
    for (const label of ['Chargement', 'En veille', 'Gelé', 'Son', 'Erreur']) expect(markup).toContain(label)
    expect(markup).toContain('<div class="hover-card-note error">Chargement impossible</div>')
  })

  it('says "mémoire libérée" for a sleeping page instead of dashes, and "Gelé" in the status of a frozen one', () => {
    expect(card(true, { ...awake, awake: false }, true)).toContain('Mémoire libérée')
    expect(card(true, { ...awake, awake: false }, true)).not.toContain('Mémoire —')
    expect(card(true, { ...awake, awake: false, frozen: true })).toContain('<div class="hover-card-status">Gelé</div>')
  })

  it('is a group named by the title of the tab, not a tooltip: a tooltip holds no control, and the card has its buttons', () => {
    const markup = html(createElement(HoverCard, { tab, anchor, runtime: awake, sidebarWidth: 323, preview: true, resources: false, badges: true, onAction: () => undefined }))
    expect(markup).not.toContain('role="tooltip"')
    const named = /^<div class="hover-card[^"]*" role="group" aria-labelledby="([^"]+)"/.exec(markup)?.[1]
    expect(named).toBeTruthy()
    expect(markup).toContain(`<div id="${named}" class="hover-card-title">`)
    expect(markup).toMatch(/<button type="button">Fermer l’onglet<\/button>/)
    // The legend is named too: a name on an element without a role is not read.
    expect(markup).toContain('<div class="hover-card-legend" role="group" aria-label="Légende des états">')
  })

  it('is the card it was with the marks off: no legend, no note, "En veille" for a frozen page too, dashes for a sleeping one', () => {
    const off = card(false, { ...awake, awake: false, frozen: true, failed: true }, true)
    expect(off).not.toMatch(/hover-card-legend|hover-card-note/)
    expect(off).toContain('<div class="hover-card-status">En veille</div>')
    expect(off).not.toContain('Mémoire libérée')
  })
})

describe('the downloads button of the footer', () => {
  const running = (patch: Partial<DownloadInfo> = {}): DownloadInfo => ({ id: 'd1', filename: 'rapport-octobre.pdf', url: 'https://example.org/r.pdf', path: '/tmp/r.pdf', state: 'progressing', receivedBytes: 620, totalBytes: 1000, startedAt: 10, ...patch })
  const props = (patch: Partial<FooterDownloadsProps> = {}): FooterDownloadsProps => ({ enabled: true, downloads: [running()], buttons: { pause: false, resumeRecorded: false }, onOpenPanel: noop, onAction: noop, ...patch })

  it('is the plain button with its count while the switch is off, and mounts nothing of the status (the component is not even returned)', () => {
    const element = FooterDownloads(props({ enabled: false })) as ReactElement
    expect(element.type).toBe(PlainDownloadsButton)
    const markup = html(element)
    expect(markup).toContain('class="footer-side footer-downloads"')
    expect(markup).toContain('<span class="footer-count">1</span>')
    expect(markup).toContain('aria-label="Téléchargements"')
    expect(markup).not.toMatch(/dlc|dl-bubble|st-live/)
    expect(html(createElement(FooterDownloads, props({ enabled: false, downloads: [] })))).not.toContain('footer-count')
  })

  it('is the chip with the switch on: a ring at 62 %, the count, the file in its name, and a live region', () => {
    const markup = html(createElement(FooterDownloads, props()))
    expect(markup).toContain('dlc-group progress')
    expect(markup).toContain('style="--p:62"')
    expect(markup).toContain(frenchSpaces('aria-label="rapport-octobre.pdf · 62 %"'))
    expect(markup).toContain('<span class="dlc-n">1</span>')
    expect(markup).toMatch(/<span class="st-live" role="status" aria-live="polite">rapport-octobre\.pdf · 50\u00a0%<\/span>/)
  })

  it('keeps the name the button always had at rest, with the shortcut in the bubble', () => {
    const markup = html(createElement(DownloadChip, { view: chipView([], noStatus()), panelLabel: 'Téléchargements · ⌥⌘L', onOpenPanel: noop, onCancel: noop }))
    expect(markup).toContain('aria-label="Téléchargements"')
    expect(markup).toContain('data-tip="Téléchargements · ⌥⌘L"')
    expect(markup).not.toContain('dlc-cancel')
    // Without the shortcut (a command left without one), the name alone.
    expect(html(createElement(DownloadChip, { view: chipView([], noStatus()), onOpenPanel: noop, onCancel: noop }))).toContain('data-tip="Téléchargements"')
  })

  it('says the shortcut that opens the panel as the footer hands it, with the switch on or off', () => {
    const label = 'Téléchargements · ⌥⌘L'
    expect(html(createElement(FooterDownloads, props({ enabled: false, downloads: [], panelLabel: label })))).toContain(`data-tip="${label}"`)
    expect(html(createElement(FooterDownloads, props({ enabled: true, downloads: [], panelLabel: label })))).toContain(`data-tip="${label}"`)
  })

  it('cancels with a button of its own, never by the click that opens the panel', () => {
    const markup = html(createElement(DownloadChip, { view: chipView([running()], noStatus()), onOpenPanel: noop, onCancel: noop }))
    expect(markup).toMatch(/<button type="button" class="dlc-cancel" aria-label="Annuler le téléchargement de rapport-octobre\.pdf">/)
    expect(markup.match(/<button/g)).toHaveLength(2)
  })

  it('turns the ring when the size is not known, and takes the colours of the end and of the failure', () => {
    expect(html(createElement(DownloadChip, { view: chipView([running({ totalBytes: 0 })], noStatus()), onOpenPanel: noop, onCancel: noop }))).toContain('dlc-arc progress unknown')
    const done = html(createElement(DownloadChip, { view: chipView([running({ state: 'completed' })], { seen: {}, bubble: { kind: 'done', id: 'd1', until: 1 } }), onOpenPanel: noop, onCancel: noop }))
    expect(done).toContain('dlc-arc done')
    const failed = html(createElement(DownloadChip, { view: chipView([running({ state: 'interrupted' })], { seen: {}, bubble: { kind: 'fail', id: 'd1', until: null } }), onOpenPanel: noop, onCancel: noop }))
    expect(failed).toContain('dlc-arc fail')
  })
})

describe('the bubble of a download', () => {
  const finished = (state: DownloadInfo['state']): DownloadInfo => ({ id: 'd1', filename: 'rapport-octobre.pdf', url: 'https://example.org/r.pdf', path: '/tmp/r.pdf', state, receivedBytes: 2_516_582, totalBytes: 2_516_582, startedAt: 10 })
  const bubble = (kind: 'done' | 'fail' | 'cancel', state: DownloadInfo['state'], canResume = false): string => {
    const view = bubbleView({ kind, id: 'd1', until: kind === 'fail' ? null : BUBBLE_MS }, finished(state))
    return html(createElement(DownloadBubble, { view, canResume, onOpen: noop, onReveal: noop, onResume: noop, onClose: noop, onHold: noop, onRelease: noop }))
  }

  it('offers "Ouvrir" and "Afficher dans le Finder" at the end of a file, announces itself politely and shows the bar of its 6 s', () => {
    const markup = bubble('done', 'completed')
    expect(markup).toContain('role="status"')
    expect(markup).toContain(frenchSpaces('Téléchargement terminé · 2,4 Mo'))
    expect(markup).toMatch(/>Ouvrir<\/button>/)
    expect(markup).toMatch(/>Afficher dans le Finder<\/button>/)
    expect(markup).toContain('class="dl-timer"')
  })

  it('offers "Reprendre / Ignorer" for a failure that can resume, only "Ignorer" for one that cannot, announces it as an alert and has no timer', () => {
    const resumable = bubble('fail', 'interrupted', true)
    expect(resumable).toContain('role="alert"')
    expect(resumable).toMatch(/Reprendre<\/button>/)
    expect(resumable).toMatch(/>Ignorer<\/button>/)
    expect(resumable).not.toContain('dl-timer')
    const stuck = bubble('fail', 'interrupted', false)
    expect(stuck).not.toContain('Reprendre')
    expect(stuck).toMatch(/>Ignorer<\/button>/)
  })

  it('says only that the download was cancelled, with the cross to close it (a cancelled download cannot be resumed)', () => {
    const markup = bubble('cancel', 'cancelled')
    expect(markup).toContain('Téléchargement annulé')
    expect(markup).not.toMatch(/Reprendre|Ouvrir/)
    expect(markup).toContain('aria-label="Fermer (Échap)"')
  })

  it('names every button', () => {
    for (const markup of [bubble('done', 'completed'), bubble('fail', 'interrupted', true), bubble('cancel', 'cancelled')]) {
      const unnamed = [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter(([, attrs, inner]) => !/aria-label="[^"]+"/.test(attrs!) && inner!.replace(/<[^>]*>/g, '').trim() === '')
      expect(unnamed).toEqual([])
    }
  })
})

describe('a section of the site panel', () => {
  const section = (open: boolean, summary: { text: string; tone?: 'ok' | 'warn' } | null): string => html(createElement(SiteSection, { id: 'permissions', open, summary, onToggle: noop }, createElement('p', null, 'contenu')))

  it('is a title that says what is inside; folded, it mounts nothing of its content', () => {
    const folded = section(false, { text: '1 autorisée · 1 refusée' })
    expect(folded).toContain('aria-expanded="false"')
    expect(folded).toContain('Autorisations')
    expect(folded).toContain('1 autorisée · 1 refusée')
    expect(folded).not.toContain('contenu')
    expect(folded).not.toContain('aria-controls')
  })

  it('shows its content as a named group when open, and the title controls it', () => {
    const open = section(true, null)
    expect(open).toContain('aria-expanded="true"')
    expect(open).toContain('<p>contenu</p>')
    expect(open).toMatch(/aria-controls="scc-section-permissions"/)
    expect(open).toMatch(/id="scc-section-permissions" class="scc-section-body" role="group" aria-label="Autorisations"/)
    expect(open).not.toContain('scc-section-sum')
  })

  it('keeps the blocker open and the rest folded by default', () => {
    expect(DEFAULT_SECTIONS.blocking).toBe(true)
    expect(Object.values(DEFAULT_SECTIONS).filter(Boolean)).toHaveLength(1)
  })
})
