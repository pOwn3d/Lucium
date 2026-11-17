import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_NOTARY_PROFILE,
  assessProblem,
  cdhashOf,
  chooseIdentity,
  commandLine,
  describeDmgFailure,
  developerIdentities,
  dmgNameOf,
  imageRecordNameOf,
  dmgPlan,
  makeDmg,
  notaryProblem,
  parseDmgArgs,
  parseNotaryAnswer,
  plistCommand,
  realDmgDeps,
  resolveDmgInput,
  shellWord,
  stapleValidateCommand,
  sumLineOf,
  sumNameOf,
  versionProblem,
  volumeNameOf,
  type Command,
  type CommandResult,
  type DmgDeps,
  type DmgInput
} from './make-dmg'

// The disk image of a release (scripts/make-dmg.mjs). Nothing here touches a keychain, Apple or the disk: the commands are planned and checked as
// text, and the order of the steps is run against fake effects that record what would have been run.
const VERSION = '0.2.12'
const APP = '/repo/dist-drm/mac-arm64/Lucium.app'
const OUT = '/repo/dist-drm'
const TMP = '/var/tmp-root'
const WORK = `${TMP}/lucium-dmg-${VERSION}-aB3dEf`
// Made-up identities: the real one is in the keychain of the Mac that builds.
const IDENTITY = 'Developer ID Application: Example Org (ABCDE12345)'
const OTHER_IDENTITY = 'Developer ID Application: Other Org (ZYXWV98765)'
const listing = (...names: string[]): string => `${names.map((name, at) => `  ${at + 1}) ${String(at).repeat(40).replace(/\d/g, 'A')} "${name}"`).join('\n')}\n     ${names.length} valid identities found\n`
const LISTING = listing('Apple Development: Someone (AAAAAAAAAA)', 'Apple Distribution: Example Org (ABCDE12345)', IDENTITY)
const CDHASH = '1234567890abcdef1234567890abcdef12345678'
const INPUT: DmgInput = { version: VERSION, app: APP, outDir: OUT, tmpRoot: TMP, signIdentity: null, notaryProfile: 'lucium', dryRun: false }
const PLAN = dmgPlan({ app: APP, work: WORK, outDir: OUT, version: VERSION, identity: IDENTITY, profile: 'lucium' })
const DMG = `Lucium-${VERSION}-arm64.dmg`
const HASH = 'a'.repeat(64)
const SIZE = 141_000_017
const EXECUTABLE = { sha256: 'e'.repeat(64), size: 91_024 }

describe('the names', () => {
  it('name the image after the version, its sum beside it, and its volume with a space', () => {
    expect(dmgNameOf(VERSION)).toBe('Lucium-0.2.12-arm64.dmg')
    expect(sumNameOf(VERSION)).toBe('Lucium-0.2.12-arm64.dmg.sha256')
    expect(volumeNameOf(VERSION)).toBe('Lucium 0.2.12')
  })

  it('write the sum as "<hash>  <name>" and a newline, which is what shasum -a 256 -c reads', () => {
    expect(sumLineOf(HASH, DMG)).toBe(`${HASH}  ${DMG}\n`)
    const dir = mkdtempSync(join(tmpdir(), 'make-dmg-sum-'))
    try {
      writeFileSync(join(dir, DMG), 'the image')
      const hash = createHash('sha256').update('the image').digest('hex')
      writeFileSync(join(dir, sumNameOf(VERSION)), sumLineOf(hash, DMG))
      const good = spawnSync('shasum', ['-a', '256', '-c', sumNameOf(VERSION)], { cwd: dir, encoding: 'utf8' })
      expect(good.status).toBe(0)
      expect(good.stdout).toBe(`${DMG}: OK\n`)
      writeFileSync(join(dir, sumNameOf(VERSION)), sumLineOf(HASH, DMG))
      expect(spawnSync('shasum', ['-a', '256', '-c', sumNameOf(VERSION)], { cwd: dir, encoding: 'utf8' }).status).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the arguments', () => {
  it('default to a real run of the built app', () => {
    expect(parseDmgArgs([])).toEqual({ ok: true, options: { dryRun: false, help: false, app: null } })
  })

  it('read the flags and --app, separate or after "="', () => {
    expect(parseDmgArgs(['--dry-run', '--app', 'x/Lucium.app'])).toEqual({ ok: true, options: { dryRun: true, help: false, app: 'x/Lucium.app' } })
    expect(parseDmgArgs(['--app=y/Lucium.app'])).toMatchObject({ ok: true, options: { app: 'y/Lucium.app' } })
    expect(parseDmgArgs(['--help'])).toMatchObject({ ok: true, options: { help: true } })
    expect(parseDmgArgs(['-h'])).toMatchObject({ ok: true, options: { help: true } })
  })

  it('refuse an unknown option, a missing value (also when the next word is an option) and a loose argument', () => {
    expect(parseDmgArgs(['--publish'])).toEqual({ ok: false, message: 'Unknown option: --publish' })
    expect(parseDmgArgs(['-x'])).toEqual({ ok: false, message: 'Unknown option: -x' })
    expect(parseDmgArgs(['--app'])).toEqual({ ok: false, message: '--app needs a value' })
    expect(parseDmgArgs(['--app', '--dry-run'])).toEqual({ ok: false, message: '--app needs a value' })
    expect(parseDmgArgs(['--app='])).toEqual({ ok: false, message: '--app needs a value' })
    const loose = parseDmgArgs(['dist-drm/Lucium.app'])
    expect(loose.ok).toBe(false)
    expect(loose.ok ? '' : loose.message).toMatch(/Unexpected argument: dist-drm\/Lucium\.app/)
  })
})

describe('the input', () => {
  const env = { cwd: '/work', root: '/repo', tmpRoot: TMP, version: VERSION, signIdentity: undefined as string | undefined, notaryProfile: undefined as string | undefined }
  const options = { dryRun: false, help: false, app: null as string | null }

  it('defaults to the built app of dist-drm, the image in dist-drm, the profile lucium and the first identity of the keychain', () => {
    expect(resolveDmgInput(options, env)).toEqual(INPUT)
    expect(DEFAULT_NOTARY_PROFILE).toBe('lucium')
  })

  it('reads the profile and the identity from the environment, a name each, and an empty variable is no variable', () => {
    expect(resolveDmgInput(options, { ...env, notaryProfile: 'my-profile', signIdentity: IDENTITY })).toMatchObject({ notaryProfile: 'my-profile', signIdentity: IDENTITY })
    expect(resolveDmgInput(options, { ...env, notaryProfile: ' my profile\n' })).toMatchObject({ notaryProfile: 'myprofile' })
    expect(resolveDmgInput(options, { ...env, notaryProfile: '  ', signIdentity: ' ' })).toMatchObject({ notaryProfile: 'lucium', signIdentity: null })
  })

  it('resolves --app against the folder the command is run from, and keeps the image in dist-drm', () => {
    expect(resolveDmgInput({ ...options, app: 'out/Lucium.app', dryRun: true }, env)).toMatchObject({ app: '/work/out/Lucium.app', outDir: '/repo/dist-drm', dryRun: true })
    expect(resolveDmgInput({ ...options, app: '/abs/Lucium.app' }, env).app).toBe('/abs/Lucium.app')
  })
})

describe('the signing identity', () => {
  it('lists the Developer ID Application identities of the keychain, in order, and no other', () => {
    expect(developerIdentities(LISTING)).toEqual([IDENTITY])
    expect(developerIdentities(listing(OTHER_IDENTITY, 'Apple Development: Someone (AAAAAAAAAA)', IDENTITY))).toEqual([OTHER_IDENTITY, IDENTITY])
    expect(developerIdentities('')).toEqual([])
    expect(developerIdentities('  1) not-a-hash "Developer ID Application: X (ABCDE12345)"')).toEqual([])
  })

  it('takes the first Developer ID Application identity, and says when there are several', () => {
    expect(chooseIdentity(LISTING, null)).toEqual({ ok: true, identity: IDENTITY, note: null })
    const two = chooseIdentity(listing(OTHER_IDENTITY, IDENTITY), null)
    expect(two).toEqual({ ok: true, identity: OTHER_IDENTITY, note: expect.stringContaining('2 Developer ID Application identities: the first one is used (set LUCIUM_SIGN_IDENTITY to choose)') })
  })

  it('takes LUCIUM_SIGN_IDENTITY when it is set, even when it is not the first', () => {
    expect(chooseIdentity(listing(OTHER_IDENTITY, IDENTITY), IDENTITY)).toEqual({ ok: true, identity: IDENTITY, note: null })
  })

  it('refuses a chosen identity that the keychain does not hold, never replacing it by another one', () => {
    const refused = chooseIdentity(LISTING, OTHER_IDENTITY)
    expect(refused.ok ? '' : refused.message).toMatch(/LUCIUM_SIGN_IDENTITY is not a valid code-signing identity of the keychain/)
    // A part of a name is not a name: codesign would take it for a search.
    for (const part of ['Developer ID Application', 'Example Org', IDENTITY.slice(0, -1)]) {
      const partial = chooseIdentity(LISTING, part)
      expect(partial.ok, part).toBe(false)
      expect(partial.ok ? '' : partial.message, part).toMatch(/is not a valid code-signing identity of the keychain/)
    }
  })

  it('refuses a chosen identity that is not a Developer ID Application: Apple notarizes only what one signed', () => {
    const refused = chooseIdentity(LISTING, 'Apple Distribution: Example Org (ABCDE12345)')
    expect(refused.ok ? '' : refused.message).toMatch(/is not a "Developer ID Application" identity/)
  })

  it('refuses a keychain without a Developer ID Application identity', () => {
    const refused = chooseIdentity(listing('Apple Development: Someone (AAAAAAAAAA)'), null)
    expect(refused.ok ? '' : refused.message).toMatch(/no "Developer ID Application" identity in the keychain/)
    expect(chooseIdentity('', null).ok).toBe(false)
  })
})

describe('the commands', () => {
  const lines = (): string[] => Object.values(PLAN).filter((value): value is Command => typeof value === 'object').map(commandLine)

  it('copies the app with ditto and a link to /Applications into a staging folder of the work folder', () => {
    expect(PLAN.stage).toBe(`${WORK}/stage`)
    expect(PLAN.staged).toBe(`${WORK}/stage/Lucium.app`)
    expect(PLAN.makeStage).toMatchObject({ program: '/bin/mkdir', args: [`${WORK}/stage`] })
    expect(PLAN.copyApp).toMatchObject({ program: '/usr/bin/ditto', args: [APP, `${WORK}/stage/Lucium.app`] })
    expect(PLAN.linkApplications).toMatchObject({ program: '/bin/ln', args: ['-s', '/Applications', `${WORK}/stage/Applications`] })
  })

  it('makes an HFS+ compressed image named after the version, from the staging folder, in the work folder', () => {
    expect(PLAN.create).toMatchObject({ program: '/usr/bin/hdiutil', args: ['create', '-volname', 'Lucium 0.2.12', '-srcfolder', `${WORK}/stage`, '-fs', 'HFS+', '-format', 'UDZO', `${WORK}/${DMG}`] })
    expect(commandLine(PLAN.create)).toBe(`/usr/bin/hdiutil create -volname 'Lucium 0.2.12' -srcfolder ${WORK}/stage -fs HFS+ -format UDZO ${WORK}/${DMG}`)
  })

  it('signs the image with the identity and a timestamp', () => {
    expect(PLAN.sign).toMatchObject({ program: '/usr/bin/codesign', args: ['--sign', IDENTITY, '--timestamp', `${WORK}/${DMG}`] })
  })

  it('has it notarized with the keychain profile, waits for the answer and asks for it as JSON', () => {
    expect(PLAN.submit).toMatchObject({ program: 'xcrun', args: ['notarytool', 'submit', `${WORK}/${DMG}`, '--keychain-profile', 'lucium', '--wait', '--output-format', 'json'] })
  })

  it('staples and validates the ticket, and asks Gatekeeper about the image as if it were opened', () => {
    expect(PLAN.staple).toMatchObject({ program: 'xcrun', args: ['stapler', 'staple', `${WORK}/${DMG}`] })
    expect(PLAN.validateDmg).toMatchObject({ program: 'xcrun', args: ['stapler', 'validate', `${WORK}/${DMG}`] })
    expect(PLAN.assess).toMatchObject({ program: '/usr/sbin/spctl', args: ['-a', '-t', 'open', '--context', 'context:primary-signature', '-v', `${WORK}/${DMG}`] })
  })

  it('moves the finished image to dist-drm, and names its sum beside it', () => {
    expect(PLAN.moveDmg).toMatchObject({ program: '/bin/mv', args: ['-f', `${WORK}/${DMG}`, `${OUT}/${DMG}`] })
    expect(PLAN.finalDmg).toBe(`${OUT}/${DMG}`)
    expect(PLAN.finalSum).toBe(`${OUT}/${DMG}.sha256`)
  })

  it('reads the version and the ticket of an app, as publish-update.mjs does', () => {
    expect(plistCommand(APP)).toMatchObject({ program: '/usr/bin/plutil', args: ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', `${APP}/Contents/Info.plist`] })
    expect(stapleValidateCommand(APP)).toMatchObject({ program: 'xcrun', args: ['stapler', 'validate', APP] })
  })

  it('gives the notary service a profile name and nothing else: no password, no Apple ID, no key, no team', () => {
    for (const command of Object.values(PLAN).filter((value): value is Command => typeof value === 'object')) {
      for (const arg of command.args) expect(arg, commandLine(command)).not.toMatch(/^--(password|apple-id|team-id|key|key-id|issuer)\b/)
    }
    expect(PLAN.submit.args.filter((arg) => arg.startsWith('--'))).toEqual(['--keychain-profile', '--wait', '--output-format'])
  })

  it('prints commands that can be pasted', () => {
    expect(shellWord('Lucium 0.2.12')).toBe("'Lucium 0.2.12'")
    expect(shellWord('plain-1.2/x')).toBe('plain-1.2/x')
    expect(lines().find((line) => line.includes('--sign'))).toBe(`/usr/bin/codesign --sign '${IDENTITY}' --timestamp ${WORK}/${DMG}`)
  })

  it('works only in the work folder until the very end: the image is in dist-drm after the move and not before', () => {
    const inOut = Object.entries(PLAN)
      .filter((entry): entry is [string, Command] => typeof entry[1] === 'object')
      .filter(([, command]) => command.args.some((arg) => arg === PLAN.finalDmg || arg === PLAN.finalSum))
      .map(([name]) => name)
    expect(inOut).toEqual(['moveDmg'])
  })
})

describe('the checks', () => {
  it('want the built app to be the version of package.json, three numbers', () => {
    expect(versionProblem(VERSION, VERSION)).toBeNull()
    expect(versionProblem(VERSION, '0.2.11')).toMatch(/the built app is 0\.2\.11, package\.json says 0\.2\.12: .*build it again/)
    for (const version of ['0.2', '0.2.12-beta.1', 'v0.2.12', '0.2.12 ', '', '0.2.x']) expect(versionProblem(version, version), version).toMatch(/not x\.y\.z/)
  })

  it('read the CDHash of a signature, and nothing else', () => {
    expect(cdhashOf(`Executable=/x/Lucium\nIdentifier=app.lucium.browser\nCDHash=${CDHASH}\nSigned Time=1 Nov 2026\n`)).toBe(CDHASH)
    expect(cdhashOf('CandidateCDHash sha256=abcdef\nno hash here')).toBeNull()
    expect(cdhashOf('')).toBeNull()
  })

  it('read the answer of the notary service: the status and the id, or nothing when it is not JSON', () => {
    expect(parseNotaryAnswer('{"id":"sub-1","status":"Accepted","message":"ok"}')).toEqual({ status: 'Accepted', id: 'sub-1' })
    expect(parseNotaryAnswer('{"id":7,"status":["Accepted"]}')).toEqual({ status: '', id: '' })
    for (const text of ['', 'Error: no credentials', '[]', 'null', '"Accepted"']) expect(parseNotaryAnswer(text), text).toEqual({ status: '', id: '' })
  })

  it('accept the image only when Apple said Accepted and notarytool succeeded', () => {
    expect(notaryProblem({ status: 'Accepted', id: 'sub-1' }, 0, 'lucium')).toBeNull()
    expect(notaryProblem({ status: 'Invalid', id: 'sub-1' }, 0, 'lucium')).toMatch(/Apple did not accept the image \(Invalid\)\n.*xcrun notarytool log sub-1 --keychain-profile lucium/)
    // notarytool failed after the status was written, or was killed: not accepted, whatever the JSON says.
    expect(notaryProblem({ status: 'Accepted', id: 'sub-1' }, 1, 'lucium')).toMatch(/Apple did not accept the image \(Accepted\)/)
    expect(notaryProblem({ status: '', id: '' }, 69, 'lucium')).toBe('Apple did not accept the image (notarytool exit code 69)')
    expect(notaryProblem({ status: '', id: '' }, null, 'lucium')).toMatch(/exit code none \(timeout or not started\)/)
  })

  it('accept the image only when Gatekeeper accepts it as notarized', () => {
    const verdict = (status: number | null, stderr: string): CommandResult => ({ status, stdout: '', stderr })
    expect(assessProblem(verdict(0, `${DMG}: accepted\nsource=Notarized Developer ID\n`))).toBeNull()
    expect(assessProblem(verdict(3, `${DMG}: rejected\nsource=no usable signature\n`))).toMatch(/Gatekeeper refuses the image \(spctl exit code 3\): .*rejected/)
    expect(assessProblem(verdict(null, ''))).toMatch(/exit code none/)
    // Signed with a Developer ID and not notarized: accepted as plain "Developer ID", which is not enough.
    expect(assessProblem(verdict(0, `${DMG}: accepted\nsource=Developer ID\n`))).toMatch(/accepts the image but not as notarized/)
    expect(assessProblem({ status: 0, stdout: `${DMG}: accepted\nsource=Notarized Developer ID\n`, stderr: '' })).toBeNull()
  })

  it('says what dist-drm holds when it stops', () => {
    expect(describeDmgFailure({ step: 'Sign the disk image', problem: 'codesign failed: x', touchedOutput: false }, OUT)).toBe(`FAILED at "Sign the disk image": codesign failed: x\nNothing was written to ${OUT}.`)
    expect(describeDmgFailure({ step: 'Put the image and its sum in dist-drm', problem: 'x', touchedOutput: true }, OUT)).toMatch(/dist-drm may hold a part of the result \(the image without its sum or its record\): remove them and run the command again/)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The run

type Kind =
  | 'plutil'
  | 'stapler-app'
  | 'identities'
  | 'mkdir'
  | 'ditto'
  | 'ln'
  | 'verify-staged'
  | 'sig-app'
  | 'sig-staged'
  | 'stapler-staged'
  | 'create'
  | 'sign'
  | 'submit'
  | 'staple'
  | 'stapler-dmg'
  | 'assess'
  | 'move'

function kindOf(command: Command): Kind {
  const last = command.args[command.args.length - 1]
  switch (command.program) {
    case '/usr/bin/plutil':
      return 'plutil'
    case '/usr/bin/security':
      return 'identities'
    case '/bin/mkdir':
      return 'mkdir'
    case '/usr/bin/ditto':
      return 'ditto'
    case '/bin/ln':
      return 'ln'
    case '/usr/bin/hdiutil':
      return 'create'
    case '/usr/sbin/spctl':
      return 'assess'
    case '/bin/mv':
      return 'move'
    case '/usr/bin/codesign':
      if (command.args[0] === '--verify') return 'verify-staged'
      if (command.args[0] === '--sign') return 'sign'
      return last === APP ? 'sig-app' : 'sig-staged'
    case 'xcrun':
      if (command.args[0] === 'notarytool') return 'submit'
      if (command.args[1] === 'staple') return 'staple'
      return last === APP ? 'stapler-app' : last === PLAN.staged ? 'stapler-staged' : 'stapler-dmg'
    default:
      throw new Error(`unexpected command ${commandLine(command)}`)
  }
}

const done = (stdout = '', status: number | null = 0, stderr = ''): CommandResult => ({ status, stdout, stderr })
const signature = (hash = CDHASH): CommandResult => done('', 0, `Executable=/x/Lucium\nIdentifier=app.lucium.browser\nCDHash=${hash}\nTeamIdentifier=ABCDE12345\n`)
const accepted = JSON.stringify({ id: 'sub-1', status: 'Accepted', message: 'Successfully received submission info' })

interface World {
  results?: Partial<Record<Kind, CommandResult>>
  missing?: string[]
  weight?: { sha256: string; size: number }
  unreadable?: boolean
  /** The executable of the copy of the app cannot be read. */
  unreadableExecutable?: boolean
  removeFails?: boolean
}

/** A world where everything goes well, and what each test changes. Records every command that was run, in order, and every file touched. */
function world(change: World = {}) {
  const ran: Command[] = []
  const said: string[] = []
  const written: Record<string, string> = {}
  const weighed: string[] = []
  const removedDirs: string[] = []
  const removedFiles: string[] = []
  const madeDirs: string[] = []
  const missing = new Set(change.missing ?? [])
  const defaults: Record<Kind, CommandResult> = {
    plutil: done(`${VERSION}\n`),
    'stapler-app': done('The validate action worked!\n'),
    identities: done(LISTING),
    mkdir: done(),
    ditto: done(),
    ln: done(),
    'verify-staged': done('', 0, `${PLAN.staged}: valid on disk\n`),
    'sig-app': signature(),
    'sig-staged': signature(),
    'stapler-staged': done('The validate action worked!\n'),
    create: done('created: x.dmg\n'),
    sign: done('', 0, `${PLAN.workDmg}: signed Disk Image [UDIF]\n`),
    submit: done(accepted),
    staple: done('The staple and validate action worked!\n'),
    'stapler-dmg': done(`Processing: ${PLAN.workDmg}\nThe validate action worked!\n`),
    assess: done('', 0, `${PLAN.workDmg}: accepted\nsource=Notarized Developer ID\n`),
    move: done()
  }
  const deps: DmgDeps = {
    say: (line) => said.push(line),
    exists: (path) => !missing.has(path),
    run: (command) => {
      ran.push(command)
      return { ...defaults[kindOf(command)], ...change.results?.[kindOf(command)] }
    },
    makeTempDir: (prefix) => {
      madeDirs.push(prefix)
      return WORK
    },
    removeDir: (path) => {
      removedDirs.push(path)
      if (change.removeFails) throw new Error('EBUSY: resource busy')
    },
    removeFile: (path) => {
      removedFiles.push(path)
    },
    writeText: (path, text) => {
      written[path] = text
    },
    sha256File: async (path) => {
      weighed.push(path)
      if (path === PLAN.stagedExecutable) {
        if (change.unreadableExecutable) throw new Error('EACCES: permission denied')
        return EXECUTABLE
      }
      if (change.unreadable) throw new Error('EACCES: permission denied')
      return change.weight ?? { sha256: HASH, size: SIZE }
    }
  }
  return { deps, ran, said, written, weighed, removedDirs, removedFiles, madeDirs, kinds: () => ran.map(kindOf) }
}

const CHECKS: Kind[] = ['plutil', 'stapler-app', 'identities']
const STAGING: Kind[] = ['mkdir', 'ditto', 'ln']
const COPY_CHECKS: Kind[] = ['verify-staged', 'sig-app', 'sig-staged', 'stapler-staged']
const FULL_RUN: Kind[] = [...CHECKS, ...STAGING, ...COPY_CHECKS, 'create', 'sign', 'submit', 'staple', 'stapler-dmg', 'assess', 'move']
const WRITES = new Set<Kind>([...STAGING, ...COPY_CHECKS, 'create', 'sign', 'submit', 'staple', 'stapler-dmg', 'assess', 'move'])

describe('the making of the image', () => {
  it('runs the steps in their order: check, copy, check the copy, make, sign, notarize, staple, ask Gatekeeper, and only then put it in dist-drm', async () => {
    const w = world()
    const result = await makeDmg(INPUT, w.deps)
    expect(result).toEqual({ ok: true, dryRun: false, dmg: `${OUT}/${DMG}`, sum: `${OUT}/${DMG}.sha256`, made: { sha256: HASH, size: SIZE, stapler: 'The validate action worked!', gatekeeper: `${PLAN.finalDmg}: accepted\nsource=Notarized Developer ID` } })
    expect(w.kinds()).toEqual(FULL_RUN)
    expect(w.madeDirs).toEqual([`${TMP}/lucium-dmg-${VERSION}-`])
    expect(w.said.at(-2)).toBe(`\nThe disk image of Lucium ${VERSION} is ready: ${OUT}/${DMG}`)
  })

  it('runs exactly the commands of the plan', async () => {
    const w = world()
    await makeDmg(INPUT, w.deps)
    const expected = [plistCommand(APP), stapleValidateCommand(APP), PLAN.makeStage, PLAN.copyApp, PLAN.linkApplications, PLAN.verifyStaged, PLAN.signatureOfApp, PLAN.signatureOfStaged, PLAN.validateStaged, PLAN.create, PLAN.sign, PLAN.submit, PLAN.staple, PLAN.validateDmg, PLAN.assess, PLAN.moveDmg]
    expect(w.ran.slice(0, 2).map(commandLine)).toEqual(expected.slice(0, 2).map(commandLine))
    expect(w.ran.slice(3).map(commandLine)).toEqual(expected.slice(2).map(commandLine))
  })

  it('writes the sum from the image that is in dist-drm, after the move, and removes an older sum first', async () => {
    const w = world()
    await makeDmg(INPUT, w.deps)
    expect(w.weighed).toEqual([PLAN.stagedExecutable, `${OUT}/${DMG}`])
    expect(w.written[`${OUT}/${DMG}.sha256`]).toBe(`${HASH}  ${DMG}\n`)
    expect(w.removedFiles).toEqual([`${OUT}/${DMG}.sha256`, `${OUT}/${DMG}.json`])
    expect(w.kinds().at(-1)).toBe('move')
  })

  it('writes with the image the record of the app it holds: the executable of the copy that went into it, and removes an older record first', async () => {
    const w = world()
    await makeDmg(INPUT, w.deps)
    expect(PLAN.stagedExecutable).toBe(`${PLAN.staged}/Contents/MacOS/Lucium`)
    expect(Object.keys(w.written).sort()).toEqual([`${OUT}/${DMG}.json`, `${OUT}/${DMG}.sha256`])
    expect(imageRecordNameOf(VERSION)).toBe(`${DMG}.json`)
    expect(JSON.parse(w.written[`${OUT}/${DMG}.json`] ?? '{}')).toEqual({ version: VERSION, image: { name: DMG, sha256: HASH, size: SIZE }, executable: EXECUTABLE })
    // The record of an earlier image never stays beside a new one.
    expect(w.removedFiles).toContain(`${OUT}/${DMG}.json`)
  })

  it('puts nothing in dist-drm when the executable of the copy cannot be weighed: no image there without its record', async () => {
    const w = world({ unreadableExecutable: true })
    const result = await makeDmg(INPUT, w.deps)
    expect(result).toMatchObject({ ok: false, step: 'Put the image and its sum in dist-drm', touchedOutput: false })
    expect(result.ok ? '' : result.problem).toMatch(/cannot read .*stage\/Lucium\.app\/Contents\/MacOS\/Lucium: EACCES: permission denied/)
    expect(w.kinds()).not.toContain('move')
    expect(w.removedFiles).toEqual([])
    expect(w.written).toEqual({})
  })

  it('touches nothing of dist-drm before the move: the image is made, signed, notarized and checked in the work folder', async () => {
    const w = world()
    await makeDmg(INPUT, w.deps)
    for (const command of w.ran.filter((one) => kindOf(one) !== 'move')) expect(command.args, commandLine(command)).not.toContain(`${OUT}/${DMG}`)
  })

  it('removes the work folder, the copy of the app in it included, when it is done', async () => {
    const w = world()
    await makeDmg(INPUT, w.deps)
    expect(w.removedDirs).toEqual([WORK])
    expect(w.said.join('\n')).toContain(`The work folder ${WORK} is removed.`)
  })

  it('says it when the work folder cannot be removed, and the image is ready all the same', async () => {
    const w = world({ removeFails: true })
    expect(await makeDmg(INPUT, w.deps)).toMatchObject({ ok: true })
    expect(w.said.join('\n')).toContain(`warning: the work folder ${WORK} was not removed: EBUSY: resource busy`)
  })

  it('uses the identity of LUCIUM_SIGN_IDENTITY and the profile it is given', async () => {
    const w = world({ results: { identities: done(listing(OTHER_IDENTITY, IDENTITY)) } })
    await makeDmg({ ...INPUT, signIdentity: IDENTITY, notaryProfile: 'my-profile' }, w.deps)
    expect(w.ran.find((command) => kindOf(command) === 'sign')?.args).toEqual(['--sign', IDENTITY, '--timestamp', PLAN.workDmg])
    expect(w.ran.find((command) => kindOf(command) === 'submit')?.args).toContain('my-profile')
  })

  it('prints the identity without its team identifier, and says when the keychain holds several', async () => {
    const w = world({ results: { identities: done(listing(OTHER_IDENTITY, IDENTITY)) } })
    await makeDmg(INPUT, w.deps)
    const printed = w.said.join('\n')
    // The command lines carry the whole name (codesign needs it); the line that says which identity is used does not.
    expect(w.said.find((line) => line.startsWith('  ok  Developer ID: '))).toBe('  ok  Developer ID: Developer ID Application: Other Org')
    expect(printed).toContain('2 Developer ID Application identities: the first one is used')
  })

  describe('in a dry run', () => {
    it('makes only the checks that read, prints every other command and runs none, makes no folder and writes nothing', async () => {
      const w = world()
      expect(await makeDmg({ ...INPUT, dryRun: true }, w.deps)).toEqual({ ok: true, dryRun: true, dmg: `${OUT}/${DMG}`, sum: `${OUT}/${DMG}.sha256`, made: null })
      expect(w.kinds()).toEqual(CHECKS)
      expect(w.ran.filter((command) => WRITES.has(kindOf(command)))).toEqual([])
      expect(w.madeDirs).toEqual([])
      expect(w.removedDirs).toEqual([])
      expect(w.removedFiles).toEqual([])
      expect(w.written).toEqual({})
      expect(w.weighed).toEqual([])
      expect(w.said.at(-1)).toMatch(/Dry run done: nothing was copied, signed or sent, and nothing was written/)
    })

    it('prints the commands of the plan, in order, each marked as not run', async () => {
      const w = world()
      await makeDmg({ ...INPUT, dryRun: true }, w.deps)
      const printed = w.said.join('\n')
      // The work folder does not exist: its name is shown with the placeholder of mkdtemp.
      const dry = dmgPlan({ app: APP, work: `${TMP}/lucium-dmg-${VERSION}-XXXXXX`, outDir: OUT, version: VERSION, identity: IDENTITY, profile: 'lucium' })
      const commands = [dry.makeStage, dry.copyApp, dry.linkApplications, dry.verifyStaged, dry.signatureOfApp, dry.signatureOfStaged, dry.validateStaged, dry.create, dry.sign, dry.submit, dry.staple, dry.validateDmg, dry.assess, dry.moveDmg]
      const positions = commands.map((command) => printed.indexOf(`$ ${commandLine(command)}   (dry run: not run)`))
      expect(positions.every((position) => position >= 0), commands.map(commandLine).filter((_, at) => positions[at]! < 0).join('\n')).toBe(true)
      expect(positions).toEqual([...positions].sort((a, b) => a - b))
      // What only reads is run, not marked.
      expect(printed).not.toContain(`$ ${commandLine(plistCommand(APP))}   (dry run`)
    })

    it('still fails on the checks that read', async () => {
      const w = world({ results: { plutil: done('0.2.11\n') } })
      expect(await makeDmg({ ...INPUT, dryRun: true }, w.deps)).toMatchObject({ ok: false, step: 'Check the app', touchedOutput: false })
      expect(w.kinds()).toEqual(['plutil'])
    })

    it('still fails on an identity the keychain does not hold', async () => {
      const w = world()
      expect(await makeDmg({ ...INPUT, dryRun: true, signIdentity: OTHER_IDENTITY }, w.deps)).toMatchObject({ ok: false, step: 'Find the signing identity' })
    })
  })

  describe('stops before anything is copied when the app or the keychain is not right', () => {
    const cases: Array<[string, World, Partial<DmgInput>, Kind[], RegExp]> = [
      ['the app is missing', { missing: [APP] }, {}, [], /Lucium\.app does not exist: build the release first/],
      ['dist-drm is missing', { missing: [OUT] }, {}, [], /dist-drm does not exist/],
      ['the version of the app cannot be read', { results: { plutil: done('', 1, 'no such key') } }, {}, ['plutil'], /cannot read the version of .*no such key/],
      ['the app is of another version', { results: { plutil: done('0.2.11\n') } }, {}, ['plutil'], /the built app is 0\.2\.11, package\.json says 0\.2\.12/],
      ['the version of package.json is not three numbers', { results: { plutil: done('0.2.12-beta.1\n') } }, { version: '0.2.12-beta.1' }, ['plutil'], /not x\.y\.z/],
      ['the app has no stapled ticket', { results: { 'stapler-app': done('', 65, 'does not have a ticket stapled to it') } }, {}, ['plutil', 'stapler-app'], /no valid notarization ticket.*does not have a ticket stapled/],
      ['the keychain cannot be listed', { results: { identities: done('', 1, 'security: no keychain') } }, {}, CHECKS, /cannot list the identities of the keychain: security: no keychain/],
      ['the chosen identity is not in the keychain', {}, { signIdentity: OTHER_IDENTITY }, CHECKS, /LUCIUM_SIGN_IDENTITY is not a valid code-signing identity/],
      ['the chosen identity is not a Developer ID Application', {}, { signIdentity: 'Apple Distribution: Example Org (ABCDE12345)' }, CHECKS, /is not a "Developer ID Application" identity/],
      ['the keychain has no Developer ID Application', { results: { identities: done(listing('Apple Development: Someone (AAAAAAAAAA)')) } }, {}, CHECKS, /no "Developer ID Application" identity in the keychain/]
    ]
    it.each(cases)('%s', async (_name, change, input, ranKinds, message) => {
      const w = world(change)
      const result = await makeDmg({ ...INPUT, ...input }, w.deps)
      expect(result.ok).toBe(false)
      expect(result.ok ? '' : result.problem).toMatch(message)
      expect(result.ok ? true : result.touchedOutput).toBe(false)
      expect(w.kinds(), 'what was run, up to the failure').toEqual(ranKinds)
      expect(w.madeDirs, 'a folder was made').toEqual([])
      expect(w.removedDirs).toEqual([])
      expect(w.written).toEqual({})
    })
  })

  describe('stops at the first failure and leaves dist-drm as it was, the work folder removed', () => {
    const upTo = (kind: Kind): Kind[] => FULL_RUN.slice(0, FULL_RUN.indexOf(kind) + 1)
    const cases: Array<[string, World, Kind, string, RegExp]> = [
      ['the staging folder cannot be made', { results: { mkdir: done('', 1, 'mkdir: Permission denied') } }, 'mkdir', 'Copy the app to a staging folder', /cannot make the staging folder: mkdir: Permission denied/],
      ['the app cannot be copied', { results: { ditto: done('', 1, 'ditto: No space left on device') } }, 'ditto', 'Copy the app to a staging folder', /cannot copy the app: ditto: No space left/],
      ['the link cannot be made', { results: { ln: done('', 1, 'ln: failed') } }, 'ln', 'Copy the app to a staging folder', /cannot make the link to Applications/],
      ['the copy does not verify', { results: { 'verify-staged': done('', 1, 'a sealed resource is missing or invalid') } }, 'verify-staged', 'Check the copy', /the copy of the app does not verify.*a sealed resource is missing/],
      // An app the icon of Settings › About and updates › App icon was put on (it ran): ditto copies its `Icon\r` and the Finder attribute of its root, which
      // codesign --strict refuses (measured on a copy of 1.0.0, 12 November 2026). No image is made of it.
      ['the app carries a custom icon', { results: { 'verify-staged': done('', 1, `${PLAN.staged}: resource fork, Finder information, or similar detritus not allowed`) } }, 'verify-staged', 'Check the copy', /the copy of the app does not verify.*detritus not allowed/],
      ['the signature of the app has no CDHash', { results: { 'sig-app': done('', 0, 'Executable=/x\n') } }, 'sig-staged', 'Check the copy', /no CDHash in the signature/],
      ['the signature of the copy has no CDHash', { results: { 'sig-staged': done('', 0, 'Executable=/x\n') } }, 'sig-staged', 'Check the copy', /no CDHash in the signature/],
      ['the signature of the app cannot be read', { results: { 'sig-app': done('', 1, 'code object is not signed at all') } }, 'sig-app', 'Check the copy', /cannot read the signature of the app: code object is not signed/],
      ['the copy has another signature than the app', { results: { 'sig-staged': signature('f'.repeat(40)) } }, 'sig-staged', 'Check the copy', /the copy has another signature than the app \(CDHash f{40}, the app 1234/],
      ['the copy has no stapled ticket', { results: { 'stapler-staged': done('', 65, 'no ticket') } }, 'stapler-staged', 'Check the copy', /the copy has no valid notarization ticket/],
      ['hdiutil fails', { results: { create: done('', 1, 'hdiutil: create failed - Resource busy') } }, 'create', 'Make the disk image', /hdiutil create failed: hdiutil: create failed - Resource busy/],
      ['hdiutil succeeds and the image is not there', { missing: [PLAN.workDmg] }, 'create', 'Make the disk image', /does not exist/],
      ['codesign fails', { results: { sign: done('', 1, 'errSecInternalComponent') } }, 'sign', 'Sign the disk image', /codesign failed: errSecInternalComponent/],
      ['Apple says Invalid', { results: { submit: done(JSON.stringify({ id: 'sub-9', status: 'Invalid' })) } }, 'submit', 'Have Apple notarize the disk image', /Apple did not accept the image \(Invalid\)\n.*xcrun notarytool log sub-9 --keychain-profile lucium/],
      ['notarytool fails after it said Accepted', { results: { submit: done(accepted, 1, 'Error: timed out') } }, 'submit', 'Have Apple notarize the disk image', /Apple did not accept the image \(Accepted\)/],
      ['notarytool cannot answer (no profile)', { results: { submit: done('', 1, 'Error: No Keychain password item found for profile: lucium') } }, 'submit', 'Have Apple notarize the disk image', /exit code 1\)\n.*No Keychain password item found for profile: lucium/],
      ['the ticket cannot be stapled', { results: { staple: done('', 65, 'Could not find a ticket for the image') } }, 'staple', 'Staple the ticket', /stapler staple failed: Could not find a ticket/],
      ['the stapled image does not validate', { results: { 'stapler-dmg': done('', 65, 'no ticket stapled') } }, 'stapler-dmg', 'Staple the ticket', /the image has no valid notarization ticket stapled to it/],
      ['Gatekeeper refuses the image', { results: { assess: done('', 3, `${PLAN.workDmg}: rejected\nsource=Unnotarized Developer ID`) } }, 'assess', 'Ask Gatekeeper', /Gatekeeper refuses the image \(spctl exit code 3\)/],
      ['Gatekeeper accepts it as a plain Developer ID', { results: { assess: done('', 0, `${PLAN.workDmg}: accepted\nsource=Developer ID`) } }, 'assess', 'Ask Gatekeeper', /accepts the image but not as notarized/]
    ]
    it.each(cases)('%s', async (_name, change, lastKind, step, message) => {
      const w = world(change)
      const result = await makeDmg(INPUT, w.deps)
      expect(result.ok).toBe(false)
      expect(result.ok ? '' : result.step).toBe(step)
      expect(result.ok ? '' : result.problem).toMatch(message)
      expect(result.ok ? true : result.touchedOutput).toBe(false)
      expect(w.kinds(), 'what was run, up to the failure').toEqual(upTo(lastKind))
      expect(w.removedDirs, 'the work folder').toEqual([WORK])
      expect(w.removedFiles, 'a file of dist-drm was removed').toEqual([])
      expect(w.written, 'a file was written').toEqual({})
      expect(w.weighed).toEqual([])
    })

    it('never moves the image to dist-drm when a step before the move fails', async () => {
      for (const [, change] of cases) {
        const w = world(change)
        await makeDmg(INPUT, w.deps)
        expect(w.kinds()).not.toContain('move')
      }
    })

    it('removes the work folder when a step fails, and says so when it cannot', async () => {
      const w = world({ results: { sign: done('', 1, 'x') }, removeFails: true })
      expect(await makeDmg(INPUT, w.deps)).toMatchObject({ ok: false, step: 'Sign the disk image' })
      expect(w.removedDirs).toEqual([WORK])
      expect(w.said.join('\n')).toContain('was not removed: EBUSY')
    })
  })

  describe('when dist-drm is reached', () => {
    it('says that it may hold a part of the result when the move fails, and has removed the older sum first', async () => {
      const w = world({ results: { move: done('', 1, 'mv: Permission denied') } })
      const result = await makeDmg(INPUT, w.deps)
      expect(result).toMatchObject({ ok: false, step: 'Put the image and its sum in dist-drm', touchedOutput: true })
      expect(result.ok ? '' : result.problem).toMatch(/cannot move the image to .*mv: Permission denied/)
      expect(w.removedFiles).toEqual([`${OUT}/${DMG}.sha256`, `${OUT}/${DMG}.json`])
      expect(w.written).toEqual({})
      expect(w.removedDirs).toEqual([WORK])
    })

    it('writes no sum for an image that cannot be read', async () => {
      const w = world({ unreadable: true })
      const result = await makeDmg(INPUT, w.deps)
      expect(result).toMatchObject({ ok: false, touchedOutput: true })
      expect(result.ok ? '' : result.problem).toMatch(/cannot read .*Lucium-0\.2\.12-arm64\.dmg: EACCES: permission denied/)
      expect(w.written).toEqual({})
    })
  })
})

describe('the real effects', () => {
  const deps = realDmgDeps(() => {})
  const node = (script: string, timeoutMs = 20_000): Command => ({ program: process.execPath, args: ['-e', script], timeoutMs })
  const dir = mkdtempSync(join(tmpdir(), 'make-dmg-effects-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('run a command without a shell and give its output, its error and its code', () => {
    expect(deps.run(node("process.stdout.write('out $HOME;'); process.stderr.write('err'); process.exit(3)"))).toEqual({ status: 3, stdout: 'out $HOME;', stderr: 'err' })
  })

  it('say that a command could not be started, with a status that is not 0', () => {
    const result = deps.run({ program: '/nonexistent/program', args: [], timeoutMs: 1000 })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/ENOENT/)
  })

  it('make a folder with the prefix it is given, remove it with what it holds, and remove a file that is not there without a word', () => {
    const made = deps.makeTempDir(join(dir, 'lucium-dmg-'))
    expect(made.startsWith(join(dir, 'lucium-dmg-'))).toBe(true)
    expect(made.length).toBe(join(dir, 'lucium-dmg-').length + 6)
    deps.writeText(join(made, 'a'), 'abc')
    expect(deps.exists(join(made, 'a'))).toBe(true)
    deps.removeDir(made)
    expect(deps.exists(made)).toBe(false)
    expect(() => deps.removeFile(join(dir, 'never-existed'))).not.toThrow()
    deps.writeText(join(dir, 'b'), 'x')
    deps.removeFile(join(dir, 'b'))
    expect(deps.exists(join(dir, 'b'))).toBe(false)
  })

  it('hash a file, and refuse one that is not there', async () => {
    writeFileSync(join(dir, 'c'), 'abc')
    expect(await deps.sha256File(join(dir, 'c'))).toEqual({ sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', size: 3 })
    await expect(deps.sha256File(join(dir, 'missing'))).rejects.toThrow(/ENOENT/)
  })
})

describe('scripts/make-dmg.mjs', () => {
  const script = fileURLToPath(new URL('../../scripts/make-dmg.mjs', import.meta.url))
  // The environment never names an identity or a profile of the maintainer: the runs below stop before they are read.
  const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, ...args], { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH ?? '', HOME: tmpdir() } })

  it('shows its usage with --help', () => {
    const help = run('--help')
    expect(help.status).toBe(0)
    expect(help.stderr).toMatch(/--dry-run +prints every command and runs none that copies, signs, sends or writes/)
    expect(help.stderr).toMatch(/--app <app> +the built app the image is made of/)
  })

  it('refuses an unknown option and a loose argument, with its usage', () => {
    for (const args of [['--publish'], ['dist-drm/Lucium.app'], ['--app']]) {
      const result = run(...args)
      expect(result.status, args.join(' ')).toBe(2)
      expect(result.stderr).toMatch(/^Error: /)
      expect(result.stderr).toContain('--dry-run')
    }
  })

  it('stops in a dry run on an app that does not exist, before any command that copies, signs or sends is even printed', () => {
    const nowhere = join(tmpdir(), 'nowhere', 'Lucium.app')
    const result = run('--dry-run', '--app', nowhere)
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/FAILED at "Check the app": .*Lucium\.app does not exist/)
    expect(result.stderr).toMatch(/Nothing was written to .*dist-drm/)
    expect(result.stdout).toContain('Dry run of the disk image of Lucium')
    expect(result.stdout).not.toMatch(/\$ \S*(hdiutil|ditto|codesign|notarytool|spctl|mv|ln) /)
    expect(existsSync(join(tmpdir(), 'nowhere'))).toBe(false)
  })
})

// The repository becomes public, and this script works next to the maintainer's keychain: it lists the names of the identities and hands a profile
// name to notarytool, and reads or prints nothing else of the keychain.
describe('the files about the disk image', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

  it('read no secret of the keychain, and give notarytool no credential', () => {
    for (const path of ['./make-dmg.ts', '../../scripts/make-dmg.mjs']) {
      const text = read(path)
      expect(text, path).not.toMatch(/find-generic-password|find-internet-password|dump-keychain|export-keychain|security export|--password|--apple-id|--team-id/)
      expect(text, path).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
    }
    expect(read('./make-dmg.ts')).toContain("args: ['find-identity', '-v', '-p', 'codesigning']")
  })
})
