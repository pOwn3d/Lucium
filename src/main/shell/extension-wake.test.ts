// The toolbar click wakes the extension's worker first (an idle worker drops the click), and the translation entry of the page menu is offered
// on every non-editable context, once. The real methods of the Browser and of the engine run on stand-ins for what they touch (the window, the sessions,
// the page): what is checked is the order of what they do and what the menu holds.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'

// The menu is what Menu.buildFromTemplate receives; the other names only need to exist (the engine reaches Electron when a method runs).
const electron = vi.hoisted(() => ({ template: [] as unknown[] }))
vi.mock('electron', () => new Proxy({ Menu: { buildFromTemplate: (template: unknown[]) => ((electron.template = template), { popup() {} }) } } as Record<string, unknown>, { get: (target, name: string) => (name in target ? target[name] : {}) }))
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: class { static fromSession() { return undefined } }, setSessionPartitionResolver() {} }))

const { Browser } = await import('./browser')
const { ElectronEngine, ElectronPage } = await import('../engine/electron-engine')
const browser = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => Promise<void>>
const engine = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => Promise<void>>

const ID = 'abcdefghijklmnopabcdefghijklmnop'

/** A promise the test settles when it says so. */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

/** Lets what is waiting on already settled promises run (no timer). */
const settle = () => new Promise<void>((done) => setImmediate(done))

describe('the toolbar click of an extension', () => {
  /** A window whose sidebar is shown; its engine wakes workers when it can (`engine.wakeExtension`), and the click is the script run in the interface. */
  function toolbar(wake: ((id: string) => Promise<void>) | undefined) {
    const steps: string[] = []
    const self = {
      store: { get: () => ({ settings: { sidebarVisible: true }, sidePanelBehavior: {} }) },
      dispatch: () => undefined,
      engine: wake ? { wakeExtension: async (id: string) => { steps.push(`wake ${id}`); await wake(id); steps.push('worker running') } } : {},
      win: { webContents: { executeJavaScript: async () => (steps.push('click'), true) } }
    }
    return { self, steps }
  }

  it('starts the worker before the click reaches the page', async () => {
    const worker = deferred()
    const bar = toolbar(() => worker.promise)
    const clicked = browser['activateExtension']!.call(bar.self, ID)
    await settle()
    // The worker is not running yet: the click waits.
    expect(bar.steps).toEqual([`wake ${ID}`])
    worker.resolve()
    await clicked
    expect(bar.steps).toEqual([`wake ${ID}`, 'worker running', 'click'])
  })

  it('clicks all the same with an engine that has no worker to wake', async () => {
    const bar = toolbar(undefined)
    await browser['activateExtension']!.call(bar.self, ID)
    expect(bar.steps).toEqual(['click'])
  })
})

describe('the worker of an extension, woken by the engine', () => {
  const SCOPE = `chrome-extension://${ID}/`

  /** A profile: `hasExtension` says whether the extension is loaded in it; its worker runs when `running` says so, and `start` is what starting it does. */
  function profile(options: { hasExtension: boolean; running?: boolean; start?: () => Promise<void> }) {
    const state = { running: options.running ?? false }
    const startWorkerForScope = vi.fn(options.start ?? (async () => undefined))
    return {
      state,
      startWorkerForScope,
      value: {
        session: {
          extensions: { getExtension: () => (options.hasExtension ? { id: ID } : undefined) },
          serviceWorkers: { getAllRunning: () => (state.running ? { 1: { scope: SCOPE } } : {}), startWorkerForScope }
        }
      }
    }
  }
  // The manifests are empty: nothing is known of the extension, so its worker is woken (an extension that declares none is not: worker-less-extension.test.ts).
  const wake = (...profiles: Array<ReturnType<typeof profile>>) =>
    engine['wakeExtension']!.call(Object.assign(Object.create(ElectronEngine.prototype) as object, { profiles: new Map(profiles.map((p, i) => [`p${i}`, p.value])), manifests: new Map() }), ID)

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('is started only in the profiles that have the extension', async () => {
    const without = profile({ hasExtension: false })
    const withIt = profile({ hasExtension: true, start: async () => void (withIt.state.running = true) })
    await wake(without, withIt)
    expect(without.startWorkerForScope).not.toHaveBeenCalled()
    expect(withIt.startWorkerForScope).toHaveBeenCalledExactlyOnceWith(SCOPE)
  })

  it('is left alone when it already runs', async () => {
    const running = profile({ hasExtension: true, running: true })
    await wake(running)
    expect(running.startWorkerForScope).not.toHaveBeenCalled()
  })

  it('waits until the worker runs before it answers', async () => {
    vi.useFakeTimers()
    const slow = profile({ hasExtension: true })
    let woken = false
    void wake(slow).then(() => (woken = true))
    await vi.advanceTimersByTimeAsync(500)
    expect(woken).toBe(false)
    slow.state.running = true
    await vi.advanceTimersByTimeAsync(100)
    expect(woken).toBe(true)
  })

  it('waits all the same when the start is refused (a start is already under way), and says so', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const refused = profile({ hasExtension: true, start: async () => Promise.reject(new Error('already starting')) })
    let woken = false
    void wake(refused).then(() => (woken = true))
    await vi.advanceTimersByTimeAsync(300)
    expect(woken).toBe(false)
    refused.state.running = true
    await vi.advanceTimersByTimeAsync(100)
    expect(woken).toBe(true)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('gives up after ten seconds when the worker never runs, and lets the click go on', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const never = profile({ hasExtension: true })
    let woken = false
    void wake(never).then(() => (woken = true))
    await vi.advanceTimersByTimeAsync(9_000)
    expect(woken).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(woken).toBe(true)
  })
})

describe('the translation entry of the page menu', () => {
  interface Context {
    isEditable?: boolean
    linkURL?: string
    selectionText?: string
    mediaType?: string
    srcURL?: string
  }

  /** The menu the page opens for a click in this context, on a page in `pageLang`, with these options. */
  function menuFor(context: Context, settings: { pageLang?: string; translate?: boolean; handler?: boolean; translateTarget?: string; translated?: boolean } = {}) {
    const translatePage = vi.fn()
    const events = {
      menuOptions: () => ({
        qrCode: false,
        readAloud: false,
        ...(settings.translate === false ? {} : { translate: true }),
        ...(settings.translateTarget !== undefined ? { translateTarget: settings.translateTarget } : {}),
        ...(settings.translated !== undefined ? { translated: settings.translated } : {})
      }),
      ...(settings.handler === false ? {} : { translatePage }),
      openWindow: () => undefined,
      searchSelection: () => undefined
    }
    const wc = { session: {}, mainFrame: {}, getURL: () => 'https://page.example/', navigationHistory: { canGoBack: () => false, canGoForward: () => false } }
    const page = Object.assign(Object.create(ElectronPage.prototype) as object, { view: { webContents: wc }, pageLang: settings.pageLang ?? 'en', speaking: false, win: {} })
    const params = { x: 0, y: 0, isEditable: false, linkURL: '', selectionText: '', mediaType: 'none', srcURL: '', misspelledWord: '', dictionarySuggestions: [], frame: null, ...context }
    ;(page as unknown as { showContextMenu(params: unknown, events: unknown): void }).showContextMenu(params, events)
    // « Traduire en <langue> » or « Afficher l'original »: whatever it is named, the one entry that calls the translation.
    const entries = (electron.template as Array<{ label?: string; click?: () => void }>).filter((item) => /^(Traduire en |Translate to )/.test(item.label ?? '') || item.label === t('translate.show-original'))
    return { entries, translatePage }
  }

  afterEach(() => setLanguage('fr'))

  const CONTEXTS: Array<[name: string, context: Context]> = [
    ['the page itself', {}],
    ['a link', { linkURL: 'https://other.example/' }],
    ['a selected text', { selectionText: 'some words' }],
    ['an image', { mediaType: 'image', srcURL: 'https://page.example/a.png' }]
  ]

  it.each(CONTEXTS)('is offered once on %s, for a page in another language than the interface', (_name, context) => {
    setLanguage('fr')
    const menu = menuFor(context)
    expect(menu.entries).toHaveLength(1)
    menu.entries[0]!.click!()
    expect(menu.translatePage).toHaveBeenCalledOnce()
  })

  it('is never offered in a field being edited', () => {
    expect(menuFor({ isEditable: true }).entries).toHaveLength(0)
    expect(menuFor({ isEditable: true, selectionText: 'some words' }).entries).toHaveLength(0)
  })

  it('is not offered for a page in the language of the interface, or in an unknown one', () => {
    setLanguage('fr')
    expect(menuFor({}, { pageLang: 'fr-CA' }).entries).toHaveLength(0)
    expect(menuFor({}, { pageLang: '' }).entries).toHaveLength(0)
  })

  it('is not offered when the option is off or when nothing can translate', () => {
    expect(menuFor({}, { translate: false }).entries).toHaveLength(0)
    expect(menuFor({}, { handler: false }).entries).toHaveLength(0)
  })

  it('names the language the page is translated into, and translates at once: « Traduire en français », never the panel’s « Traduire cette page… »', () => {
    setLanguage('fr')
    const menu = menuFor({})
    expect(menu.entries.map((item) => item.label)).toEqual(['Traduire en français'])
    expect((electron.template as Array<{ label?: string }>).some((item) => item.label === t('menu.traduire-cette-page'))).toBe(false)
    menu.entries[0]!.click!()
    expect(menu.translatePage).toHaveBeenCalledOnce()
    setLanguage('en')
    expect(menuFor({}, { pageLang: 'fr' }).entries.map((item) => item.label)).toEqual(['Translate to English'])
  })

  it('follows the language chosen in the settings: offered for a page in another one, named after it, not offered for a page already in it', () => {
    setLanguage('fr')
    expect(menuFor({}, { pageLang: 'fr', translateTarget: 'de' }).entries.map((item) => item.label)).toEqual(['Traduire en allemand'])
    expect(menuFor({}, { pageLang: 'de-AT', translateTarget: 'de' }).entries).toHaveLength(0)
  })

  it('is « Afficher l’original » on a translated page, whatever its text reads like now', () => {
    setLanguage('fr')
    const menu = menuFor({}, { pageLang: 'fr', translated: true })
    expect(menu.entries.map((item) => item.label)).toEqual(['Afficher l’original'])
    menu.entries[0]!.click!()
    expect(menu.translatePage).toHaveBeenCalledOnce()
    expect(menuFor({}, { pageLang: 'fr', translated: true, translate: false }).entries).toHaveLength(0)
  })
})
