import { describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

// Choosing an extension in the « menu, the Extensions menu or the command bar clicks its icon in the toolbar (activateExtension). An extension that asked for
// its side panel on a click of its icon gets the panel, even when the icon has no size (it does not fit the bar): the click it would get there is the one
// App.tsx turns into the panel, which a programmatic activation of a hidden icon does not go through.
// The method runs on a stand-in (browser-fake.test-support.ts): the shell reaches Electron only when a method runs.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const EXTENSION = 'a'.repeat(32)
const state = (behavior: Record<string, boolean>) => ({ ...createInitialState({ now: 0, newId: () => 'x' }), sidePanelBehavior: behavior })

function windowWith(behavior: Record<string, boolean>, openSidePanel = vi.fn()) {
  const executeJavaScript = vi.fn(() => Promise.resolve(true))
  const fake = fakeBrowser({ store: { get: () => state(behavior) }, openSidePanel, engine: { wakeExtension: vi.fn(() => Promise.resolve()) }, win: { webContents: { executeJavaScript } } })
  return { fake, openSidePanel, executeJavaScript }
}

describe('activating an extension from a menu', () => {
  it('opens its side panel when it asked for it on a click of its icon, without clicking an icon that may be hidden', async () => {
    const { fake, openSidePanel, executeJavaScript } = windowWith({ [EXTENSION]: true })
    await shell['activateExtension']!.call(fake.self, EXTENSION)
    expect(openSidePanel).toHaveBeenCalledWith(EXTENSION, undefined)
    expect(executeJavaScript).not.toHaveBeenCalled()
  })

  it('says why when the extension has no panel to show, and does not click the icon either (that click would reach it as an action it never handles)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { fake, executeJavaScript } = windowWith({ [EXTENSION]: true }, vi.fn(() => { throw new Error('no panel') }))
    await shell['activateExtension']!.call(fake.self, EXTENSION)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(EXTENSION), 'no panel')
    expect(executeJavaScript).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('clicks the icon of any other extension, and of one that did not ask for its panel', async () => {
    const other = windowWith({ [EXTENSION]: true })
    await shell['activateExtension']!.call(other.fake.self, 'b'.repeat(32))
    expect(other.openSidePanel).not.toHaveBeenCalled()
    expect(other.executeJavaScript).toHaveBeenCalledTimes(1)
    const off = windowWith({ [EXTENSION]: false })
    await shell['activateExtension']!.call(off.fake.self, EXTENSION)
    expect(off.openSidePanel).not.toHaveBeenCalled()
    expect(off.executeJavaScript).toHaveBeenCalledTimes(1)
  })
})
