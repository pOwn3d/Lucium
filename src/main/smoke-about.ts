// Engine checks for the "À propos" of Lucium: the group of Settings › À propos et mises à jour, after its settings and before the state of Lucium (what it
// says, where it sits, that it is quiet), its five links (an ordinary tab of the browser, never a navigation of the Settings window; the
// licences open the documentation), the
// version read by the main process, and the About panel of the menu bar. Real mouse events drive the links.
// Called from the engine smoke test: `await smokeAbout(ctx, check)`. `runAboutSmoke` is the same with its own report, for
// LUCIUM_SMOKE_ONLY=about (quick loop). LUCIUM_ABOUT_VERBOSE=1 prints every check as it goes.
// No request leaves the machine: the tabs the links open are sent to a local page instead of the real addresses (the address the
// interface asked for is recorded before that).

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { app, BrowserWindow as ElectronWindow, ipcMain, Menu, shell, type WebContents } from 'electron'
import {
  ABOUT_LICENSE,
  ABOUT_NAME,
  ABOUT_ROWS,
  COMPANY_URL,
  ISSUES_URL,
  LICENSES_DOC,
  REPOSITORY_URL,
  aboutCopyright,
  aboutFootnote,
  aboutPanelOptions,
  aboutTagline,
  aboutUrl,
  displayAddress
} from '@shared/about'
import { Channel } from '@shared/ipc'
import type { Browser } from './shell/browser'
import { appliedAboutPanel } from './shell/about'
import type { SmokeContext } from './smoke'
import { isBuiltApp } from './runtime'
import { noteCheck, OPEN_MORE_SETTINGS, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void

interface Rect {
  x: number
  y: number
  width: number
  height: number
}


const waitFor = waiterOf(6000, 60)

const evaluate = <T>(wc: WebContents, script: string): Promise<T> => wc.executeJavaScript(script) as Promise<T>
const within = (value: number, wanted: number, tolerance = 1) => Math.abs(value - wanted) <= tolerance

const rectOf = (wc: WebContents, selector: string, text?: string): Promise<Rect | null> =>
  evaluate(
    wc,
    `(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
      const el = ${text === undefined ? 'els[0]' : `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))`}
      if (!el) return null
      el.scrollIntoView({ block: 'nearest' })
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })()`
  )

/** A left click with real mouse events, in the middle of the box. */
async function clickRect(wc: WebContents, rect: Rect): Promise<void> {
  const x = Math.round(rect.x + rect.width / 2)
  const y = Math.round(rect.y + rect.height / 2)
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 } as Electron.MouseInputEvent)
  await sleep(200)
}

async function clickOn(wc: WebContents, selector: string, text?: string): Promise<boolean> {
  await sleep(80)
  const rect = await rectOf(wc, selector, text)
  if (!rect) return false
  await sleep(80)
  await clickRect(wc, (await rectOf(wc, selector, text)) ?? rect)
  return true
}

export async function smokeAbout(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win } = ctx
  const settingsWindows = () => ElectronWindow.getAllWindows().filter((w) => w.getTitle() === 'Réglages')
  const tabs = () => store.get().tabs
  const text = (wc: WebContents, selector: string) => evaluate<string>(wc, `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`)

  // A local page stands in for every address a link opens.
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end('<title>smoke about</title><body>ok</body>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // What the interface asked for, recorded before the address is swapped for the local page.
  const asked: string[] = []
  const RELEASES_URL = aboutUrl('news')!
  const realAddresses = [COMPANY_URL, REPOSITORY_URL, ISSUES_URL, RELEASES_URL]
  const mutable = browser as unknown as { dispatch: Browser['dispatch'] }
  const realDispatch = mutable.dispatch.bind(browser)
  mutable.dispatch = (action) => {
    if (action.type === 'tab/open' && realAddresses.includes(action.url)) {
      asked.push(action.url)
      return realDispatch({ ...action, url: `${base}/about-${asked.length}` })
    }
    return realDispatch(action)
  }

  // The system's folder opener is already a recorder in a test run (index.ts); this one also lets a check make it fail.
  const openedPaths: string[] = []
  let failOpening = false
  const shellMutable = shell as unknown as { openPath: (path: string) => Promise<string> }
  const realOpenPath = shellMutable.openPath
  shellMutable.openPath = async (path) => {
    openedPaths.push(path)
    if (failOpening) throw new Error('forced: the system refused to open the folder')
    return ''
  }

  const errors: string[] = []
  const warnings: string[] = []
  const realError = console.error
  const realWarn = console.warn
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
    realError(...args)
  }
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
    realWarn(...args)
  }

  const pageMessages: string[] = []
  const listenToPages = (_event: unknown, contents: WebContents) => {
    contents.on('console-message', (event: unknown, ...legacy: unknown[]) => {
      const message = (event as { message?: unknown })?.message ?? legacy[1]
      pageMessages.push(String(message))
    })
  }
  app.on('web-contents-created', listenToPages)

  const opening: string[] = []
  const trackTabs = () => {
    for (const tab of tabs()) if (tab.url.startsWith(base) && !opening.includes(tab.id)) opening.push(tab.id)
  }

  // The group lives in « À propos et mises à jour »: the link of the menu leads to it, and the page is the one on screen. The state of Lucium waits in
  // the fold « Plus de réglages » of the page, opened here so that it is drawn.
  const openAboutGroup = async (): Promise<WebContents> => {
    // A toast left by an earlier suite (themes applied, a session restored…) must not be taken for a notice raised by opening the pane.
    await waitFor(() => browser.snapshot().toast === null && browser.currentPanel() === null, 20_000)
    browser.openOverlay({ panel: 'settings', pane: 'about', anchor: 'about' })
    await waitFor(() => settingsWindows().length === 1)
    const wc = settingsWindows()[0]!.webContents
    await waitFor(async () => (await evaluate<string>(wc, `document.querySelector('.settings-cat[aria-current=page]')?.dataset.cat ?? ''`)) === 'about')
    await waitFor(async () => (await rectOf(wc, '.about-group')) !== null, 8000)
    await waitFor(() => evaluate<boolean>(wc, OPEN_MORE_SETTINGS), 3000)
    await sleep(300)
    return wc
  }

  try {
    // ======================= the About panel of the menu bar =======================
    {
      const lucium = Menu.getApplicationMenu()?.items.find((item) => item.label === 'Lucium')
      const first = lucium?.submenu?.items[0]
      check('the first entry of the Lucium menu is the About, labelled “À propos de Lucium” (it opens the small window of E27-P A; Arc’s order is untouched)', typeof first?.click === 'function' && first.label === 'À propos de Lucium' && lucium?.submenu?.items[1]?.type === 'separator' && lucium.submenu.items[2]?.label === 'Réglages…', `${first?.role} / ${first?.label}`)
      const applied = appliedAboutPanel()
      check('the panel was given its options at start-up', applied !== null)
      check('they carry the version the main process reads (package.json)', applied?.applicationVersion === app.getVersion() && /^\d+\.\d+\.\d+/.test(app.getVersion()), `${applied?.applicationVersion} / ${app.getVersion()}`)
      check('and the name, and no second number in parentheses', applied?.applicationName === 'Lucium' && applied.version === '')
      check('the copyright reads “© 2026 les contributeurs de Lucium — un projet de ConsilioWeb”', applied?.copyright === '© 2026 les contributeurs de Lucium — un projet de ConsilioWeb' && applied.copyright === aboutCopyright(), applied?.copyright)
      check('the licence and the site are in its credits', !!applied?.credits.includes(ABOUT_LICENSE) && applied.credits.includes('https://consilioweb.fr'), applied?.credits)
      check('they are exactly what the shared module builds for this version', JSON.stringify(applied) === JSON.stringify(aboutPanelOptions(app.getVersion())))
    }

    // ======================= the group, in « À propos et mises à jour » =======================
    // Its own settings first (Mises à jour, Icône de l’application), then « À propos », then only the state of Lucium (État de Lucium, Journal des
    // erreurs, Rapport: SettingsCategories.tsx, EngineStatus.tsx), in « Plus de réglages », which loads after the page opens. The title of a group is
    // its .pref-title (the h3 also holds the count of its settings).
    let wc = await openAboutGroup()
    {
      const engineTitles = ['État de Lucium', 'Journal des erreurs', 'Rapport']
      const titlesOf = () => evaluate<string[]>(wc, `[...document.querySelectorAll('.settings-content .pref-section > h3 > .pref-title')].map((h) => h.textContent)`)
      await waitFor(async () => (await titlesOf()).includes('Rapport'))
      const titles = await titlesOf()
      const about = titles.indexOf('À propos')
      check('the group “À propos” is in Réglages › À propos et mises à jour, right after its settings (the icon of the application) and right before the state of Lucium', about > 0 && titles[about - 1] === 'Icône de l’application' && titles[about + 1] === 'État de Lucium', titles.join('|'))
      check('the state of Lucium, its journal and its report close the pane after it', JSON.stringify(titles.slice(about + 1)) === JSON.stringify(engineTitles), titles.join('|'))
      check('it is a section at the top of the page, found by the anchor of the menu (#about), and only the state of Lucium follows it, in « Plus de réglages »', await evaluate<boolean>(wc, `(() => { const section = document.querySelector('.about-group')?.closest('.pref-section'); if (!section || section.parentElement !== document.querySelector('.settings-content') || !section.matches('section#about') || section.querySelector(':scope > .pref-group.about-group') === null) return false; const sections = [...document.querySelectorAll('.settings-content .pref-section')]; const after = sections.slice(sections.indexOf(section) + 1); return after.length > 0 && after.every((next) => next.closest('.more-settings-body') !== null && ${JSON.stringify(engineTitles)}.includes(next.querySelector('h3 .pref-title')?.textContent ?? '')) })()`))
      check('the page’s own settings come first and are intact: the updates open it, the icon comes before the group, nothing of the group before it', titles[0] === 'Mises à jour' && titles[1] === 'Icône de l’application' && (await evaluate<boolean>(wc, `(() => { const sections = [...document.querySelectorAll('.settings-content .pref-section')]; const index = sections.findIndex((s) => s.querySelector('.about-group')); return index >= 2 && sections.slice(0, index).every((s) => !s.querySelector('.about-group, .about-link')) })()`)), titles.join('|'))
      check('the pane keeps a single “À propos” group', (await evaluate<number>(wc, `[...document.querySelectorAll('.pref-section > h3 .pref-title')].filter((h) => h.textContent === 'À propos').length`)) === 1)

      const rows = await evaluate<Array<{ label: string; control: string }>>(
        wc,
        `[...document.querySelectorAll('.about-group > .pref-row')].map((r) => ({ label: r.querySelector('.pref-label')?.textContent ?? '', control: (r.querySelector('.pref-control, .about-detail')?.textContent ?? '') }))`
      )
      check('seven lines: name and version, what it is, then the five links', rows.length === 1 + 1 + ABOUT_ROWS.length && ABOUT_ROWS.length === 5, JSON.stringify(rows))
      check('the first says “Lucium” and the version the main process reports', rows[0]?.label === ABOUT_NAME && rows[0].control === `Version ${app.getVersion()}`, JSON.stringify(rows[0]))
      check('the second says it is free and community-made, free of charge and open source, under GPL-3.0-or-later', rows[1]?.label === 'Navigateur libre et communautaire, gratuit, code ouvert — licence GPL-3.0-or-later' && rows[1].label === aboutTagline(), rows[1]?.label)
      check('the links read “Un projet de ConsilioWeb”, “Code source et contributions”, “Signaler un problème”, “Nouveautés”, “Licences des composants”', JSON.stringify(rows.slice(2).map((r) => r.label)) === JSON.stringify(['Un projet de ConsilioWeb', 'Code source et contributions', 'Signaler un problème', 'Nouveautés', 'Licences des composants']), JSON.stringify(rows.slice(2)))
      check('each shows where it leads: consilioweb.fr, the repository, its issues, its releases, the licences file', JSON.stringify(rows.slice(2).map((r) => r.control)) === JSON.stringify(['consilioweb.fr', displayAddress(REPOSITORY_URL), displayAddress(ISSUES_URL), displayAddress(RELEASES_URL), LICENSES_DOC]), JSON.stringify(rows.slice(2).map((r) => r.control)))
      check('its note says nothing is sent to ConsilioWeb', (await evaluate<string>(wc, `document.querySelector('.about-group').parentElement.querySelector('.pref-note')?.textContent ?? ''`)) === aboutFootnote())

      // A card like the others of the pane: same fill, same border, same radius, same column. The others are the card of the icon, just above it, and the one of
      // the automatic updates, the neighbour that is always there (the group of the ad blocker it was compared with is in Protection now).
      const look = await evaluate<{ bg: string; border: string; radius: string; icon: string; updates: string }>(
        wc,
        `(() => { const read = (el) => { if (!el) return ''; const c = getComputedStyle(el); return [c.backgroundColor, c.borderTopColor, c.borderTopLeftRadius].join('|') }; const mine = getComputedStyle(document.querySelector('.about-group')); const updates = [...document.querySelectorAll('.pref-group')].find((g) => !g.classList.contains('about-group') && g.textContent.includes('Rechercher les mises à jour automatiquement')); return { bg: mine.backgroundColor, border: mine.borderTopColor, radius: mine.borderTopLeftRadius, icon: read(document.getElementById('icon')?.querySelector('.pref-group')), updates: read(updates) } })()`
      )
      // The colours are the tokens of the Settings window (they follow the appearance): the card is drawn (a fill, a border) and is drawn as the others.
      const mine = `${look.bg}|${look.border}|${look.radius}`
      check('the card has a fill, a border and rounded corners, the same as the other groups of the pane', look.bg !== '' && look.bg !== 'rgba(0, 0, 0, 0)' && look.border !== '' && look.radius !== '0px' && look.icon === mine && look.updates === mine, JSON.stringify(look))
      await evaluate(wc, `document.querySelector('.settings-content').scrollTop = 1e6`)
      await sleep(120)
      const card = await rectOf(wc, '.about-group')
      const column = await evaluate<{ x: number; width: number; height: number } | null>(wc, `(() => { const other = document.getElementById('icon')?.querySelector('.pref-group'); if (!other) return null; const r = other.getBoundingClientRect(); return { x: r.x, width: r.width, height: innerHeight } })()`)
      const neighbour = await rectOf(wc, '.pref-group', 'Rechercher les mises à jour automatiquement')
      check('it is in the column of the other groups (same left edge and width), and can be scrolled fully into the window', !!card && !!column && !!neighbour && within(card.x, column.x, 0.6) && within(card.width, column.width, 0.6) && within(card.x, neighbour.x, 0.6) && within(card.width, neighbour.width, 0.6) && card.y >= 0 && card.y + card.height <= column.height, JSON.stringify({ card, column, neighbour }))
      const rowHeights = await evaluate<number[]>(wc, `[...document.querySelectorAll('.about-group > .pref-row')].map((r) => r.getBoundingClientRect().height)`)
      const minRow = await evaluate<number>(wc, `parseFloat(getComputedStyle(document.querySelector('.about-group > .pref-row')).minHeight)`)
      check('its rows are as tall as a row of the window at least (and under 52 px, the sentence that wraps included), and the links all have the same height', rowHeights.every((h) => h >= minRow - 0.6 && h < 52) && rowHeights.slice(2).every((h) => within(h, rowHeights[2]!, 0.6)), JSON.stringify({ rowHeights, minRow }))
      check('no line of the group overflows its card or is cut', await evaluate<boolean>(wc, `[...document.querySelectorAll('.about-group *')].every((e) => e.scrollWidth <= e.clientWidth + 1 || getComputedStyle(e).display === 'inline')`))
      check('the pane does not scroll sideways', await evaluate<boolean>(wc, `(() => { const c = document.querySelector('.settings-content'); return c.scrollWidth <= c.clientWidth })()`))

      // Quiet: no link to follow, nothing remote, no banner, no notice.
      const loaded = await evaluate<{ anchors: number; remote: number; targets: number }>(
        wc,
        `(() => { const g = document.querySelector('.about-group'); return { anchors: g.querySelectorAll('a, [href]').length, remote: g.querySelectorAll('img, iframe, script, link, video, audio, object, embed, [src], [srcset]').length, targets: g.querySelectorAll('[target]').length } })()`
      )
      check('it holds no link to navigate, no image, no frame, no script and nothing that loads from a distance', loaded.anchors === 0 && loaded.remote === 0 && loaded.targets === 0, JSON.stringify(loaded))
      check('opening it raises no notice, no banner and no dialog', (await evaluate<number>(wc, `document.querySelectorAll('[role=dialog], [role=alertdialog], [role=alert], .toast, .banner, .dialog').length`)) === 0 && browser.snapshot().toast === null && browser.currentPanel() === null)
    }

    // ======================= the links =======================
    const settingsUrl = wc.getURL()
    let navigated = 0
    // An attempt counts even though the surface lock refuses it (see shell/surface-guard.ts).
    wc.on('will-navigate', () => {
      navigated++
    })
    const tabsBefore = tabs().length
    {
      const before = tabs().map((t) => t.id)
      check('a click on “Un projet de ConsilioWeb” …', await clickOn(wc, '.about-link', 'consilioweb.fr'))
      check('…asks for a tab of https://consilioweb.fr', await waitFor(() => asked.includes('https://consilioweb.fr')), JSON.stringify(asked))
      trackTabs()
      const opened = tabs().find((t) => !before.includes(t.id))
      check('…and the tab opens in the browser, selected', !!opened && opened.url.startsWith(`${base}/about-1`) && store.get().activeTabBySpace[opened.spaceId] === opened.id, JSON.stringify(opened?.url))
      check('…the window of the browser comes to the front, the Settings window stays open and on its own page', win.isVisible() && !win.isMinimized() && settingsWindows().length === 1 && wc.getURL() === settingsUrl && navigated === 0, `${wc.getURL()} / navigations ${navigated}`)
    }
    {
      check('“Code source et contributions” …', await clickOn(wc, '.about-link', 'Code source et contributions'))
      check('…asks for a tab of the repository', await waitFor(() => asked.includes(REPOSITORY_URL)), JSON.stringify(asked))
      check('“Signaler un problème” …', await clickOn(wc, '.about-link', 'Signaler un problème'))
      check('…asks for a tab of its issues', await waitFor(() => asked.includes(ISSUES_URL)), JSON.stringify(asked))
      check('“Nouveautés” …', await clickOn(wc, '.about-link', 'Nouveautés'))
      check('…asks for a tab of the releases of the repository', await waitFor(() => asked.includes(RELEASES_URL)), JSON.stringify(asked))
      trackTabs()
      check('each click opened one tab and nothing else', asked.length === 4 && tabs().length === tabsBefore + 4, `${asked.length} asked, ${tabs().length - tabsBefore} tabs`)
      check('the Settings window never navigated', wc.getURL() === settingsUrl && navigated === 0 && settingsWindows().length === 1, `navigations ${navigated}`)
    }
    {
      openedPaths.length = 0
      const countBefore = tabs().length
      const askedBefore = asked.length
      check('“Licences des composants” …', await clickOn(wc, '.about-link', 'Licences des composants'))
      check('…opens the folder of the documentation, the way Aide › Documentation does', await waitFor(() => openedPaths.length === 1) && openedPaths[0]!.endsWith('/docs') && openedPaths[0] === (isBuiltApp() ? join(process.resourcesPath, 'docs') : join(app.getAppPath(), 'docs')), JSON.stringify(openedPaths))
      check('…and opens no tab', tabs().length === countBefore && asked.length === askedBefore)
      // The system refusing to open the folder is reported in the log, with where it happened (Aide › Documentation shows a dialog for a refusal it can read).
      failOpening = true
      errors.length = 0
      await clickOn(wc, '.about-link', 'Licences des composants')
      check('when the system fails to open it, the failure is logged with its context and nothing else happens', await waitFor(() => errors.some((line) => line.includes('[about] cannot open the documentation') && line.includes('forced'))) && tabs().length === countBefore, errors.join(' | ').slice(0, 300))
      failOpening = false
    }

    // ======================= what the main process accepts =======================
    {
      const askedBefore = asked.length
      const countBefore = tabs().length
      openedPaths.length = 0
      warnings.length = 0
      for (const raw of ['https://evil.example/', 'javascript:alert(1)', 'file:///etc/passwd', '../../etc', 'SITE', '', '__proto__', '{"target":"site"}']) {
        await evaluate(wc, `window.lucium.openAbout(${JSON.stringify(raw)})`)
      }
      await evaluate(wc, `window.lucium.openAbout({ target: 'site' })`)
      await evaluate(wc, `window.lucium.openAbout(null)`)
      await evaluate(wc, `window.lucium.openAbout(['site'])`)
      // The witness: the links are messages without an answer; a question asked after them on the same channel is answered only once the main
      // process has handled them (each refusal is logged as it is decided).
      await evaluate(wc, `window.lucium.aboutVersion()`)
      check('anything but the five words (an address, a script, a file, a path, an object) opens nothing and is logged', asked.length === askedBefore && tabs().length === countBefore && openedPaths.length === 0 && warnings.filter((w) => w.includes('[about] ignored')).length === 11, `${warnings.filter((w) => w.includes('[about] ignored')).length} warnings`)
      check('the version comes from the main process: “Version <package.json>”', (await evaluate<string>(wc, `window.lucium.aboutVersion()`)) === app.getVersion())

      // A page that is not one of our surfaces has the same preload but no right to this channel.
      const stranger = new ElectronWindow({ show: false, webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true } })
      try {
        await stranger.loadURL(`${base}/stranger`)
        const has = await evaluate<boolean>(stranger.webContents, `typeof window.lucium?.openAbout === 'function'`)
        warnings.length = 0
        // No wait after it: the question is asked after the link on the same channel, so its answer comes once the link has been handled.
        const reply = await evaluate<string | undefined>(stranger.webContents, `(async () => { window.lucium.openAbout('site'); return await window.lucium.aboutVersion() })()`)
        check('a page that is not one of our surfaces gets no version and opens no tab through them', has && reply === undefined && asked.length === askedBefore && tabs().length === countBefore, `${has} / “${reply}” / ${asked.length - askedBefore} asked`)
        check('…and the refusal is logged', warnings.filter((w) => w.includes('untrusted sender')).length >= 2, warnings.join(' | ').slice(0, 300))
      } finally {
        stranger.destroy()
      }
    }

    // ======================= the version, when the main process fails to answer =======================
    {
      settingsWindows()[0]!.close()
      await waitFor(() => settingsWindows().length === 0)
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })._invokeHandlers
      const original = handlers.get(Channel.aboutVersion)
      check('the version channel is a registered handler (the control for the next check)', typeof original === 'function')
      handlers.set(Channel.aboutVersion, async () => {
        throw new Error('forced: no version')
      })
      pageMessages.length = 0
      try {
        const forced = await openAboutGroup()
        const label = await waitFor(async () => (await text(forced, '.about-version')) === 'Version inconnue')
        check('without an answer, the line says “Version inconnue” and the rest of the group is still there', label && (await forced.executeJavaScript(`document.querySelectorAll('.about-group .about-link').length`)) === ABOUT_ROWS.length, await text(forced, '.about-version'))
        check('…and the failure is written to the console of the window, with its context', pageMessages.some((m) => m.includes('[about] the version could not be read')), pageMessages.join(' | ').slice(0, 300))
      } finally {
        if (original) handlers.set(Channel.aboutVersion, original)
      }
      settingsWindows()[0]?.close()
      await waitFor(() => settingsWindows().length === 0)
      wc = await openAboutGroup()
      check('with the handler back, the version is shown again', (await text(wc, '.about-version')) === `Version ${app.getVersion()}`)
    }
  } finally {
    app.off('web-contents-created', listenToPages)
    console.error = realError
    console.warn = realWarn
    shellMutable.openPath = realOpenPath
    mutable.dispatch = realDispatch
    for (const id of opening) browser.dispatch({ type: 'tab/close', id })
    for (const w of settingsWindows()) w.close()
    await waitFor(() => settingsWindows().length === 0, 3000)
    server.close()
  }
}

export async function runAboutSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    const verbose = process.env['LUCIUM_ABOUT_VERBOSE'] === '1'
    await smokeAbout(ctx, (name, ok, detail) => {
      noteCheck(checks, name, ok, detail)
      if (verbose) console.log(`ABOUT ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail.slice(0, 400)}`}`)
    })
  } catch (error) {
    noteCheck(checks, 'smokeAbout ran to the end', false, String((error as Error)?.stack ?? error))
    console.log(`ABOUT FAIL smokeAbout ran to the end -- ${String((error as Error)?.stack ?? error)}`)
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_ABOUT ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
