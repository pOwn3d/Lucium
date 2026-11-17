// The whole page can be captured too: the selection layer only knew how to take a rectangle.

import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'

const act = vi.hoisted(() => ({ captureFullPage: vi.fn(), captureVisible: vi.fn(), closeOverlay: vi.fn() }))
vi.mock('./api', () => ({ api: () => act, useSnapshot: () => null }))
// capture.ts (the main process side of the same button) imports electron: nothing of it is used by the capture of a page that the test gives a browser for.
vi.mock('electron', () => ({ app: {}, clipboard: {}, ClipboardItem: class {}, Notification: class {}, shell: {} }))
vi.mock('../main/shell/portrait', () => ({ renderPortrait: vi.fn() }))

import { captureFromLayer } from '../main/shell/capture'
import { RegionCapture } from './Panels'

beforeAll(() => setLanguage('fr'))
afterEach(() => vi.clearAllMocks())

/** Every element of a tree, depth first. */
function elementsOf(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elementsOf)
  if (!isValidElement(node)) return []
  const element = node as ReactElement<Record<string, unknown>>
  return [element, ...elementsOf(element.props['children'] as ReactNode)]
}

/** The elements the layer returns, with their handlers. The component is called inside the render of a probe, where its state hook is allowed. */
function layer(): ReactElement<Record<string, unknown>>[] {
  let tree: ReactNode = null
  const Probe = (): null => {
    tree = RegionCapture()
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  return elementsOf(tree)
}

describe('the layer where a zone is chosen for a capture', () => {
  it('offers the whole page next to the hint, without taking the pointer for a zone', () => {
    const markup = renderToStaticMarkup(createElement(RegionCapture))
    expect(markup).toContain('Faites glisser pour choisir la zone')
    expect(markup).toMatch(/<button[^>]*class="capture-full"[^>]*>Page entière<\/button>/)
  })

  it('asks the main process for the whole page, or for what is on screen, when the button is pressed', () => {
    const button = (label: string) => layer().find((element) => element.type === 'button' && element.props['children'] === label)
    ;(button('Page entière')?.props['onClick'] as () => void)()
    expect(act.captureFullPage).toHaveBeenCalledTimes(1)
    expect(act.captureVisible).not.toHaveBeenCalled()
    ;(button('Fenêtre visible')?.props['onClick'] as () => void)()
    expect(act.captureVisible).toHaveBeenCalledTimes(1)
  })

  it('does not let a press on the bar reach the layer: it is neither the start of a zone nor the end of one (which would close the layer first)', () => {
    const bar = layer().find((element) => element.props['className'] === 'capture-hint')
    for (const handler of ['onMouseDown', 'onMouseUp']) {
      const event = { stopPropagation: vi.fn() }
      ;(bar?.props[handler] as (e: typeof event) => void)(event)
      expect(event.stopPropagation, handler).toHaveBeenCalledTimes(1)
    }
  })
})

describe('the capture of the whole page asked from the layer', () => {
  /** A browser that notes in which order it is asked, and whose capture gives nothing to save (or fails). */
  function browserOf(options: { fails?: boolean } = {}) {
    const calls: string[] = []
    const browser = {
      closeOverlay: vi.fn(() => void calls.push('close the layer')),
      // A single page on screen: the pane in focus is the selected tab, nothing to select.
      followPaneFocus: vi.fn(),
      capture: vi.fn(async (full: boolean) => {
        calls.push(full ? 'capture the page' : 'capture the screen')
        if (options.fails) throw new Error('the page is gone')
        return null
      }),
      showToast: vi.fn()
    }
    return { browser: browser as unknown as Parameters<typeof captureFromLayer>[0], calls, spies: browser }
  }

  it('closes the layer first, so that the picture is the page and not the layer over it', async () => {
    const { browser, calls, spies } = browserOf()
    await captureFromLayer(browser, true)
    expect(calls).toEqual(['close the layer', 'capture the page'])
    expect(spies.showToast).not.toHaveBeenCalled()
  })

  it('takes what is on screen only when the whole page is not asked for', async () => {
    const { browser, calls } = browserOf()
    await captureFromLayer(browser, false)
    expect(calls).toEqual(['close the layer', 'capture the screen'])
  })

  it('tells the user, with a toast, when the capture fails: the layer is gone and nothing else would say that no picture was made', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { browser, spies } = browserOf({ fails: true })
    await captureFromLayer(browser, true)
    expect(spies.showToast).toHaveBeenCalledTimes(1)
    expect(String(spies.showToast.mock.calls[0]![0])).toContain('capture')
    expect(error).toHaveBeenCalledWith('[capture] full-page capture failed:', expect.any(Error))
    error.mockRestore()
  })
})
