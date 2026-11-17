// "Aperçu du lien (Coup d’œil)" in the menu of a link is the user's explicit choice and must open the preview whatever "Coup d’œil avec Maj" says; a Shift+click is a
// request of the page, which the setting decides. The rule is tested in src/shared/link-open.test.ts and shared/little-modifier.test.ts; here the page
// of the engine runs over a fake web contents (engine/electron-page.test-support.ts), and the shell's events of a tab (`Browser.pageEvents`) on a
// stand-in: the class reaches Electron only when a method runs.

import { describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import type { TabItem } from '@shared/model'
import { itemLabelled, makePage } from './engine/electron-page.test-support'

vi.mock('electron', async () => (await import('./engine/electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))

const { Browser } = await import('./shell/browser')
const shellMethods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

const LINK = 'https://autre.example/article'

describe('the Glance of a link', () => {
  it('is asked by the menu of a link as a choice of the user, and by a Shift+click as a request of the page', async () => {
    const { wc, events } = await makePage()
    itemLabelled(wc.rightClick({ linkURL: LINK }), t('engine.apercu-du-lien-coup-d-oeil'))!.click!()
    expect(events.openWindow).toHaveBeenLastCalledWith(LINK, 'peek')

    // Shift+click: Chromium asks for a new window without a feature list, right after a click of the user.
    wc.click()
    expect(wc.open(LINK, { disposition: 'new-window', features: '' })).toEqual({ action: 'deny' })
    expect(events.openWindow).toHaveBeenLastCalledWith(LINK, 'peek', true, 'new-window', '')
  })

  it('is decided by opensPeek, which knows who asked, and not by the setting alone', () => {
    const tab: TabItem = { id: 't', spaceId: 's', url: 'https://site.example/', title: 'Site', pinned: false, createdAt: 1, lastActiveAt: 1 }
    const destinations = (peekWithShift: boolean) => {
      const openPeek = vi.fn()
      const openTabFromPage = vi.fn()
      const settings = { peekWithShift, peekOnExternalLinks: false, littleArcModifier: false, littleArcNewTabLinks: false }
      const shell = { store: { get: () => ({ tabs: [tab], settings }) }, littleOpener: null, isPrivate: () => false, openPeek, openTabFromPage }
      const events = shellMethods['pageEvents']!.call(shell, tab, () => true) as { openWindow: (...args: unknown[]) => void }
      events.openWindow(LINK, 'peek')
      events.openWindow(LINK, 'peek', true, 'new-window', '')
      return { peeks: openPeek.mock.calls.length, tabs: openTabFromPage.mock.calls.map((call) => call.slice(1)) }
    }
    // "Coup d’œil avec Maj" off: the menu still opens the preview, the Shift+click of the page opens a tab.
    expect(destinations(false)).toEqual({ peeks: 1, tabs: [[LINK, 'peek', true]] })
    // On: both preview.
    expect(destinations(true)).toEqual({ peeks: 2, tabs: [] })
  })
})
