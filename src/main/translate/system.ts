// The system's own translation: the first engine of the panel "Traduire cette page" on macOS (docs/traduction-locale.md).
//
// macOS translates on the Mac with the languages the person installed in System Settings › General › Language & Region › Translation Languages
// (Apple's Translation framework). Electron cannot reach it: a small helper does (native/system-translate/main.swift, bundled as
// LuciumTranslate.app in Contents/Helpers/): `availability` for a pair, `translate` for one batch of texts.
//
// One helper serves a whole page (`systemHelperFor`): started at the first request, it takes the next ones on the same pipes, one line of JSON each
// with its id (protocol 2), and keeps the translation session of the pair from one batch to the next; with nothing to do for 45 s its input is
// closed and it quits. A helper whose bundle names no protocol 2 (an older build of it), or that does not answer the greeting, is run once per
// request as before, one run at a time.
//
// Rules this file keeps, each with its test (system.test.ts, system-stream.test.ts, system-native.test.ts):
//  - nothing is run before a translation is asked for: the helper is started for a page only, by the panel (its opening on a page, « Traduire »),
//    by a one-click translation, or by a page that loads in a language of « Toujours traduire » (the person's own setting: a tab restored in such
//    a language starts it as the application starts, and only then); never from the Settings window, never while the function is off, and never
//    on a system older than macOS 26 (the session without a window is macOS 26.0 and later); it stays at most 45 s after its last request
//    (SYSTEM_TRANSLATE_IDLE_MS);
//  - the text of the page goes through the standard input, never in an argument (other processes read command lines), and is never logged: what
//    is logged is a kind of failure;
//  - a batch is bounded here, before the helper is started or written to, with the helper's own limits; each answer is bounded as it is read;
//  - the helper never downloads a language and makes no request of its own; nothing here asks the network either;
//  - the helper is started only when its signature is the one this application expects (helper-signature.ts), and it answers only
//    Lucium (native/shared/caller.swift); one still running when the application quits is stopped (`stopSystemTranslateHelpers`).
//
// Each system has its own engine or none: `systemEngineFor` in engines.ts picks it. Windows and Linux have none in this build (Bergamot comes first there).

import { spawn, type ChildProcess, type ChildProcessByStdio, type SpawnOptionsWithStdioTuple, type StdioNull, type StdioPipe } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import type { Readable, Writable } from 'node:stream'
import { join } from 'node:path'
import { isLanguageCode, type BatchPace, type SystemAvailability, type SystemEngineKind } from '@shared/translate-local'
import type { EngineModel } from './engines'
import { bundleOf, isTrustedHelper } from '../helper-signature'
import { isRecord } from '@shared/record'

/** The bundle and the program the packaging puts in Contents/Helpers/ (native/system-translate/build.sh). */
export const SYSTEM_TRANSLATE_HELPER_BUNDLE = 'LuciumTranslate.app'
export const SYSTEM_TRANSLATE_HELPER_EXECUTABLE = 'lucium-translate'
/** The identifier its bundle is signed under (native/system-translate/Info.plist): what its signature is checked against. */
export const SYSTEM_TRANSLATE_HELPER_IDENTIFIER = 'app.lucium.browser.translate'

/** The helper's limits (native/system-translate/main.swift): a batch beyond them is refused here, before the helper is started. Characters count as JavaScript counts them. */
export const SYSTEM_TRANSLATE_LIMITS = { texts: 64, textChars: 2000, totalChars: 12_000, inputBytes: 256 * 1024 } as const
/** An answer: the translations of a batch (bounded by the controller's `checkReply` at four times the text), as JSON. Anything longer is not one. */
const OUTPUT_LIMIT = 512 * 1024
/** How long an `availability` and a batch may take. The first call after a while starts the system's service (about 0,3 s measured; 1 s for a batch). */
export const SYSTEM_TRANSLATE_TIMEOUTS = { availabilityMs: 10_000, batchMs: 60_000 } as const
/** The first macOS with a translation session that needs no window: `TranslationSession(installedSource:target:)`. */
export const SYSTEM_TRANSLATE_MIN_MACOS = 26
/** The protocol of a helper that serves a page in one run: lines of JSON with ids (main.swift `protocolVersion`, Info.plist `LuciumTranslateProtocol`). */
export const SYSTEM_TRANSLATE_PROTOCOL = 2
/** A helper with nothing to do has its input closed after this long, and quits (it quits by itself after 120 s: main.swift `idleLimitMs`). */
export const SYSTEM_TRANSLATE_IDLE_MS = 45_000
/** A helper whose input was closed and that has not quit after this long is stopped. */
const QUIT_GRACE_MS = 5_000
/**
 * How a page is cut for macOS's translation (pass.ts). macOS translates one text after the other, about 150 ms a text and 3 ms a character on this
 * Mac (macOS 27.2, Apple silicon, its default strategy; measured with the helper), and no faster with several sessions at once: a batch costs what
 * its texts cost, so small batches cost nothing more and show the page sooner. The first is what is on screen (two paragraphs, about 1,5 s), the
 * next ones about 4 s each; three are sent ahead, which the helper takes without a pause between two. Within the helper's limits (pass.test.ts).
 */
export const SYSTEM_TRANSLATE_PACE: BatchPace = { inFlight: 3, first: { chars: 400, items: 8 }, next: { chars: 1200, items: 24 } }
/** An Info.plist is a few hundred bytes: a bigger one is not read. */
const PLIST_LIMIT = 64 * 1024

/** What the helper answers, and what this side adds: too old a system, a helper that did not answer or is not signed as expected, a stop. */
export type SystemTranslateFailure = 'caller' | 'unavailable' | 'not-installed' | 'unsupported' | 'too-large' | 'invalid' | 'cancelled' | 'failed' | 'error' | 'timeout' | 'helper' | 'untrusted' | 'stopped'
const HELPER_CODES: ReadonlySet<string> = new Set(['caller', 'unavailable', 'not-installed', 'unsupported', 'too-large', 'invalid', 'cancelled', 'failed', 'error'])
const STATUSES: ReadonlySet<string> = new Set(['installed', 'supported', 'unsupported'])

/** A failure of the system's translation, with its kind. Its message holds the kind only, never a text of the page. */
export class SystemTranslateError extends Error {
  constructor(readonly kind: SystemTranslateFailure) {
    super(`system translation: ${kind}`)
    this.name = 'SystemTranslateError'
  }
}

export type SystemHelperRequest = { command: 'availability'; from: string; to: string } | { command: 'translate'; from: string; to: string; texts: string[] }

/** Gives `request` to the helper and answers the JSON it answered. Rejects with a SystemTranslateError ('timeout', 'helper', 'stopped', 'untrusted', 'too-large'). */
export type SystemHelperRunner = (request: SystemHelperRequest, timeoutMs: number, signal?: AbortSignal) => Promise<unknown>

/** `spawn` as the runner uses it; a test hands in its own to see what the helper would be given. */
export type SpawnHelper = (file: string, args: readonly string[], options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioNull>) => ChildProcessByStdio<Writable, Readable, null>

/** The one place the helper is started (listed in zero-cost-inventory.test.ts: only on a request of the panel). */
const startHelper: SpawnHelper = (file, args, options) => spawn(file, [...args], options)

/** The helpers running now: stopped when the application quits. */
const running = new Set<ChildProcess>()

/** Stops every helper still running (at quit): its batch then fails as 'helper', and nothing waits for it. */
export function stopSystemTranslateHelpers(): void {
  for (const child of running) child.kill('SIGKILL')
  running.clear()
}

/**
 * Whether the helper at `executable` may be started now (its signature, helper-signature.ts). An application without a team (ad hoc, from the
 * sources) starts it when its signature is intact under its identifier: it is given the texts of a page, never a secret, and it checks its caller.
 */
export function systemTranslateHelperTrusted(executable: string): boolean {
  return isTrustedHelper({ executable, identifier: SYSTEM_TRANSLATE_HELPER_IDENTIFIER, adHoc: 'identifier' })
}

/** The few variables the helper may need from the environment, and nothing else (no DYLD_*, no NODE_*). */
function helperEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['HOME', 'TMPDIR', 'USER', 'LOGNAME']) if (process.env[name] !== undefined) env[name] = process.env[name]
  return env
}

/**
 * The runner of a helper of the first protocol: one run for one request. No argument at all: the request and its texts go through the standard input.
 * Its error output goes nowhere (the helper writes none, and a pipe nobody empties would block it). A stop or the time limit kills it: a translation
 * cannot be interrupted otherwise. `trusted` is asked before each start: a helper whose signature is not the expected one is never started (by
 * default the check of helper-signature.ts, which checks a program once while its files stay the same).
 */
export function systemHelperRunner(executable: string, spawnHelper: SpawnHelper = startHelper, trusted: () => boolean = () => systemTranslateHelperTrusted(executable)): SystemHelperRunner {
  return (request, timeoutMs, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new SystemTranslateError('stopped'))
        return
      }
      if (!trusted()) {
        reject(new SystemTranslateError('untrusted'))
        return
      }
      let child: ReturnType<SpawnHelper>
      try {
        child = spawnHelper(executable, [], { stdio: ['pipe', 'pipe', 'ignore'], env: helperEnvironment() })
      } catch (error) {
        console.warn('[translate] the translation helper of the system could not be started:', error instanceof Error ? error.name : typeof error)
        reject(new SystemTranslateError('helper'))
        return
      }
      running.add(child)
      const out: Buffer[] = []
      let size = 0
      let done = false
      const finish = (error: SystemTranslateError | null): void => {
        if (done) return
        done = true
        running.delete(child)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error) {
          reject(error)
          return
        }
        let answer: unknown
        try {
          answer = JSON.parse(Buffer.concat(out).toString('utf8'))
        } catch {
          answer = undefined
        }
        out.length = 0
        if (answer === undefined) reject(new SystemTranslateError('helper'))
        else resolve(answer)
      }
      const stop = (kind: SystemTranslateFailure): void => {
        child.kill('SIGKILL')
        finish(new SystemTranslateError(kind))
      }
      const onAbort = (): void => stop('stopped')
      const timer = setTimeout(() => stop('timeout'), timeoutMs)
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => {
        if (done) return
        size += chunk.length
        if (size > OUTPUT_LIMIT) {
          stop('helper')
          return
        }
        out.push(chunk)
      })
      child.on('error', () => finish(new SystemTranslateError('helper')))
      child.on('close', (code) => finish(code === 0 ? null : new SystemTranslateError('helper')))
      // A helper that exits before reading its input breaks the pipe: that shows as its exit code above, not as a second error.
      child.stdin.on('error', () => undefined)
      child.stdin.end(JSON.stringify(request))
    })
}

/**
 * The protocol the helper's bundle names (`LuciumTranslateProtocol` in its Info.plist, sealed by its signature, which is checked before it starts);
 * 1, one request per run, when it names none or cannot be read.
 */
export function helperProtocol(executable: string): number {
  try {
    const plist = join(bundleOf(executable), 'Contents', 'Info.plist')
    if (statSync(plist).size > PLIST_LIMIT) return 1
    const named = /<key>LuciumTranslateProtocol<\/key>\s*<integer>(\d{1,3})<\/integer>/.exec(readFileSync(plist, 'utf8'))
    return named ? Number(named[1]) : 1
  } catch (error) {
    // No Info.plist: a helper that names no protocol, so the first one. Any other failure is said: the helper then answers one request per run, slower.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[translate] the protocol of the helper could not be read from its bundle (${executable}); the first one is used:`, error instanceof Error ? error.message : String(error))
    return 1
  }
}

/** What tells a program from another one at the same place (a build of the helper since): its size and its time of change. */
function programStamp(executable: string): string {
  try {
    const info = statSync(executable)
    return `${info.size}:${info.mtimeMs}`
  } catch {
    return ''
  }
}

export interface HelperServiceOptions {
  spawnHelper?: SpawnHelper
  /** Whether the helper may be started (asked before each start; by default its signature, helper-signature.ts). */
  trusted?: () => boolean
  /** The protocol the helper speaks (by default what its bundle names, `helperProtocol`). */
  protocol?: () => number
  /** How long a helper with nothing to do is kept (SYSTEM_TRANSLATE_IDLE_MS). */
  idleMs?: number
  /** How long the helper may take to answer its greeting before it is taken for one of the first protocol (the time of an `availability`). */
  helloMs?: number
}

/** A request given to a running helper, until its answer. */
interface Waiting {
  request: SystemHelperRequest
  timeoutMs: number
  signal: AbortSignal | undefined
  resolve(answer: unknown): void
  reject(error: SystemTranslateError): void
  timer: ReturnType<typeof setTimeout>
  onAbort: () => void
}

/** A helper running for a page (and kept a while after): its requests by id, and the part of its answer not yet a whole line. */
interface Live {
  child: ReturnType<SpawnHelper>
  greeted: boolean
  over: boolean
  pending: Map<number, Waiting>
  partial: Buffer[]
  partialSize: number
  idle: ReturnType<typeof setTimeout> | null
  hello: ReturnType<typeof setTimeout> | null
}

/**
 * A helper that serves many requests in one run (protocol 2): one line of JSON for each request, with its id, one line for each answer. Started at the
 * first request (its signature checked then, `trusted`), it greets (`{"command":"hello","protocol":2}`) and is given the requests at once, several
 * ahead; it answers them one after the other. With no request for `idleMs`, its input is closed and it quits.
 *  - A stop of a request gives it up at once (its answer, when it comes, goes nowhere); when no request is left, the helper is stopped (its work was
 *    for nobody). The time limit of a request stops the helper: that request fails as 'timeout', the others as 'helper'.
 *  - An answer longer than the limit, a line that is not JSON, or an answer without an id stops it, and every request fails ('helper'), but for a
 *    failure the helper names (an input it could not read: 'too-large', 'invalid'…), which every request gets.
 *  - A helper of the first protocol (its bundle names no protocol 2, or it does not answer the greeting in time, or answers something else) is run
 *    once per request, one run at a time, as before; the requests already given to it are given again that way.
 */
export function systemHelperService(executable: string, options: HelperServiceOptions = {}): SystemHelperRunner {
  const spawnHelper = options.spawnHelper ?? startHelper
  const trusted = options.trusted ?? (() => systemTranslateHelperTrusted(executable))
  const protocol = options.protocol ?? (() => helperProtocol(executable))
  const idleMs = options.idleMs ?? SYSTEM_TRANSLATE_IDLE_MS
  const helloMs = options.helloMs ?? SYSTEM_TRANSLATE_TIMEOUTS.availabilityMs
  const once = systemHelperRunner(executable, spawnHelper, trusted)
  let queue: Promise<unknown> = Promise.resolve()
  /** The first protocol, one run at a time (as the controller asked it before: one batch after the other). */
  const oneAtATime: SystemHelperRunner = (request, timeoutMs, signal) => {
    const result = queue.then(() => once(request, timeoutMs, signal))
    // The next run waits for this one to end, however it ends: its outcome is the caller's (`result`).
    queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  /** The program that did not answer the greeting: run once per request until it changes (a new build of it is greeted again). */
  let refusedStamp: string | null = null
  let live: Live | null = null
  let nextId = 1

  /** Ends a helper: nothing more is read from it, and it is killed unless it was told to quit. */
  const finish = (helper: Live, kill: boolean): void => {
    if (helper.over) return
    helper.over = true
    if (helper.idle) clearTimeout(helper.idle)
    if (helper.hello) clearTimeout(helper.hello)
    if (live === helper) live = null
    if (kill) {
      helper.child.kill('SIGKILL')
      running.delete(helper.child)
    }
  }
  const release = (waiting: Waiting): void => {
    clearTimeout(waiting.timer)
    waiting.signal?.removeEventListener('abort', waiting.onAbort)
  }
  /** Every request still waiting gets its outcome, and the helper is stopped. */
  const settleAll = (helper: Live, outcome: (waiting: Waiting) => { answer: unknown } | { error: SystemTranslateFailure }): void => {
    const waiting = [...helper.pending.values()]
    helper.pending.clear()
    finish(helper, true)
    for (const entry of waiting) {
      release(entry)
      const result = outcome(entry)
      if ('answer' in result) entry.resolve(result.answer)
      else entry.reject(new SystemTranslateError(result.error))
    }
  }
  /** The helper does not speak protocol 2: what it was given goes again, one run per request. */
  const refuse = (helper: Live): void => {
    refusedStamp = programStamp(executable)
    console.warn('[translate] the translation helper of the system did not answer its greeting: it is run once for each question, as before')
    const waiting = [...helper.pending.values()]
    helper.pending.clear()
    finish(helper, true)
    for (const entry of waiting) {
      release(entry)
      oneAtATime(entry.request, entry.timeoutMs, entry.signal).then(entry.resolve, (error: unknown) => entry.reject(error instanceof SystemTranslateError ? error : new SystemTranslateError('helper')))
    }
  }
  /** No request left: the helper's input is closed after `idleMs`, and it quits (killed if it does not). */
  const idleIfDone = (helper: Live): void => {
    if (helper.over || helper.pending.size > 0) return
    if (helper.idle) clearTimeout(helper.idle)
    helper.idle = setTimeout(() => {
      finish(helper, false)
      helper.child.stdin.end()
      setTimeout(() => {
        if (running.delete(helper.child)) helper.child.kill('SIGKILL')
      }, QUIT_GRACE_MS).unref?.()
    }, idleMs)
    helper.idle.unref?.()
  }
  const failureCode = (raw: Record<string, unknown>): SystemTranslateFailure | null => {
    const code = raw['error']
    return raw['ok'] === false && typeof code === 'string' && HELPER_CODES.has(code) ? (code as SystemTranslateFailure) : null
  }
  const onLine = (helper: Live, line: string): void => {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      raw = undefined
    }
    if (!isRecord(raw)) {
      settleAll(helper, () => ({ error: 'helper' }))
      return
    }
    if (!helper.greeted) {
      if (helper.hello) clearTimeout(helper.hello)
      helper.hello = null
      if (raw['ok'] === true && raw['protocol'] === SYSTEM_TRANSLATE_PROTOCOL) {
        helper.greeted = true
        return
      }
      // Lucium's helper that will not serve this process (`caller`): every request gets that answer, as one run would have given it.
      if (failureCode(raw) === 'caller') settleAll(helper, () => ({ answer: { ok: false, error: 'caller' } }))
      else refuse(helper)
      return
    }
    const id = raw['id']
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      // A line the helper could not read: it says why (a code), then quits. Every request gets that failure.
      const code = failureCode(raw)
      settleAll(helper, () => (code ? { answer: { ok: false, error: code } } : { error: 'helper' }))
      return
    }
    const waiting = helper.pending.get(id)
    // A request given up (stopped): its answer goes nowhere.
    if (!waiting) return
    helper.pending.delete(id)
    release(waiting)
    const answer: Record<string, unknown> = { ...raw }
    delete answer['id']
    waiting.resolve(answer)
    idleIfDone(helper)
  }
  const onData = (helper: Live, chunk: Buffer): void => {
    let from = 0
    for (let end = chunk.indexOf(0x0a); end !== -1 && !helper.over; end = chunk.indexOf(0x0a, from)) {
      const piece = chunk.subarray(from, end)
      from = end + 1
      // THE BOUND of an answer: a line longer than any answer is not one.
      if (helper.partialSize + piece.length > OUTPUT_LIMIT) {
        settleAll(helper, () => ({ error: 'helper' }))
        return
      }
      const line = Buffer.concat([...helper.partial, piece]).toString('utf8')
      helper.partial = []
      helper.partialSize = 0
      onLine(helper, line)
    }
    if (helper.over) return
    const rest = chunk.subarray(from)
    helper.partialSize += rest.length
    if (helper.partialSize > OUTPUT_LIMIT) {
      settleAll(helper, () => ({ error: 'helper' }))
      return
    }
    if (rest.length > 0) helper.partial.push(rest)
  }
  /** Starts a helper of protocol 2 (greeted by the first request); a failure kind when it may not or cannot be started. */
  const start = (): Live | SystemTranslateFailure => {
    if (!trusted()) return 'untrusted'
    let child: ReturnType<SpawnHelper>
    try {
      child = spawnHelper(executable, [], { stdio: ['pipe', 'pipe', 'ignore'], env: helperEnvironment() })
    } catch (error) {
      console.warn('[translate] the translation helper of the system could not be started:', error instanceof Error ? error.name : typeof error)
      return 'helper'
    }
    running.add(child)
    const helper: Live = { child, greeted: false, over: false, pending: new Map(), partial: [], partialSize: 0, idle: null, hello: null }
    child.stdout.on('data', (chunk: Buffer) => onData(helper, chunk))
    // The end of the helper (it quit, it was killed, it crashed): what still waits for it fails.
    const ended = (): void => {
      running.delete(child)
      if (!helper.over) settleAll(helper, () => ({ error: 'helper' }))
    }
    child.on('error', ended)
    child.on('close', ended)
    // A helper that quits before reading all its input breaks the pipe: that shows as its end above, not as a second error.
    child.stdin.on('error', () => undefined)
    return helper
  }
  /** The greeting, written once the first request waits for its answer (an answer to it may come at once). */
  const greet = (helper: Live): void => {
    helper.hello = setTimeout(() => refuse(helper), helloMs)
    helper.hello.unref?.()
    helper.child.stdin.write(`${JSON.stringify({ command: 'hello', protocol: SYSTEM_TRANSLATE_PROTOCOL })}\n`)
  }

  return (request, timeoutMs, signal) => {
    if (signal?.aborted) return Promise.reject(new SystemTranslateError('stopped'))
    if (live === null && (protocol() < SYSTEM_TRANSLATE_PROTOCOL || (refusedStamp !== null && refusedStamp === programStamp(executable)))) return oneAtATime(request, timeoutMs, signal)
    return new Promise((resolve, reject) => {
      const id = nextId++
      const line = `${JSON.stringify({ ...request, id })}\n`
      // THE GUARD of a line's size: the helper reads no line longer than its limit, so none is written.
      if (Buffer.byteLength(line) > SYSTEM_TRANSLATE_LIMITS.inputBytes) {
        reject(new SystemTranslateError('too-large'))
        return
      }
      const fresh = live === null
      const helper = live ?? start()
      if (typeof helper === 'string') {
        reject(new SystemTranslateError(helper))
        return
      }
      live = helper
      if (helper.idle) clearTimeout(helper.idle)
      helper.idle = null
      const waiting: Waiting = {
        request,
        timeoutMs,
        signal,
        resolve,
        reject,
        timer: setTimeout(() => settleAll(helper, (entry) => ({ error: entry === waiting ? 'timeout' : 'helper' })), timeoutMs),
        onAbort: () => {
          if (helper.pending.get(id) !== waiting) return
          helper.pending.delete(id)
          release(waiting)
          reject(new SystemTranslateError('stopped'))
          // Nothing left for anyone: its work is stopped with it.
          if (helper.pending.size === 0) finish(helper, true)
        }
      }
      waiting.timer.unref?.()
      helper.pending.set(id, waiting)
      signal?.addEventListener('abort', waiting.onAbort, { once: true })
      if (fresh) greet(helper)
      // The greeting's answer may have settled it already (one run per request, or `caller`): then there is nothing more to write.
      if (!helper.over) helper.child.stdin.write(line)
    })
  }
}

/** The helper of each program, made at its first request: one helper serves the requests of every page, one after the other. */
const services = new Map<string, SystemHelperRunner>()

/** The helper at `executable`, as the system's engine reaches it (engines.ts `systemEngineFor`). */
export function systemHelperFor(executable: string): SystemHelperRunner {
  let service = services.get(executable)
  if (!service) {
    service = systemHelperService(executable)
    services.set(executable, service)
  }
  return service
}

/** Where the helper is: Contents/Helpers/ of the built application (put there by the packaging), out-native/ when run from the sources. */
export function systemTranslateHelperPath(where: { built: boolean; resourcesPath: string; appPath: string }): string {
  const bundle = where.built ? join(where.resourcesPath, '..', 'Helpers', SYSTEM_TRANSLATE_HELPER_BUNDLE) : join(where.appPath, 'out-native', SYSTEM_TRANSLATE_HELPER_BUNDLE)
  return join(bundle, 'Contents', 'MacOS', SYSTEM_TRANSLATE_HELPER_EXECUTABLE)
}

/**
 * Whether `version` (`process.getSystemVersion()`: "26.1.0") is macOS 26 or later. Anything unreadable is not. A program linked with an SDK older
 * than 26 is told "16.x" by macOS 26 and later (the old numbering continued, SYSTEM_VERSION_COMPAT): no macOS 16 ever existed, so it counts as 26.
 * (Electron 45.2.1 is linked with the SDK 26.5 and reads the real number; another build of Electron may not.)
 */
export function hasSessionWithoutWindow(version: string): boolean {
  const major = /^(\d{1,3})(?:\.\d+)*$/.exec(version.trim())?.[1]
  return major !== undefined && (Number(major) >= SYSTEM_TRANSLATE_MIN_MACOS || Number(major) === 16)
}

/**
 * THE GUARD of "a batch beyond the helper's limits never reaches it": the number of texts, the characters of each and of all. Throws 'too-large'
 * before anything is started (the helper refuses the same, this keeps a process from being started for nothing).
 */
export function checkBatch(texts: readonly string[]): void {
  if (texts.length === 0 || texts.length > SYSTEM_TRANSLATE_LIMITS.texts) throw new SystemTranslateError('too-large')
  let total = 0
  for (const text of texts) {
    if (text.length > SYSTEM_TRANSLATE_LIMITS.textChars) throw new SystemTranslateError('too-large')
    total += text.length
  }
  if (total > SYSTEM_TRANSLATE_LIMITS.totalChars) throw new SystemTranslateError('too-large')
}

function failureOf(raw: Record<string, unknown>): SystemTranslateFailure {
  const code = raw['error']
  return typeof code === 'string' && HELPER_CODES.has(code) ? (code as SystemTranslateFailure) : 'helper'
}

/** The answer of an `availability`: a status, or the kind of failure. */
export function parseAvailabilityReply(raw: unknown): { ok: true; status: 'installed' | 'supported' | 'unsupported' } | { ok: false; error: SystemTranslateFailure } {
  if (!isRecord(raw)) return { ok: false, error: 'helper' }
  if (raw['ok'] !== true) return { ok: false, error: failureOf(raw) }
  const status = raw['status']
  return typeof status === 'string' && STATUSES.has(status) ? { ok: true, status: status as 'installed' | 'supported' | 'unsupported' } : { ok: false, error: 'helper' }
}

/** The answer of a `translate`: one string for each text sent (the controller checks their length and characters before the page sees them). */
export function parseTranslateReply(raw: unknown, count: number): { ok: true; texts: string[] } | { ok: false; error: SystemTranslateFailure } {
  if (!isRecord(raw)) return { ok: false, error: 'helper' }
  if (raw['ok'] !== true) return { ok: false, error: failureOf(raw) }
  const texts = raw['texts']
  return Array.isArray(texts) && texts.length === count && texts.every((text) => typeof text === 'string') ? { ok: true, texts: texts as string[] } : { ok: false, error: 'helper' }
}

/** The system's own translation as the controller uses it: no pack, no file of Lucium; the system has the languages, or says it has not. */
export interface SystemEngine {
  readonly id: 'system'
  readonly kind: SystemEngineKind
  /** What the system says of a pair. Never throws: a helper that fails is "unavailable", and the failure is logged (its kind). */
  availability(from: string, to: string): Promise<SystemAvailability>
  /** A model for a pair the system said is installed: its batches go to the helper of the page, several ahead (SYSTEM_TRANSLATE_PACE). */
  open(from: string, to: string): EngineModel
}

export interface MacTranslationOptions {
  /** The helper, found at each request (null: this build has none). Nothing is looked at before. */
  runner: () => SystemHelperRunner | null
  /** The version of macOS (`process.getSystemVersion()`). */
  systemVersion: () => string
  timeouts?: { availabilityMs: number; batchMs: number }
}

/** macOS's translation (Apple's Translation framework), through the helper. */
export function createMacTranslation(options: MacTranslationOptions): SystemEngine {
  const timeouts = options.timeouts ?? SYSTEM_TRANSLATE_TIMEOUTS
  /** The helper, only on a system that has the session it needs: on an older one nothing is started. */
  const helper = (): SystemHelperRunner | null => (hasSessionWithoutWindow(options.systemVersion()) ? options.runner() : null)
  return {
    id: 'system',
    kind: 'macos',
    async availability(from, to) {
      if (!isLanguageCode(from) || !isLanguageCode(to) || from === to) return 'unsupported'
      const run = helper()
      if (!run) return 'unavailable'
      try {
        const reply = parseAvailabilityReply(await run({ command: 'availability', from, to }, timeouts.availabilityMs))
        if (reply.ok) return reply.status
        if (reply.error !== 'unavailable') console.warn(`[translate] the translation of the system did not say whether it has ${from} → ${to}: ${reply.error}`)
        return 'unavailable'
      } catch (error) {
        console.warn(`[translate] the translation of the system did not say whether it has ${from} → ${to}: ${error instanceof SystemTranslateError ? error.kind : 'helper'}`)
        return 'unavailable'
      }
    },
    open(from, to) {
      return {
        async translate(texts, signal) {
          if (signal.aborted) throw new SystemTranslateError('stopped')
          checkBatch(texts)
          const run = helper()
          if (!run) throw new SystemTranslateError('unavailable')
          const reply = parseTranslateReply(await run({ command: 'translate', from, to, texts: [...texts] }, timeouts.batchMs, signal), texts.length)
          if (!reply.ok) throw new SystemTranslateError(reply.error)
          return reply.texts
        },
        // Nothing of the page is held here: the helper keeps the session of the pair, and quits by itself once idle.
        dispose: () => undefined,
        pace: SYSTEM_TRANSLATE_PACE
      }
    }
  }
}
