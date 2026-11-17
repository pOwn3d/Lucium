// The layout bar under a split view of two panes, as the person finds it: rendered to markup for what is shown, and its elements walked for what
// each button sends (the component has no state of its own, it can be called as a function).

import { createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SplitView } from '@shared/model'
import { SplitBar } from './SplitBar'

const split: SplitView = { id: 'sp1', spaceId: 's', tabIds: ['a', 'b'], orientation: 'horizontal', ratios: [0.5, 0.5] }
const style = { left: 0, top: 0, width: 600, height: 36 }
const bar = (patch: Partial<{ split: SplitView; scrollSync: boolean; synced: boolean }> = {}) => ({ split, scrollSync: false, synced: false, style, ...patch })
const markup = (patch: Parameters<typeof bar>[0] = {}): string => renderToStaticMarkup(createElement(SplitBar, bar(patch)))

/** The buttons of the element tree, in order, with their text. */
function buttons(node: ReactNode, out: Array<{ text: string; onClick: () => void }> = []): Array<{ text: string; onClick: () => void }> {
  if (Array.isArray(node)) node.forEach((child) => buttons(child, out))
  else if (node && typeof node === 'object' && 'props' in node) {
    const element = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>
    const text = (n: ReactNode): string => (Array.isArray(n) ? n.map(text).join('') : typeof n === 'string' ? n : n && typeof n === 'object' && 'props' in n ? text((n as ReactElement<{ children?: ReactNode }>).props.children) : '')
    if (element.type === 'button' && element.props.onClick) out.push({ text: text(element.props.children), onClick: element.props.onClick })
    else buttons(element.props.children, out)
  }
  return out
}

const sent = { dispatch: vi.fn(), setScrollSynced: vi.fn() }
beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = { lucium: sent }
})
afterEach(() => {
  sent.dispatch.mockReset()
  sent.setScrollSynced.mockReset()
  delete (globalThis as { window?: unknown }).window
})

describe('what the bar shows', () => {
  it('has the three ratios and "Échanger", and the ratio the panes have is the one that is pressed', () => {
    const html = markup()
    expect(html).toContain('30 / 70')
    expect(html).toContain('50 / 50')
    expect(html).toContain('70 / 30')
    expect(html).toContain('Échanger')
    expect(html).toMatch(/aria-pressed="true"[^>]*>50 \/ 50/)
    expect(html).toMatch(/aria-pressed="false"[^>]*>30 \/ 70/)
  })

  it('offers "Défilement synchronisé" only while the setting that offers it is on, and shows it pressed while the panes scroll together', () => {
    expect(markup({ scrollSync: false, synced: true })).not.toContain('Défilement synchronisé')
    expect(markup({ scrollSync: true, synced: false })).toMatch(/aria-pressed="false"[^>]*>.*Défilement synchronisé/)
    expect(markup({ scrollSync: true, synced: true })).toMatch(/aria-pressed="true"[^>]*>.*Défilement synchronisé/)
  })

  it('is a labelled group, so that a screen reader says what it is', () => {
    expect(markup()).toContain('role="group"')
    expect(markup()).toContain('aria-label="Disposition des volets"')
  })

  it('shows nothing for a split view of three panes (it has no bar)', () => {
    expect(markup({ split: { ...split, tabIds: ['a', 'b', 'c'], ratios: [0.3, 0.3, 0.4] } })).toBe('')
  })
})

describe('what the buttons send', () => {
  const tree = (patch: Parameters<typeof bar>[0] = {}) => buttons(SplitBar(bar(patch)))

  it('sends the shares of the ratio that was pressed, for this split view', () => {
    const [thirty, , seventy] = tree()
    thirty!.onClick()
    seventy!.onClick()
    expect(sent.dispatch.mock.calls).toEqual([[{ type: 'split/ratios', id: 'sp1', ratios: [0.3, 0.7] }], [{ type: 'split/ratios', id: 'sp1', ratios: [0.7, 1 - 0.7] }]])
  })

  it('sends the swap of the two pages', () => {
    tree().find((b) => b.text.includes('Échanger'))!.onClick()
    expect(sent.dispatch).toHaveBeenCalledWith({ type: 'split/move', tabId: 'a', direction: 1 })
  })

  it('asks the shell to link the scrolling, or to stop linking it, whichever it is not doing', () => {
    tree({ scrollSync: true, synced: false }).find((b) => b.text.includes('Défilement synchronisé'))!.onClick()
    tree({ scrollSync: true, synced: true }).find((b) => b.text.includes('Défilement synchronisé'))!.onClick()
    expect(sent.setScrollSynced.mock.calls).toEqual([['sp1', true], ['sp1', false]])
    expect(sent.dispatch).not.toHaveBeenCalled()
  })
})
