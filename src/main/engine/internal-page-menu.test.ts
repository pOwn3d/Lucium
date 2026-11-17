// The right-click menu of a tab. The entries the extensions add (`contextMenus`) are for the pages of the web: a click on one tells the extension the address of the
// page it was made on (`info.pageUrl`, and the tab), which for the Extensions page is the browser's own address, not for an extension to be told.
// A real ElectronPage over stand-ins (electron-page.test-support.ts), and a library that has an entry.

import { describe, expect, it, vi } from 'vitest'
import { itemLabelled, makePage } from './electron-page.test-support'

const library = vi.hoisted(() => ({ items: vi.fn((): unknown[] => [{ label: 'From an extension' }]) }))
vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({
  ElectronChromeExtensions: { fromSession: () => ({ api: { contextMenus: { menus: new Map([['abcdefghijklmnopabcdefghijklmnop', {}]]) } }, getContextMenuItems: library.items }) }
}))
vi.mock('electron-chrome-web-store', () => ({}))

describe('the entries of the extensions in the menu of a page', () => {
  it('are in the menu of a page of the web', async () => {
    library.items.mockClear()
    const { wc } = await makePage()
    wc.url = 'https://site.example/'
    expect(itemLabelled(wc.rightClick({}), 'From an extension')).toBeDefined()
    expect(library.items).toHaveBeenCalled()
  })

  it('are not in the menu of the Extensions page, and the library is not asked for them', async () => {
    library.items.mockClear()
    const { wc } = await makePage()
    for (const url of ['lucium-ui://extensions/', 'lucium-ui://extensions/shortcuts', `lucium-ui://extensions/?id=${'a'.repeat(32)}`]) {
      wc.url = url
      expect(itemLabelled(wc.rightClick({}), 'From an extension'), url).toBeUndefined()
    }
    expect(library.items).not.toHaveBeenCalled()
  })
})
