// @vitest-environment happy-dom
// The views of one document draw the same snapshot: they share one listener and at most one read of the state, instead of each asking the main
// process for a copy of the whole state and receiving its own copy of every snapshot it sends.

import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getKeyPlatform, setKeyPlatform, tIn } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import { installBridge, mount, settle, type Mounted } from './dom.test-support'
import { followSnapshots, useSnapshot } from './api'

const snapshot = (platform: string): UiSnapshot =>
  ({ state: createInitialState({ now: 1, newId: () => 'id' }), runtime: { tabs: {} }, extensions: [], downloads: [], platform }) as unknown as UiSnapshot

function View({ name }: { name: string }) {
  const drawn = useSnapshot()
  return createElement('p', { 'data-view': name }, drawn ? drawn.platform : 'nothing')
}

const drawn = (container: Element): string[] => [...container.querySelectorAll('p')].map((p) => p.textContent ?? '')

interface Bridge {
  reads: number
  listeners: number
  stopped: number
  push: (next: UiSnapshot) => void
  answer: (first: UiSnapshot | null) => void
}

function bridge(): Bridge {
  const listening = new Set<(next: UiSnapshot) => void>()
  const answers: ((first: UiSnapshot | null) => void)[] = []
  const state: Bridge = {
    reads: 0,
    listeners: 0,
    stopped: 0,
    push: (next) => {
      for (const listener of [...listening]) listener(next)
    },
    answer: (first) => {
      for (const resolve of answers.splice(0)) resolve(first)
    }
  }
  installBridge({
    getSnapshot: () => {
      state.reads += 1
      return new Promise<UiSnapshot | null>((resolve) => answers.push(resolve))
    },
    onSnapshot: (listener: (next: UiSnapshot) => void) => {
      state.listeners += 1
      listening.add(listener)
      return () => {
        state.stopped += 1
        listening.delete(listener)
      }
    }
  })
  return state
}

const several = () => createElement('div', null, createElement(View, { name: 'a' }), createElement(View, { name: 'b' }), createElement(View, { name: 'c' }))

let mounted: Mounted | null = null
afterEach(async () => {
  mounted?.unmount()
  mounted = null
  // The document lets go of the snapshot a moment after its last view (api.ts): wait for it, so that no test starts with the previous one's.
  await settle()
  vi.restoreAllMocks()
})

describe('the snapshot of a document', () => {
  // The keys named inside the sentences are those of the system the snapshot says (shared/key-words.ts): a window on Linux reads « Ctrl+Q », not « ⌘Q ».
  it('tells the texts which system the window runs on, as it tells them the language', () => {
    const main = bridge()
    mounted = mount(several())
    act(() => main.push(snapshot('linux')))
    expect(getKeyPlatform()).toBe('linux')
    expect(tIn('fr', 'features.demande-une-confirmation-avant-q')).toBe('Demande une confirmation avant Ctrl+Q.')
    act(() => main.push(snapshot('darwin')))
    expect(tIn('fr', 'features.demande-une-confirmation-avant-q')).toBe('Demande une confirmation avant ⌘Q.')
    setKeyPlatform(undefined)
  })

  // The room kept for the traffic lights is macOS's alone: the stylesheets read the system from the root (window-controls.css).
  it('says the system on the root of the document, for the stylesheets', () => {
    const main = bridge()
    mounted = mount(several())
    act(() => main.push(snapshot('win32')))
    expect(document.documentElement.getAttribute('data-platform')).toBe('win32')
    act(() => main.push(snapshot('darwin')))
    expect(document.documentElement.getAttribute('data-platform')).toBe('darwin')
    document.documentElement.removeAttribute('data-platform')
    setKeyPlatform(undefined)
  })

  it('is read once and listened to once for all the views that draw it', async () => {
    const main = bridge()
    mounted = mount(several())
    expect(main.reads).toBe(1)
    expect(main.listeners).toBe(1)
    expect(drawn(mounted.container)).toEqual(['nothing', 'nothing', 'nothing'])

    await settle(() => main.answer(snapshot('first')))
    expect(drawn(mounted.container)).toEqual(['first', 'first', 'first'])

    act(() => main.push(snapshot('pushed')))
    expect(drawn(mounted.container)).toEqual(['pushed', 'pushed', 'pushed'])
    expect(main.reads).toBe(1)
  })

  it('keeps a snapshot pushed before the answer of the read, which is older', async () => {
    const main = bridge()
    mounted = mount(several())
    act(() => main.push(snapshot('pushed')))
    await settle(() => main.answer(snapshot('read')))
    expect(drawn(mounted.container)).toEqual(['pushed', 'pushed', 'pushed'])
  })

  it('stops listening when its last view goes, and a view mounted later reads the state again instead of drawing the old one', async () => {
    const main = bridge()
    mounted = mount(several())
    await settle(() => main.answer(snapshot('first')))
    mounted.unmount()
    mounted = null
    await settle()
    expect(main.stopped).toBe(1)

    mounted = mount(createElement(View, { name: 'later' }))
    expect(drawn(mounted.container)).toEqual(['nothing'])
    expect(main.reads).toBe(2)
    await settle(() => main.answer(snapshot('again')))
    expect(drawn(mounted.container)).toEqual(['again'])
  })

  it('is kept while the document follows the snapshots: a view mounted afterwards draws it from its first frame, without a read', async () => {
    const main = bridge()
    const unfollow = followSnapshots()
    try {
      act(() => main.push(snapshot('kept')))
      mounted = mount(createElement(View, { name: 'panel' }))
      expect(drawn(mounted.container)).toEqual(['kept'])
      expect(main.reads).toBe(0)
      expect(main.listeners).toBe(1)
    } finally {
      unfollow()
    }
  })

  it('a failed read leaves the views waiting for the next snapshot, and says why in the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    installBridge({ getSnapshot: () => Promise.reject(new Error('refused')), onSnapshot: () => () => undefined })
    mounted = mount(createElement(View, { name: 'alone' }))
    await settle()
    expect(drawn(mounted.container)).toEqual(['nothing'])
    expect(warn).toHaveBeenCalledWith('[ui] the first state could not be read:', expect.any(Error))
  })
})
