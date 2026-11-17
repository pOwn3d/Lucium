// @vitest-environment happy-dom
// The extension icons of the toolbar that do not fit go to the « menu, whatever the order in which the refs of the bar are attached. The bar and its
// right group are ancestors of ExtensionActions: their refs are attached after its first layout effect, which then found them empty and measured
// nothing. With the snapshot already known at the first render (nothing re-rendered the component afterwards), the icons stayed where they were, the
// right group took the room of the address and the address was left with no width at 900 px.

import { createElement, useRef } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import { followSnapshots } from './api'
import { ExtensionActions } from './ExtensionActions'
import { mount, settle, type Mounted } from './dom.test-support'

/** Widths as the layout of the run in which the address was squeezed measured them: the bar 567, its left group 106, its right group 328 of which 144 are the icons. */
const WIDTHS: Record<string, number> = { 'bar': 567, 'left': 106, 'right': 328, 'tb-actions': 144 }

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return WIDTHS[this.dataset['role'] ?? ''] ?? (this.classList.contains('tb-actions') ? WIDTHS['tb-actions']! : 0)
    }
  })
  customElements.define(
    'browser-action-list',
    class extends HTMLElement {
      constructor() {
        super()
        const shadow = this.attachShadow({ mode: 'open' })
        for (let i = 0; i < 5; i++) {
          const action = document.createElement('button')
          action.className = 'action'
          action.id = `a${i}`
          shadow.append(action)
        }
      }
    }
  )
})

let mounted: Mounted | null = null
let stop: (() => void) | null = null

beforeEach(() => {
  const snapshot = { state: createInitialState({ now: 1, newId: () => 'id' }), extensions: [], runtime: { tabs: {} }, downloads: [], windows: [], platform: 'darwin' } as unknown as UiSnapshot
  // The snapshot is known before anything is drawn, as it is once a document has received one.
  ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = {
    getSnapshot: async () => snapshot,
    onSnapshot: (listener) => {
      listener(snapshot)
      return () => undefined
    }
  }
  stop = followSnapshots()
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  stop?.()
  stop = null
})

function Bar() {
  const bar = useRef<HTMLDivElement>(null)
  const left = useRef<HTMLDivElement>(null)
  const right = useRef<HTMLDivElement>(null)
  return createElement(
    'div',
    { ref: bar, 'data-role': 'bar' },
    createElement('div', { ref: left, 'data-role': 'left' }),
    createElement('div', { ref: right, 'data-role': 'right' }, createElement(ExtensionActions, { partition: 'persist:p', profileId: 'default', bar, left, right }))
  )
}

describe('the plan of the extension icons, at the first mount of the bar', () => {
  it('sends to the « menu the icons that leave the address less than its minimum, although the snapshot was there at the first render', async () => {
    mounted = mount(createElement(Bar))
    await settle()
    const shadow = mounted.container.querySelector('browser-action-list')!.shadowRoot!
    const hidden = [...shadow.querySelectorAll<HTMLElement>('.action')].filter((node) => node.hidden)
    // The right group holds 184 px besides the icons and may be 182 px wide at this width: no icon fits.
    expect(hidden).toHaveLength(5)
    expect(mounted.container.querySelector('.tb-overflow')).not.toBeNull()
  })
})
