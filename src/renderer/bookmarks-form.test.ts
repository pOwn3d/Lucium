// The form of a bookmark ("Signets…", "Modifier"): an address the library cannot keep leaves the form open, sends nothing, and the reason is
// written under the field of the address and tied to it, so that a screen reader says it with the field and the eye finds it where the
// mistake is. Drawn with the real component, no window: each pass is a render, and what a person does between two renders is done on the
// elements of the pass before.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { setLanguage, t } from '@shared/i18n'
import type { Bookmark, SidebarState } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { expandedElements, rendersOf, type Element } from './render.test-support'
import bookmarksCss from './bookmarks.css?raw'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, sent: [] as unknown[] }))
vi.mock('./api', () => ({
  api: () => ({ dispatch: (action: unknown) => (holder.sent.push(action), Promise.resolve()), closeOverlay: () => undefined }),
  useSnapshot: () => holder.snapshot
}))

import { Bookmarks } from './Bookmarks'

const bm = (n: number): Bookmark => ({ id: `b${n}`, url: `https://site${n}.example/page`, title: `Page ${n}`, tags: [], addedAt: n })

beforeEach(() => {
  setLanguage('fr')
  holder.sent = []
  const state: SidebarState = { ...createInitialState({ now: 1, newId: ((n = 0) => () => `id${++n}`)() }), bookmarks: [bm(1), bm(2)] }
  holder.snapshot = { state }
})
afterEach(() => setLanguage('fr'))

const by = (elements: Element[], name: string, value: string): Element => {
  const found = elements.find((element) => element.props[name] === value)
  if (!found) throw new Error(`no element with ${name}="${value}"`)
  return found
}
const press = (element: Element): void => (element.props['onClick'] as () => void)()
const type = (element: Element, value: string): void => (element.props['onChange'] as (event: { target: { value: string } }) => void)({ target: { value } })
const alerts = (elements: Element[]): Element[] => elements.filter((element) => element.props['role'] === 'alert')
const statuses = (elements: Element[]): Element[] => elements.filter((element) => element.props['role'] === 'status')

/** Opens the form of the first bookmark, types a new name and `address`, presses "Enregistrer", and gives what is on screen after it. */
function saveWith(address: string): Element[] {
  const passes = rendersOf(5, (pass) => {
    const elements = expandedElements(createElement(Bookmarks))
    if (pass === 0) press(by(elements, 'aria-label', t('bookmarks.modifier-name', { name: 'Page 1' })))
    if (pass === 1) type(by(elements, 'data-field', 'title'), 'Nouveau nom')
    if (pass === 2) type(by(elements, 'data-field', 'url'), address)
    if (pass === 3) press(by(elements, 'data-action', 'save'))
    return elements
  })
  return passes[4]!
}

describe('"Enregistrer" in the form of a bookmark', () => {
  it('sends the edit and closes the form when the address can be kept', () => {
    const after = saveWith('  https://nouveau.example/a  ')
    expect(holder.sent).toEqual([{ type: 'bookmark/edit', id: 'b1', patch: { title: 'Nouveau nom', url: 'https://nouveau.example/a', tags: [], note: '' } }])
    expect(after.some((element) => element.props['data-action'] === 'save')).toBe(false)
    expect(alerts(after)).toEqual([])
  })

  it('writes why an address is refused under its field and ties the two, keeps what was typed, and sends nothing', () => {
    for (const address of ['pas une adresse', 'javascript:alert(1)', 'file:///etc/passwd', '']) {
      holder.sent = []
      const after = saveWith(address)
      expect(holder.sent, address).toEqual([])
      const [reason, ...others] = alerts(after)
      expect(others, address).toEqual([])
      expect(reason!.props['children'], address).toBe(t('bookmarks.cette-adresse-n-est-pas-celle-d-une-page-web'))
      const field = by(after, 'data-field', 'url')
      expect(field.props, address).toMatchObject({ value: address, 'aria-invalid': true })
      // The field names the sentence, by an id that is there and is not empty.
      expect(typeof reason!.props['id'] === 'string' && reason!.props['id'] !== '', address).toBe(true)
      expect(field.props['aria-describedby'], address).toBe(reason!.props['id'])
      expect(by(after, 'data-field', 'title').props['value'], address).toBe('Nouveau nom')
      // The sentence is in the form, right after the label of the address, and no longer in the message of the panel.
      const form = by(after, 'className', 'bookmark-form')
      const children = (form.props['children'] as unknown[]).filter(Boolean) as Element[]
      const at = children.indexOf(reason!)
      expect(at, address).toBeGreaterThan(0)
      expect(expandedElements(children[at - 1]!).includes(field), address).toBe(true)
      expect(statuses(after), address).toEqual([])
    }
  })

  it('says that another bookmark has the address already, however it is written', () => {
    for (const address of ['https://site2.example/page', 'HTTPS://SITE2.example/page']) {
      holder.sent = []
      const after = saveWith(address)
      expect(alerts(after).map((element) => element.props['children']), address).toEqual([t('bookmarks.un-autre-signet-a-deja-cette-adresse')])
      expect(by(after, 'data-field', 'url').props['aria-describedby'], address).toBe(alerts(after)[0]!.props['id'])
      expect(holder.sent, address).toEqual([])
    }
  })

  it('has a field that is neither invalid nor described before anything is refused', () => {
    const passes = rendersOf(2, (pass) => {
      const elements = expandedElements(createElement(Bookmarks))
      if (pass === 0) press(by(elements, 'aria-label', t('bookmarks.modifier-name', { name: 'Page 1' })))
      return elements
    })
    const field = by(passes[1]!, 'data-field', 'url')
    expect(field.props['aria-invalid']).toBeUndefined()
    expect(field.props['aria-describedby']).toBeUndefined()
  })

  it('takes the reason away as soon as the address is typed again', () => {
    const passes = rendersOf(6, (pass) => {
      const elements = expandedElements(createElement(Bookmarks))
      if (pass === 0) press(by(elements, 'aria-label', t('bookmarks.modifier-name', { name: 'Page 1' })))
      if (pass === 1) type(by(elements, 'data-field', 'url'), 'pas une adresse')
      if (pass === 2) press(by(elements, 'data-action', 'save'))
      if (pass === 4) type(by(elements, 'data-field', 'url'), 'https://nouveau.example/')
      return alerts(elements).length
    })
    expect(passes).toEqual([0, 0, 0, 1, 1, 0])
  })

  it('draws the reason in the ink of an error, which is a role of the tokens', () => {
    expect(bookmarksCss).toMatch(/\.bookmark-problem\s*\{[^}]*color:\s*var\(--danger-ink\)/)
  })
})
