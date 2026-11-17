// Checks the application that is handed out, as it is on disk: `pnpm verify:app <path of Lucium.app>` (scripts/verify-app.mjs).
// Not part of the application (nothing in it imports this file); the script reads it with Node's own TypeScript, so it imports nothing but Node's
// modules, and is handed what other modules know (the engine guard, the entitlements of each piece, the licence texts, the fuses).
//
// Why: every suite of the project runs from the sources, on the standard Electron. What exists only in the package (the signature, the
// entitlements, the provisioning profile of the keychain service, the notarization, the engine that was really built in, what electron-builder
// left in or out) was checked by the build that made it, and then never again: not on the app unzipped from the archive, not on the one of the
// disk image, not on an installed copy. This reads the bundle itself and trusts nothing the build said.
//
// It never opens a window. Everything is read (`codesign -d`, `spctl`, `stapler validate`, `plutil`, the files), except the last check: the app
// is started twice with a switch it must refuse (`--smoke`, `--remote-debugging-port`), on a throw-away data folder, and must leave with code 1
// and say why before it makes anything. That check is not made on an app that failed a check before it: an app that is not the expected build is
// not started.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What is expected, read from the files of the repository that say it

/** What electron-builder.yml says of the bundle: its identifier, and the address schemes it registers. */
export function builderFacts(yaml: string): { identifier: string; urlSchemes: string[] } | null {
  const identifier = /^appId: (\S+)$/m.exec(yaml)?.[1]
  const urlSchemes = [...yaml.matchAll(/^\s+CFBundleURLSchemes: \[([^\]]*)\]$/gm)].flatMap((found) => (found[1] ?? '').split(',').map((scheme) => scheme.trim()).filter(Boolean))
  return identifier && urlSchemes.length > 0 ? { identifier, urlSchemes } : null
}

export interface FuseWire {
  version: number
  bytes: number[]
}

export interface VerifyInput {
  /** The bundle to check. */
  app: string
  /** The version it must carry (package.json's). */
  version: string
  /** Its bundle identifier (`appId` of electron-builder.yml). */
  identifier: string
  /** The address schemes its Info.plist registers (electron-builder.yml): these and no other. */
  urlSchemes: string[]
  /**
   * The team that must have signed it. Null only with `--any-team` (`teamChoice`): the team is then read from the signature, said, and only its
   * consistency is checked, which the signature of anyone passes. That is a look at a copy, not the check of a build to hand out.
   */
  team: string | null
  /** The entitlements of the keychain service (native/vault-keychain/entitlements.plist.in), with `__TEAM_ID__` where the team goes. */
  keychainEntitlements: string
  /**
   * What the application asks of the helper of the system's translation before it starts it (src/main/translate/system.ts), read from the helper's
   * own Info.plist in the repository (`translateHelperFacts`): the identifier its signature must carry, and the protocol its bundle must name.
   */
  translateHelper: { identifier: string; protocol: number }
  /** The names of the positions of the fuse wire, and the value each named fuse must have (castLabs' set). */
  fuseNames: readonly string[]
  fuses: Readonly<Record<string, boolean>>
  /**
   * The public keys of the update feed (src/main/update-feed-keys.ts), and what is wrong with their list (update-feed-signature.ts,
   * `publicKeyProblems`: no key at all, more than two, something that is not a key). The application must carry each key, or it would refuse the
   * feeds the publication signs; a list with a problem fails the check whatever the application holds, and the app is then never started.
   */
  feedKeys: { keys: readonly string[]; problems: readonly string[] }
  /** Start the app to see it refuse the switches it must refuse (false with `--no-launch`). */
  launch: boolean
  /** How long a refused launch may take, in milliseconds. */
  launchTimeoutMs: number
}

export interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
}

export interface LaunchResult {
  /** The exit code, null when the app did not leave by itself. */
  code: number | null
  stderr: string
  /** The app was still running after the time it was given, and was stopped. */
  timedOut: boolean
  elapsedMs: number
}

/** What the checks do to the outside, and what they are told by other modules. `realVerifyDeps` is the real one. */
export interface VerifyDeps {
  say: (line: string) => void
  /** Runs a program that only reads, to its end, without a shell. */
  run: (program: string, args: string[]) => CommandResult
  /** Starts the executable of the app with these arguments, and waits for it to leave. */
  launch: (executable: string, args: string[], timeoutMs: number) => Promise<LaunchResult>
  /** A new empty folder for one launch, and its removal. */
  makeTempDir: () => string
  removeDir: (path: string) => void
  readFuseWire: (app: string) => Promise<FuseWire | null>
  /** Why this engine version is not the one a release is built on, or null (src/main/drm-engine-guard.ts, with the pinned Electron). */
  engineProblem: (engine: string) => string | null
  /** The entitlements a piece of the app must be signed with: the keys of its plist (src/main/mac-sign-order.ts). Throws for a helper it does not know. */
  entitlementsOf: (piece: string) => string[]
  /** The licence texts the folder of resources lacks (scripts/notices/shipped-notices.cjs). */
  noticeProblems: (resources: string) => string[]
  now: () => Date
}

export interface Check {
  name: string
  ok: boolean
  /** What was found: the proof when it passed, each problem when it did not. */
  detail: string
}

const passed = (name: string, detail: string): Check => ({ name, ok: true, detail })
const failed = (name: string, problems: string[]): Check => ({ name, ok: false, detail: problems.join('\n') })
const verdict = (name: string, problems: string[], proof: string): Check => (problems.length === 0 ? passed(name, proof) : failed(name, problems))
const firstLines = (text: string, count = 4): string => text.trim().split('\n').slice(0, count).join(' | ')
const failureOf = (result: CommandResult): string => firstLines(result.stderr) || firstLines(result.stdout) || `exit code ${result.status === null ? 'none (not started, or stopped)' : result.status}`

/**
 * A custom icon at the root of a bundle: Settings › About and updates › App icon puts the chosen icon on the running copy (src/main/shell/bundle-icon.ts), and the
 * Finder attribute of the root then fails `codesign --strict` with these words, while macOS still opens the copy as notarized (docs/drm.md). The
 * build handed out carries none: scripts/make-dmg.mjs and scripts/publish-update.mjs refuse one that does.
 */
const CUSTOM_ICON_FILE = 'Icon\r'
const CUSTOM_ICON_FAILURE = /detritus not allowed|com\.apple\.FinderInfo/
export const CUSTOM_ICON_NOTE = 'a custom icon is set on this copy (Settings › About and updates › App icon): this is not a defect of the build; the build handed out carries none'

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The signature, as codesign prints it

export interface Signature {
  identifier: string | null
  team: string | null
  /** The flags of the code directory: `runtime` is the hardened runtime, `adhoc` a signature no certificate made. */
  flags: string[]
  authorities: string[]
}

/** What `codesign -dvvv` says of a piece (it writes to the standard error). */
export function signatureOf(text: string): Signature {
  const team = /^TeamIdentifier=(.+)$/m.exec(text)?.[1] ?? null
  return {
    identifier: /^Identifier=(.+)$/m.exec(text)?.[1] ?? null,
    team: team === 'not set' ? null : team,
    flags: (/^CodeDirectory .*flags=0x[0-9a-f]+\(([^)]*)\)/m.exec(text)?.[1] ?? '').split(',').filter(Boolean),
    authorities: [...text.matchAll(/^Authority=(.+)$/gm)].map((found) => found[1] ?? '')
  }
}

/** Why a piece is not signed as a piece of a release is: by a Developer ID of `team`, with the hardened runtime. */
export function signatureProblems(signature: Signature, team: string): string[] {
  const problems: string[] = []
  if (signature.flags.includes('adhoc') || signature.authorities.length === 0) problems.push('signed ad hoc, by no certificate')
  else if (!signature.authorities[0]?.startsWith('Developer ID Application: ')) problems.push(`signed by "${signature.authorities[0]}", not by a Developer ID Application certificate`)
  if (signature.team !== team) problems.push(`signed by the team ${signature.team ?? '(none)'}, expected ${team}`)
  if (!signature.flags.includes('runtime')) problems.push('signed without the hardened runtime')
  return problems
}

/**
 * Why the designated requirement of the app (`codesign -d -r-`) is not the one of a Developer ID build of this identifier and team. It is what
 * Squirrel checks an update against, and what macOS ties the granted permissions to: another identifier or another team is another app.
 */
export function requirementProblems(text: string, want: { identifier: string; team: string }): string[] {
  const requirement = /^(?:# )?designated => (.+)$/m.exec(text)?.[1]
  if (!requirement) return ['codesign printed no designated requirement']
  const problems: string[] = []
  if (!requirement.includes(`identifier "${want.identifier}"`)) problems.push(`it does not name the identifier "${want.identifier}"`)
  if (!requirement.includes('anchor apple generic')) problems.push('it is not anchored to Apple (anchor apple generic)')
  // The two marks of a Developer ID chain: the intermediate certificate of the Developer ID authority, and a leaf that is a Developer ID Application.
  if (!requirement.includes('certificate 1[field.1.2.840.113635.100.6.2.6]')) problems.push('it does not ask for the Developer ID certification authority')
  if (!requirement.includes('certificate leaf[field.1.2.840.113635.100.6.1.13]')) problems.push('it does not ask for a Developer ID Application certificate')
  // The team, whole: quoted or not, and never as the beginning of a longer one (nor an empty one, which would be found anywhere).
  const named = /certificate leaf\[subject\.OU\] = "?([A-Za-z0-9]+)"?(?=\s|$)/.exec(requirement)?.[1]
  if (want.team === '' || named !== want.team) problems.push(`it does not name the team ${want.team || '(none)'}`)
  return problems.length === 0 ? [] : [...problems, `the requirement is: ${requirement}`]
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Property lists, as far as the checks read them

type PlistValue = true | false | string | string[]

/** The keys of the top dictionary of an XML property list whose value is a boolean, a string or a list of strings; XML comments are not read. */
export function plistValues(xml: string): Record<string, PlistValue> {
  const values: Record<string, PlistValue> = {}
  const body = xml.replace(/<!--[\s\S]*?-->/g, '')
  for (const found of body.matchAll(/<key>([^<]+)<\/key>\s*(?:<(true|false)\/>|<string>([^<]*)<\/string>|<array>((?:\s*<string>[^<]*<\/string>)*)\s*<\/array>|<array\/>)/g)) {
    const [, key, bool, text, list] = found
    if (key === undefined) continue
    if (bool !== undefined) values[key] = bool === 'true'
    else if (text !== undefined) values[key] = text
    else values[key] = [...(list ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((entry) => entry[1] ?? '')
  }
  return values
}

/**
 * What the Info.plist of the translation helper names: its bundle identifier and the protocol it speaks. Read as the application reads it
 * (system.ts `helperProtocol`): as text, the protocol a whole number of three digits at most. Null for what it does not name that way.
 */
export function translateHelperFacts(xml: string): { identifier: string | null; protocol: number | null } {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '')
  const protocol = /<key>LuciumTranslateProtocol<\/key>\s*<integer>(\d{1,3})<\/integer>/.exec(body)?.[1]
  return { identifier: /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(body)?.[1] ?? null, protocol: protocol === undefined ? null : Number(protocol) }
}

/**
 * Why the application would not run this translation helper as the build means it to. It starts the helper only when its signature carries the
 * expected identifier (otherwise the system's translation is silently unavailable, for everyone), and runs it once per batch, slowly, when its
 * bundle does not name the protocol of this build.
 */
export function translateHelperProblems(found: { signedAs: string | null; plist: string | null }, want: { identifier: string; protocol: number }): string[] {
  const problems: string[] = []
  if (found.signedAs !== want.identifier) problems.push(`it is signed under the identifier ${found.signedAs ?? '(none)'}, the application only starts ${want.identifier}: the translation by macOS would be unavailable`)
  if (found.plist === null) return [...problems, 'its Info.plist cannot be read']
  const facts = translateHelperFacts(found.plist)
  if (facts.identifier !== want.identifier) problems.push(`its Info.plist names the bundle ${facts.identifier ?? '(none)'}, expected ${want.identifier}`)
  if (facts.protocol !== want.protocol) problems.push(`its Info.plist names the protocol ${facts.protocol ?? '(none)'} (LuciumTranslateProtocol), expected ${want.protocol}: the application would start it again for every batch`)
  return problems
}

/** The property list a provisioning profile carries: the profile is a signed envelope around it, and the list is in it as plain text. */
export function profilePlist(file: Buffer): string | null {
  const text = file.toString('latin1')
  const start = text.indexOf('<?xml')
  const end = text.indexOf('</plist>')
  return start === -1 || end < start ? null : text.slice(start, end + '</plist>'.length)
}

/**
 * Why the provisioning profile embedded in the keychain service does not authorize what the service is signed with. Without a profile that grants
 * them, macOS refuses to start a program that claims an application identifier and keychain access groups: Touch ID would be unavailable.
 */
export function profileProblems(xml: string, want: { team: string; applicationIdentifier: string; accessGroups: string[]; now: Date }): string[] {
  const values = plistValues(xml)
  const problems: string[] = []
  const teams = Array.isArray(values['TeamIdentifier']) ? values['TeamIdentifier'] : []
  if (!teams.includes(want.team)) problems.push(`it is the profile of the team ${teams.join(', ') || '(none)'}, not of ${want.team}`)
  if (values['com.apple.application-identifier'] !== want.applicationIdentifier) problems.push(`it authorizes the application ${JSON.stringify(values['com.apple.application-identifier'] ?? null)}, the service is ${want.applicationIdentifier}`)
  const granted = Array.isArray(values['keychain-access-groups']) ? values['keychain-access-groups'] : []
  for (const group of want.accessGroups) {
    if (!granted.some((pattern) => pattern === group || (pattern.endsWith('*') && group.startsWith(pattern.slice(0, -1))))) problems.push(`it does not grant the keychain access group ${group} (it grants: ${granted.join(', ') || 'none'})`)
  }
  // A Developer ID profile runs on every Mac; a development profile only on the Macs it lists.
  if (values['ProvisionsAllDevices'] !== true) problems.push('it is not a profile for every Mac (ProvisionsAllDevices): a development profile, which other Macs refuse')
  const expires = /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/.exec(xml)?.[1]
  const expiry = expires ? new Date(expires) : null
  if (!expiry || Number.isNaN(expiry.getTime())) problems.push('it has no expiration date')
  else if (expiry.getTime() <= want.now.getTime()) problems.push(`it expired on ${expiry.toISOString()}`)
  return problems
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// app.asar: what the package carries

export interface AsarEntry {
  /** The path inside the archive, without a leading slash. */
  path: string
  size: number
  /** The file is beside the archive, in app.asar.unpacked/, at the same path. */
  unpacked: boolean
  /** The SHA-256 of the file as it was when the archive was made (hex), when the header keeps one. */
  hash?: string
}

/** The SHA-256 the header keeps of a file (`integrity`, written by @electron/asar for the files it leaves outside too), or undefined. */
function sealedHash(child: object): string | undefined {
  const integrity = (child as { integrity?: unknown }).integrity
  if (typeof integrity !== 'object' || integrity === null) return undefined
  const { algorithm, hash } = integrity as { algorithm?: unknown; hash?: unknown }
  return algorithm === 'SHA256' && typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash) ? hash.toLowerCase() : undefined
}

/** The header of an asar archive: its text (what the integrity hash of Info.plist is made of) and the files it lists. Null when the file is not one. */
export function readAsar(file: string): { header: string; entries: AsarEntry[] } | null {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const head = Buffer.alloc(16)
    if (readSync(fd, head, 0, 16, 0) !== 16 || head.readUInt32LE(0) !== 4) return null
    const length = head.readUInt32LE(12)
    // The header of this application is a few hundred kilobytes; a length that is not one is not read.
    if (length === 0 || length > 64 * 1024 * 1024) return null
    const body = Buffer.alloc(length)
    if (readSync(fd, body, 0, length, 16) !== length) return null
    const header = body.toString('utf8')
    let tree: unknown
    try {
      tree = JSON.parse(header)
    } catch {
      return null
    }
    const entries: AsarEntry[] = []
    const walk = (node: unknown, prefix: string): void => {
      if (typeof node !== 'object' || node === null) return
      const files = (node as { files?: unknown }).files
      if (typeof files !== 'object' || files === null) return
      for (const [name, child] of Object.entries(files as Record<string, unknown>)) {
        const path = prefix === '' ? name : `${prefix}/${name}`
        if (typeof child !== 'object' || child === null) continue
        if ('files' in child) walk(child, path)
        else if (!('link' in child)) {
          const hash = sealedHash(child)
          entries.push({ path, size: Number((child as { size?: unknown }).size ?? 0), unpacked: (child as { unpacked?: unknown }).unpacked === true, ...(hash ? { hash } : {}) })
        }
      }
    }
    walk(tree, '')
    return { header, entries }
  } finally {
    closeSync(fd)
  }
}

/**
 * A file left outside app.asar that the signature changes after the archive is made (a native module is signed then): its hash in the header is
 * the one of the unsigned file, so it is not compared here. `codesign --verify --deep --strict` answers for those.
 */
export function isSignedAfterPacking(path: string): boolean {
  return /\.(node|dylib)$/.test(path)
}

/**
 * What is wrong with the files left outside app.asar, compared with what its header says of them. The fuse that checks the archive only checks
 * its header and what is inside; a file beside it is read from the disk as it is. The header (whose own hash Info.plist seals) keeps the SHA-256
 * of each of them: a script that is not the one the archive was made with is named, and so is one the header does not list.
 * `read` answers the bytes of a file of app.asar.unpacked, null when it is not there or is empty (the check of the unpacked files already says so).
 */
export function unpackedScriptProblems(entries: readonly AsarEntry[], loose: readonly string[], read: (path: string) => Buffer | null): string[] {
  const problems: string[] = []
  const listed = new Set<string>()
  for (const entry of entries) {
    if (!entry.unpacked) continue
    listed.add(entry.path)
    if (isSignedAfterPacking(entry.path)) continue
    if (!entry.hash) {
      problems.push(`${entry.path}: the header of app.asar keeps no SHA-256 of it, so it cannot be told from another file`)
      continue
    }
    const bytes = read(entry.path)
    if (bytes === null) continue
    const found = createHash('sha256').update(bytes).digest('hex')
    if (found !== entry.hash) problems.push(`${entry.path} in app.asar.unpacked is not the file app.asar was made with: its SHA-256 is ${found}, the header says ${entry.hash}`)
  }
  for (const path of loose) if (!listed.has(path) && !isSignedAfterPacking(path)) problems.push(`${path} is in app.asar.unpacked and app.asar does not list it`)
  return problems
}

/** The most a preload may weigh. They run before the scripts of every page, frame or worker they are given to; the largest is about 24 kB today. */
export const PRELOAD_MAX_BYTES = 64 * 1024

/** Whether a path of the package is a preload: the application's own (out/preload/), and the ones of the extension libraries. */
export function isPreload(path: string): boolean {
  return /^out\/preload\/[^/]+\.js$/.test(path) || /\.preload\.js$/.test(path)
}

/** The preloads that weigh more than `PRELOAD_MAX_BYTES`. `sizeOf` answers what a preload weighs in the package, null when it cannot be weighed. */
export function preloadSizeProblems(preloads: readonly string[], sizeOf: (path: string) => number | null): string[] {
  return preloads.flatMap((path) => {
    const size = sizeOf(path)
    return size !== null && size > PRELOAD_MAX_BYTES ? [`${path} weighs ${size} bytes, more than the ${PRELOAD_MAX_BYTES} a preload may: it runs before every page it is given to (a dependency bundled by mistake?)`] : []
  })
}

/**
 * Whether a path of the package is a file of the tests. The engine suites (out/main/smoke*.js) and the helpers of the tests (test-support) are
 * built as pieces of their own and left out by electron-builder.yml; a test file, a tests folder, the probe extensions of compat/ or a test runner
 * among the modules has no place in what is handed out either.
 */
export function isTestFile(path: string): boolean {
  if (/^node_modules\/(vitest|@vitest|playwright|playwright-core|@playwright)\//.test(path)) return true
  if (path.startsWith('node_modules/')) return false
  return /^out\/main\/smoke[^/]*\.js$/.test(path) || /test-support/.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /(^|\/)(tests?|__tests__|e2e|compat)\//.test(path)
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The fuses

/**
 * What is wrong with the list of public keys of the update feed, else which of them the package lacks. The keys are text in the main process, and app.asar is not compressed: each is looked for
 * as it is written in src/main/update-feed-keys.ts.
 */
export function feedKeyProblems(list: { keys: readonly string[]; problems: readonly string[] }, asar: Buffer): string[] {
  if (list.problems.length > 0) return [...list.problems]
  return list.keys.filter((key) => !asar.includes(key)).map((key) => `app.asar does not hold the public key ${key} of the update feed: this build would refuse the feeds signed with it. Build again from a tree whose src/main/update-feed-keys.ts has it`)
}

const FUSE_ON = 0x31
const FUSE_OFF = 0x30

/** Each named fuse of `want` that the wire does not have at its value. */
export function fuseProblems(wire: FuseWire, names: readonly string[], want: Readonly<Record<string, boolean>>): string[] {
  const problems: string[] = []
  for (const [name, enabled] of Object.entries(want)) {
    const position = names.indexOf(name)
    const byte = position === -1 ? undefined : wire.bytes[position]
    if (position === -1) problems.push(`the fuse ${name} has no position in the wire that is known here`)
    else if (byte !== (enabled ? FUSE_ON : FUSE_OFF)) problems.push(`${name} is ${byte === FUSE_ON ? 'on' : byte === FUSE_OFF ? 'off' : byte === undefined ? 'missing' : `0x${byte.toString(16)}`}, expected ${enabled ? 'on' : 'off'}`)
  }
  return problems
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The launch that must be refused

/** What the app writes before it leaves when it was started with a switch it refuses (src/main/index.ts). */
export const LAUNCH_REFUSED_MARK = '[launch] refused'

/** The switches the checks start the app with: each is refused by a built app (REFUSED_SWITCHES of src/main/runtime.ts). */
export const REFUSED_LAUNCHES: readonly { name: string; args: string[] }[] = [
  { name: 'smoke', args: ['--smoke'] },
  { name: 'remote-debugging-port', args: ['--remote-debugging-port=0'] }
]

/** Why a launch was not the refusal that is expected: code 1, said, before the time is up, and nothing of the switch took effect. */
export function launchProblems(result: LaunchResult, name: string, left: { devToolsPort: boolean }): string[] {
  const problems: string[] = []
  if (result.timedOut) problems.push(`the app was still running after ${Math.round(result.elapsedMs / 1000)} s with --${name}: it did not refuse the switch (it was stopped)`)
  else if (result.code !== 1) problems.push(`the app left with ${result.code === null ? 'no exit code' : `code ${result.code}`} with --${name}, expected 1`)
  if (!result.stderr.includes(LAUNCH_REFUSED_MARK) || !result.stderr.includes(`--${name}`)) problems.push(`the app did not say that it refuses --${name} ("${LAUNCH_REFUSED_MARK}: …"): it left for another reason, or the switch was read`)
  if (left.devToolsPort) problems.push('a DevToolsActivePort file was written in the data folder: the debugging port was opened')
  return problems
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The checks

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Info.plist as JSON (`plutil -convert json`), or why it cannot be read. */
function readPlist(file: string, deps: VerifyDeps): { plist: Record<string, unknown> } | { problem: string } {
  if (!existsSync(file)) return { problem: `${file} does not exist` }
  const converted = deps.run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file])
  if (converted.status !== 0) return { problem: `cannot read ${file}: ${failureOf(converted)}` }
  try {
    const plist: unknown = JSON.parse(converted.stdout)
    return isRecord(plist) ? { plist } : { problem: `${file} is not a dictionary` }
  } catch {
    return { problem: `plutil did not print ${file} as JSON` }
  }
}

const sorted = (list: readonly string[]): string => [...list].sort().join(', ') || 'none'

/** The entitlements a piece is signed with, as codesign prints them. */
function entitlementsOfPiece(piece: string, deps: VerifyDeps): { values: Record<string, PlistValue> } | { problem: string } {
  // `--entitlements - --xml` is the current spelling of `--entitlements :-`.
  const shown = deps.run('codesign', ['-d', '--entitlements', '-', '--xml', piece])
  return shown.status === 0 ? { values: plistValues(shown.stdout) } : { problem: `codesign cannot show the entitlements: ${failureOf(shown)}` }
}

const grantedKeys = (values: Record<string, PlistValue>): string[] => Object.keys(values).filter((key) => values[key] === true)

export interface VerifyResult {
  checks: Check[]
  /** The number of checks that failed. */
  problems: number
  /** Whether the app was started to see it refuse its switches. */
  launched: boolean
}

/**
 * Checks `input.app` and says what it found, one line per check. Every check is made, whatever the one before found (a failed check does not
 * hide the next), except the launches, which are not made on an app that failed anything.
 */
export async function verifyApp(input: VerifyInput, deps: VerifyDeps): Promise<VerifyResult> {
  const { app } = input
  const checks: Check[] = []
  const add = (check: Check): void => {
    checks.push(check)
    const [first, ...more] = check.detail.split('\n')
    deps.say(`  ${check.ok ? 'ok  ' : 'FAIL'}  ${check.name}: ${first}`)
    for (const line of more) deps.say(`        ${' '.repeat(check.name.length)}  ${line}`)
  }
  const contents = join(app, 'Contents')
  const resources = join(contents, 'Resources')
  const infoFile = join(contents, 'Info.plist')
  if (!existsSync(infoFile)) {
    add(failed('bundle', [`${app} is not an application bundle: no Contents/Info.plist`]))
    return { checks, problems: 1, launched: false }
  }

  // 1. The signature of the whole bundle, every nested piece and every sealed resource included. A copy that carries the icon chosen in Settings
  // fails it on the attribute of its root: the line says so, since the build itself is not at fault (the check still fails).
  const whole = deps.run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  const customIcon = whole.status !== 0 && CUSTOM_ICON_FAILURE.test(`${whole.stderr}\n${whole.stdout}`) && existsSync(join(app, CUSTOM_ICON_FILE))
  add(whole.status === 0 ? passed('signature', 'codesign --verify --deep --strict: valid, every piece and every sealed resource') : failed('signature', [`codesign --verify --deep --strict: ${failureOf(whole)}`, ...(customIcon ? [CUSTOM_ICON_NOTE] : [])]))

  // 2. Who signed it, and how.
  const described = deps.run('codesign', ['-dvvv', app])
  const signature = signatureOf(described.stderr)
  const team = input.team ?? signature.team ?? ''
  if (described.status !== 0) add(failed('signer', [`codesign -dvvv: ${failureOf(described)}`]))
  else if (team === '') add(failed('signer', ['signed by no team (ad hoc, or not signed): not a build to hand out']))
  else {
    add(verdict('signer', signatureProblems(signature, team), `${signature.authorities[0]}, hardened runtime${input.team ? '' : ` (--any-team: team ${team} read from the signature, not compared with an expected one; this is not the check of a build to hand out)`}`))
  }

  // 3. The designated requirement: what an update is checked against.
  const requirement = deps.run('codesign', ['-d', '-r-', app])
  if (requirement.status !== 0) add(failed('designated requirement', [`codesign -d -r-: ${failureOf(requirement)}`]))
  else if (team === '') add(failed('designated requirement', ['no team to compare it with']))
  else add(verdict('designated requirement', requirementProblems(`${requirement.stdout}\n${requirement.stderr}`, { identifier: input.identifier, team }), `identifier "${input.identifier}", Developer ID of the team ${team}`))

  // 4. Info.plist: the identifier, the version, the address schemes, the two keys the updates rest on.
  const info = readPlist(infoFile, deps)
  const plist = 'plist' in info ? info.plist : null
  if (!plist) add(failed('Info.plist', ['problem' in info ? info.problem : 'unreadable']))
  else {
    add(verdict('identifier', plist['CFBundleIdentifier'] === input.identifier && signature.identifier === input.identifier ? [] : [`CFBundleIdentifier is ${JSON.stringify(plist['CFBundleIdentifier'] ?? null)} and the signature names ${JSON.stringify(signature.identifier)}, expected "${input.identifier}"`], input.identifier))
    add(verdict('version', plist['CFBundleShortVersionString'] === input.version ? [] : [`CFBundleShortVersionString is ${JSON.stringify(plist['CFBundleShortVersionString'] ?? null)}, expected "${input.version}"`], input.version))
    const types = Array.isArray(plist['CFBundleURLTypes']) ? plist['CFBundleURLTypes'] : []
    const schemes = types.flatMap((type) => (isRecord(type) && Array.isArray(type['CFBundleURLSchemes']) ? type['CFBundleURLSchemes'].map(String) : []))
    add(verdict('address schemes', sorted(schemes) === sorted(input.urlSchemes) ? [] : [`CFBundleURLTypes registers ${sorted(schemes)}, expected ${sorted(input.urlSchemes)}`], sorted(schemes)))
    add(verdict('downgrades', plist['ElectronSquirrelPreventDowngrades'] === true ? [] : ['Info.plist lacks ElectronSquirrelPreventDowngrades: an update could install an older build'], 'refused (ElectronSquirrelPreventDowngrades)'))
  }

  // 5. The engine: the stable castLabs build of the pinned Electron, read from the framework that is in the bundle.
  const framework = readPlist(join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources', 'Info.plist'), deps)
  if (!('plist' in framework)) add(failed('engine', [framework.problem]))
  else {
    const engine = String(framework.plist['CFBundleVersion'] ?? '')
    const problem = deps.engineProblem(engine)
    add(verdict('engine', problem ? [problem] : [], `Electron ${engine}`))
  }

  // 6. The fuses that are closed, read in the binary.
  // A framework whose binary is missing or unreadable is a failed check like another, not the end of the run: the checks below are still made.
  let wire: FuseWire | null = null
  let unread: string | null = null
  try {
    wire = await deps.readFuseWire(app)
  } catch (error) {
    unread = `the binary of the Electron framework could not be read for its fuses (${error instanceof Error ? error.message : String(error)}): the bundle is incomplete`
  }
  if (unread !== null) add(failed('fuses', [unread]))
  else add(wire ? verdict('fuses', fuseProblems(wire, input.fuseNames, input.fuses), sorted(Object.entries(input.fuses).map(([name, enabled]) => `${name} ${enabled ? 'on' : 'off'}`))) : failed('fuses', ['no Electron fuse wire in the framework']))

  // 7. app.asar: the hash Info.plist seals, what was unpacked, and no file of the tests.
  const asarFile = join(resources, 'app.asar')
  const asar = readAsar(asarFile)
  if (!asar) add(failed('app.asar', [`${asarFile} is missing or is not an asar archive`]))
  else {
    const integrity = plist && isRecord(plist['ElectronAsarIntegrity']) && isRecord(plist['ElectronAsarIntegrity']['Resources/app.asar']) ? plist['ElectronAsarIntegrity']['Resources/app.asar']['hash'] : undefined
    const header = createHash('sha256').update(asar.header).digest('hex')
    add(verdict('app.asar integrity', integrity === header ? [] : [`ElectronAsarIntegrity of Info.plist says ${JSON.stringify(integrity ?? null)}, the header of app.asar hashes to ${header}: the app would refuse to start, or its archive was changed`], `the hash of its header is the one in Info.plist (${asar.entries.length} files)`))
    const unpacked = asar.entries.filter((entry) => entry.unpacked)
    const lost = unpacked.flatMap((entry) => {
      const file = join(resources, 'app.asar.unpacked', ...entry.path.split('/'))
      if (!existsSync(file)) return [`${entry.path} is not in app.asar.unpacked`]
      // Not compared with the size app.asar keeps: a native module is signed after the archive is made, and its signature makes it longer.
      return statSync(file).size > 0 ? [] : [`${entry.path} is empty in app.asar.unpacked`]
    })
    add(verdict('unpacked files', lost, `the ${unpacked.length} files app.asar leaves outside are in app.asar.unpacked (the preloads of the pages among them)`))
    const loose = existsSync(join(resources, 'app.asar.unpacked')) ? listFiles(join(resources, 'app.asar.unpacked')) : []
    const outside = (path: string): string => join(resources, 'app.asar.unpacked', ...path.split('/'))
    const compared = unpacked.filter((entry) => !isSignedAfterPacking(entry.path)).length
    add(verdict('unpacked scripts', unpackedScriptProblems(asar.entries, loose.filter((path) => !isTestFile(path)), (path) => (existsSync(outside(path)) && statSync(outside(path)).size > 0 ? readFileSync(outside(path)) : null)), `the ${compared} scripts left outside app.asar are the ones its header keeps the SHA-256 of, and it lists every one that is there`))
    const preloads = asar.entries.filter((entry) => isPreload(entry.path))
    const weights = new Map(preloads.map((entry) => [entry.path, entry.unpacked ? (existsSync(outside(entry.path)) ? statSync(outside(entry.path)).size : null) : entry.size]))
    const heaviest = Math.max(0, ...[...weights.values()].map((size) => size ?? 0))
    add(verdict('preload sizes', preloadSizeProblems([...weights.keys()], (path) => weights.get(path) ?? null), `the ${preloads.length} preloads weigh ${heaviest} bytes at most (the bound is ${PRELOAD_MAX_BYTES})`))
    const tests = [...new Set([...asar.entries.map((entry) => entry.path), ...loose])].filter(isTestFile)
    add(verdict('update feed keys', feedKeyProblems(input.feedKeys, readFileSync(asarFile)), `the ${input.feedKeys.keys.length} public key(s) of the update feed are in app.asar: a feed is believed only when one of them signed it`))
    add(verdict('test files', tests.slice(0, 12).map((path) => `${path} is a file of the tests`).concat(tests.length > 12 ? [`and ${tests.length - 12} more`] : []), 'none in app.asar nor in app.asar.unpacked'))
  }

  // 8. The licence texts travel with the binary.
  const notices = deps.noticeProblems(resources)
  add(verdict('license texts', notices, 'LICENSE, NOTICE, ADDITIONAL-PERMISSION.txt, THIRD-PARTY-NOTICES.txt, LICENSE.electron.txt and LICENSES.chromium.html in Contents/Resources'))

  // 9. The entitlements of the app and of its helpers: each the exact set of its plist, and the same signer.
  const helpersDir = join(contents, 'Frameworks')
  const helpers = existsSync(helpersDir) ? readdirSync(helpersDir).filter((name) => name.endsWith('.app')).sort() : []
  const name = plist && typeof plist['CFBundleExecutable'] === 'string' ? plist['CFBundleExecutable'] : 'Lucium'
  const wantedHelpers = ['', ' (GPU)', ' (Plugin)', ' (Renderer)'].map((kind) => `${name} Helper${kind}.app`).sort()
  const rights: string[] = []
  if (sorted(helpers) !== sorted(wantedHelpers)) rights.push(`the helpers are ${sorted(helpers)}, expected ${sorted(wantedHelpers)}`)
  for (const piece of [app, ...helpers.map((helper) => join(helpersDir, helper))]) {
    const label = piece === app ? 'the app' : relative(contents, piece).split(sep).join('/')
    let wanted: string[]
    try {
      wanted = deps.entitlementsOf(piece)
    } catch (error) {
      rights.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const shown = entitlementsOfPiece(piece, deps)
    if ('problem' in shown) rights.push(`${label}: ${shown.problem}`)
    else if (sorted(grantedKeys(shown.values)) !== sorted(wanted)) rights.push(`${label} is signed with [${sorted(grantedKeys(shown.values))}], expected [${sorted(wanted)}]`)
    if (piece !== app && team !== '') rights.push(...signatureProblems(signatureOf(deps.run('codesign', ['-dvvv', piece]).stderr), team).map((problem) => `${label}: ${problem}`))
  }
  add(verdict('entitlements', rights, `the app and its ${helpers.length} helpers, each the exact set of its plist; the renderer and GPU helpers keep library validation`))

  // 10. The helper of the system's translation: signed by the team under its own identifier, with no entitlement at all, its protocol named.
  const translate = join(contents, 'Helpers', 'LuciumTranslate.app')
  if (!existsSync(translate)) add(failed('translation helper', ['Contents/Helpers/LuciumTranslate.app is missing']))
  else {
    const shown = entitlementsOfPiece(translate, deps)
    const signature = signatureOf(deps.run('codesign', ['-dvvv', translate]).stderr)
    const problems = team === '' ? ['no team to compare its signer with'] : signatureProblems(signature, team)
    if ('problem' in shown) problems.push(shown.problem)
    else if (Object.keys(shown.values).length > 0) problems.push(`it is signed with entitlements (${sorted(Object.keys(shown.values))}), expected none`)
    // What the application itself asks before it starts it: the identifier of the signature, and the protocol the bundle names.
    const helperPlist = join(translate, 'Contents', 'Info.plist')
    let plistText: string | null = null
    try {
      plistText = readFileSync(helperPlist, 'utf8')
    } catch (error) {
      problems.push(`${relative(contents, helperPlist).split(sep).join('/')}: ${error instanceof Error ? error.message : String(error)}`)
    }
    problems.push(...translateHelperProblems({ signedAs: signature.identifier, plist: plistText }, input.translateHelper))
    add(verdict('translation helper', problems, `signed by the team as ${input.translateHelper.identifier}, hardened runtime, no entitlement, protocol ${input.translateHelper.protocol}`))
  }

  // 11. The keychain service of the vault (Touch ID): its own entitlements, and the provisioning profile that authorizes them.
  const keychain = join(contents, 'XPCServices', 'LuciumKeychain.xpc')
  if (!existsSync(keychain)) add(failed('keychain service', ['Contents/XPCServices/LuciumKeychain.xpc is missing: Touch ID would be unavailable']))
  else if (team === '') add(failed('keychain service', ['no team to check its entitlements with']))
  else {
    const wanted = plistValues(input.keychainEntitlements.replaceAll('__TEAM_ID__', team))
    const shown = entitlementsOfPiece(keychain, deps)
    const problems = signatureProblems(signatureOf(deps.run('codesign', ['-dvvv', keychain]).stderr), team)
    if ('problem' in shown) problems.push(shown.problem)
    else if (JSON.stringify(Object.entries(shown.values).sort()) !== JSON.stringify(Object.entries(wanted).sort())) {
      problems.push(`it is signed with ${JSON.stringify(shown.values)}, expected ${JSON.stringify(wanted)}: without its own entitlements Lucium says Touch ID is unavailable`)
    }
    add(verdict('keychain service', problems, `signed by the team with its own entitlements (${sorted(Object.keys(wanted))})`))
    const profileFile = join(keychain, 'Contents', 'embedded.provisionprofile')
    const profile = existsSync(profileFile) ? profilePlist(readFileSync(profileFile)) : null
    const groups = Array.isArray(wanted['keychain-access-groups']) ? wanted['keychain-access-groups'] : []
    add(
      profile
        ? verdict('keychain profile', profileProblems(profile, { team, applicationIdentifier: String(wanted['com.apple.application-identifier'] ?? ''), accessGroups: groups, now: deps.now() }), `embedded.provisionprofile authorizes ${String(wanted['com.apple.application-identifier'] ?? '')} and its access group, on every Mac, and has not expired`)
        : failed('keychain profile', [existsSync(profileFile) ? 'embedded.provisionprofile holds no property list' : 'the keychain service has no embedded.provisionprofile: macOS would refuse to start it'])
    )
  }

  // 12. The notarization: what Gatekeeper answers, and the ticket stapled to the bundle (read without the network).
  const gatekeeper = deps.run('spctl', ['--assess', '--type', 'execute', '-vv', app])
  const answer = `${gatekeeper.stdout}\n${gatekeeper.stderr}`
  add(gatekeeper.status === 0 && /: accepted$/m.test(answer) && /^source=Notarized Developer ID$/m.test(answer) ? passed('Gatekeeper', 'accepted, source=Notarized Developer ID') : failed('Gatekeeper', [`spctl --assess: ${firstLines(answer) || `exit code ${gatekeeper.status}`}`]))
  const stapled = deps.run('xcrun', ['stapler', 'validate', app])
  add(stapled.status === 0 ? passed('notarization ticket', 'stapled (xcrun stapler validate)') : failed('notarization ticket', [`xcrun stapler validate: ${failureOf(stapled)}`]))

  // 13. The switches a built app must refuse. Started only when everything above passed: what is not the expected build is not run.
  const before = checks.filter((check) => !check.ok).length
  let launched = false
  if (!input.launch) deps.say('  --    refused switches: NOT CHECKED (--no-launch): the app was not started')
  else if (before > 0) deps.say(`  --    refused switches: not checked, the app was not started: ${before} check(s) failed above, and an app that is not the expected build is not run`)
  else {
    launched = true
    for (const { name: switchName, args } of REFUSED_LAUNCHES) {
      const folder = deps.makeTempDir()
      try {
        const result = await deps.launch(join(contents, 'MacOS', name), [...args, `--user-data-dir=${folder}`], input.launchTimeoutMs)
        add(verdict(`refuses --${switchName}`, launchProblems(result, switchName, { devToolsPort: existsSync(join(folder, 'DevToolsActivePort')) }), `left with code 1 in ${result.elapsedMs} ms and said so, before it made anything`))
      } finally {
        deps.removeDir(folder)
      }
    }
  }
  return { checks, problems: checks.filter((check) => !check.ok).length, launched }
}

/** Every file under a folder, as paths relative to it with "/"; links are not followed. */
function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    return entry.isDirectory() ? listFiles(join(dir, entry.name), path) : entry.isFile() ? [path] : []
  })
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The arguments and the real effects

export interface VerifyOptions {
  app: string | null
  team: string | null
  /** `--any-team`: no team is expected; the one of the signature is only compared between the pieces. */
  anyTeam: boolean
  version: string | null
  noLaunch: boolean
  help: boolean
}

const TEAM_ID = /^[A-Z0-9]{10}$/

export function parseVerifyArgs(args: string[]): { ok: true; options: VerifyOptions } | { ok: false; message: string } {
  const options: VerifyOptions = { app: null, team: null, anyTeam: false, version: null, noLaunch: false, help: false }
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] as string
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--no-launch') options.noLaunch = true
    else if (arg === '--any-team') options.anyTeam = true
    else if (arg === '--team' || arg === '--version') {
      const value = args[++at]
      if (value === undefined || value.startsWith('--')) return { ok: false, message: `${arg} needs a value` }
      if (arg === '--team') options.team = value
      else options.version = value
    } else if (arg.startsWith('--')) return { ok: false, message: `Unknown option: ${arg}` }
    else if (options.app === null) options.app = arg
    else return { ok: false, message: `Only one application can be checked at a time (got ${options.app} and ${arg})` }
  }
  if (!options.help && options.app === null) return { ok: false, message: 'Which application? Give the path of Lucium.app' }
  if (options.team !== null && !TEAM_ID.test(options.team)) return { ok: false, message: `--team takes a team identifier (10 letters and digits), not "${options.team}"` }
  if (options.team !== null && options.anyTeam) return { ok: false, message: '--team names the team expected and --any-team expects none: give one of the two' }
  return { ok: true, options }
}

/**
 * The Apple developer team that signs the official builds of Lucium. It is public: every signed copy carries it, and the README prints it so that
 * anyone can compare (`codesign -dv`). A build signed by another team is not an official one.
 */
export const OFFICIAL_TEAM_ID = '9A9AUX9UHT'

/**
 * The team the app is compared with: `--team`, else the environment variable LUCIUM_TEAM_ID, else the team of the official builds
 * (`OFFICIAL_TEAM_ID`). The team is never read from the signature being checked: the build of any Developer ID would then pass as the project's.
 * `--any-team` asks for exactly that, in so many words (a look at a copy whose signer is not known); it does not go with a team named by the
 * option or the variable, since one of the two would be ignored without a word. `official` says the team is the default one, for the output.
 */
export function teamChoice(options: Pick<VerifyOptions, 'team' | 'anyTeam'>, envTeam: string | undefined): { ok: true; team: string | null; official: boolean } | { ok: false; message: string } {
  const fromEnv = envTeam?.trim() || null
  if (options.team === null && fromEnv !== null && !TEAM_ID.test(fromEnv)) return { ok: false, message: 'LUCIUM_TEAM_ID is not a team identifier (10 letters and digits)' }
  const named = options.team ?? fromEnv
  if (options.anyTeam) {
    return named === null
      ? { ok: true, team: null, official: false }
      : { ok: false, message: 'LUCIUM_TEAM_ID names the team expected and --any-team expects none: unset the variable, or leave --any-team out' }
  }
  return named === null ? { ok: true, team: OFFICIAL_TEAM_ID, official: true } : { ok: true, team: named, official: false }
}

/** The environment of a launch: the one of the script, without the variables that drive Electron or Lucium from outside. */
export function launchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^(ELECTRON_|LUCIUM_|NODE_OPTIONS$|MAIN_VITE_|VITE_)/.test(name)))
}

/** The real effects but what other modules tell (`told`): programs without a shell, the app started with nothing to read from and no terminal. */
export function realVerifyDeps(say: (line: string) => void, tmpRoot: string, told: Pick<VerifyDeps, 'readFuseWire' | 'engineProblem' | 'entitlementsOf' | 'noticeProblems'>): VerifyDeps {
  return {
    say,
    ...told,
    run: (program, args) => {
      const done = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
      return { status: done.status, stdout: done.stdout ?? '', stderr: `${done.stderr ?? ''}${done.error ? `\n${done.error.message}` : ''}` }
    },
    launch: (executable, args, timeoutMs) =>
      new Promise((done) => {
        const started = Date.now()
        let stderr = ''
        let timedOut = false
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], env: launchEnv(process.env) })
        const timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, timeoutMs)
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
        })
        child.on('error', (error) => {
          clearTimeout(timer)
          done({ code: null, stderr: `${stderr}\n${error.message}`, timedOut: false, elapsedMs: Date.now() - started })
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          done({ code, stderr, timedOut, elapsedMs: Date.now() - started })
        })
      }),
    makeTempDir: () => mkdtempSync(join(tmpRoot, 'lucium-verify-app-')),
    removeDir: (path) => rmSync(path, { recursive: true, force: true }),
    now: () => new Date()
  }
}
