// The side of `pnpm perf` (scripts/perf.mjs) that runs inside the application, and the engine checks of that side.
//
// `LUCIUM_SMOKE_ONLY=perf` makes the application a measuring target: it prepares the scenario named by LUCIUM_PERF_SCENARIO (settings of the
// registry, then tabs of the local pages the script serves at LUCIUM_PERF_PAGES), says so on its standard output (shared/perf-core.ts, the
// LUCIUM_PERF_* lines) and then does nothing, so that what the script reads from `ps` is the application at rest. In this mode (index.ts
// `measuring`) the gates that the engine test normally leaves out (automatic copies, update look, memory of the windows) are started, because
// they are part of what "all features on" costs. The blocker is offline as in every engine test: its lists are not downloaded.
//
// `runPerfSmoke` is the short check that joins the full chain: the preparation puts the application in the state each scenario says, so that a
// figure of the report means what its name says.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { FEATURES, isFeatureOn } from '@shared/features'
import type { Settings } from '@shared/model'
import { formatMarker, pageHtml, pagePath, PAGE_TITLE_PREFIX, parsePagePath, parsePagesBase, scenarioById, type Marker, type ReadyInfo, type Scenario } from '@shared/perf-core'
import { PERF_SKIPPED, perfFeaturePatch } from '@shared/perf-features'
import { runningGates } from './shell/feature-gate'
import type { FeatureId } from '@shared/features'
import type { SmokeContext } from './smoke'
import { noteCheck, pollUntil, recorderOf, sleep } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = (condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> => pollUntil(condition, timeoutMs, 100)

const DEFAULT_TAB_TIMEOUT_MS = 20_000
const DEFAULT_MAX_SECONDS = 1800

export interface Prepared {
  info: ReadyInfo
  /** The tabs the preparation opened, in order. */
  tabIds: string[]
}

/**
 * Puts the application in the state of the scenario: the features of the registry all on or all off (the others keep their settings), then
 * `tabs` tabs of the pages served at `pagesBase`, each waited for until it shows its title and is not loading (a tab the browser has no state for yet is not loading). Throws, with the page that failed, when a tab does
 * not load or when one of the tabs has no live page afterwards: a measure of tabs that are not there would pass for a good one.
 */
export interface PrepareOptions {
  pagesBase: string
  tabs?: number
  tabTimeoutMs?: number
  /** Only for the checks below, which have to make the two guards fire: what opens a tab, and what tells which pages are alive. */
  open?: (url: string) => void
  livePages?: () => string[]
}

export async function prepareScenario({ browser, store }: SmokeContext, scenario: Scenario, options: PrepareOptions): Promise<Prepared> {
  const tabs = options.tabs ?? scenario.tabs
  let featuresOn: string[] = []
  let featuresOff: string[] = []
  if (scenario.features !== 'default') {
    const plan = perfFeaturePatch(scenario.features)
    browser.dispatch({ type: 'settings/update', patch: plan.patch })
    featuresOn = plan.on
    featuresOff = plan.off
    // The gates start and stop what they own as the state changes: they get the moment before any page exists.
    await sleep(500)
  }
  const tabIds: string[] = []
  for (let index = 1; index <= tabs; index++) {
    const known = new Set(store.get().tabs.map((tab) => tab.id))
    const url = `${options.pagesBase}${pagePath(index)}`
    if (options.open) options.open(url)
    else browser.dispatch({ type: 'tab/open', url })
    const opened = store.get().tabs.find((tab) => !known.has(tab.id))
    if (!opened) throw new Error(`l’onglet ${index} n’a pas été créé`)
    tabIds.push(opened.id)
    const timeout = options.tabTimeoutMs ?? DEFAULT_TAB_TIMEOUT_MS
    const loaded = await waitFor(() => store.get().tabs.find((tab) => tab.id === opened.id)?.title.startsWith(PAGE_TITLE_PREFIX) === true && browser.snapshot().runtime.tabs[opened.id]?.loading !== true, timeout)
    if (!loaded) throw new Error(`la page ${index} (${pagePath(index)}) ne s’est pas chargée en ${timeout} ms`)
  }
  const live = new Set((options.livePages ?? (() => browser.livePageIds()))())
  const liveTabs = tabIds.filter((id) => live.has(id)).length
  if (liveTabs !== tabs) throw new Error(`${tabs} onglets ouverts mais ${liveTabs} seulement ont une page vivante`)
  return { info: { scenario: scenario.id, tabs, featuresOn, featuresOff, liveTabs }, tabIds }
}

/**
 * The features whose gate the measuring mode starts (the four of the window, and the three that index.ts leaves out of an engine test but starts
 * here). “Toutes allumées” measures nothing of them if one is not running: the driver says so rather than report a figure that lacks them.
 */
export const GATES_OF_FEATURES_ON: readonly FeatureId[] = ['sleep', 'little-archive', 'hover-cards', 'favicons', 'auto-backup', 'auto-update', 'restore-windows']

/** `LUCIUM_SMOKE_ONLY=perf`: prepare the scenario, say so, then stay still until the script stops the application. */
export async function runPerfDriver(ctx: SmokeContext): Promise<number> {
  const say = (marker: Marker) => console.log(formatMarker(marker))
  try {
    const scenario = scenarioById(process.env['LUCIUM_PERF_SCENARIO'] ?? '')
    if (!scenario) throw new Error(`scénario inconnu : ${JSON.stringify(process.env['LUCIUM_PERF_SCENARIO'] ?? '')}`)
    const pagesBase = parsePagesBase(process.env['LUCIUM_PERF_PAGES'])
    if (!pagesBase) throw new Error(`LUCIUM_PERF_PAGES doit être http://127.0.0.1:<port> (reçu : ${JSON.stringify(process.env['LUCIUM_PERF_PAGES'] ?? '')})`)
    const { info } = await prepareScenario(ctx, scenario, { pagesBase })
    if (scenario.features === 'on') {
      const missing = GATES_OF_FEATURES_ON.filter((id) => !runningGates().includes(id))
      if (missing.length > 0) throw new Error(`les portails de ${missing.join(', ')} ne tournent pas : la mesure « toutes allumées » ne les compterait pas`)
    }
    say({ kind: 'ready', info })
  } catch (error) {
    // The script waits for one of the two lines: this one stops its wait with the reason.
    console.error('[perf] the scenario could not be prepared:', error)
    say({ kind: 'error', message: String((error as Error)?.message ?? error) })
    // The application exits right after: a pipe may still hold the line.
    await sleep(300)
    return 2
  }
  // A single timer, only a guard for a script that died without stopping the application; it is not a poll.
  const requested = Number(process.env['LUCIUM_PERF_MAX_SECONDS'])
  const seconds = Number.isInteger(requested) && requested >= 10 && requested <= 86_400 ? requested : DEFAULT_MAX_SECONDS
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  console.warn(`[perf] no one stopped the application within ${seconds} s: it quits.`)
  return 0
}

// ---------- the engine checks ----------

async function smokePerf(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store } = ctx
  const settings = () => store.get().settings
  const featureKeys = [...new Set(FEATURES.map((feature) => feature.key))] as Array<keyof Settings>
  const before = Object.fromEntries(featureKeys.map((key) => [key, settings()[key]])) as Partial<Settings>
  const knownTabs = new Set(store.get().tabs.map((tab) => tab.id))
  const requested: string[] = []

  const server = createServer((req, res) => {
    const index = parsePagePath(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    requested.push(req.url ?? '')
    if (index === null) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(pageHtml(index))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const pagesBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const closeNewTabs = async () => {
    for (const tab of store.get().tabs.filter((candidate) => !knownTabs.has(candidate.id))) browser.dispatch({ type: 'tab/close', id: tab.id })
    await sleep(200)
  }
  /** The four gates the window itself ties to the registry in every mode (sleep, little windows, hover cards, site icons). */
  const gatedHere = ['sleep', 'little-archive', 'hover-cards', 'favicons'] as const

  try {
    const answer = await fetch(`${pagesBase}${pagePath(7)}`)
    const text = await answer.text()
    check('perf: the page server answers a page with its title, and nothing else', answer.status === 200 && text.includes(`<title>${PAGE_TITLE_PREFIX}7</title>`) && (await fetch(`${pagesBase}/autre`)).status === 404)

    // ---- the tabs ----
    const tabsScenario = scenarioById('tabs-10')!
    const prepared = await prepareScenario(ctx, tabsScenario, { pagesBase, tabs: 3 })
    check('perf: three tabs are opened, each one loaded and alive', prepared.tabIds.length === 3 && prepared.info.liveTabs === 3 && prepared.tabIds.every((id) => store.get().tabs.find((tab) => tab.id === id)?.title.startsWith(PAGE_TITLE_PREFIX)), JSON.stringify(prepared.info))
    check('perf: …each from its own page of the server', [1, 2, 3].every((index) => requested.some((url) => url === pagePath(index))), requested.join(' '))
    check('perf: a scenario of default settings touches no setting', prepared.info.featuresOn.length === 0 && prepared.info.featuresOff.length === 0 && featureKeys.every((key) => settings()[key] === before[key]))
    await closeNewTabs()

    // ---- every feature off ----
    const off = await prepareScenario(ctx, scenarioById('features-off')!, { pagesBase, tabs: 1 })
    check('perf: “toutes coupées” switches every registered feature off', FEATURES.every((feature) => !isFeatureOn(settings(), feature.id)), FEATURES.filter((feature) => isFeatureOn(settings(), feature.id)).map((feature) => feature.id).join())
    check('perf: …none of their gates is running', gatedHere.every((id) => !runningGates().includes(id)), runningGates().join())
    check('perf: …and the report lists all of them as off', off.info.featuresOff.length === FEATURES.length && off.info.featuresOn.length === 0)
    await closeNewTabs()

    // ---- every feature on ----
    const on = await prepareScenario(ctx, scenarioById('features-on')!, { pagesBase, tabs: 1 })
    const wrong = FEATURES.filter((feature) => isFeatureOn(settings(), feature.id) === Object.hasOwn(PERF_SKIPPED, feature.id)).map((feature) => feature.id)
    check('perf: “toutes allumées” switches every feature on, but those it lists as left aside', wrong.length === 0, wrong.join())
    check('perf: …their gates are running', gatedHere.every((id) => runningGates().includes(id)), runningGates().join())
    check('perf: …and the report names the features on and the ones left off', on.info.featuresOn.length === FEATURES.length - Object.keys(PERF_SKIPPED).length && on.info.featuresOff.length === Object.keys(PERF_SKIPPED).length)
    await closeNewTabs()

    // ---- the two guards of the preparation ----
    let notCreated = ''
    try {
      await prepareScenario(ctx, tabsScenario, { pagesBase, tabs: 1, open: () => undefined })
    } catch (error) {
      notCreated = String((error as Error).message)
    }
    check('perf: a tab that is not created stops the preparation', /l’onglet 1 n’a pas été créé/.test(notCreated), notCreated)
    let notAlive = ''
    try {
      await prepareScenario(ctx, tabsScenario, { pagesBase, tabs: 1, livePages: () => [] })
    } catch (error) {
      notAlive = String((error as Error).message)
    }
    check('perf: tabs that are open but have no live page stop the preparation, saying how many are alive', /1 onglets ouverts mais 0 seulement ont une page vivante/.test(notAlive), notAlive)
    await closeNewTabs()

    // ---- a page that does not load stops the preparation ----
    server.close()
    server.closeAllConnections()
    let failure = ''
    try {
      await prepareScenario(ctx, tabsScenario, { pagesBase, tabs: 1, tabTimeoutMs: 1500 })
    } catch (error) {
      failure = String((error as Error).message)
    }
    check('perf: a page that does not load stops the preparation, naming the page', /la page 1 .*ne s’est pas chargée/.test(failure), failure)
    await closeNewTabs()

    // ---- the lines the script reads ----
    check('perf: the line that says the scenario is ready is the one the script reads', formatMarker({ kind: 'ready', info: on.info }).startsWith('LUCIUM_PERF_READY {"scenario":"features-on"'))
  } finally {
    server.close()
    server.closeAllConnections()
    await closeNewTabs()
    browser.dispatch({ type: 'settings/update', patch: before })
  }
}

/** The short check of the full chain (and of `LUCIUM_SMOKE_ONLY` runs that do not name `perf`): the preparation of the scenarios, not their measure. */
export async function runPerfSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokePerf(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokePerf ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_PERF ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
