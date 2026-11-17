// The translation in one click (controller.ts): the toolbar button's popover, « Traduire en <langue> » of the page's menu and of File, « Toujours traduire »
// as a page loads, « Ne jamais traduire ce site ». The same translation as the panel (macOS's own engine here, simulated; nothing fetched), of the pair the
// panel would propose, without the panel; each tab with its own state; the lists written only by the main process, never from a private window or tab; the
// one-time notice of macOS's translation. The pages are the tests' own.

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { defaultSettings, type Settings, type TabTranslation } from '@shared/model'
import { el, fakePage, text as textNode, type FakePage } from '@shared/translate-test-support'
import { TranslateController, type TranslateDeps, type TranslatePage } from './controller'
import { EngineRegistry, glossaryEngine, type TranslationEngine } from './engines'
import { TranslationMemory } from './memory'
import { createMacTranslation, type SystemHelperRequest } from './system'
import { frenchSpaces } from '@shared/french-typography'
import { extractScript } from '@shared/translate-page-script'

const ENGLISH = ['The cat is sleeping on the sofa, and the dog is in the garden with the children of the house.', 'It is a fine day for a walk to the old bridge in the town.']
const FRENCH = ['Le chat dort sur le canapé et le chien est dans le jardin avec les enfants de la maison.', 'Il fait beau pour une promenade vers le vieux pont de la ville.']

const dirs: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lucium-quick-'))
  dirs.push(dir)
  return dir
}
beforeEach(() => {
  setLanguage('fr')
  for (const level of ['log', 'info', 'warn', 'debug'] as const) vi.spyOn(console, level).mockImplementation(() => undefined)
})
afterEach(() => {
  setLanguage('fr')
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface TabSpec {
  url: string
  texts: readonly string[]
  lang?: string
  private?: boolean
}

const TABS: Record<string, TabSpec> = {
  'en-1': { url: 'https://www.news.example/story', texts: ENGLISH, lang: 'en' },
  'en-2': { url: 'https://blog.example.org/post', texts: ENGLISH },
  'fr-1': { url: 'https://journal.example.fr/article', texts: FRENCH, lang: 'fr' },
  // Says it is in English, written in French.
  'liar': { url: 'https://liar.example/', texts: FRENCH, lang: 'en' },
  'short': { url: 'https://short.example/', texts: ['Hi'] },
  'secret': { url: 'https://secret.example/', texts: ENGLISH, lang: 'en', private: true }
}

/** A glossary of a pair, placed by hand with its manifest: the engine that translates when macOS is not there. */
function glossaryPack(root: string, from: string, to: string): void {
  const dir = join(root, `${from}-${to}`)
  mkdirSync(dir, { recursive: true })
  const data = JSON.stringify({ entries: { the: 'le', cat: 'chat' } })
  const name = `${from}-${to}.glossary.json`
  writeFileSync(join(dir, name), data)
  const sha256 = createHash('sha256').update(data).digest('hex')
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, engine: 'glossary', from, to, version: '1', files: [{ role: 'glossary', name, size: Buffer.byteLength(data), sha256 }] }))
}

interface Setup {
  controller: TranslateController
  /** The folder of the models. */
  root: string
  settings: Settings
  pages: Map<string, FakePage>
  /** The tab on screen. */
  show(id: string): void
  changes: Array<[string, TabTranslation | null]>
  requests: SystemHelperRequest[]
  translated(): TranslateRequestSent[]
  notices: number[]
  fetched: string[]
  /** Holds the system's next translations until `release` is called. */
  hold(): void
  release(): void
  /** Holds what the system says of a pair (`availability`) until `releaseSystem` is called. */
  holdSystem(): void
  releaseSystem(): void
  /** The tab shows a document at another address from now on, and nothing told the controller yet. */
  navigate(id: string, url: string): void
  memory: TranslationMemory
}

function setup(over: { settings?: Partial<Settings>; readOnly?: boolean; system?: boolean; saves?: boolean; engines?: readonly TranslationEngine[] } = {}): Setup {
  const settings: Settings = { ...defaultSettings(), translateLocal: true, translateTarget: 'auto', ...over.settings }
  const root = tmp()
  const pages = new Map(Object.entries(TABS).map(([id, spec]) => [id, fakePage(el('BODY', spec.texts.map((t) => el('P', [textNode(t)]))), spec.lang ?? '')]))
  let shown = 'en-1'
  const changes: Array<[string, TabTranslation | null]> = []
  const requests: SystemHelperRequest[] = []
  const notices: number[] = []
  const fetched: string[] = []
  let gate: Promise<void> | null = null
  let open: () => void = () => undefined
  let systemGate: Promise<void> | null = null
  let openSystem: () => void = () => undefined
  const addresses = new Map<string, string>()
  const memory = new TranslationMemory()
  const system =
    over.system === false
      ? null
      : createMacTranslation({
          systemVersion: () => '27.2.0',
          runner: () => async (request) => {
            requests.push(request)
            if (request.command === 'availability') {
              if (systemGate) await systemGate
              return { ok: true, status: 'installed' }
            }
            if (gate) await gate
            return { ok: true, texts: request.texts.map((value) => value.toUpperCase()) }
          }
        })
  const pageOf = (id: string): TranslatePage | null => {
    const page = pages.get(id)
    const spec = TABS[id]
    return page && spec ? { id, url: addresses.get(id) ?? spec.url, ...(spec.private ? { private: true } : {}), run: (code) => page.run(code) } : null
  }
  const deps: TranslateDeps = {
    settings: () => settings,
    page: () => pageOf(shown),
    pageOf,
    tabChanged: (id, translation) => void changes.push([id, translation]),
    // A window that keeps nothing (`saves: false`) writes nothing.
    saveSettings: (patch) => void (over.saves === false ? undefined : Object.assign(settings, patch)),
    systemNotice: () => void notices.push(1),
    readOnly: over.readOnly ?? false,
    defaultDir: root,
    engineDir: join(tmp(), 'translation-engine'),
    engines: new EngineRegistry(over.engines ?? [glossaryEngine], system),
    memory,
    fetch: async (url) => {
      fetched.push(url)
      return new Response('', { status: 404 })
    },
    chooseFolder: async () => null,
    saveFolder: () => undefined,
    systemLocale: () => 'fr-FR'
  }
  return {
    controller: new TranslateController(deps),
    root,
    settings,
    pages,
    show: (id) => void (shown = id),
    changes,
    requests,
    translated: () => requests.filter((request): request is TranslateRequestSent => request.command === 'translate'),
    notices,
    fetched,
    hold: () => void (gate = new Promise<void>((resolve) => (open = resolve))),
    release: () => {
      gate = null
      open()
    },
    holdSystem: () => void (systemGate = new Promise<void>((resolve) => (openSystem = resolve))),
    releaseSystem: () => {
      systemGate = null
      openSystem()
    },
    navigate: (id, url) => void addresses.set(id, url),
    memory
  }
}

const upper = (texts: readonly string[]) => texts.map((value) => value.toUpperCase())
type TranslateRequestSent = Extract<SystemHelperRequest, { command: 'translate' }>

describe('one click on « Traduire » (the toolbar button’s popover)', () => {
  it('translates the page on screen with the pair the panel would propose, into the target, without the panel and without the network', async () => {
    const t = setup()
    const view = await t.controller.handle({ action: 'quick' })
    expect(view.state).toBe('translated')
    expect(t.pages.get('en-1')!.texts()).toEqual(upper(ENGLISH))
    expect(t.translated().map(({ from, to }) => [from, to])).toEqual([['en', 'fr']])
    // The button says « under way » first, then « translated ».
    expect(t.changes).toEqual([
      ['en-1', { state: 'working', from: 'en', to: 'fr' }],
      ['en-1', { state: 'translated', from: 'en', to: 'fr' }]
    ])
    expect(t.fetched).toEqual([])
  })

  it('puts the original back with « Afficher l’original », and the tab has no translation any more', async () => {
    const t = setup()
    await t.controller.handle({ action: 'quick' })
    const view = await t.controller.handle({ action: 'restore' })
    expect(view.state).toBe('idle')
    expect(t.pages.get('en-1')!.texts()).toEqual(ENGLISH)
    expect(t.changes.at(-1)).toEqual(['en-1', null])
    expect(t.controller.translationOf('en-1')).toBeNull()
  })

  it('does nothing more for a page already translated into that language, and translates the original into « Autre langue… »', async () => {
    const t = setup()
    await t.controller.handle({ action: 'quick' })
    await t.controller.handle({ action: 'quick' })
    expect(t.translated()).toHaveLength(1)
    const other = await t.controller.handle({ action: 'quick', to: 'de' })
    expect(other.state).toBe('translated')
    // The original went to the engine, not the French translation.
    expect(t.translated().map(({ from, to, texts }) => [from, to, texts])).toEqual([
      ['en', 'fr', ENGLISH],
      ['en', 'de', ENGLISH]
    ])
    expect(t.controller.translationOf('en-1')).toEqual({ state: 'translated', from: 'en', to: 'de' })
  })

  it('says so when the page’s language is not recognised, as an error (the page’s menu then opens the panel), and touches nothing', async () => {
    const t = setup()
    t.show('short')
    const view = await t.controller.quickTab('short')
    expect(view).toMatchObject({ state: 'error', message: frenchSpaces('La langue de cette page n’a pas été reconnue : choisissez-la dans « Plus d’options… ».') })
    // The panel the menu opens then says it.
    expect((await t.controller.handle({ action: 'refresh' })).message).toBe(view.message)
    expect(t.translated()).toEqual([])
    expect(t.changes).toEqual([])
  })

  it('refuses everything while the function is off', async () => {
    const t = setup({ settings: { translateLocal: false } })
    expect((await t.controller.handle({ action: 'quick' })).state).toBe('error')
    expect((await t.controller.quickTab('en-1')).state).toBe('error')
    await t.controller.autoTranslate('en-2')
    expect(t.requests).toEqual([])
  })
})

describe('the menu of a page and File, for a tab', () => {
  it('translate the tab they are for, on screen or not, and show its original; the panel shows the state of the page on screen only', async () => {
    const t = setup()
    expect((await t.controller.quickTab('en-2')).state).toBe('idle')
    expect(t.pages.get('en-2')!.texts()).toEqual(upper(ENGLISH))
    expect(t.pages.get('en-1')!.texts()).toEqual(ENGLISH)
    // The page on screen (en-1) is not translated, and the sentence about en-2 is not said on it.
    const onScreen = await t.controller.handle({ action: 'refresh' })
    expect(onScreen).toMatchObject({ state: 'idle', message: '' })
    t.show('en-2')
    expect((await t.controller.handle({ action: 'refresh' })).state).toBe('translated')
    await t.controller.restoreTab('en-2')
    expect(t.pages.get('en-2')!.texts()).toEqual(ENGLISH)
    expect(t.controller.translationOf('en-2')).toBeNull()
  })
})

describe('« Toujours traduire », as a page loads', () => {
  it('translates by itself a page written in a language of the list, into the target', async () => {
    const t = setup({ settings: { translateAlways: ['en'] } })
    await t.controller.autoTranslate('en-2')
    expect(t.pages.get('en-2')!.texts()).toEqual(upper(ENGLISH))
    expect(t.controller.translationOf('en-2')).toEqual({ state: 'translated', from: 'en', to: 'fr' })
  })

  it('never translates a page of a site of « Ne jamais traduire ce site », which wins, its subdomains too', async () => {
    const t = setup({ settings: { translateAlways: ['en'], translateNeverSites: ['news.example', 'example.org'] } })
    await t.controller.autoTranslate('en-1')
    await t.controller.autoTranslate('en-2')
    expect(t.translated()).toEqual([])
    expect(t.pages.get('en-1')!.texts()).toEqual(ENGLISH)
    expect(t.changes).toEqual([])
  })

  it('leaves alone a page in another language than the list’s, one that only says it is in English, and one in the target language', async () => {
    const t = setup({ settings: { translateAlways: ['de'] } })
    await t.controller.autoTranslate('en-1')
    const english = setup({ settings: { translateAlways: ['en', 'fr'] } })
    await english.controller.autoTranslate('liar')
    await english.controller.autoTranslate('fr-1')
    expect([...t.translated(), ...english.translated()]).toEqual([])
    expect(english.pages.get('liar')!.texts()).toEqual(FRENCH)
  })

  it('translates a page once, however often its language is told', async () => {
    const t = setup({ settings: { translateAlways: ['en'] } })
    await Promise.all([t.controller.autoTranslate('en-2'), t.controller.autoTranslate('en-2')])
    await t.controller.autoTranslate('en-2')
    expect(t.translated()).toHaveLength(1)
    // Not even a second question to the system: the second telling found the translation under way.
    expect(t.requests.filter((request) => request.command === 'availability')).toHaveLength(1)
  })

  it('translates in a private window too (nothing is written: the rule of the translation today)', async () => {
    const t = setup({ readOnly: true, settings: { translateAlways: ['en'] } })
    await t.controller.autoTranslate('en-2')
    expect(t.pages.get('en-2')!.texts()).toEqual(upper(ENGLISH))
  })
})

describe('the two switches of the popover', () => {
  it('« Toujours traduire l’anglais » writes the language, and translates the page on screen now; off, takes it out', async () => {
    const t = setup()
    const view = await t.controller.handle({ action: 'always', language: 'en', on: true })
    expect(t.settings.translateAlways).toEqual(['en'])
    expect(view.state).toBe('translated')
    expect(t.pages.get('en-1')!.texts()).toEqual(upper(ENGLISH))
    await t.controller.handle({ action: 'always', language: 'en', on: false })
    expect(t.settings.translateAlways).toEqual([])
  })

  it('« Toujours traduire » switched on does not translate a page of a site never translated', async () => {
    const t = setup({ settings: { translateNeverSites: ['news.example'] } })
    await t.controller.handle({ action: 'always', language: 'en', on: true })
    expect(t.settings.translateAlways).toEqual(['en'])
    expect(t.translated()).toEqual([])
  })

  it('« Ne jamais traduire ce site » writes the site of the page on screen (the interface names none), and shows the original of a translated page', async () => {
    const t = setup()
    await t.controller.handle({ action: 'quick' })
    await t.controller.handle({ action: 'never-site', on: true })
    expect(t.settings.translateNeverSites).toEqual(['news.example'])
    expect(t.pages.get('en-1')!.texts()).toEqual(ENGLISH)
    expect(t.controller.translationOf('en-1')).toBeNull()
    await t.controller.handle({ action: 'never-site', on: false })
    expect(t.settings.translateNeverSites).toEqual([])
  })

  it('write nothing from a private window, nor for a private tab: the site of a private tab is never written down', async () => {
    const window = setup({ readOnly: true })
    for (const request of [{ action: 'always', language: 'en', on: true }, { action: 'never-site', on: true }] as const) {
      expect(await window.controller.handle(request)).toMatchObject({ state: 'error', message: 'Une fenêtre ou un onglet privé n’enregistre aucune préférence de traduction.' })
    }
    const tab = setup()
    tab.show('secret')
    expect((await tab.controller.handle({ action: 'never-site', on: true })).state).toBe('error')
    expect((await tab.controller.handle({ action: 'always', language: 'en', on: true })).state).toBe('error')
    expect([window.settings, tab.settings].map((s) => [s.translateAlways, s.translateNeverSites])).toEqual([
      [[], []],
      [[], []]
    ])
  })
})

describe('the notice of macOS’s translation', () => {
  it('is given once, the first time macOS translates a page in one click, and remembered', async () => {
    const t = setup()
    await t.controller.handle({ action: 'quick' })
    expect(t.notices).toHaveLength(1)
    expect(t.settings.translateSystemNoticeSeen).toBe(true)
    await t.controller.handle({ action: 'restore' })
    await t.controller.handle({ action: 'quick' })
    await t.controller.quickTab('en-2')
    expect(t.notices).toHaveLength(1)
  })

  it('is not given again once remembered, nor by a later window', async () => {
    const t = setup({ settings: { translateSystemNoticeSeen: true } })
    await t.controller.handle({ action: 'quick' })
    expect(t.notices).toEqual([])
  })

  it('is said by the full panel itself when the panel translated: remembered, with no second notice', async () => {
    const t = setup()
    await t.controller.handle({ action: 'run', from: 'en', to: 'fr' })
    expect(t.notices).toEqual([])
    expect(t.settings.translateSystemNoticeSeen).toBe(true)
  })

  it('is given once by a window that cannot remember it (a private window)', async () => {
    const t = setup({ saves: false })
    await t.controller.handle({ action: 'quick' })
    await t.controller.quickTab('en-2')
    expect(t.notices).toHaveLength(1)
    expect(t.settings.translateSystemNoticeSeen).toBe(false)
  })

  it('is about macOS only: a translation by a glossary gives none', async () => {
    const t = setup({ system: false })
    glossaryPack(t.root, 'en', 'fr')
    expect((await t.controller.handle({ action: 'quick' })).state).toBe('translated')
    expect(t.pages.get('en-1')!.texts()[0]).toMatch(/^Le chat/)
    expect(t.notices).toEqual([])
    expect(t.settings.translateSystemNoticeSeen).toBe(false)
  })
})

describe('the turn of the translations', () => {
  it('a translation waits for the one before; asked for its original meanwhile, it never runs', async () => {
    const t = setup()
    t.hold()
    const first = t.controller.quickTab('en-1')
    await vi.waitFor(() => expect(t.translated()).toHaveLength(1))
    const second = t.controller.quickTab('en-2')
    // The button of the second tab says « under way » at once.
    await vi.waitFor(() => expect(t.controller.translationOf('en-2')).toEqual({ state: 'working', from: 'en', to: 'fr' }))
    await t.controller.restoreTab('en-2')
    expect(t.controller.translationOf('en-2')).toBeNull()
    t.release()
    await Promise.all([first, second])
    expect(t.translated().map((request) => request.texts)).toEqual([ENGLISH])
    expect(t.pages.get('en-2')!.texts()).toEqual(ENGLISH)
    expect(t.pages.get('en-1')!.texts()).toEqual(upper(ENGLISH))
  })

  it('a page that goes to another document stops its translation, and the tab has none any more', async () => {
    const t = setup()
    t.hold()
    const running = t.controller.quickTab('en-1')
    await vi.waitFor(() => expect(t.translated()).toHaveLength(1))
    t.controller.forgetTab('en-1')
    t.release()
    expect((await running).state).not.toBe('translated')
    expect(t.controller.translationOf('en-1')).toBeNull()
    expect(t.pages.get('en-1')!.texts()).toEqual(ENGLISH)
  })

  it('« Traduire » of the panel that waited its turn does not run once its tab went to another document, nor once its original was asked', async () => {
    for (const leave of ['another document', 'the original'] as const) {
      const t = setup()
      t.hold()
      const first = t.controller.quickTab('en-1')
      await vi.waitFor(() => expect(t.translated()).toHaveLength(1))
      t.show('en-2')
      const second = t.controller.handle({ action: 'run', from: 'en', to: 'fr' })
      if (leave === 'another document') t.controller.forgetTab('en-2')
      else await t.controller.handle({ action: 'restore' })
      t.release()
      await Promise.all([first, second])
      // The page the tab shows now was never read: one translation only, the first tab's.
      expect(t.translated().map((request) => request.texts), leave).toEqual([ENGLISH])
      expect(t.pages.get('en-2')!.texts(), leave).toEqual(ENGLISH)
      expect(t.controller.translationOf('en-2'), leave).toBeNull()
      // Nor was anything started for it: the system was asked about the first tab's pair only, and the button of the tab never said « under way ».
      expect(t.requests.filter((request) => request.command === 'availability'), leave).toHaveLength(1)
      expect(t.changes.filter(([id]) => id === 'en-2'), leave).toEqual([])
    }
  })

  it('a tab that leaves its document while the system is asked about the pair is not translated: nothing was under way yet for the stop to end', async () => {
    const t = setup()
    t.holdSystem()
    const running = t.controller.quickTab('en-1')
    await vi.waitFor(() => expect(t.requests.map((request) => request.command)).toEqual(['availability']))
    t.controller.forgetTab('en-1')
    t.releaseSystem()
    expect((await running).state).not.toBe('translated')
    expect(t.translated()).toEqual([])
    expect(t.pages.get('en-1')!.texts()).toEqual(ENGLISH)
    expect(t.controller.translationOf('en-1')).toBeNull()
    // The button said « under way » when it was asked, then nothing: it does not say it again for the document the tab shows now.
    expect(t.changes).toEqual([
      ['en-1', { state: 'working', from: 'en', to: 'fr' }],
      ['en-1', null]
    ])
    // The turn is free: the next translation runs.
    await t.controller.quickTab('en-2')
    expect(t.controller.translationOf('en-2')?.state).toBe('translated')
  })

  it('a tab that shows a document of another site when its turn comes is left alone: its text is not read, and nothing goes to the memory of the first site', async () => {
    const t = setup()
    t.holdSystem()
    const running = t.controller.quickTab('en-1')
    await vi.waitFor(() => expect(t.requests.map((request) => request.command)).toEqual(['availability']))
    // The address of the tab changed, and the controller has not been told yet (`forgetTab` comes with the navigation).
    t.navigate('en-1', 'https://never.example/account')
    t.releaseSystem()
    expect((await running).state).toBe('idle')
    expect(t.translated()).toEqual([])
    expect(t.pages.get('en-1')!.texts()).toEqual(ENGLISH)
    expect(t.controller.translationOf('en-1')).toBeNull()
    expect(t.memory.size).toBe(0)
    // Another document of the same site is the same site: it is translated (the count of the tab says when the document itself changed).
    const same = setup()
    same.holdSystem()
    const again = same.controller.quickTab('en-1')
    await vi.waitFor(() => expect(same.requests).toHaveLength(1))
    same.navigate('en-1', 'https://www.news.example/other-story')
    same.releaseSystem()
    expect((await again).state).toBe('translated')
  })

  it('« Arrêter » while an engine loads its model stops the load and gives the turn back at once', async () => {
    const loads: Array<AbortSignal | undefined> = []
    // An engine whose load never ends by itself: only its stop ends it. Without the signal of the translation it could not be stopped at all.
    const slow: TranslationEngine = {
      id: 'glossary',
      load: (_manifest, _dir, _context, signal) => {
        loads.push(signal)
        return new Promise((_resolve, reject) => {
          if (!signal) reject(new Error('no stop was given to the load'))
          else signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
        })
      }
    }
    const t = setup({ system: false, engines: [slow] })
    glossaryPack(t.root, 'en', 'fr')
    const running = t.controller.quickTab('en-1')
    await vi.waitFor(() => expect(loads).toHaveLength(1))
    await t.controller.handle({ action: 'restore' })
    const view = await running
    expect(loads[0]?.aborted).toBe(true)
    // Stopped, not a pack that failed to load; the page was never read, and the tab has no translation.
    expect(view.state).toBe('idle')
    expect(t.pages.get('en-1')!.texts()).toEqual(ENGLISH)
    expect(t.controller.translationOf('en-1')).toBeNull()
    // The turn is free: the panel's other operations are not answered « busy ».
    expect((await t.controller.handle({ action: 'folder-default' })).message).not.toBe((await import('@shared/i18n')).t('translate.msg-busy'))
  })

  it('a translation stopped while its engine loaded does not read the page, even when the engine loaded all the same', async () => {
    let loading: (() => void) | null = null
    // An engine that does not hear the stop: its load ends when the test says so, with a model.
    const deaf: TranslationEngine = {
      id: 'glossary',
      load: () => new Promise((resolve) => (loading = () => resolve({ translate: async (texts) => texts.map((value) => value.toUpperCase()), dispose: () => undefined })))
    }
    const t = setup({ system: false, engines: [deaf] })
    glossaryPack(t.root, 'en', 'fr')
    const running = t.controller.quickTab('en-1')
    await vi.waitFor(() => expect(loading).not.toBeNull())
    const read = vi.spyOn(t.pages.get('en-1')!, 'run')
    await t.controller.restoreTab('en-1')
    loading!()
    await running
    // The panel still reads its sample of the page on screen; the texts to translate are not asked for.
    expect(read.mock.calls.map(([code]) => code)).not.toContain(extractScript())
    expect(t.pages.get('en-1')!.texts()).toEqual(ENGLISH)
    expect(t.controller.translationOf('en-1')).toBeNull()
  })
})
