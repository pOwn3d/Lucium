// What the Dock click does to the real windows: the pure plan is tested in macos-window-lifecycle.test.ts, this checks that followDockClicks reads
// Electron, runs the plan in its order, and touches nothing it must not (a destroyed window, the Settings window, the mini window).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const handlers: Record<string, () => void> = {}
vi.mock('electron', () => new Proxy({ app: { on: (event: string, run: () => void) => void (handlers[event] = run) } }, { get: (target, prop: string) => (prop in target ? (target as Record<string, unknown>)[prop] : {}) }))
const { followDockClicks } = await import('./windows-wiring')

interface FakeOptions {
  id: string
  kind?: 'main' | 'window' | 'private'
  visible?: boolean
  minimized?: boolean
  destroyed?: boolean
}

function fakeWindow(log: string[], { id, kind = 'window', visible = true, minimized = false, destroyed = false }: FakeOptions) {
  let isMin = minimized
  let isVisible = visible
  const win = {
    isDestroyed: () => destroyed,
    isVisible: () => isVisible,
    isMinimized: () => isMin,
    restore: () => { isMin = false; log.push(`restore:${id}`) },
    show: () => { isVisible = true; log.push(`show:${id}`) },
    focus: () => void log.push(`focus:${id}`)
  }
  return { id, kind, win }
}

function click(records: ReturnType<typeof fakeWindow>[], lastUsed: string, log: string[], away = false) {
  const manager = {
    list: () => records,
    focused: () => records.find((r) => r.id === lastUsed) ?? records[0]!,
    isMainAway: () => away,
    revealMain: () => void log.push('revealMain'),
    newWindow: () => void log.push('newWindow')
  }
  followDockClicks(manager as never)
  handlers['activate']!()
}

describe('followDockClicks', () => {
  // The Dock is a macOS matter (the plan is empty elsewhere): the test holds on whichever system runs it.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin' }))
  afterAll(() => Object.defineProperty(process, 'platform', platform))

  it('brings every window forward, the last used one last and focused', () => {
    const log: string[] = []
    click([fakeWindow(log, { id: 'main', kind: 'main' }), fakeWindow(log, { id: 'window-2' }), fakeWindow(log, { id: 'private-1', kind: 'private' })], 'window-2', log)
    expect(log).toEqual(['show:main', 'show:private-1', 'show:window-2', 'focus:window-2'])
  })

  it('restores a minimized window before showing it, and skips a destroyed one', () => {
    const log: string[] = []
    click([fakeWindow(log, { id: 'main', kind: 'main', minimized: true }), fakeWindow(log, { id: 'window-2', destroyed: true, visible: false })], 'main', log)
    expect(log).toEqual(['restore:main', 'show:main', 'focus:main'])
  })

  it('brings the main window put away back through the window manager, so that its pages come back', () => {
    const log: string[] = []
    click([fakeWindow(log, { id: 'main', kind: 'main', visible: false })], 'main', log, true)
    expect(log).toEqual(['revealMain'])
  })

  it('opens a window when every one is gone', () => {
    const log: string[] = []
    click([fakeWindow(log, { id: 'main', kind: 'main', destroyed: true, visible: false })], 'main', log)
    expect(log).toEqual(['newWindow'])
  })
})
