// The items of a live folder (LiveRows.tsx) are rows of the sidebar like a tab's: the row holds a real button, which the keyboard reaches and
// the arrows walk (`focusSibling` looks for `.tab > .tab-main`), and Return and Space click like on any button. Rendered to markup, which is what the
// assistive technology reads; the keys are tried on the elements the component returns, with a stand-in for the page.

import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Folder } from '@shared/model'
import type { LiveFolder } from '@shared/live-folders'
import { LiveItems } from './LiveRows'

const dispatch = vi.fn()
beforeEach(() => {
  dispatch.mockReset()
  ;(globalThis as { window?: unknown }).window = { lucium: { dispatch } }
})

const live: LiveFolder = {
  kind: 'feed',
  source: 'https://blog.example/feed.xml',
  items: [
    { title: 'Premier billet', url: 'https://blog.example/un', at: 1_700_000_000_000 },
    { title: 'Deuxième billet', url: 'https://blog.example/deux' }
  ],
  checkedAt: 1_700_000_100_000
} as unknown as LiveFolder
const folder = { id: 'f1', spaceId: 's1', name: 'Blog', collapsed: false, live } as Folder & { live: LiveFolder }

const markup = (): string => renderToStaticMarkup(createElement(LiveItems, { folder }))

/** Every element of the tree `LiveItems` returns, whose props satisfy `match`. */
function find(node: ReactNode, match: (props: Record<string, unknown>, type: unknown) => boolean, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((child) => find(child, match, found))
  else if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>
    if (match(props, node.type)) found.push(node)
    find(props['children'] as ReactNode, match, found)
  }
  return found
}
const tree = (): ReactNode => LiveItems({ folder })
const buttons = (): ReactElement[] => find(tree(), (_props, type) => type === 'button')

describe('the items of a live folder', () => {
  it('are rows that hold a real button, as a tab row does, not rows that are buttons', () => {
    const html = markup()
    expect(html).not.toMatch(/role="button"/)
    const rows = html.match(/<div class="tab live-item"[^>]*>(<button\b[^>]*>)/g) ?? []
    expect(rows).toHaveLength(2)
    // The button is the direct child of the row: the walk of the arrows looks for `.tab > .tab-main`.
    for (const row of rows) expect(row).toMatch(/<button type="button" class="tab-main"/)
  })

  it('name each button by the title of the item, and keep the site and the date in its tooltip', () => {
    const html = markup()
    expect(html).toContain('<span class="tab-title">Premier billet</span>')
    expect(html).toMatch(/<button[^>]*class="tab-main"[^>]*title="Premier billet\nblog\.example · /)
    expect(html).toMatch(/<button[^>]*class="tab-main"[^>]*title="Deuxième billet\nblog\.example"/)
  })

  it('are reached by the arrows of the sidebar like the other rows (not a stop of the Tab key of their own)', () => {
    for (const button of buttons()) expect(button.props as object).toMatchObject({ tabIndex: -1, className: 'tab-main' })
  })

  it('move the focus to the neighbouring row of the sidebar with the arrows, and leave the other keys to the button', () => {
    const rows = [{ focus: vi.fn() }, { focus: vi.fn() }, { focus: vi.fn() }]
    const asked: string[] = []
    const current = { closest: () => ({ querySelectorAll: (selector: string) => (asked.push(selector), rows) }) }
    rows.splice(1, 0, current as never)
    const onKeyDown = (buttons()[0]!.props as { onKeyDown: (event: unknown) => void }).onKeyDown
    const key = (name: string) => ({ key: name, currentTarget: current, preventDefault: vi.fn() })

    const down = key('ArrowDown')
    onKeyDown(down)
    expect(down.preventDefault).toHaveBeenCalled()
    expect(asked).toEqual(['.tab > .tab-main'])
    expect(rows[2]!.focus).toHaveBeenCalledOnce()

    const up = key('ArrowUp')
    onKeyDown(up)
    expect(up.preventDefault).toHaveBeenCalled()
    expect(rows[0]!.focus).toHaveBeenCalledOnce()

    // Return and Space are the button's own: nothing is stopped, nothing is opened twice.
    for (const name of ['Enter', ' ', 'Tab', 'a']) {
      const other = key(name)
      onKeyDown(other)
      expect(other.preventDefault, name).not.toHaveBeenCalled()
    }
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('open the page in a new tab on a click, which a key on the button makes as well; ⌘-click and the middle click open it behind', () => {
    const rowOf = (index: number) => find(tree(), (props) => props['data-live-item'] === 'f1')[index]!.props as { onClick: (event: unknown) => void; onAuxClick: (event: unknown) => void }
    rowOf(0).onClick({ metaKey: false, ctrlKey: false })
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'tab/open', url: 'https://blog.example/un' })
    rowOf(1).onClick({ metaKey: true, ctrlKey: false })
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'tab/open', url: 'https://blog.example/deux', background: true })
    rowOf(0).onAuxClick({ button: 1 })
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'tab/open', url: 'https://blog.example/un', background: true })
    rowOf(0).onAuxClick({ button: 2 })
    expect(dispatch).toHaveBeenCalledTimes(3)
  })
})
