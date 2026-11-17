// @vitest-environment happy-dom
// Requests the main process fails, as the panels live them: the button must not do nothing and say nothing. Each failure has a sentence on
// screen (or, for the first state of a view, a line in the console, the view then waiting for the next state), and its cause is written.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { useSnapshot } from './api'
import { SpacesPanel } from './ManagePanels'
import { ThemeEditor } from './ThemeEditor'
import { button, click, installBridge, mount, settle, type Mounted } from './dom.test-support'

const FAILURE = new Error('the main process failed')

let n = 0
const ctx = { now: 1, newId: () => `id${++n}` }
/** Two spaces, so that one can be put aside and a theme applied to all. */
function twoSpaces(): SidebarState {
  const first = createInitialState(ctx)
  return reduce(first, { type: 'space/create', name: 'Perso', emoji: '🏡', hue: 100 } as Action, ctx)
}

let mounted: Mounted | null = null
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('the first state of a view', () => {
  it('that cannot be read is written in the console, and the view draws the next state the main process publishes', async () => {
    let publish: (snapshot: UiSnapshot) => void = () => undefined
    installBridge({ getSnapshot: () => Promise.reject(FAILURE), onSnapshot: (listener: (snapshot: UiSnapshot) => void) => ((publish = listener), () => undefined) })
    const Probe = () => createElement('p', null, useSnapshot() ? 'drawn' : 'waiting')
    mounted = mount(createElement(Probe))
    await settle()
    expect(warn).toHaveBeenCalledWith('[ui] the first state could not be read:', FAILURE)
    expect(mounted.container.textContent).toBe('waiting')
    await settle(() => publish({ state: createInitialState(ctx) } as unknown as UiSnapshot))
    expect(mounted.container.textContent).toBe('drawn')
  })
})

describe('« Archiver » in the panel of the spaces', () => {
  it('says that the space could not be put aside when the main process fails', async () => {
    const state = twoSpaces()
    const space = state.spaces[1]!
    installBridge({ getSnapshot: async () => ({ state }) as unknown as UiSnapshot, dispatch: () => Promise.reject(FAILURE) })
    mounted = mount(createElement(SpacesPanel))
    await settle()
    await click(mounted.container.querySelector(`[aria-label="${t('space-manage.mettre-name-de-cote', { name: space.name })}"]`)!)
    await settle()
    expect(mounted.container.querySelector('.tk-status.error[role="alert"]')?.textContent).toBe(t('space-manage.l-espace-n-a-pas-pu-etre-mis-de-cote', { name: space.name }))
    expect(warn).toHaveBeenCalledWith('[spaces] the space could not be archived:', FAILURE)
  })
})

describe('the theme editor', () => {
  async function editor(own: object): Promise<HTMLElement> {
    const state = twoSpaces()
    installBridge({ getSnapshot: async () => ({ state }) as unknown as UiSnapshot, dispatch: async () => undefined, ...own })
    mounted = mount(createElement(ThemeEditor, { spaceId: state.spaces[0]!.id }))
    await settle()
    return mounted.container
  }
  const said = (container: Element): string[] => [...container.querySelectorAll('.tp-note[role="status"]')].map((one) => one.textContent ?? '')

  it('says that the action did not go through when a copy, a paste or « Appliquer à tous les espaces » fails', async () => {
    const container = await editor({ themeCode: () => Promise.reject(FAILURE) })
    const actions: Array<[string, () => Element]> = [
      ['copying the colour', () => [...container.querySelectorAll('button')].filter((one) => one.textContent === t('menu.copier'))[0]!],
      ['copying the code of the theme', () => [...container.querySelectorAll('button')].filter((one) => one.textContent === t('menu.copier'))[1]!],
      ['pasting a code', () => button(container, t('menu.coller'))],
      ['applying the theme to every space', () => button(container, t('theme-panel.appliquer-a-tous-les-espaces'))]
    ]
    for (const [what, find] of actions) {
      warn.mockClear()
      await click(find())
      await settle()
      expect(said(container), what).toEqual([t('theme-editor.l-action-n-a-pas-abouti')])
      expect(warn, what).toHaveBeenCalledWith(`[theme] ${what} failed:`, FAILURE)
    }
  })

  it('says the same when the colour of the site cannot be read', async () => {
    const container = await editor({ siteColor: () => Promise.reject(FAILURE) })
    await click(button(container, t('theme-panel.couleur-du-site')))
    await settle()
    expect(said(container)).toEqual([t('theme-editor.l-action-n-a-pas-abouti')])
    expect(warn).toHaveBeenCalledWith('[theme] reading the colour of the site failed:', FAILURE)
  })

  it('announces that the page declares no colour: the sentence is a status, as the line under it is', async () => {
    const container = await editor({ siteColor: async () => null })
    await click(button(container, t('theme-panel.couleur-du-site')))
    await settle()
    expect(said(container)).toEqual([t('theme-editor.cette-page-ne-declare-pas-de-couleur')])
  })
})
