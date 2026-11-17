import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { defaultSettings, type Settings } from '@shared/model'
import { catalogueUrl, type SystemAvailability } from '@shared/translate-local'
import { el, fakePage, text as textNode, type FakePage } from '@shared/translate-test-support'
import { TranslateController, type TranslateDeps } from './controller'
import { EngineRegistry, defaultEngines, glossaryEngine } from './engines'
import { SystemTranslateError, createMacTranslation, type SystemEngine, type SystemHelperRequest } from './system'
import { frenchSpaces } from '@shared/french-typography'

// Which engine translates a pair: the system's own translation when the pair is installed in macOS, else Bergamot,
// else the glossary; never the system's elsewhere than macOS. The system's helper is simulated; the page is the tests' own.
const ORIGINAL = ['Bonjour le monde', '  Le chat dort ici. ']
const GLOSSARY = { bonjour: 'hello', le: 'the', monde: 'world', chat: 'cat', dort: 'sleeps', ici: 'here' }

const dirs: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lucium-system-choice-'))
  dirs.push(dir)
  return dir
}
let logs: unknown[][] = []
beforeEach(() => {
  setLanguage('fr')
  logs = []
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args))
})
afterEach(() => {
  setLanguage('fr')
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function glossaryPack(root: string, from: string, to: string): void {
  const dir = join(root, `${from}-${to}`)
  mkdirSync(dir, { recursive: true })
  const data = JSON.stringify({ entries: GLOSSARY })
  const name = `${from}-${to}.glossary.json`
  writeFileSync(join(dir, name), data)
  const sha256 = createHash('sha256').update(data).digest('hex')
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, engine: 'glossary', from, to, version: '1', files: [{ role: 'glossary', name, size: Buffer.byteLength(data), sha256 }] }))
}

/** The helper as main.swift answers, over the system's languages: `status` for every pair, translations in upper case. */
class SimulatedSystem {
  status: SystemAvailability | 'installed' = 'installed'
  /** The helper fails on the translation itself (a language removed between the check and the translation). */
  failTranslate: string | null = null
  requests: SystemHelperRequest[] = []
  engine(version = '27.2.0'): SystemEngine {
    return createMacTranslation({
      systemVersion: () => version,
      runner: () => async (request) => {
        this.requests.push(request)
        if (request.command === 'availability') return this.status === 'unavailable' ? { ok: false, error: 'unavailable' } : { ok: true, status: this.status }
        if (this.failTranslate) return { ok: false, error: this.failTranslate }
        return { ok: true, texts: request.texts.map((text) => text.toUpperCase()) }
      }
    })
  }
  asked(command: 'availability' | 'translate'): number {
    return this.requests.filter((request) => request.command === command).length
  }
}

interface Setup {
  controller: TranslateController
  page: FakePage
  root: string
  fetched: string[]
  opened: number[]
}

function setup(system: SystemEngine | null, over: { openSettings?: boolean; target?: string; lang?: string; texts?: readonly string[] } = {}): Setup {
  const root = tmp()
  const settings: Settings = { ...defaultSettings(), translateLocal: true, translateTarget: over.target ?? 'en' }
  const page = fakePage(el('BODY', (over.texts ?? ORIGINAL).map((text, index) => el(index === 0 ? 'H1' : 'P', [textNode(text)]))), over.lang ?? 'fr')
  const fetched: string[] = []
  const opened: number[] = []
  const deps: TranslateDeps = {
    settings: () => settings,
    page: () => ({ url: 'https://exemple.org/page', run: (code) => page.run(code) }),
    readOnly: false,
    defaultDir: root,
    engineDir: join(tmp(), 'translation-engine'),
    engines: new EngineRegistry([glossaryEngine], system),
    // The system's translation asks nothing of the network: any request here is a failure of the test.
    fetch: async (url) => {
      fetched.push(url)
      return new Response('', { status: 404 })
    },
    chooseFolder: async () => null,
    saveFolder: () => undefined,
    systemLocale: () => 'fr-FR',
    ...(over.openSettings === false ? {} : { openSystemSettings: () => void opened.push(1) })
  }
  return { controller: new TranslateController(deps), page, root, fetched, opened }
}

const logged = (): string => JSON.stringify(logs)

describe('the engine that translates a pair', () => {
  it('is the system’s when macOS has the pair installed, before a glossary of the same pair, with nothing fetched', async () => {
    const system = new SimulatedSystem()
    const t = setup(system.engine())
    glossaryPack(t.root, 'fr', 'en')
    const opened = await t.controller.handle({ action: 'refresh' })
    expect(opened.system).toEqual({ kind: 'macos', status: 'installed', settingsLink: true })
    expect(opened.using).toEqual(['system'])
    // A pair the system translates needs no model: nothing to look up.
    expect(opened.route).toEqual({ ok: true, steps: [['fr', 'en']] })
    expect(opened.lookupUrl).toBeNull()
    const done = await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })
    expect(done.state).toBe('translated')
    expect(done.using).toEqual(['system'])
    expect(t.page.texts()).toEqual(['BONJOUR LE MONDE', '  LE CHAT DORT ICI. '])
    expect(system.requests.filter((r) => r.command === 'translate')).toEqual([{ command: 'translate', from: 'fr', to: 'en', texts: ['Bonjour le monde', 'Le chat dort ici.'] }])
    expect(t.fetched).toEqual([])
    await t.controller.handle({ action: 'restore' })
    expect(t.page.texts()).toEqual(ORIGINAL)
  })

  it('is a pack when macOS supports the pair but has not installed it: the panel says where to install it, and Lucium downloads nothing', async () => {
    const system = new SimulatedSystem()
    system.status = 'supported'
    const t = setup(system.engine())
    glossaryPack(t.root, 'fr', 'en')
    const view = await t.controller.handle({ action: 'refresh' })
    expect(view.system?.status).toBe('supported')
    expect(view.using).toEqual(['glossary'])
    expect((await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })).using).toEqual(['glossary'])
    expect(t.page.texts()).toEqual(['Hello the world', '  The cat sleeps here. '])
    expect(system.asked('translate')).toBe(0)
    expect(t.fetched).toEqual([])
  })

  it('says, for a pair macOS could translate once installed and no pack has, where to install it, and still offers the Bergamot models', async () => {
    const system = new SimulatedSystem()
    system.status = 'supported'
    const t = setup(system.engine())
    const view = await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })
    expect(view.state).toBe('error')
    expect(view.message).toContain('Langues pour la traduction…')
    expect(view.route).toEqual({ ok: false, missing: [['fr', 'en']] })
    expect(view.lookupUrl).toBe(catalogueUrl('fr', 'en'))
    expect(view.using).toEqual([])
    expect(t.page.texts()).toEqual(ORIGINAL)
    expect(t.fetched).toEqual([])
    // The pane of the system's settings opens on the click, from an address of the main process.
    const after = await t.controller.handle({ action: 'system-settings' })
    expect(t.opened).toEqual([1])
    expect(after.message).toContain('Langue et région')
  })

  it('is a pack when macOS does not translate the pair, or is too old for the translation without a window', async () => {
    for (const [status, version] of [['unsupported', '27.2.0'], ['installed', '15.7.1']] as const) {
      const system = new SimulatedSystem()
      system.status = status
      const t = setup(system.engine(version))
      glossaryPack(t.root, 'fr', 'en')
      const view = await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })
      expect(view.using, `${status} ${version}`).toEqual(['glossary'])
      expect(view.system?.status).toBe(version === '15.7.1' ? 'unavailable' : 'unsupported')
      expect(t.page.texts()).toEqual(['Hello the world', '  The cat sleeps here. '])
      expect(system.asked('translate')).toBe(0)
      // macOS 15: the helper is not even started.
      if (version === '15.7.1') expect(system.requests).toEqual([])
    }
  })

  it('is never the system’s elsewhere than macOS: the registry of Windows and Linux has none, and the panel says nothing of it', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const locate = vi.fn(() => '/x/lucium-translate')
      const registry = defaultEngines(platform, { locate, systemVersion: () => '27.2.0' })
      expect(registry.system).toBeNull()
      expect(locate).not.toHaveBeenCalled()
    }
    const t = setup(null)
    glossaryPack(t.root, 'fr', 'en')
    const view = await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })
    expect(view.system).toBeNull()
    expect(view.using).toEqual(['glossary'])
    // Without a system engine there is nothing to open either.
    await t.controller.handle({ action: 'system-settings' })
    expect(t.opened).toEqual([])
  })

  it('puts the page back, says so and logs no text when the system fails during the translation; it asks the system again next time', async () => {
    const system = new SimulatedSystem()
    const t = setup(system.engine())
    system.failTranslate = 'not-installed'
    const view = await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })
    expect(view.state).toBe('error')
    expect(view.message).toBe(frenchSpaces('La traduction de macOS a échoué : la page est restée telle quelle. Réessayez ; si cela recommence, Bergamot peut traduire à sa place.'))
    expect(t.page.texts()).toEqual(ORIGINAL)
    expect(logged()).toContain('not-installed')
    for (const sentence of ['Bonjour le monde', 'Le chat dort ici', 'BONJOUR']) expect(logged()).not.toContain(sentence)
    // The system's word is not trusted any more: the next view asks again, and a pack takes over once it says the pair is gone.
    system.failTranslate = null
    system.status = 'supported'
    glossaryPack(t.root, 'fr', 'en')
    const before = system.asked('availability')
    // The Settings window's view reads no page and asks the system nothing.
    expect((await t.controller.handle({ action: 'packs' })).system?.status).toBe('unknown')
    expect(system.asked('availability')).toBe(before)
    expect((await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })).using).toEqual(['glossary'])
    expect(system.asked('availability')).toBeGreaterThan(before)
  })

  it('never writes a text of the page in a log, whatever the engine answers', async () => {
    for (const code of ['failed', 'cancelled', 'unsupported', 'rm -rf /']) {
      const system = new SimulatedSystem()
      system.failTranslate = code
      const t = setup(system.engine())
      await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })
    }
    // A model that throws the text itself (a broken engine): the controller logs the message it got, the system's never carries the text.
    const leaky = new SimulatedSystem().engine()
    const t = setup({ ...leaky, open: () => ({ translate: async () => Promise.reject(new SystemTranslateError('failed')), dispose: () => undefined }) })
    await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })
    expect(logs.length).toBeGreaterThan(0)
    for (const sentence of ['Bonjour le monde', 'Le chat dort ici']) expect(logged()).not.toContain(sentence)
  })
})

describe('when the system is asked', () => {
  it('never from the Settings window (a view that reads no page), once when the panel opens, and again before each translation', async () => {
    const system = new SimulatedSystem()
    const t = setup(system.engine())
    await t.controller.handle({ action: 'packs' })
    await t.controller.handle({ action: 'packs' })
    expect(system.requests).toEqual([])
    await t.controller.handle({ action: 'refresh' })
    expect(system.asked('availability')).toBe(1)
    // A second view of the same pair (a message, a list) reuses what it said.
    await t.controller.handle({ action: 'packs' })
    await t.controller.handle({ action: 'restore' })
    expect(system.asked('availability')).toBe(1)
    await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })
    expect(system.asked('availability')).toBe(2)
    // Opening the panel again asks again: a language may have been installed meanwhile.
    await t.controller.handle({ action: 'refresh' })
    expect(system.asked('availability')).toBe(3)
  })

  it('never while the function is off', async () => {
    const system = new SimulatedSystem()
    const t = setup(system.engine())
    const off = new TranslateController({ ...(t.controller as unknown as { deps: TranslateDeps }).deps, settings: () => ({ ...defaultSettings(), translateLocal: false }) })
    for (const action of ['refresh', 'system-settings'] as const) await off.handle({ action })
    await off.handle({ action: 'run', from: 'fr', to: 'en' })
    expect(system.requests).toEqual([])
    expect(t.opened).toEqual([])
  })

  it('offers the pane of the system’s settings only where the system has one', async () => {
    const system = new SimulatedSystem()
    system.status = 'supported'
    const t = setup(system.engine(), { openSettings: false })
    expect((await t.controller.handle({ action: 'refresh' })).system).toEqual({ kind: 'macos', status: 'supported', settingsLink: false })
    await t.controller.handle({ action: 'system-settings' })
    expect(t.opened).toEqual([])
  })
})

// The panel opened from « Traduire cette page… » never starts on a pair that goes nowhere (the capture of 0.2.14: French into French, and the button greyed).
describe('the pair the panel starts from', () => {
  const FRENCH = [
    'Le gouvernement a annoncé qu’il présentera un nouveau plan pour l’économie à l’automne, après une série d’avertissements des chefs d’entreprise.',
    'Les ministres devraient présenter leurs propositions dans les prochaines semaines, et ils ont dit que ce sera pour tout le monde.'
  ]

  it('is the language the page declares, into the target, when the words of the page are in the target language: the system is asked about that pair', async () => {
    const system = new SimulatedSystem()
    const t = setup(system.engine(), { target: 'fr', lang: 'en-US', texts: FRENCH })
    const view = await t.controller.handle({ action: 'refresh' })
    expect(view.page?.detection).toMatchObject({ language: 'fr', source: 'text', declared: 'en' })
    expect(view.proposed).toEqual({ from: 'en', to: 'fr' })
    expect(view.using).toEqual(['system'])
    expect(system.requests).toEqual([{ command: 'availability', from: 'en', to: 'fr' }])
  })

  it('is French into English for a French page when the target is French: the other language, not the same one', async () => {
    const system = new SimulatedSystem()
    const t = setup(system.engine(), { target: 'fr', lang: 'fr', texts: FRENCH })
    const view = await t.controller.handle({ action: 'refresh' })
    expect(view.target).toBe('fr')
    expect(view.proposed).toEqual({ from: 'fr', to: 'en' })
    expect(view.route).toEqual({ ok: true, steps: [['fr', 'en']] })
    expect(system.requests).toEqual([{ command: 'availability', from: 'fr', to: 'en' }])
    expect((await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })).state).toBe('translated')
  })

  it('says what macOS does not have for the pair proposed, instead of nothing at all', async () => {
    const system = new SimulatedSystem()
    system.status = 'supported'
    const t = setup(system.engine(), { target: 'fr', lang: 'en', texts: ['Menu'] })
    const view = await t.controller.handle({ action: 'refresh' })
    expect(view.proposed).toEqual({ from: 'en', to: 'fr' })
    expect(view.system?.status).toBe('supported')
  })

  it('is what the person asked for once they have asked: the page is not read again to guess', async () => {
    const system = new SimulatedSystem()
    const t = setup(system.engine(), { target: 'fr', lang: 'en', texts: FRENCH })
    await t.controller.handle({ action: 'run', from: 'en', to: 'fr' })
    const view = await t.controller.handle({ action: 'packs' })
    expect(view.proposed).toBeNull()
    const again = await t.controller.handle({ action: 'refresh' })
    expect(again.proposed).toEqual({ from: 'en', to: 'fr' })
  })

  it('has no pair for the Settings window, which reads no page', async () => {
    const t = setup(new SimulatedSystem().engine(), { target: 'fr', texts: FRENCH })
    const view = await t.controller.handle({ action: 'packs' })
    expect(view.proposed).toBeNull()
    expect(view.page).toBeNull()
  })
})
