// The command bar: the layer of the panels (overlay.html) that ⌘T and ⌘L open over the page. The keys are typed in its field the way the
// keyboard does, and the effect is read in the state (the tabs) and in what the local server receives. The suggestions of the search engine
// are switched off first: what is typed must not leave the machine. The searches go to a template of the local server.

import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchLucium, TEST_DOMAIN, type Running } from './launch'
import {
  activeTabId,
  barRows,
  chooseBarRow,
  chooseMenuEntry,
  dismissWelcome,
  dispatch,
  menuEntryState,
  openCommandBar,
  OPEN_TABS_GROUP,
  openTab,
  overlayShown,
  requestPanel,
  pathsReceived,
  serveSite,
  setSettings,
  snapshotOf,
  tabAt,
  titledPage,
  typeInBar,
  waitForPanel,
  waitForState,
  expectStays,
  type LocalSite
} from './helpers'

let site: LocalSite
/** The search of a site: the settings take only https:// addresses there, so it is a server of the tests in https, reached by a test host name. */
let secure: LocalSite
let running: Running

test.beforeAll(async () => {
  site = await serveSite({ '/a': titledPage('Page A'), '/b': titledPage('Page B'), '/engine': titledPage('Moteur local') })
  secure = await serveSite({ '/search': titledPage('Recherche locale') }, { secure: true })
})

test.afterAll(async () => {
  await site.close()
  await secure.close()
})

/** Adds a site search of the user: the keyword `loc` and the search page of the https server (the defaults stay after it, as the store merges them). */
async function addLocalSearch(): Promise<void> {
  await dispatch(running.page, { type: 'settings/update', patch: { siteSearches: [{ keyword: 'loc', name: 'Site local', url: `https://search.${TEST_DOMAIN}:${secure.port}/search?q=%s` }] } })
  await waitForState(running.page, (s) => (s.state.settings['siteSearches'] as Array<{ keyword: string }>).some((search) => search.keyword === 'loc'), 'the site search "loc"')
}

/** Starts the application with its search kept on the machine: no suggestion asked of an engine, searches sent to the local server. */
async function start(extensions: string[] = []): Promise<void> {
  site.requests.length = 0
  secure.requests.length = 0
  // The certificate of the https server is the tests' own: Chromium is told to accept it.
  running = await launchLucium({ extensions, args: ['--ignore-certificate-errors'] })
  await dismissWelcome(running.app, running.page)
  await setSettings(running.page, { searchSuggestions: false, searchUrlTemplate: `${site.origin}/engine?q=%s` })
}

test.afterEach(async () => {
  await running?.close()
})

const url = (path: string) => `${site.origin}${path}`

test.describe('opening and typing', () => {
  test.beforeEach(() => start())

  test('⌘T opens the bar for a new tab: an address and Enter open it in a new tab, and the bar closes', async () => {
    const first = await openTab(running, url('/a'), 'Page A')
    const overlay = await openCommandBar(running.app, 'CmdOrCtrl+T')
    await typeInBar(overlay, url('/b'))
    await overlay.keyboard.press('Enter')
    const state = await waitForState(running.page, (s) => tabAt(s, url('/b'))?.title === 'Page B', 'page B in a tab')
    expect(state.state.tabs.filter((tab) => tab.url === url('/a')).map((tab) => tab.id)).toEqual([first.id])
    expect(await activeTabId(running.page)).toBe(tabAt(state, url('/b'))!.id)
    await expect.poll(() => overlayShown(running.app)).toBe(false)
  })

  test('⌘L opens the bar on the tab on screen, with its address: Enter loads the new address in that same tab', async () => {
    const first = await openTab(running, url('/a'), 'Page A')
    const count = (await snapshotOf(running.page)).state.tabs.length
    const overlay = await openCommandBar(running.app, 'CmdOrCtrl+L')
    const field = overlay.locator('.palette-input')
    await expect(field).toHaveValue(url('/a'))
    await field.fill(url('/b'))
    await overlay.keyboard.press('Enter')
    const state = await waitForState(running.page, (s) => s.state.tabs.find((tab) => tab.id === first.id)?.url === url('/b'), 'the same tab on page B')
    expect(state.state.tabs.length).toBe(count)
  })

  test('Escape closes the bar without opening anything', async () => {
    await openTab(running, url('/a'), 'Page A')
    const count = (await snapshotOf(running.page)).state.tabs.length
    const overlay = await openCommandBar(running.app, 'CmdOrCtrl+T')
    await typeInBar(overlay, url('/b'))
    await overlay.keyboard.press('Escape')
    await expect.poll(() => overlayShown(running.app)).toBe(false)
    const opened = async () => ({ tabs: (await snapshotOf(running.page)).state.tabs.length, asked: pathsReceived(site, '/b') })
    await expectStays(opened, { tabs: count, asked: [] }, 'Escape opens no tab and asks for no page', 500)
  })

  test('the bar finds an open tab by its title, and Enter goes to that tab instead of opening a new one', async () => {
    const pageA = await openTab(running, url('/a'), 'Page A')
    await openTab(running, url('/b'), 'Page B')
    const count = (await snapshotOf(running.page)).state.tabs.length
    const overlay = await openCommandBar(running.app, 'CmdOrCtrl+T')
    await typeInBar(overlay, 'Page A')
    await chooseBarRow(overlay, (row) => row.label === 'Page A' && OPEN_TABS_GROUP.test(row.group))
    await expect.poll(() => activeTabId(running.page)).toBe(pageA.id)
    expect((await snapshotOf(running.page)).state.tabs.length).toBe(count)
  })

  test('a site keyword: "loc" and the words open the search of that site with the words', async () => {
    await addLocalSearch()
    const overlay = await openCommandBar(running.app, 'CmdOrCtrl+T')
    // The keyword and its space become the pill of the site; the words stay in the field.
    await typeInBar(overlay, 'loc bonjour', 'bonjour')
    await expect(overlay.locator('.scope-pill')).toContainText('Site local')
    await overlay.keyboard.press('Enter')
    await expect.poll(() => pathsReceived(secure, '/search')).toContain('/search?q=bonjour')
    expect(pathsReceived(site, '/engine')).toEqual([])
  })
})

test.describe('functions of the bar', () => {
  test.beforeEach(() => start())

  // A keyword of the user's own answers with a "!" in front whether bangs are on or not (scopeSiteFor): what the function adds is the "!" after
  // the words ("salut !loc"), and the keywords of the fixed list (which are sites of the Internet, not tested here).
  test('search-bangs: "salut !loc" searches the site of the keyword while on; off, the same text goes to the search engine as it is', async () => {
    await addLocalSearch()
    await setSettings(running.page, { searchBangs: true })
    let overlay = await openCommandBar(running.app, 'CmdOrCtrl+T')
    await typeInBar(overlay, 'salut !loc')
    await overlay.keyboard.press('Enter')
    await expect.poll(() => pathsReceived(secure, '/search')).toContain('/search?q=salut')
    expect(pathsReceived(site, '/engine')).toEqual([])

    // Control: the function off, "salut !loc" is only words for the search engine.
    await setSettings(running.page, { searchBangs: false })
    overlay = await openCommandBar(running.app, 'CmdOrCtrl+T')
    await typeInBar(overlay, 'salut !loc')
    await overlay.keyboard.press('Enter')
    await expect.poll(() => pathsReceived(site, '/engine')).toContain(`/engine?q=${encodeURIComponent('salut !loc')}`)
    expect(pathsReceived(secure, '/search')).toEqual(['/search?q=salut'])
  })

  test('command-bar-calc: a calculation gives its answer as the first line while on; off, no answer is offered', async () => {
    await setSettings(running.page, { commandBarCalc: true })
    let overlay = await openCommandBar(running.app, 'CmdOrCtrl+T')
    await typeInBar(overlay, '6*7')
    await expect.poll(async () => (await barRows(overlay))[0]?.label).toBe('= 42')
    await overlay.keyboard.press('Escape')
    await expect.poll(() => overlayShown(running.app)).toBe(false)

    await setSettings(running.page, { commandBarCalc: false })
    overlay = await openCommandBar(running.app, 'CmdOrCtrl+T')
    await typeInBar(overlay, '6*7')
    await expect.poll(async () => (await barRows(overlay)).length).toBeGreaterThan(0)
    expect((await barRows(overlay)).some((row) => row.label.startsWith('='))).toBe(false)
  })

  test('tab-search: ⇧⌘A opens the tab search, which lists the open tabs; off, nothing opens, by the menu or by a request', async () => {
    await openTab(running, url('/a'), 'Page A')
    await openTab(running, url('/b'), 'Page B')
    await setSettings(running.page, { tabSearch: true })
    await expect.poll(() => menuEntryState(running.app, 'CmdOrCtrl+Shift+A')).toBe('enabled')
    await chooseMenuEntry(running.app, 'CmdOrCtrl+Shift+A')
    const overlay = await waitForPanel(running.app, '.palette.cb-tabs .palette-input')
    await expect(overlay.locator('.palette.cb-tabs')).toContainText('Page A')
    await overlay.keyboard.press('Escape')
    await expect.poll(() => overlayShown(running.app)).toBe(false)

    await setSettings(running.page, { tabSearch: false })
    // The menu is rebuilt when this setting changes (`tabSearch` of menuKey, src/shared/menu-state.ts): its entry can no longer be chosen. Asked for
    // by the interface anyway (a stale shortcut), the main process opens nothing either.
    await expect.poll(() => menuEntryState(running.app, 'CmdOrCtrl+Shift+A'), { message: 'the entry of the tab search can no longer be chosen' }).not.toBe('enabled')
    await requestPanel(running.page, { panel: 'commandbar', mode: 'tabs', initial: '' })
    await expectStays(() => overlayShown(running.app), false, 'the tab search does not open while the function is off', 800)
  })

  test('shortcut-help: ⌘/ opens the sheet of the shortcuts; off, nothing opens, by the menu or by a request', async () => {
    await setSettings(running.page, { shortcutHelp: true })
    await expect.poll(() => menuEntryState(running.app, 'CmdOrCtrl+/')).toBe('enabled')
    await chooseMenuEntry(running.app, 'CmdOrCtrl+/')
    const overlay = await waitForPanel(running.app, '.sk.tk-panel')
    await overlay.keyboard.press('Escape')
    await expect.poll(() => overlayShown(running.app)).toBe(false)

    await setSettings(running.page, { shortcutHelp: false })
    // As for tab-search: the menu is rebuilt (`shortcutHelp` of menuKey), and a request of the interface opens nothing.
    await expect.poll(() => menuEntryState(running.app, 'CmdOrCtrl+/'), { message: 'the entry of the shortcuts can no longer be chosen' }).not.toBe('enabled')
    await requestPanel(running.page, { panel: 'shortcuts' })
    await expectStays(() => overlayShown(running.app), false, 'the sheet of the shortcuts does not open while the function is off', 800)
  })
})

test.describe('omnibox-keywords: the keyword of an extension hands it the words typed after it', () => {
  const probe = resolve(__dirname, '../../compat/keyext-probe')
  test.beforeEach(() => start([probe]))

  type ProbeEntry = { event: string; text?: string }

  /**
   * A reader of what the probe extension was told by the bar: the extension keeps a log that a page of 127.0.0.1 may read (externally_connectable),
   * and each read empties it, so the entries are gathered here.
   */
  async function probeReader(): Promise<() => Promise<ProbeEntry[]>> {
    const id = await running.app.evaluate(({ session }) => {
      const profile = session.fromPartition('persist:profile-default') as unknown as { extensions?: { getAllExtensions(): Array<{ id: string; name: string }> }; getAllExtensions?: () => Array<{ id: string; name: string }> }
      const all = profile.extensions?.getAllExtensions() ?? profile.getAllExtensions?.() ?? []
      return all.find((extension) => extension.name === 'Keyext Probe')?.id ?? ''
    })
    expect(id, 'the Keyext Probe is loaded').not.toBe('')
    const reader = await openTab(running, url('/a'), 'Page A')
    const seen: ProbeEntry[] = []
    return async () => {
      const fresh = await reader.page.evaluate(
        (extension) =>
          new Promise<ProbeEntry[]>((done) => {
            const runtime = (globalThis as unknown as { chrome: { runtime: { sendMessage(id: string, message: unknown, reply: (answer: unknown) => void): void } } }).chrome.runtime
            runtime.sendMessage(extension, { type: 'log' }, (answer) => done((answer ?? []) as ProbeEntry[]))
          }),
        id
      )
      seen.push(...fresh)
      return seen
    }
  }

  test('on: "kxp bonjour" and Enter give "bonjour" to the extension; off, the same words are a web search and the extension hears nothing', async () => {
    const log = await probeReader()
    const entered = async () => (await log()).filter((entry) => entry.event === 'entered').map((entry) => entry.text)
    // Control first: off (the default), the words go to the search engine.
    await setSettings(running.page, { omniboxKeywords: false })
    let overlay = await openCommandBar(running.app, 'CmdOrCtrl+T')
    await typeInBar(overlay, 'kxp bonjour')
    await overlay.keyboard.press('Enter')
    await expect.poll(() => pathsReceived(site, '/engine')).toContain(`/engine?q=${encodeURIComponent('kxp bonjour')}`)
    expect(await entered()).toEqual([])

    await setSettings(running.page, { omniboxKeywords: true })
    overlay = await openCommandBar(running.app, 'CmdOrCtrl+T')
    await typeInBar(overlay, 'kxp bonjour')
    await overlay.keyboard.press('Enter')
    await expect.poll(entered, { timeout: 15_000 }).toEqual(['bonjour'])
  })
})
