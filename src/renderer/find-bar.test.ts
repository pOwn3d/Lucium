// @vitest-environment happy-dom
// The find bar's buttons (Panels.tsx, `FindBar`): with the setting `findRegex` off the bar has none; with it on it has case, whole words, accents and the
// expression, off at first, and each press changes what the next search asks for and, when something is typed, searches again at once.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { createInitialState } from '@shared/sidebar'
import { click, mount, type Mounted, type } from './dom.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, finds: [] as Array<[string, unknown]> }))
vi.mock('./api', () => ({
  api: () => ({ find: (text: string, options: unknown) => void holder.finds.push([text, options]), closeOverlay: () => undefined }),
  useSnapshot: () => holder.snapshot
}))

import { FindBar } from './Panels'

let mounted: Mounted | null = null

function bar(findRegex: boolean) {
  const base = createInitialState({ now: 0, newId: () => 'x' })
  holder.snapshot = { state: { ...base, settings: { ...base.settings, findRegex } }, find: null }
  mounted = mount(createElement(FindBar))
  return mounted.container
}

const toggle = (container: HTMLElement, key: string) => container.querySelector<HTMLButtonElement>(`[data-find-toggle="${key}"]`)

beforeEach(() => {
  setLanguage('fr')
  holder.finds.length = 0
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('the buttons of the find bar', () => {
  it('are not there with the setting off, and the bar keeps its field, its arrows and its close button', () => {
    const container = bar(false)
    expect(container.querySelectorAll('[data-find-toggle]')).toHaveLength(0)
    expect(container.querySelector('.fb-input')).not.toBeNull()
  })

  it('are four with the setting on, named, and not pressed', () => {
    const container = bar(true)
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-find-toggle]')]
    expect(buttons.map((b) => b.dataset['findToggle'])).toEqual(['matchCase', 'wholeWord', 'accents', 'regex'])
    for (const b of buttons) {
      expect(b.getAttribute('aria-label'), b.dataset['findToggle']).toBeTruthy()
      expect(b.getAttribute('aria-pressed')).toBe('false')
    }
  })

  it('search again with the option when one is pressed after a text is typed, and without it when it is pressed again', async () => {
    const container = bar(true)
    type(container.querySelector<HTMLInputElement>('.fb-input')!, 'école')
    expect(holder.finds.at(-1)).toEqual(['école', {}])
    await click(toggle(container, 'wholeWord')!)
    expect(holder.finds.at(-1)).toEqual(['école', { wholeWord: true }])
    expect(toggle(container, 'wholeWord')!.getAttribute('aria-pressed')).toBe('true')
    await click(toggle(container, 'accents')!)
    await click(toggle(container, 'matchCase')!)
    expect(holder.finds.at(-1)).toEqual(['école', { matchCase: true, wholeWord: true, accents: true }])
    await click(toggle(container, 'wholeWord')!)
    expect(holder.finds.at(-1)).toEqual(['école', { matchCase: true, accents: true }])
  })

  it('send the pressed options with the text that is typed next', async () => {
    const container = bar(true)
    await click(toggle(container, 'regex')!)
    expect(holder.finds).toEqual([])
    type(container.querySelector<HTMLInputElement>('.fb-input')!, 'a+')
    expect(holder.finds.at(-1)).toEqual(['a+', { regex: true }])
  })
})
