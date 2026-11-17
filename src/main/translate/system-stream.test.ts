import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SYSTEM_TRANSLATE_LIMITS,
  SYSTEM_TRANSLATE_PROTOCOL,
  createMacTranslation,
  helperProtocol,
  stopSystemTranslateHelpers,
  systemHelperService,
  type HelperServiceOptions,
  type SpawnHelper,
  type SystemHelperRequest
} from './system'

// The helper that serves a page in one run (protocol 2, main.swift): one line of JSON for each request with its id, one for each answer. The helper
// is simulated (a child process of the test's own, or a shell script standing for it): the Swift one needs the languages of the system.
const SENTENCE = 'Le chat dort sur le canapé du salon.'
const HELPER = '/Applications/Lucium.app/Contents/Helpers/LuciumTranslate.app/Contents/MacOS/lucium-translate'
const AVAILABILITY: SystemHelperRequest = { command: 'availability', from: 'fr', to: 'en' }
const translate = (...texts: string[]): SystemHelperRequest => ({ command: 'translate', from: 'fr', to: 'en', texts })

let logs: unknown[][] = []
beforeEach(() => {
  logs = []
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args))
})
afterEach(() => {
  stopSystemTranslateHelpers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

interface FakeChild extends EventEmitter {
  stdin: PassThrough
  stdout: PassThrough
  kill: ReturnType<typeof vi.fn>
  /** The lines it was given, in order. */
  lines: string[]
  /** Its input was closed (it was told to quit). */
  ended: boolean
  killed: boolean
  args: readonly string[]
  options: unknown
  say(answer: unknown): void
  sayRaw(text: string): void
}

/**
 * A helper as main.swift behaves in protocol 2 (`answer: 'auto'`): it greets back, then answers each request in order with its id (a pair is
 * installed, a translation is upper case); with `answer: 'held'` the test answers. `greeting` replaces its answer to the greeting.
 */
function streamSpawn(options: { answer?: 'auto' | 'held'; greeting?: unknown } = {}) {
  const children: FakeChild[] = []
  const spawnHelper: SpawnHelper = (_file, args, spawnOptions) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      lines: [] as string[],
      ended: false,
      killed: false,
      args,
      options: spawnOptions
    }) as FakeChild
    child.say = (answer) => void child.stdout.write(`${JSON.stringify(answer)}\n`)
    child.sayRaw = (text) => void child.stdout.write(text)
    child.kill = vi.fn(() => {
      if (!child.killed) {
        child.killed = true
        setImmediate(() => child.emit('close', null))
      }
      return true
    })
    let buffer = ''
    child.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        child.lines.push(line)
        const request = JSON.parse(line) as Record<string, unknown>
        if (request['command'] === 'hello') {
          if ('greeting' in options) {
            if (options.greeting !== undefined) child.say(options.greeting)
          } else child.say({ ok: true, protocol: SYSTEM_TRANSLATE_PROTOCOL })
        } else if (options.answer !== 'held') {
          const id = request['id']
          child.say(request['command'] === 'availability' ? { ok: true, status: 'installed', id } : { ok: true, texts: (request['texts'] as string[]).map((text) => text.toUpperCase()), id })
        }
      }
    })
    child.stdin.on('finish', () => {
      child.ended = true
      setImmediate(() => child.emit('close', 0))
    })
    children.push(child)
    return child as unknown as ReturnType<SpawnHelper>
  }
  return { children, spawnHelper }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

const service = (spawnHelper: SpawnHelper, over: HelperServiceOptions = {}) => systemHelperService(HELPER, { spawnHelper, trusted: () => true, protocol: () => SYSTEM_TRANSLATE_PROTOCOL, ...over })

describe('a helper that serves a page (protocol 2)', () => {
  it('is started once for many requests, greeted first, and given each request on a line of its own with its id, never in an argument', async () => {
    const { children, spawnHelper } = streamSpawn()
    const trusted = vi.fn(() => true)
    const run = service(spawnHelper, { trusted })
    const answers = await Promise.all([run(AVAILABILITY, 1000), run(translate(SENTENCE), 1000), run(translate('Bonjour.', 'Merci.'), 1000)])
    expect(answers).toEqual([{ ok: true, status: 'installed' }, { ok: true, texts: [SENTENCE.toUpperCase()] }, { ok: true, texts: ['BONJOUR.', 'MERCI.'] }])
    expect(children).toHaveLength(1)
    // Its signature is checked when it is started, not for each request.
    expect(trusted).toHaveBeenCalledTimes(1)
    const [child] = children
    expect(child!.args).toEqual([])
    expect((child!.options as { stdio: unknown[] }).stdio).toEqual(['pipe', 'pipe', 'ignore'])
    expect(child!.lines.map((line) => JSON.parse(line))).toEqual([
      { command: 'hello', protocol: SYSTEM_TRANSLATE_PROTOCOL },
      { ...AVAILABILITY, id: 1 },
      { ...translate(SENTENCE), id: 2 },
      { ...translate('Bonjour.', 'Merci.'), id: 3 }
    ])
    expect(JSON.stringify(child!.args)).not.toContain('chat')
    // A later request (another page) goes to the same helper.
    expect(await run(AVAILABILITY, 1000)).toEqual({ ok: true, status: 'installed' })
    expect(children).toHaveLength(1)
  })

  it('gives each answer to the request of its id, whatever the order, and reads answers cut anywhere', async () => {
    const { children, spawnHelper } = streamSpawn({ answer: 'held' })
    const run = service(spawnHelper)
    const first = run(translate('Un.'), 1000)
    const second = run(translate('Deux.'), 1000)
    await settle()
    const child = children[0]!
    const [one, two] = child.lines.slice(1).map((line) => (JSON.parse(line) as { id: number }).id)
    child.sayRaw(`{"ok":true,"texts":["TWO"],"id":${two}}\n{"ok":true,"te`)
    child.sayRaw(`xts":["ONE"],"id":${one}}`)
    child.sayRaw('\n')
    expect(await first).toEqual({ ok: true, texts: ['ONE'] })
    expect(await second).toEqual({ ok: true, texts: ['TWO'] })
  })

  it('quits once idle: its input is closed after the idle time, and the next request starts another helper', async () => {
    const { children, spawnHelper } = streamSpawn()
    const run = service(spawnHelper, { idleMs: 40 })
    await run(AVAILABILITY, 1000)
    await new Promise((resolve) => setTimeout(resolve, 15))
    // A request within the idle time keeps it.
    await run(AVAILABILITY, 1000)
    expect(children[0]!.ended).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(children[0]!.ended).toBe(true)
    expect(children[0]!.killed).toBe(false)
    await run(AVAILABILITY, 1000)
    expect(children).toHaveLength(2)
  })

  it('stops a request at once on « Arrêter », gives the others their answers, and stops the helper when nothing is left for anyone', async () => {
    const { children, spawnHelper } = streamSpawn({ answer: 'held' })
    const run = service(spawnHelper)
    const stop = new AbortController()
    const stopped = run(translate('Un.'), 1000, stop.signal)
    const other = run(translate('Deux.'), 1000)
    await settle()
    const child = children[0]!
    stop.abort()
    await expect(stopped).rejects.toMatchObject({ name: 'SystemTranslateError', kind: 'stopped' })
    expect(child.killed).toBe(false)
    // The answer of the request given up goes nowhere; the other one gets its own.
    const [one, two] = child.lines.slice(1).map((line) => (JSON.parse(line) as { id: number }).id)
    child.say({ ok: true, texts: ['ONE'], id: one })
    child.say({ ok: true, texts: ['TWO'], id: two })
    expect(await other).toEqual({ ok: true, texts: ['TWO'] })
    // A request alone, stopped: the helper's work was for nobody, it is stopped.
    const alone = new AbortController()
    const last = run(translate('Trois.'), 1000, alone.signal)
    await settle()
    alone.abort()
    await expect(last).rejects.toMatchObject({ kind: 'stopped' })
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    // Stopped before it is sent: nothing is started.
    await expect(run(AVAILABILITY, 1000, alone.signal)).rejects.toMatchObject({ kind: 'stopped' })
    expect(children).toHaveLength(1)
  })

  it('stops a helper that does not answer in time: that request fails as "timeout", the others as "helper"', async () => {
    const { children, spawnHelper } = streamSpawn({ answer: 'held' })
    const run = service(spawnHelper)
    const slow = run(translate('Un.'), 30)
    const waiting = run(translate('Deux.'), 10_000)
    await expect(slow).rejects.toMatchObject({ kind: 'timeout' })
    await expect(waiting).rejects.toMatchObject({ kind: 'helper' })
    expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('refuses a request whose line would be longer than the helper reads, before it is written or a helper started', async () => {
    const { children, spawnHelper } = streamSpawn()
    const run = service(spawnHelper)
    const big = 'é'.repeat(SYSTEM_TRANSLATE_LIMITS.inputBytes / 2)
    await expect(run(translate(big), 1000)).rejects.toMatchObject({ kind: 'too-large' })
    expect(children).toHaveLength(0)
  })

  it('stops a helper whose answer is too long, is not JSON, or has no id; every request fails, but for a failure the helper names', async () => {
    const tooLong = streamSpawn({ answer: 'held' })
    const runLong = service(tooLong.spawnHelper)
    const pending = runLong(translate('Un.'), 1000)
    await settle()
    tooLong.children[0]!.sayRaw('a'.repeat(600 * 1024))
    await expect(pending).rejects.toMatchObject({ kind: 'helper' })
    expect(tooLong.children[0]!.kill).toHaveBeenCalled()

    const notJson = streamSpawn({ answer: 'held' })
    const runNotJson = service(notJson.spawnHelper)
    const garbled = runNotJson(translate('Un.'), 1000)
    await settle()
    notJson.children[0]!.sayRaw('not json\n')
    await expect(garbled).rejects.toMatchObject({ kind: 'helper' })

    // A line the helper could not read: it says why, without an id, and quits; each request gets that failure, and the engine its kind.
    const named = streamSpawn({ answer: 'held' })
    const runNamed = service(named.spawnHelper)
    const engine = createMacTranslation({ runner: () => runNamed, systemVersion: () => '27.2.0' })
    const batch = engine.open('fr', 'en').translate(['Un.'], new AbortController().signal)
    const asked = engine.availability('fr', 'en')
    await settle()
    named.children[0]!.say({ ok: false, error: 'too-large' })
    await expect(batch).rejects.toMatchObject({ kind: 'too-large' })
    expect(await asked).toBe('unavailable')
  })

  it('fails what waits for a helper that ends (it crashed, or the application quits), and starts a new one for the next request', async () => {
    const { children, spawnHelper } = streamSpawn({ answer: 'held' })
    const run = service(spawnHelper)
    const pending = run(translate('Un.'), 60_000)
    await settle()
    stopSystemTranslateHelpers()
    await expect(pending).rejects.toMatchObject({ kind: 'helper' })
    expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL')
    const next = run(AVAILABILITY, 1000)
    await settle()
    children[1]!.say({ ok: true, status: 'installed', id: 2 })
    expect(await next).toEqual({ ok: true, status: 'installed' })
  })

  it('never starts a helper whose signature is not the expected one', async () => {
    const { children, spawnHelper } = streamSpawn()
    await expect(service(spawnHelper, { trusted: () => false })(AVAILABILITY, 1000)).rejects.toMatchObject({ kind: 'untrusted' })
    expect(children).toHaveLength(0)
  })

  it('gives "caller" to every request when the helper will not serve this process, as one run would', async () => {
    const { spawnHelper } = streamSpawn({ greeting: { ok: false, error: 'caller' } })
    const run = service(spawnHelper)
    const engine = createMacTranslation({ runner: () => run, systemVersion: () => '27.2.0' })
    await expect(engine.open('fr', 'en').translate(['Un.'], new AbortController().signal)).rejects.toMatchObject({ kind: 'caller' })
  })
})

/** A helper of the first protocol: it reads its request until its input ends, answers once, and quits. */
function onceSpawn() {
  const runs: Array<{ input: string; args: readonly string[] }> = []
  let open = 0
  let most = 0
  const spawnHelper: SpawnHelper = (_file, args) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() })
    const run = { input: '', args }
    runs.push(run)
    open++
    most = Math.max(most, open)
    child.stdin.on('data', (chunk: Buffer) => void (run.input += chunk.toString('utf8')))
    child.stdin.on('finish', () => {
      setTimeout(() => {
        const request = JSON.parse(run.input) as Record<string, unknown>
        child.stdout.end(JSON.stringify(request['command'] === 'availability' ? { ok: true, status: 'installed' } : { ok: true, texts: (request['texts'] as string[]).map((text) => text.toUpperCase()) }))
      }, 5)
    })
    child.stdout.on('end', () => {
      open--
      child.emit('close', 0)
    })
    return child as unknown as ReturnType<SpawnHelper>
  }
  return { runs, spawnHelper, most: () => most }
}

describe('a helper of the first protocol (an older build of it)', () => {
  it('is run once per request, one run at a time, with the request alone on its input, as before', async () => {
    const helper = onceSpawn()
    const run = systemHelperService(HELPER, { spawnHelper: helper.spawnHelper, trusted: () => true, protocol: () => 1 })
    const answers = await Promise.all([run(translate('Un.'), 1000), run(translate('Deux.'), 1000), run(AVAILABILITY, 1000)])
    expect(answers).toEqual([{ ok: true, texts: ['UN.'] }, { ok: true, texts: ['DEUX.'] }, { ok: true, status: 'installed' }])
    expect(helper.runs.map((r) => JSON.parse(r.input))).toEqual([translate('Un.'), translate('Deux.'), AVAILABILITY])
    expect(helper.most()).toBe(1)
  })

  it('is taken for one when it does not answer the greeting as protocol 2: what it was given goes again, one run each, until its program changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lucium-helper-stamp-'))
    try {
      const program = join(dir, 'lucium-translate')
      writeFileSync(program, 'v1')
      // A helper that answers the greeting with something else, then (for the runs of the first protocol) answers once.
      const odd = streamSpawn({ greeting: { ok: false, error: 'invalid' } })
      const once = onceSpawn()
      let greeted = 0
      const spawnHelper: SpawnHelper = (file, args, options) => (greeted++ === 0 ? odd.spawnHelper(file, args, options) : once.spawnHelper(file, args, options))
      const run = systemHelperService(program, { spawnHelper, trusted: () => true, protocol: () => SYSTEM_TRANSLATE_PROTOCOL })
      expect(await Promise.all([run(translate('Un.'), 1000), run(translate('Deux.'), 1000)])).toEqual([{ ok: true, texts: ['UN.'] }, { ok: true, texts: ['DEUX.'] }])
      expect(odd.children[0]!.kill).toHaveBeenCalled()
      expect(once.runs).toHaveLength(2)
      expect(JSON.stringify(logs)).toContain('did not answer its greeting')
      // The same program: straight to one run per request.
      await run(AVAILABILITY, 1000)
      expect(once.runs).toHaveLength(3)
      expect(odd.children).toHaveLength(1)
      // A new build of it at the same place is greeted again (and this one does not answer in time either).
      writeFileSync(program, 'v2, a little longer')
      utimesSync(program, new Date(), new Date(Date.now() + 5000))
      const greeting = run(AVAILABILITY, 1000)
      await settle()
      expect(once.runs).toHaveLength(4)
      expect(once.runs[3]!.input.split('\n')[0]).toBe(JSON.stringify({ command: 'hello', protocol: SYSTEM_TRANSLATE_PROTOCOL }))
      await expect(greeting).rejects.toMatchObject({ kind: 'timeout' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is taken for one when it does not answer the greeting in time', async () => {
    // It answers nothing at all, the greeting included.
    const silent = streamSpawn({ greeting: undefined, answer: 'held' })
    const once = onceSpawn()
    let started = 0
    const spawnHelper: SpawnHelper = (file, args, options) => (started++ === 0 ? silent.spawnHelper(file, args, options) : once.spawnHelper(file, args, options))
    const run = systemHelperService(HELPER, { spawnHelper, trusted: () => true, protocol: () => SYSTEM_TRANSLATE_PROTOCOL, helloMs: 30 })
    expect(await run(translate('Un.'), 5000)).toEqual({ ok: true, texts: ['UN.'] })
    expect(silent.children[0]!.kill).toHaveBeenCalled()
  })
})

describe('the protocol a helper speaks', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lucium-helper-protocol-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const bundle = (plist: string | null): string => {
    const app = join(dir, `H${Math.random().toString(36).slice(2)}.app`)
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
    if (plist !== null) writeFileSync(join(app, 'Contents', 'Info.plist'), plist)
    return join(app, 'Contents', 'MacOS', 'lucium-translate')
  }

  it('is the one its bundle names, and the first one when it names none, cannot be read, or is too big to be a plist', () => {
    const repository = readFileSync(new URL('../../../native/system-translate/Info.plist', import.meta.url), 'utf8')
    expect(helperProtocol(bundle(repository))).toBe(SYSTEM_TRANSLATE_PROTOCOL)
    expect(helperProtocol(bundle(repository.replace(/\s*<key>LuciumTranslateProtocol<\/key>\s*<integer>2<\/integer>/, '')))).toBe(1)
    expect(helperProtocol(bundle(null))).toBe(1)
    expect(helperProtocol(bundle(`${repository}${' '.repeat(70 * 1024)}`))).toBe(1)
    expect(helperProtocol(bundle('<key>LuciumTranslateProtocol</key><string>2</string>'))).toBe(1)
  })

  it('says why when the Info.plist of the bundle is there and cannot be read, and only then', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const unreadable = bundle(null)
    // A folder where the file should be: there, and not readable as a file.
    mkdirSync(join(unreadable, '..', '..', 'Info.plist'))
    expect(helperProtocol(unreadable)).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[translate\] the protocol of the helper could not be read from its bundle/), expect.stringMatching(/EISDIR/))
    warn.mockClear()
    expect(helperProtocol(bundle(null))).toBe(1)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('with a real program standing for the helper (protocol 2)', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lucium-system-stream-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** A shell script that greets, answers each line with its id, counts the requests, and writes down its arguments and environment. */
  function script(): string {
    const path = join(dir, 'helper.sh')
    writeFileSync(
      path,
      [
        '#!/bin/sh',
        `printf '%s' "$#" > '${dir}/argc'`,
        `env > '${dir}/env'`,
        'IFS= read -r hello',
        `printf '%s' "$hello" > '${dir}/hello'`,
        `printf '{"ok":true,"protocol":2}\\n'`,
        'n=0',
        'while IFS= read -r line; do',
        `  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')`,
        '  n=$((n+1))',
        `  printf '{"ok":true,"status":"installed","id":%s}\\n' "$id"`,
        'done',
        `printf '%s' "$n" > '${dir}/count'`,
        ''
      ].join('\n')
    )
    chmodSync(path, 0o700)
    return path
  }

  it('serves every request in one run, gets nothing of our environment, and quits when its input is closed', async () => {
    process.env['LUCIUM_TRANSLATE_PROBE'] = 'must-not-reach-the-helper'
    const run = systemHelperService(script(), { trusted: () => true, protocol: () => SYSTEM_TRANSLATE_PROTOCOL, idleMs: 50 })
    try {
      expect(await Promise.all([run(AVAILABILITY, 5000), run(AVAILABILITY, 5000), run(AVAILABILITY, 5000)])).toEqual(Array.from({ length: 3 }, () => ({ ok: true, status: 'installed' })))
    } finally {
      delete process.env['LUCIUM_TRANSLATE_PROBE']
    }
    // Idle: its input closed, it quits by itself and says how many requests it served.
    for (let i = 0; i < 100 && !existsCount(dir); i++) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(readFileSync(join(dir, 'count'), 'utf8')).toBe('3')
    expect(readFileSync(join(dir, 'argc'), 'utf8')).toBe('0')
    expect(JSON.parse(readFileSync(join(dir, 'hello'), 'utf8'))).toEqual({ command: 'hello', protocol: SYSTEM_TRANSLATE_PROTOCOL })
    expect(readFileSync(join(dir, 'env'), 'utf8')).not.toContain('LUCIUM_TRANSLATE_PROBE')
  })
})

function existsCount(dir: string): boolean {
  try {
    readFileSync(join(dir, 'count'))
    return true
  } catch {
    return false
  }
}
