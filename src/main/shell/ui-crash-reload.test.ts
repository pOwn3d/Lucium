// The page of the interface is loaded again when its renderer dies, never when it ends cleanly, never once its web contents is gone, and not for ever.

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { UI_RELOADS_MAX, UI_RELOAD_WINDOW_MS, reloadUiAfterCrash, type CrashReloadDeps } from './ui-crash-reload'

class FakeContents extends EventEmitter {
  destroyed = false
  reloads = 0
  isDestroyed(): boolean {
    return this.destroyed
  }
  reload(): void {
    this.reloads++
  }
  die(reason: string): void {
    this.emit('render-process-gone', {}, { reason })
  }
}

function setup(): { contents: FakeContents; deps: CrashReloadDeps; clock: { now: number }; pending: Array<() => void>; lines: string[]; flush: () => void } {
  const contents = new FakeContents()
  const clock = { now: 1_000_000 }
  const pending: Array<() => void> = []
  const lines: string[] = []
  const deps: CrashReloadDeps = { now: () => clock.now, later: (run) => void pending.push(run), log: (line) => void lines.push(line) }
  const flush = (): void => {
    for (const run of pending.splice(0)) run()
  }
  return { contents, deps, clock, pending, lines, flush }
}

describe('reloadUiAfterCrash', () => {
  it('loads the page again when its renderer crashes, after the event has returned, and says so', () => {
    const { contents, deps, lines, flush } = setup()
    reloadUiAfterCrash(contents, 'index', deps)
    contents.die('crashed')
    expect(contents.reloads).toBe(0)
    flush()
    expect(contents.reloads).toBe(1)
    expect(lines).toEqual(['[ui] the index page ended (crashed): loading it again'])
  })

  it('reloads after any end that is not clean: killed, out of memory, abnormal exit', () => {
    const { contents, deps, flush } = setup()
    reloadUiAfterCrash(contents, 'overlay', deps)
    for (const reason of ['killed', 'oom', 'abnormal-exit']) contents.die(reason)
    flush()
    expect(contents.reloads).toBe(3)
  })

  it('does nothing when the renderer ended cleanly (the surface closing, the application quitting)', () => {
    const { contents, deps, lines, flush } = setup()
    reloadUiAfterCrash(contents, 'settings', deps)
    contents.die('clean-exit')
    flush()
    expect(contents.reloads).toBe(0)
    expect(lines).toEqual([])
  })

  it('does not touch a web contents destroyed before the reload runs', () => {
    const { contents, deps, flush } = setup()
    reloadUiAfterCrash(contents, 'index', deps)
    contents.die('crashed')
    contents.destroyed = true
    flush()
    expect(contents.reloads).toBe(0)
  })

  it(`stops after ${UI_RELOADS_MAX} reloads within a minute, and says why`, () => {
    const { contents, deps, clock, lines, flush } = setup()
    reloadUiAfterCrash(contents, 'index', deps)
    for (let i = 0; i < UI_RELOADS_MAX + 2; i++) {
      contents.die('crashed')
      clock.now += 1000
    }
    flush()
    expect(contents.reloads).toBe(UI_RELOADS_MAX)
    expect(lines.at(-1)).toContain('left as it is until Lucium restarts')
  })

  it('reloads again once the earlier deaths are more than a minute old', () => {
    const { contents, deps, clock, flush } = setup()
    reloadUiAfterCrash(contents, 'index', deps)
    for (let i = 0; i < UI_RELOADS_MAX; i++) contents.die('crashed')
    clock.now += UI_RELOAD_WINDOW_MS
    contents.die('crashed')
    flush()
    expect(contents.reloads).toBe(UI_RELOADS_MAX + 1)
  })

  it('listens once per web contents: loading the surface again does not double the reloads', () => {
    const { contents, deps, flush } = setup()
    reloadUiAfterCrash(contents, 'index', deps)
    reloadUiAfterCrash(contents, 'index', deps)
    contents.die('crashed')
    flush()
    expect(contents.reloads).toBe(1)
    expect(contents.listenerCount('render-process-gone')).toBe(1)
  })

  it('tells the user once when it stops loading the page again, and once more only after the page lived again', () => {
    const { contents, deps, clock, flush } = setup()
    const told: string[] = []
    reloadUiAfterCrash(contents, 'index', { ...deps, giveUp: (page) => void told.push(page) })
    for (let i = 0; i < UI_RELOADS_MAX; i++) contents.die('crashed')
    expect(told).toEqual([])
    contents.die('crashed')
    contents.die('oom')
    expect(told).toEqual(['index'])
    // A minute later the page is loaded again; when it then dies for good a second time, that is said too.
    clock.now += UI_RELOAD_WINDOW_MS
    for (let i = 0; i < UI_RELOADS_MAX + 1; i++) contents.die('crashed')
    flush()
    expect(told).toEqual(['index', 'index'])
  })
})
