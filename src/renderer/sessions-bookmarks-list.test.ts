// @vitest-environment happy-dom
// The Sessions and the Signets panels, mounted in a document, as panels of a list: a row deleted leaves the list at once and can be taken back
// ("Annuler", ⌘Z) until the panel is left, the arrows go from row to row, and the frame names itself as the other list panels do. What still
// waits to be deleted is made before anything that reads the list as it is shown (a session saved in the room left, a file exported).

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import type { Bookmark } from '@shared/model'
import { SESSIONS_MAX } from '@shared/sessions'
import { createInitialState } from '@shared/sidebar'
import { Bookmarks } from './Bookmarks'
import { Sessions } from './Sessions'
import { button, click, mount, settle, type, type Mounted } from './dom.test-support'

let mounted: Mounted | null = null
let dispatch: ReturnType<typeof vi.fn>
let calls: string[]

const base = createInitialState({ now: 1, newId: ((n = 0) => () => `id${++n}`)() })
const SESSIONS = [
  { id: 'veille', name: 'Veille', createdAt: 1, tabs: [{ url: 'https://example.org/', title: 'Exemple' }] },
  { id: 'banque', name: 'Banque', createdAt: 1, tabs: [], space: { tabs: [] } },
  { id: 'projet', name: 'Projet', createdAt: 1, tabs: [{ url: 'https://example.org/p', title: 'Projet' }] }
]
const bookmark = (n: number, more: Partial<Bookmark> = {}): Bookmark => ({ id: `b${n}`, url: `https://site${n}.example/page`, title: `Page ${n}`, tags: [], addedAt: n, ...more })

async function open(component: typeof Sessions | typeof Bookmarks, state: object): Promise<HTMLElement> {
  const bridge: Partial<LuciumApi> = {
    getSnapshot: async () => ({ state: { ...base, ...state }, extensions: [], downloads: [] }) as unknown as UiSnapshot,
    onSnapshot: () => () => undefined,
    dispatch: dispatch as never,
    closeOverlay: vi.fn() as never,
    sessionBackups: async () => ({ enabled: true, entries: [], unreadable: 0 }),
    bookmarksTransfer: (async (request: { op: string }) => {
      calls.push(`transfer:${request.op}`)
      return { ok: true, message: '' }
    }) as never
  }
  ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = bridge
  mounted = mount(createElement(component as () => null))
  await settle()
  return mounted.container
}
const leave = (): void => {
  mounted?.unmount()
  mounted = null
}
const rowIds = (container: Element, selector: string): Array<string | null> => [...container.querySelectorAll(selector)].map((row) => row.getAttribute('data-id'))
const rowButton = (container: Element, id: string, name: string): HTMLButtonElement => container.querySelector<HTMLButtonElement>(`[data-id="${id}"] button[data-action="${name}"]`)!
const notice = (container: Element): Element | null => container.querySelector('.lp-undo')
/** A key pressed where the focus is, as the keyboard sends it. Answers whether something took it (the default prevented). */
function press(key: string, more: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...more })
  act(() => {
    document.activeElement!.dispatchEvent(event)
  })
  return event.defaultPrevented
}
const focused = (): Element | null => document.activeElement
const deleted = (type: string): unknown[] => dispatch.mock.calls.map(([action]) => action as { type: string }).filter((action) => action.type === type)

beforeEach(() => {
  setLanguage('fr')
  calls = []
  dispatch = vi.fn(async (action: { type: string }) => {
    calls.push(action.type)
  })
})
afterEach(() => {
  leave()
  vi.restoreAllMocks()
})

describe('the Sessions panel, a panel of a list', () => {
  const sessions = (container: Element) => rowIds(container, '.sessions-row')

  it('is a dialog named by its title, each row a button named by what it does', async () => {
    const container = await open(Sessions, { sessions: SESSIONS })
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe(`${t('sessions.sessions')}3`)
    expect([...container.querySelectorAll('.sessions-row .lp-main')].map((main) => [main.tagName, main.getAttribute('aria-label')])).toEqual([
      ['BUTTON', t('sessions.restaurer-name', { name: 'Veille' })],
      ['BUTTON', t('cmd.reopen-space', { name: 'Banque' })],
      ['BUTTON', t('sessions.restaurer-name', { name: 'Projet' })]
    ])
  })

  it('takes a deleted session out of the list at once, deletes nothing yet, and offers to take it back', async () => {
    const container = await open(Sessions, { sessions: SESSIONS })
    expect(notice(container)).toBeNull()
    await click(rowButton(container, 'veille', 'delete'))
    expect(sessions(container)).toEqual(['banque', 'projet'])
    expect(container.querySelector('.lp-count')!.textContent).toBe('2')
    expect(dispatch).not.toHaveBeenCalled()
    expect(notice(container)!.getAttribute('role')).toBe('status')
    expect(notice(container)!.querySelector('span')!.textContent).toBe(t('sessions.session-supprimee', { name: 'Veille' }))
    expect(notice(container)!.querySelector('button')!.textContent).toContain(t('templates.annuler'))
  })

  it('brings the session back on ⌘Z, and then deletes nothing when the panel is left', async () => {
    const container = await open(Sessions, { sessions: SESSIONS })
    await click(rowButton(container, 'veille', 'delete'))
    // From a row, not from the name field: there ⌘Z takes back what was typed.
    container.querySelector<HTMLElement>('.sessions-row .lp-main')!.focus()
    expect(press('z', { metaKey: true })).toBe(true)
    expect(sessions(container)).toEqual(['veille', 'banque', 'projet'])
    expect(notice(container)).toBeNull()
    leave()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('brings it back on « Annuler » too', async () => {
    const container = await open(Sessions, { sessions: SESSIONS })
    await click(rowButton(container, 'projet', 'delete'))
    await click(notice(container)!.querySelector('button')!)
    expect(sessions(container)).toEqual(['veille', 'banque', 'projet'])
    leave()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('deletes the session when the panel is left, and says of a space set aside that it is one', async () => {
    const container = await open(Sessions, { sessions: SESSIONS })
    await click(rowButton(container, 'banque', 'delete'))
    expect(notice(container)!.querySelector('span')!.textContent).toBe(t('space-manage.espace-mis-de-cote-supprime', { name: 'Banque' }))
    expect(dispatch).not.toHaveBeenCalled()
    leave()
    expect(deleted('session/delete')).toEqual([{ type: 'session/delete', id: 'banque' }])
  })

  it('goes from the name field down the sessions with the arrows, and back, stopping at the ends', async () => {
    const container = await open(Sessions, { sessions: SESSIONS })
    const mains = [...container.querySelectorAll('.sessions-row .lp-main')]
    expect(focused()).toBe(container.querySelector('#sessions-name'))
    press('ArrowDown')
    expect(focused()).toBe(mains[0])
    press('ArrowDown')
    press('ArrowDown')
    expect(focused()).toBe(mains[2])
    press('ArrowDown')
    expect(focused()).toBe(mains[2])
    press('ArrowUp')
    expect(focused()).toBe(mains[1])
    press('Home')
    expect(focused()).toBe(mains[0])
  })

  it('leaves ↓ to the field of a name being changed: the rename is not ended by it', async () => {
    const container = await open(Sessions, { sessions: SESSIONS })
    await click(rowButton(container, 'veille', 'rename'))
    const field = container.querySelector<HTMLInputElement>('.sessions-rename')!
    expect(focused()).toBe(field)
    press('ArrowDown')
    expect(focused()).toBe(field)
    expect(container.querySelector('.sessions-rename')).not.toBeNull()
  })

  it('makes a waiting deletion before it saves a session: at the limit, the room left is the room taken', async () => {
    const full = Array.from({ length: SESSIONS_MAX }, (_, index) => ({ id: `s${index}`, name: `Session ${index}`, createdAt: 1, tabs: [{ url: 'https://example.org/', title: 'Exemple' }] }))
    const tab = { id: 't1', spaceId: base.activeSpaceId, url: 'https://example.org/a', title: 'A', pinned: false }
    const container = await open(Sessions, { sessions: full, tabs: [tab] })
    const save = container.querySelector<HTMLButtonElement>('button[data-action="save"]')!
    expect(save.disabled).toBe(true)
    await click(rowButton(container, 's0', 'delete'))
    expect(save.disabled).toBe(false)
    await click(save)
    expect(calls).toEqual(['session/delete', 'session/save'])
    expect(notice(container)).toBeNull()
  })
})

describe('the Signets panel, a panel of a list', () => {
  const LIBRARY = [bookmark(1, { tags: ['outils'] }), bookmark(2), bookmark(3, { note: 'à relire' })]
  const bookmarks = (container: Element) => rowIds(container, '.bookmark-row')

  it('is a dialog named by its title, each row a button named by the page it opens, the tags a group of filters', async () => {
    const container = await open(Bookmarks, { bookmarks: LIBRARY })
    const dialog = container.querySelector('[role="dialog"]')!
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe(`${t('settings.signets')}3`)
    expect(container.querySelector('input[type="search"]')!.getAttribute('aria-label')).toBe(t('bookmarks.rechercher-dans-les-signets'))
    expect([...container.querySelectorAll('.bookmark-row .lp-main')].map((main) => [main.tagName, main.getAttribute('aria-label')])).toEqual([1, 2, 3].map((n) => ['BUTTON', t('bookmarks.ouvrir-name', { name: `Page ${n}` })]))
    const filters = container.querySelector('[role="group"]')!
    expect(filters.getAttribute('aria-label')).toBe(t('bookmarks.etiquettes'))
    expect(filters.querySelector('button')!.getAttribute('aria-pressed')).toBe('false')
  })

  it('opens the bookmark of a row from its main button', async () => {
    const container = await open(Bookmarks, { bookmarks: LIBRARY })
    await click(rowButton(container, 'b2', 'open'))
    expect(dispatch).toHaveBeenCalledWith({ type: 'bookmark/open', id: 'b2' })
  })

  it('takes a deleted bookmark out of the list, of the count and of the tags at once, deletes nothing yet, and offers to take it back', async () => {
    const container = await open(Bookmarks, { bookmarks: LIBRARY })
    await click(rowButton(container, 'b1', 'remove'))
    expect(bookmarks(container)).toEqual(['b2', 'b3'])
    expect(container.querySelector('.lp-count')!.textContent).toBe('2')
    expect(container.querySelector('button[data-action="chip"]')).toBeNull()
    expect(dispatch).not.toHaveBeenCalled()
    expect(notice(container)!.getAttribute('role')).toBe('status')
    expect(notice(container)!.querySelector('span')!.textContent).toBe(t('bookmarks.signet-supprime', { name: 'Page 1' }))
    expect(notice(container)!.querySelector('button')!.textContent).toContain(t('templates.annuler'))
  })

  it('brings the bookmark back on ⌘Z, and then deletes nothing when the panel is left', async () => {
    const container = await open(Bookmarks, { bookmarks: LIBRARY })
    await click(rowButton(container, 'b1', 'remove'))
    container.querySelector<HTMLElement>('.bookmark-row .lp-main')!.focus()
    expect(press('z', { metaKey: true })).toBe(true)
    expect(bookmarks(container)).toEqual(['b1', 'b2', 'b3'])
    expect(notice(container)).toBeNull()
    leave()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('deletes the bookmark when the panel is left', async () => {
    const container = await open(Bookmarks, { bookmarks: LIBRARY })
    await click(rowButton(container, 'b3', 'remove'))
    expect(dispatch).not.toHaveBeenCalled()
    leave()
    expect(deleted('bookmark/remove')).toEqual([{ type: 'bookmark/remove', id: 'b3' }])
  })

  it('goes from the search down the bookmarks with the arrows, and back', async () => {
    const container = await open(Bookmarks, { bookmarks: LIBRARY })
    const mains = [...container.querySelectorAll('.bookmark-row .lp-main')]
    expect(focused()).toBe(container.querySelector('input[type="search"]'))
    press('ArrowDown')
    expect(focused()).toBe(mains[0])
    press('End')
    expect(focused()).toBe(mains[2])
    press('ArrowUp')
    expect(focused()).toBe(mains[1])
  })

  it('leaves ↓ to the fields of the form of a bookmark: the lines of its note', async () => {
    const container = await open(Bookmarks, { bookmarks: LIBRARY })
    await click(rowButton(container, 'b1', 'edit'))
    const note = container.querySelector<HTMLTextAreaElement>('[data-field="note"]')!
    note.focus()
    expect(press('ArrowDown')).toBe(false)
    expect(focused()).toBe(note)
  })

  it('makes a waiting deletion before the file is written, so that the file does not hold the bookmark', async () => {
    const container = await open(Bookmarks, { bookmarks: LIBRARY })
    await click(rowButton(container, 'b2', 'remove'))
    await click(button(container, t('bookmarks.exporter')))
    expect(calls).toEqual(['bookmark/remove', 'transfer:export'])
  })

  it('gives the address of a bookmark being deleted to another one: the deletion is made first', async () => {
    const container = await open(Bookmarks, { bookmarks: LIBRARY })
    await click(rowButton(container, 'b2', 'remove'))
    await click(rowButton(container, 'b1', 'edit'))
    type(container.querySelector<HTMLInputElement>('[data-field="url"]')!, 'https://site2.example/page')
    await click(container.querySelector('button[data-action="save"]')!)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(calls).toEqual(['bookmark/remove', 'bookmark/edit'])
  })
})
