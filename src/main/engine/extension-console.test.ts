import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { Session, WebContents } from 'electron'
import { ExtensionJournal } from '@shared/extension-journal'
import { ExtensionConsoleWatch, isLibraryTrace, type ConsoleEnv } from './extension-console'

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)

class FakeSession {
  readonly serviceWorkers = new EventEmitter()
}

class FakeContents extends EventEmitter {
  destroyed = false
  constructor(
    readonly session: FakeSession,
    private url: string
  ) {
    super()
  }
  getURL(): string {
    return this.url
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  navigate(url: string, mainFrame = true): void {
    this.url = url
    this.emit('did-start-navigation', { url, isMainFrame: mainFrame })
  }
}

function setup(existing: FakeContents[] = []) {
  const profile = new FakeSession()
  const other = new FakeSession()
  const created = new EventEmitter()
  const contents = [...existing]
  const env: ConsoleEnv = {
    sources: () => [
      { profileId: 'default', session: profile as unknown as Session },
      { profileId: 'work', session: other as unknown as Session }
    ],
    onContentsCreated: (listener) => {
      created.on('created', listener)
      return () => created.off('created', listener)
    },
    contents: () => contents as unknown as WebContents[]
  }
  const journal = new ExtensionJournal()
  const watch = new ExtensionConsoleWatch(journal, env)
  const listeners = () => profile.serviceWorkers.listenerCount('console-message') + other.serviceWorkers.listenerCount('console-message') + created.listenerCount('created')
  const make = (session: FakeSession, url: string): FakeContents => {
    const wc = new FakeContents(session, url)
    contents.push(wc)
    created.emit('created', {}, wc)
    return wc
  }
  const say = (session: FakeSession, details: { message: string; level: number; sourceUrl: string; lineNumber?: number }) => session.serviceWorkers.emit('console-message', {}, { lineNumber: 1, ...details })
  return { watch, journal, profile, other, created, listeners, make, say, contents }
}

describe('the console of the extensions', () => {
  it('listens to nothing until it is started: no listener on a session, none on the web contents that are made', () => {
    const t = setup()
    expect(t.listeners()).toBe(0)
    expect(t.watch.isWatching()).toBe(false)
    t.say(t.profile, { message: 'nobody hears', level: 3, sourceUrl: `chrome-extension://${A}/a.js` })
    expect(t.journal.list()).toEqual([])
  })

  it('records what a worker of an extension prints, with its level, its profile and where', () => {
    const t = setup()
    const stop = t.watch.start()
    t.say(t.profile, { message: 'hello', level: 1, sourceUrl: `chrome-extension://${A}/background.js`, lineNumber: 4 })
    t.say(t.other, { message: 'Uncaught Error: boom', level: 3, sourceUrl: `chrome-extension://${B}/sw.js`, lineNumber: 9 })
    expect(t.journal.list().map((e) => [e.level, e.source, e.profileId, e.extensionId === A ? 'A' : 'B', e.message, e.where])).toEqual([
      ['info', 'worker', 'default', 'A', 'hello', 'background.js:4'],
      ['error', 'worker', 'work', 'B', 'Uncaught Error: boom', 'sw.js:9']
    ])
    stop()
  })

  it('never reads the worker of a site, nor a message that is only verbose', () => {
    const t = setup()
    const stop = t.watch.start()
    t.say(t.profile, { message: 'a site speaks', level: 3, sourceUrl: 'https://example.com/sw.js' })
    t.say(t.profile, { message: 'verbose', level: 0, sourceUrl: `chrome-extension://${A}/a.js` })
    expect(t.journal.list()).toEqual([])
    stop()
  })

  it('stops listening when the last one that started it stops, and not before', () => {
    const t = setup()
    const first = t.watch.start()
    const second = t.watch.start()
    // Two windows share one listening: a second start adds nothing.
    expect(t.created.listenerCount('created')).toBe(1)
    expect(t.profile.serviceWorkers.listenerCount('console-message')).toBe(1)
    first()
    first()
    expect(t.watch.isWatching()).toBe(true)
    t.say(t.profile, { message: 'still heard', level: 3, sourceUrl: `chrome-extension://${A}/a.js` })
    expect(t.journal.list()).toHaveLength(1)
    second()
    expect(t.watch.isWatching()).toBe(false)
    expect(t.listeners()).toBe(0)
    t.say(t.profile, { message: 'not heard', level: 3, sourceUrl: `chrome-extension://${A}/a.js` })
    expect(t.journal.list()).toHaveLength(1)
  })

  it('takes up the same session again when it is started a second time', () => {
    const t = setup()
    t.watch.start()()
    const stop = t.watch.start()
    t.say(t.profile, { message: 'heard again', level: 2, sourceUrl: `chrome-extension://${A}/a.js` })
    expect(t.journal.list()).toHaveLength(1)
    stop()
  })

  it('listens to a profile whose session is made while it is on, and not otherwise', () => {
    const t = setup()
    const late = new FakeSession()
    t.watch.attach({ profileId: 'late', session: late as unknown as Session })
    expect(late.serviceWorkers.listenerCount('console-message')).toBe(0)
    const stop = t.watch.start()
    t.watch.attach({ profileId: 'late', session: late as unknown as Session })
    late.serviceWorkers.emit('console-message', {}, { message: 'x', level: 3, sourceUrl: `chrome-extension://${A}/a.js`, lineNumber: 1 })
    expect(t.journal.list().map((e) => e.profileId)).toEqual(['late'])
    stop()
    expect(late.serviceWorkers.listenerCount('console-message')).toBe(0)
  })

  it('listens to the page of an extension, from its first address, and to no other page', () => {
    const t = setup()
    const stop = t.watch.start()
    const options = t.make(t.profile, '')
    const tab = t.make(t.profile, '')
    options.navigate(`chrome-extension://${A}/options.html`)
    tab.navigate('https://example.com/')
    options.emit('console-message', { message: 'options says', level: 'warning', lineNumber: 3, sourceId: `chrome-extension://${A}/options.js` })
    tab.emit('console-message', { message: 'a site says', level: 'error', lineNumber: 1, sourceId: 'https://example.com/app.js' })
    expect(options.listenerCount('console-message')).toBe(1)
    expect(tab.listenerCount('console-message')).toBe(0)
    expect(t.journal.list().map((e) => [e.source, e.level, e.message, e.where])).toEqual([['page', 'warning', 'options says', 'options.js:3']])
    stop()
    expect(options.listenerCount('console-message')).toBe(0)
    expect(options.listenerCount('did-start-navigation')).toBe(0)
    expect(tab.listenerCount('did-start-navigation')).toBe(0)
  })

  it('listens to the pages of extensions that are already open, and ignores a subframe', () => {
    const popup = new FakeContents(new FakeSession(), `chrome-extension://${A}/popup.html`)
    const t = setup([popup])
    popup.session.serviceWorkers.removeAllListeners()
    const stop = t.watch.start()
    expect(popup.listenerCount('console-message')).toBe(1)
    const frame = t.make(t.profile, '')
    frame.navigate(`chrome-extension://${A}/embedded.html`, false)
    expect(frame.listenerCount('console-message')).toBe(0)
    stop()
  })

  it('drops what a page says once it has gone on to a site, or its session is not a profile', () => {
    const t = setup()
    const stop = t.watch.start()
    const page = t.make(t.profile, '')
    page.navigate(`chrome-extension://${A}/a.html`)
    page.navigate('https://example.com/')
    page.emit('console-message', { message: 'a site now', level: 'error', lineNumber: 1, sourceId: 'x' })
    const stray = t.make(new FakeSession(), '')
    stray.navigate(`chrome-extension://${A}/a.html`)
    stray.emit('console-message', { message: 'no profile', level: 'error', lineNumber: 1, sourceId: 'x' })
    expect(t.journal.list()).toEqual([])
    stop()
  })

  it('lets go of a page that was destroyed without failing', () => {
    const t = setup()
    const stop = t.watch.start()
    const page = t.make(t.profile, '')
    page.navigate(`chrome-extension://${A}/a.html`)
    page.destroyed = true
    expect(() => stop()).not.toThrow()
  })
})

describe('the extension library\'s own trace of the calls (it is published with its debug switch on)', () => {
  it('is not recorded, from a page or a worker: it carries the tabs and cookies the calls pass and answer', () => {
    const t = setup()
    const stop = t.watch.start()
    const popup = t.make(t.profile, '')
    popup.navigate(`chrome-extension://${A}/popup.html`)
    for (const message of ['tabs.query [object Object]', 'cookies.getAll (result) [object Object],[object Object]', 'tabs.query ', 'windows.getCurrent']) {
      popup.emit('console-message', { message, level: 'info', lineNumber: 1, sourceId: '' })
      t.say(t.profile, { message, level: 1, sourceUrl: `chrome-extension://${A}/sw.js` })
    }
    t.say(t.profile, { message: 'tabs.onUpdated (result) 12 [object Object] [object Object]', level: 1, sourceUrl: `chrome-extension://${A}/sw.js` })
    expect(t.journal.list()).toEqual([])
    stop()
  })

  it('is told apart from what the extension prints itself, and from the library\'s warnings', () => {
    expect(isLibraryTrace('info', 'cookies.onChanged (result) [object Object]')).toBe(true)
    expect(isLibraryTrace('info', 'downloads.download [object Object]')).toBe(true)
    // An event named by the extension, a sentence, a file name: the extension's own lines.
    expect(isLibraryTrace('info', 'runtime.onInstalled fired')).toBe(false)
    expect(isLibraryTrace('info', 'background.js loaded')).toBe(false)
    expect(isLibraryTrace('info', 'Signed in')).toBe(false)
    // What the library says at another level is worth reading (an API it does not implement).
    expect(isLibraryTrace('warning', 'tabs.discard is not yet implemented.')).toBe(false)
    expect(isLibraryTrace('error', 'tabs.query (result) undefined')).toBe(false)
  })
})

describe('the library\'s notice about a page without context isolation (an offscreen document, the background page of a Manifest V2 extension)', () => {
  const notice = `injectExtensionAPIs: context isolation disabled in chrome-extension://${A}/offscreen.html`

  it('is not recorded: the extension can do nothing about it, and read in the journal it looks like its own fault', () => {
    const t = setup()
    const stop = t.watch.start()
    const page = t.make(t.profile, '')
    page.navigate(`chrome-extension://${A}/offscreen.html`)
    page.emit('console-message', { message: notice, level: 'warning', lineNumber: 576, sourceId: '' })
    expect(t.journal.list()).toEqual([])
    // The page's own lines are still heard.
    page.emit('console-message', { message: 'offscreen ready', level: 'info', lineNumber: 1, sourceId: `chrome-extension://${A}/offscreen.js` })
    expect(t.journal.list().map((entry) => entry.message)).toEqual(['offscreen ready'])
    stop()
  })

  it('is told apart by its sentence, its level and its address: the same words from a web page or at another level are not its own', () => {
    expect(isLibraryTrace('warning', notice)).toBe(true)
    expect(isLibraryTrace('info', notice)).toBe(false)
    expect(isLibraryTrace('error', notice)).toBe(false)
    expect(isLibraryTrace('warning', 'injectExtensionAPIs: context isolation disabled in https://site.example/')).toBe(false)
    expect(isLibraryTrace('warning', 'context isolation disabled in the options page')).toBe(false)
    // The library's other warnings stay (a real failure of its own: `injectExtensionAPIs error`).
    expect(isLibraryTrace('error', `injectExtensionAPIs error (chrome-extension://${A}/offscreen.html)`)).toBe(false)
  })
})

describe('the pages of extensions left open when the Extensions page is opened again', () => {
  it('are listened to again: the second listening does not take them for pages it already has', () => {
    const popup = new FakeContents(new FakeSession(), `chrome-extension://${A}/popup.html`)
    const t = setup([popup])
    ;(popup as unknown as { session: unknown }).session = t.profile
    t.watch.start()()
    expect(popup.listenerCount('console-message')).toBe(0)
    const stop = t.watch.start()
    expect(popup.listenerCount('console-message')).toBe(1)
    popup.emit('console-message', { message: 'still here', level: 'warning', lineNumber: 2, sourceId: `chrome-extension://${A}/popup.js` })
    expect(t.journal.list().map((e) => e.message)).toEqual(['still here'])
    stop()
  })
})
