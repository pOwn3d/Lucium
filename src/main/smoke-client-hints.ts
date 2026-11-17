// An engine check of the Client Hints that the pages of Lucium send to a site and read for themselves, run inside a real Electron. The pages
// of every session present themselves as a plain Chrome (shared/user-agent.ts, `app.userAgentFallback`). Measured on 13 November 2026: Chromium
// put `Sec-CH-UA`, `Sec-CH-UA-Mobile` and `Sec-CH-UA-Platform` on the image, the script and the image of the other site of a page, and on none of
// the navigations; it never sent a hint a site asks for. Decided the same day: the engine adds the three to the navigations, with the values
// Chromium gives the rest (shared/client-hints.ts), and nothing more. This suite checks that decision.
// A local server is the only outside world. It keeps every header of every request of three pages of one site: a plain one, one whose answer says
// `Accept-CH: Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Model`, and the one opened after it; each page asks
// for an image and a script of its own site and for an image of the other one. The page of each window also reads `navigator.userAgent`,
// `navigator.userAgentData` (brands, mobile, platform) and `getHighEntropyValues`. That is done in four windows: a tab of the normal profile under the
// protection « Standard » and under « Renforcée » (the level a new profile starts with, which also sends Global Privacy Control), a private window
// under « Renforcée », and a window of a second profile under « Renforcée ».
// It writes one line, `LUCIUM_SMOKE_CLIENT_HINTS {…}`, with everything it saw, and keeps it in the report of the run (`clientHints`). Its checks:
// the pages load, the server saw the requests, the page can read what it reads, the window is the one it claims to be, the server received the
// user agent the page reads; and the decision (`judgeHints`): the three hints on each navigation, the values of the other requests on all twelve,
// the brands, the system and the mobile flag the page reads, no hint a site asks for, no brand of a product.
// `LUCIUM_SMOKE_ONLY=client-hints` runs this file alone; LUCIUM_EXTENSIONS is not needed (and better left out: an extension may change these headers).

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app, type WebContents } from 'electron'
import { PRESETS, presetChange, presetOf } from '@shared/settings-presets'
import { chromeUserAgent } from '@shared/user-agent'
import type { Settings } from '@shared/model'
import type { SmokeContext } from './smoke'
import { getWindowManager, MAIN_WINDOW_ID, type WindowRecord } from './shell/windows'
import { closeLeftoverPanels, noteCheck, recorderOf, reportFact, waiterOf, type CheckFn, type CheckRecord } from './smoke-kit'
import {
  ACCEPT_CH,
  ASKED_HINTS,
  clientHintsLine,
  clientHintsReadScript,
  DEFAULT_HINTS,
  flatHeaders,
  HIGH_ENTROPY_HINTS,
  HINT_PHASES,
  HINT_WHATS,
  hintPath,
  hintRequestOf,
  judgeHints,
  settled,
  summarizeHints,
  type HintPhase,
  type HintSummary,
  type HintsVerdict,
  type PageRead,
  type SeenRequest
} from './smoke-probe-kit'

const waitFor = waiterOf(10_000, 60)
/** The longest a page may take to load, with its three subresources, before the suite says it did not. */
const LOAD_MS = 20_000

const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

type Level = 'standard' | 'renforcee'
type Where = 'ordinary' | 'private' | 'profile-window'

interface Variant {
  id: string
  where: Where
  level: Level
  /** In words: what this window is, for the report. */
  what: string
}

/** The windows measured, in order. Each has its own server (its own port, so its own origin): what a site asked for in one never reaches another. */
const VARIANTS: readonly Variant[] = [
  { id: 'ordinary-standard', where: 'ordinary', level: 'standard', what: 'a tab of the normal profile, protection Standard' },
  { id: 'ordinary-renforcee', where: 'ordinary', level: 'renforcee', what: 'a tab of the normal profile, protection Renforcée' },
  { id: 'private-renforcee', where: 'private', level: 'renforcee', what: 'a tab of a private window, protection Renforcée' },
  { id: 'profile-window-renforcee', where: 'profile-window', level: 'renforcee', what: 'a tab of a window of a second profile, protection Renforcée' }
]

/** What one window leaves in the report: where it was measured, what the page read, every request the server saw, and the two put side by side. */
interface VariantReport {
  id: string
  what: string
  protection: { wanted: Level; readBack: string | null }
  session: { profile: string | null; persistent: boolean | null }
  origin: string
  loaded: Record<HintPhase, boolean>
  page: PageRead | null
  requests: SeenRequest[]
  summary: HintSummary
  verdict: HintsVerdict
}

export interface ClientHintsReport {
  engine: { application: string; electron: string; chromium: string; platform: string; arch: string; wantedUserAgent: string | null }
  asked: { acceptCH: string; askedHints: readonly string[]; defaultHints: readonly string[]; highEntropyHints: readonly string[] }
  variants: VariantReport[]
}

export const newClientHintsReport = (): ClientHintsReport => ({
  engine: {
    application: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    chromium: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    wantedUserAgent: chromeUserAgent(process.versions.chrome, process.platform)
  },
  asked: { acceptCH: ACCEPT_CH, askedHints: ASKED_HINTS, defaultHints: DEFAULT_HINTS, highEntropyHints: HIGH_ENTROPY_HINTS },
  variants: []
})

/** The page of a phase: its own image and script, and an image of the other site; its title says when it has loaded all of them. */
const pageHtml = (phase: HintPhase, other: string): string =>
  `<!doctype html><title>client-hints ${phase} pending</title><body>
  <img src="${hintPath(phase, 'img')}" alt="">
  <img src="${other}${hintPath(phase, 'cross-img')}" alt="">
  <script src="${hintPath(phase, 'script')}"></script>
  <script>addEventListener('load', () => { document.title = 'client-hints ${phase} done' })</script></body>`

interface HintServer {
  origin: string
  seen: SeenRequest[]
  stop: () => void
}

/** A server that keeps every request of the plan with its headers, and answers `Accept-CH` on the page of the `ask` phase only. */
async function startHintServer(): Promise<HintServer> {
  const seen: SeenRequest[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const place = hintRequestOf(url.pathname)
    res.setHeader('cache-control', 'no-store')
    if (place === null) {
      res.statusCode = 404
      return void res.end()
    }
    const host = req.headers.host ?? ''
    seen.push({ n: seen.length + 1, phase: place.phase, what: place.what, method: req.method ?? '', host, headers: flatHeaders(req.headers) })
    if (place.what === 'img' || place.what === 'cross-img') {
      res.setHeader('content-type', 'image/gif')
      return void res.end(PIXEL_GIF)
    }
    if (place.what === 'script') {
      res.setHeader('content-type', 'text/javascript; charset=utf-8')
      return void res.end(`window.__script = ${JSON.stringify(place.phase)}`)
    }
    if (place.phase === 'ask') res.setHeader('accept-ch', ACCEPT_CH)
    // The other site of the pair: the page of one holds an image of the other.
    const port = host.split(':')[1] ?? ''
    const other = host.startsWith('localhost') ? `http://127.0.0.1:${port}` : `http://localhost:${port}`
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(pageHtml(place.phase, other))
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  return {
    origin: `http://localhost:${port}`,
    seen,
    stop: () => {
      server.close()
      server.closeAllConnections()
    }
  }
}

export async function smokeClientHints(ctx: SmokeContext, check: CheckFn, report: ClientHintsReport): Promise<void> {
  const { browser, store, engine, win } = ctx
  const manager = getWindowManager()
  const home = store.get().activeSpaceId
  const homeProfile = store.get().spaces.find((space) => space.id === home)?.profileId ?? 'default'
  const secondProfile = 'client-hints-b'
  const prior = { sleepAfterMinutes: store.get().settings.sleepAfterMinutes }
  /** What the protection level had been before the suite changed it, put back at the end (the first value of each setting wins). */
  let restore: Partial<Settings> = {}
  const servers: HintServer[] = []
  const windows: WindowRecord[] = []
  const spaces: string[] = []
  const tabs: Array<{ rec: WindowRecord; id: string }> = []

  const wcOf = (rec: WindowRecord, id: string): WebContents | undefined => (rec.browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  /** Opens a tab in a window and waits for its page to say, by its title, that it loaded its subresources too. */
  const openIn = async (rec: WindowRecord, url: string, title: string): Promise<{ id: string; wc: WebContents | undefined; loaded: boolean }> => {
    rec.browser.dispatch({ type: 'tab/open', url })
    const tab = rec.store.get().tabs.at(-1)
    if (!tab) return { id: '', wc: undefined, loaded: false }
    tabs.push({ rec, id: tab.id })
    const titled = (): boolean => {
      const wc = wcOf(rec, tab.id)
      return wc !== undefined && !wc.isDestroyed() && wc.getTitle() === title
    }
    const loaded = (await waitFor(() => wcOf(rec, tab.id) !== undefined, LOAD_MS)) && (await waitFor(titled, LOAD_MS))
    return { id: tab.id, wc: wcOf(rec, tab.id), loaded }
  }
  /** Gives the protection of the Settings window to the whole application, the way a click on its row does, and answers the level the settings hold then. */
  const setLevel = (level: Level): string | null => {
    const change = presetChange(PRESETS.protection, store.get().settings, level)
    if (change) {
      restore = { ...change.record.undo, ...restore }
      browser.dispatch({ type: 'settings/update', patch: change.patch })
    }
    return presetOf(PRESETS.protection, store.get().settings)
  }
  const seatOf = async (variant: Variant): Promise<{ rec: WindowRecord | null; profile: string | null; why: string }> => {
    if (variant.where === 'ordinary') return { rec: manager.list().find((record) => record.id === MAIN_WINDOW_ID) ?? null, profile: homeProfile, why: 'the main window is gone' }
    if (variant.where === 'private') {
      const rec = manager.openPrivate()
      windows.push(rec)
      return { rec, profile: null, why: '' }
    }
    browser.dispatch({ type: 'space/create', name: 'Client Hints B', emoji: '🔬', hue: 200, profileId: secondProfile })
    const space = store.get().activeSpaceId
    spaces.push(space)
    browser.dispatch({ type: 'space/select', id: home })
    const rec = manager.openWindow({ commandBar: false })
    windows.push(rec)
    rec.browser.dispatch({ type: 'space/select', id: space })
    await waitFor(() => !rec.win.webContents.isLoading(), LOAD_MS)
    return { rec, profile: secondProfile, why: '' }
  }

  win.showInactive()
  const leftover = closeLeftoverPanels(browser)
  if (leftover.length > 0) console.warn(`[client-hints] closed what an earlier suite left over the window: ${leftover.join(', ')}`)
  browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0 } })

  try {
    for (const variant of VARIANTS) {
      const name = (text: string): string => `client hints (${variant.id}): ${text}`
      try {
        const readBack = setLevel(variant.level)
        const seat = await seatOf(variant)
        if (seat.rec === null) {
          check(name('the window to measure exists'), false, seat.why)
          continue
        }
        const rec = seat.rec
        const server = await startHintServer()
        servers.push(server)
        const loaded: Record<HintPhase, boolean> = { baseline: false, ask: false, after: false }
        let page: PageRead | null = null
        let session: VariantReport['session'] = { profile: null, persistent: null }
        for (const phase of HINT_PHASES) {
          const opened = await openIn(rec, `${server.origin}${hintPath(phase, 'page')}`, `client-hints ${phase} done`)
          loaded[phase] = opened.loaded
          // The title says the page is loaded; what the measurement is made of is what the server received, so that is what is waited for.
          await waitFor(() => HINT_WHATS.every((what) => server.seen.some((request) => request.phase === phase && request.what === what)))
          if (phase === 'baseline' && opened.wc && !opened.wc.isDestroyed()) {
            const wc = opened.wc
            session = { profile: engine.profileOfTab(wc.id) ?? null, persistent: wc.session.getStoragePath() !== null }
            // Read on the plain page, before any hint was asked for: what the page reads does not depend on what a site asked.
            page = await settled(wc.executeJavaScript(clientHintsReadScript()) as Promise<PageRead>, (why): PageRead => ({ error: `the script of the page: ${why}` }), 12_000)
          }
        }
        const summary = summarizeHints(server.seen, page)
        const verdict = judgeHints(server.seen, page)
        // What the window itself holds: a private window copies the settings of the main one as it opens, and follows them after.
        const levelOfWindow = presetOf(PRESETS.protection, rec.store.get().settings)
        report.variants.push({
          id: variant.id,
          what: variant.what,
          protection: { wanted: variant.level, readBack: levelOfWindow },
          session,
          origin: server.origin,
          loaded,
          page,
          requests: [...server.seen],
          summary,
          verdict
        })

        const inItsSession =
          variant.where === 'private' ? session.persistent === false : session.persistent === true && session.profile === seat.profile
        check(name('(control) the tab is in the session of that kind of window (a profile of its own, or the throw-away session of a private window)'), inItsSession, JSON.stringify({ session, wantedProfile: seat.profile }))
        check(
          name('(control) the application and the window both hold the protection level that was measured'),
          readBack === variant.level && levelOfWindow === variant.level,
          JSON.stringify({ wanted: variant.level, levelOfTheApplication: readBack, levelOfTheWindow: levelOfWindow, globalPrivacyControlSeenByTheServer: summary.globalPrivacyControl })
        )
        check(name('the three pages load, each asked for its image, its script and the image of the other site, and the server saw all twelve requests'), HINT_PHASES.every((phase) => loaded[phase]) && summary.missing.length === 0, JSON.stringify({ loaded, missing: summary.missing }))
        const lowRead = page !== null && page.error === undefined && page.lowError === undefined && page.jsonError === undefined
        check(name('navigator.userAgentData can be read (brands, mobile, platform) without an error'), lowRead, JSON.stringify(page === null ? 'the page was not read' : { present: page.present, error: page.error, lowError: page.lowError, jsonError: page.jsonError, brands: page.brands, mobile: page.mobile, platform: page.platform }))
        check(name('getHighEntropyValues answers without an error'), page !== null && page.error === undefined && page.highError === undefined, JSON.stringify(page === null ? 'the page was not read' : { error: page.error, highError: page.highError, high: page.high }))
        check(name('every request the server saw carried, as its User-Agent, the navigator.userAgent the page reads'), summary.userAgentAgrees === true, JSON.stringify({ server: summary.userAgentHeaders, page: summary.userAgentOfPage }))
        // The decision of 13 November: the navigations carry the three hints Chromium puts on the rest, and nothing more leaves.
        check(name('the request of each of the three pages carries Sec-CH-UA, Sec-CH-UA-Mobile and Sec-CH-UA-Platform'), summary.missing.length === 0 && verdict.navigationsMissing.length === 0, JSON.stringify({ missing: verdict.navigationsMissing, sent: summary.hintsSent }))
        check(
          name('all twelve requests carry the same three values, those Chromium put on the image of the first page'),
          summary.missing.length === 0 && verdict.reference !== null && verdict.differing.length === 0,
          JSON.stringify({ reference: verdict.reference, differing: verdict.differing.map((key) => ({ key, hints: summary.hintsSent[key] })) })
        )
        check(
          name('the brands of Sec-CH-UA on the navigation are those navigator.userAgentData reads, in the same order, and so are the system and the mobile flag'),
          verdict.brandsAgree && verdict.platformAgrees && verdict.mobileAgrees,
          JSON.stringify({ brands: summary.brands, platform: summary.platform, mobile: summary.mobile })
        )
        check(name('no hint a site asks for with Accept-CH leaves, on any request (full version list, version of the system, architecture, model)'), summary.missing.length === 0 && verdict.detailedSent.length === 0, JSON.stringify(verdict.detailedSent))
        check(name('no brand names a product, in the headers or in what the page reads: neither Lucium, nor Electron, nor Google Chrome'), verdict.productBrands.length === 0, JSON.stringify(verdict.productBrands))
      } catch (error) {
        check(name('the measurement ran to the end'), false, String((error as Error)?.stack ?? error))
      }
    }
  } finally {
    for (const { rec, id } of tabs) if (!rec.win.isDestroyed()) rec.browser.dispatch({ type: 'tab/close', id })
    for (const rec of windows) if (!rec.win.isDestroyed()) rec.win.close()
    await waitFor(() => windows.every((rec) => rec.win.isDestroyed()), 6000)
    await manager.settled()
    browser.dispatch({ type: 'space/select', id: home })
    for (const id of spaces) browser.dispatch({ type: 'space/delete', id })
    browser.dispatch({ type: 'settings/update', patch: { ...restore, ...prior } })
    for (const server of servers) server.stop()
  }
}

/** `LUCIUM_SMOKE_ONLY=client-hints`: only these checks, and one line with everything the suite saw (also kept in the report of the run, as `clientHints`). */
export async function runClientHintsSmoke(ctx: SmokeContext): Promise<number> {
  const checks: CheckRecord[] = []
  const report = newClientHintsReport()
  try {
    await smokeClientHints(ctx, recorderOf(checks), report)
  } catch (error) {
    noteCheck(checks, 'smokeClientHints ran to the end', false, String((error as Error)?.stack ?? error))
  }
  reportFact('clientHints', report)
  const failed = checks.filter((c) => !c.ok)
  console.log(clientHintsLine({ measured: report, checks, failed: failed.length }))
  return failed.length === 0 ? 0 : 1
}
