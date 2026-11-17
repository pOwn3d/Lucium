// The picture of a tab (TabPicture.tsx, Modifier l'onglet in ManagePanels.tsx): drawn in place of the emoji and of the site's icon, picked through the
// main process, and taken away with an emoji or the site's icon. Rendered to markup, the snapshot and the bridge replaced (no window).

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'
import { expandedElements, rendersOf } from './render.test-support'

const PICTURE = '0123456789abcdef01234567.png'
const ctx = { now: 1, newId: ((n = 0) => () => `id${++n}`)() }
const holder = vi.hoisted(() => ({ state: null as unknown, asked: [] as unknown[], dispatched: [] as unknown[] }))
vi.mock('./api', () => ({
  api: () => ({
    spaceImage: async (request: unknown) => {
      holder.asked.push(request)
      return { ok: true }
    },
    dispatch: async (action: unknown) => void holder.dispatched.push(action),
    closeOverlay: () => undefined,
    setTabAddress: () => undefined
  }),
  useSnapshot: () => ({ state: holder.state, runtime: { tabs: {} } })
}))

const { TabMark } = await import('./TabPicture')
const { TabEditor } = await import('./ManagePanels')
const { Sheet } = await import('./templates')

const withPicture = (): SidebarState => {
  const state = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://a.example.org/page' } as Action, ctx)
  return reduce(state, { type: 'tab/image', id: state.tabs[0]!.id, image: PICTURE }, ctx)
}

beforeEach(() => {
  setLanguage('fr')
  holder.asked = []
  holder.dispatched = []
})

describe('the icon of a tab', () => {
  const tab = { url: 'https://a.example.org/', title: 'A' }

  it('is its picture when it has one (the site’s icon while the picture comes), else its emoji, else the site’s icon', () => {
    const pictured = rendersOf(1, () => expandedElements(createElement(TabMark, { tab: { ...tab, image: PICTURE, icon: '🔥' } })))[0]!
    expect(pictured.some((element) => element.props['name'] === PICTURE)).toBe(true)
    expect(renderToStaticMarkup(createElement(TabMark, { tab: { ...tab, image: PICTURE, icon: '🔥' } }))).not.toContain('🔥')
    expect(renderToStaticMarkup(createElement(TabMark, { tab: { ...tab, icon: '🔥' } }))).toBe('<span class="favicon emoji-icon">🔥</span>')
    expect(renderToStaticMarkup(createElement(TabMark, { tab }))).toContain('class="favicon')
  })
})

describe('Modifier l’onglet and the picture of a tab', () => {
  it('offers « Choisir une image… », which asks the main process for a picture for this tab', () => {
    holder.state = withPicture()
    const tabId = (holder.state as SidebarState).tabs[0]!.id
    const markup = renderToStaticMarkup(createElement(TabEditor, { tabId }))
    expect(markup).toContain('aria-label="Image choisie"')
    expect(markup).toContain('Choisir une image…')
    const button = rendersOf(1, () => expandedElements(createElement(TabEditor, { tabId })))[0]!.find((element) => element.type === 'button' && element.props['children'] === 'Choisir une image…')
    ;(button!.props['onClick'] as () => void)()
    expect(holder.asked).toEqual([{ op: 'pick-tab', tabId }])
  })

  it('takes the picture away with « Reprendre l’icône du site », although the tab has no emoji', () => {
    holder.state = withPicture()
    const tabId = (holder.state as SidebarState).tabs[0]!.id
    rendersOf(2, (pass) => {
      const elements = expandedElements(createElement(TabEditor, { tabId }))
      if (pass === 0) {
        const siteIcon = elements.find((element) => element.type === 'button' && element.props['children'] === 'Reprendre l’icône du site')
        expect(siteIcon!.props['disabled']).toBe(false)
        ;(siteIcon!.props['onClick'] as () => void)()
      } else (elements.find((element) => element.type === Sheet)!.props['onSubmit'] as () => void)()
      return null
    })
    expect(holder.dispatched).toEqual([{ type: 'tab/icon', id: tabId, icon: '' }])
  })
})
