// « Surveiller cette page » and a private tab of a normal window: its address is never written into the watched pages (the
// settings, so state.json, the automatic copies and an export), and never looked at again with the cookies of the profile. The real method and
// the real menu run on stand-ins for the window.

import { describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { t } from '@shared/i18n'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))

const { Browser } = await import('./browser')
const { webToolsFileItems } = await import('./web-tools-menu')
const methods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => Promise<void>>

const URL_OF_PAGE = 'https://boutique.example/produit'

/** A normal window whose tab on screen is `private` or not, with the watched pages switched on. */
function windowWith(tabIsPrivate: boolean) {
  const settings: Settings = { ...defaultSettings(), pageWatch: true }
  const space = { id: 's1', profileId: 'default' }
  const tab = { id: 't1', spaceId: 's1', url: URL_OF_PAGE, title: 'Produit', pinned: false, createdAt: 1, lastActiveAt: 1, ...(tabIsPrivate ? { private: true } : {}) }
  const state = { settings, tabs: [tab], spaces: [space], activeSpaceId: 's1', activeTabBySpace: { s1: 't1' }, splits: [] }
  const dispatch = vi.fn()
  const showToast = vi.fn()
  const self = {
    store: { get: () => state },
    followPaneFocus: () => undefined,
    isPrivate: () => false,
    containerKeyOf: () => '',
    pages: new Map(),
    dispatch,
    showToast,
    settingsOpener: null
  }
  return { self, state, dispatch, showToast }
}

describe('watching the page of a private tab', () => {
  it('is refused with a notice, and nothing is written into the settings', async () => {
    const { self, dispatch, showToast } = windowWith(true)
    await methods['watchPage']!.call(self, false)
    await methods['watchPage']!.call(self, true)
    expect(dispatch).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(t('browser.page-privee-non-surveillable'))
  })

  it('goes on for a tab that is not private', async () => {
    const { self, dispatch } = windowWith(false)
    await methods['watchPage']!.call(self, false)
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'settings/update', patch: { pageWatches: [expect.objectContaining({ url: URL_OF_PAGE })] } }))
  })

  it('is greyed out in the File menu for a private tab', () => {
    const entries = (tabIsPrivate: boolean) => {
      const { state } = windowWith(tabIsPrivate)
      const items = webToolsFileItems({ browser: {} as never, store: { get: () => state } as never, acc: () => undefined, page: URL_OF_PAGE, facts: {} as never, private: false, report: () => () => undefined })
      return items.filter((item) => item.label === t('menu.surveiller-cette-page') || item.label === t('menu.surveiller-une-zone-de-la-page')).map((item) => item.enabled)
    }
    expect(entries(true)).toEqual([false, false])
    expect(entries(false)).toEqual([true, true])
  })
})
