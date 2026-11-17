import * as nodeFs from 'node:fs'
import { closeSync, copyFileSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectionOf } from '@shared/window-selection'
import { HistoryStore } from './history'
import { backUpBeforeRestore, sideFiles } from './persist'
import { onPersistenceNotice, takePersistenceNotices, type PersistenceNotice } from './persistence-notices'
import { StateStore, WindowView, loadState } from './store'
import { tempDir } from './temp-dir'

// The real file system, with the calls that can fail on a real disk (full, read-only, no permission) wrapped so a test can make them fail.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), openSync: vi.fn(actual.openSync), writeSync: vi.fn(actual.writeSync), closeSync: vi.fn(actual.closeSync), renameSync: vi.fn(actual.renameSync), copyFileSync: vi.fn(actual.copyFileSync) }
})
const real = await vi.importActual<typeof nodeFs>('node:fs')

const dir = () => tempDir('lucium-failures-')
const diskFull = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
const denied = () => Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' })
let logged: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  takePersistenceNotices()
  vi.mocked(writeFileSync).mockImplementation(real.writeFileSync)
  vi.mocked(openSync).mockImplementation(real.openSync)
  vi.mocked(writeSync).mockImplementation(real.writeSync)
  vi.mocked(closeSync).mockImplementation(real.closeSync)
  vi.mocked(renameSync).mockImplementation(real.renameSync)
  vi.mocked(copyFileSync).mockImplementation(real.copyFileSync)
  logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Makes writing to files whose path ends with `suffix` fail with `error` until `stop` is called (the file opens, then the write fails, as on a full disk). */
const failWrites = (suffix: string, error: () => Error) => {
  let failing = true
  const doomed = new Set<number>()
  vi.mocked(openSync).mockImplementation(((file: nodeFs.PathLike, ...rest: unknown[]) => {
    const fd = (real.openSync as (...args: unknown[]) => number)(file, ...rest)
    if (String(file).endsWith(suffix)) doomed.add(fd)
    return fd
  }) as typeof openSync)
  vi.mocked(closeSync).mockImplementation(((fd: number) => {
    doomed.delete(fd)
    return real.closeSync(fd)
  }) as typeof closeSync)
  vi.mocked(writeSync).mockImplementation(((fd: number, ...rest: unknown[]) => {
    if (failing && doomed.has(fd)) throw error()
    return (real.writeSync as (...args: unknown[]) => number)(fd, ...rest)
  }) as typeof writeSync)
  return () => {
    failing = false
  }
}

describe('a state that cannot be written', () => {
  it('does not throw, answers false, keeps the state in memory and tells the user once', () => {
    const path = join(dir(), 'state.json')
    const store = new StateStore(loadState(path), path)
    store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    failWrites('state.json.tmp', diskFull)

    expect(() => store.flush()).not.toThrow()
    expect(store.flush()).toBe(false)
    expect(store.get().tabs.map((t) => t.url)).toEqual(['https://a.fr/'])
    expect(takePersistenceNotices()).toMatchObject([{ kind: 'save-failed', file: 'state.json', reason: expect.stringContaining('ENOSPC') }])
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('cannot write'), expect.anything())
  })

  it('tries again by itself, and the state of that moment is the one written', () => {
    const path = join(dir(), 'state.json')
    // The timed writes made synchronously, so that the mocked synchronous calls are the ones they go through (store-async-writes.test.ts: the others).
    const store = new StateStore(loadState(path), path, undefined, { asyncWrites: false })
    store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    const stop = failWrites('state.json.tmp', diskFull)
    store.flush()
    store.dispatch({ type: 'tab/open', url: 'https://b.fr/' })
    vi.advanceTimersByTime(400)
    expect(() => readFileSync(path, 'utf8')).toThrow()
    stop()
    vi.advanceTimersByTime(5000)
    expect(loadState(path).tabs.map((t) => t.url).sort()).toEqual(['https://a.fr/', 'https://b.fr/'])
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('can be written again'))
  })

  it('retries after a delay even when nothing changes any more (the timer is not left to a later change)', () => {
    const path = join(dir(), 'state.json')
    const store = new StateStore(loadState(path), path)
    const stop = failWrites('state.json.tmp', diskFull)
    expect(store.flush()).toBe(false)
    stop()
    vi.advanceTimersByTime(5000)
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBeDefined()
  })

  it('says it once per breakdown, not at each retry, and again when it breaks anew', () => {
    const path = join(dir(), 'state.json')
    const store = new StateStore(loadState(path), path)
    let stop = failWrites('state.json.tmp', diskFull)
    store.flush()
    vi.advanceTimersByTime(5000 * 4)
    expect(takePersistenceNotices()).toHaveLength(1)
    stop()
    vi.advanceTimersByTime(5000)
    stop = failWrites('state.json.tmp', denied)
    store.flush()
    expect(takePersistenceNotices()).toMatchObject([{ kind: 'save-failed', reason: expect.stringContaining('EACCES') }])
  })

  it('fails the rename as well as the write: the file in place is left as it was', () => {
    const path = join(dir(), 'state.json')
    const store = new StateStore(loadState(path), path)
    expect(store.flush()).toBe(true)
    const before = readFileSync(path, 'utf8')
    store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    vi.mocked(renameSync).mockImplementation(() => {
      throw denied()
    })
    expect(store.flush()).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(before)
    // Nor is a complete copy of the state left beside it under another name.
    expect(real.existsSync(`${path}.tmp`)).toBe(false)
  })

  it('leaves no temporary file behind a write that stopped short', () => {
    const path = join(dir(), 'state.json')
    const store = new StateStore(loadState(path), path)
    store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    failWrites('state.json.tmp', diskFull)
    expect(store.flush()).toBe(false)
    expect(real.existsSync(`${path}.tmp`)).toBe(false)
    expect(real.existsSync(path)).toBe(false)
  })

  it('does not stop the next flush: the history is written even when the state could not be, as at quit', () => {
    const folder = dir()
    const store = new StateStore(loadState(join(folder, 'state.json')), join(folder, 'state.json'))
    const history = new HistoryStore(join(folder, 'history.json'))
    history.record('https://a.fr/', 'A', 1)
    failWrites('state.json.tmp', diskFull)
    // What the before-quit handler does.
    expect(() => {
      store.flush()
      history.flush()
    }).not.toThrow()
    expect(JSON.parse(readFileSync(join(folder, 'history.json'), 'utf8'))).toHaveLength(1)
  })

  it('answers the same through a window view (it is what the application holds)', () => {
    const path = join(dir(), 'state.json')
    const shared = new StateStore(loadState(path), path)
    const view = new WindowView(shared, selectionOf(shared.get()), new Set(), true)
    failWrites('state.json.tmp', diskFull)
    expect(view.flush()).toBe(false)
  })

  it('is not told about a store that never writes (the private window)', () => {
    const store = new StateStore(loadState(join(dir(), 'none.json')), null)
    failWrites('.tmp', diskFull)
    expect(store.flush()).toBe(true)
    expect(takePersistenceNotices()).toEqual([])
  })
})

describe('a history that cannot be written', () => {
  it('keeps its pages, never throws, tells the user once and writes them when the disk answers again', () => {
    const path = join(dir(), 'history.json')
    const history = new HistoryStore(path)
    history.record('https://a.fr/', 'A', 1)
    const stop = failWrites('history.json.tmp', diskFull)
    expect(() => history.flush()).not.toThrow()
    vi.advanceTimersByTime(5000 * 3)
    expect(history.size()).toBe(1)
    expect(takePersistenceNotices()).toMatchObject([{ kind: 'save-failed', file: 'history.json' }])
    stop()
    vi.advanceTimersByTime(5000)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject([{ url: 'https://a.fr/' }])
  })

  it('does not throw from its own timer either', () => {
    const path = join(dir(), 'history.json')
    const history = new HistoryStore(path)
    failWrites('history.json.tmp', diskFull)
    history.record('https://a.fr/', 'A', 1)
    expect(() => vi.advanceTimersByTime(2100)).not.toThrow()
  })
})

describe('an unreadable file that cannot be moved aside either', () => {
  it('loadState does not throw: it starts fresh, says so, and leaves the file as it is', () => {
    const folder = dir()
    const path = join(folder, 'state.json')
    writeFileSync(path, '{ broken')
    vi.mocked(renameSync).mockImplementation(() => {
      throw denied()
    })

    const state = loadState(path)

    expect(state.spaces).toHaveLength(1)
    expect(readFileSync(path, 'utf8')).toBe('{ broken')
    expect(takePersistenceNotices()).toMatchObject([{ kind: 'kept-in-place', file: 'state.json', moveError: expect.stringContaining('EACCES') }])
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('could not be moved aside'))
  })

  it('writes nothing over it as long as it cannot be moved, keeps the state in memory, and moves it aside when it can', () => {
    const folder = dir()
    const path = join(folder, 'state.json')
    writeFileSync(path, '{ broken')
    let stuck = true
    vi.mocked(renameSync).mockImplementation(((from: string, to: string) => {
      if (stuck && String(from) === path) throw denied()
      return real.renameSync(from, to)
    }) as typeof renameSync)
    const store = new StateStore(loadState(path), path)
    takePersistenceNotices()
    store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })

    expect(store.flush()).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(readFileSync(path, 'utf8')).toBe('{ broken')
    expect(store.get().tabs).toHaveLength(1)
    // The user was told at start-up that the file could not be moved: the failed save does not say it a second time.
    expect(takePersistenceNotices()).toEqual([])
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('cannot write'), expect.objectContaining({ message: expect.stringContaining('still cannot be moved aside') }))

    stuck = false
    vi.advanceTimersByTime(5000)
    expect(loadState(path).tabs.map((t) => t.url)).toEqual(['https://a.fr/'])
    expect(sideFiles(path, 'corrupt')).toHaveLength(1)
    expect(readFileSync(sideFiles(path, 'corrupt')[0]!, 'utf8')).toBe('{ broken')
  })

  it('goes on once the file has been removed by hand', () => {
    const folder = dir()
    const path = join(folder, 'state.json')
    writeFileSync(path, '{ broken')
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw denied()
    })
    const store = new StateStore(loadState(path), path)
    real.rmSync(path)
    expect(store.flush()).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBeDefined()
  })

  it('the history does not throw from its constructor, and does not overwrite the file either', () => {
    const path = join(dir(), 'history.json')
    writeFileSync(path, 'not json')
    vi.mocked(renameSync).mockImplementation(() => {
      throw denied()
    })
    const history = new HistoryStore(path)
    history.record('https://a.fr/', 'A', 1)
    expect(history.flush()).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('not json')
    expect(takePersistenceNotices().map((n) => n.kind)).toEqual(['kept-in-place'])
  })
})

describe('notices reach whoever listens, including those from before it listened', () => {
  it('replays what happened at start-up, then follows', () => {
    const path = join(dir(), 'state.json')
    writeFileSync(path, '{ broken')
    loadState(path)
    const heard: PersistenceNotice[] = []
    const stop = onPersistenceNotice((notice) => heard.push(notice))
    expect(heard.map((n) => n.kind)).toEqual(['set-aside'])
    const store = new StateStore(loadState(join(dir(), 'state.json')), join(dir(), 'x', 'state.json'))
    store.flush()
    expect(heard.map((n) => n.kind)).toEqual(['set-aside', 'save-failed'])
    stop()
  })
})

describe('the copy before a restoration', () => {
  it('fails with the reason when the copy fails, so that nothing is restored', () => {
    const path = join(dir(), 'state.json')
    writeFileSync(path, 'current')
    vi.mocked(copyFileSync).mockImplementation(() => {
      throw diskFull()
    })
    expect(backUpBeforeRestore(() => true, path)).toContain('ENOSPC')
    expect(sideFiles(path, 'avant-restauration')).toEqual([])
  })
})
