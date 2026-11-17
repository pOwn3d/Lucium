import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultEngines, systemEngineFor, type SystemEngineHost } from './engines'
import {
  SYSTEM_TRANSLATE_LIMITS,
  SystemTranslateError,
  checkBatch,
  createMacTranslation,
  hasSessionWithoutWindow,
  parseAvailabilityReply,
  parseTranslateReply,
  stopSystemTranslateHelpers,
  systemHelperRunner,
  systemTranslateHelperPath,
  type SpawnHelper,
  type SystemHelperRequest,
  type SystemHelperRunner
} from './system'

// The system's own translation (macOS's) through its helper, simulated: the helper is Swift and needs the system's languages, so the tests give a
// runner of their own (or a shell script standing for the helper). The text of a page is recognisable, so that a leak into a log or an argument is seen.
const SENTENCE = 'Le chat dort sur le canapé du salon.'
const HELPER = '/Applications/Lucium.app/Contents/Helpers/LuciumTranslate.app/Contents/MacOS/lucium-translate'
const STOP = new AbortController().signal

/** The helper and the system behind it, as main.swift and macOS behave: a pair is installed, supported or unsupported; a translation is upper case. */
class SimulatedHelper {
  status: 'installed' | 'supported' | 'unsupported' = 'installed'
  fails: string | null = null
  requests: SystemHelperRequest[] = []
  run: SystemHelperRunner = async (request) => {
    this.requests.push(request)
    if (this.fails) return { ok: false, error: this.fails }
    if (request.command === 'availability') return { ok: true, status: this.status }
    if (this.status !== 'installed') return { ok: false, error: this.status === 'supported' ? 'not-installed' : 'unsupported' }
    return { ok: true, texts: request.texts.map((text) => text.toUpperCase()) }
  }
}

let logs: unknown[][] = []
beforeEach(() => {
  logs = []
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args))
})
afterEach(() => vi.restoreAllMocks())
const logged = (): string => JSON.stringify(logs)

describe('the macOS version the system translation needs', () => {
  it('is macOS 26 or later (TranslationSession(installedSource:target:)); anything older or unreadable is not', () => {
    for (const version of ['26.0.0', '26.4', '27.2.0', '30.1']) expect(hasSessionWithoutWindow(version), version).toBe(true)
    for (const version of ['15.7.1', '14.6', '12.0.0', '10.16', '', 'unknown', '26a', '-26', ' ']) expect(hasSessionWithoutWindow(version), version).toBe(false)
  })

  it('counts the "16.x" macOS 26 and later tell a program linked with an older SDK as macOS 26 (no macOS 16 ever existed)', () => {
    for (const version of ['16.0', '16.0.0', '16.4']) expect(hasSessionWithoutWindow(version), version).toBe(true)
  })

  it('on a macOS older than 26, says "unavailable" and never starts the helper', async () => {
    const helper = new SimulatedHelper()
    const runner = vi.fn(() => helper.run)
    const engine = createMacTranslation({ runner, systemVersion: () => '15.7.1' })
    expect(await engine.availability('fr', 'en')).toBe('unavailable')
    await expect(engine.open('fr', 'en').translate([SENTENCE], STOP)).rejects.toMatchObject({ kind: 'unavailable' })
    expect(runner).not.toHaveBeenCalled()
    expect(helper.requests).toEqual([])
  })

  it('says "unavailable" when the build has no helper, and when the helper itself answers it (a framework older than its session)', async () => {
    expect(await createMacTranslation({ runner: () => null, systemVersion: () => '26.1.0' }).availability('fr', 'en')).toBe('unavailable')
    const helper = new SimulatedHelper()
    helper.fails = 'unavailable'
    expect(await createMacTranslation({ runner: () => helper.run, systemVersion: () => '26.1.0' }).availability('fr', 'en')).toBe('unavailable')
    // That one is no failure of the helper: nothing to log.
    expect(logs).toEqual([])
  })
})

describe('the system engine', () => {
  const engine = (helper: SimulatedHelper) => createMacTranslation({ runner: () => helper.run, systemVersion: () => '27.2.0' })

  it('says what the system has of a pair: installed, supported (to install in System Settings), unsupported', async () => {
    const helper = new SimulatedHelper()
    for (const status of ['installed', 'supported', 'unsupported'] as const) {
      helper.status = status
      expect(await engine(helper).availability('fr', 'en')).toBe(status)
    }
    expect(helper.requests).toEqual(Array.from({ length: 3 }, () => ({ command: 'availability', from: 'fr', to: 'en' })))
    // Not a pair of language codes: not asked.
    expect(await engine(helper).availability('fr', 'fr')).toBe('unsupported')
    expect(await engine(helper).availability('../x', 'en')).toBe('unsupported')
    expect(helper.requests).toHaveLength(3)
  })

  it('translates a batch in one run of the helper, one text for each text sent, in order', async () => {
    const helper = new SimulatedHelper()
    expect(await engine(helper).open('fr', 'en').translate([SENTENCE, 'Bonjour.'], STOP)).toEqual([SENTENCE.toUpperCase(), 'BONJOUR.'])
    expect(helper.requests).toEqual([{ command: 'translate', from: 'fr', to: 'en', texts: [SENTENCE, 'Bonjour.'] }])
  })

  it('refuses a batch beyond the helper’s limits before it starts the helper', async () => {
    const helper = new SimulatedHelper()
    const model = engine(helper).open('fr', 'en')
    const tooMany = Array.from({ length: SYSTEM_TRANSLATE_LIMITS.texts + 1 }, () => 'mot')
    const tooLong = ['x'.repeat(SYSTEM_TRANSLATE_LIMITS.textChars + 1)]
    const tooMuch = Array.from({ length: 7 }, () => 'x'.repeat(SYSTEM_TRANSLATE_LIMITS.textChars))
    for (const batch of [tooMany, tooLong, tooMuch, []]) await expect(model.translate(batch, STOP)).rejects.toMatchObject({ name: 'SystemTranslateError', kind: 'too-large' })
    expect(helper.requests).toEqual([])
    // At the limits exactly, it goes.
    expect(() => checkBatch(Array.from({ length: SYSTEM_TRANSLATE_LIMITS.texts }, () => 'x'.repeat(SYSTEM_TRANSLATE_LIMITS.totalChars / SYSTEM_TRANSLATE_LIMITS.texts)))).not.toThrow()
    // The controller's batches fit in them (shared/translate-local.ts: 48 texts, 3 000 characters, 1 500 a text).
    expect(SYSTEM_TRANSLATE_LIMITS.texts).toBeGreaterThanOrEqual(48)
    expect(SYSTEM_TRANSLATE_LIMITS.totalChars).toBeGreaterThanOrEqual(3000)
    expect(SYSTEM_TRANSLATE_LIMITS.textChars).toBeGreaterThanOrEqual(1500)
  })

  it('says why a translation failed by a kind, and never writes the text of the page in a log or an error', async () => {
    const helper = new SimulatedHelper()
    for (const [status, kind] of [['supported', 'not-installed'], ['unsupported', 'unsupported']] as const) {
      helper.status = status
      const failure = await engine(helper).open('fr', 'en').translate([SENTENCE], STOP).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(SystemTranslateError)
      expect(failure).toMatchObject({ kind })
      expect(String(failure)).not.toContain(SENTENCE)
    }
    // A helper that breaks while it is asked: unavailable, and the log says the pair and the kind only.
    const broken = createMacTranslation({ runner: () => async () => Promise.reject(new SystemTranslateError('timeout')), systemVersion: () => '26.0' })
    expect(await broken.availability('fr', 'en')).toBe('unavailable')
    expect(logged()).toContain('fr → en: timeout')
    helper.fails = 'rm -rf /'
    expect(await engine(helper).availability('fr', 'en')).toBe('unavailable')
    expect(logged()).toContain('fr → en: helper')
    expect(logged()).not.toContain(SENTENCE)
  })

  it('stops before the helper when the translation was stopped', async () => {
    const helper = new SimulatedHelper()
    const stopped = new AbortController()
    stopped.abort()
    await expect(engine(helper).open('fr', 'en').translate([SENTENCE], stopped.signal)).rejects.toMatchObject({ kind: 'stopped' })
    expect(helper.requests).toEqual([])
  })
})

describe('the answers of the helper', () => {
  it('take a status or a list of one string per text, and nothing else', () => {
    expect(parseAvailabilityReply({ ok: true, status: 'installed' })).toEqual({ ok: true, status: 'installed' })
    for (const raw of [{ ok: true, status: 'downloading' }, { ok: 'true', status: 'installed' }, { status: 'installed' }, null, 'installed', []]) expect(parseAvailabilityReply(raw).ok, JSON.stringify(raw)).toBe(false)
    expect(parseTranslateReply({ ok: true, texts: ['a', 'b'] }, 2)).toEqual({ ok: true, texts: ['a', 'b'] })
    for (const raw of [{ ok: true, texts: ['a'] }, { ok: true, texts: ['a', 3] }, { ok: true, texts: 'ab' }, { ok: 1, texts: ['a', 'b'] }, null]) expect(parseTranslateReply(raw, 2), JSON.stringify(raw)).toEqual({ ok: false, error: 'helper' })
  })

  it('keep the code of a failure the helper knows, and turn any other into "helper"', () => {
    for (const code of ['unavailable', 'not-installed', 'unsupported', 'too-large', 'invalid', 'cancelled', 'failed', 'error']) expect(parseTranslateReply({ ok: false, error: code }, 1)).toEqual({ ok: false, error: code })
    expect(parseTranslateReply({ ok: false, error: '<script>' }, 1)).toEqual({ ok: false, error: 'helper' })
    expect(parseAvailabilityReply({ ok: false, error: 'not-installed' })).toEqual({ ok: false, error: 'not-installed' })
  })
})

/** A child process that answers `answer` once its input is closed, and keeps what it was given. */
function fakeSpawn(answer: string) {
  const calls: Array<{ file: string; args: readonly string[]; options: unknown; input: string }> = []
  const spawnHelper: SpawnHelper = (file, args, options) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() })
    const call = { file, args, options, input: '' }
    calls.push(call)
    child.stdin.on('data', (chunk: Buffer) => void (call.input += chunk.toString('utf8')))
    child.stdin.on('finish', () => child.stdout.end(answer))
    child.stdout.on('end', () => child.emit('close', 0))
    return child as unknown as ReturnType<SpawnHelper>
  }
  return { calls, spawnHelper }
}

/** A signature check that says yes: these tests are about what the runner gives the program, helper-signature.test.ts about the check. */
const TRUSTED = (): boolean => true

describe('the runner of the helper', () => {
  it('gives the texts through the standard input, never as an argument, and lets the error output go nowhere', async () => {
    const { calls, spawnHelper } = fakeSpawn('{"ok":true,"texts":["The cat"]}\n')
    const answer = await systemHelperRunner(HELPER, spawnHelper, TRUSTED)({ command: 'translate', from: 'fr', to: 'en', texts: [SENTENCE] }, 1000)
    expect(answer).toEqual({ ok: true, texts: ['The cat'] })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toEqual([])
    expect(JSON.stringify([calls[0]!.file, calls[0]!.args])).not.toContain('chat')
    expect(JSON.parse(calls[0]!.input)).toEqual({ command: 'translate', from: 'fr', to: 'en', texts: [SENTENCE] })
    expect((calls[0]!.options as { stdio: unknown[] }).stdio).toEqual(['pipe', 'pipe', 'ignore'])
  })

  it('never starts a helper whose signature is not the expected one, and by default checks it', async () => {
    const { calls, spawnHelper } = fakeSpawn('{"ok":true,"texts":["The cat"]}\n')
    const request: SystemHelperRequest = { command: 'translate', from: 'fr', to: 'en', texts: [SENTENCE] }
    await expect(systemHelperRunner(HELPER, spawnHelper, () => false)(request, 1000)).rejects.toMatchObject({ name: 'SystemTranslateError', kind: 'untrusted' })
    // Without a check handed in, the one of helper-signature.ts runs: a program that is not there is not trusted, and is not started.
    await expect(systemHelperRunner('/nowhere/LuciumTranslate.app/Contents/MacOS/lucium-translate', spawnHelper)(request, 1000)).rejects.toMatchObject({ kind: 'untrusted' })
    expect(calls).toHaveLength(0)
  })

  it('stops the helpers still running when the application quits', async () => {
    const killed: string[] = []
    const spawnHelper: SpawnHelper = () => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        kill: vi.fn((signal: string) => {
          killed.push(signal)
          child.emit('close', null)
          return true
        })
      })
      return child as unknown as ReturnType<SpawnHelper>
    }
    const pending = systemHelperRunner(HELPER, spawnHelper, TRUSTED)({ command: 'availability', from: 'fr', to: 'en' }, 60_000)
    stopSystemTranslateHelpers()
    await expect(pending).rejects.toMatchObject({ kind: 'helper' })
    expect(killed).toEqual(['SIGKILL'])
  })

  describe('with a real program', () => {
    let dir = ''
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'lucium-system-translate-'))
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    /** A shell script standing for the helper: it writes down its argument count, its input and its environment, then answers. */
    function script(body: string): string {
      const path = join(dir, 'helper.sh')
      writeFileSync(path, `#!/bin/sh\nprintf '%s' "$#" > '${dir}/argc'\ncat > '${dir}/stdin'\nenv > '${dir}/env'\n${body}\n`)
      chmodSync(path, 0o700)
      return path
    }

    it('starts it with no argument, writes the request on its input, passes none of our variables, and reads its answer', async () => {
      process.env['LUCIUM_TRANSLATE_PROBE'] = 'must-not-reach-the-helper'
      try {
        const answer = await systemHelperRunner(script(`printf '{"ok":true,"status":"installed"}\\n'`), undefined, TRUSTED)({ command: 'availability', from: 'fr', to: 'en' }, 5000)
        expect(answer).toEqual({ ok: true, status: 'installed' })
      } finally {
        delete process.env['LUCIUM_TRANSLATE_PROBE']
      }
      expect(readFileSync(join(dir, 'argc'), 'utf8')).toBe('0')
      expect(JSON.parse(readFileSync(join(dir, 'stdin'), 'utf8'))).toEqual({ command: 'availability', from: 'fr', to: 'en' })
      expect(readFileSync(join(dir, 'env'), 'utf8')).not.toContain('LUCIUM_TRANSLATE_PROBE')
    })

    it('stops a helper that does not answer in time, and one whose translation was stopped', async () => {
      const started = Date.now()
      await expect(systemHelperRunner(script('exec sleep 30'), undefined, TRUSTED)({ command: 'availability', from: 'fr', to: 'en' }, 300)).rejects.toMatchObject({ name: 'SystemTranslateError', kind: 'timeout' })
      const stop = new AbortController()
      const running = systemHelperRunner(script('exec sleep 30'), undefined, TRUSTED)({ command: 'translate', from: 'fr', to: 'en', texts: [SENTENCE] }, 30_000, stop.signal)
      setTimeout(() => stop.abort(), 100)
      await expect(running).rejects.toMatchObject({ kind: 'stopped' })
      expect(Date.now() - started).toBeLessThan(5000)
    })

    it('refuses an answer too long, not JSON, or from a helper that failed, and a helper that is not there', async () => {
      const request: SystemHelperRequest = { command: 'availability', from: 'fr', to: 'en' }
      await expect(systemHelperRunner(script(`head -c 600000 /dev/zero | tr '\\0' 'a'`), undefined, TRUSTED)(request, 5000)).rejects.toMatchObject({ kind: 'helper' })
      await expect(systemHelperRunner(script(`printf 'not json'`), undefined, TRUSTED)(request, 5000)).rejects.toMatchObject({ kind: 'helper' })
      await expect(systemHelperRunner(script(`printf '{"ok":true}'; exit 3`), undefined, TRUSTED)(request, 5000)).rejects.toMatchObject({ kind: 'helper' })
      await expect(systemHelperRunner(join(dir, 'absent'), undefined, TRUSTED)(request, 5000)).rejects.toMatchObject({ kind: 'helper' })
    })
  })

  it('finds the helper in Contents/Helpers of the built application, in out-native from the sources', () => {
    expect(systemTranslateHelperPath({ built: true, resourcesPath: '/Applications/Lucium.app/Contents/Resources', appPath: '/x' })).toBe(HELPER)
    expect(systemTranslateHelperPath({ built: false, resourcesPath: '/r', appPath: '/src/lucium' })).toBe('/src/lucium/out-native/LuciumTranslate.app/Contents/MacOS/lucium-translate')
  })
})

describe('the system engine of each system', () => {
  const host: SystemEngineHost = { locate: () => HELPER, systemVersion: () => '27.2.0' }

  it('is macOS’s on macOS, tried before Bergamot and the glossary', () => {
    expect(systemEngineFor('darwin', host)?.kind).toBe('macos')
    expect(defaultEngines('darwin', host).order()).toEqual(['system', 'bergamot', 'glossary'])
  })

  it('is none on Windows and Linux: Bergamot comes first there, and the macOS helper is never looked for', () => {
    const locate = vi.fn(() => HELPER)
    for (const platform of ['win32', 'linux'] as const) {
      expect(systemEngineFor(platform, { ...host, locate })).toBeNull()
      expect(defaultEngines(platform, { ...host, locate }).order()).toEqual(['bergamot', 'glossary'])
      expect(defaultEngines(platform, { ...host, locate }).system).toBeNull()
    }
    expect(locate).not.toHaveBeenCalled()
  })

  it('looks for its helper only when it is asked something, never when it is made', async () => {
    const locate = vi.fn(() => null)
    const engine = systemEngineFor('darwin', { locate, systemVersion: () => '27.2.0' })!
    expect(locate).not.toHaveBeenCalled()
    expect(await engine.availability('fr', 'en')).toBe('unavailable')
    expect(locate).toHaveBeenCalledTimes(1)
  })
})
