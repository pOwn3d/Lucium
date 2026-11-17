// The machinery of "find in page by regular expression" (shared/regex-find.ts says what it is for and where its limits are).
//
//  - A script in an isolated world of the tab (the page cannot see it, and its Content-Security-Policy does not apply) reads the visible text
//    of the page by blocks and keeps the text nodes it came from. The expression never goes there.
//  - The expression runs in a worker thread of the main process, on a copy of that text. A catastrophic expression ("(a+)+b") cannot be
//    interrupted from inside, so the worker is terminated when the time is up: the page keeps running, the interface keeps answering.
//  - A second script turns the matches into ranges and paints them with the CSS Custom Highlight API (no change to the page's DOM), and
//    scrolls the current one into view. Ranges are live: the page may edit its text meanwhile, and a match whose node changed is dropped.

import { Worker } from 'node:worker_threads'
import { REGEX_HIGHLIGHT_CSS } from '@shared/ipc'
import { REGEX_MATCH_MAX, REGEX_PATTERN_MAX, REGEX_TEXT_MAX, REGEX_TIME_LIMIT_MS, type RegexFindError } from '@shared/regex-find'

/** An isolated world of its own (see SLEEP_WORLD, READER_WORLD and MARKDOWN_WORLD for the others). */
export const REGEX_FIND_WORLD = 4_200_071

const DEBOUNCE_MS = 120

// ---------- the worker: the only place the expression runs ----------

/**
 * `findMatches(chunks, pattern, caseSensitive, limit)` answers `{ matches: [[chunk, start, end], …], more }` or `{ error }`. Unicode mode is tried
 * first (so `\p{L}` works) and plain mode when the expression is not valid in it. Empty matches are skipped. Kept as text: the worker runs
 * this very source, and the tests run it through `new Function`.
 */
export const MATCH_SOURCE = `function findMatches(chunks, pattern, caseSensitive, limit) {
  var flags = caseSensitive ? 'gm' : 'gim'
  var re = null
  try { re = new RegExp(pattern, flags + 'u') } catch (first) {
    try { re = new RegExp(pattern, flags) } catch (second) { return { error: 'invalid' } }
  }
  var matches = []
  for (var c = 0; c < chunks.length; c++) {
    var text = chunks[c]
    re.lastIndex = 0
    var m
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        var step = re.unicode && re.lastIndex < text.length && text.charCodeAt(re.lastIndex) >= 0xD800 && text.charCodeAt(re.lastIndex) <= 0xDBFF ? 2 : 1
        re.lastIndex += step
        continue
      }
      matches.push([c, m.index, m.index + m[0].length])
      if (matches.length > limit) { matches.pop(); return { matches: matches, more: true } }
    }
  }
  return { matches: matches, more: false }
}`

const WORKER_SOURCE = `const { parentPort } = require('node:worker_threads')
${MATCH_SOURCE}
parentPort.on('message', (job) => {
  var reply
  try { reply = findMatches(job.chunks, job.pattern, job.caseSensitive, job.limit) } catch (error) { reply = { error: 'failed', message: String(error && error.message) } }
  parentPort.postMessage(reply)
})`

export interface RegexJob {
  pattern: string
  caseSensitive: boolean
  chunks: string[]
}

export type RegexRunOutcome =
  | { ok: true; matches: Array<[number, number, number]>; more: boolean }
  | { ok: false; error: RegexFindError | 'cancelled' }

/** What the runner needs of a worker thread (the real one, or a stand-in in the tests). */
export interface WorkerLike {
  postMessage(value: unknown): void
  on(event: 'message', listener: (value: unknown) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number>
}

const startWorker = (): WorkerLike => new Worker(WORKER_SOURCE, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256 } })

const isTriple = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every((n) => Number.isInteger(n) && (n as number) >= 0)

/** The worker's answer, checked: the worker is ours, but what crosses a thread is still read as data. */
function readReply(reply: unknown): RegexRunOutcome {
  const r = typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>) : {}
  if (r['error'] === 'invalid') return { ok: false, error: 'invalid' }
  if (Array.isArray(r['matches']) && r['matches'].every(isTriple) && typeof r['more'] === 'boolean') return { ok: true, matches: r['matches'] as Array<[number, number, number]>, more: r['more'] }
  console.error('[find] the regular expression worker gave an answer that is not one:', typeof r['message'] === 'string' ? r['message'].slice(0, 200) : typeof reply)
  return { ok: false, error: 'failed' }
}

/** Runs one expression at a time, each in a worker thread of its own that is gone when the answer is. */
export class RegexRunner {
  private running: { worker: WorkerLike; finish: (outcome: RegexRunOutcome) => void } | null = null

  constructor(
    private readonly timeoutMs: number = REGEX_TIME_LIMIT_MS,
    private readonly limit: number = REGEX_MATCH_MAX,
    private readonly makeWorker: () => WorkerLike = startWorker
  ) {}

  run(job: RegexJob): Promise<RegexRunOutcome> {
    this.cancel()
    return new Promise((resolve) => {
      let worker: WorkerLike
      try {
        worker = this.makeWorker()
      } catch (error) {
        console.error('[find] cannot start the regular expression worker:', error instanceof Error ? error.message : String(error))
        return resolve({ ok: false, error: 'failed' })
      }
      let done = false
      const finish = (outcome: RegexRunOutcome): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (this.running?.worker === worker) this.running = null
        worker.terminate().catch((error: unknown) => console.warn('[find] cannot stop the regular expression worker:', error instanceof Error ? error.message : String(error)))
        resolve(outcome)
      }
      const timer = setTimeout(() => {
        console.warn(`[find] regular expression abandoned after ${this.timeoutMs} ms:`, job.pattern.slice(0, 80))
        finish({ ok: false, error: 'slow' })
      }, this.timeoutMs)
      worker.on('message', (reply) => finish(readReply(reply)))
      worker.on('error', (error) => {
        console.error('[find] the regular expression worker failed:', error.message)
        finish({ ok: false, error: 'failed' })
      })
      // A worker that ends without having answered (a crash, or an out-of-memory stop).
      worker.on('exit', (code) => {
        if (!done) console.error(`[find] the regular expression worker stopped (code ${code}) before it answered`)
        finish({ ok: false, error: 'failed' })
      })
      this.running = { worker, finish }
      worker.postMessage({ pattern: job.pattern, caseSensitive: job.caseSensitive, limit: this.limit, chunks: job.chunks })
    })
  }

  /** Ends the run under way, if any: its promise answers `cancelled`. */
  cancel(): void {
    this.running?.finish({ ok: false, error: 'cancelled' })
  }
}

// ---------- the scripts of the page side ----------

export type PageScan = { ok: true; chunks: string[]; partial: boolean } | { ok: false; reason: string }

/**
 * The answer of `collectScript`, checked in this process: blocks of text, and no more of it than the script is told to collect. The script
 * applies that bound in the page's process, which is not this one's to trust: an answer over it is refused before a character is copied to
 * the worker. The check itself stops where the bound is crossed (a block counts for one character at least), so that an answer made of
 * millions of blocks costs no more to refuse than one of the largest size allowed.
 */
export function readScan(reply: unknown, maxChars: number = REGEX_TEXT_MAX): PageScan {
  const chunks = typeof reply === 'object' && reply !== null ? (reply as { chunks?: unknown }).chunks : undefined
  if (!Array.isArray(chunks)) return { ok: false, reason: 'the page gave no text' }
  let chars = 0
  for (let i = 0; i < chunks.length; i++) {
    const chunk: unknown = chunks[i]
    if (typeof chunk !== 'string') return { ok: false, reason: 'the page gave no text' }
    chars += Math.max(chunk.length, 1)
    if (chars > maxChars) return { ok: false, reason: 'the page gave more text than a search reads' }
  }
  return { ok: true, chunks: chunks as string[], partial: (reply as { partial?: unknown }).partial === true }
}

/** The text of the page as blocks, kept in `window.__luciumRegexFind` of the isolated world. Answers `{ chunks, partial }`. */
export const collectScript = (generation: number): string => String.raw`/* regex-find:collect */ (() => {
  const MAX_CHARS = ${REGEX_TEXT_MAX}
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'select', 'option', 'iframe', 'object', 'canvas', 'head', 'title'])
  const st = (window.__luciumRegexFind = { generation: ${generation}, chunks: [], ranges: [] })
  const root = document.body || document.documentElement
  if (!root) return { chunks: [], partial: false }
  // A block is the nearest ancestor that is not inline: text runs on across inline elements ("Hello <b>wor</b>ld" is one block) and stops at a block.
  const blocks = new WeakMap()
  const blockOf = (element) => {
    const path = []
    let node = element
    let block
    for (;;) {
      if (blocks.has(node)) { block = blocks.get(node); break }
      path.push(node)
      const display = getComputedStyle(node).display
      if ((display === 'inline' || display === 'contents') && node.parentElement && node !== root) node = node.parentElement
      else { block = node; break }
    }
    for (const visited of path) blocks.set(visited, block)
    return block
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === 3) return NodeFilter.FILTER_ACCEPT
      if (SKIP.has(node.localName)) return NodeFilter.FILTER_REJECT
      if (typeof node.checkVisibility === 'function' && !node.checkVisibility()) return NodeFilter.FILTER_REJECT
      return node.localName === 'br' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    }
  })
  let chars = 0
  let partial = false
  let current = null
  const close = () => {
    if (current && /\S/.test(current.text)) st.chunks.push(current)
    current = null
  }
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 1) { close(); continue }
    const data = node.data
    if (data.length === 0 || !node.parentElement) continue
    const block = blockOf(node.parentElement)
    if (!current || current.block !== block) { close(); current = { block, text: '', parts: [] } }
    if (chars + data.length > MAX_CHARS) { partial = true; break }
    current.parts.push({ node, start: current.text.length, end: current.text.length + data.length })
    current.text += data
    chars += data.length
  }
  close()
  return { chunks: st.chunks.map((chunk) => chunk.text), partial }
})()`

/** Shows the range `i` as the current match: its highlight, and the page scrolled so that it is on screen. */
const SHOW = String.raw`
  const show = (i) => {
    const range = st.ranges[i]
    if (!range) return
    const current = new Highlight(range)
    current.priority = 1
    CSS.highlights.set('lucium-find-current', current)
    const element = range.startContainer.parentElement
    if (element) element.scrollIntoView({ block: 'center', inline: 'nearest' })
    const rect = range.getBoundingClientRect()
    if (rect.height > 0 && (rect.bottom < 0 || rect.top > innerHeight)) window.scrollBy({ top: rect.top - innerHeight / 2, behavior: 'instant' })
  }`

/** Paints the matches `[chunk, start, end][]` and the first one as current. Answers `{ shown }`, `{ stale }` or `{ unsupported }`. */
export const applyScript = (generation: number, matches: ReadonlyArray<readonly [number, number, number]>): string => String.raw`/* regex-find:apply */ (() => {
  const st = window.__luciumRegexFind
  if (!st || st.generation !== ${generation}) return { stale: true }
  if (!window.CSS || !CSS.highlights || typeof Highlight !== 'function') return { unsupported: true }
  const matches = ${JSON.stringify(matches)}
  // The part of the block that holds an offset: where it starts, or (for the end of a match) where it ends.
  const partAt = (parts, offset, atEnd) => {
    let low = 0
    let high = parts.length - 1
    while (low < high) {
      const middle = (low + high) >> 1
      if (atEnd ? parts[middle].end < offset : parts[middle].end <= offset) low = middle + 1
      else high = middle
    }
    return parts[low]
  }
  const intact = (part) => part.node.isConnected && part.node.data.length === part.end - part.start
  const ranges = []
  for (const [index, start, end] of matches) {
    const chunk = st.chunks[index]
    if (!chunk) continue
    const first = partAt(chunk.parts, start, false)
    const last = partAt(chunk.parts, end, true)
    // The page edited this text since it was read: the match is left out.
    if (!first || !last || !intact(first) || !intact(last)) continue
    const range = document.createRange()
    range.setStart(first.node, start - first.start)
    range.setEnd(last.node, end - last.start)
    ranges.push(range)
  }
  st.ranges = ranges
  CSS.highlights.delete('lucium-find-current')
  if (ranges.length === 0) { CSS.highlights.delete('lucium-find'); return { shown: 0 } }
  CSS.highlights.set('lucium-find', new Highlight(...ranges))
  ${SHOW}
  show(0)
  return { shown: ranges.length }
})()`

/** Moves the current match to range `index`. Answers true, or false when the page no longer holds the search `generation`. */
export const currentScript = (generation: number, index: number): string => String.raw`/* regex-find:current */ (() => {
  const st = window.__luciumRegexFind
  if (!st || st.generation !== ${generation} || !st.ranges[${index}]) return false
  ${SHOW}
  show(${index})
  return true
})()`

export const CLEAR_SCRIPT = String.raw`/* regex-find:clear */ (() => {
  if (window.CSS && CSS.highlights) {
    CSS.highlights.delete('lucium-find')
    CSS.highlights.delete('lucium-find-current')
  }
  delete window.__luciumRegexFind
  return true
})()`

// ---------- one tab's search ----------

export interface FindReport {
  matches: number
  ordinal: number
  error?: RegexFindError
  more?: boolean
}

/** What the finder needs of its tab. */
export interface FinderHost {
  /** Runs a script in the isolated world of the tab; rejects when the page is gone. */
  run(code: string): Promise<unknown>
  /** Sets the CSS of the `find` slot of the tab ('' removes it). */
  setCss(css: string): void
  report(report: FindReport): void
}

export interface FinderOptions {
  next?: boolean
  forward?: boolean
  matchCase?: boolean
}

/** The regular-expression search of one tab: scan, match, paint, step. A new search ends the one before it. */
export class RegexFinder {
  private generation = 0
  private pattern = ''
  private matchCase = false
  private count = 0
  private index = 0
  private more = false
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Something was painted or is being prepared: `stop()` has to clean up. */
  active = false

  constructor(
    private readonly host: FinderHost,
    private readonly runner: RegexRunner = new RegexRunner(),
    private readonly debounceMs: number = DEBOUNCE_MS
  ) {}

  find(pattern: string, options: FinderOptions = {}): void {
    if (!pattern) return this.stop()
    const matchCase = options.matchCase === true
    if (options.next && pattern === this.pattern && matchCase === this.matchCase && this.count > 0) return void this.step(options.forward ?? true)
    this.cancelPending()
    this.pattern = pattern
    this.matchCase = matchCase
    this.count = 0
    this.index = 0
    this.more = false
    this.active = true
    if (pattern.length > REGEX_PATTERN_MAX) {
      this.clearPage()
      return this.host.report({ matches: 0, ordinal: 0, error: 'too-long' })
    }
    this.host.setCss(REGEX_HIGHLIGHT_CSS)
    const generation = this.generation
    // A key pressed after another replaces it: only the last text is searched.
    this.timer = setTimeout(() => void this.search(pattern, matchCase, generation), this.debounceMs)
  }

  /** The tab went to another document: what was painted is gone with the old one. */
  reset(): void {
    this.cancelPending()
    this.pattern = ''
    this.count = 0
    this.active = false
  }

  stop(): void {
    const wasActive = this.active
    this.reset()
    if (!wasActive) return
    this.host.setCss('')
    this.clearPage()
  }

  private cancelPending(): void {
    this.generation++
    this.runner.cancel()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private clearPage(): void {
    this.host.run(CLEAR_SCRIPT).catch((error: unknown) => {
      // The page is gone or navigating: its highlights went with it, so this is worth a line and nothing more.
      console.debug('[find] cannot clear the highlights:', error instanceof Error ? error.message : String(error))
    })
  }

  private fail(generation: number, error: RegexFindError, cause?: unknown): void {
    if (generation !== this.generation) return
    if (cause !== undefined) console.warn('[find] the page could not be searched:', cause instanceof Error ? cause.message : String(cause))
    this.count = 0
    this.host.report({ matches: 0, ordinal: 0, error })
  }

  private async search(pattern: string, matchCase: boolean, generation: number): Promise<void> {
    this.timer = null
    let scan: { chunks: string[]; partial: boolean }
    try {
      const reply = readScan(await this.host.run(collectScript(generation)))
      if (generation !== this.generation) return
      if (!reply.ok) return this.fail(generation, 'failed', new Error(reply.reason))
      scan = reply
    } catch (error) {
      return this.fail(generation, 'failed', error)
    }
    const outcome = await this.runner.run({ pattern, caseSensitive: matchCase, chunks: scan.chunks })
    if (generation !== this.generation) return
    if (!outcome.ok) {
      if (outcome.error === 'cancelled') return
      this.clearPage()
      return this.fail(generation, outcome.error)
    }
    try {
      const painted = (await this.host.run(applyScript(generation, outcome.matches))) as { shown?: unknown; unsupported?: unknown } | null
      if (generation !== this.generation) return
      if (painted?.unsupported === true) return this.fail(generation, 'unsupported')
      // `{ stale: true }` is the page saying it no longer holds this search (it changed documents): no count to show.
      if (typeof painted?.shown !== 'number') return this.fail(generation, 'failed', new Error('the page no longer holds this search'))
      this.count = painted.shown
      this.more = outcome.more || scan.partial
      this.index = 0
      this.host.report({ matches: this.count, ordinal: this.count > 0 ? 1 : 0, ...(this.more ? { more: true } : {}) })
    } catch (error) {
      this.fail(generation, 'failed', error)
    }
  }

  private async step(forward: boolean): Promise<void> {
    const generation = this.generation
    const next = (this.index + (forward ? 1 : -1) + this.count) % this.count
    // At once: two presses of Return before the page answers move two steps.
    this.index = next
    try {
      const moved = await this.host.run(currentScript(generation, next))
      if (generation !== this.generation) return
      // The page lost the search (a reload, a script that cleared the registry): search again.
      if (moved !== true) return this.find(this.pattern, { matchCase: this.matchCase })
      this.host.report({ matches: this.count, ordinal: next + 1, ...(this.more ? { more: true } : {}) })
    } catch (error) {
      this.fail(generation, 'failed', error)
    }
  }
}
