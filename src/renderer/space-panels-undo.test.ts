// @vitest-environment happy-dom
// « Gérer les espaces »: the notice that follows « Mettre de côté » offers « Rouvrir » as long as every notice with an action (eight seconds), and waits
// while the pointer or the focus is on it, as the notice of a deletion does.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'
import { ACTION_NOTICE_MS } from '@shared/toast'
import { click, mount, pointerOut, pointerOver, settle, type Mounted } from './dom.test-support'

const holder = vi.hoisted(() => ({ before: null as unknown, after: null as unknown, dispatched: [] as unknown[] }))
vi.mock('./api', () => ({
  api: () => ({ dispatch: (action: unknown) => (holder.dispatched.push(action), Promise.resolve()), getSnapshot: () => Promise.resolve(holder.after), openOverlay: () => undefined, closeOverlay: () => undefined }),
  useSnapshot: () => holder.before
}))

import { SpacesPanel } from './ManagePanels'

let mounted: Mounted | null = null
const advance = (ms: number): void => act(() => void vi.advanceTimersByTime(ms))
const notice = (): HTMLElement | null => mounted!.container.querySelector<HTMLElement>('.lp-undo')

beforeEach(async () => {
  setLanguage('fr')
  holder.dispatched = []
  vi.useFakeTimers()
  const ctx = { now: 1, newId: ((n) => () => `id${++n}`)(0) }
  let state: SidebarState = createInitialState(ctx)
  state = reduce(state, { type: 'space/update', id: state.spaces[0]!.id, patch: { name: 'Travail' } }, ctx)
  state = reduce(state, { type: 'space/create', name: 'Perso', emoji: '🏡', hue: 100 }, ctx)
  const perso = state.spaces[1]!.id
  state = reduce(state, { type: 'space/select', id: state.spaces[0]!.id }, ctx)
  const asideState = reduce(state, { type: 'space/aside', id: perso }, ctx)
  holder.before = { state, runtime: { tabs: {} }, extensions: [], downloads: [], spaceTabs: {}, platform: 'darwin' }
  holder.after = { ...(holder.before as object), state: asideState }
  mounted = mount(createElement(SpacesPanel))
  await click(mounted.container.querySelector(`[aria-label="${t('space-manage.mettre-name-de-cote', { name: 'Perso' })}"]`)!)
  await settle()
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.useRealTimers()
})

describe('the notice of a space put aside', () => {
  it('offers « Rouvrir » for as long as every notice with an action, then goes', () => {
    expect(notice()?.textContent).toContain('Perso')
    advance(ACTION_NOTICE_MS - 1)
    expect(notice()).not.toBeNull()
    advance(1)
    expect(notice()).toBeNull()
  })

  it('waits while the pointer or the focus is on it, and goes on with what it had left', () => {
    advance(5000)
    pointerOver(notice()!)
    advance(ACTION_NOTICE_MS * 3)
    expect(notice()).not.toBeNull()
    act(() => notice()!.querySelector('button')!.focus())
    pointerOut(notice()!)
    advance(ACTION_NOTICE_MS * 3)
    expect(notice()).not.toBeNull()
    act(() => mounted!.container.querySelector<HTMLElement>('.lp-main')!.focus())
    advance(ACTION_NOTICE_MS - 5000 - 1)
    expect(notice()).not.toBeNull()
    advance(1)
    expect(notice()).toBeNull()
  })
})
