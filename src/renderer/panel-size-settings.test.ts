// Settings › Apparence › Taille des fenêtres et des panneaux: the control with its notches, the preview and its slider, the list of the screens. The pane is drawn
// to elements with the real component (no window, as render.test-support.ts does), with the screens the test gives it; the bridge is a stand-in that writes down what
// the pane asked of it.

import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { defaultSettings, type Settings } from '@shared/model'
import { screenOf, withNoticed, withPanelSize, type PanelSizes, type ScreenInfo, type ScreenView } from '@shared/panel-scale'
import { loadScreens } from './panel-screens'
import { elementsOf, type Element } from './render.test-support'
import { frenchSpaces } from '@shared/french-typography'

const bridge = vi.hoisted(() => ({ asked: [] as Array<[string, unknown]> }))
vi.mock('./api', () => ({ api: () => ({ dispatch: (action: unknown) => void bridge.asked.push(['dispatch', action]), panelScreens: () => new Promise(() => undefined) }) }))

const { PanelSizeView, screenName } = await import('./PanelSizeSettings')

const screenAt = (width: number, height: number, label: string, internal = false, scaleFactor = 1): ScreenInfo => screenOf({ label, internal, scaleFactor, size: { width, height } })!
const ULTRAWIDE = screenAt(3440, 1440, 'LG UltraWide')
const LAPTOP = screenAt(1512, 982, '', true, 2)
const view = (screen: ScreenInfo, extra: Partial<ScreenView> = {}): ScreenView => ({ ...screen, current: false, window: null, ...extra })
const BOTH = [view(ULTRAWIDE, { current: true, window: { x: 1000, y: 200, width: 1360, height: 860 } }), view(LAPTOP)]

const settings = (panelSizes: PanelSizes = {}): Settings => ({ ...defaultSettings(), panelSizes })
const draw = (sizes: PanelSizes, screens: readonly ScreenView[] = BOTH): Element[] => elementsOf(createElement(PanelSizeView, { settings: settings(sizes), screens }))
const text = (node: unknown): string => (typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' && 'props' in node ? text((node as Element).props['children']) : '')
const withClass = (elements: Element[], name: string): Element[] => elements.filter((element) => String(element.props['className'] ?? '').split(' ').includes(name))
const notches = (elements: Element[]): Element[] => withClass(elements, 'panel-seg-item')
const slider = (elements: Element[]): Element => withClass(elements, 'panel-slider-input')[0]!
const act = (element: Element, handler: string, ...args: unknown[]): void => (element.props[handler] as (...a: unknown[]) => void)(...args)

beforeEach(() => {
  bridge.asked.length = 0
  setLanguage('fr')
})

describe('the control with its five notches', () => {
  it('has Automatique, Compacte, Normale, Grande and Très grande, in that order', () => {
    expect(notches(draw({})).map(text)).toEqual(['Automatique', 'Compacte', 'Normale', 'Grande', 'Très grande'])
  })

  it('shows Automatique while the screen has no choice, and the notch of the size that was chosen otherwise', () => {
    const pressed = (sizes: PanelSizes) => notches(draw(sizes)).filter((element) => element.props['aria-pressed'] === true).map(text)
    expect(pressed({})).toEqual(['Automatique'])
    expect(pressed(withPanelSize({}, ULTRAWIDE, 90, 1))).toEqual(['Compacte'])
    expect(pressed(withPanelSize({}, ULTRAWIDE, 100, 1))).toEqual(['Normale'])
    expect(pressed(withPanelSize({}, ULTRAWIDE, 125, 1))).toEqual(['Grande'])
    expect(pressed(withPanelSize({}, ULTRAWIDE, 150, 1))).toEqual(['Très grande'])
  })

  it('shows no notch for a size the slider chose between them, and says it is custom', () => {
    const drawn = draw(withPanelSize({}, ULTRAWIDE, 115, 1))
    expect(notches(drawn).filter((element) => element.props['aria-pressed'] === true)).toEqual([])
    expect(drawn.some((element) => element.props['hint'] === frenchSpaces('Personnalisée : 115 %'))).toBe(true)
  })

  it('shows the choice of the screen the window is on, not another screen’s', () => {
    const sizes = withPanelSize({}, LAPTOP, 150, 1)
    expect(notches(draw(sizes)).filter((element) => element.props['aria-pressed'] === true).map(text)).toEqual(['Automatique'])
  })

  it('chooses for the screen the window is on when a notch is clicked: its size in percent, and null for Automatique', () => {
    const drawn = notches(draw({}))
    act(drawn[3]!, 'onClick')
    act(drawn[1]!, 'onClick')
    act(drawn[0]!, 'onClick')
    const screen = { key: 'LG UltraWide|3440x1440@1', label: 'LG UltraWide', internal: false, width: 3440, height: 1440, scaleFactor: 1 }
    expect(bridge.asked).toEqual([
      ['dispatch', { type: 'panel-size/set', screen, percent: 125 }],
      ['dispatch', { type: 'panel-size/set', screen, percent: 90 }],
      ['dispatch', { type: 'panel-size/set', screen, percent: null }]
    ])
  })

  it('is the control of the screen with the focus even when the list gives another first: the screen marked current', () => {
    const drawn = notches(draw({}, [view(LAPTOP), view(ULTRAWIDE, { current: true })]))
    act(drawn[2]!, 'onClick')
    expect(bridge.asked[0]![1]).toMatchObject({ screen: { key: ULTRAWIDE.key }, percent: 100 })
  })

  it('waits, disabled, until the main process has told which screens there are (a failed question leaves it so)', () => {
    const drawn = draw({}, [])
    expect(notches(drawn).every((element) => element.props['disabled'] === true)).toBe(true)
    expect(slider(drawn).props['disabled']).toBe(true)
    expect(withClass(drawn, 'panel-stage')).toEqual([])
    act(notches(drawn)[2]!, 'onClick')
    expect(bridge.asked).toEqual([])
  })
})

describe('the preview', () => {
  it('names the screen it is drawn for, with its size', () => {
    const drawn = draw({})
    expect(text(withClass(drawn, 'panel-screen-pill')[0])).toBe(frenchSpaces('Écran : LG UltraWide 3440 × 1440'))
    expect(text(withClass(draw({}, [view(LAPTOP, { current: true })]), 'panel-screen-pill')[0])).toBe(frenchSpaces('Écran : Écran intégré 1512 × 982'))
  })

  it('has the shape of the screen, and draws the Notes panel in a window of it', () => {
    const drawn = draw({})
    expect(Number((withClass(drawn, 'panel-stage')[0]!.props['style'] as Record<string, unknown>)['--ratio'])).toBeCloseTo(3440 / 1440, 3)
    expect(text(withClass(drawn, 'panel-stage-title')[0])).toBe('Notes')
    expect(withClass(drawn, 'panel-stage-window')).toHaveLength(1)
    expect(withClass(drawn, 'panel-stage-panel')).toHaveLength(1)
  })

  it('draws the panel larger as the size goes up, at the same place', () => {
    const width = (sizes: PanelSizes) => parseFloat(String((withClass(draw(sizes), 'panel-stage-panel')[0]!.props['style'] as { width: string }).width))
    expect(width(withPanelSize({}, ULTRAWIDE, 150, 1))).toBeGreaterThan(width(withPanelSize({}, ULTRAWIDE, 100, 1)))
    expect(width(withPanelSize({}, ULTRAWIDE, 100, 1))).toBeGreaterThan(width(withPanelSize({}, ULTRAWIDE, 80, 1)))
    // Automatique on the ultra-wide is 125 %: the same picture as the choice of 125 %.
    expect(width({})).toBe(width(withPanelSize({}, ULTRAWIDE, 125, 1)))
  })

  it('is described for a screen reader, with the size', () => {
    expect(withClass(draw({}), 'panel-stage')[0]!.props['aria-label']).toBe(frenchSpaces('Aperçu : le panneau Notes dans une fenêtre sur cet écran, à 125 %'))
    expect(withClass(draw(withPanelSize({}, ULTRAWIDE, 90, 1)), 'panel-stage')[0]!.props['aria-label']).toBe(frenchSpaces('Aperçu : le panneau Notes dans une fenêtre sur cet écran, à 90 %'))
  })
})

describe('the slider', () => {
  it('goes from 80 to 160 % by 5, at the choice, or at what Automatique gives on this screen', () => {
    const auto = slider(draw({}))
    expect(auto.props).toMatchObject({ min: 80, max: 160, step: 5, value: 125, type: 'range' })
    expect(slider(draw(withPanelSize({}, ULTRAWIDE, 140, 1))).props['value']).toBe(140)
    expect(slider(draw({}, [view(LAPTOP, { current: true })])).props['value']).toBe(100)
  })

  it('says its value in words for a screen reader, and has a name', () => {
    const input = slider(draw(withPanelSize({}, ULTRAWIDE, 140, 1)))
    expect(input.props['aria-valuetext']).toBe(frenchSpaces('140 %'))
    expect(input.props['aria-label']).toBe('Taille des panneaux sur cet écran')
  })

  it('chooses nothing while it is dragged: the preview draws, and the windows (Settings is one of them) are left alone until it is let go', () => {
    const input = slider(draw({}))
    act(input, 'onChange', { currentTarget: { value: '140' } })
    act(input, 'onChange', { currentTarget: { value: '145' } })
    expect(bridge.asked).toEqual([])
  })

  it('chooses the value it was dragged to when it is let go (the pointer, a key, or the focus leaving), once', () => {
    for (const release of ['onPointerUp', 'onKeyUp', 'onBlur']) {
      bridge.asked.length = 0
      const input = slider(draw({}))
      act(input, 'onChange', { currentTarget: { value: '145' } })
      act(input, release)
      act(input, release)
      expect(bridge.asked, release).toEqual([['dispatch', { type: 'panel-size/set', screen: expect.objectContaining({ key: ULTRAWIDE.key }), percent: 145 }]])
    }
  })

  it('chooses nothing for a click that moved nothing, and keeps Automatique when it is let go where Automatique already was', () => {
    const input = slider(draw({}))
    act(input, 'onPointerUp')
    act(input, 'onChange', { currentTarget: { value: '125' } })
    act(input, 'onPointerUp')
    expect(bridge.asked).toEqual([])
  })
})

describe('the list of the known screens', () => {
  const rowsOf = (sizes: PanelSizes, screens: readonly ScreenView[] = BOTH) => withClass(draw(sizes, screens), 'panel-screen-row')

  it('lists the connected screens, each with its choice, or Automatique', () => {
    const rows = rowsOf(withPanelSize({}, ULTRAWIDE, 125, 1))
    expect(rows.map((row) => text(row))).toEqual([frenchSpaces('LG UltraWide 3440 × 1440125 %Retirer'), 'Écran intégré 1512 × 982Automatique'])
  })

  it('offers to remove a choice, and only a choice: back to Automatique for that screen', () => {
    const rows = rowsOf(withPanelSize({}, ULTRAWIDE, 125, 1))
    const buttons = rows.map((row) => elementsOf(row).filter((element) => element.type === 'button'))
    expect(buttons[0]).toHaveLength(1)
    expect(buttons[1]).toHaveLength(0)
    expect(buttons[0]![0]!.props['aria-label']).toBe('Retirer LG UltraWide 3440 × 1440')
    act(buttons[0]![0]!, 'onClick')
    expect(bridge.asked).toEqual([['dispatch', { type: 'panel-size/set', screen: { key: ULTRAWIDE.key, label: 'LG UltraWide', internal: false, width: 3440, height: 1440, scaleFactor: 1 }, percent: null }]])
  })

  it('keeps the choice of a screen that is not connected, and says so, so that plugging it in again finds it', () => {
    const office = screenAt(2560, 1440, 'Office')
    const rows = rowsOf(withPanelSize({}, office, 110, 1))
    expect(rows.map((row) => text(row))).toEqual(['LG UltraWide 3440 × 1440Automatique', 'Écran intégré 1512 × 982Automatique', frenchSpaces('Office 2560 × 1440 · non branché110 %Retirer')])
  })

  it('does not list a screen that was only noticed: it has no choice to show or to remove', () => {
    const rows = rowsOf(withNoticed({}, screenAt(2560, 1440, 'Office'), 1))
    expect(rows).toHaveLength(2)
  })

  it('names a screen by what it is: its own name, the built-in one by its kind, one with no name by « Écran »', () => {
    expect(screenName(ULTRAWIDE)).toBe('LG UltraWide')
    expect(screenName(LAPTOP)).toBe('Écran intégré')
    expect(screenName(screenAt(1920, 1080, ''))).toBe('Écran')
    setLanguage('en')
    expect(screenName(LAPTOP)).toBe('Built-in screen')
    expect(screenName(screenAt(1920, 1080, ''))).toBe('Screen')
  })
})

describe('the screens asked of the main process', () => {
  it('hands the list on', async () => {
    const set = vi.fn()
    await loadScreens(async () => BOTH, set, vi.fn())
    expect(set).toHaveBeenCalledWith(BOTH)
  })

  it('tells a question that failed, with what it was about, and keeps what the pane had', async () => {
    const set = vi.fn()
    const log = vi.fn()
    const failure = new Error('channel closed')
    await loadScreens(() => Promise.reject(failure), set, log)
    expect(set).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![0]).toContain('cannot read the screens')
    expect(log.mock.calls[0]![1]).toBe(failure)
  })

  it('ignores an answer that is not a list (a refused question answers nothing sensible)', async () => {
    const set = vi.fn()
    await loadScreens(async () => null as unknown as ScreenView[], set, vi.fn())
    expect(set).not.toHaveBeenCalled()
  })
})
