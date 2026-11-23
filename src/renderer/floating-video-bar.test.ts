// The bar of Lucium's floating video window (FloatingVideoBar.tsx), drawn to markup: a recorded video and a live stream, the small window, the
// sound, the names of the buttons in both languages, the keys they say, and what each button asks of the window.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { FLOATING_COMPACT_WIDTH, type FloatingVideoFacts, type FloatingVideoState } from '@shared/floating-video'
import { elementsOf, type Element } from './render.test-support'
import { frenchSpaces } from '@shared/french-typography'

vi.mock('./api', () => ({ api: () => ({ onFloatingVideoState: () => () => undefined }) }))

const { FloatingVideoView } = await import('./FloatingVideoBar')

const recorded = (over: Partial<FloatingVideoFacts> = {}): FloatingVideoFacts => ({ paused: false, ended: false, muted: false, volume: 0.6, currentTime: 125, duration: 2470, live: false, behindLive: false, protected: false, width: 1920, height: 1080, ...over })
const state = (facts: FloatingVideoFacts | null, over: Partial<FloatingVideoState> = {}): FloatingVideoState => ({ site: 'twitch.tv', pinned: true, tabMuted: false, facts, ...over })
const live = (over: Partial<FloatingVideoFacts> = {}) => recorded({ live: true, duration: null, ...over })

const draw = (value: FloatingVideoState | null, width = 640, visible = true) => {
  const act = vi.fn()
  const tree = createElement(FloatingVideoView, { state: value, visible, width, act })
  const elements = elementsOf(tree)
  const button = (label: string) => elements.find((el: Element) => (el.type === 'button' || el.type === 'input') && el.props['aria-label'] === label)
  const click = (label: string) => (button(label)!.props['onClick'] as () => void)()
  return { markup: renderToStaticMarkup(tree), act, button, click, elements }
}

beforeEach(() => setLanguage('fr'))
afterEach(() => setLanguage('fr'))

describe('the bar of a recorded video', () => {
  it('has, from left to right, pause, the sound and its volume, −10 s and +10 s, the time and « Revenir à l’onglet »; nothing at the top but the handle of the window', () => {
    const { markup, button } = draw(state(recorded()))
    for (const label of ['Pause', 'Couper le son', 'Volume', frenchSpaces('Reculer de 10 s'), frenchSpaces('Avancer de 10 s'), 'Revenir à l’onglet']) expect(button(label), label).toBeDefined()
    // No header: not the site, not the pin, not the close button (« Revenir à l’onglet » and ⌘W close the window).
    for (const label of ['Garder au premier plan', 'Fermer']) expect(button(label), label).toBeUndefined()
    expect(markup).toContain('<div class="fv-top" aria-hidden="true"></div>')
    expect(markup).toContain('2:05 / 41:10')
    // The time has a role: a name on an element without one is not read, and « 2:05 / 41:10 » alone does not say what it counts.
    expect(markup).toContain(`<span class="fv-time" role="timer" aria-label="${frenchSpaces('Temps écoulé et durée')}">2:05 / 41:10</span>`)
    expect(markup).not.toContain('twitch.tv')
    expect(markup).not.toContain('EN DIRECT')
    expect(markup.indexOf('Pause')).toBeLessThan(markup.indexOf('Couper le son'))
    expect(markup.indexOf('Avancer de 10 s')).toBeLessThan(markup.indexOf('Revenir à l’onglet'))
  })

  it('is a named group, not a toolbar: ← and → seek the video, so they cannot go from button to button as a toolbar promises', () => {
    const { markup } = draw(state(recorded()))
    expect(markup).not.toContain('role="toolbar"')
    expect(markup).toMatch(/<div class="fv-bar" role="group" aria-label="Commandes[^"]*"/)
  })

  it('says each key in the name the pointer shows, and to assistive technologies', () => {
    const { button } = draw(state(recorded()))
    expect(button('Pause')!.props['title']).toBe('Pause · barre d’espace')
    expect(button('Pause')!.props['aria-keyshortcuts']).toBe('Space')
    expect(button('Couper le son')!.props['aria-keyshortcuts']).toBe('M')
    expect(button(frenchSpaces('Reculer de 10 s'))!.props['aria-keyshortcuts']).toBe('ArrowLeft')
  })

  it('offers « Lecture » for a paused or ended video, and has no −10 s for a protected one', () => {
    expect(draw(state(recorded({ paused: true }))).button('Lecture')).toBeDefined()
    expect(draw(state(recorded({ ended: true }))).button('Lecture')).toBeDefined()
    expect(draw(state(recorded({ protected: true }))).button('Reculer de 10 s')).toBeUndefined()
  })

  it('asks the window what each button does', () => {
    const { click, act, button } = draw(state(recorded()))
    click('Pause')
    click('Couper le son')
    click(frenchSpaces('Reculer de 10 s'))
    click(frenchSpaces('Avancer de 10 s'))
    click('Revenir à l’onglet')
    ;(button('Volume')!.props['onChange'] as (event: unknown) => void)({ currentTarget: { value: '0.25' } })
    expect(act.mock.calls.map(([command]) => command)).toEqual([{ kind: 'toggle' }, { kind: 'mute' }, { kind: 'seek', seconds: -10 }, { kind: 'seek', seconds: 10 }, { kind: 'back' }, { kind: 'volume', value: 0.25 }])
  })
})

describe('the bar of a live stream', () => {
  it('says « En direct » in place of the time, with no −10 s nor +10 s and no « EN DIRECT » over the picture', () => {
    const { markup, button } = draw(state(live()))
    expect(markup).not.toContain('EN DIRECT')
    expect(markup).toContain('En direct')
    expect(button('Reculer de 10 s')).toBeUndefined()
    expect(button('Avancer de 10 s')).toBeUndefined()
  })

  it('offers « Revenir au direct » in the bar, in place of the time, behind the live edge', () => {
    const { act, markup, elements } = draw(state(live({ behindLive: true })))
    const back = elements.find((el: Element) => el.props['className'] === 'fv-live behind')
    expect(back).toBeDefined()
    expect(markup).toContain('Revenir au direct')
    expect(markup).not.toContain('class="fv-time"')
    ;(back!.props['onClick'] as () => void)()
    expect(act).toHaveBeenCalledWith({ kind: 'live' })
    expect(draw(state(live())).elements.some((el: Element) => el.props['className'] === 'fv-live behind')).toBe(false)
  })
})

describe('the sound of the bar', () => {
  it('shows the tab’s sound cut, or the video silent, as cut, with the slider at zero', () => {
    for (const value of [state(recorded(), { tabMuted: true }), state(recorded({ muted: true })), state(recorded({ volume: 0 }))]) {
      const { button } = draw(value)
      expect(button('Réactiver le son')).toBeDefined()
      expect(button('Volume')!.props['value']).toBe(0)
    }
    expect(draw(state(recorded())).button('Volume')!.props['value']).toBe(0.6)
  })
})

describe('the small window', () => {
  it('keeps only pause, the sound and « Revenir à l’onglet »', () => {
    const { button, markup } = draw(state(live()), FLOATING_COMPACT_WIDTH - 1)
    for (const label of ['Pause', 'Couper le son', 'Revenir à l’onglet']) expect(button(label), label).toBeDefined()
    for (const label of ['Volume', 'Garder au premier plan', 'Fermer', 'Reculer de 10 s']) expect(button(label), label).toBeUndefined()
    expect(markup).not.toContain('EN DIRECT')
    expect(markup).not.toContain('twitch.tv')
    expect(markup).not.toContain('En direct<')
    expect(markup).toContain('class="fv shown compact"')
  })
})

describe('the bar before the video is read', () => {
  it('says it is looking for it, and can only go back or close', () => {
    const { button, markup } = draw(state(null))
    expect(markup).toContain('Recherche de la vidéo…')
    expect(button('Lecture')!.props['disabled']).toBe(true)
    expect(button('Revenir à l’onglet')!.props['disabled']).toBeUndefined()
  })

  it('is hidden until the pointer moves: no « shown » class', () => {
    expect(draw(state(recorded()), 640, false).markup).toContain('class="fv"')
  })
})

describe('the bar in English', () => {
  it('names its buttons in the language of the interface', () => {
    setLanguage('en')
    const { button, markup } = draw(state(live()))
    for (const label of ['Pause', 'Mute', 'Volume', 'Back to tab']) expect(button(label), label).toBeDefined()
    for (const label of ['Keep on top', 'Close']) expect(button(label), label).toBeUndefined()
    expect(markup).toContain('Live')
    expect(button('Pause')!.props['title']).toBe('Pause · Space bar')
  })
})
