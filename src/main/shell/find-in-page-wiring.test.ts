// The find bar's request on its way to the page (browser-dialogs.ts, `findInPage`) and the room kept for its panel (browser-layout.ts), run on a
// stand-in of the class Browser (browser-fake.test-support.ts): the buttons of the setting `findRegex` (expression, whole words, accents) reach the
// page only with the setting on, and the panel is as wide as its buttons need.

import { describe, expect, it, vi } from 'vitest'
import { FIND_PANEL, FIND_PANEL_WIDE } from '@shared/ipc'
import { findLayerBounds } from '@shared/ui-scale'
import { overlayHost, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

function searching(findRegex: boolean) {
  const page = { find: vi.fn(), stopFind: vi.fn() }
  const published = { find: null as unknown }
  const fake = overlayHost({ findRegex }, { activePage: () => page, publish: () => undefined })
  const find = (text: string, options: Record<string, unknown>) => {
    shell['findInPage']!.call(fake.self, text, options)
    published.find = fake.self['find']
  }
  return { page, find, published }
}

describe('findInPage', () => {
  const asked = { next: true, forward: false, matchCase: true, regex: true, wholeWord: true, accents: true }

  it('hands the page every option the bar sent when the setting is on, and says in the state of the bar that an expression is read', () => {
    const { page, find, published } = searching(true)
    find('é+', asked)
    expect(page.find).toHaveBeenCalledWith('é+', asked)
    expect(published.find).toEqual({ text: 'é+', matches: 0, ordinal: 0, regex: true })
  })

  it('hands the page the case and the direction only when the setting is off, whatever the interface sent', () => {
    const { page, find, published } = searching(false)
    find('é+', asked)
    expect(page.find).toHaveBeenCalledWith('é+', { next: true, forward: false, matchCase: true })
    expect(published.find).toEqual({ text: 'é+', matches: 0, ordinal: 0 })
  })

  it('keeps the whole words and the accents for the page when only they are on', () => {
    const { page, find } = searching(true)
    find('cole', { wholeWord: true, accents: true })
    expect(page.find).toHaveBeenCalledWith('cole', { wholeWord: true, accents: true })
  })
})

describe('the room of the find panel', () => {
  const boundsWith = (findRegex: boolean) => {
    const stage = { x: 300, y: 50, width: 1200, height: 900 }
    const fake = overlayHost({ findRegex }, { stageRect: () => stage, k: () => 1, win: { getContentBounds: () => ({ x: 0, y: 0, width: 1600, height: 1000 }) } })
    return { stage, bounds: shell['overlayBounds']!.call(fake.self, { panel: 'find' }) }
  }

  it('is the panel of always with the setting off', () => {
    const { stage, bounds } = boundsWith(false)
    expect(bounds).toEqual(findLayerBounds(stage, FIND_PANEL, 1))
  })

  it('is the wider panel with the setting on, and keeps its right edge', () => {
    const { stage, bounds } = boundsWith(true)
    expect(bounds).toEqual(findLayerBounds(stage, FIND_PANEL_WIDE, 1))
    const plain = findLayerBounds(stage, FIND_PANEL, 1)
    expect((bounds as { x: number; width: number }).x + (bounds as { width: number }).width).toBe(plain.x + plain.width)
  })
})
