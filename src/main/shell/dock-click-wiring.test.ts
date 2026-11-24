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
  focused?: boolean
  onMoveTop?: () => void
}

function fakeWindow(log: string[], { id, kind = 'window', visible = true, minimized = false, destroyed = false, focused = false, onMoveTop }: FakeOptions) {
  let isMin = minimized
  let isVisible = visible
  const win = {
    isDestroyed: () => destroyed,
    isVisible: () => isVisible,
    isMinimized: () => isMin,
    restore: () => { isMin = false; log.push(`restore:${id}`) },
    show: () => { isVisible = true; log.push(`show:${id}`) },
    isFocused: () => focused,
    moveTop: () => { log.push(`moveTop:${id}`); onMoveTop?.() },
    focus: () => void log.push(`focus:${id}`)
  }
  return { id, kind, win }
}

function manager(records: ReturnType<typeof fakeWindow>[], lastUsed: string, log: string[], away = false, raiseAll?: () => boolean) {
  const fake = {
    list: () => records,
    focused: () => records.find((r) => r.id === lastUsed) ?? records[0]!,
    isMainAway: () => away,
    revealMain: () => void log.push('revealMain'),
    newWindow: () => void log.push('newWindow')
  }
  followDockClicks(fake as never, raiseAll)
}

function click(records: ReturnType<typeof fakeWindow>[], lastUsed: string, log: string[], away = false) {
  manager(records, lastUsed, log, away)
  handlers['activate']!()
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

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

  it('with the setting off (read at each click), brings the last used window only and moves nothing when switching to the application', () => {
    const log: string[] = []
    let on = false
    const records = [fakeWindow(log, { id: 'main', kind: 'main' }), fakeWindow(log, { id: 'window-2', minimized: true, focused: true })]
    manager(records, 'window-2', log, false, () => on)
    handlers['activate']!()
    expect(log).toEqual(['restore:window-2', 'show:window-2', 'focus:window-2'])
    log.length = 0
    handlers['did-become-active']!()
    expect(log).toEqual([])
    on = true
    return nextTurn().then(() => {
      handlers['activate']!()
      expect(log).toEqual(['show:main', 'show:window-2', 'focus:window-2'])
    })
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

  describe('switching to the application (did-become-active: ⌘⇥, a click in a window)', () => {
    const switchTo = (records: ReturnType<typeof fakeWindow>[], log: string[], away = false) => {
      manager(records, 'main', log, away)
      handlers['did-become-active']!()
    }

    it('raises every window on screen without taking the focus, the focused one last', () => {
      const log: string[] = []
      switchTo([fakeWindow(log, { id: 'main', kind: 'main' }), fakeWindow(log, { id: 'window-2', focused: true }), fakeWindow(log, { id: 'private-1', kind: 'private' })], log)
      expect(log).toEqual(['moveTop:main', 'moveTop:private-1', 'moveTop:window-2'])
    })

    it('does not restore a minimized window, show a hidden or put-away one, or touch a destroyed one', () => {
      const log: string[] = []
      switchTo([fakeWindow(log, { id: 'main', kind: 'main', visible: false }), fakeWindow(log, { id: 'window-2', minimized: true }), fakeWindow(log, { id: 'private-1', destroyed: true, visible: false }), fakeWindow(log, { id: 'guest-1', focused: true })], log, true)
      expect(log).toEqual(['moveTop:guest-1'])
    })

    it('does not start an activation again by raising its windows, and answers the next real one', async () => {
      const log: string[] = []
      const again = () => handlers['did-become-active']!()
      switchTo([fakeWindow(log, { id: 'main', kind: 'main', focused: true, onMoveTop: again }), fakeWindow(log, { id: 'window-2', onMoveTop: again })], log)
      expect(log).toEqual(['moveTop:window-2', 'moveTop:main'])
      // An echo that comes in the turn after is ignored too; then the guard is lifted.
      again()
      expect(log).toHaveLength(2)
      await nextTurn()
      again()
      expect(log).toHaveLength(2 + 2)
    })
  })
})
