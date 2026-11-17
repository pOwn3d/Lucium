// Engine checks for the parity of "Effacer les données du site" with the Clear Domain Data extension it comes from: several sites at
// once, the sites erased before, the optional confirmation, the notices after a run nobody watched, one result per site.
// Run in a real Electron (LUCIUM_SMOKE_ONLY=cleardata2 for a quick loop, or after the data checks of the full suite). A local server
// hands out pages that fill every kind of storage; hosts that are different origins of this one machine play different sites:
// 127.0.0.1 (A), localhost (B) and p.localhost (P, the site that must never be touched when it is not named).

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Menu, type MenuItem } from 'electron'
import { defaultSettings } from '@shared/model'
import { SITE_DATA_HOSTS_MAX, SITE_DATA_RECENTS_MAX, SITE_DATA_TYPES } from '@shared/site-data'
import type { SmokeContext } from './smoke'
import { PROBE_PAGE, SITE_PAGE, clickOn, evaluate, waitFor, waitRect, type Stored } from './smoke-sitedata'
import { recorderOf, sleep } from './smoke-kit'
import { setNoticeSink, type SystemNotice } from './shell/system-notice'
import { getWindowManager } from './shell/windows'
import { frenchSpaces } from '@shared/french-typography'

type Check = (name: string, ok: boolean, detail?: string) => void

export async function smokeClearData2(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, overlayView } = ctx
  // The pages are visited in the default profile's space.
  const history = ctx.history.of('default')
  const ui = overlayView.webContents
  const manager = getWindowManager()

  const cachedHits = new Map<string, number>()
  const server = createServer((req, res) => {
    const host = req.headers.host ?? ''
    const path = (req.url ?? '/').split('?')[0]
    res.setHeader('content-type', 'text/html')
    if (path === '/site') {
      res.setHeader('set-cookie', 'srv=ok; Path=/')
      return res.end(SITE_PAGE)
    }
    if (path === '/probe') return res.end(PROBE_PAGE)
    if (path === '/cached.txt') {
      cachedHits.set(host, (cachedHits.get(host) ?? 0) + 1)
      res.setHeader('content-type', 'text/plain')
      res.setHeader('cache-control', 'max-age=3600')
      return res.end('cached')
    }
    if (path === '/sw.js') {
      res.setHeader('content-type', 'text/javascript')
      return res.end("self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(clients.claim()))")
    }
    res.end(`<title>root ${path}</title><body>root</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const A = `127.0.0.1:${port}`
  const B = `localhost:${port}`
  const P = `p.localhost:${port}`
  const urlOf = (host: string, path = '') => `http://${host}${path}`

  // Every notice goes to this list instead of the notification centre of the machine the test runs on.
  const notices: SystemNotice[] = []
  let systemAccepts = true
  const releaseSink = setNoticeSink((notice) => {
    notices.push(notice)
    return systemAccepts
  })

  const homeSpace = store.get().spaces.find((s) => s.profileId === 'default')!.id
  browser.dispatch({ type: 'space/select', id: homeSpace })
  const openedTabs: string[] = []
  const tabs = () => store.get().tabs
  const titleOf = (id: string) => tabs().find((t) => t.id === id)?.title ?? ''
  const urlOfTab = (id: string) => tabs().find((t) => t.id === id)?.url ?? ''
  const openTab = (url: string): string => {
    browser.dispatch({ type: 'tab/open', url })
    const id = tabs().at(-1)!.id
    openedTabs.push(id)
    return id
  }
  const settings = () => store.get().settings
  const resetSettings = () => {
    const d = defaultSettings()
    browser.dispatch({
      type: 'settings/update',
      patch: {
        siteDataTypes: d.siteDataTypes,
        siteDataSubdomains: d.siteDataSubdomains,
        siteDataReload: d.siteDataReload,
        siteDataHttp: d.siteDataHttp,
        siteDataConfirm: d.siteDataConfirm,
        // The sheet closes at once by default (« Fermeture auto », as in the extension): the runs below read its answer, so it stays open.
        siteDataAutoClose: false,
        siteDataNotify: d.siteDataNotify,
        // The drawing on the page is a decoration this run does not look at.
        siteDataAnimation: 'none',
        siteDataRecents: d.siteDataRecents
      }
    })
  }

  let probeCounter = 0
  /** Loads the probe page in a tab and reads what the origin still holds. */
  const probe = async (tabId: string, host: string): Promise<Stored | null> => {
    browser.dispatch({ type: 'tab/select', id: tabId })
    const n = `?n=${++probeCounter}`
    browser.submitUrl(urlOf(host, `/probe${n}`), 'current')
    const read = (): Stored | null => {
      const title = titleOf(tabId)
      if (!title.startsWith('probe:')) return null
      const parsed = JSON.parse(title.slice('probe:'.length)) as Stored
      return parsed.n === n ? parsed : null
    }
    return (await waitFor(() => read() !== null, 8000)) ? read() : null
  }
  const seed = async (host: string): Promise<string> => {
    const id = openTab(urlOf(host, '/site'))
    check(`${host} finished filling its storage`, await waitFor(() => titleOf(id) === 'seeded', 12_000), titleOf(id))
    return id
  }
  let seedCounter = 0
  const reseed = async (tabId: string, host: string): Promise<void> => {
    browser.dispatch({ type: 'tab/select', id: tabId })
    // The title of the page that was there says "seeded" until the new document replaces it: wait for the new document itself.
    const n = `?r=${++seedCounter}`
    browser.submitUrl(urlOf(host, `/site${n}`), 'current')
    const done = await waitFor(async () => (await browser.evaluateInPage(`location.search === ${JSON.stringify(n)} && document.title === 'seeded'`).catch(() => false)) === true, 12_000)
    check(`${host} was filled again`, done, titleOf(tabId))
  }
  const full = (s: Stored | null) => s !== null && s.cookie.includes('srv=ok') && s.cookie.includes('js=ok') && s.ls === 'ok' && s.ss === 'ok' && s.idb && s.sw === 1 && s.caches === 'smokecache' && s.fs === true
  const empty = (s: Stored | null) => s !== null && s.cookie === '' && s.ls === null && s.ss === null && !s.idb && s.sw === 0 && s.caches === '' && s.fs !== true
  const show = (s: Stored | null) => JSON.stringify(s)
  /** What the page on screen still holds, read without leaving it (the panel is open over it). */
  const held = async (): Promise<{ cookie: string; ls: string | null }> =>
    (await browser.evaluateInPage(`({ cookie: document.cookie, ls: localStorage.getItem('ls') })`)) as { cookie: string; ls: string | null }

  // ---------- the panel, driven the way a user drives it ----------
  const openPanel = async (tabId: string): Promise<boolean> => {
    browser.closeOverlay()
    browser.dispatch({ type: 'tab/select', id: tabId })
    browser.openOverlay({ panel: 'sitedata' })
    const shown = (await waitRect(ui, '.sitedata input.field')) !== null
    await waitFor(() => evaluate<boolean>(ui, `document.activeElement === document.querySelector('.sitedata input.field')`), 3000)
    await sleep(300)
    return shown
  }
  const tagsShown = () => evaluate<string[]>(ui, `[...document.querySelectorAll('.sd-tag-label')].map((e) => e.textContent)`)
  const chipsShown = () => evaluate<string[]>(ui, `[...document.querySelectorAll('.sd-recents button.sd-recent')].map((e) => e.textContent)`)
  const ticked = () => evaluate<string[]>(ui, `[...document.querySelectorAll('.sd-types li')].filter((li) => li.querySelector('input').checked).map((li) => li.querySelector('strong').textContent)`)
  const draftValue = () => evaluate<string>(ui, `document.querySelector('.sitedata input.field')?.value ?? ''`)
  /** The line under the switches that says why nothing ran (« Entrez un domaine », « Sélectionnez au moins un type », an address that is not one). */
  const problemShown = () => evaluate<string>(ui, `document.querySelector('.sd-error')?.textContent ?? ''`)
  const flag = (label: string) => evaluate<boolean | null>(ui, `[...document.querySelectorAll('.sitedata label.sd-switch, .sitedata label.sd-scope')].find((l) => l.textContent.includes(${JSON.stringify(label)}))?.querySelector('input').checked ?? null`)
  const cards = () =>
    evaluate<Array<{ host: string; score: string; lines: string[] }>>(
      ui,
      `[...document.querySelectorAll('.sd-card')].map((c) => ({ host: c.querySelector('header strong').textContent, score: c.querySelector('.sd-score').textContent, lines: [...c.querySelectorAll('.sd-result')].map((l) => l.classList.contains('is-ok') + ':' + l.textContent) }))`
    )
  /** The card scrolls when it is taller than the window: bring the target to the middle before a real click lands on it. */
  const reveal = (selector: string, text?: string) =>
    evaluate(
      ui,
      `(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = ${text === undefined ? 'els[0]' : `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))`}; el?.scrollIntoView({ block: 'center' }) })()`
    )
  const click = async (selector: string, text?: string): Promise<boolean> => {
    await reveal(selector, text)
    await sleep(120)
    return clickOn(ui, selector, text)
  }
  const typeText = async (text: string) => {
    await click('.sitedata input.field')
    await ui.insertText(text)
    await sleep(250)
  }
  const pressEnter = async () => {
    ui.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    ui.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await sleep(250)
  }
  /** A real click on the first element matching an exact selector (a tag's remove button has no text of its own). */
  const clickSelector = async (selector: string): Promise<boolean> => {
    await reveal(selector)
    await sleep(120)
    const rect = await waitRect(ui, selector)
    if (!rect) return false
    const x = Math.round(rect.x + rect.width / 2)
    const y = Math.round(rect.y + rect.height / 2)
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) ui.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 })
    await sleep(250)
    return true
  }
  const menuItem = (label: string): MenuItem | undefined => {
    const find = (items: MenuItem[]): MenuItem | undefined => {
      for (const item of items) {
        if (item.label === label) return item
        const inner = item.submenu ? find(item.submenu.items) : undefined
        if (inner) return inner
      }
      return undefined
    }
    return find(Menu.getApplicationMenu()?.items ?? [])
  }
  const noticeFor = (body: string) => notices.find((n) => n.body === body)

  try {
    resetSettings()
    // The extension probes (loaded by the full suite) discard the first tab of the window when they start: let that be this one.
    openTab(urlOf(B, '/'))
    const tabA = await seed(A)
    const tabB = await seed(B)
    const tabP = await seed(P)
    const seeded = { A: await probe(tabA, A), B: await probe(tabB, B), P: await probe(tabP, P) }
    for (const [name, stored] of Object.entries(seeded)) check(`the test site ${name} really holds cookies, localStorage, sessionStorage, IndexedDB, a service worker and Cache Storage`, full(stored), show(stored))
    const pHits = cachedHits.get(P)

    // ---------- several sites at once, as tags ----------
    await reseed(tabA, A)
    await reseed(tabB, B)
    check('the panel opens on the site of the tab as one tag', (await openPanel(tabA)) && JSON.stringify(await tagsShown()) === JSON.stringify([A]), JSON.stringify(await tagsShown()))
    await typeText(B)
    await pressEnter()
    check('typing another site and pressing Enter makes a second tag, in order, and empties the field', JSON.stringify(await tagsShown()) === JSON.stringify([A, B]) && (await draftValue()) === '', `${JSON.stringify(await tagsShown())} / ${await draftValue()}`)
    await typeText(`${A} `)
    check('a site that is already there does not make a second tag', (await tagsShown()).length === 2, JSON.stringify(await tagsShown()))
    await typeText('pas/un/hote')
    await pressEnter()
    check('what is not a site stays in the field, with a warning', (await draftValue()) === 'pas/un/hote' && (await problemShown()).startsWith('Adresse non valide'), await draftValue())
    await click('.sd-cta')
    check('and the button runs nothing while it is there', (await cards()).length === 0 && (await problemShown()).startsWith('Adresse non valide'), await problemShown())
    // A Backspace sent with sendInputEvent does not always reach the editor on macOS: empty the field with the editing commands of the Edit menu.
    await click('.sitedata input.field')
    ui.selectAll()
    ui.delete()
    await waitFor(async () => (await draftValue()) === '' && (await problemShown()) === '')
    check('emptying the field takes the warning away, and the tags are still two', (await draftValue()) === '' && (await problemShown()) === '' && (await tagsShown()).length === 2, `${await draftValue()} / ${JSON.stringify(await tagsShown())}`)
    ui.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
    ui.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    await waitFor(async () => (await tagsShown()).length < 2)
    check('Backspace in the empty field takes the last tag away', JSON.stringify(await tagsShown()) === JSON.stringify([A]) && (await draftValue()) === '', `${JSON.stringify(await tagsShown())} / ${JSON.stringify(await draftValue())}`)
    await typeText(`${B},`)
    check('a comma ends a site: it becomes a tag again', JSON.stringify(await tagsShown()) === JSON.stringify([A, B]) && (await draftValue()) === '', `${JSON.stringify(await tagsShown())} / ${await draftValue()}`)
    check('the cookie tile counts the cookies of both sites', await waitFor(async () => Number(await evaluate<string>(ui, `[...document.querySelectorAll('.sd-tile')].find((r) => r.textContent.includes('Cookies'))?.querySelector('.sd-badge')?.textContent ?? ''`)) >= 4, 4000))
    check('the sites are served over http: « Inclure HTTP » is ticked by itself', (await flag('Inclure HTTP')) === true)

    await click('button.sd-text-button', 'Aucun')
    check('“Aucun” unticks every type', (await ticked()).length === 0, JSON.stringify(await ticked()))
    await click('.sd-cta')
    check('and the button then says to tick one, and runs nothing', (await problemShown()) === 'Sélectionnez au moins un type' && (await cards()).length === 0, await problemShown())
    await click('button.sd-text-button', 'Tout')
    check('“Tout” ticks every type again', (await ticked()).length === SITE_DATA_TYPES.length && (await problemShown()) === '', JSON.stringify(await ticked()))

    await click('.sd-cta')
    check('Effacer answers with one card per site, in the order of the tags', await waitFor(async () => (await cards()).length === 2), JSON.stringify(await cards()))
    const answered = await cards()
    check('each card names its site and scores every operation (9/9: the eight types and the licences of protected video)', answered.map((c) => c.host).join() === [A, B].join() && answered.every((c) => c.score === `${SITE_DATA_TYPES.length + 1}/${SITE_DATA_TYPES.length + 1}`), JSON.stringify(answered.map((c) => [c.host, c.score])))
    check('and has one successful line per type, and one for the licences', answered.every((c) => c.lines.length === SITE_DATA_TYPES.length + 1 && c.lines.every((l) => l.startsWith('true:')) && c.lines.at(-1) === 'true:Licences de vidéo protégée'), JSON.stringify(answered[0]?.lines))
    check('the banner says everything was cleared', (await evaluate<string>(ui, `document.querySelector('.sd-banner strong')?.textContent ?? ''`)) === 'Données effacées')
    check('the tab on one of the sites went back to its root', await waitFor(() => urlOfTab(tabA) === urlOf(A, '/'), 8000), urlOfTab(tabA))
    browser.closeOverlay()
    // Read before the probes below visit the sites again (a visit is history too).
    const hostsAfter = history.hosts()
    // The tab that went back to the root of its site visited that root again: it is the only page of the site the history may hold.
    const keptOfA = history.search('127.0.0.1', 50).map((entry) => entry.url).filter((url) => url.startsWith(urlOf(A)))
    check('the two sites were remembered, in the order of the run', JSON.stringify(settings().siteDataRecents) === JSON.stringify([A, B]), JSON.stringify(settings().siteDataRecents))
    check('and no notice was shown: the answer was on screen', notices.length === 0, JSON.stringify(notices))

    const a1 = await probe(tabA, A)
    const b1 = await probe(tabB, B)
    const p1 = await probe(tabP, P)
    check('both named sites are emptied', empty(a1) && empty(b1), `${show(a1)} ${show(b1)}`)
    check('and the third site, not named, keeps all its data', full(p1), show(p1))
    check('and its cached file is still served from the HTTP cache', cachedHits.get(P) === pHits, `${pHits} -> ${cachedHits.get(P)}`)
    check(
      'the history of the third site is still there, while the pages of the two others were forgotten (but the root the tab went back to)',
      hostsAfter.includes(P) && !hostsAfter.includes(B) && keptOfA.every((url) => url === urlOf(A, '/')),
      `${hostsAfter.join(', ')} / ${keptOfA.join(', ')}`
    )

    // ---------- a recent site, one click ----------
    await reseed(tabA, A)
    await reseed(tabB, B)
    const pUrlBefore = urlOfTab(tabP)
    check('the panel opens on the third site, and offers the two sites erased before', (await openPanel(tabP)) && JSON.stringify(await tagsShown()) === JSON.stringify([P]) && JSON.stringify(await chipsShown()) === JSON.stringify([A, B]), `${JSON.stringify(await tagsShown())} ${JSON.stringify(await chipsShown())}`)
    await click('.sd-recents button.sd-recent', A)
    check('a click on a recent site adds it as a tag, and takes it out of the recent list', JSON.stringify(await tagsShown()) === JSON.stringify([P, A]) && JSON.stringify(await chipsShown()) === JSON.stringify([B]), `${JSON.stringify(await tagsShown())} ${JSON.stringify(await chipsShown())}`)
    await clickSelector(`button.sd-tag-remove[aria-label="Retirer ${P}"]`)
    check('the × of a tag takes the site out of the run', JSON.stringify(await tagsShown()) === JSON.stringify([A]) && JSON.stringify(await chipsShown()) === JSON.stringify([B]), JSON.stringify(await tagsShown()))
    // A site typed and not validated is part of the run when the button is pressed (the extension does the same).
    await typeText(B)
    await click('.sd-cta')
    check('with what was typed counted as a site, Effacer answers for the two', await waitFor(async () => (await cards()).length === 2), JSON.stringify(await cards()))
    check('which are the recent site and the typed one', JSON.stringify((await cards()).map((c) => c.host)) === JSON.stringify([A, B]), JSON.stringify(await cards()))
    browser.closeOverlay()
    check('the tab of the site that was not named was left where it was', urlOfTab(tabP) === pUrlBefore, `${pUrlBefore} -> ${urlOfTab(tabP)}`)
    const a2 = await probe(tabA, A)
    const b2 = await probe(tabB, B)
    const p2 = await probe(tabP, P)
    check('the recent site and the typed one are emptied', empty(a2) && empty(b2), `${show(a2)} ${show(b2)}`)
    check('the site whose tag was removed keeps everything', full(p2), show(p2))
    check('the recent list now starts with the sites just erased', JSON.stringify(settings().siteDataRecents) === JSON.stringify([A, B]), JSON.stringify(settings().siteDataRecents))

    await openPanel(tabP)
    await click('.sd-recents button.sd-text-button', 'Effacer')
    check('“Effacer” beside the recent domains empties them and hides the row', (await waitFor(() => settings().siteDataRecents.length === 0, 3000)) && (await evaluate<boolean>(ui, `document.querySelector('.sd-recents') === null`)), JSON.stringify(settings().siteDataRecents))
    browser.closeOverlay()

    // ---------- the confirmation, when the setting asks for it ----------
    await reseed(tabA, A)
    // « Demander confirmation » lives in Réglages › Vie privée et sécurité now.
    browser.dispatch({ type: 'settings/update', patch: { siteDataConfirm: true } })
    await openPanel(tabA)
    await click('.sd-cta')
    check('Effacer then asks first, naming the site', await waitFor(() => evaluate<boolean>(ui, `document.querySelector('.sd-dialog') !== null`), 3000) && (await evaluate<string>(ui, `document.querySelector('.sd-dialog')?.textContent ?? ''`)).includes(A))
    const whileAsking = await held()
    check('nothing is erased while it waits', whileAsking.cookie.includes('srv=ok') && whileAsking.ls === 'ok', JSON.stringify(whileAsking))
    await click('.sd-no')
    check('“Annuler” goes back to the form, with the site still there', (await evaluate<boolean>(ui, `document.querySelector('.sd-dialog') === null`)) && JSON.stringify(await tagsShown()) === JSON.stringify([A]), JSON.stringify(await tagsShown()))
    const afterCancel = await held()
    check('and nothing was erased', afterCancel.cookie.includes('srv=ok') && afterCancel.ls === 'ok' && (await cards()).length === 0, JSON.stringify(afterCancel))
    check('no site was remembered by a run that did not happen', settings().siteDataRecents.length === 0, JSON.stringify(settings().siteDataRecents))
    await click('.sd-cta')
    await waitFor(() => evaluate<boolean>(ui, `document.querySelector('.sd-dialog') !== null`), 3000)
    await click('.sd-yes')
    check('confirming erases and shows the card of the site', await waitFor(async () => (await cards()).length === 1), JSON.stringify(await cards()))
    browser.closeOverlay()
    const a3 = await probe(tabA, A)
    check('the site is empty after the confirmation', empty(a3), show(a3))
    browser.dispatch({ type: 'settings/update', patch: { siteDataConfirm: false } })

    // ---------- the panel that closes at once, and the notice that tells the end ----------
    notices.length = 0
    await reseed(tabA, A)
    await openPanel(tabA)
    await click('.sitedata label.sd-switch', 'Fermeture auto')
    await click('.sd-cta')
    check('with “Fermeture auto”, Effacer closes the panel', await waitFor(() => browser.currentPanel() === null, 3000), String(browser.currentPanel()))
    check('and the choice is remembered', settings().siteDataAutoClose === true)
    check('the run ends on its own and a system notice names the site', await waitFor(() => noticeFor(A) !== undefined, 8000), JSON.stringify(notices))
    check('the notice says the data was cleared', noticeFor(A)?.title === 'Données effacées', JSON.stringify(notices))
    const a4 = await probe(tabA, A)
    check('and the site is empty', empty(a4), show(a4))
    check('the site was remembered', settings().siteDataRecents[0] === A, JSON.stringify(settings().siteDataRecents))

    // The same run through the real IPC: the answer is empty at once, the data goes later.
    await reseed(tabA, A)
    notices.length = 0
    const detached = await evaluate<unknown[]>(ui, `window.lucium.clearSites({ hosts: [${JSON.stringify(A)}], types: ['cookies', 'localStorage'], subdomains: false, http: true, reload: false, detached: true })`)
    check('a detached run answers at once with nothing to show', Array.isArray(detached) && detached.length === 0, JSON.stringify(detached))
    check('and still ends with its notice', await waitFor(() => noticeFor(A) !== undefined, 8000), JSON.stringify(notices))

    browser.dispatch({ type: 'settings/update', patch: { siteDataNotify: false } })
    await reseed(tabA, A)
    notices.length = 0
    await evaluate(ui, `window.lucium.clearSites({ hosts: [${JSON.stringify(A)}], types: ['cookies'], subdomains: false, http: true, reload: false, detached: true })`)
    const quiet = await waitFor(async () => (await held()).cookie === '', 8000)
    // A fixed wait, for want of a witness: the notice would come at the end of the run, and a run that says nothing has no end the test can see.
    await sleep(700)
    check('with the notices off, the run still erases but nothing is shown', quiet && notices.length === 0, `${quiet} ${JSON.stringify(await held())} ${JSON.stringify(notices)} tab=${browser.snapshot().state.activeTabBySpace[homeSpace]} url=${urlOfTab(tabA)}`)
    browser.dispatch({ type: 'settings/update', patch: { siteDataNotify: true, siteDataAutoClose: false } })

    // ---------- without the panel: the menus, the shortcut, the command bar ----------
    const quick = menuItem('Effacer les données du site maintenant')
    check('the Archive menu lists “Effacer les données du site maintenant” with ⌥⇧⌘X', quick?.accelerator === 'CmdOrCtrl+Alt+Shift+X' && Menu.getApplicationMenu()!.items.find((m) => m.label === 'Archive')?.submenu?.items.includes(quick) === true, String(quick?.accelerator))
    check('and the Extensions menu has no entry of its own for it', menuItem('Effacer les données du domaine') === undefined)
    browser.dispatch({ type: 'settings/update', patch: { siteDataTypes: ['cookies', 'localStorage', 'sessionStorage'], siteDataReload: true } })

    await reseed(tabA, A)
    await reseed(tabB, B)
    browser.dispatch({ type: 'tab/select', id: tabA })
    notices.length = 0
    quick?.click()
    check('choosing it clears the site of the page and shows a notice naming it', await waitFor(() => noticeFor(A)?.title === 'Données effacées', 8000), JSON.stringify(notices))
    check('and sends the tab back to the root of the site (the remembered reload)', await waitFor(() => urlOfTab(tabA) === urlOf(A, '/'), 8000), urlOfTab(tabA))
    const a5 = await probe(tabA, A)
    check('only the remembered types went: cookies, localStorage and sessionStorage, not IndexedDB, the service worker or Cache Storage', a5 !== null && a5.cookie === '' && a5.ls === null && a5.ss === null && a5.idb && a5.sw === 1 && a5.caches === 'smokecache', show(a5))
    const b5 = await probe(tabB, B)
    check('another site is untouched by a quick clear', full(b5), show(b5))
    check('a quick clear remembers the site too', settings().siteDataRecents[0] === A, JSON.stringify(settings().siteDataRecents))

    // The command bar offers it too.
    browser.dispatch({ type: 'tab/select', id: tabB })
    await reseed(tabB, B)
    notices.length = 0
    for (let attempt = 0; attempt < 4; attempt++) {
      browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
      if (await waitFor(() => evaluate<boolean>(ui, `document.activeElement === document.querySelector('.palette-input')`), 3000)) break
    }
    await sleep(200)
    for (const ch of 'efface les donnees du site maintenant') {
      const keyCode = ch === ' ' ? 'Space' : ch
      ui.sendInputEvent({ type: 'keyDown', keyCode })
      ui.sendInputEvent({ type: 'char', keyCode: ch })
      ui.sendInputEvent({ type: 'keyUp', keyCode })
      await sleep(40)
    }
    await sleep(350)
    const rows = await evaluate<Array<{ label: string; selected: boolean }>>(ui, `[...document.querySelectorAll('.results li[role="option"]')].map((li) => ({ label: li.querySelector('.label')?.textContent ?? '', selected: li.classList.contains('selected') }))`)
    const at = rows.findIndex((r) => r.label === 'Effacer les données du site maintenant')
    check('typing “efface les donnees du site maintenant” in the command bar offers the action', at >= 0, JSON.stringify(rows.map((r) => r.label)))
    for (let i = Math.max(0, rows.findIndex((r) => r.selected)); i < at; i++) {
      ui.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
      ui.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
      await sleep(80)
    }
    ui.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    ui.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    check('and Enter on it clears the site and shows the notice, without opening the panel', (await waitFor(() => noticeFor(B)?.title === 'Données effacées', 8000)) && browser.currentPanel() !== 'sitedata', `${JSON.stringify(notices)} ${browser.currentPanel()}`)
    browser.closeOverlay()

    // A page that has no site is filtered out, as the extension filters chrome:// pages.
    const blank = openTab('about:blank')
    browser.dispatch({ type: 'tab/select', id: blank })
    await waitFor(() => urlOfTab(blank).startsWith('about:'), 3000)
    notices.length = 0
    quick?.click()
    check('on a page without a site, the entry says so in a toast and shows no notice', (await waitFor(() => browser.snapshot().toast?.message.includes('pas de données de site') === true, 3000)) && notices.length === 0, `${JSON.stringify(browser.snapshot().toast)} ${JSON.stringify(notices)}`)
    const pStill = await probe(tabP, P)
    check('and nothing was erased', full(pStill), show(pStill))
    browser.dispatch({ type: 'tab/close', id: blank })

    // Without a notification centre the same words go to the toast of the window.
    await reseed(tabB, B)
    browser.dispatch({ type: 'tab/select', id: tabB })
    systemAccepts = false
    notices.length = 0
    quick?.click()
    check('when the system takes no notice, the window’s toast says the same', await waitFor(() => browser.snapshot().toast?.message === frenchSpaces(`Données effacées : ${B}`), 8000), `${JSON.stringify(browser.snapshot().toast)} ${JSON.stringify(notices)}`)
    systemAccepts = true

    // ---------- the private window: its own session, no list, no name in a notice ----------
    resetSettings()
    browser.dispatch({ type: 'settings/update', patch: { siteDataRecents: [P] } })
    {
      const priv = manager.openPrivate()
      priv.browser.dispatch({ type: 'tab/open', url: urlOf(A, '/site') })
      const privTab = priv.store.get().tabs.at(-1)!.id
      check('the private window filled its own session for the same address', await waitFor(() => priv.store.get().tabs.find((t) => t.id === privTab)?.title === 'seeded', 12_000))
      notices.length = 0
      const results = await priv.browser.clearSitesFor({ hosts: [A], types: ['cookies', 'localStorage'], subdomains: false, http: true, reload: false, detached: false })
      check('a run in the private window answers and succeeds', results.length === 1 && results[0]!.results.every((r) => r.ok), JSON.stringify(results))
      check('and remembers nothing in the settings of the main window', JSON.stringify(settings().siteDataRecents) === JSON.stringify([P]), JSON.stringify(settings().siteDataRecents))
      check('nor in its own (it only holds the main window’s list, as a copy)', !priv.store.get().settings.siteDataRecents.includes(A), JSON.stringify(priv.store.get().settings.siteDataRecents))
      priv.browser.dispatch({ type: 'tab/select', id: privTab })
      await priv.browser.quickClearSite()
      check('a quick clear in the private window shows a notice that does not name the site', notices.length === 1 && notices[0]!.body === 'Fenêtre privée' && !JSON.stringify(notices).includes('127.0.0.1'), JSON.stringify(notices))
      priv.browser.openOverlay({ panel: 'sitedata' })
      const privateUi = priv.win.contentView.children.map((v) => v as Electron.WebContentsView).find((v) => v.webContents.getURL().includes('overlay'))?.webContents
      check('the private window has a panel to look at', privateUi !== undefined)
      if (privateUi) {
        await waitRect(privateUi, '.sitedata input.field')
        // The list of the types is drawn with the recent sites, in one render (SiteData.tsx): once it is there, so would they be.
        await waitFor(async () => (await evaluate<number>(privateUi, `document.querySelectorAll('.sd-types li').length`)) > 0)
        check('whose panel offers no recent site and no history to forget', (await evaluate<boolean>(privateUi, `document.querySelector('.sd-recents') === null`)) && (await evaluate<number>(privateUi, `document.querySelectorAll('.sd-types li').length`)) === SITE_DATA_TYPES.length - 1, '')
        check('and has no setting of its own to change: they are in Réglages', await evaluate<boolean>(privateUi, `document.querySelector('.sitedata-more') === null`))
      }
      priv.browser.closeOverlay()
      priv.win.close()
      await waitFor(() => manager.privateWindows().length === 0)
      await manager.settled()
    }

    // ---------- the list of recent sites is bounded and its entries are valid ----------
    const many = Array.from({ length: SITE_DATA_RECENTS_MAX + 2 }, (_, i) => `recent${i}.example`)
    await browser.clearSitesFor({ hosts: many, types: ['cookies'], subdomains: false, http: true, reload: false, detached: false })
    check('the recent sites keep the newest ones, no more than the list bound, in the order of the run', JSON.stringify(settings().siteDataRecents) === JSON.stringify(many.slice(0, SITE_DATA_RECENTS_MAX)), JSON.stringify(settings().siteDataRecents))

    // ---------- the real IPC refuses what is not valid, and erases nothing ----------
    resetSettings()
    await reseed(tabA, A)
    const refusal = (script: string) => evaluate<string>(ui, `(${script}).then(() => 'accepted', (e) => String(e.message ?? e))`)
    const bad = await refusal(`window.lucium.clearSites({ hosts: [${JSON.stringify(A)}, 'a b'], types: ['cookies'], subdomains: false, http: true, reload: false, detached: false })`)
    check('one site that is not valid refuses the whole run', bad.includes('Invalid site data request'), bad)
    const none = await refusal(`window.lucium.clearSites({ hosts: [], types: ['cookies'], subdomains: false, http: true, reload: false, detached: false })`)
    check('no site refuses the run', none.includes('Invalid site data request'), none)
    const tooMany = await refusal(`window.lucium.clearSites({ hosts: ${JSON.stringify(Array.from({ length: SITE_DATA_HOSTS_MAX + 1 }, (_, i) => `s${i}.example`))}, types: ['cookies'], subdomains: false, http: true, reload: false, detached: false })`)
    check('too many sites refuses the run', tooMany.includes('Invalid site data request'), tooMany)
    const noTypes = await refusal(`window.lucium.clearSites({ hosts: [${JSON.stringify(A)}], types: [], subdomains: false, http: true, reload: false, detached: false })`)
    check('no type refuses the run', noTypes.includes('Invalid site data request'), noTypes)
    browser.dispatch({ type: 'tab/select', id: tabA })
    const keptByRefusals = await held()
    check('and the site named next to the invalid one still has everything', keptByRefusals.cookie.includes('srv=ok') && keptByRefusals.ls === 'ok', JSON.stringify(keptByRefusals))
  } finally {
    releaseSink()
    resetSettings()
    browser.closeOverlay()
    for (const id of openedTabs) browser.dispatch({ type: 'tab/close', id })
    server.close()
  }
}

/** The same checks with their own report, for a quick local loop (see LUCIUM_SMOKE_ONLY in index.ts). Returns the exit code. */
export async function runClearData2Smoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  const check: Check = recorderOf(checks)
  try {
    await smokeClearData2(ctx, check)
  } catch (error) {
    check('smokeClearData2 ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_CLEARDATA2 ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}

