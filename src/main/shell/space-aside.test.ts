import { beforeEach, describe, expect, it, vi } from 'vitest'

const showMessageBoxSync = vi.fn()
vi.mock('electron', () => ({ dialog: { showMessageBoxSync: (...args: unknown[]) => showMessageBoxSync(...args) } }))

import { setLanguage } from '@shared/i18n'
import { createInitialState, reduce, type Ctx } from '@shared/sidebar'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { asideQuestion, asideSpace, withEveryWindowsTabs } from './space-aside'
import { frenchSpaces } from '@shared/french-typography'

const ctx: Ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
// Two spaces (the only one cannot be put aside), the second with two tabs.
let state = createInitialState(ctx)
state = reduce(state, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200 }, ctx)
const work = state.activeSpaceId
for (const url of ['https://a.example/', 'https://b.example/']) state = reduce(state, { type: 'tab/open', url, spaceId: work }, ctx)

const setup = () => {
  const dispatch = vi.fn()
  const toast = vi.fn()
  const browser = { dispatch, showToast: toast } as unknown as Browser
  const store = { get: () => state } as unknown as StateStore
  return { dispatch, toast, browser, store }
}

beforeEach(() => {
  showMessageBoxSync.mockReset()
  setLanguage('fr')
})

describe('the question before a space is put aside', () => {
  it('makes "Annuler" the default button: the pages close, and what was typed in them and not sent is lost', () => {
    const question = asideQuestion('Travail', 2)
    expect(question.buttons).toEqual(['Mettre de côté', 'Annuler'])
    expect(question.defaultId).toBe(1)
    expect(question.cancelId).toBe(1)
    expect(question.detail).toContain('ce que vous avez saisi sans l’envoyer est perdu')
  })

  it('shows the native box with that default, and does nothing when it is answered by the default button', () => {
    const { dispatch, browser, store } = setup()
    showMessageBoxSync.mockImplementation((_win: unknown, options: { defaultId: number }) => options.defaultId)
    asideSpace(browser, store, {} as never, work)
    expect(showMessageBoxSync).toHaveBeenCalledTimes(1)
    const options = showMessageBoxSync.mock.calls[0]![1] as { defaultId: number; cancelId: number; buttons: string[] }
    expect(options.buttons[options.defaultId]).toBe('Annuler')
    expect(options.cancelId).toBe(options.defaultId)
    // A Return typed at once presses the default button: the space is still there.
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('also asks, with the same default, when there is no window to hang the box on', () => {
    const { dispatch, browser, store } = setup()
    showMessageBoxSync.mockImplementation((options: { defaultId: number }) => options.defaultId)
    asideSpace(browser, store, undefined, work)
    expect(showMessageBoxSync).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('puts the space aside when "Mettre de côté" itself is chosen', () => {
    const { dispatch, browser, store } = setup()
    showMessageBoxSync.mockReturnValue(0)
    asideSpace(browser, store, {} as never, work)
    expect(dispatch).toHaveBeenCalledWith({ type: 'space/aside', id: work })
  })

  it('reads "Cancel" in English, not the "Undo" of the Edit menu', () => {
    setLanguage('en')
    expect(asideQuestion('Work', 2).buttons).toEqual(['Set Aside', 'Cancel'])
  })

  it('says what happens to the tabs with a sentence that agrees with their number, in either language', () => {
    const first = (count: number) => asideQuestion('Travail', count).detail.split(frenchSpaces(' ; '))[0]
    expect([0, 1, 3].map(first)).toEqual([
      frenchSpaces('Il n’a aucun onglet : il est gardé dans une session du même nom'),
      'Son onglet est fermé et gardé dans une session du même nom',
      'Ses 3 onglets sont fermés et gardés dans une session du même nom'
    ])
    try {
      setLanguage('en')
      const english = (count: number) => asideQuestion('Work', count).detail.split('; ')[0]
      expect([0, 1, 3].map(english)).toEqual(['It has no tabs', 'Its tab is closed and kept in a session of the same name', 'Its 3 tabs are closed and kept in a session of the same name'])
      expect(asideQuestion('Work', 3).detail).toMatch(/\(Spaces › Reopen a Space Set Aside, “Manage Spaces” or File › Sessions…\)\. The pages reload when it reopens: /)
    } finally {
      setLanguage('fr')
    }
  })
})

describe('with windows that have tabs of their own', () => {
  // The window lists one of the two tabs of the space; the other one belongs to another window.
  const independent = { ...state, settings: { ...state.settings, independentWindows: true } }
  const shared = { ...independent, tabs: independent.tabs.map((tab, i) => (i === 1 ? { ...tab, windowKey: 'window-1' } : tab)) }
  const view = { ...shared, tabs: shared.tabs.filter((tab) => tab.windowKey === undefined) }
  const store = { get: () => view, root: () => ({ get: () => shared }) } as unknown as StateStore

  it('counts in the question the tabs the other windows have in the space: they are closed too', () => {
    expect(view.tabs.filter((tab) => tab.spaceId === work)).toHaveLength(1)
    const asked: Array<ReturnType<typeof asideQuestion>> = []
    const { browser } = setup()
    asideSpace(browser, store, undefined, work, (question) => (asked.push(question), false))
    expect(asked[0]!.detail).toBe(asideQuestion('Travail', 2).detail)
  })

  it('reads the shared state only while the setting is on', () => {
    expect(withEveryWindowsTabs(store).tabs).toBe(shared.tabs)
    const off = { ...view, settings: { ...view.settings, independentWindows: false } }
    const never = { get: () => off, root: () => { throw new Error('the shared state is not read while every window lists every tab') } } as unknown as StateStore
    expect(withEveryWindowsTabs(never)).toBe(off)
  })
})
