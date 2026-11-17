// `loadSurface`, the one way a page of our interface is loaded, run for real over a web contents that is an event emitter: the surface is locked to
// our own pages before its first load and stays so, its errors reach the log, its page comes back when its renderer dies, and an environment
// variable cannot replace the interface of the built application. Before, two tests only read that the line `lockSurface(target, roots)` was in
// index.ts, which a condition or a comment in front of it left green.

import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isSurfaceLocked } from './surface-guard'
import { loadSurface, type Surface } from './surface-load'
import { setNoticeSink, type SystemNotice } from './system-notice'

const RENDERER = '/Applications/Lucium.app/Contents/Resources/app.asar/out/renderer'
const DEV = 'http://localhost:5173'

/** A web contents that keeps what it is asked to load, and whether it was locked at that moment. */
function fakeSurface(options: { loadFails?: boolean } = {}) {
  const emitter = new EventEmitter()
  const loads: Array<{ how: 'file' | 'url'; what: string; options?: unknown; lockedBefore: boolean }> = []
  let open: ((details: { url: string }) => { action: string }) | null = null
  let reloads = 0
  const result = (): Promise<void> => (options.loadFails ? Promise.reject(new Error('ERR_FILE_NOT_FOUND')) : Promise.resolve())
  const contents = Object.assign(emitter, {
    setWindowOpenHandler: (handler: typeof open) => void (open = handler),
    loadFile: (path: string, loadOptions?: unknown) => (loads.push({ how: 'file', what: path, options: loadOptions, lockedBefore: isSurfaceLocked(contents as never) }), result()),
    loadURL: (url: string) => (loads.push({ how: 'url', what: url, lockedBefore: isSurfaceLocked(contents as never) }), result()),
    isDestroyed: () => false,
    reload: () => void reloads++
  })
  /** A navigation of the surface: whether it was stopped. */
  const navigate = (event: string, url: string): boolean => {
    const e = { preventDefault: vi.fn(), url }
    emitter.emit(event, e, url)
    return e.preventDefault.mock.calls.length > 0
  }
  return { contents: contents as never, emitter, loads, navigate, windowOpen: (url: string) => open?.({ url }), reloads: () => reloads }
}

const load = (surface: Surface, built = true, options: { loadFails?: boolean } = {}) => {
  const fake = fakeSurface(options)
  loadSurface(fake.contents, surface, { rendererDir: RENDERER, built })
  return fake
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('a surface of the interface, as it is loaded', () => {
  it('is locked before its first load, whatever the page', () => {
    for (const page of ['index', 'overlay', 'littlearc', 'floating-video', 'settings', 'taskmanager', 'about', 'window-share-view', 'window-share-command', 'page-annotate-command'] as const) {
      const { loads } = load({ page })
      expect(loads, page).toHaveLength(1)
      expect(loads[0]!.lockedBefore, page).toBe(true)
    }
  })

  it('then refuses to show anything but our own pages: a remote page would inherit the whole API of the preload', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const surface = load({ page: 'index' })
    expect(surface.navigate('will-navigate', 'https://evil.example/')).toBe(true)
    expect(surface.navigate('will-redirect', 'https://evil.example/')).toBe(true)
    expect(surface.navigate('will-frame-navigate', 'https://evil.example/')).toBe(true)
    expect(surface.navigate('will-navigate', 'file:///etc/hosts')).toBe(true)
    expect(surface.navigate('will-attach-webview', '')).toBe(true)
    expect(surface.windowOpen('https://evil.example/')).toEqual({ action: 'deny' })
    // Its own pages stay reachable.
    // The address of a file is written from its path (a drive letter and no backslash on Windows), as the application writes it.
    expect(surface.navigate('will-navigate', pathToFileURL(join(RENDERER, 'settings.html')).href)).toBe(false)
  })

  it('loads the built page of the application, with its hash and its query', () => {
    const { loads } = load({ page: 'settings', hash: 'general', query: { id: 'w1' } })
    expect(loads).toEqual([{ how: 'file', what: join(RENDERER, 'settings.html'), options: { hash: 'general', query: { id: 'w1' } }, lockedBefore: true }])
  })

  it('never follows ELECTRON_RENDERER_URL in the built application: another process could replace the interface with a page of its own', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'https://evil.example')
    const surface = load({ page: 'index' }, true)
    expect(surface.loads.map((each) => each.how)).toEqual(['file'])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(surface.navigate('will-navigate', 'https://evil.example/index.html')).toBe(true)
  })

  it('follows the dev server while developing, and is locked to it and to the built pages', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', `${DEV}/`)
    const surface = load({ page: 'littlearc', hash: 'float', query: { id: 'a b' } }, false)
    expect(surface.loads).toEqual([{ how: 'url', what: `${DEV}/littlearc.html?id=a+b#float`, lockedBefore: true }])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(surface.navigate('will-navigate', `${DEV}/settings.html`)).toBe(false)
    expect(surface.navigate('will-navigate', 'https://evil.example/')).toBe(true)
  })

  it('has the errors of its page relayed to the log, under the name of the page', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const surface = load({ page: 'settings' })
    surface.emitter.emit('console-message', { level: 'error', message: '[ui] an error was not caught: boom' })
    expect(error).toHaveBeenCalledWith('[ui:settings] an error was not caught: boom')
  })

  it('tells the user through the system when its renderer keeps dying and it is no longer loaded again, and in the log when the system refuses', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const notices: SystemNotice[] = []
    let taken = true
    const restore = setNoticeSink((notice) => (notices.push(notice), taken))
    try {
      const dies = (surface: ReturnType<typeof load>): void => {
        for (let i = 0; i < 4; i++) surface.emitter.emit('render-process-gone', {}, { reason: 'crashed' })
      }
      dies(load({ page: 'index' }))
      expect(notices).toEqual([{ title: 'L’interface de Lucium ne répond plus', body: expect.stringContaining('quittez Lucium, puis rouvrez-le') }])
      expect(error.mock.calls.some((call) => String(call[0]).includes('could not tell the user'))).toBe(false)
      taken = false
      dies(load({ page: 'overlay' }))
      expect(error.mock.calls.some((call) => String(call[0]).includes('could not tell the user that the overlay page is no longer loaded again'))).toBe(true)
    } finally {
      restore()
    }
  })

  it('is loaded again when its renderer dies', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const surface = load({ page: 'overlay' })
    surface.emitter.emit('render-process-gone', {}, { reason: 'crashed' })
    vi.runAllTimers()
    expect(surface.reloads()).toBe(1)
  })

  it('says in the log when its page cannot be loaded', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    load({ page: 'about', hash: 'licence' }, true, { loadFails: true })
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('[shell] cannot load the about#licence UI:', expect.any(Error)))
  })
})

// That main() has no other way to load a page than the function above: main-wiring.test.ts, where main() is run.
