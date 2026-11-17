// The disk image of a release in one command: `node scripts/make-dmg.mjs` (docs/community/release-process.md, "The disk image"). Not part of the
// application (nothing in it imports this file); the script reads it with Node's own TypeScript, like publish-update.ts, so it imports nothing but
// Node's modules and uses nothing that type stripping cannot erase (no enum, no parameter property).
//
// What it does is what the maintainer would do by hand, in the same order: check the built app (dist-drm/mac-arm64/Lucium.app is the notarized one
// that was archived for the update feed: the image holds exactly that app, never a rebuilt one), copy it with an `Applications` link into a staging
// folder, make the image, sign it with the Developer ID of the build, have Apple notarize it, staple the ticket, ask Gatekeeper, and write the SHA-256
// sum. It stops at the first thing that is wrong. All the work is done in a folder of its own; dist-drm/ only receives the finished, checked image
// and its sum, so a failed run leaves no image there that looks like a release.
//
// The code is either pure (the names, the arguments, the identity, the commands, the checks) or takes its effects as `DmgDeps`: the script gives the
// real ones (`realDmgDeps`), the tests a fake one. So the order of the steps, and what stops them, is tested without a keychain, Apple or a disk.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The names

/** The name of the built app, and of the app inside the image. */
export const APP_FILE = 'Lucium.app'

/** The keychain profile of `xcrun notarytool store-credentials` that this Mac holds (a name; the credentials stay in the keychain). */
export const DEFAULT_NOTARY_PROFILE = 'lucium'

/** The version of package.json becomes the name of a file and of a volume: three numbers, as the archive's name (publish-update.ts). */
const PACKAGE_VERSION = /^\d+\.\d+\.\d+$/

/** The image, as scripts/publish-update.mjs looks for it beside the archive (publish-update.ts has the same two names). */
export const dmgNameOf = (version: string): string => `Lucium-${version}-arm64.dmg`
/** Its sum, in the format `shasum -a 256 -c` reads. */
export const sumNameOf = (version: string): string => `${dmgNameOf(version)}.sha256`
/**
 * The record written with the image: which image it is, and the executable of the app it holds. The publication reads it to refuse an image left
 * from an earlier build of the same version (src/main/publish-update.ts has the same name, and a test keeps them equal). It is never sent anywhere.
 */
export const imageRecordNameOf = (version: string): string => `${dmgNameOf(version)}.json`

/** The record of an image: its sum and size as the file is in dist-drm/, and those of the executable of the copy of the app that went into it. */
export function imageRecordOf(input: { version: string; image: { sha256: string; size: number }; executable: { sha256: string; size: number } }): {
  version: string
  image: { name: string; sha256: string; size: number }
  executable: { sha256: string; size: number }
} {
  return { version: input.version, image: { name: dmgNameOf(input.version), sha256: input.image.sha256, size: input.image.size }, executable: { sha256: input.executable.sha256, size: input.executable.size } }
}
/** What Finder shows when the image is opened. */
export const volumeNameOf = (version: string): string => `Lucium ${version}`

/** The line `shasum -a 256` prints and `shasum -a 256 -c` reads: the hash, two spaces, the name of the file (in the folder of the sum). */
export const sumLineOf = (sha256: string, fileName: string): string => `${sha256}  ${fileName}\n`

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The arguments

export interface DmgOptions {
  dryRun: boolean
  help: boolean
  /** The built app the image is made of (default: dist-drm/mac-arm64/Lucium.app). */
  app: string | null
}

export type ParsedDmgArgs = { ok: true; options: DmgOptions } | { ok: false; message: string }

export function parseDmgArgs(args: string[]): ParsedDmgArgs {
  const options: DmgOptions = { dryRun: false, help: false, app: null }
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] as string
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--app' || arg.startsWith('--app=')) {
      // The next word is the value, unless it is another option: `--app --dry-run` must not take the flag for a path.
      const value = arg.startsWith('--app=') ? arg.slice('--app='.length) : args[at + 1] !== undefined && !(args[at + 1] as string).startsWith('--') ? args[++at] : undefined
      if (value === undefined || value === '') return { ok: false, message: '--app needs a value' }
      options.app = value
    } else if (arg.startsWith('-')) return { ok: false, message: `Unknown option: ${arg}` }
    else return { ok: false, message: `Unexpected argument: ${arg} (the image is always made of one app; --app <app> names it)` }
  }
  return { ok: true, options }
}

export interface DmgInput {
  /** The version of package.json: the one the built app must carry. */
  version: string
  app: string
  /** Where the finished image and its sum are written (dist-drm/ of the repository). */
  outDir: string
  /** Where the staging folder is made (the temporary folder of the system). */
  tmpRoot: string
  /** LUCIUM_SIGN_IDENTITY, or null: the first Developer ID Application identity of the keychain, as scripts/build-drm-release.sh chooses. */
  signIdentity: string | null
  /** The notarytool keychain profile: LUCIUM_NOTARY_PROFILE, else `lucium`. */
  notaryProfile: string
  dryRun: boolean
}

/** The options with their defaults and absolute paths. `signIdentity` and `notaryProfile` are the environment variables, as they were found. */
export function resolveDmgInput(options: DmgOptions, env: { cwd: string; root: string; tmpRoot: string; version: string; signIdentity: string | undefined; notaryProfile: string | undefined }): DmgInput {
  // The profile is a name: whitespace is dropped as the build script does, and an empty variable is no variable.
  const profile = (env.notaryProfile ?? '').replace(/\s+/g, '')
  const identity = (env.signIdentity ?? '').trim()
  return {
    version: env.version,
    app: options.app ? resolve(env.cwd, options.app) : join(env.root, 'dist-drm', 'mac-arm64', APP_FILE),
    outDir: join(env.root, 'dist-drm'),
    tmpRoot: env.tmpRoot,
    signIdentity: identity === '' ? null : identity,
    notaryProfile: profile === '' ? DEFAULT_NOTARY_PROFILE : profile,
    dryRun: options.dryRun
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The signing identity

/** The names of the "Developer ID Application" identities of `security find-identity -v -p codesigning`, in the order it lists them. */
export function developerIdentities(listing: string): string[] {
  return [...listing.matchAll(/^\s*\d+\)\s+[0-9A-F]{40}\s+"(Developer ID Application: [^"]+)"\s*$/gm)].map((found) => found[1] as string)
}

export type IdentityChoice = { ok: true; identity: string; note: string | null } | { ok: false; message: string }

/**
 * The identity that signs the image, chosen as scripts/build-drm-release.sh chooses the one of the app (docs/drm.md, section 8): LUCIUM_SIGN_IDENTITY
 * when it is set, and it must then be a valid identity of the keychain (never replaced by another one in silence); else the first Developer ID Application
 * of the keychain. Apple notarizes only what a Developer ID Application signed, so any other identity is refused here, before anything is built.
 */
export function chooseIdentity(listing: string, fromEnv: string | null): IdentityChoice {
  const identities = developerIdentities(listing)
  if (fromEnv !== null && fromEnv !== '') {
    if (!listing.includes(`"${fromEnv}"`)) return { ok: false, message: 'LUCIUM_SIGN_IDENTITY is not a valid code-signing identity of the keychain (security find-identity -v -p codesigning)' }
    if (!identities.includes(fromEnv)) return { ok: false, message: 'LUCIUM_SIGN_IDENTITY is not a "Developer ID Application" identity: Apple notarizes only what one of them signed' }
    return { ok: true, identity: fromEnv, note: null }
  }
  const first = identities[0]
  if (first === undefined) return { ok: false, message: 'no "Developer ID Application" identity in the keychain (security find-identity -v -p codesigning): Apple notarizes only what one of them signed' }
  return { ok: true, identity: first, note: identities.length > 1 ? `${identities.length} Developer ID Application identities: the first one is used (set LUCIUM_SIGN_IDENTITY to choose)` : null }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The commands

export interface Command {
  program: string
  args: string[]
  timeoutMs: number
}

const plainWord = /^[A-Za-z0-9_@%+=:,./~-]+$/
/** A word as a shell would need it, so that a printed command can be pasted. */
export const shellWord = (word: string): string => (plainWord.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)
export const commandLine = (command: Command): string => [command.program, ...command.args].map(shellWord).join(' ')

const MINUTE = 60_000

/** The checks of the app and of the keychain: they only read, so a dry run makes them too. */
export const plistCommand = (app: string): Command => ({ program: '/usr/bin/plutil', args: ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')], timeoutMs: MINUTE })
export const stapleValidateCommand = (path: string): Command => ({ program: 'xcrun', args: ['stapler', 'validate', path], timeoutMs: 2 * MINUTE })
export const listIdentitiesCommand: Command = { program: '/usr/bin/security', args: ['find-identity', '-v', '-p', 'codesigning'], timeoutMs: MINUTE }

export interface DmgPlan {
  /** The folders and files of the work, all under `work`. */
  stage: string
  staged: string
  workDmg: string
  /** The finished image, its sum and its record, in dist-drm/. */
  finalDmg: string
  finalSum: string
  finalRecord: string
  /** The executable of the copy of the app that goes into the image: the record names its sum. */
  stagedExecutable: string
  makeStage: Command
  copyApp: Command
  linkApplications: Command
  verifyStaged: Command
  signatureOfApp: Command
  signatureOfStaged: Command
  validateStaged: Command
  create: Command
  sign: Command
  submit: Command
  staple: Command
  validateDmg: Command
  assess: Command
  moveDmg: Command
}

/**
 * The commands that make the image of `app` in `work`, once the identity is known. The staging folder holds the app and the link that lets people drag
 * it to Applications; the image is made, signed, notarized and stapled in `work`, and only then moved to `outDir`. The credentials of the notary
 * service are never in a command: only the name of the keychain profile.
 */
export function dmgPlan(plan: { app: string; work: string; outDir: string; version: string; identity: string; profile: string }): DmgPlan {
  const stage = join(plan.work, 'stage')
  const staged = join(stage, APP_FILE)
  const workDmg = join(plan.work, dmgNameOf(plan.version))
  const finalDmg = join(plan.outDir, dmgNameOf(plan.version))
  return {
    stage,
    staged,
    workDmg,
    finalDmg,
    finalSum: join(plan.outDir, sumNameOf(plan.version)),
    finalRecord: join(plan.outDir, imageRecordNameOf(plan.version)),
    stagedExecutable: join(staged, 'Contents', 'MacOS', 'Lucium'),
    makeStage: { program: '/bin/mkdir', args: [stage], timeoutMs: MINUTE },
    // ditto copies what a bundle holds (symbolic links, extended attributes, the stapled ticket); cp -R does not always.
    copyApp: { program: '/usr/bin/ditto', args: [plan.app, staged], timeoutMs: 10 * MINUTE },
    linkApplications: { program: '/bin/ln', args: ['-s', '/Applications', join(stage, 'Applications')], timeoutMs: MINUTE },
    verifyStaged: { program: '/usr/bin/codesign', args: ['--verify', '--deep', '--strict', staged], timeoutMs: 5 * MINUTE },
    signatureOfApp: { program: '/usr/bin/codesign', args: ['-dvvv', plan.app], timeoutMs: MINUTE },
    signatureOfStaged: { program: '/usr/bin/codesign', args: ['-dvvv', staged], timeoutMs: MINUTE },
    validateStaged: stapleValidateCommand(staged),
    create: { program: '/usr/bin/hdiutil', args: ['create', '-volname', volumeNameOf(plan.version), '-srcfolder', stage, '-fs', 'HFS+', '-format', 'UDZO', workDmg], timeoutMs: 15 * MINUTE },
    sign: { program: '/usr/bin/codesign', args: ['--sign', plan.identity, '--timestamp', workDmg], timeoutMs: 5 * MINUTE },
    // JSON so that the answer can be read: notarytool may exit 0 for an image Apple refused.
    submit: { program: 'xcrun', args: ['notarytool', 'submit', workDmg, '--keychain-profile', plan.profile, '--wait', '--output-format', 'json'], timeoutMs: 90 * MINUTE },
    staple: { program: 'xcrun', args: ['stapler', 'staple', workDmg], timeoutMs: 5 * MINUTE },
    validateDmg: stapleValidateCommand(workDmg),
    assess: { program: '/usr/sbin/spctl', args: ['-a', '-t', 'open', '--context', 'context:primary-signature', '-v', workDmg], timeoutMs: 2 * MINUTE },
    moveDmg: { program: '/bin/mv', args: ['-f', workDmg, finalDmg], timeoutMs: 10 * MINUTE }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The checks

/** What is wrong with the version of the built app, or null. The image is made of the app as it is: it must be the app of the version being released. */
export function versionProblem(packageVersion: string, builtVersion: string): string | null {
  if (!PACKAGE_VERSION.test(packageVersion)) return `the version of package.json is "${packageVersion}", not x.y.z: it names the image and its volume`
  if (builtVersion !== packageVersion) return `the built app is ${builtVersion}, package.json says ${packageVersion}: the image holds the built app as it is, so build it again, or check out the right version`
  return null
}

/** The `CDHash=` line of `codesign -dvvv`, which names the exact code a signature seals, or null. */
export const cdhashOf = (text: string): string | null => /^CDHash=([0-9a-f]+)$/m.exec(text)?.[1] ?? null

export interface NotaryAnswer {
  status: string
  id: string
}

/** The JSON `xcrun notarytool submit --wait --output-format json` prints: the status of the submission (`Accepted`, `Invalid`…) and its id. */
export function parseNotaryAnswer(text: string): NotaryAnswer {
  try {
    const answer = JSON.parse(text) as unknown
    if (typeof answer === 'object' && answer !== null && !Array.isArray(answer)) {
      const { status, id } = answer as { status?: unknown; id?: unknown }
      return { status: typeof status === 'string' ? status : '', id: typeof id === 'string' ? id : '' }
    }
  } catch {
    // Not JSON: notarytool failed before it could answer (no profile, no network); its error is on stderr.
  }
  return { status: '', id: '' }
}

/** What is wrong with the notary service's answer, or null when Apple accepted the image. */
export function notaryProblem(answer: NotaryAnswer, exitStatus: number | null, profile: string): string | null {
  if (exitStatus === 0 && answer.status === 'Accepted') return null
  const what = answer.status !== '' ? answer.status : `notarytool exit code ${exitStatus === null ? 'none (timeout or not started)' : exitStatus}`
  const reason = answer.id !== '' ? `\n    The reason: xcrun notarytool log ${answer.id} --keychain-profile ${shellWord(profile)}` : ''
  return `Apple did not accept the image (${what})${reason}`
}

/** What is wrong with Gatekeeper's verdict on the image, or null. A signed image that is not notarized is accepted as plain "Developer ID": not enough. */
export function assessProblem(result: { status: number | null; stdout: string; stderr: string }): string | null {
  const text = `${result.stdout}\n${result.stderr}`.trim()
  if (result.status !== 0) return `Gatekeeper refuses the image (spctl exit code ${result.status === null ? 'none (timeout or not started)' : result.status}): ${firstLines(text)}`
  if (!text.includes('source=Notarized Developer ID')) return `Gatekeeper accepts the image but not as notarized (expected "source=Notarized Developer ID"): ${firstLines(text)}`
  return null
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The work

export interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
}

/** Everything the making of the image does to the outside; `realDmgDeps` is the real one. */
export interface DmgDeps {
  say: (line: string) => void
  exists: (path: string) => boolean
  /** Runs a command to its end, without a shell. */
  run: (command: Command) => CommandResult
  /** Makes a new folder whose name starts with `prefix` (a path), and gives its path. */
  makeTempDir: (prefix: string) => string
  removeDir: (path: string) => void
  removeFile: (path: string) => void
  writeText: (path: string, text: string) => void
  sha256File: (path: string) => Promise<{ sha256: string; size: number }>
}

/** What the run made, when it was not a dry run. */
export interface DmgMade {
  sha256: string
  size: number
  /** What `stapler validate` and `spctl` said about the finished image. */
  stapler: string
  gatekeeper: string
}

export type DmgResult = { ok: true; dryRun: boolean; dmg: string; sum: string; made: DmgMade | null } | { ok: false; step: string; problem: string; touchedOutput: boolean }

class DmgFailure extends Error {
  step: string
  constructor(step: string, problem: string) {
    super(problem)
    this.step = step
  }
}

/** The message the script prints when the run failed: what went wrong, and what dist-drm/ holds. */
export function describeDmgFailure(result: { step: string; problem: string; touchedOutput: boolean }, outDir: string): string {
  const state = result.touchedOutput
    ? `${outDir} may hold a part of the result (the image without its sum or its record): remove them and run the command again before publishing anything.`
    : `Nothing was written to ${outDir}.`
  return `FAILED at "${result.step}": ${result.problem}\n${state}`
}

const firstLines = (text: string, count = 6): string => text.trim().split('\n').slice(0, count).join('\n')
const lastLine = (text: string): string => text.trim().split('\n').pop() ?? ''
const failureOf = (result: CommandResult): string => firstLines(result.stderr) || firstLines(result.stdout) || `exit code ${result.status === null ? 'none (timeout or not started)' : result.status}`

/**
 * Makes the image of `input.app`. In a dry run the checks that only read are made (the app, the version, the ticket, the keychain's identities) and
 * every other command is printed and not run. Never throws for a failed step: the result says which and why.
 */
export async function makeDmg(input: DmgInput, deps: DmgDeps): Promise<DmgResult> {
  const { say } = deps
  const { dryRun } = input
  const prefix = join(input.tmpRoot, `lucium-dmg-${input.version}-`)
  let work: string | null = null
  let touchedOutput = false
  let step = ''

  const begin = (title: string, commands: Command[], writes: boolean): boolean => {
    step = title
    say(`\n${title}`)
    for (const command of commands) say(`  $ ${commandLine(command)}${writes && dryRun ? '   (dry run: not run)' : ''}`)
    return !(writes && dryRun)
  }
  const ok = (line: string): void => say(`  ok  ${line}`)
  // A declaration, not a constant: TypeScript only narrows after a call to a function that is declared to return `never`.
  function fail(problem: string): never {
    throw new DmgFailure(step, problem)
  }
  const mustRun = (command: Command, what: string): CommandResult => {
    const done = deps.run(command)
    if (done.status !== 0) fail(`${what}: ${failureOf(done)}`)
    return done
  }

  try {
    say(`${dryRun ? 'Dry run of the disk image' : 'Disk image'} of Lucium ${input.version}`)

    // 1. The app: the one that was notarized and archived, as it is.
    const plist = plistCommand(input.app)
    const stapled = stapleValidateCommand(input.app)
    begin('Check the app', [plist, stapled], false)
    if (!deps.exists(input.app)) fail(`${input.app} does not exist: build the release first (scripts/build-drm-release.sh --notarize --no-install …), or name the app with --app`)
    if (!deps.exists(input.outDir)) fail(`${input.outDir} does not exist: it is where the image and its sum are written`)
    const built = mustRun(plist, `cannot read the version of ${input.app}`)
    const mismatch = versionProblem(input.version, built.stdout.trim())
    if (mismatch) fail(mismatch)
    ok(`the app is ${input.version}, as package.json`)
    mustRun(stapled, 'the app has no valid notarization ticket stapled to it (xcrun stapler validate)')
    ok('the notarization ticket is stapled')

    // 2. The identity, chosen before a byte is copied.
    begin('Find the signing identity', [listIdentitiesCommand], false)
    const choice = chooseIdentity(mustRun(listIdentitiesCommand, 'cannot list the identities of the keychain').stdout, input.signIdentity)
    if (!choice.ok) fail(choice.message)
    if (choice.note) say(`  --  ${choice.note}`)
    // The name without the team identifier, so that the output can be pasted anywhere.
    ok(`Developer ID: ${choice.identity.replace(/ \([A-Z0-9]{10}\)$/, '')}`)

    work = dryRun ? `${prefix}XXXXXX` : deps.makeTempDir(prefix)
    const plan = dmgPlan({ app: input.app, work, outDir: input.outDir, version: input.version, identity: choice.identity, profile: input.notaryProfile })

    // 3. The app and the link to Applications, in a staging folder.
    if (begin('Copy the app to a staging folder', [plan.makeStage, plan.copyApp, plan.linkApplications], true)) {
      mustRun(plan.makeStage, 'cannot make the staging folder')
      mustRun(plan.copyApp, 'cannot copy the app')
      mustRun(plan.linkApplications, 'cannot make the link to Applications')
      ok(`${plan.staged} and the link to /Applications`)
    }

    // 4. The copy must be the app: same signature, which seals every file, and its ticket.
    if (begin('Check the copy', [plan.verifyStaged, plan.signatureOfApp, plan.signatureOfStaged, plan.validateStaged], true)) {
      mustRun(plan.verifyStaged, 'the copy of the app does not verify (codesign --verify --deep --strict)')
      const original = cdhashOf(`${mustRun(plan.signatureOfApp, 'cannot read the signature of the app').stderr}`)
      const copy = cdhashOf(`${mustRun(plan.signatureOfStaged, 'cannot read the signature of the copy').stderr}`)
      if (original === null || copy === null) fail('no CDHash in the signature of the app or of its copy (codesign -dvvv)')
      if (original !== copy) fail(`the copy has another signature than the app (CDHash ${copy}, the app ${original}): it is not the app that was notarized`)
      mustRun(plan.validateStaged, 'the copy has no valid notarization ticket stapled to it (xcrun stapler validate)')
      ok(`the copy is the app: CDHash ${original}, ticket stapled`)
    }

    // 5. The image: HFS+, compressed. The volume is named after the version.
    if (begin('Make the disk image', [plan.create], true)) {
      mustRun(plan.create, 'hdiutil create failed')
      if (!deps.exists(plan.workDmg)) fail(`hdiutil said nothing is wrong and ${plan.workDmg} does not exist`)
      ok(`${volumeNameOf(input.version)}: ${plan.workDmg}`)
    }

    // 6. Signed with the Developer ID of the app, with a secure timestamp (Apple's notary service wants one).
    if (begin('Sign the disk image', [plan.sign], true)) {
      mustRun(plan.sign, 'codesign failed')
      ok('signed')
    }

    // 7. Apple's notary service, with the keychain profile; --wait gives the answer.
    if (begin('Have Apple notarize the disk image', [plan.submit], true)) {
      const submitted = deps.run(plan.submit)
      const answer = parseNotaryAnswer(submitted.stdout)
      const refused = notaryProblem(answer, submitted.status, input.notaryProfile)
      if (refused) fail(`${refused}${answer.status === '' ? `\n    ${failureOf(submitted)}` : ''}`)
      ok(`accepted by Apple (submission ${answer.id})`)
    }

    // 8. The ticket is stapled to the image, so that it opens without a network.
    let stapler = ''
    if (begin('Staple the ticket', [plan.staple, plan.validateDmg], true)) {
      mustRun(plan.staple, 'stapler staple failed')
      // "Processing: <path>" then "The validate action worked!": the verdict is the last line.
      stapler = lastLine(mustRun(plan.validateDmg, 'the image has no valid notarization ticket stapled to it (xcrun stapler validate)').stdout)
      ok(stapler)
    }

    // 9. What Gatekeeper says when someone opens the image.
    let gatekeeper = ''
    if (begin('Ask Gatekeeper', [plan.assess], true)) {
      const assessed = deps.run(plan.assess)
      const refused = assessProblem(assessed)
      if (refused) fail(refused)
      // The image is checked in the work folder and then moved: the verdict is shown with the name it ends up with.
      gatekeeper = firstLines(`${assessed.stdout}\n${assessed.stderr}`, 3).replaceAll(plan.workDmg, plan.finalDmg)
      ok(gatekeeper.replace(/\n/g, ' · '))
    }

    // 10. Only now does dist-drm/ get the image, then its sum, computed from the file as it is there: a sum without an image is never left behind.
    let made: DmgMade | null = null
    if (begin('Put the image and its sum in dist-drm', [plan.moveDmg], true)) {
      // Which app the image holds, for its record: the executable of the copy that went into it, still in the work folder. Weighed before dist-drm
      // is touched: an image is never left there without the record that ties it to the app.
      const executable = await deps.sha256File(plan.stagedExecutable).catch((error: unknown) => fail(`cannot read ${plan.stagedExecutable}: ${error instanceof Error ? error.message : String(error)}`))
      touchedOutput = true
      // The sum and the record of an earlier image go first: neither may stay beside an image it does not describe.
      deps.removeFile(plan.finalSum)
      deps.removeFile(plan.finalRecord)
      mustRun(plan.moveDmg, `cannot move the image to ${plan.finalDmg}`)
      const weight = await deps.sha256File(plan.finalDmg).catch((error: unknown) => fail(`cannot read ${plan.finalDmg}: ${error instanceof Error ? error.message : String(error)}`))
      deps.writeText(plan.finalSum, sumLineOf(weight.sha256, dmgNameOf(input.version)))
      deps.writeText(plan.finalRecord, `${JSON.stringify(imageRecordOf({ version: input.version, image: weight, executable }), null, 2)}\n`)
      made = { sha256: weight.sha256, size: weight.size, stapler, gatekeeper }
      ok(`${plan.finalDmg}: SHA-256 ${weight.sha256}, ${weight.size} bytes`)
      ok(`${plan.finalSum} written`)
      ok(`${plan.finalRecord} written: the image holds the app whose executable has SHA-256 ${executable.sha256}`)
    }

    say(dryRun ? '\nDry run done: nothing was copied, signed or sent, and nothing was written.' : `\nThe disk image of Lucium ${input.version} is ready: ${plan.finalDmg}`)
    return { ok: true, dryRun, dmg: plan.finalDmg, sum: plan.finalSum, made }
  } catch (error) {
    if (error instanceof DmgFailure) return { ok: false, step: error.step, problem: error.message, touchedOutput }
    throw error
  } finally {
    // The work folder holds a copy of the app and the unfinished image: it never stays, whatever happened.
    if (work !== null && !dryRun) {
      try {
        deps.removeDir(work)
        say(`\n  The work folder ${work} is removed.`)
      } catch (error) {
        say(`\n  warning: the work folder ${work} was not removed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The real effects

/** The real effects of `DmgDeps`: files, child processes (no shell). */
export function realDmgDeps(say: (line: string) => void): DmgDeps {
  return {
    say,
    exists: existsSync,
    run: (command) => {
      const done = spawnSync(command.program, command.args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: command.timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })
      return { status: done.status, stdout: done.stdout ?? '', stderr: `${done.stderr ?? ''}${done.error ? `\n${done.error.message}` : ''}` }
    },
    makeTempDir: (prefix) => mkdtempSync(prefix),
    removeDir: (path) => rmSync(path, { recursive: true, force: true }),
    removeFile: (path) => rmSync(path, { force: true }),
    writeText: (path, text) => writeFileSync(path, text),
    sha256File: (path) =>
      new Promise((done, fail) => {
        const hash = createHash('sha256')
        let size = 0
        createReadStream(path)
          .on('data', (chunk) => {
            hash.update(chunk)
            size += chunk.length
          })
          .on('error', fail)
          .on('end', () => done({ sha256: hash.digest('hex'), size }))
      })
  }
}
