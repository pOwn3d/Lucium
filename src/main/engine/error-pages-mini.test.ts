// The « Ouvrir en mini-fenêtre » button of an error page must reach the browser's mini window opener (PageErrors in error-pages.ts), run on a
// page without Electron (page-errors.test-support.ts), and the page the engine makes must hand it the opener the shell gave the engine (the opener
// main() gives the engine: shell/own-windows-wiring.test.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ERROR_SCHEME } from '@shared/error-pages'
import { engineForPages } from './electron-page.test-support'
import { FakeContents, FakeCover, fakeHost, nonceIn, settle } from './page-errors.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub({ clipboard: { writeText: vi.fn() }, shell: { openExternal: vi.fn(async () => undefined) } }))
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))
vi.mock('./page-cover', async () => ({ PageCover: (await import('./page-errors.test-support')).FakeCover }))

const { PageErrors } = await import('./error-pages')
const { ElectronEngine } = await import('./electron-engine')

function page(withOpener = true) {
  const wc = new FakeContents()
  const host = fakeHost()
  if (!withOpener) Reflect.deleteProperty(host, 'openMini')
  new PageErrors(wc as never, host as never)
  return { wc, host }
}

beforeEach(() => {
  FakeCover.made = []
})

describe('error page: open in a mini window', () => {
  it('opens the address that failed in the mini window, and leaves the page where it is', () => {
    const { wc, host } = page()
    wc.fail('https://absent.example/page')
    wc.click('open-mini-window')
    expect(host.openMini).toHaveBeenCalledWith('https://absent.example/page')
    expect(host.reload).not.toHaveBeenCalled()
  })

  it('opens the address of a blank error status from its cover too', async () => {
    const { wc, host } = page()
    wc.commit('https://site.example/absent', 404)
    wc.emit('did-finish-load')
    await settle()
    FakeCover.made[0]!.click('open-mini-window')
    expect(host.openMini).toHaveBeenCalledWith('https://site.example/absent')
  })

  it('does nothing on a page that has no window of the browser to open it from (a popup)', () => {
    const { wc, host } = page(false)
    wc.fail('https://absent.example/page')
    expect(() => wc.click('open-mini-window')).not.toThrow()
    expect(host.reload).not.toHaveBeenCalled()
  })

  it('is wired from the engine to the opener the shell gave it: a page made before the opener was set uses it all the same', async () => {
    const world = await engineForPages({ ready: null })
    const { view } = world.create('t1')
    const wc = view.webContents
    wc.url = 'https://absent.example/page'
    const click = async (): Promise<void> => {
      wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://absent.example/page', true)
      wc.emit('dom-ready')
      await settle()
      const written = wc.executeJavaScript.mock.calls.map(([code]) => String(code)).filter((code) => code.includes(ERROR_SCHEME)).at(-1) ?? ''
      wc.emit('will-navigate', { preventDefault: () => undefined }, `${ERROR_SCHEME}open-mini-window?n=${nonceIn(written)}`)
    }
    // No opener yet: nothing happens, and nothing throws.
    await click()
    const opener = vi.fn()
    ;(ElectronEngine.prototype as unknown as Record<string, (this: unknown, opener: (url: string) => void) => void>)['setMiniWindowOpener']!.call(world.engine, opener)
    await click()
    expect(opener).toHaveBeenCalledExactlyOnceWith('https://absent.example/page')
  })
})
