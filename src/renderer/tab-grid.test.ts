// @vitest-environment happy-dom
// The tab overview (TabGrid.tsx), drawn and used in a document: one card per tab with the picture the main process gave (an icon or a letter without one), the
// search and the Space chips narrow the cards, a card goes to its tab, the close button and ⌫ close a tab and keep the panel, the arrows move the focus, the tab menu
// (a right click) is the one that moves a tab, Escape empties the search then closes.

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frenchSpaces } from '@shared/french-typography'
import { setLanguage } from '@shared/i18n'
import { defaultSettings, type SidebarState, type TabItem } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import css from './tab-grid.css?raw'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, asked: [] as Array<[string, unknown[]]> }))
vi.mock('./api', () => {
  const act = new Proxy({}, { get: (_target, name: string) => (...args: unknown[]) => void holder.asked.push([name, args]) })
  return { api: () => act, useSnapshot: () => holder.snapshot }
})

import { TabGrid } from './TabGrid'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

const tab = (id: string, spaceId: string, title: string, extra: Partial<TabItem> = {}): TabItem => ({ id, spaceId, title, url: `https://${id}.example.org/page`, lastActiveAt: 1, createdAt: 1, pinned: false, ...extra }) as TabItem

function show(pictures: Record<string, string> = {}): void {
  const base = createInitialState({ now: 0, newId: () => 'x' })
  const home = base.spaces[0]!
  const state: SidebarState = {
    ...base,
    spaces: [home, { ...home, id: 'work', name: 'Travail', emoji: '💼' }],
    tabs: [tab('docs', home.id, 'Documentation'), tab('mail', home.id, 'Courrier'), tab('plan', 'work', 'Planning')],
    activeTabBySpace: { ...base.activeTabBySpace, [home.id]: 'docs' },
    settings: { ...defaultSettings(), tabGrid: true }
  }
  holder.snapshot = { state, runtime: { tabs: {}, canGoBack: false, canGoForward: false }, platform: 'darwin' }
  act(() => root.render(createElement(TabGrid, { pictures })))
}

beforeEach(() => {
  setLanguage('fr')
  holder.asked = []
  holder.snapshot = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const cards = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('li.tg-card')]
const names = (): string[] => cards().map((card) => card.querySelector('.tg-name')!.textContent!)
const calls = (name: string): unknown[][] => holder.asked.filter(([called]) => called === name).map(([, args]) => args)
const click = (el: Element | null | undefined): void => void act(() => (el as HTMLElement).click())
const type = (value: string): void => {
  const field = host.querySelector<HTMLInputElement>('input[type="search"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const key = (target: Element, name: string): void => void act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })))
const chip = (label: string): HTMLButtonElement => [...host.querySelectorAll<HTMLButtonElement>('.tk-chip')].find((b) => b.textContent!.includes(label))!

describe('the panel', () => {
  it('draws nothing until the first snapshot has arrived', () => {
    act(() => root.render(createElement(TabGrid, { pictures: {} })))
    expect(host.innerHTML).toBe('')
  })

  it('is a dialog named by its title, with a labelled search and a status that says how many tabs', () => {
    show()
    const dialog = host.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(host.querySelector(`#${dialog.getAttribute('aria-labelledby')}`)?.textContent).toBe('Vue d’ensemble des onglets')
    expect(host.querySelector('input[type="search"]')?.getAttribute('aria-label')).toBe('Chercher un onglet')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('2 onglets')
  })

  it('shows the tabs of the Space on screen first, and all of them with the chip « Tous les espaces »', () => {
    show()
    expect(names()).toEqual(['Documentation', 'Courrier'])
    click(chip('Tous les espaces'))
    expect(names()).toEqual(['Documentation', 'Courrier', 'Planning'])
    click(chip('Travail'))
    expect(names()).toEqual(['Planning'])
    expect(chip('Travail').getAttribute('aria-pressed')).toBe('true')
  })

  it('draws the picture it was given, and an icon or the first letter of the site for a tab with none', () => {
    show({ docs: 'data:image/jpeg;base64,AAAA' })
    const [docs, mail] = cards()
    expect(docs!.querySelector('.tg-pic img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA')
    expect(mail!.querySelector('.tg-pic img')).toBeNull()
    expect(mail!.querySelector('.tg-letter')?.textContent).toBe('M')
  })

  it('narrows the cards by what is typed (the title or the address), and says so when none is left', () => {
    show()
    type('cour')
    expect(names()).toEqual(['Courrier'])
    expect(host.querySelector('[role="status"]')?.textContent).toBe('1 onglet')
    type('zzzz')
    expect(cards()).toHaveLength(0)
    expect(host.querySelector('.tg-empty')?.textContent).toContain(frenchSpaces('« zzzz »'))
  })

  it('marks the tab on screen, and names each card for a screen reader', () => {
    show()
    const go = cards()[0]!.querySelector('.tg-go')!
    expect(go.getAttribute('aria-current')).toBe('true')
    expect(go.getAttribute('aria-label')).toBe(frenchSpaces('Aller à l’onglet « Documentation »'))
    expect(cards()[1]!.querySelector('.tg-go')!.getAttribute('aria-current')).toBeNull()
  })
})

describe('what a card does', () => {
  it('goes to its tab and puts the panel away', () => {
    show()
    click(cards()[1]!.querySelector('.tg-go'))
    expect(calls('dispatch')).toEqual([[{ type: 'tab/select', id: 'mail' }]])
    expect(calls('closeOverlay')).toEqual([[]])
  })

  it('closes its tab with its button and keeps the panel open, naming the tab that went', () => {
    show()
    click(cards()[1]!.querySelector('.tg-close'))
    expect(calls('dispatch')).toEqual([[{ type: 'tab/close', id: 'mail' }]])
    expect(calls('closeOverlay')).toEqual([])
    expect(host.querySelector('[role="status"]')?.textContent).toContain(frenchSpaces('« Courrier » fermé'))
    expect(cards()[1]!.querySelector('.tg-close')?.getAttribute('aria-label')).toBe(frenchSpaces('Fermer l’onglet « Courrier »'))
  })

  it('closes the tab with Delete or Backspace on its card', () => {
    show()
    key(cards()[0]!.querySelector('.tg-go')!, 'Delete')
    key(cards()[1]!.querySelector('.tg-go')!, 'Backspace')
    expect(calls('dispatch')).toEqual([[{ type: 'tab/close', id: 'docs' }], [{ type: 'tab/close', id: 'mail' }]])
  })

  it('opens the menu of the tab on a right click, which is where a tab is moved to another Space', () => {
    show()
    act(() => void cards()[1]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
    expect(calls('showMenu')).toHaveLength(1)
    expect(calls('showMenu')[0]![0]).toMatchObject({ kind: 'tab', id: 'mail' })
  })
})

describe('the keyboard', () => {
  it('goes from the search to the first card with ↓, and to its tab with Enter', () => {
    show()
    const field = host.querySelector('input[type="search"]')!
    key(field, 'ArrowDown')
    expect(document.activeElement).toBe(cards()[0]!.querySelector('.tg-go'))
    key(field, 'Enter')
    expect(calls('dispatch')).toEqual([[{ type: 'tab/select', id: 'docs' }]])
  })

  it('moves the focus from card to card with the arrows (only the selected card is a Tab stop)', () => {
    show()
    key(host.querySelector('input[type="search"]')!, 'ArrowDown')
    key(document.activeElement!, 'ArrowRight')
    expect(document.activeElement).toBe(cards()[1]!.querySelector('.tg-go'))
    expect(cards()[1]!.querySelector('.tg-go')!.getAttribute('tabindex')).toBe('0')
    expect(cards()[0]!.querySelector('.tg-go')!.getAttribute('tabindex')).toBe('-1')
    key(document.activeElement!, 'Home')
    expect(document.activeElement).toBe(cards()[0]!.querySelector('.tg-go'))
  })

  it('empties the search with Escape, then closes the panel', () => {
    show()
    type('cour')
    key(host.querySelector('input[type="search"]')!, 'Escape')
    expect(host.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('')
    expect(calls('closeOverlay')).toEqual([])
    key(host.querySelector('input[type="search"]')!, 'Escape')
    expect(calls('closeOverlay')).toEqual([[]])
  })

  it('has every control as a real button or field', () => {
    show()
    expect(host.querySelectorAll('[onclick], [role="button"]')).toHaveLength(0)
    for (const b of host.querySelectorAll('button')) expect(b.getAttribute('type')).toBe('button')
  })
})

describe('the stylesheet', () => {
  it('lets the cards wrap by themselves, cuts the transition for « Réduire les animations », and writes no colour', () => {
    expect(css).toContain('grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr))')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*transition: none/)
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  })
})
