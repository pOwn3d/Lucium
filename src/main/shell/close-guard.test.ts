import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const showMessageBox = vi.fn()
vi.mock('electron', () => ({ dialog: { showMessageBox: (...args: unknown[]) => showMessageBox(...args) } }))

import { setLanguage } from '@shared/i18n'
import { createInitialState, reduce, type Ctx } from '@shared/sidebar'
import { CloseGuard, askWithSheet, type CloseAnswer, type CloseAsker } from './close-guard'
import { prepareQuitForUpdate } from './quit-flow'
import type { WindowRecord } from './windows'
import { frenchSpaces } from '@shared/french-typography'

/** A window that can be closed: `close()` emits `close` to the listeners and goes unless one of them prevented it. */
class FakeWindow extends EventEmitter {
  destroyed = false
  closes = 0
  isDestroyed() {
    return this.destroyed
  }
  close() {
    this.closes++
    const event = { prevented: false, preventDefault() { this.prevented = true } }
    this.emit('close', event)
    if (!event.prevented) {
      this.destroyed = true
      this.emit('closed')
    }
  }
}

const ctx: Ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const stateWithTabs = (count: number) => {
  let state = createInitialState(ctx)
  for (let i = 0; i < count; i++) state = reduce(state, { type: 'tab/open', url: `https://t${i}.example/` }, ctx)
  return state
}
const recordOf = (id: string, tabs: number, kind: WindowRecord['kind'] = 'window'): { record: WindowRecord; win: FakeWindow } => {
  const win = new FakeWindow()
  const state = stateWithTabs(tabs)
  return { win, record: { id, kind, win, browser: undefined, store: { get: () => state } } as unknown as WindowRecord }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('CloseGuard', () => {
  let windows = 2
  let quitting = false
  let stopped = 0
  const asked: string[] = []
  let answer: CloseAnswer | 'reject' = { close: false, stopAsking: false }
  const ask: CloseAsker = async (_win, warning) => {
    asked.push(warning.message)
    if (answer === 'reject') throw new Error('no sheet')
    return answer
  }
  const guard = () => new CloseGuard({ windowCount: () => windows, quitting: () => quitting, stopAsking: () => void stopped++ }, ask)

  beforeEach(() => {
    windows = 2
    quitting = false
    stopped = 0
    asked.length = 0
    answer = { close: false, stopAsking: false }
  })
  afterEach(() => vi.restoreAllMocks())

  it('puts no listener on any window until the setting is on, and takes them off when it goes off', () => {
    const g = guard()
    const a = recordOf('a', 3)
    g.watch(a.record)
    expect(g.listening()).toBe(0)
    expect(a.win.listenerCount('close')).toBe(0)
    g.sync(true)
    expect(g.listening()).toBe(1)
    expect(a.win.listenerCount('close')).toBe(1)
    // A window opened while it is on carries the listener too.
    const b = recordOf('b', 3)
    g.watch(b.record)
    expect(g.listening()).toBe(2)
    g.sync(false)
    expect(g.listening()).toBe(0)
    expect([a.win.listenerCount('close'), b.win.listenerCount('close')]).toEqual([0, 0])
    // Off, a window of several tabs closes without a word.
    a.win.close()
    expect(a.win.destroyed).toBe(true)
    expect(asked).toEqual([])
  })

  it('does not stack the listener on a window it is told about twice, or when the setting is switched on twice', () => {
    const g = guard()
    const a = recordOf('a', 3)
    g.sync(true)
    g.sync(true)
    g.watch(a.record)
    g.watch(a.record)
    expect(a.win.listenerCount('close')).toBe(1)
    expect(g.listening()).toBe(1)
  })

  it('asks before closing a window of several tabs and keeps it open on a no, closes it on a yes', async () => {
    const g = guard()
    const a = recordOf('a', 3)
    g.watch(a.record)
    g.sync(true)
    a.win.close()
    await flush()
    expect(asked).toEqual([frenchSpaces('Fermer cette fenêtre ?')])
    expect(a.win.destroyed).toBe(false)
    answer = { close: true, stopAsking: false }
    a.win.close()
    await flush()
    expect(asked).toHaveLength(2)
    expect(a.win.destroyed).toBe(true)
    expect(stopped).toBe(0)
  })

  it('does not ask for the last window, while the application quits, or for a window with one tab', async () => {
    const g = guard()
    const a = recordOf('a', 3)
    const lone = recordOf('lone', 1)
    g.watch(a.record)
    g.watch(lone.record)
    g.sync(true)
    windows = 1
    a.win.close()
    await flush()
    expect(a.win.destroyed).toBe(true)
    windows = 3
    quitting = true
    const b = recordOf('b', 3)
    g.watch(b.record)
    b.win.close()
    await flush()
    expect(b.win.destroyed).toBe(true)
    quitting = false
    lone.win.close()
    await flush()
    expect(lone.win.destroyed).toBe(true)
    expect(asked).toEqual([])
  })

  it('asks nothing while « Installer et relancer » closes the windows: before-quit-for-update marks the quit first (quit-flow.ts)', async () => {
    const g = guard()
    const a = recordOf('a', 3)
    g.watch(a.record)
    g.sync(true)
    windows = 3
    const flushed: string[] = []
    prepareQuitForUpdate({
      store: { flush: () => flushed.push('store') } as never,
      history: { flush: () => flushed.push('history') },
      engine: { flushDownloadResume: () => flushed.push('downloads'), flushStrictTransport: () => flushed.push('strict hosts') },
      windowManager: { markQuitting: () => (quitting = true) } as never,
      confirm: () => flushed.push('confirm')
    })
    a.win.close()
    await flush()
    expect(a.win.destroyed).toBe(true)
    expect(asked).toEqual([])
    expect(flushed).toEqual(['confirm', 'store', 'history', 'downloads', 'strict hosts'])
  })

  it('does not stack a second question while the first one is open', async () => {
    let release: (answer: CloseAnswer) => void = () => undefined
    const slow: CloseAsker = (_win, warning) => {
      asked.push(warning.message)
      return new Promise((resolve) => (release = resolve))
    }
    const g = new CloseGuard({ windowCount: () => windows, quitting: () => false, stopAsking: () => undefined }, slow)
    const a = recordOf('a', 3)
    g.watch(a.record)
    g.sync(true)
    a.win.close()
    a.win.close()
    await flush()
    expect(asked).toHaveLength(1)
    release({ close: false, stopAsking: false })
    await flush()
    a.win.close()
    await flush()
    expect(asked).toHaveLength(2)
  })

  it('keeps the window open and logs which window and why when the question cannot be asked', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const g = guard()
    const a = recordOf('window-7', 3)
    g.watch(a.record)
    g.sync(true)
    answer = 'reject'
    a.win.close()
    await flush()
    expect(a.win.destroyed).toBe(false)
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]![0])).toContain('[close-guard]')
    expect(String(error.mock.calls[0]![0])).toContain('window-7')
    expect(String((error.mock.calls[0]![1] as Error).message)).toBe('no sheet')
    // The question can be asked again afterwards.
    answer = { close: true, stopAsking: false }
    a.win.close()
    await flush()
    expect(a.win.destroyed).toBe(true)
  })

  it('switches the setting off when the answer says not to ask again, and only when the window is closed', async () => {
    const g = guard()
    const a = recordOf('a', 3)
    g.watch(a.record)
    g.sync(true)
    answer = { close: true, stopAsking: true }
    a.win.close()
    await flush()
    expect(stopped).toBe(1)
    expect(a.win.destroyed).toBe(true)
  })

  it('forgets a window that closed: nothing is held for it', () => {
    const g = guard()
    const a = recordOf('a', 3)
    g.watch(a.record)
    g.sync(true)
    g.unwatch(a.record)
    expect(g.listening()).toBe(0)
    expect(a.win.listenerCount('close')).toBe(0)
  })

  it('tells a private window that its tabs go with it', async () => {
    const g = guard()
    const p = recordOf('private-1', 2, 'private')
    g.watch(p.record)
    g.sync(true)
    p.win.close()
    await flush()
    expect(asked).toEqual([frenchSpaces('Fermer cette fenêtre privée ?')])
  })
})

describe('askWithSheet', () => {
  const win = {} as never
  const warning = { message: 'Fermer ?', detail: 'Détail.' }

  it('shows a sheet with Cancel as the default button and a box to stop asking, and reads the answer', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: true })
    await expect(askWithSheet(win, warning)).resolves.toEqual({ close: true, stopAsking: true })
    const options = showMessageBox.mock.calls.at(-1)![1] as { buttons: string[]; defaultId: number; cancelId: number; checkboxChecked: boolean }
    expect(options.buttons).toEqual(['Fermer', 'Annuler'])
    expect([options.defaultId, options.cancelId, options.checkboxChecked]).toEqual([1, 1, false])
  })

  it('reads "Cancel" in English, not the "Undo" of the Edit menu', async () => {
    setLanguage('en')
    try {
      showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      await askWithSheet(win, warning)
      expect((showMessageBox.mock.calls.at(-1)![1] as { buttons: string[] }).buttons).toEqual(['Close', 'Cancel'])
    } finally {
      setLanguage('fr')
    }
  })

  it('never stops asking on a Cancel, even with the box ticked', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: true })
    await expect(askWithSheet(win, warning)).resolves.toEqual({ close: false, stopAsking: false })
  })

  it('closes without stopping the questions when the box is not ticked', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    await expect(askWithSheet(win, warning)).resolves.toEqual({ close: true, stopAsking: false })
  })
})
