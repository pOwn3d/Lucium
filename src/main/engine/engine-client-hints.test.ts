// The Client Hints of the engine read from a page of the interface (engine-client-hints.ts): when, how often, how long a navigation waits for
// them at the launch, and what is left when the read fails.

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UA_DATA_SCRIPT, type ClientHintHeaders } from '@shared/client-hints'
import { EngineClientHints, HINTS_WAIT_MS } from './engine-client-hints'

const READ = { brands: [{ brand: 'Not:A-Brand', version: '8' }, { brand: 'Chromium', version: '156' }], mobile: false, platform: 'macOS' }
const MEASURED = { 'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="156"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"' }

/** A page of the interface whose script answers what each read is given, in turn. */
function fakeUi(answers: Array<() => Promise<unknown>>) {
  const ui = Object.assign(new EventEmitter(), {
    scripts: [] as string[],
    destroyed: false,
    isDestroyed: () => ui.destroyed,
    executeJavaScript: (code: string): Promise<unknown> => {
      ui.scripts.push(code)
      return (answers.shift() ?? (() => Promise.resolve(null)))()
    }
  })
  return ui
}

/** Lets the promises of a read settle (the timers of the wait may be fake). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function hints() {
  const lines: string[] = []
  return { lines, hints: new EngineClientHints((line) => lines.push(line)) }
}

/** What a navigation is given, and whether it has been given it yet. */
function navigationOf(engine: EngineClientHints) {
  const asked = engine.forNavigation()
  const seen: { done: boolean; hints: ClientHintHeaders | null } = { done: false, hints: null }
  if (asked instanceof Promise)
    void asked.then((given) => {
      seen.done = true
      seen.hints = given
    })
  else Object.assign(seen, { done: true, hints: asked })
  return { waits: asked instanceof Promise, seen }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the Client Hints of the engine', () => {
  it('are not known when no page of the interface was handed in: a navigation does not wait, nothing is guessed, and the log says so once', () => {
    const { lines, hints: engine } = hints()
    expect(engine.forNavigation()).toBeNull()
    expect(engine.forNavigation()).toBeNull()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('not known')
  })

  it('are read as soon as the page of the interface commits, and a navigation that started before waits for them and leaves with them', async () => {
    vi.useFakeTimers()
    const { lines, hints: engine } = hints()
    const ui = fakeUi([() => Promise.resolve(READ)])
    engine.learnFrom(ui)
    expect(ui.scripts).toEqual([])
    const early = navigationOf(engine)
    expect(early.waits).toBe(true)
    ui.emit('did-navigate')
    await settle()
    expect(ui.scripts).toEqual([UA_DATA_SCRIPT])
    expect(early.seen).toEqual({ done: true, hints: MEASURED })
    expect(engine.forNavigation()).toEqual(MEASURED)
    // Kept: the page is not asked again, and nothing waits any more.
    expect(ui.listenerCount('did-navigate') + ui.listenerCount('dom-ready')).toBe(0)
    ui.emit('dom-ready')
    expect(ui.scripts).toHaveLength(1)
    vi.advanceTimersByTime(HINTS_WAIT_MS)
    expect(lines).toEqual([])
  })

  it('are waited for a bounded time only: past it the navigations that waited leave without them, the log says so once, and later ones do not wait', async () => {
    vi.useFakeTimers()
    const { lines, hints: engine } = hints()
    const ui = fakeUi([])
    engine.learnFrom(ui)
    const early = navigationOf(engine)
    vi.advanceTimersByTime(HINTS_WAIT_MS - 1)
    await settle()
    expect(early.seen.done).toBe(false)
    vi.advanceTimersByTime(1)
    await settle()
    expect(early.seen).toEqual({ done: true, hints: null })
    expect(lines).toEqual([expect.stringContaining(`were not read within ${HINTS_WAIT_MS} ms`)])
    expect(navigationOf(engine)).toEqual({ waits: false, seen: { done: true, hints: null } })
    expect(lines).toHaveLength(1)
  })

  it('stay unknown when the page has no brands to give, say why in the log, and are read again at its next document', async () => {
    vi.useFakeTimers()
    const { lines, hints: engine } = hints()
    const ui = fakeUi([() => Promise.resolve(null), () => Promise.resolve({ ...READ, brands: [] }), () => Promise.resolve(READ)])
    engine.learnFrom(ui)
    ui.emit('did-navigate')
    await settle()
    expect(lines[0]).toContain('no usable navigator.userAgentData (null)')
    ui.emit('dom-ready')
    await settle()
    expect(lines[1]).toContain('"brands":[]')
    ui.emit('dom-ready')
    await settle()
    expect(engine.forNavigation()).toEqual(MEASURED)
  })

  it('stay unknown when the script fails, with the reason in the log, and nothing is read in a page that is gone', async () => {
    vi.useFakeTimers()
    const { lines, hints: engine } = hints()
    const ui = fakeUi([() => Promise.reject(new Error('Script failed to execute'))])
    engine.learnFrom(ui)
    ui.emit('did-navigate')
    await settle()
    expect(lines).toEqual([expect.stringContaining('cannot read navigator.userAgentData in the interface (Script failed to execute)')])
    ui.destroyed = true
    ui.emit('dom-ready')
    expect(ui.scripts).toHaveLength(1)
  })
})
