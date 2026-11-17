// @vitest-environment happy-dom
// A surface that draws a snapshot (`useSnapshot`) puts the system's « Toujours afficher les barres de défilement » on its document as an attribute, so that
// the stylesheets give their bar back to the lists that hide it (scroll-bars-css.test.ts); it takes it off when the setting goes.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UiSnapshot } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import { installBridge, mount, settle, type Mounted } from './dom.test-support'
import { useSnapshot } from './api'

let mounted: Mounted | null = null
let push: ((snapshot: UiSnapshot) => void) | null = null

const snapshot = (extra: Partial<UiSnapshot> = {}): UiSnapshot => ({ state: createInitialState({ now: 1, newId: () => 'id' }), runtime: { tabs: {} }, extensions: [], downloads: [], platform: 'darwin', ...extra }) as unknown as UiSnapshot
const attribute = (): string | null => document.documentElement.getAttribute('data-scrollbars')

function Surface() {
  useSnapshot()
  return null
}

async function open(first: UiSnapshot): Promise<void> {
  installBridge({
    getSnapshot: () => Promise.resolve(first),
    onSnapshot: (listener: (snapshot: UiSnapshot) => void) => {
      push = listener
      return () => undefined
    }
  })
  mounted = mount(createElement(Surface))
  await settle()
}

beforeEach(() => document.documentElement.removeAttribute('data-scrollbars'))
afterEach(() => {
  mounted?.unmount()
  mounted = null
  push = null
  vi.restoreAllMocks()
})

describe('the document of a surface', () => {
  it('has no attribute while the system does not always show the bars', async () => {
    await open(snapshot())
    expect(attribute()).toBeNull()
  })

  it('takes data-scrollbars="always" from the snapshot, and loses it when the setting goes', async () => {
    await open(snapshot({ scrollBarsAlways: true }))
    expect(attribute()).toBe('always')
    act(() => push!(snapshot()))
    expect(attribute()).toBeNull()
    act(() => push!(snapshot({ scrollBarsAlways: true })))
    expect(attribute()).toBe('always')
  })
})
