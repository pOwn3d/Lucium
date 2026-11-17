// What the person sees of the capture of the sound of a tab by an extension (shared/tab-capture.ts), as a window of the browser runs it
// (browser-media.ts, `onTabCapture`), on a stand-in of the class Browser (browser-fake.test-support.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frenchSpaces } from '@shared/french-typography'
import { setLanguage } from '@shared/i18n'
import { defaultSettings } from '@shared/model'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const EXT = 'a'.repeat(32)

beforeEach(() => setLanguage('fr'))
afterEach(() => setLanguage('fr'))

interface Toast {
  message: string
  action?: { label: string; run: () => void }
}

/** A window that tells the person what the engine says of the captures, with the extension actions it has. */
function windowWith() {
  const toasts: Toast[] = []
  const elsewhere: Toast[] = []
  const menu = vi.fn()
  // The notice goes to the window the person is in, which is not always the one that heard the engine.
  const inFront = { showToast: (message: string, action?: Toast['action']) => void toasts.push({ message, ...(action ? { action } : {}) }) }
  const own: Record<string, unknown> = {
    noticeWindow: () => inFront,
    showToast: (message: string) => void elsewhere.push({ message }),
    extensionActions: { menu },
    onTabCapture: shell['onTabCapture']
  }
  const fake = fakeBrowser(own)
  const tell = (event: unknown) => shell['onTabCapture']!.call(fake.self, event)
  return { tell, toasts, menu, elsewhere }
}

describe('an extension that asks to capture the sound of a tab while it is not allowed', () => {
  it('is told to the person, with the name of the extension and a button to its details', () => {
    const { tell, toasts, elsewhere } = windowWith()
    tell({ kind: 'refused', profileId: 'work', extensionId: EXT, name: 'Captions' })
    expect(toasts).toHaveLength(1)
    expect(elsewhere).toEqual([])
    expect(toasts[0]!.message).toBe(frenchSpaces('Captions a voulu capter le son d’un onglet : c’est désactivé pour cette extension.'))
    expect(toasts[0]!.action?.label).toBe('Ouvrir les détails')
  })

  it('opens the details of that extension, in that profile, with the button', () => {
    const { tell, toasts, menu } = windowWith()
    tell({ kind: 'refused', profileId: 'work', extensionId: EXT, name: 'Captions' })
    toasts[0]!.action!.run()
    expect(menu).toHaveBeenCalledExactlyOnceWith('manage', 'work', EXT)
  })

  it('is told in English when the language is English', () => {
    setLanguage('en')
    const { tell, toasts } = windowWith()
    tell({ kind: 'refused', profileId: 'default', extensionId: EXT, name: 'Captions' })
    expect(toasts[0]!.message).toBe('Captions tried to capture a tab’s sound: that is switched off for this extension.')
    expect(toasts[0]!.action?.label).toBe('Open details')
  })

  it('cannot put a name that is not a name in the sentence: it is cleaned and cut', () => {
    const { tell, toasts } = windowWith()
    tell({ kind: 'refused', profileId: 'default', extensionId: EXT, name: `Evil\u0007‮${'x'.repeat(300)}` })
    expect(toasts[0]!.message).not.toMatch(/[\u0000-\u001f‮]/)
    expect(toasts[0]!.message.length).toBeLessThan(160)
  })
})

describe('a capture that begins and ends', () => {
  const TAB = 'tab-1'
  /** A window that shows the tab, and the engine that knows its number. The runtime and the notices are what the person sees. */
  function shown(over: { owner?: 'this' | 'other' | 'none'; destroyed?: boolean } = {}) {
    const toasts: Toast[] = []
    const stopped: number[] = []
    const published: string[] = []
    const ownerStops = vi.fn()
    const other = { markCaptured: vi.fn(), stopTabCapture: ownerStops }
    const own: Record<string, unknown> = {
      win: { isDestroyed: () => over.destroyed === true },
      runtime: { tabs: { [TAB]: { loading: false, audible: true, muted: false, awake: true } }, canGoBack: false, canGoForward: false },
      engine: { pageIdOfTabNumber: (n: number) => (n === 7 ? TAB : undefined), tabNumberOf: (id: string) => (id === TAB ? 7 : undefined), stopTabCapture: (n: number) => void stopped.push(n) },
      store: { get: () => ({ tabs: [{ id: 'another-tab', title: 'Une autre page' }, { id: TAB, title: 'Réunion du lundi' }], settings: defaultSettings() }) },
      noticeWindow: () => inFront,
      ownerOf: () => (over.owner === 'other' ? other : over.owner === 'none' ? undefined : fake.self),
      layout: () => void published.push('layout'),
      publish: () => void published.push('publish'),
      markCaptured: shell['markCaptured'],
      stopTabCapture: shell['stopTabCapture']
    }
    const inFront = { showToast: (message: string, action?: Toast['action']) => void toasts.push({ message, ...(action ? { action } : {}) }) }
    const fake = fakeBrowser(own)
    const tell = (event: unknown) => shell['onTabCapture']!.call(fake.self, event)
    const info = () => (own['runtime'] as { tabs: Record<string, Record<string, unknown>> }).tabs[TAB]!
    return { tell, toasts, stopped, published, info, other, ownerStops, fake }
  }
  const started = { kind: 'started', tabNumber: 7, profileId: 'default', extensionId: EXT, name: 'Captions' }
  const ended = (muted: boolean) => ({ kind: 'ended', tabNumber: 7, profileId: 'default', extensionId: EXT, name: 'Captions', muted })

  it('marks the tab with the name of the extension while the capture lasts, and publishes it', () => {
    const { tell, info, published } = shown()
    tell(started)
    expect(info()['capturedBy']).toBe('Captions')
    expect(published).toEqual(['layout', 'publish'])
  })

  it('puts on the mark a name that is cleaned and cut, as in the notice: the name of an extension is any text its author wrote', () => {
    const { tell, info } = shown()
    tell({ ...started, name: `Evil\u0007‮${'x'.repeat(300)}` })
    const mark = info()['capturedBy'] as string
    expect(mark).not.toMatch(/[\u0000-\u001f\u202e]/)
    expect(mark.length).toBeLessThanOrEqual(80)
    expect(mark.startsWith('Evil x')).toBe(true)
    // A name that is nothing once cleaned is a question mark, as in the notice.
    tell({ ...started, name: '\u0007\u202e ' })
    expect(info()['capturedBy']).toBe('?')
  })

  it('hands the window that shows the tab the same clean name', () => {
    const { tell, other } = shown({ owner: 'other' })
    tell({ ...started, name: `Evil\u0007${'y'.repeat(300)}` })
    expect(other.markCaptured).toHaveBeenCalledExactlyOnceWith(TAB, `Evil ${'y'.repeat(75)}`)
  })

  it('tells the person once, with the title of the tab and the way to stop it', () => {
    const { tell, toasts, stopped } = shown()
    tell(started)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]!.message).toBe(frenchSpaces('Captions capte maintenant le son de l’onglet « Réunion du lundi ».'))
    expect(toasts[0]!.action?.label).toBe('Arrêter la capture du son')
    toasts[0]!.action!.run()
    expect(stopped).toEqual([7])
  })

  it('takes the mark away when the capture ends, and puts the speaker of the row where the sound went back to', () => {
    const { tell, info } = shown()
    tell(started)
    tell(ended(true))
    expect(info()).toEqual({ loading: false, audible: true, muted: true, awake: true })
    const again = shown()
    again.tell(started)
    again.tell(ended(false))
    expect(again.info()['muted']).toBe(false)
    expect(again.info()).not.toHaveProperty('capturedBy')
  })

  it('keeps what else the tab shows when it marks it and when it takes the mark away', () => {
    const { tell, info } = shown()
    tell(started)
    expect(info()).toMatchObject({ loading: false, audible: true, muted: false, awake: true })
  })

  it('says nothing, and marks nothing, for a tab that is not there (a number that is none, a window that is closing)', () => {
    const none = shown({ owner: 'none' })
    none.tell(started)
    expect(none.info()).not.toHaveProperty('capturedBy')
    expect(none.toasts).toEqual([])
    const unknown = shown()
    unknown.tell({ ...started, tabNumber: 99 })
    expect(unknown.info()).not.toHaveProperty('capturedBy')
    const closing = shown({ destroyed: true })
    closing.tell(started)
    expect(closing.info()).not.toHaveProperty('capturedBy')
    expect(closing.published).toEqual([])
  })

  it('leaves the mark to the window that shows the tab', () => {
    const { tell, other, info, toasts } = shown({ owner: 'other' })
    tell(started)
    expect(other.markCaptured).toHaveBeenCalledExactlyOnceWith(TAB, 'Captions')
    expect(info()).not.toHaveProperty('capturedBy')
    tell(ended(false))
    expect(other.markCaptured).toHaveBeenLastCalledWith(TAB, undefined, false)
    // The notice is for the window the person is in.
    expect(toasts).toHaveLength(1)
  })

  it('marks no tab the runtime does not hold', () => {
    const { fake, published } = shown()
    shell['markCaptured']!.call(fake.self, 'ghost-tab', 'Captions')
    expect((fake.self['runtime'] as { tabs: Record<string, unknown> }).tabs).not.toHaveProperty('ghost-tab')
    expect(published).toEqual([])
  })

  it('stops the capture of a tab: asks the engine, by the number of the tab, from the window that shows it', () => {
    const { fake, stopped } = shown()
    shell['stopTabCapture']!.call(fake.self, TAB)
    expect(stopped).toEqual([7])
    shell['stopTabCapture']!.call(fake.self, 'unknown-tab')
    expect(stopped).toEqual([7])
  })

  it('passes the stop on to the window that shows the tab', () => {
    const { fake, ownerStops, stopped } = shown({ owner: 'other' })
    shell['stopTabCapture']!.call(fake.self, TAB)
    expect(ownerStops).toHaveBeenCalledExactlyOnceWith(TAB)
    expect(stopped).toEqual([])
  })
})

describe('what the person allowed, given to the engine', () => {
  /** The settings as `configureExtensions` reads them, and what it hands the engine. */
  function configured(profiles: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const configureExtensions = vi.fn()
    const settings = { ...defaultSettings(), profiles, ...extra } as never
    const own: Record<string, unknown> = { isPrivate: () => false, isSecondary: () => false, store: { get: () => ({ settings }) }, extensionFolders: { follow: vi.fn() }, engine: { configureExtensions }, extensionsKey: undefined }
    const fake = fakeBrowser(own)
    shell['configureExtensions']!.call(fake.self)
    return { configureExtensions, fake }
  }

  it('lists, by profile, the extensions the person let capture the sound of a tab: none by default', () => {
    expect(configured({}).configureExtensions.mock.calls[0]![0]).toMatchObject({ tabCapture: {}, disabled: {} })
    const { configureExtensions } = configured({ work: { tabCaptureExtensions: [EXT] }, home: { disabledExtensions: [EXT] }, calm: { tabCaptureExtensions: [] } })
    const config = configureExtensions.mock.calls[0]![0] as { tabCapture: unknown; disabled: unknown }
    // Only the profiles that allowed something are listed.
    expect(config.tabCapture).toEqual({ work: [EXT] })
    expect(config.disabled).toEqual({ home: [EXT] })
  })

  it('hands over whether the whole function is on: it is, by default', () => {
    expect(configured({}).configureExtensions.mock.calls[0]![0]).toMatchObject({ tabCaptureOn: true })
    expect(configured({}, { extensionTabCapture: false }).configureExtensions.mock.calls[0]![0]).toMatchObject({ tabCaptureOn: false })
  })

  it('tells the engine again when only that choice changes', () => {
    const first = configured({})
    expect(first.configureExtensions).toHaveBeenCalledTimes(1)
    // The same settings: nothing is sent again. A change of the capture alone: it is.
    const settings = { ...defaultSettings(), profiles: { work: { tabCaptureExtensions: [EXT] } } } as never
    ;(first.fake.self as Record<string, unknown>)['store'] = { get: () => ({ settings }) }
    shell['configureExtensions']!.call(first.fake.self)
    expect(first.configureExtensions).toHaveBeenCalledTimes(2)
    shell['configureExtensions']!.call(first.fake.self)
    expect(first.configureExtensions).toHaveBeenCalledTimes(2)
    // The switch of the whole function is a change of its own.
    const off = { ...defaultSettings(), profiles: { work: { tabCaptureExtensions: [EXT] } }, extensionTabCapture: false } as never
    ;(first.fake.self as Record<string, unknown>)['store'] = { get: () => ({ settings: off }) }
    shell['configureExtensions']!.call(first.fake.self)
    expect(first.configureExtensions).toHaveBeenCalledTimes(3)
  })
})
