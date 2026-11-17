import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import { EMPTY_SESSION, SHRINK_GRACE_MS, sessionWindowCount, type SavedSession } from '@shared/window-session'
import { replaceFileDurably } from '../durable-write'
import { takePersistenceNotices } from '../persistence-notices'
import { FeatureGates } from './feature-gate'
import { SessionWriter, gateWindowMemory, readSession, writeSession } from './session'
import { tempDir } from '../temp-dir'

// The real file, with the write that can fail on a real disk wrapped so that a test can make it fail.
vi.mock('../durable-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../durable-write')>()
  return { ...actual, replaceFileDurably: vi.fn(actual.replaceFileDurably) }
})
const realWrite = (await vi.importActual<typeof import('../durable-write')>('../durable-write')).replaceFileDurably

const state = createInitialState({ now: 1, newId: () => 'x' })
const screen = { x: 0, y: 0, width: 1920, height: 1080 }
const dir = () => tempDir('lucium-session-')
afterEach(() => vi.restoreAllMocks())

describe('the session file', () => {
  it('gives back what was written, windows fitted to the screens', () => {
    const path = join(dir(), 'windows.json')
    writeSession(path, { main: { x: 5, y: 6, width: 1000, height: 700 }, windows: [{ bounds: { x: 40, y: 50, width: 900, height: 600 }, spaceId: state.activeSpaceId, tabs: {}, sidebarVisible: false }] })
    const read = readSession(path, [screen], state)
    expect(read.main).toEqual({ x: 5, y: 6, width: 1000, height: 700 })
    expect(read.windows).toHaveLength(1)
    expect(read.windows[0]!.sidebarVisible).toBe(false)
  })

  it('reads a file saved with a byte-order mark as the session it holds', () => {
    const path = join(dir(), 'windows.json')
    writeFileSync(path, `\uFEFF${JSON.stringify({ main: { x: 5, y: 6, width: 1000, height: 700 }, windows: [] })}`)
    expect(readSession(path, [screen], state).main).toEqual({ x: 5, y: 6, width: 1000, height: 700 })
  })

  it('opens the windows as usual when there is no file, and says so when the file is damaged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const folder = dir()
    expect(readSession(join(folder, 'absent.json'), [screen], state)).toEqual({ main: null, windows: [] })
    expect(warn).not.toHaveBeenCalled()
    const damaged = join(folder, 'windows.json')
    writeFileSync(damaged, '{"main": ')
    expect(readSession(damaged, [screen], state)).toEqual({ main: null, windows: [] })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable'), expect.any(String))
  })

  it('writes the file whole or not at all (a crash mid-write leaves the previous one)', () => {
    const path = join(dir(), 'windows.json')
    writeSession(path, { main: null, windows: [] })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ main: null, windows: [] })
  })
})

// ---- the end of the application: the windows that close on the way out must not become the session ----

const rect = { x: 10, y: 10, width: 900, height: 600 }

/**
 * The window manager as the memory of the windows sees it: the first window, the others (a private, guest or mini window is not in the list it gives,
 * as in WindowManager.sessionSnapshot), the `closed` of a window, and the quit being decided.
 */
function fakeWindows(others: string[]) {
  const listeners = new Set<() => void>()
  const notify = (): void => listeners.forEach((listener) => listener())
  const manager = {
    main: true,
    others: [...others],
    quitting: false,
    sessionSnapshot: (): SavedSession =>
      manager.main
        ? { main: rect, windows: manager.others.map((id, i) => ({ bounds: { ...rect, x: 40 * (i + 1) }, spaceId: id, tabs: {}, sidebarVisible: true })) }
        : { main: null, windows: [] },
    isQuitting: () => manager.quitting,
    onChange: (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener)),
    /** A window that is not saved (private, guest, mini window): the listeners hear of it, the list does not change. */
    openUnsaved: notify,
    open(id: string) {
      manager.others.push(id)
      notify()
    },
    /** `closed` of a window: the manager forgets it and tells the listeners. */
    close(id: string) {
      manager.others = manager.others.filter((other) => other !== id)
      notify()
    },
    markQuitting() {
      manager.quitting = true
    }
  }
  return manager
}

/** The memory of the windows wired as index.ts wires it, with `alreadySaved` windows in the file at launch (0: no file). */
function memory(opened: string[], alreadySaved = 0) {
  const path = join(dir(), 'windows.json')
  const windows = fakeWindows(opened)
  if (alreadySaved > 0) writeSession(path, { main: rect, windows: Array.from({ length: alreadySaved - 1 }, (_, i) => ({ bounds: rect, spaceId: `old${i}`, tabs: {}, sidebarVisible: true })) })
  const win = new EventEmitter()
  const app = new EventEmitter()
  const writer = new SessionWriter(path, windows as never, alreadySaved > 0 ? alreadySaved : null)
  const state = createInitialState({ now: 1, newId: () => 'x' })
  const gates = new FeatureGates({ get: () => state, subscribe: () => () => undefined })
  gateWindowMemory(gates, { win: win as never, app: app as never, windows: windows as never, writer })
  // Nothing is saved at launch itself: the windows opening and the first window being placed are what asks for the first save.
  if (alreadySaved === 0) win.emit('move')
  const file = (): { main: unknown; windows: Array<{ spaceId: string }> } => JSON.parse(readFileSync(path, 'utf8'))
  /** What index.ts does on a quit that goes ahead: the memory's own `before-quit` listener is first, then the one that decides the quit. */
  const quit = (): void => {
    app.emit('before-quit')
    windows.markQuitting()
  }
  return { path, windows, win, app, gates, file, quit, writes: () => vi.mocked(replaceFileDurably).mock.calls.length }
}

describe('the session file is read with a bound', () => {
  it('is not read when it is larger than the small files the application reads', () => {
    const path = join(tempDir('lucium-session-'), 'windows.json')
    writeFileSync(path, ' '.repeat(1024 * 1024 + 1))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(readSession(path, [], state)).toEqual(EMPTY_SESSION)
    // The bound is what refuses it: the text is never parsed, so the refusal names the size rather than a JSON error.
    expect(String(warn.mock.calls[0]?.[1] ?? '')).toMatch(/more than the 1048576 this application reads/)
  })
})

describe('the windows kept through the end of the application', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(replaceFileDurably).mockReset()
    vi.mocked(replaceFileDurably).mockImplementation(realWrite)
    takePersistenceNotices()
  })
  afterEach(() => vi.useRealTimers())

  it('keeps the 3 windows when the application is quit and the others are gone before the first one closes', () => {
    const t = memory(['b', 'c'])
    vi.advanceTimersByTime(600)
    expect(t.file().windows).toHaveLength(2)
    t.quit()
    // What a slow close does on a real ⌘Q (Electron 45 closes the windows last-opened first, the first one last): the `closed` of the others comes before the `close` of the first.
    t.windows.close('c')
    t.windows.close('b')
    t.win.emit('close')
    vi.advanceTimersByTime(60_000)
    expect(t.file().windows.map((w) => w.spaceId)).toEqual(['b', 'c'])
    t.gates.disposeAll()
  })

  it('keeps them too when closing takes long (a page that asks "Leave the page?" in each window) and the grace would have gone by', () => {
    const t = memory(['b', 'c'])
    vi.advanceTimersByTime(600)
    t.quit()
    t.windows.close('c')
    vi.advanceTimersByTime(SHRINK_GRACE_MS * 3)
    t.windows.close('b')
    vi.advanceTimersByTime(SHRINK_GRACE_MS * 3)
    t.win.emit('close')
    vi.advanceTimersByTime(SHRINK_GRACE_MS * 3)
    expect(t.file().windows).toHaveLength(2)
    t.gates.disposeAll()
  })

  it('keeps the 3 windows when they are closed one by one, then the first one (the last window ends the application)', () => {
    const t = memory(['b', 'c'])
    vi.advanceTimersByTime(600)
    t.windows.close('c')
    vi.advanceTimersByTime(1500)
    t.windows.close('b')
    vi.advanceTimersByTime(1500)
    // The red button of the first window: its `close` is the last chance to save, then the application quits.
    t.win.emit('close')
    t.quit()
    vi.advanceTimersByTime(60_000)
    expect(t.file().windows).toHaveLength(2)
    t.gates.disposeAll()
  })

  it('keeps them when the windows are closed one by one and the quit follows', () => {
    const t = memory(['b', 'c'])
    vi.advanceTimersByTime(600)
    t.windows.close('c')
    vi.advanceTimersByTime(1500)
    t.windows.close('b')
    vi.advanceTimersByTime(1500)
    t.quit()
    t.win.emit('close')
    vi.advanceTimersByTime(60_000)
    expect(t.file().windows).toHaveLength(2)
    t.gates.disposeAll()
  })

  it('takes a closed window out of the file once the user kept working without it, and keeps that list through a later quit', () => {
    const t = memory(['b', 'c'])
    vi.advanceTimersByTime(600)
    t.windows.close('c')
    vi.advanceTimersByTime(SHRINK_GRACE_MS - 1000)
    expect(t.file().windows).toHaveLength(2)
    // Moving the first window meanwhile asks for a save, which still leaves the file as it is.
    t.win.emit('move')
    vi.advanceTimersByTime(900)
    expect(t.file().windows).toHaveLength(2)
    vi.advanceTimersByTime(SHRINK_GRACE_MS)
    expect(t.file().windows.map((w) => w.spaceId)).toEqual(['b'])
    t.quit()
    t.windows.close('b')
    t.win.emit('close')
    vi.advanceTimersByTime(60_000)
    expect(t.file().windows.map((w) => w.spaceId)).toEqual(['b'])
    t.gates.disposeAll()
  })

  it('saves a window opened after a closing at once, and the new list stays the one to keep', () => {
    const t = memory(['b', 'c'])
    vi.advanceTimersByTime(600)
    t.windows.close('c')
    vi.advanceTimersByTime(1000)
    t.windows.open('d')
    vi.advanceTimersByTime(600)
    expect(t.file().windows.map((w) => w.spaceId)).toEqual(['b', 'd'])
    t.gates.disposeAll()
  })

  it('still has the 3 windows of the file when the application is quit right after a launch whose windows are not all back', () => {
    const t = memory([], 3)
    // Only the first window exists yet; the restored ones are opened a moment later.
    t.win.emit('resize')
    vi.advanceTimersByTime(600)
    t.quit()
    t.win.emit('close')
    vi.advanceTimersByTime(60_000)
    expect(t.file().windows).toHaveLength(2)
    expect(sessionWindowCount(readSession(t.path, [{ x: 0, y: 0, width: 4000, height: 3000 }], createInitialState({ now: 1, newId: () => 'x' })))).toBe(3)
    t.gates.disposeAll()
  })

  it('does not write for a window that is not in the session (private, guest, mini window), and does not touch the file at all', () => {
    const t = memory(['b'])
    vi.advanceTimersByTime(600)
    const before = t.writes()
    expect(before).toBe(1)
    t.windows.openUnsaved()
    vi.advanceTimersByTime(600)
    t.windows.openUnsaved()
    vi.advanceTimersByTime(600)
    expect(t.writes()).toBe(before)
    expect(t.file().windows).toHaveLength(1)
    t.gates.disposeAll()
  })

  it('writes nothing once the quit is decided, whatever asks for it', () => {
    const t = memory(['b'])
    vi.advanceTimersByTime(600)
    t.quit()
    const before = t.writes()
    t.win.emit('move')
    t.windows.open('c')
    t.windows.close('b')
    t.win.emit('close')
    t.app.emit('before-quit')
    vi.advanceTimersByTime(60_000)
    expect(t.writes()).toBe(before)
    t.gates.disposeAll()
  })

  it('writes the last positions at the quit when no window went away', () => {
    const t = memory(['b'])
    vi.advanceTimersByTime(600)
    t.windows.others = ['b', 'c']
    t.quit()
    expect(t.file().windows).toHaveLength(2)
    t.gates.disposeAll()
  })

  it('says so once when the file cannot be written, tries again, and is silent again when it works', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(replaceFileDurably).mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    })
    const t = memory(['b'])
    vi.advanceTimersByTime(600)
    expect(existsSync(t.path)).toBe(false)
    expect(takePersistenceNotices()).toEqual([{ kind: 'save-failed', file: 'windows.json', reason: expect.stringContaining('ENOSPC') }])
    expect(error).toHaveBeenCalledTimes(1)
    // Still failing at the next try: no second dialog.
    vi.advanceTimersByTime(31_000)
    expect(takePersistenceNotices()).toEqual([])
    vi.mocked(replaceFileDurably).mockImplementation(realWrite)
    vi.advanceTimersByTime(31_000)
    expect(t.file().windows).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('can be written again'))
    t.gates.disposeAll()
  })
})
