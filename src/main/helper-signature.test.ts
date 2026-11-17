import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CODESIGN, bundleOf, forgetHelperVerdicts, helperFilesFingerprint, helperRequirement, isTrustedHelper, teamOfProcess, type HelperIdentity, type RunCodesign } from './helper-signature'
import { tempDir } from './temp-dir'

const TEAM = 'ABCDE12345'
const HELPER: HelperIdentity = { executable: '/Applications/Lucium.app/Contents/Helpers/LuciumExample.app/Contents/MacOS/lucium-example', identifier: 'app.lucium.browser.example', adHoc: 'refuse' }

/** codesign as a test wants it to answer, keeping what it was asked. */
function codesign(status = 0, stderr = '') {
  const calls: string[][] = []
  const run: RunCodesign = (args) => {
    calls.push([...args])
    return { status, stderr }
  }
  return { calls, run }
}

beforeEach(() => {
  forgetHelperVerdicts()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('the team of the application', () => {
  it('is read by codesign on the running process, and is a team only when Apple gave one', () => {
    const { calls, run } = codesign(0, 'Executable=/Applications/Lucium.app/Contents/MacOS/Lucium\nIdentifier=app.lucium.browser\nTeamIdentifier=ABCDE12345\n')
    expect(teamOfProcess(4242, run)).toBe(TEAM)
    expect(calls).toEqual([['-d', '--verbose=2', '4242']])
    expect(teamOfProcess(1, codesign(0, 'Identifier=app.lucium.browser\nTeamIdentifier=not set\n').run)).toBeNull()
    expect(teamOfProcess(1, codesign(0, 'TeamIdentifier=ABCDE12345" or anchor apple\n').run)).toBeNull()
    expect(teamOfProcess(1, codesign(1, 'TeamIdentifier=ABCDE12345\n').run)).toBeNull()
  })
})

describe('the requirement of a helper', () => {
  it('names its identifier, Apple’s chain and the team of the application', () => {
    expect(helperRequirement('app.lucium.browser.example', TEAM)).toBe('identifier "app.lucium.browser.example" and anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"')
  })

  it('is never made from a text that could change its meaning', () => {
    expect(() => helperRequirement('x" or anchor apple or identifier "y', TEAM)).toThrow()
    expect(() => helperRequirement('app.lucium.browser.example', 'ABCDE12345" or anchor apple')).toThrow()
  })
})

describe('whether a helper may be started', () => {
  const same = () => 'same files'

  it('with a team: only a helper that codesign says meets the requirement, checked on its bundle', () => {
    const yes = codesign(0)
    expect(isTrustedHelper(HELPER, { run: yes.run, team: () => TEAM, fingerprint: same })).toBe(true)
    expect(yes.calls).toEqual([['--verify', '--strict', `-R=${helperRequirement(HELPER.identifier, TEAM)}`, '/Applications/Lucium.app/Contents/Helpers/LuciumExample.app']])
    forgetHelperVerdicts()
    expect(isTrustedHelper(HELPER, { run: codesign(3).run, team: () => TEAM, fingerprint: same })).toBe(false)
  })

  it('without a team: never a helper of the rule "refuse"; the translation helper only when its signature is intact under its identifier', () => {
    const asked = codesign(0)
    expect(isTrustedHelper(HELPER, { run: asked.run, team: () => null, fingerprint: same })).toBe(false)
    expect(asked.calls).toEqual([])
    const translate: HelperIdentity = { executable: '/A.app/Contents/Helpers/LuciumTranslate.app/Contents/MacOS/lucium-translate', identifier: 'app.lucium.browser.translate', adHoc: 'identifier' }
    expect(isTrustedHelper(translate, { run: asked.run, team: () => null, fingerprint: same })).toBe(true)
    expect(asked.calls).toEqual([['--verify', '--strict', '-R=identifier "app.lucium.browser.translate"', '/A.app/Contents/Helpers/LuciumTranslate.app']])
  })

  it('keeps its verdict while the files are the same, and checks again once they changed; a missing helper is not started', () => {
    const asked = codesign(0)
    let files = 'first'
    const deps = { run: asked.run, team: () => TEAM, fingerprint: () => files }
    expect(isTrustedHelper(HELPER, deps)).toBe(true)
    expect(isTrustedHelper(HELPER, deps)).toBe(true)
    expect(asked.calls).toHaveLength(1)
    files = 'replaced'
    expect(isTrustedHelper(HELPER, { ...deps, run: codesign(3).run })).toBe(false)
    expect(isTrustedHelper(HELPER, { ...deps, fingerprint: () => null })).toBe(false)
  })

  // The check runs codesign once per program, not once per start: the verdict is kept by its path, while its files keep their size and times.
  it('checks a program once per place and per change: again at another path, again once its program or its seal changed', () => {
    const dir = tempDir('lucium-helper-verdicts-')
    const make = (name: string): HelperIdentity => {
      const executable = join(dir, `${name}.app`, 'Contents', 'MacOS', 'helper')
      mkdirSync(join(dir, `${name}.app`, 'Contents', 'MacOS'), { recursive: true })
      mkdirSync(join(dir, `${name}.app`, 'Contents', '_CodeSignature'), { recursive: true })
      writeFileSync(executable, 'program')
      writeFileSync(join(dir, `${name}.app`, 'Contents', '_CodeSignature', 'CodeResources'), 'seal')
      writeFileSync(join(dir, `${name}.app`, 'Contents', 'Info.plist'), '<plist version="1.0"><dict/></plist>')
      return { executable, identifier: 'app.lucium.browser.translate', adHoc: 'identifier' }
    }
    const asked = codesign(0)
    const deps = { run: asked.run, team: () => null }
    const first = make('First')
    for (let i = 0; i < 5; i++) expect(isTrustedHelper(first, deps)).toBe(true)
    expect(asked.calls).toHaveLength(1)
    // The same program at another place is another program.
    expect(isTrustedHelper(make('Second'), deps)).toBe(true)
    expect(asked.calls).toHaveLength(2)
    // Its program touched (same bytes, another time of change): checked again, once.
    utimesSync(first.executable, new Date(), new Date(Date.now() + 60_000))
    expect(isTrustedHelper(first, deps)).toBe(true)
    expect(isTrustedHelper(first, deps)).toBe(true)
    expect(asked.calls).toHaveLength(3)
    // Its Info.plist rewritten (it names the protocol the helper speaks): checked again, once.
    writeFileSync(join(dir, 'First.app', 'Contents', 'Info.plist'), '<plist version="1.0"><dict><key>LuciumTranslateProtocol</key><integer>1</integer></dict></plist>')
    expect(isTrustedHelper(first, deps)).toBe(true)
    expect(isTrustedHelper(first, deps)).toBe(true)
    expect(asked.calls).toHaveLength(4)
    // Its seal rewritten: checked again, and refused this time.
    writeFileSync(join(dir, 'First.app', 'Contents', '_CodeSignature', 'CodeResources'), 'another seal')
    expect(isTrustedHelper(first, { ...deps, run: codesign(1).run })).toBe(false)
    expect(isTrustedHelper(first, { ...deps, run: asked.run })).toBe(false)
    expect(asked.calls).toHaveLength(4)
  })

  it('finds the bundle of a helper from its program', () => {
    expect(bundleOf(HELPER.executable)).toBe('/Applications/Lucium.app/Contents/Helpers/LuciumExample.app')
  })

  // The real codesign, on a bundle signed here ad hoc: the requirement is passed in the form codesign reads (`-R=<text>`), the identifier holds,
  // the team of a Developer ID does not, and a bundle changed after its signature is refused.
  it.runIf(process.platform === 'darwin' && existsSync(CODESIGN))('is decided by the real codesign: identifier yes, team no, changed bundle no', () => {
    const dir = tempDir('lucium-helper-signature-')
    const bundle = join(dir, 'Probe.app')
    const executable = join(bundle, 'Contents', 'MacOS', 'probe')
    mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(executable, '#!/bin/sh\nexit 0\n')
    chmodSync(executable, 0o755)
    writeFileSync(join(bundle, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.lucium.probe</string><key>CFBundleExecutable</key><string>probe</string></dict></plist>\n')
    expect(spawnSync(CODESIGN, ['--force', '--sign', '-', '--identifier', 'test.lucium.probe', bundle]).status).toBe(0)
    const probe: HelperIdentity = { executable, identifier: 'test.lucium.probe', adHoc: 'identifier' }
    expect(isTrustedHelper(probe, { team: () => null })).toBe(true)
    forgetHelperVerdicts()
    expect(isTrustedHelper({ ...probe, identifier: 'test.lucium.other' }, { team: () => null })).toBe(false)
    forgetHelperVerdicts()
    expect(isTrustedHelper(probe, { team: () => TEAM })).toBe(false)
    forgetHelperVerdicts()
    writeFileSync(executable, '#!/bin/sh\necho replaced\n')
    expect(isTrustedHelper(probe, { team: () => null })).toBe(false)
  })
})

describe('what identifies the files of a helper', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  /** A bundle on the disk, with its program, its seal and its Info.plist. */
  const bundle = (): { executable: string; contents: string } => {
    const root = mkdtempSync(join(tmpdir(), 'lucium-helper-'))
    dirs.push(root)
    const contents = join(root, 'Translate.app', 'Contents')
    mkdirSync(join(contents, 'MacOS'), { recursive: true })
    mkdirSync(join(contents, '_CodeSignature'), { recursive: true })
    writeFileSync(join(contents, 'MacOS', 'translate'), 'program')
    writeFileSync(join(contents, '_CodeSignature', 'CodeResources'), 'seal')
    writeFileSync(join(contents, 'Info.plist'), '<plist><key>Protocol</key><integer>2</integer></plist>')
    return { executable: join(contents, 'MacOS', 'translate'), contents }
  }

  it('is the same while nothing changes', () => {
    const { executable } = bundle()
    expect(helperFilesFingerprint(executable)).toBe(helperFilesFingerprint(executable))
    expect(helperFilesFingerprint(executable)!.split('|')).toHaveLength(3)
  })

  // Info.plist says which protocol the helper speaks and is read before each start: a rewrite of it must send the bundle back to codesign.
  it('changes when the program, the seal or Info.plist is rewritten, so that codesign is asked again', () => {
    for (const file of [['MacOS', 'translate'], ['_CodeSignature', 'CodeResources'], ['Info.plist']]) {
      const { executable, contents } = bundle()
      const before = helperFilesFingerprint(executable)
      writeFileSync(join(contents, ...file), 'rewritten, and longer than it was')
      expect(helperFilesFingerprint(executable), file.join('/')).not.toBe(before)
    }
  })

  it('is null, and the helper is not started, when one of the three is missing', () => {
    for (const file of [['MacOS', 'translate'], ['_CodeSignature', 'CodeResources'], ['Info.plist']]) {
      const { executable, contents } = bundle()
      rmSync(join(contents, ...file))
      expect(helperFilesFingerprint(executable), file.join('/')).toBeNull()
      expect(isTrustedHelper({ ...HELPER, executable }, { run: codesign(0).run, team: () => TEAM })).toBe(false)
    }
  })
})

