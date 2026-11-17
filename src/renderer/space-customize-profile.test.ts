// @vitest-environment happy-dom
// « Personnaliser l'espace », its section of the profile, mounted in a document. Another profile for a space reloads every tab of the space with
// another set of cookies: what was being typed in those pages is lost, and the sites are signed out. A choice in the menu used to do it at once.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t, tp } from '@shared/i18n'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import { createInitialState, type Action } from '@shared/sidebar'
import { SpaceCustomize } from './SpaceCustomize'
import { button, click, mount, settle, type, type Mounted } from './dom.test-support'

let mounted: Mounted | null = null
let dispatch: ReturnType<typeof vi.fn<(action: Action) => Promise<void>>>
let spaceId = ''

/** The panel of the first space, which has `tabs` tabs; the profile « Travail » exists beside the default one. */
async function panel(tabs: number): Promise<HTMLElement> {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  spaceId = state.spaces[0]!.id
  const snapshot = {
    state: {
      ...state,
      settings: { ...state.settings, profileNames: { work: 'Travail' } },
      tabs: Array.from({ length: tabs }, (_, index) => ({ id: `t${index}`, spaceId, url: `https://exemple.org/${index}`, title: `Page ${index}`, pinned: false, createdAt: 1, lastActiveAt: 1 }))
    },
    extensions: [],
    runtime: { tabs: {} },
    platform: 'darwin'
  } as unknown as UiSnapshot
  const own: Partial<LuciumApi> = { getSnapshot: async () => snapshot, dispatch }
  ;(window as unknown as { lucium: unknown }).lucium = new Proxy(own, { get: (target, name: string) => (target as Record<string, unknown>)[name] ?? (name.startsWith('on') ? () => () => undefined : () => Promise.resolve(undefined)) })
  mounted = mount(createElement(SpaceCustomize, { spaceId, focus: 'name' }))
  await settle()
  dispatch.mockClear()
  return mounted.container
}

const menu = (container: Element): HTMLSelectElement => container.querySelector<HTMLSelectElement>(`select[aria-label="${t('space-create.profil')}"]`)!
const choose = (select: HTMLSelectElement, value: string): void =>
  act(() => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
const profileChanges = (): Action[] => dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === 'space/update' && 'profileId' in action.patch)

beforeEach(() => {
  setLanguage('fr')
  dispatch = vi.fn(async () => undefined)
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('another profile chosen for a space that has tabs', () => {
  it('changes nothing at once: the panel asks, saying how many tabs are loaded again', async () => {
    const container = await panel(3)
    choose(menu(container), 'work')
    expect(profileChanges()).toEqual([])
    const question = container.querySelector('.sc-confirm')!
    expect(question.querySelector('b')?.textContent).toBe(t('space-customize.changer-le-profil-de-name', { name: container.querySelector<HTMLInputElement>('input')?.value ?? '' }))
    expect(question.textContent).toContain(tp('space-customize.profil-recharge', 3))
  })

  it('is given up with « Annuler »: the menu goes back to the profile of the space, and nothing is sent', async () => {
    const container = await panel(3)
    choose(menu(container), 'work')
    await click(button(container.querySelector('.sc-confirm')!, t('templates.annuler')))
    expect(container.querySelector('.sc-confirm')).toBeNull()
    expect(menu(container).value).toBe('default')
    expect(profileChanges()).toEqual([])
  })

  it('is done with « Changer de profil »', async () => {
    const container = await panel(3)
    choose(menu(container), 'work')
    await click(button(container, t('space-customize.changer-de-profil')))
    expect(profileChanges()).toEqual([{ type: 'space/update', id: spaceId, patch: { profileId: 'work' } }])
    expect(container.querySelector('.sc-confirm')).toBeNull()
  })

  it('asks nothing when the profile of the space is chosen again', async () => {
    const container = await panel(3)
    choose(menu(container), 'work')
    choose(menu(container), 'default')
    expect(container.querySelector('.sc-confirm')).toBeNull()
    expect(profileChanges()).toEqual([])
  })
})

describe('another profile chosen for a space with no tab', () => {
  it('is applied at once: nothing is loaded again, there is nothing to ask', async () => {
    const container = await panel(0)
    choose(menu(container), 'work')
    expect(profileChanges()).toEqual([{ type: 'space/update', id: spaceId, patch: { profileId: 'work' } }])
    expect(container.querySelector('.sc-confirm')).toBeNull()
  })
})

describe('a new profile for the space', () => {
  it('says that it could not be created when its request fails, keeps the name typed and writes the error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const container = await panel(0)
    choose(menu(container), '__new__')
    const name = container.querySelector<HTMLInputElement>('.new-profile')!
    type(name, 'Projet')
    dispatch.mockRejectedValueOnce(new Error('the store is closed'))
    await click(button(container, t('space-customize.creer-le-profil')))
    expect(container.querySelector('.sh-error[role="alert"]')?.textContent).toBe(t('settings-profiles.profil-non-cree'))
    expect(container.querySelector<HTMLInputElement>('.new-profile')?.value).toBe('Projet')
    expect(warn).toHaveBeenCalledWith('[space] the profile could not be created:', expect.any(Error))
  })
})
