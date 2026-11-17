// @vitest-environment happy-dom
// « Modifier l’onglet », mounted. Its four bubbles (name the window, QR code, translate, live folder) take the place of the editor and keep the
// name and the icon typed so far. They never send the address typed in the field: a click on « Code QR » must not take the tab to another page
// (and the code shown is the one of the page the tab is still on). Only « Enregistrer » sends the address.

import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import type { LuciumApi, OverlayRequest, UiSnapshot } from '@shared/ipc'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { TabEditor } from './ManagePanels'
import { button, click, mount, settle, type, type Mounted } from './dom.test-support'

const PAGE = 'https://a.example.org/page'
const ELSEWHERE = 'https://elsewhere.example/'

let mounted: Mounted | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

async function editor() {
  const ctx = { now: 1, newId: ((n = 0) => () => `id${++n}`)() }
  const state = reduce(createInitialState(ctx), { type: 'tab/open', url: PAGE } as Action, ctx)
  const tabId = state.tabs[0]!.id
  const dispatch = vi.fn(async (_action: Action) => undefined)
  const setTabAddress = vi.fn<(id: string, input: string) => void>()
  const openOverlay = vi.fn<(request: OverlayRequest) => void>()
  const closeOverlay = vi.fn<() => void>()
  const bridge = { getSnapshot: async () => ({ state, runtime: { tabs: {} } }) as unknown as UiSnapshot, onSnapshot: () => () => undefined, dispatch, setTabAddress, openOverlay, closeOverlay }
  ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = bridge as unknown as Partial<LuciumApi>
  mounted = mount(createElement(TabEditor, { tabId }))
  await settle()
  const [name, address] = [...mounted.container.querySelectorAll<HTMLInputElement>('input.tk-field')]
  return { container: mounted.container, tabId, name: name!, address: address!, dispatch, setTabAddress, openOverlay, closeOverlay }
}

describe('a bubble opened from « Modifier l’onglet »', () => {
  it('keeps the name typed, and does not send the tab to the address typed', async () => {
    const e = await editor()
    type(e.name, 'Mon onglet')
    type(e.address, ELSEWHERE)
    await click(button(e.container, t('qr-panel.code-qr')))
    expect(e.setTabAddress).not.toHaveBeenCalled()
    expect(e.dispatch.mock.calls.map((call) => call[0])).toEqual([{ type: 'tab/rename', id: e.tabId, title: 'Mon onglet' }])
    // The code is the one of the page the tab is on, which did not change.
    expect(e.openOverlay).toHaveBeenCalledWith({ panel: 'qr', text: PAGE })
  })

  it('is so for each of the four bubbles', async () => {
    for (const label of ['window-name.nommer-la-fenetre', 'qr-panel.code-qr', 'translate.translate', 'ctx.bloc-dossier-en-direct'] as const) {
      const e = await editor()
      type(e.address, ELSEWHERE)
      await click(button(e.container, t(label)))
      expect(e.openOverlay, label).toHaveBeenCalledTimes(1)
      expect(e.setTabAddress, label).not.toHaveBeenCalled()
      mounted?.unmount()
      mounted = null
    }
  })
})

describe('« Enregistrer »', () => {
  it('sends the address typed, with the name, and closes the editor', async () => {
    const e = await editor()
    type(e.name, 'Mon onglet')
    type(e.address, ELSEWHERE)
    await click(button(e.container, t('templates.enregistrer')))
    expect(e.setTabAddress).toHaveBeenCalledWith(e.tabId, ELSEWHERE)
    expect(e.dispatch).toHaveBeenCalledWith({ type: 'tab/rename', id: e.tabId, title: 'Mon onglet' })
    expect(e.closeOverlay).toHaveBeenCalledTimes(1)
  })
})
