// The translation of the page on screen: what the panel "Traduire cette page" asks, one request at a time. It reads the page's text through an isolated world of
// the page, gives it to the engine of the pack in batches, puts the answer back, and can put the original back. Everything it needs from the outside (the page,
// the files, the network, the system's folder box, the engines) is handed in, so that the tests drive it with a page of their own and an engine of their own.
//
// Rules it keeps: nothing is fetched except by the two requests that say so (`lookup`, `download`), each after the user's click, and `download` only fetches
// what the last `lookup` showed; a window without disk (private) never writes a model; a page is left exactly as it was when anything fails.
//
// The engine of a pair: the system's own translation when the system has the pair installed (macOS, engines.ts `systemEngineFor`); else its Bergamot
// model when the engine's binary is there; else its glossary if it has one (shared/translate-local.ts `usablePacks`). The system is asked about a pair
// only for a page: when the panel shows one (its opening, « Traduire »), and before each translation, the one-click ones and the one of a page that
// loads in a language of « Toujours traduire » too (a tab restored in such a language asks it as the application starts). Never from the Settings
// window, and never while the function is off. It never downloads a language: a pair it supports but has not installed goes to the packs, and the
// panel offers the pane of the system's settings where it is installed.
// The binary is looked up and downloaded with the first model, on the same clicks, and shown in the same list of files with its address and size.
//
// The translation in one click (the toolbar button, « Traduire en <langue> » of the page's menu and of File, « Toujours traduire <langue> »): the same
// translation, of the pair the panel would propose, without the panel (`quick`, `quickTab`, `autoTranslate`). Each tab has its own state (under way,
// translated), which the toolbar shows; the translations take their turn, one at a time, and a page shown in its original (or left) while its translation
// waited is not translated.

import { applyLanguage, getLanguage, t, tp } from '@shared/i18n'
import type { Settings, TabTranslation } from '@shared/model'
import { neverTranslated, translatesByItself, withAlwaysLanguage, withNeverSite } from '@shared/translate-quick'
import {
  CATALOGUE_LIMITS,
  NO_DETECTION,
  RELEASE_ENV,
  RUNTIME_CATALOGUE_URL,
  catalogueUrl,
  detectLanguage,
  formatSize,
  parseCatalogue,
  parseRuntimeCatalogue,
  planRoute,
  proposedPair,
  targetLanguage,
  usablePacks,
  wireBytes,
  type DownloadPlan,
  type EngineId,
  type FilterEnv,
  type InstalledPack,
  type PackEngine,
  type PackManifest,
  type RuntimePlan,
  type SystemAvailability,
  type TranslateRequest,
  type TranslateState,
  type TranslateView
} from '@shared/translate-local'
import { applyScript, extractScript, readApplyReply, readExtractReply, readSampleReply, restoreScript, sampleScript } from '@shared/translate-page-script'
import type { EngineContext, EngineModel, EngineRegistry } from './engines'
import { packRoute, type RouteMemory, type RoutePack, type TranslationMemory } from './memory'
import { BadReply, translatePass } from './pass'
import { downloadPack, downloadRuntime, sweepStaging, type Fetch } from './download'
import { GLOSSARY_ASIDE, adoptFolder, listPacks, packDir, packDirOf, packSignature, readManifest, readRuntimeManifest, removePack, verifiedKey, verifyPack } from './pack-store'
import { urlHostname } from '@shared/url'
import { settingsPath } from '@shared/settings-path'

export interface TranslatePage {
  url: string
  /** The tab of the page: each tab's translation is its own (the toolbar button shows it). Absent: a single page (the tests). */
  id?: string
  /** A private tab, or a page of a private window: nothing of it is written to the settings (« Toujours traduire », « Ne jamais traduire ce site »). */
  private?: boolean
  /** Runs a script in the translation world of this page and answers what it returned. */
  run(code: string): Promise<unknown>
}

/** What asked for a translation: the panel's « Traduire », one click without the panel, or a page that loaded in a language always translated. */
type Via = 'panel' | 'quick' | 'auto'

/** The settings the one-click translation writes (the interface never names the site: the main process reads it from the page). */
export type QuickSettingsPatch = Partial<Pick<Settings, 'translateAlways' | 'translateNeverSites' | 'translateSystemNoticeSeen'>>

const keyOf = (page: TranslatePage): string => page.id ?? ''

export interface TranslateDeps {
  settings(): Settings
  /** The page on screen, or null when there is none. */
  page(): TranslatePage | null
  /** A window that writes nothing to disk. */
  readOnly: boolean
  defaultDir: string
  /** The folder of the engine's own files (userData/translation-engine): fixed, never one the interface or the settings name. */
  engineDir: string
  engines: EngineRegistry
  fetch: Fetch
  /** The system the filters of Mozilla's records are read for; macOS when not given. */
  filterEnv?: FilterEnv
  /** The system's box that chooses a folder; null when cancelled. */
  chooseFolder(): Promise<string | null>
  /** Saves the chosen folder in the settings (only the main process does: the interface cannot name a path). */
  saveFolder(path: string): void
  systemLocale(): string
  /** Opens the pane of the system's settings where its translation languages are installed; absent on a system that has no such link. */
  openSystemSettings?: () => void
  /** The page of a tab, on screen or not (a page translated by itself as it loads, the menu of a page). */
  pageOf?(tabId: string): TranslatePage | null
  /** The translation of a tab changed: under way, done, or gone (null). The toolbar button and the menus follow it. */
  tabChanged?(tabId: string, translation: TabTranslation | null): void
  /** Writes the settings of the one-click translation (the main process' store; a private window keeps nothing). */
  saveSettings?(patch: QuickSettingsPatch): void
  /** macOS translated a page in one click for the first time: the one-time notice that Apple may count the use of its translation (never the text). */
  systemNotice?(): void
  /**
   * The translations of this session, in memory (memory.ts): a text met again is not translated again. Absent: nothing is kept. Never used for a
   * private window or a private tab (`memoryFor`).
   */
  memory?: TranslationMemory
}

const isWebPage = (url: string): boolean => /^https?:\/\//i.test(url)
const originOf = (url: string): string | null => (URL.canParse(url) ? new URL(url).origin : null)

/** A lookup that did not get a list: the reason the panel shows. */
class LookupFailure extends Error {}

/** What a lookup offers: the models of the pair (unless the same ones are installed), the engine's binary (unless it is there), and what it all weighs. */
interface Offer {
  plan: DownloadPlan
  models: boolean
  runtime: RuntimePlan | null
  catalogue: string
}

export class TranslateController {
  private state: TranslateView['state'] = 'idle'
  private message = ''
  /** The page the last sentence is about (a translation's): the panel shows it on that page only. Undefined: about no page (the models, the folder). */
  private messageKey: string | undefined = undefined
  private offer: Offer | null = null
  /** The download under way, which « Arrêter » stops. */
  private stop: AbortController | null = null
  /** The translation under way, and the page it is for: « Afficher l'original » on that page stops it. */
  private running: { key: string; abort: AbortController } | null = null
  /** The translation of each tab: under way (or waiting its turn) and translated. Forgotten when the page goes back to its original or to another document. */
  private readonly tabs = new Map<string, TabTranslation>()
  /** Counts, per page, the originals asked for and the documents left: a translation that waited its turn for an older one does not run. */
  private readonly generation = new Map<string, number>()
  /** One operation at a time: the translations wait their turn, the other operations are refused while one holds it or waits (`waiting`). */
  private turn: Promise<void> = Promise.resolve()
  private waiting = 0
  /** The one-time notice of macOS's translation was given by this window (a private window cannot write that it was). */
  private noticeGiven = false
  /** The leftovers of a download that was cut short are looked for once, the first time the panel is read. */
  private swept = false
  /** The pair the person last asked to translate: the route (and the models to look for) follow it, not only what was detected. Forgotten when the panel opens. */
  private wanted: readonly [string, string] | null = null
  /**
   * Packs whose fingerprints were checked in this session (pair@version), with how the pack looked on disk when they were: the check reads every file, so it is
   * not repeated while nothing was written, but a file changed or replaced since (the signature differs) is checked again, whatever happened before.
   */
  private readonly verified = new Map<string, { dir: string; manifest: PackManifest; signature: string }>()
  /** What the system's translation said of the pair shown: asked once each time the panel opens, and again before each translation. */
  private systemSaid: { pair: string; status: SystemAvailability } | null = null

  constructor(private readonly deps: TranslateDeps) {}

  /** What the system's translation says of a pair (null: this system has none). `fresh` asks again rather than reuse what it said of the same pair. */
  private async systemStatus(from: string, to: string, fresh: boolean): Promise<SystemAvailability | null> {
    const system = this.deps.engines.system
    // Off in the settings (`translateSystemEngine`): the system is never asked, the panel goes straight to the packs.
    if (!system || this.deps.settings().translateSystemEngine === false) return null
    const pair = `${from}-${to}`
    if (!fresh && this.systemSaid?.pair === pair) return this.systemSaid.status
    const status = await system.availability(from, to)
    this.systemSaid = { pair, status }
    return status
  }

  private get dir(): string {
    return this.deps.settings().translateModelsDir || this.deps.defaultDir
  }

  private get context(): EngineContext {
    return { runtimeDir: this.deps.engineDir }
  }

  private sayInLanguage(): void {
    // The sentences are read in the language of the interface, which is the process' (set by the settings).
    applyLanguage(this.deps.settings(), this.deps.systemLocale())
  }

  /** What the page answered a script, of any shape: each caller reads it with the reader of that script (translate-page-script.ts). Null when it did not answer. */
  private async run(page: TranslatePage, code: string): Promise<unknown> {
    try {
      return await page.run(code)
    } catch (error) {
      console.warn('[translate] the page did not answer a script:', error instanceof Error ? error.message : String(error))
      return null
    }
  }

  /** What the panel shows now: the page, its language, the packs, the route. Reads the page's text sample (no network). */
  async view(wantsPage = true): Promise<TranslateView> {
    this.sayInLanguage()
    const settings = this.deps.settings()
    const page = this.deps.page()
    const key = page ? keyOf(page) : undefined
    // The state is the page's own (another tab may be the one translated); the last sentence is said on the page it is about.
    const own = key !== undefined ? this.tabs.get(key) : undefined
    const ours = this.messageKey === undefined || this.messageKey === key
    const state: TranslateState = own?.state ?? (ours && this.state !== 'translated' ? this.state : 'idle')
    // The function off in the settings: the page is not read and the system is not asked, whatever the view is for (the panel then says it is off).
    const readPage = wantsPage && settings.translateLocal
    if (!this.swept && !this.deps.readOnly) {
      this.swept = true
      await sweepStaging(this.dir)
    }
    const packs = await listPacks(this.dir, await this.stillVerified())
    const ready = await this.deps.engines.ready(this.context)
    const target = targetLanguage(settings, getLanguage())
    let detection = NO_DETECTION
    if (readPage && page && isWebPage(page.url)) {
      const sample = readSampleReply(await this.run(page, sampleScript()))
      if (sample) detection = detectLanguage(sample.text, sample.lang)
    }
    const shown = readPage && page !== null && isWebPage(page.url) ? page : null
    // The pair the panel starts from: never a pair that goes nowhere (a page already in the target language is proposed another target).
    const proposed = shown ? proposedPair(detection, target, getLanguage()) : null
    const [from, to] = this.wanted ?? [proposed?.from ?? '', proposed?.to ?? target]
    const pairShown: [string, string] | null = from && to && from !== to ? [from, to] : null
    // The system is asked about the pair only for a view of a page (the panel), never for the Settings window's (`packs`).
    const system = shown && pairShown ? await this.systemStatus(pairShown[0], pairShown[1], false) : null
    const bySystem = system === 'installed'
    const route = pairShown && !bySystem ? planRoute(usablePacks(packs, ready), pairShown[0], pairShown[1]) : null
    const pair = route && !route.ok ? route.missing[0] : undefined
    const using: EngineId[] = bySystem ? ['system'] : route?.ok ? [...new Set(route.steps.map((step) => step.engine))] : []
    return {
      enabled: settings.translateLocal,
      readOnly: this.deps.readOnly,
      page: shown ? { host: urlHostname(shown.url), detection } : null,
      target,
      proposed,
      packs,
      engines: this.deps.engines.ids(),
      ready,
      // A pair the system translates needs no pack: nothing to look up.
      route: bySystem && pairShown ? { ok: true, steps: [pairShown] } : route ? (route.ok ? { ok: true, steps: route.steps.map((step) => [step.from, step.to]) } : route) : null,
      state,
      message: ours ? this.message : '',
      offer: this.offer ? this.offerView(this.offer) : null,
      folder: { path: this.dir, isDefault: !settings.translateModelsDir },
      lookupUrl: pair ? catalogueUrl(pair[0], pair[1]) : null,
      system: this.deps.engines.system ? { kind: this.deps.engines.system.kind, status: system ?? 'unknown', settingsLink: this.deps.openSystemSettings !== undefined } : null,
      using
    }
  }

  /** The files of an offer as the panel lists them: each address and size, the engine's binary named as such, and the total that goes over the network. */
  private offerView(offer: Offer): NonNullable<TranslateView['offer']> {
    const models = offer.models ? offer.plan.files.map(({ name, url, size, transfer }) => ({ name, url, size: transfer?.size ?? size, kind: 'model' as const })) : []
    const engine = offer.runtime ? [{ name: offer.runtime.file.name, url: offer.runtime.file.url, size: wireBytes(offer.runtime.file), kind: 'engine' as const }] : []
    const files = [...engine, ...models]
    return {
      from: offer.plan.from,
      to: offer.plan.to,
      catalogue: offer.catalogue,
      files,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      diskBytes: (offer.models ? offer.plan.diskBytes : 0) + (offer.runtime?.file.size ?? 0)
    }
  }

  /** One request from the panel or the toolbar button's popover. Never throws; the view says how it went. */
  async handle(request: TranslateRequest): Promise<TranslateView> {
    this.sayInLanguage()
    if (!this.deps.settings().translateLocal) return this.say('error', t('translate.msg-off', { settingsPath: settingsPath('translate') }))
    if (request.action === 'restore') return this.restore(this.deps.page())
    if (request.action === 'refresh') {
      this.wanted = null
      // The person may have installed a language in the system's settings since: the system is asked again.
      this.systemSaid = null
      return this.view()
    }
    if (request.action === 'packs') return this.view(false)
    if (request.action === 'system-settings') return this.openSystemSettings()
    if (request.action === 'quick') return this.quick(this.deps.page(), request.to)
    if (request.action === 'always') return this.setAlways(request.language, request.on)
    if (request.action === 'never-site') return this.setNeverSite(request.on)
    // A translation waits for its turn; the panel's other operations are refused while one holds it.
    if (request.action === 'run') {
      const page = this.deps.page()
      // Counted now, before the wait: the original asked for, or the tab gone to another document, while it waited, and it does not run.
      const generation = page ? (this.generation.get(keyOf(page)) ?? 0) : 0
      return this.inTurn(() => this.translate(request.from, request.to, page, 'panel', undefined, generation))
    }
    if (this.waiting > 0) return this.say(this.state, t('translate.msg-busy'))
    return this.inTurn(async () => {
      switch (request.action) {
        case 'lookup':
          return await this.lookup(request.from, request.to)
        case 'download':
          return await this.download(request.from, request.to)
        case 'adopt':
          return await this.adopt(request.from, request.to)
        case 'remove':
          return await this.remove(request.from, request.to, request.engine)
        case 'folder':
          return await this.chooseFolder()
        case 'folder-default':
          return await this.useDefaultFolder()
      }
    })
  }

  /** Runs `job` once the operation before it has ended, and holds the turn until it ends. */
  private async inTurn<T>(job: () => Promise<T>): Promise<T> {
    const previous = this.turn
    let done: () => void = () => undefined
    this.turn = new Promise<void>((resolve) => (done = resolve))
    this.waiting++
    try {
      await previous
      return await job()
    } finally {
      this.waiting--
      done()
    }
  }

  // ---------- the translation in one click ----------

  /** The translation of a page changed: kept here, and told to the toolbar. Nothing is told when nothing changed. */
  private setTab(key: string, translation: TabTranslation | null): void {
    const known = this.tabs.get(key)
    const same = translation === null ? known === undefined : known?.state === translation.state && known.from === translation.from && known.to === translation.to
    if (same) return
    if (translation === null) this.tabs.delete(key)
    else this.tabs.set(key, translation)
    this.deps.tabChanged?.(key, translation)
  }

  private bump(key: string): void {
    this.generation.set(key, (this.generation.get(key) ?? 0) + 1)
  }

  /**
   * The pair a page is translated with in one click: what its text is written in, into the target (`proposedPair`, as the panel would propose it), or into
   * `to` (« Autre langue… »). A translated page keeps the language it was translated from (its text reads in the target now). Null when the language of the
   * page is not told, or the pair would go nowhere.
   */
  private async quickPair(page: TranslatePage, to: string | undefined): Promise<[string, string] | null> {
    const known = this.tabs.get(keyOf(page))
    if (known) return known.from !== (to ?? known.to) ? [known.from, to ?? known.to] : null
    const sample = readSampleReply(await this.run(page, sampleScript()))
    const detection = sample ? detectLanguage(sample.text, sample.lang) : NO_DETECTION
    const proposed = proposedPair(detection, to ?? targetLanguage(this.deps.settings(), getLanguage()), getLanguage())
    // Another language chosen, the one the text is written in: from the language the page says it is in, if it says another one.
    const from = to !== undefined && proposed.from === to ? (detection.declared ?? '') : proposed.from
    const into = to ?? proposed.to
    return from !== '' && from !== into ? [from, into] : null
  }

  /** Translates a page in one click, without the panel: the toolbar button's popover, the page's menu, File, « Toujours traduire » switched on. */
  private async quick(page: TranslatePage | null, to?: string, via: Via = 'quick'): Promise<TranslateView> {
    if (!page || !isWebPage(page.url)) return this.say('error', t('translate.msg-not-web'))
    const known = this.tabs.get(keyOf(page))
    // Under way, or already in that language: nothing more to do.
    if (known?.state === 'working' || (known?.state === 'translated' && (to === undefined || to === known.to))) return this.view()
    const pair = await this.quickPair(page, to)
    if (!pair) return this.say('error', t('translate.msg-no-language'), keyOf(page))
    return this.translateInTurn(page, pair[0], pair[1], via)
  }

  /** A one-click translation: the button says « under way » at once, the translation waits for its turn, and does not run if the original was asked meanwhile. */
  private async translateInTurn(page: TranslatePage, from: string, to: string, via: Via): Promise<TranslateView> {
    const key = keyOf(page)
    const generation = this.generation.get(key) ?? 0
    const before = this.tabs.get(key) ?? null
    this.setTab(key, { state: 'working', from, to })
    return this.inTurn(async () => {
      if ((this.generation.get(key) ?? 0) !== generation) return this.view()
      // Translated into another language: the original first (an engine translates the page's own text, never a translation).
      if (before?.state === 'translated') await this.run(page, restoreScript())
      return this.translate(from, to, page, via, null)
    })
  }

  /** The menu of a page (« Traduire en <langue> ») or File asked for the translation of a tab: an error in the answer says the panel is needed. */
  async quickTab(tabId: string): Promise<TranslateView> {
    this.sayInLanguage()
    if (!this.deps.settings().translateLocal) return this.say('error', t('translate.msg-off', { settingsPath: settingsPath('translate') }))
    return this.quick(this.deps.pageOf?.(tabId) ?? null)
  }

  /** « Afficher l'original » from the page's menu or File, for a tab. */
  async restoreTab(tabId: string): Promise<TranslateView> {
    this.sayInLanguage()
    const page = this.deps.pageOf?.(tabId) ?? null
    return page ? this.restore(page) : this.view()
  }

  /**
   * A page finished loading in another language than the target (`TabRuntime.pageLanguage`): it is translated by itself when its language is one of
   * « Toujours traduire » and its site is not one of « Ne jamais traduire ce site » (`translatesByItself`). What its words say decides, not only its `lang`:
   * a page that says it is in English but is written in the target language is left alone. Never opens anything; a failure leaves the page as it was.
   */
  async autoTranslate(tabId: string): Promise<void> {
    this.sayInLanguage()
    const settings = this.deps.settings()
    const page = this.deps.pageOf?.(tabId) ?? null
    if (!page || !settings.translateLocal || this.tabs.has(keyOf(page))) return
    const sample = readSampleReply(await this.run(page, sampleScript()))
    if (!sample) return
    const language = detectLanguage(sample.text, sample.lang).language ?? ''
    const target = targetLanguage(settings, getLanguage())
    if (!translatesByItself(settings, page.url, language, target) || this.tabs.has(keyOf(page))) return
    const view = await this.translateInTurn(page, language, target, 'auto')
    if (view.state === 'error') console.warn(`[translate] the page of tab ${tabId} was not translated by itself (${language} → ${target}); it stays as it was`)
  }

  /** The page of a tab went to another document, or the tab closed: its translation is over (one under way is stopped, one waiting will not run). */
  forgetTab(tabId: string): void {
    this.bump(tabId)
    if (this.running?.key === tabId) this.running.abort.abort()
    this.setTab(tabId, null)
    if (this.messageKey === tabId) this.messageKey = undefined
  }

  /** The tab's page translated, or being translated (the page's menu then offers « Afficher l'original »); null otherwise. */
  translationOf(tabId: string): TabTranslation | null {
    return this.tabs.get(tabId) ?? null
  }

  /** « Toujours traduire <langue> »: put in or taken out of the settings; switched on for the page on screen, not translated, it is translated now. */
  private async setAlways(language: string, on: boolean): Promise<TranslateView> {
    const page = this.deps.page()
    const blocked = this.refuseLists(page)
    if (blocked) return blocked
    const settings = this.deps.settings()
    this.deps.saveSettings?.({ translateAlways: withAlwaysLanguage(settings.translateAlways, language, on) })
    if (on && page && isWebPage(page.url) && !this.tabs.has(keyOf(page)) && !neverTranslated(settings.translateNeverSites, page.url)) return this.quick(page)
    return this.view()
  }

  /** « Ne jamais traduire ce site », for the site of the page on screen; switched on while the page is translated, its original comes back. */
  private async setNeverSite(on: boolean): Promise<TranslateView> {
    const page = this.deps.page()
    if (!page || !isWebPage(page.url)) return this.say('error', t('translate.msg-not-web'))
    const blocked = this.refuseLists(page)
    if (blocked) return blocked
    this.deps.saveSettings?.({ translateNeverSites: withNeverSite(this.deps.settings().translateNeverSites, page.url, on) })
    if (on && this.tabs.has(keyOf(page))) return this.restore(page)
    return this.view()
  }

  /** The lists are settings: a private window keeps none, and the site of a private tab is never written down. */
  private refuseLists(page: TranslatePage | null): Promise<TranslateView> | null {
    return this.deps.readOnly || page?.private === true ? this.say('error', t('translate.msg-lists-private'), page ? keyOf(page) : undefined) : null
  }

  /** The first time macOS translated a page: said once out of the panel (the full panel says it whenever macOS is its engine), and remembered. */
  private noticeSystem(via: Via): void {
    if (this.noticeGiven || this.deps.settings().translateSystemNoticeSeen) return
    this.noticeGiven = true
    this.deps.saveSettings?.({ translateSystemNoticeSeen: true })
    if (via !== 'panel') this.deps.systemNotice?.()
  }

  /** The pack of a pair, just written and checked by whoever wrote it, counts as verified. */
  private async markVerified(from: string, to: string): Promise<void> {
    const dir = packDir(this.dir, from, to)
    const manifest = dir ? await readManifest(dir, from, to) : null
    if (dir && manifest) this.verified.set(verifiedKey(`${from}-${to}`, manifest.version), { dir, manifest, signature: await packSignature(dir, manifest) })
  }

  /** The checks remembered for the packs of a pair (its folder and a glossary set aside): forgotten when one of them is written or removed. */
  private forgetVerified(from: string, to: string): void {
    for (const key of [...this.verified.keys()]) if (key.startsWith(`${from}-${to}@`) || key.startsWith(`${from}-${to}${GLOSSARY_ASIDE}@`)) this.verified.delete(key)
  }

  /** The keys of the packs still verified: those whose files are as they were when they were checked. */
  private async stillVerified(): Promise<Set<string>> {
    for (const [key, entry] of [...this.verified]) if ((await packSignature(entry.dir, entry.manifest)) !== entry.signature) this.verified.delete(key)
    return new Set(this.verified.keys())
  }

  /** `key`: the page the sentence is about (the panel says it on that page only); none for what is about no page (the models, the folder). */
  private async say(state: TranslateView['state'], message: string, key?: string): Promise<TranslateView> {
    this.state = state
    this.message = message
    this.messageKey = key
    return this.view()
  }

  /** Writing to the disk (a model, the folder) is not for a window that keeps nothing. */
  private refuseWrite(): Promise<TranslateView> | null {
    return this.deps.readOnly ? this.say('error', t('translate.msg-private')) : null
  }

  /**
   * THE GUARD of the memory: what a page of `route` may reuse and add to. A private window or a private tab neither reads it nor adds to it: nothing of
   * its text stays after it. And a page only meets the translations of its own origin: what the memory knows is put in the page before the rest,
   * which the page can observe, so a memory common to every site would tell one site which sentences were translated on another.
   */
  private memoryFor(page: TranslatePage, route: string): RouteMemory | null {
    const origin = originOf(page.url)
    if (!this.deps.memory || this.deps.readOnly || page.private === true || origin === null) return null
    return this.deps.memory.of(`${origin}\u0001${route}`)
  }

  /**
   * Whether the tab of `page` now shows a document of another site than the one `page` was read on (or has no page any more). A page without a tab
   * (a single page) and a window that cannot look a tab up are not said to have moved.
   */
  private movedAway(page: TranslatePage): boolean {
    if (page.id === undefined || !this.deps.pageOf) return false
    const now = this.deps.pageOf(page.id)
    return !now || originOf(now.url) !== originOf(page.url)
  }

  // ---------- translating ----------

  /**
   * Translates `page` from a language to another. `previous`: what the page's translation was before this one was asked (the panel's « Traduire » on a page
   * already translated leaves it translated). The tab's state is `working` while it runs, then `translated`, or nothing when it failed or was stopped.
   * `asked`: the count of the page (`generation`) when the translation was asked, before it waited for its turn; the count as it is now when not given.
   *
   * `page` was read when the translation was asked: its address is the one of that moment, and its script runs in whatever document the tab shows
   * now. So the page is not read (nor anything put in it) once the tab left that document: its text would be translated with the pair chosen for
   * the other one, and kept in the memory of the other site.
   */
  private async translate(
    from: string,
    to: string,
    page: TranslatePage | null,
    via: Via,
    previous: TabTranslation | null = page ? (this.tabs.get(keyOf(page)) ?? null) : null,
    asked?: number
  ): Promise<TranslateView> {
    // The panel shows the pair asked last; a page translated by itself, maybe in the background, does not change it.
    if (via !== 'auto') this.wanted = [from, to]
    if (!page || !isWebPage(page.url)) return this.say('error', t('translate.msg-not-web'), page ? keyOf(page) : undefined)
    const key = keyOf(page)
    const generation = asked ?? this.generation.get(key) ?? 0
    /** The original was asked for, or the tab went to another document (`restore`, `forgetTab`), since this translation was asked: each said the tab's state already. */
    const gone = (): boolean => (this.generation.get(key) ?? 0) !== generation
    if (gone()) return this.view()
    // Every way out says the page's state first: the view it answers shows it.
    const end = (state: TranslateState, message: string, after: TabTranslation | null = null): Promise<TranslateView> => {
      this.setTab(key, after)
      return this.say(state, message, key)
    }
    // The system's own translation first, when it has the pair installed (asked again now: a language can be removed in the system's settings).
    const system = this.deps.engines.system
    const said = await this.systemStatus(from, to, true)
    const bySystem = system !== null && said === 'installed'
    let steps: InstalledPack[] = []
    if (!bySystem) {
      const packs = await listPacks(this.dir, await this.stillVerified())
      const ready = await this.deps.engines.ready(this.context)
      const route = planRoute(usablePacks(packs, ready), from, to)
      if (!route.ok) {
        const pairs = route.missing.map(([a, b]) => `${a} → ${b}`).join(', ')
        // A pack this build has no engine for says so; a pair the system could translate once installed says where; a model whose engine's binary is not downloaded yet says that.
        const unknown = packs.find((pack) => route.missing.some(([a, b]) => pack.from === a && pack.to === b) && !this.deps.engines.get(pack.engine))
        if (unknown) return end('error', t('translate.msg-no-engine', { engine: unknown.engine }), previous)
        if (said === 'supported') return end('error', t('translate.msg-system-not-installed', { from, to }), previous)
        const waiting = packs.some((pack) => pack.engine === 'bergamot' && !ready.includes('bergamot') && route.missing.some(([a, b]) => pack.from === a && pack.to === b))
        return end('error', waiting ? t('translate.msg-runtime-missing', { pairs }) : t('translate.msg-no-route', { pairs }), previous)
      }
      if (route.steps.length === 0) return end('idle', t('translate.msg-same-language'), previous)
      steps = route.steps
    }
    // The system and the folder of the packs were asked meanwhile (the system may take seconds): nothing was under way that a stop could end.
    if (gone()) return this.view()
    // Every pack on the route is checked and its engine loaded before the page is touched.
    const models: EngineModel[] = []
    const release = (): void => models.forEach((model) => model.dispose())
    const abort = new AbortController()
    this.running = { key, abort }
    if (previous?.state !== 'translated') this.setTab(key, { state: 'working', from, to })
    try {
      if (bySystem) models.push(system.open(from, to))
      const used: RoutePack[] = []
      for (const step of steps) {
        const dir = packDirOf(this.dir, step.folder)
        const manifest = dir ? await readManifest(dir, step.from, step.to) : null
        if (!dir || !manifest) return await end('error', t('translate.msg-load-failed', { from: step.from, to: step.to }), previous)
        used.push({ engine: manifest.engine, folder: step.folder, version: manifest.version, files: manifest.files })
        const engine = this.deps.engines.get(manifest.engine)
        if (!engine) return await end('error', t('translate.msg-no-engine', { engine: manifest.engine }), previous)
        const verified = verifiedKey(step.folder, manifest.version)
        const before = await packSignature(dir, manifest)
        if (this.verified.get(verified)?.signature !== before) {
          this.state = 'working'
          const checked = await verifyPack(dir, manifest)
          if (!checked.ok) {
            console.warn(`[translate] the pack ${step.from}-${step.to} does not match its fingerprints (${checked.reason})`)
            return await end('error', t('translate.msg-pack-bad', { from: step.from, to: step.to }), previous)
          }
          // The signature is taken before the check: a file written while it read is seen as changed the next time.
          this.verified.set(verified, { dir, manifest, signature: before })
        }
        try {
          models.push(await engine.load(manifest, dir, this.context, abort.signal))
        } catch (error) {
          // Stopped while the engine started (« Arrêter », or the tab left the page): not a failure of the pack, and the turn is given back now.
          if (abort.signal.aborted) return await end('idle', t('translate.msg-stopped'))
          const reason = error instanceof Error ? error.message : String(error)
          console.warn(`[translate] the engine ${manifest.engine} could not load the pack ${step.from}-${step.to}:`, reason)
          // The engine's binary or a model's file that does not match its fingerprint at load is said as such: it was changed since it was checked.
          if (/^runtime-(size|fingerprint)/.test(reason)) return await end('error', t('translate.msg-runtime-bad'), previous)
          if (/^model-(size|fingerprint)/.test(reason)) return await end('error', t('translate.msg-pack-bad', { from: step.from, to: step.to }), previous)
          return await end('error', t('translate.msg-load-failed', { from: step.from, to: step.to }), previous)
        }
      }
      // Stopped while the engines loaded (from here on a stop, or the tab leaving its document, ends `abort`): the page was not read yet, and is not.
      if (abort.signal.aborted) return await end('idle', t('translate.msg-stopped'))
      // The tab shows a document of another site than the one this translation was asked for, and nothing said so yet: it is left alone.
      if (this.movedAway(page)) return await end('idle', t('translate.msg-page-changed'))
      this.state = 'working'
      this.message = ''
      this.messageKey = key
      const extracted = readExtractReply(await this.run(page, extractScript()))
      if (!extracted) return await end('error', t('translate.msg-page-changed'), previous)
      // Already translated: it stays so (« Afficher l'original » first).
      if ('error' in extracted) return await end('error', t('translate.msg-already'), previous ?? { state: 'translated', from, to })
      if (extracted.nodes.length === 0) return await end('idle', t('translate.msg-nothing'))
      // What the translation is kept under: the engine and the pair, or the packs as they were just read (another model translates again).
      const route = bySystem ? `system:${from}>${to}` : packRoute(used)
      // On screen first, the repeated texts once, the known ones at once, several batches ahead (pass.ts); each batch in the page as it comes.
      const { applied, skipped } = await translatePass(
        { texts: extracted.nodes, offsets: extracted.offsets },
        {
          models,
          signal: abort.signal,
          memory: this.memoryFor(page, route),
          apply: async (positions, texts) => {
            return readApplyReply(await this.run(page, applyScript(positions, texts)))
          }
        }
      )
      const more = extracted.more ? ` ${t('translate.msg-more')}` : ''
      const done = skipped > 0 ? tp('translate.msg-done-skipped', applied, { skipped }) : tp('translate.msg-done', applied)
      if (bySystem) this.noticeSystem(via)
      return await end('translated', done + more, { state: 'translated', from, to })
    } catch (error) {
      // Whatever went wrong, the page goes back to the text it had.
      await this.run(page, restoreScript())
      if (abort.signal.aborted) return await end('idle', t('translate.msg-stopped'))
      if (error instanceof BadReply) {
        console.warn('[translate] an engine answered with something that is not one text for each text sent')
        return await end('error', t('translate.msg-reply-bad'))
      }
      console.warn('[translate] the translation failed; the page was restored:', error instanceof Error ? error.message : String(error))
      if (bySystem) {
        // What the system said is not trusted any more (a language removed since, a helper that broke): it is asked again at the next view.
        this.systemSaid = null
        return await end('error', t('translate.msg-system-failed'))
      }
      return await end('error', t('translate.msg-engine-failed'))
    } finally {
      release()
      if (this.running?.abort === abort) this.running = null
    }
  }

  /** The pane of the system's settings where its languages are installed: an address of the main process, opened on the person's click. */
  private async openSystemSettings(): Promise<TranslateView> {
    if (!this.deps.engines.system || !this.deps.openSystemSettings) return this.view()
    this.deps.openSystemSettings()
    return this.say('idle', t('translate.msg-system-settings-opened'))
  }

  /**
   * « Afficher l'original » (or « Arrêter ») on a page: its translation under way is stopped (it puts the page back itself), one waiting its turn will not
   * run, a translated page gets its text back. Without a translation of the page, a download under way is what « Arrêter » stops.
   */
  private async restore(page: TranslatePage | null): Promise<TranslateView> {
    const key = page ? keyOf(page) : undefined
    if (key !== undefined) this.bump(key)
    if (this.running && (key === undefined || this.running.key === key)) {
      this.running.abort.abort()
      return this.say('idle', t('translate.msg-stopped'), key)
    }
    const own = key !== undefined ? this.tabs.get(key) : undefined
    if (!own && this.stop) {
      this.stop.abort()
      return this.say('idle', t('translate.msg-stopped'))
    }
    if (!page) return this.say('idle', '')
    // Waiting its turn: it will not run (the count above moved), and the page was never touched.
    if (own?.state === 'working') {
      this.setTab(keyOf(page), null)
      return this.say('idle', t('translate.msg-stopped'), keyOf(page))
    }
    await this.run(page, restoreScript())
    this.setTab(keyOf(page), null)
    return this.say('idle', t('translate.msg-restored'), keyOf(page))
  }

  // ---------- the models ----------

  /** One list from the catalogue server, read bounded and parsed. The only request of the lookups: each one a click's, to an address the panel named. */
  private async getList(url: string): Promise<unknown> {
    const response = await this.deps.fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'error', credentials: 'omit', cache: 'no-store' })
    if (!response.ok) {
      await response.body?.cancel().catch((error: unknown) => console.warn('[translate] the answer of the catalogue could not be dropped:', error instanceof Error ? error.message : String(error)))
      throw new LookupFailure(String(response.status))
    }
    const text = await readText(response, CATALOGUE_LIMITS.bytes)
    if (text === null) throw new LookupFailure(t('translate.catalogue-too-big'))
    return JSON.parse(text)
  }

  /** Whether the pair's folder already holds a model with exactly the files of a plan, and they are intact (only the engine's binary is then to fetch). */
  private async samePack(plan: DownloadPlan): Promise<boolean> {
    const dir = packDir(this.dir, plan.from, plan.to)
    const installed = dir ? await readManifest(dir, plan.from, plan.to) : null
    if (!dir || !installed || installed.engine !== 'bergamot' || installed.files.length !== plan.files.length) return false
    if (!plan.files.every((file) => installed.files.some((kept) => kept.role === file.role && kept.sha256 === file.sha256 && kept.size === file.size))) return false
    // A model that is the right one on paper but damaged on disk is downloaded again rather than kept.
    return (await verifyPack(dir, installed)).ok
  }

  /**
   * Asks the catalogue what the files of a pair are, and, when the engine's binary is not there yet, what it is. A click's requests: the addresses are on the
   * catalogue server the panel named. Nothing is downloaded: the panel shows every file, its address and size, before the click that downloads.
   */
  private async lookup(from: string, to: string): Promise<TranslateView> {
    const blocked = this.refuseWrite()
    if (blocked) return blocked
    const url = catalogueUrl(from, to)
    const env = this.deps.filterEnv ?? RELEASE_ENV
    this.offer = null
    try {
      const parsed = parseCatalogue(await this.getList(url), from, to, { env })
      if (!parsed.ok) return this.say('error', parsed.reason)
      let runtime: RuntimePlan | null = null
      // The binary is asked for only by a build that has the engine, and only while it is not there.
      if (this.deps.engines.get('bergamot') && !(await readRuntimeManifest(this.deps.engineDir))) {
        const engine = parseRuntimeCatalogue(await this.getList(RUNTIME_CATALOGUE_URL), env)
        if (!engine.ok) return this.say('error', engine.reason)
        runtime = engine.plan
      }
      const models = !(await this.samePack(parsed.plan))
      if (!models && !runtime) return this.say('idle', t('translate.msg-up-to-date', { from, to }))
      this.offer = { plan: parsed.plan, models, runtime, catalogue: url }
      return await this.say('idle', t('translate.msg-offer', { size: formatSize(this.offerView(this.offer).totalBytes) }))
    } catch (error) {
      console.warn('[translate] the catalogue lookup failed:', error instanceof Error ? error.message : String(error))
      return this.say('error', t('translate.msg-lookup-failed', { reason: error instanceof LookupFailure ? error.message : error instanceof Error ? error.name : 'error' }))
    }
  }

  /** Downloads what the last lookup showed, and nothing else: the engine's binary first (when it was shown), then the models. */
  private async download(from: string, to: string): Promise<TranslateView> {
    const blocked = this.refuseWrite()
    if (blocked) return blocked
    const offer = this.offer
    if (!offer || offer.plan.from !== from || offer.plan.to !== to) return this.say('error', t('translate.msg-download-first', { from, to }))
    this.state = 'working'
    const abort = new AbortController()
    this.stop = abort
    let leftover = ''
    const hooks = { signal: abort.signal, leftover: (folder: string) => (leftover = ` ${t('translate.msg-leftover', { folder })}`) }
    const failed = (reason: string): Promise<TranslateView> => this.say(reason === 'stopped' ? 'idle' : 'error', (reason === 'stopped' ? t('translate.msg-stopped-resume') : t('translate.msg-download-failed', { reason })) + leftover)
    try {
      if (offer.runtime) {
        const engine = await downloadRuntime(offer.runtime, this.deps.engineDir, this.deps.fetch, hooks)
        if (!engine.ok) return await failed(engine.reason)
        // The binary is there: a second click downloads only what is left.
        offer.runtime = null
      }
      if (offer.models) {
        const result = await downloadPack(offer.plan, this.dir, this.deps.fetch, hooks)
        if (!result.ok) return await failed(result.reason)
        // The files were checked as they arrived: the pack counts as verified.
        this.forgetVerified(from, to)
        await this.markVerified(from, to)
      }
      this.offer = null
      return await this.say('idle', (offer.models ? t('translate.msg-downloaded', { from, to }) : t('translate.msg-runtime-downloaded')) + leftover)
    } finally {
      this.stop = null
    }
  }

  private async adopt(from: string, to: string): Promise<TranslateView> {
    const blocked = this.refuseWrite()
    if (blocked) return blocked
    const result = await adoptFolder(this.dir, from, to)
    if (!result.ok) {
      console.warn(`[translate] the folder of the pack ${from}-${to} cannot be adopted (${result.reason})`)
      return this.say('error', t('translate.msg-adopt-failed', { folder: packDir(this.dir, from, to) ?? '', reason: result.reason }))
    }
    await this.markVerified(from, to)
    return this.say('idle', t('translate.msg-adopted', { from, to }))
  }

  private async remove(from: string, to: string, engine?: PackEngine): Promise<TranslateView> {
    const blocked = this.refuseWrite()
    if (blocked) return blocked
    const result = await removePack(this.dir, from, to, engine)
    this.forgetVerified(from, to)
    if (!result.ok && result.reason === 'not-a-pack') return this.say('error', t('translate.msg-not-a-pack', { from, to }))
    return this.say(result.ok ? 'idle' : 'error', result.ok ? t('translate.msg-removed', { from, to }) : t('translate.msg-download-failed', { reason: result.reason }))
  }

  private async chooseFolder(): Promise<TranslateView> {
    const blocked = this.refuseWrite()
    if (blocked) return blocked
    const path = await this.deps.chooseFolder()
    if (path === null) return this.view()
    this.deps.saveFolder(path)
    this.verified.clear()
    return this.say('idle', t('translate.msg-folder-set'))
  }

  private async useDefaultFolder(): Promise<TranslateView> {
    const blocked = this.refuseWrite()
    if (blocked) return blocked
    this.deps.saveFolder('')
    this.verified.clear()
    return this.say('idle', t('translate.msg-folder-default'))
  }
}

/** The text of a response, or null when it is longer than `max` bytes. Never reads more than `max` + one chunk. */
async function readText(response: Response, max: number): Promise<string | null> {
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > max) return null
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks))
}

