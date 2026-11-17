// The bar of a tab that plays: its title row (the name of the tab, « Image dans l'image », « Fermer ») is folded to nothing until the pointer comes.
// Its two buttons are the first Tab stops of the bar: the row opens when the keyboard brings the focus into the bar, so that the focus is never
// on a button that cannot be seen.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabItem } from '@shared/model'
import { expandedElements, rendersOf, type Element } from './render.test-support'

vi.mock('./api', () => ({ api: () => new Proxy({}, { get: () => () => undefined }), useSnapshot: () => null }))

import { MediaPlayer } from './MediaPlayer'

const tab: TabItem = { id: 't', spaceId: 's', url: 'https://musique.exemple/', title: 'Musique', pinned: false, createdAt: 1, lastActiveAt: 2 }
const info = { loading: false, audible: true, muted: false, awake: true }
/** A button of the bar as a focus event names it: `visible` says whether the keyboard gave the focus. */
const button = (visible: boolean) => ({ matches: (selector: string) => selector === ':focus-visible' && visible })

/** The state of the bar drawn once, then again after `act` was given the bar of the first drawing. */
function statesAround(act: (bar: Element) => void): [string, string] {
  const states = rendersOf(2, (pass) => {
    const bar = expandedElements(createElement(MediaPlayer, { tab, info: info as never })).find((element) => element.props['data-media-player'] === 't')!
    if (pass === 0) act(bar)
    return String(bar.props['data-state'])
  })
  return [states[0]!, states[1]!]
}
const focus = (bar: Element, target: unknown): void => (bar.props['onFocus'] as (event: unknown) => void)({ target })
const blur = (bar: Element, inBar: boolean): void => (bar.props['onBlur'] as (event: unknown) => void)({ currentTarget: { contains: () => inBar }, relatedTarget: {} })

beforeEach(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }))
afterEach(() => vi.unstubAllGlobals())

describe('the pause of a tab that is muted', () => {
  const buttons = (over: object): Element[] => rendersOf(1, () => expandedElements(createElement(MediaPlayer, { tab, info: { ...info, ...over } as never })))[0]!.filter((element) => element.type === 'button')
  const toggle = (over: object): Element => buttons(over).find((element) => String(element.props['className']).includes('mp-toggle'))!

  it('is toned down but not said to be unavailable: it still pauses the tab', () => {
    expect(toggle({ muted: true }).props['className']).toBe('mp-button mp-toggle quiet')
    expect(toggle({ muted: true }).props['aria-disabled']).toBeUndefined()
    expect(toggle({ muted: false }).props['className']).toBe('mp-button mp-toggle')
  })

  it('leaves « unavailable » to a button that cannot act: no previous track on the site', () => {
    const previous = buttons({ muted: true }).find((element) => String(element.props['className']).includes('mp-previous'))!
    expect([previous.props['className'], previous.props['aria-disabled']]).toEqual(['mp-button mp-previous dim', true])
  })
})

describe('the bar of a tab that plays, from the keyboard', () => {
  it('is folded until something happens', () => {
    expect(statesAround(() => undefined)).toEqual(['folded', 'folded'])
  })

  it('opens its title row when the keyboard brings the focus on one of its buttons', () => {
    expect(statesAround((bar) => focus(bar, button(true)))).toEqual(['folded', 'open'])
  })

  it('stays folded for a focus a click gave', () => {
    expect(statesAround((bar) => focus(bar, button(false)))).toEqual(['folded', 'folded'])
  })

  it('stays open while the focus goes from one of its buttons to another, and folds when the focus leaves it', () => {
    expect(
      statesAround((bar) => {
        focus(bar, button(true))
        blur(bar, true)
      })
    ).toEqual(['folded', 'open'])
    expect(
      statesAround((bar) => {
        focus(bar, button(true))
        blur(bar, false)
      })
    ).toEqual(['folded', 'folded'])
  })
})
