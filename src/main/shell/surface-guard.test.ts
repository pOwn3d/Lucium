import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { appRoots, isSurfaceLocked, lockSurface } from './surface-guard'

const roots = appRoots('/Applications/Lucium.app/Contents/Resources/app.asar/out/renderer', true)
const home = `${roots.fileRoot}index.html`

/** A web contents reduced to what `lockSurface` touches: events, and the handler of window.open. */
function fakeContents() {
  const emitter = new EventEmitter()
  let open: ((details: { url: string }) => { action: string }) | null = null
  const contents = Object.assign(emitter, {
    setWindowOpenHandler: (handler: typeof open) => {
      open = handler
    }
  })
  const navigate = (event: string, url: string, ...rest: unknown[]) => {
    const e = { preventDefault: vi.fn(), url }
    emitter.emit(event, e, url, ...rest)
    return e.preventDefault.mock.calls.length > 0
  }
  return { contents: contents as never, navigate, windowOpen: (url: string) => open?.({ url }), attach: () => emitter.emit('will-attach-webview', { preventDefault: vi.fn() }) }
}

describe('lockSurface', () => {
  it('cancels a navigation of the surface to a remote page, and lets it go to its own pages', () => {
    const { contents, navigate } = fakeContents()
    lockSurface(contents, roots)
    expect(navigate('will-navigate', 'https://example.com/')).toBe(true)
    expect(navigate('will-navigate', 'file:///etc/hosts')).toBe(true)
    expect(navigate('will-navigate', 'data:text/html,<p>x</p>')).toBe(true)
    expect(navigate('will-navigate', home)).toBe(false)
  })

  it('cancels a navigation of a frame inside the surface, which will-navigate does not speak for', () => {
    const { contents, navigate } = fakeContents()
    lockSurface(contents, roots)
    expect(navigate('will-frame-navigate', 'https://example.com/')).toBe(true)
    expect(navigate('will-frame-navigate', home)).toBe(false)
  })

  it('cancels a redirect away from the interface', () => {
    const { contents, navigate } = fakeContents()
    lockSurface(contents, roots)
    expect(navigate('will-redirect', 'https://example.com/')).toBe(true)
    expect(navigate('will-redirect', home)).toBe(false)
  })

  it('refuses every window the surface asks for, whatever the address', () => {
    const { contents, windowOpen } = fakeContents()
    lockSurface(contents, roots)
    for (const url of ['https://example.com/', home, 'about:blank', 'javascript:alert(1)']) expect(windowOpen(url), url).toEqual({ action: 'deny' })
  })

  it('refuses a <webview>', () => {
    const { contents } = fakeContents()
    const event = { preventDefault: vi.fn() }
    lockSurface(contents, roots)
    ;(contents as unknown as EventEmitter).emit('will-attach-webview', event)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('is applied once, and says so', () => {
    const { contents, navigate } = fakeContents()
    expect(isSurfaceLocked(contents)).toBe(false)
    lockSurface(contents, roots)
    lockSurface(contents, roots)
    expect(isSurfaceLocked(contents)).toBe(true)
    expect((contents as unknown as EventEmitter).listenerCount('will-navigate')).toBe(1)
    expect(navigate('will-navigate', 'https://example.com/')).toBe(true)
  })

  it('does not follow a dev server in a packaged application, and does while developing', () => {
    expect(appRoots('/app/out/renderer', true, 'http://localhost:5173').devUrl).toBeNull()
    expect(appRoots('/app/out/renderer', false, 'http://localhost:5173').devUrl).toBe('http://localhost:5173')
    const { contents, navigate } = fakeContents()
    lockSurface(contents, appRoots('/app/out/renderer', true, 'http://localhost:5173'))
    expect(navigate('will-navigate', 'http://localhost:5173/index.html')).toBe(true)
  })
})
