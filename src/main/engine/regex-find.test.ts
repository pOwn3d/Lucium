import { Script } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REGEX_HIGHLIGHT_CSS } from '@shared/ipc'
import { REGEX_PATTERN_MAX, REGEX_TEXT_MAX } from '@shared/regex-find'
import { CLEAR_SCRIPT, MATCH_SOURCE, RegexFinder, RegexRunner, applyScript, collectScript, currentScript, readScan, type FinderHost, type FindReport, type RegexRunOutcome, type WorkerLike } from './regex-find'

// The scripts of the page side run in a page and are checked by the engine test (smoke-search2.ts); here, that they are valid programs, the
// matching itself (the very source the worker runs), the worker's lifecycle with real threads, and the finder around them with stand-ins.

type Matches = { matches: Array<[number, number, number]>; more: boolean } | { error: string }
const findMatches = new Function(`return (${MATCH_SOURCE})`)() as (chunks: string[], pattern: string, caseSensitive: boolean, limit: number) => Matches

afterEach(() => vi.restoreAllMocks())

describe('the scripts', () => {
  it('are valid programs', () => {
    for (const code of [collectScript(3), applyScript(3, [[0, 1, 2]]), applyScript(3, []), currentScript(3, 0), CLEAR_SCRIPT]) expect(() => new Script(code)).not.toThrow()
  })

  it('carry the search they belong to, so that a script of an older search finds nothing to act on', () => {
    expect(collectScript(7)).toContain('generation: 7')
    expect(applyScript(7, [])).toContain('st.generation !== 7')
    expect(currentScript(7, 2)).toContain('st.generation !== 7')
  })

  it('never put the expression in a script (the page does not get to see what is searched)', () => {
    const pattern = 'SECRET-PATTERN(a+)+'
    for (const code of [collectScript(1), applyScript(1, [[0, 0, 3]]), currentScript(1, 0), CLEAR_SCRIPT]) expect(code).not.toContain(pattern)
  })

  it('build nothing with markup and do not touch the DOM of the page', () => {
    for (const code of [collectScript(1), applyScript(1, [[0, 0, 3]]), currentScript(1, 0), CLEAR_SCRIPT]) {
      expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|appendChild|insertBefore|surroundContents/)
    }
  })

  it('paint with the highlight names the style sheet uses', () => {
    for (const name of ['lucium-find', 'lucium-find-current']) {
      expect(applyScript(1, [])).toContain(name)
      expect(REGEX_HIGHLIGHT_CSS).toContain(`::highlight(${name})`)
    }
  })
})

describe('findMatches (the source the worker runs)', () => {
  const ok = (r: Matches) => {
    if ('error' in r) throw new Error(r.error)
    return r
  }

  it('finds every match with its block, start and end', () => {
    expect(ok(findMatches(['one two one', 'none'], 'one', false, 10))).toEqual({ matches: [[0, 0, 3], [0, 8, 11], [1, 1, 4]], more: false })
    expect(ok(findMatches(['ab12cd345'], '\\d+', false, 10)).matches).toEqual([[0, 2, 4], [0, 6, 9]])
  })

  it('ignores the case unless asked not to', () => {
    expect(ok(findMatches(['Planète planète'], 'PLANÈTE', false, 10)).matches).toHaveLength(2)
    expect(ok(findMatches(['Planète planète'], 'Planète', true, 10)).matches).toEqual([[0, 0, 7]])
  })

  it('reads ^ and $ at the line starts and ends of a block', () => {
    expect(ok(findMatches(['a\nb\nc'], '^.$', false, 10)).matches).toEqual([[0, 0, 1], [0, 2, 3], [0, 4, 5]])
  })

  it('takes unicode escapes, and falls back to the plain mode for what only that mode allows', () => {
    expect(ok(findMatches(['été Ünï 12'], '\\p{L}+', false, 10)).matches).toEqual([[0, 0, 3], [0, 4, 7]])
    // "\-" is an error in unicode mode and a plain hyphen otherwise.
    expect(ok(findMatches(['a-b'], 'a\\-b', false, 10)).matches).toEqual([[0, 0, 3]])
  })

  it('says invalid for an expression that is wrong in both modes', () => {
    for (const pattern of ['(', '[a-', '*a', 'a{2,1}', '(?<n>a)(?<n>b)', '\\']) expect(findMatches(['abc'], pattern, false, 10), pattern).toEqual({ error: 'invalid' })
  })

  it('skips empty matches and still moves on, in either mode', () => {
    expect(ok(findMatches(['aab'], 'x*', false, 10)).matches).toEqual([])
    expect(ok(findMatches(['aab'], 'a*', false, 10)).matches).toEqual([[0, 0, 2]])
    expect(ok(findMatches(['a😀b'], '(?:)', false, 10)).matches).toEqual([])
    expect(ok(findMatches(['😀😀'], '😀|', false, 10)).matches).toEqual([[0, 0, 2], [0, 2, 4]])
  })

  it('stops at the limit and says there is more, without going over', () => {
    const r = ok(findMatches(['aaaaaaaaaa', 'aaaa'], 'a', false, 5))
    expect(r.matches).toHaveLength(5)
    expect(r.more).toBe(true)
    expect(ok(findMatches(['aaaaa'], 'a', false, 5))).toMatchObject({ more: false })
    expect(ok(findMatches(['aaaaa', 'a'], 'a', false, 5))).toMatchObject({ more: true })
  })
})

describe('RegexRunner (real worker threads)', () => {
  it('runs an expression on a copy of the text', async () => {
    const outcome = await new RegexRunner().run({ pattern: 'o+', caseSensitive: false, chunks: ['foo boo', 'xyz', 'OO'] })
    expect(outcome).toEqual({ ok: true, matches: [[0, 1, 3], [0, 5, 7], [2, 0, 2]], more: false })
  })

  it('answers invalid for an expression that does not compile', async () => {
    expect(await new RegexRunner().run({ pattern: '(', caseSensitive: false, chunks: ['a'] })).toEqual({ ok: false, error: 'invalid' })
  })

  it('stops at its limit and says there is more', async () => {
    const outcome = await new RegexRunner(5000, 3).run({ pattern: 'a', caseSensitive: false, chunks: ['aaaaaaa'] })
    expect(outcome).toMatchObject({ ok: true, more: true })
    expect(outcome.ok && outcome.matches).toHaveLength(3)
  })

  it('abandons an expression that never ends, says so in the log, and is ready for the next one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const started = Date.now()
    const outcome = await new RegexRunner(400).run({ pattern: '(a+)+b', caseSensitive: false, chunks: ['a'.repeat(60) + 'c'] })
    expect(outcome).toEqual({ ok: false, error: 'slow' })
    expect(Date.now() - started).toBeLessThan(3000)
    expect(warn).toHaveBeenCalledWith('[find] regular expression abandoned after 400 ms:', '(a+)+b')
    // Nothing is left running that would slow the next run down.
    const runner = new RegexRunner(400)
    expect(await runner.run({ pattern: 'b', caseSensitive: false, chunks: ['abc'] })).toMatchObject({ ok: true })
  })

  it('does not leave the event loop waiting: a catastrophic run ends with its worker gone', async () => {
    const terminated = vi.fn()
    const real = (await import('node:worker_threads')).Worker
    const spy = vi.fn(() => {
      const worker = new real(`const { parentPort } = require('node:worker_threads'); parentPort.on('message', () => { for (;;) {} })`, { eval: true })
      const terminate = worker.terminate.bind(worker)
      worker.terminate = () => {
        terminated()
        return terminate()
      }
      return worker as unknown as WorkerLike
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const outcome = await new RegexRunner(150, 10, spy).run({ pattern: 'a', caseSensitive: false, chunks: ['a'] })
    expect(outcome).toEqual({ ok: false, error: 'slow' })
    expect(terminated).toHaveBeenCalledTimes(1)
  })

  it('answers cancelled to a run that a newer one replaces, and the newer one is not affected', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runner = new RegexRunner(1500)
    const first = runner.run({ pattern: '(a+)+b', caseSensitive: false, chunks: ['a'.repeat(60) + 'c'] })
    const second = runner.run({ pattern: 'c', caseSensitive: false, chunks: ['abc'] })
    expect(await first).toEqual({ ok: false, error: 'cancelled' })
    expect(await second).toMatchObject({ ok: true, matches: [[0, 2, 3]] })
  })

  it('cancel() ends the run under way', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runner = new RegexRunner(1500)
    const run = runner.run({ pattern: '(a+)+b', caseSensitive: false, chunks: ['a'.repeat(60) + 'c'] })
    runner.cancel()
    expect(await run).toEqual({ ok: false, error: 'cancelled' })
  })
})

/** A worker that does what the test tells it, to force the failures a real one rarely has. */
function fakeWorker(script: (api: { message: (v: unknown) => void; error: (e: Error) => void; exit: (code: number) => void }) => void): { make: () => WorkerLike; terminated: ReturnType<typeof vi.fn> } {
  const terminated = vi.fn()
  return {
    terminated,
    make: () => {
      const handlers: Record<string, (v: never) => void> = {}
      const worker: WorkerLike = {
        postMessage: () => script({ message: (v) => handlers['message']?.(v as never), error: (e) => handlers['error']?.(e as never), exit: (c) => handlers['exit']?.(c as never) }),
        on: (event: string, listener: (v: never) => void) => void (handlers[event] = listener),
        terminate: () => {
          terminated()
          return Promise.resolve(1)
        }
      } as WorkerLike
      return worker
    }
  }
}

describe('RegexRunner failures', () => {
  const job = { pattern: 'a', caseSensitive: false, chunks: ['a'] }

  it('reports a worker that cannot start', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const outcome = await new RegexRunner(1000, 10, () => {
      throw new Error('no thread')
    }).run(job)
    expect(outcome).toEqual({ ok: false, error: 'failed' })
    expect(error).toHaveBeenCalledWith('[find] cannot start the regular expression worker:', 'no thread')
  })

  it('reports a worker that raises an error, and ends it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fake = fakeWorker((w) => w.error(new Error('out of memory')))
    expect(await new RegexRunner(1000, 10, fake.make).run(job)).toEqual({ ok: false, error: 'failed' })
    expect(error).toHaveBeenCalledWith('[find] the regular expression worker failed:', 'out of memory')
    expect(fake.terminated).toHaveBeenCalled()
  })

  it('reports a worker that stops without answering', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fake = fakeWorker((w) => w.exit(7))
    expect(await new RegexRunner(1000, 10, fake.make).run(job)).toEqual({ ok: false, error: 'failed' })
    expect(error).toHaveBeenCalledWith('[find] the regular expression worker stopped (code 7) before it answered')
  })

  it('refuses an answer that is not the shape the worker gives', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const reply of [null, 'text', 5, {}, { matches: 'x', more: false }, { matches: [[0, 1]], more: false }, { matches: [[0, -1, 2]], more: false }, { matches: [[0, 1.5, 2]], more: false }, { matches: [], more: 'no' }, { error: 'failed', message: 'boom' }]) {
      error.mockClear()
      const fake = fakeWorker((w) => w.message(reply))
      expect(await new RegexRunner(1000, 10, fake.make).run(job), JSON.stringify(reply)).toEqual({ ok: false, error: 'failed' })
      expect(error).toHaveBeenCalled()
    }
  })

  it('reports a worker that cannot be stopped, without failing the run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handlers: Record<string, (v: never) => void> = {}
    const worker = {
      postMessage: () => handlers['message']?.({ matches: [], more: false } as never),
      on: (event: string, listener: (v: never) => void) => void (handlers[event] = listener),
      terminate: () => Promise.reject(new Error('stuck'))
    } as unknown as WorkerLike
    expect(await new RegexRunner(1000, 10, () => worker).run(job)).toEqual({ ok: true, matches: [], more: false })
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[find] cannot stop the regular expression worker:', 'stuck'))
  })

  it('counts a late answer for nothing once the run has ended', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let late: (v: unknown) => void = () => {}
    const worker = {
      postMessage: () => {},
      on: (event: string, listener: (v: unknown) => void) => void (event === 'message' && (late = listener)),
      terminate: () => Promise.resolve(0)
    } as unknown as WorkerLike
    expect(await new RegexRunner(50, 10, () => worker).run(job)).toEqual({ ok: false, error: 'slow' })
    expect(() => late({ matches: [[0, 0, 1]], more: false })).not.toThrow()
  })
})

// ---------- the finder, with a page and a runner that answer what the test says ----------

interface Rig {
  host: FinderHost
  reports: FindReport[]
  css: string[]
  scripts: string[]
  finder: RegexFinder
  runner: { run: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }
  /** What the page answers to each script, by its marker. */
  page: Record<string, (code: string) => unknown>
}

function rig(outcome: RegexRunOutcome | (() => Promise<RegexRunOutcome>) = { ok: true, matches: [[0, 0, 1], [0, 2, 3], [1, 0, 1]], more: false }): Rig {
  const reports: FindReport[] = []
  const css: string[] = []
  const scripts: string[] = []
  const page: Rig['page'] = {
    collect: () => ({ chunks: ['a b', 'c'], partial: false }),
    apply: (code) => ({ shown: (JSON.parse(/const matches = (.*)/.exec(code)![1]!) as unknown[]).length }),
    current: () => true,
    clear: () => true
  }
  const host: FinderHost = {
    run: async (code) => {
      scripts.push(code)
      const marker = /^\/\* regex-find:(\w+) \*\//.exec(code)![1]!
      return page[marker]!(code)
    },
    setCss: (value) => css.push(value),
    report: (r) => reports.push(r)
  }
  const runner = { run: vi.fn(typeof outcome === 'function' ? outcome : async () => outcome), cancel: vi.fn() }
  return { host, reports, css, scripts, runner, page, finder: new RegexFinder(host, runner as unknown as RegexRunner, 0) }
}

describe('RegexFinder', () => {
  it('scans the page, runs the expression on the text, paints, and reports the count with the first match current', async () => {
    const r = rig()
    r.finder.find('a|b|c')
    await vi.waitFor(() => expect(r.reports).toHaveLength(1))
    expect(r.reports[0]).toEqual({ matches: 3, ordinal: 1 })
    expect(r.runner.run).toHaveBeenCalledWith({ pattern: 'a|b|c', caseSensitive: false, chunks: ['a b', 'c'] })
    expect(r.css).toEqual([REGEX_HIGHLIGHT_CSS])
    expect(r.scripts.map((s) => /regex-find:(\w+)/.exec(s)![1])).toEqual(['collect', 'apply'])
  })

  it('steps to the next and the previous match, round the ends, without scanning again', async () => {
    const r = rig()
    r.finder.find('x')
    await vi.waitFor(() => expect(r.reports).toHaveLength(1))
    const ordinals: number[] = []
    for (const forward of [true, true, true, false, false]) {
      const before = r.reports.length
      r.finder.find('x', { next: true, forward })
      await vi.waitFor(() => expect(r.reports.length).toBe(before + 1))
      ordinals.push(r.reports.at(-1)!.ordinal)
    }
    expect(ordinals).toEqual([2, 3, 1, 3, 2])
    expect(r.runner.run).toHaveBeenCalledTimes(1)
    expect(r.scripts.filter((s) => s.includes('regex-find:current'))).toHaveLength(5)
  })

  it('counts the matches the page kept, not the ones it was sent', async () => {
    const r = rig()
    r.page['apply'] = () => ({ shown: 2 })
    r.finder.find('x')
    await vi.waitFor(() => expect(r.reports).toHaveLength(1))
    expect(r.reports[0]).toEqual({ matches: 2, ordinal: 1 })
  })

  it('says there is more when the expression or the page text was cut short', async () => {
    const r = rig({ ok: true, matches: [[0, 0, 1]], more: true })
    r.finder.find('x')
    await vi.waitFor(() => expect(r.reports).toHaveLength(1))
    expect(r.reports[0]).toEqual({ matches: 1, ordinal: 1, more: true })
    const partial = rig({ ok: true, matches: [[0, 0, 1]], more: false })
    partial.page['collect'] = () => ({ chunks: ['a'], partial: true })
    partial.finder.find('x')
    await vi.waitFor(() => expect(partial.reports).toHaveLength(1))
    expect(partial.reports[0]).toEqual({ matches: 1, ordinal: 1, more: true })
    // Stepping keeps saying it.
    partial.finder.find('x', { next: true })
    await vi.waitFor(() => expect(partial.reports).toHaveLength(2))
    expect(partial.reports[1]).toMatchObject({ more: true })
  })

  it('reports no match without an error, and clears nothing it did not paint', async () => {
    const r = rig({ ok: true, matches: [], more: false })
    r.page['apply'] = () => ({ shown: 0 })
    r.finder.find('zzz')
    await vi.waitFor(() => expect(r.reports).toHaveLength(1))
    expect(r.reports[0]).toEqual({ matches: 0, ordinal: 0 })
  })

  it('reports an invalid expression, clears the highlights, and has no match to step to', async () => {
    const r = rig({ ok: false, error: 'invalid' })
    r.finder.find('(')
    await vi.waitFor(() => expect(r.reports).toHaveLength(1))
    expect(r.reports[0]).toEqual({ matches: 0, ordinal: 0, error: 'invalid' })
    expect(r.scripts.some((s) => s.includes('regex-find:clear'))).toBe(true)
    r.finder.find('(', { next: true })
    await vi.waitFor(() => expect(r.runner.run).toHaveBeenCalledTimes(2))
  })

  it('reports an expression that was abandoned for taking too long', async () => {
    const r = rig({ ok: false, error: 'slow' })
    r.finder.find('(a+)+b')
    await vi.waitFor(() => expect(r.reports).toHaveLength(1))
    expect(r.reports[0]).toEqual({ matches: 0, ordinal: 0, error: 'slow' })
  })

  it('refuses an expression that is too long without running it', () => {
    const r = rig()
    r.finder.find('a'.repeat(REGEX_PATTERN_MAX + 1))
    expect(r.reports).toEqual([{ matches: 0, ordinal: 0, error: 'too-long' }])
    expect(r.runner.run).not.toHaveBeenCalled()
    expect(r.scripts.some((s) => s.includes('regex-find:collect'))).toBe(false)
    r.finder.find('a'.repeat(REGEX_PATTERN_MAX))
    expect(r.reports).toHaveLength(1)
  })

  it('searches only the last text of a quick series (the older ones are not run)', async () => {
    const r = rig()
    const slow = new RegexFinder(r.host, r.runner as unknown as RegexRunner, 30)
    slow.find('a')
    slow.find('ab')
    slow.find('abc')
    await vi.waitFor(() => expect(r.reports).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(r.runner.run).toHaveBeenCalledTimes(1)
    expect(r.runner.run.mock.calls[0]![0]).toMatchObject({ pattern: 'abc' })
    // The page was not even read for the texts typed on the way.
    expect(r.scripts.filter((s) => s.includes('regex-find:collect'))).toHaveLength(1)
  })

  it('drops the answer of a search that a newer one replaced, and cancels the worker of the old one', async () => {
    let release: (o: RegexRunOutcome) => void = () => {}
    let calls = 0
    const r = rig(() => (++calls === 1 ? new Promise<RegexRunOutcome>((resolve) => (release = resolve)) : Promise.resolve({ ok: true, matches: [[0, 0, 1]], more: false })))
    r.page['apply'] = (code) => ({ shown: (JSON.parse(/const matches = (.*)/.exec(code)![1]!) as unknown[]).length })
    r.finder.find('first')
    await vi.waitFor(() => expect(r.runner.run).toHaveBeenCalledTimes(1))
    r.finder.find('second')
    await vi.waitFor(() => expect(r.reports).toHaveLength(1))
    release({ ok: true, matches: [[0, 0, 1], [0, 2, 3]], more: false })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(r.reports).toEqual([{ matches: 1, ordinal: 1 }])
    expect(r.runner.cancel).toHaveBeenCalled()
    // …and the page was not even asked to paint what the old search found.
    expect(r.scripts.filter((s) => s.includes('regex-find:apply'))).toHaveLength(1)
  })

  it('drops a page scan that a newer search overtook, without running the old expression', async () => {
    let release: (value: unknown) => void = () => {}
    const r = rig()
    const scan = r.host.run
    let first = true
    r.host.run = (code) => (first && code.includes('regex-find:collect') ? ((first = false), new Promise((resolve) => (release = resolve))) : scan(code))
    r.finder.find('first')
    await vi.waitFor(() => expect(first).toBe(false))
    r.finder.find('second')
    await vi.waitFor(() => expect(r.reports).toHaveLength(1))
    release({ chunks: ['old'], partial: false })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(r.runner.run).toHaveBeenCalledTimes(1)
    expect(r.runner.run.mock.calls[0]![0]).toMatchObject({ pattern: 'second' })
    expect(r.reports).toHaveLength(1)
  })

  it('says it failed, and logs the cause, when the page cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = rig()
    r.page['collect'] = () => {
      throw new Error('Script failed to execute')
    }
    r.finder.find('x')
    await vi.waitFor(() => expect(r.reports).toHaveLength(1))
    expect(r.reports[0]).toEqual({ matches: 0, ordinal: 0, error: 'failed' })
    expect(warn).toHaveBeenCalledWith('[find] the page could not be searched:', 'Script failed to execute')
    expect(r.runner.run).not.toHaveBeenCalled()
  })

  it('says it failed when the page gives something else than text', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const reply of [null, {}, { chunks: 'x' }, { chunks: [1, 2] }]) {
      const r = rig()
      r.page['collect'] = () => reply
      r.finder.find('x')
      await vi.waitFor(() => expect(r.reports).toHaveLength(1))
      expect(r.reports[0], JSON.stringify(reply)).toEqual({ matches: 0, ordinal: 0, error: 'failed' })
    }
  })

  it('refuses, without running the expression, a page that gives more text than a search reads, and logs why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = rig()
    r.page['collect'] = () => ({ chunks: ['x'.repeat(REGEX_TEXT_MAX), 'y'], partial: false })
    r.finder.find('x')
    await vi.waitFor(() => expect(r.reports).toHaveLength(1))
    expect(r.reports[0]).toEqual({ matches: 0, ordinal: 0, error: 'failed' })
    expect(r.runner.run).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[find] the page could not be searched:', 'the page gave more text than a search reads')
  })

  it('says it failed when the page can no longer paint (it changed documents), and when it cannot be reached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stale = rig()
    stale.page['apply'] = () => ({ stale: true })
    stale.finder.find('x')
    await vi.waitFor(() => expect(stale.reports).toHaveLength(1))
    expect(stale.reports[0]).toMatchObject({ error: 'failed' })
    const gone = rig()
    gone.page['apply'] = () => {
      throw new Error('Render frame was disposed')
    }
    gone.finder.find('x')
    await vi.waitFor(() => expect(gone.reports).toHaveLength(1))
    expect(gone.reports[0]).toMatchObject({ error: 'failed' })
    expect(warn).toHaveBeenCalledWith('[find] the page could not be searched:', 'Render frame was disposed')
  })

  it('says "not supported" when the engine has no highlight API', async () => {
    const r = rig()
    r.page['apply'] = () => ({ unsupported: true })
    r.finder.find('x')
    await vi.waitFor(() => expect(r.reports).toHaveLength(1))
    expect(r.reports[0]).toEqual({ matches: 0, ordinal: 0, error: 'unsupported' })
  })

  it('searches again when a step finds that the page lost the search', async () => {
    const r = rig()
    r.finder.find('x')
    await vi.waitFor(() => expect(r.reports).toHaveLength(1))
    r.page['current'] = () => false
    r.finder.find('x', { next: true })
    await vi.waitFor(() => expect(r.runner.run).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(r.reports).toHaveLength(2))
    expect(r.reports[1]).toEqual({ matches: 3, ordinal: 1 })
  })

  it('searches again, rather than steps, when the text or the case option changed', async () => {
    const r = rig()
    r.finder.find('x')
    await vi.waitFor(() => expect(r.reports).toHaveLength(1))
    r.finder.find('y', { next: true })
    await vi.waitFor(() => expect(r.runner.run).toHaveBeenCalledTimes(2))
    r.finder.find('y', { next: true, matchCase: true })
    await vi.waitFor(() => expect(r.runner.run).toHaveBeenCalledTimes(3))
    expect(r.runner.run.mock.calls[2]![0]).toMatchObject({ caseSensitive: true })
  })

  it('cleans the page and the style when it stops, and does nothing when nothing was started', async () => {
    const idle = rig()
    idle.finder.stop()
    expect(idle.scripts).toEqual([])
    expect(idle.css).toEqual([])
    const r = rig()
    r.finder.find('x')
    await vi.waitFor(() => expect(r.reports).toHaveLength(1))
    r.finder.stop()
    expect(r.css.at(-1)).toBe('')
    expect(r.scripts.at(-1)).toContain('regex-find:clear')
    expect(r.finder.active).toBe(false)
    expect(r.runner.cancel).toHaveBeenCalled()
    r.finder.find('')
    expect(r.scripts.filter((s) => s.includes('regex-find:clear'))).toHaveLength(1)
  })

  it('forgets the search on a navigation (the painted page is gone) and paints nothing of a search that was under way', async () => {
    const r = rig()
    r.finder.find('x')
    await vi.waitFor(() => expect(r.reports).toHaveLength(1))
    r.finder.reset()
    expect(r.finder.active).toBe(false)
    r.finder.find('x', { next: true })
    await vi.waitFor(() => expect(r.runner.run).toHaveBeenCalledTimes(2))
  })

  it('logs, without failing, a clear that the page refuses', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const r = rig()
    r.finder.find('x')
    await vi.waitFor(() => expect(r.reports).toHaveLength(1))
    r.page['clear'] = () => {
      throw new Error('gone')
    }
    r.finder.stop()
    await vi.waitFor(() => expect(debug).toHaveBeenCalledWith('[find] cannot clear the highlights:', 'gone'))
  })
})

describe('readScan (the text of the page, checked in this process)', () => {
  it('takes blocks of text up to the bound, the bound included', () => {
    expect(readScan({ chunks: ['ab', 'cd'], partial: false }, 4)).toEqual({ ok: true, chunks: ['ab', 'cd'], partial: false })
    expect(readScan({ chunks: ['ab'], partial: true }, 4)).toEqual({ ok: true, chunks: ['ab'], partial: true })
    expect(readScan({ chunks: [] })).toEqual({ ok: true, chunks: [], partial: false })
    expect(readScan({ chunks: ['x'.repeat(REGEX_TEXT_MAX)] }).ok).toBe(true)
  })

  it('refuses one character more than the bound, in one block or in several', () => {
    expect(readScan({ chunks: ['abcde'] }, 4)).toEqual({ ok: false, reason: 'the page gave more text than a search reads' })
    expect(readScan({ chunks: ['ab', 'cd', 'e'] }, 4)).toEqual({ ok: false, reason: 'the page gave more text than a search reads' })
    expect(readScan({ chunks: ['x'.repeat(REGEX_TEXT_MAX), 'y'] }).ok).toBe(false)
  })

  it('refuses what is not blocks of text', () => {
    for (const reply of [null, undefined, 'text', {}, { chunks: 'x' }, { chunks: [1, 2] }, { chunks: ['a', null] }]) expect(readScan(reply), JSON.stringify(reply)).toEqual({ ok: false, reason: 'the page gave no text' })
  })

  it('stops reading where the bound is crossed: blocks without number, even empty ones, cost no more to refuse than the bound', () => {
    let reads = 0
    const endless = new Proxy(new Array<string>(1_000_000).fill(''), {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++
        return Reflect.get(target, key, receiver) as unknown
      }
    })
    expect(readScan({ chunks: endless }, 50)).toEqual({ ok: false, reason: 'the page gave more text than a search reads' })
    expect(reads).toBe(51)
  })
})
