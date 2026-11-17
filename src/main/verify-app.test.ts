import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { getLanguage, setLanguage } from '@shared/i18n'
import { settingsPath } from '@shared/settings-path'
import { drmEngineProblem } from './drm-engine-guard'
import { CASTLABS_SIGNED_SET, castlabsReleaseFuses, wireName } from './drm-fuse-trial'
import { entitlementsFor, grantedEntitlements } from './mac-sign-order'
import { FUSE_NAMES, FUSE_SENTINEL, fuseFileOf } from './publish-update'
import { UPDATE_FEED_PUBLIC_KEYS } from './update-feed-keys'
import { publicKeyProblems } from './update-feed-signature'
import {
  CUSTOM_ICON_NOTE,
  OFFICIAL_TEAM_ID,
  LAUNCH_REFUSED_MARK,
  REFUSED_LAUNCHES,
  PRELOAD_MAX_BYTES,
  builderFacts,
  fuseProblems,
  isPreload,
  isSignedAfterPacking,
  isTestFile,
  launchEnv,
  launchProblems,
  parseVerifyArgs,
  plistValues,
  preloadSizeProblems,
  profilePlist,
  profileProblems,
  readAsar,
  realVerifyDeps,
  requirementProblems,
  signatureOf,
  signatureProblems,
  teamChoice,
  unpackedScriptProblems,
  translateHelperFacts,
  verifyApp,
  type CommandResult,
  type FuseWire,
  type LaunchResult,
  type VerifyDeps,
  type VerifyInput
} from './verify-app'

// The check of the application that is handed out (`pnpm verify:app`), on fake packages: real folders, made here, with the files the checks read
// (app.asar, the unpacked files, the licence texts, the provisioning profile), and a fake `codesign`, `spctl`, `stapler` and `plutil` that answer
// what the real ones print for such a bundle. Nothing is signed, and no application is started: the launches are fakes too.
// What a package must be is not written here: it is read from the files of the repository that say it, as the script does.
const here = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url))
const packageJson = JSON.parse(readFileSync(here('package.json'), 'utf8')) as { version: string; devDependencies: Record<string, string>; scripts: Record<string, string> }
const PINNED = packageJson.devDependencies['electron'] ?? ''
const VERSION = packageJson.version
const BUILDER = builderFacts(readFileSync(here('electron-builder.yml'), 'utf8'))
if (!BUILDER) throw new Error('electron-builder.yml names no appId')
const ID = BUILDER.identifier
const TEAM = 'ABCDE12345'
const KEYCHAIN_ENTITLEMENTS = readFileSync(here('native/vault-keychain/entitlements.plist.in'), 'utf8')
// The helper's own Info.plist, as native/system-translate/build.sh copies it into the bundle.
const TRANSLATE_PLIST = readFileSync(here('native/system-translate/Info.plist'), 'utf8')
const TRANSLATE_HELPER = translateHelperFacts(TRANSLATE_PLIST) as { identifier: string; protocol: number }
const FUSES = Object.fromEntries(Object.entries(castlabsReleaseFuses().changed).map(([fuse, enabled]) => [wireName(fuse), enabled]))
// castLabs' set on the wire: RunAsNode off, the cookie encryption on, the two Node switches off, the two ASAR fuses on, then three positions more.
const WIRE: FuseWire = { version: 1, bytes: [0x30, 0x31, 0x30, 0x30, 0x31, 0x31, 0x30, 0x31, 0x31] }
const { shippedNoticeProblems } = createRequire(import.meta.url)(here('scripts/notices/shipped-notices.cjs')) as { shippedNoticeProblems: (dirs: { engine: string; project: string }) => string[] }
const NOW = new Date('2026-11-20T12:00:00Z')

const work = mkdtempSync(join(tmpdir(), 'verify-app-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))
let made = 0

/** What the fake package writes for a file left outside app.asar, and what the header of its archive keeps the hash of. */
const UNPACKED_CONTENT = 'the file'
const sha256 = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex')

interface AsarFile {
  path: string
  unpacked?: boolean
  /** The size the header says (a file inside the archive is weighed by it). */
  size?: number
  /** The hash the header keeps of a file left outside: the one of `UNPACKED_CONTENT` by default, none at all for null. */
  hash?: string | null
}

/** An asar archive with these files (their content is not written: only the header is read). */
function asarOf(files: AsarFile[]): Buffer {
  const tree: { files: Record<string, unknown> } = { files: {} }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = tree
    for (const part of parts.slice(0, -1)) node = (node.files[part] ??= { files: {} }) as typeof tree
    const integrity = file.hash === null ? {} : { integrity: { algorithm: 'SHA256', hash: file.hash ?? sha256(UNPACKED_CONTENT), blockSize: 4194304, blocks: [] } }
    node.files[parts.at(-1) as string] = file.unpacked ? { size: file.size ?? 10, unpacked: true, ...integrity } : { size: file.size ?? 10, offset: '0' }
  }
  const header = Buffer.from(JSON.stringify(tree))
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(header.length + 8, 4)
  head.writeUInt32LE(header.length + 4, 8)
  head.writeUInt32LE(header.length, 12)
  return Buffer.concat([head, header])
}
const headerHashOf = (asar: Buffer): string => createHash('sha256').update(asar.subarray(16)).digest('hex')

const xml = (body: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>`
const trueKeys = (keys: string[]): string => xml(keys.map((key) => `<key>${key}</key><true/>`).join('\n'))
const profileOf = (change: { team?: string; application?: string; groups?: string[]; allDevices?: boolean; expires?: string | null } = {}): Buffer => {
  const team = change.team ?? TEAM
  const body = [
    `<key>TeamIdentifier</key>\n<array>\n<string>${team}</string>\n</array>`,
    `<key>Entitlements</key>\n<dict>\n<key>com.apple.application-identifier</key>\n<string>${change.application ?? `${team}.${ID}.keychain`}</string>\n<key>keychain-access-groups</key>\n<array>\n${(change.groups ?? [`${team}.*`]).map((group) => `<string>${group}</string>`).join('\n')}\n</array>\n</dict>`,
    change.expires === null ? '' : `<key>ExpirationDate</key>\n<date>${change.expires ?? '2044-10-29T14:50:54Z'}</date>`,
    `<key>ProvisionsAllDevices</key>\n<${change.allDevices === false ? 'false' : 'true'}/>`
  ].join('\n')
  // A profile is a signed envelope: bytes that are not text, the property list, then the signature.
  return Buffer.concat([Buffer.from([0x30, 0x82, 0x1f, 0x00, 0x06, 0x09]), Buffer.from(xml(body), 'latin1'), Buffer.from([0xa0, 0x82, 0x00, 0xff, 0x00])])
}

interface Signed {
  identifier?: string
  team?: string | null
  flags?: string
  authority?: string | null
  /** The XML `codesign -d --entitlements - --xml` prints for it. */
  entitlements?: string
}

/** What a fake package differs by from a release that is right. */
interface Fake {
  info?: Record<string, unknown>
  engine?: string
  wire?: FuseWire | null
  /** What reading the fuses throws (the binary of the framework is not there), instead of answering a wire. */
  wireError?: Error
  /** The files of app.asar; null for no app.asar at all. */
  asar?: AsarFile[] | null
  /** The hash Info.plist keeps of the header of app.asar, when it is not the right one. */
  integrity?: string
  /** What app.asar holds after its header (the files themselves): by default the main process with the two public keys of the update feed. */
  asarContent?: string
  /** Paths, relative to the bundle, that are not made (a helper, a licence text, an unpacked file, the profile). */
  without?: string[]
  /** More files, relative to the bundle, with their content. */
  files?: Record<string, string | Buffer>
  /** The signature of a piece, by its path relative to the bundle ('' is the app itself). */
  signed?: Record<string, Signed>
  profile?: Buffer
  requirement?: string
  results?: Partial<Record<'verify' | 'spctl' | 'stapler' | 'plutil' | 'requirement' | 'describe', CommandResult>>
  /** What a launch answers, by the name of the switch. */
  launches?: Record<string, Partial<LaunchResult> | 'throws'>
  /** The launch with the debugging port leaves the file Chromium writes when it opens one. */
  devToolsPort?: boolean
  input?: Partial<VerifyInput>
}

const ASAR: AsarFile[] = [
  { path: 'package.json' },
  { path: 'out/main/index.js' },
  { path: 'out/main/runtime-44vBwoko.js' },
  { path: 'out/preload/index.js' },
  { path: 'out/preload/page-guard.js', unpacked: true },
  { path: 'out/renderer/index.html' },
  { path: 'node_modules/koffi/index.js' },
  { path: 'node_modules/@koromix/koffi-darwin-arm64/koffi.node', unpacked: true },
  // A module may carry its own tests: they are not Lucium's.
  { path: 'node_modules/tldts-experimental/dist/index.test.js' }
]
/** The public keys of the update feed this fake release is built with (two, as during a change of key). */
const FEED_KEYS = ['q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=', 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=']
const HELPERS = ['Lucium Helper.app', 'Lucium Helper (GPU).app', 'Lucium Helper (Plugin).app', 'Lucium Helper (Renderer).app']
const NOTICES: Array<[string, number]> = [['LICENSE', 35_000], ['NOTICE', 2_000], ['ADDITIONAL-PERMISSION.txt', 2_066], ['THIRD-PARTY-NOTICES.txt', 200_000], ['LICENSE.electron.txt', 1_100], ['LICENSES.chromium.html', 15_000_000]]
const REFUSAL = (name: string): string => `${LAUNCH_REFUSED_MARK}: this application does not start with --${name} (development and test switches, accepted only by a run from the sources)\n`

function fakeApp(change: Fake = {}) {
  const app = join(work, `package-${++made}`, 'Lucium.app')
  const without = new Set(change.without ?? [])
  const write = (path: string, content: string | Buffer = ''): void => {
    if (without.has(path) || [...without].some((gone) => path.startsWith(`${gone}/`))) return
    mkdirSync(dirname(join(app, path)), { recursive: true })
    writeFileSync(join(app, path), content)
  }
  const asar = change.asar === null ? null : asarOf(change.asar ?? ASAR)
  if (asar) write('Contents/Resources/app.asar', Buffer.concat([asar, Buffer.from(change.asarContent ?? `const keys=["${FEED_KEYS[0]}","${FEED_KEYS[1]}"];`)]))
  for (const file of (change.asar ?? ASAR).filter((entry) => entry.unpacked)) write(`Contents/Resources/app.asar.unpacked/${file.path}`, UNPACKED_CONTENT)
  for (const [name, size] of NOTICES) {
    write(`Contents/Resources/${name}`)
    // The real size without the bytes: the file is only weighed.
    if (existsSync(join(app, 'Contents/Resources', name))) truncateSync(join(app, 'Contents/Resources', name), size)
  }
  write('Contents/Info.plist', 'a property list')
  write('Contents/MacOS/Lucium', 'the executable')
  write('Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist', 'a property list')
  for (const helper of HELPERS) write(`Contents/Frameworks/${helper}/Contents/Info.plist`, 'a property list')
  write('Contents/Helpers/LuciumTranslate.app/Contents/Info.plist', TRANSLATE_PLIST)
  write('Contents/XPCServices/LuciumKeychain.xpc/Contents/Info.plist', 'a property list')
  write('Contents/XPCServices/LuciumKeychain.xpc/Contents/embedded.provisionprofile', change.profile ?? profileOf())
  for (const [path, content] of Object.entries(change.files ?? {})) write(path, content)

  const info = {
    CFBundleIdentifier: ID,
    CFBundleExecutable: 'Lucium',
    CFBundleShortVersionString: VERSION,
    CFBundleURLTypes: [{ CFBundleURLName: 'Web site URL', CFBundleURLSchemes: ['http', 'https'] }, { CFBundleURLName: 'Lucium command', CFBundleURLSchemes: ['lucium'] }],
    ElectronSquirrelPreventDowngrades: true,
    ElectronAsarIntegrity: { 'Resources/app.asar': { algorithm: 'SHA256', hash: change.integrity ?? (asar ? headerHashOf(asar) : '') } },
    ...change.info
  }
  // Each piece as the build signs it: the entitlements of its plist (the real ones, through `entitlementsOf`), by the team, hardened runtime.
  const entitlementsOf = (piece: string): string[] => {
    const plist = entitlementsFor(app, piece)
    return plist ? grantedEntitlements(readFileSync(here(plist), 'utf8')) : []
  }
  const signedOf = (piece: string): Required<Signed> => {
    const path = piece === app ? '' : piece.slice(app.length + 1)
    const keychain = path.endsWith('LuciumKeychain.xpc')
    const translate = path.endsWith('LuciumTranslate.app')
    return {
      identifier: path === '' ? ID : keychain ? `${ID}.keychain` : translate ? `${ID}.translate` : `${ID}.helper`,
      team: TEAM,
      flags: '0x10000(runtime)',
      authority: `Developer ID Application: Example (${TEAM})`,
      entitlements: keychain ? KEYCHAIN_ENTITLEMENTS.replaceAll('__TEAM_ID__', change.signed?.[path]?.team ?? TEAM) : translate ? '' : trueKeys(entitlementsOf(piece)),
      ...change.signed?.[path]
    }
  }
  const done = (stdout = '', status: number | null = 0, stderr = ''): CommandResult => ({ status, stdout, stderr })
  const ran: string[] = []
  const said: string[] = []
  const launches: Array<{ executable: string; args: string[]; timeoutMs: number }> = []
  const folders: string[] = []
  const removed: string[] = []
  const deps: VerifyDeps = {
    say: (line) => said.push(line),
    run: (program, args) => {
      ran.push(`${program} ${args.join(' ')}`)
      const target = args.at(-1) ?? ''
      if (program === '/usr/bin/plutil') {
        if (change.results?.plutil) return change.results.plutil
        return done(JSON.stringify(target.includes('Electron Framework.framework') ? { CFBundleVersion: change.engine ?? `${PINNED}+wvcus` } : info))
      }
      if (program === 'spctl') return change.results?.spctl ?? done('', 0, `${app}: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Example (${TEAM})\n`)
      if (program === 'xcrun') return change.results?.stapler ?? done(`Processing: ${app}\nThe validate action worked!\n`)
      if (program !== 'codesign') throw new Error(`a program the checks should not run: ${program}`)
      if (args[0] === '--verify') return change.results?.verify ?? done('', 0, `${app}: valid on disk\n${app}: satisfies its Designated Requirement\n`)
      if (args.includes('-r-')) {
        return change.results?.requirement ?? done(change.requirement ?? `designated => identifier "${ID}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "${TEAM}"\n`, 0, `Executable=${app}/Contents/MacOS/Lucium\n`)
      }
      const signed = signedOf(target)
      if (args.includes('--entitlements')) return done(signed.entitlements, 0, `Executable=${target}\n`)
      if (target === app && change.results?.describe) return change.results.describe
      return done(
        '',
        0,
        [
          `Executable=${target}`,
          `Identifier=${signed.identifier}`,
          'Format=app bundle with Mach-O thin (arm64)',
          `CodeDirectory v=20500 size=449 flags=${signed.flags} hashes=3+7 location=embedded`,
          ...(signed.authority ? [`Authority=${signed.authority}`, 'Authority=Developer ID Certification Authority', 'Authority=Apple Root CA'] : []),
          `TeamIdentifier=${signed.team ?? 'not set'}`,
          ''
        ].join('\n')
      )
    },
    launch: async (executable, args, timeoutMs) => {
      launches.push({ executable, args, timeoutMs })
      const name = REFUSED_LAUNCHES.find((launch) => launch.args[0] === args[0])?.name ?? ''
      const answer = change.launches?.[name]
      if (answer === 'throws') throw new Error('spawn EACCES')
      if (name === 'remote-debugging-port' && change.devToolsPort) writeFileSync(join((args.at(-1) ?? '').replace('--user-data-dir=', ''), 'DevToolsActivePort'), '9222\n')
      return { code: 1, stderr: REFUSAL(name), timedOut: false, elapsedMs: 180, ...answer }
    },
    makeTempDir: () => {
      const folder = mkdtempSync(join(work, 'profile-'))
      folders.push(folder)
      return folder
    },
    removeDir: (path) => {
      removed.push(path)
      rmSync(path, { recursive: true, force: true })
    },
    readFuseWire: async () => {
      if (change.wireError) throw change.wireError
      return change.wire === undefined ? WIRE : change.wire
    },
    engineProblem: (engine) => drmEngineProblem({ engine, pinned: PINNED, exception: null }),
    entitlementsOf,
    noticeProblems: (resources) => shippedNoticeProblems({ engine: resources, project: resources }),
    now: () => NOW
  }
  const input: VerifyInput = {
    app,
    version: VERSION,
    identifier: ID,
    urlSchemes: BUILDER?.urlSchemes ?? [],
    team: TEAM,
    keychainEntitlements: KEYCHAIN_ENTITLEMENTS,
    translateHelper: TRANSLATE_HELPER,
    fuseNames: FUSE_NAMES,
    fuses: FUSES,
    feedKeys: { keys: FEED_KEYS, problems: [] },
    launch: true,
    launchTimeoutMs: 20_000,
    ...change.input
  }
  return { app, info, input, deps, ran, said, launches, folders, removed }
}

async function verified(change: Fake = {}) {
  const fake = fakeApp(change)
  const result = await verifyApp(fake.input, fake.deps)
  const failed = result.checks.filter((check) => !check.ok)
  return { ...fake, result, failed, names: failed.map((check) => check.name), detailOf: (name: string): string => result.checks.find((check) => check.name === name)?.detail ?? `(no check named ${name})` }
}

const STATIC_CHECKS = [
  'signature',
  'signer',
  'designated requirement',
  'identifier',
  'version',
  'address schemes',
  'downgrades',
  'engine',
  'fuses',
  'app.asar integrity',
  'unpacked files',
  'unpacked scripts',
  'preload sizes',
  'update feed keys',
  'test files',
  'license texts',
  'entitlements',
  'translation helper',
  'keychain service',
  'keychain profile',
  'Gatekeeper',
  'notarization ticket'
]

describe('a package that is right', () => {
  it('passes every check, then is started twice and refuses both switches', async () => {
    const v = await verified()
    expect(v.failed).toEqual([])
    expect(v.result.checks.map((check) => check.name)).toEqual([...STATIC_CHECKS, 'refuses --smoke', 'refuses --remote-debugging-port'])
    expect(v.result).toMatchObject({ problems: 0, launched: true })
    expect(v.said.every((line) => line.startsWith('  ok  '))).toBe(true)
  })

  it('is only read: codesign to show and to verify, spctl, stapler and plutil, nothing that signs or writes', async () => {
    const v = await verified()
    for (const line of v.ran) expect(line).toMatch(/^(codesign (--verify --deep --strict --verbose=2|-dvvv|-d -r-|-d --entitlements - --xml)|spctl --assess --type execute -vv|xcrun stapler validate|\/usr\/bin\/plutil -convert json -o -) /)
    expect(v.ran).toContain(`codesign --verify --deep --strict --verbose=2 ${v.app}`)
    expect(v.ran).toContain(`spctl --assess --type execute -vv ${v.app}`)
    expect(v.ran).toContain(`xcrun stapler validate ${v.app}`)
  })

  it('is expected to be what the repository says: the identifier and the schemes of electron-builder.yml, castLabs’ set of fuses', () => {
    expect(BUILDER).toEqual({ identifier: 'app.lucium.browser', urlSchemes: ['http', 'https', 'lucium'] })
    expect(builderFacts('productName: Lucium\n')).toBeNull()
    expect(FUSES).toEqual(Object.fromEntries(Object.entries(CASTLABS_SIGNED_SET).map(([fuse, enabled]) => [wireName(fuse), enabled])))
    for (const name of Object.keys(FUSES)) expect(FUSE_NAMES, name).toContain(name)
    expect(fuseProblems(WIRE, FUSE_NAMES, FUSES)).toEqual([])
  })
})

describe('a package that is not the one to hand out fails the check that names its defect, and only that one', () => {
  const adhoc: Signed = { flags: '0x20002(adhoc,linker-signed)', authority: null, team: null }
  const formerId = 'dev.former.browser'
  const cases: Array<[string, Fake, string[], RegExp]> = [
    ['its seal is broken', { results: { verify: { status: 1, stdout: '', stderr: 'Lucium.app: a sealed resource is missing or invalid\nfile modified: Contents/Resources/app.asar' } } }, ['signature'], /codesign --verify --deep --strict: .*a sealed resource is missing or invalid/],
    ['it is signed ad hoc', { signed: { '': adhoc } }, ['signer'], /signed ad hoc, by no certificate\nsigned by the team \(none\), expected ABCDE12345\nsigned without the hardened runtime/],
    ['it is signed by another team', { signed: { '': { team: 'ZZZZZ99999' } } }, ['signer'], /signed by the team ZZZZZ99999, expected ABCDE12345/],
    ['it is signed by a certificate that is not a Developer ID', { signed: { '': { authority: 'Apple Development: someone (ABCDE12345)' } } }, ['signer'], /signed by "Apple Development: someone \(ABCDE12345\)", not by a Developer ID Application certificate/],
    ['it has no hardened runtime', { signed: { '': { flags: '0x0(none)' } } }, ['signer'], /signed without the hardened runtime/],
    ['its requirement names another identifier', { requirement: `designated => identifier "${formerId}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "${TEAM}"\n` }, ['designated requirement'], /it does not name the identifier "app\.lucium\.browser"\nthe requirement is: identifier "dev\.former\.browser"/],
    ['its requirement names another team', { requirement: `designated => identifier "${ID}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "ZZZZZ99999"\n` }, ['designated requirement'], /it does not name the team ABCDE12345/],
    ['its requirement is the one of an ad hoc signature', { requirement: 'designated => cdhash H"bbae7f46450519d5f19f2c6b40fd94911b9df11a"\n' }, ['designated requirement'], /it is not anchored to Apple[\s\S]*it does not ask for the Developer ID certification authority[\s\S]*it does not ask for a Developer ID Application certificate/],
    ['codesign prints no requirement', { requirement: '' }, ['designated requirement'], /codesign printed no designated requirement/],
    ['its Info.plist has the former identifier', { info: { CFBundleIdentifier: formerId } }, ['identifier'], /CFBundleIdentifier is "dev\.former\.browser" and the signature names "app\.lucium\.browser", expected "app\.lucium\.browser"/],
    ['its signature has the former identifier', { signed: { '': { identifier: formerId } } }, ['identifier'], /the signature names "dev\.former\.browser"/],
    ['it is another version', { info: { CFBundleShortVersionString: '0.2.15' } }, ['version'], /CFBundleShortVersionString is "0\.2\.15", expected "/],
    ['it registers a scheme that is not expected', { info: { CFBundleURLTypes: [{ CFBundleURLSchemes: ['http', 'https'] }, { CFBundleURLSchemes: ['lucium', 'former'] }] } }, ['address schemes'], /CFBundleURLTypes registers former, http, https, lucium, expected http, https, lucium/],
    ['it does not register the web schemes', { info: { CFBundleURLTypes: [{ CFBundleURLSchemes: ['lucium'] }] } }, ['address schemes'], /CFBundleURLTypes registers lucium, expected http, https, lucium/],
    ['it registers no scheme at all', { info: { CFBundleURLTypes: undefined } }, ['address schemes'], /CFBundleURLTypes registers none/],
    ['an update could install an older build', { info: { ElectronSquirrelPreventDowngrades: false } }, ['downgrades'], /lacks ElectronSquirrelPreventDowngrades/],
    ['its engine is a prerelease', { engine: '45.0.0-alpha.14+wvcus' }, ['engine'], /the castLabs build is 45\.0\.0-alpha\.14\+wvcus, a prerelease \(alpha\.14\)/],
    ['its engine is the standard Electron, without Widevine', { engine: PINNED }, ['engine'], /without the "\+wvcus" marker/],
    ['its engine is not the pinned Electron', { engine: '44.9.9+wvcus' }, ['engine'], /the castLabs build is 44\.9\.9\+wvcus, but package\.json pins Electron/],
    ['RunAsNode is open', { wire: { ...WIRE, bytes: WIRE.bytes.map((byte, at) => (at === 0 ? 0x31 : byte)) } }, ['fuses'], /^RunAsNode is on, expected off$/],
    ['the cookies are not encrypted', { wire: { ...WIRE, bytes: WIRE.bytes.map((byte, at) => (at === 1 ? 0x30 : byte)) } }, ['fuses'], /^EnableCookieEncryption is off, expected on$/],
    ['the app may be loaded from outside app.asar', { wire: { ...WIRE, bytes: WIRE.bytes.map((byte, at) => (at === 5 ? 0x30 : byte)) } }, ['fuses'], /^OnlyLoadAppFromAsar is off, expected on$/],
    ['its fuse wire is shorter than the fuses that must be closed', { wire: { version: 1, bytes: [0x30, 0x31, 0x30] } }, ['fuses'], /EnableNodeCliInspectArguments is missing, expected off/],
    ['it has no fuse wire', { wire: null }, ['fuses'], /no Electron fuse wire in the framework/],
    ['the binary its fuses are read in is missing', { wireError: new Error("ENOENT: no such file or directory, open 'Electron Framework'") }, ['fuses'], /^the binary of the Electron framework could not be read for its fuses \(ENOENT: no such file or directory, open 'Electron Framework'\): the bundle is incomplete$/],
    ['the hash of app.asar is not the one Info.plist seals', { integrity: 'f'.repeat(64) }, ['app.asar integrity'], /ElectronAsarIntegrity of Info\.plist says "f{64}", the header of app\.asar hashes to [0-9a-f]{64}/],
    ['Info.plist seals no hash for app.asar', { info: { ElectronAsarIntegrity: {} } }, ['app.asar integrity'], /ElectronAsarIntegrity of Info\.plist says null/],
    ['a preload that app.asar leaves outside is not there', { without: ['Contents/Resources/app.asar.unpacked/out/preload/page-guard.js'] }, ['unpacked files'], /^out\/preload\/page-guard\.js is not in app\.asar\.unpacked$/],
    ['a file that app.asar leaves outside is empty', { files: { 'Contents/Resources/app.asar.unpacked/out/preload/page-guard.js': '' } }, ['unpacked files'], /^out\/preload\/page-guard\.js is empty in app\.asar\.unpacked$/],
    ['a preload left outside app.asar is not the one the archive was made with', { files: { 'Contents/Resources/app.asar.unpacked/out/preload/page-guard.js': 'the file, and a line more' } }, ['unpacked scripts'], /^out\/preload\/page-guard\.js in app\.asar\.unpacked is not the file app\.asar was made with: its SHA-256 is [0-9a-f]{64}, the header says [0-9a-f]{64}$/],
    ['the header of app.asar keeps no hash of a preload it leaves outside', { asar: ASAR.map((entry) => (entry.path === 'out/preload/page-guard.js' ? { ...entry, hash: null } : entry)) }, ['unpacked scripts'], /^out\/preload\/page-guard\.js: the header of app\.asar keeps no SHA-256 of it/],
    ['a script that app.asar does not list is beside it', { files: { 'Contents/Resources/app.asar.unpacked/out/preload/extra.js': 'x' } }, ['unpacked scripts'], /^out\/preload\/extra\.js is in app\.asar\.unpacked and app\.asar does not list it$/],
    ['a preload inside app.asar weighs more than a preload may', { asar: [...ASAR.filter((entry) => entry.path !== 'out/preload/index.js'), { path: 'out/preload/index.js', size: PRELOAD_MAX_BYTES + 1 }] }, ['preload sizes'], new RegExp(`^out/preload/index\\.js weighs ${PRELOAD_MAX_BYTES + 1} bytes, more than the ${PRELOAD_MAX_BYTES} a preload may`)],
    [
      'a preload left outside app.asar weighs more than a preload may',
      { asar: ASAR.map((entry) => (entry.path === 'out/preload/page-guard.js' ? { ...entry, hash: sha256('x'.repeat(PRELOAD_MAX_BYTES + 7)) } : entry)), files: { 'Contents/Resources/app.asar.unpacked/out/preload/page-guard.js': 'x'.repeat(PRELOAD_MAX_BYTES + 7) } },
      ['preload sizes'],
      new RegExp(`^out/preload/page-guard\\.js weighs ${PRELOAD_MAX_BYTES + 7} bytes`)
    ],
    ['it lacks a public key of the update feed', { asarContent: `const keys=["${FEED_KEYS[0]}"];` }, ['update feed keys'], /^app\.asar does not hold the public key AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8= of the update feed: this build would refuse the feeds signed with it/],
    ['it was built while the repository held no public key of the update feed', { input: { feedKeys: { keys: [], problems: publicKeyProblems([]) } } }, ['update feed keys'], /^src\/main\/update-feed-keys\.ts holds no public key: a copy of this build would refuse every update feed\. Run `node scripts\/feed-key\.mjs` once/],
    ['the list of public keys of the repository is not one a build may carry, whatever the app holds', { input: { feedKeys: { keys: FEED_KEYS, problems: ['key 2 of src/main/update-feed-keys.ts is there twice'] } } }, ['update feed keys'], /^key 2 of src\/main\/update-feed-keys\.ts is there twice$/],
    ['it carries a helper of the tests', { asar: [...ASAR, { path: 'out/main/app-bundles.test-support-B2BDDH0f.js' }] }, ['test files'], /^out\/main\/app-bundles\.test-support-B2BDDH0f\.js is a file of the tests$/],
    ['it carries an engine suite', { asar: [...ASAR, { path: 'out/main/smoke-run-C0ffee11.js' }] }, ['test files'], /out\/main\/smoke-run-C0ffee11\.js is a file of the tests/],
    ['it carries a test file beside app.asar', { files: { 'Contents/Resources/app.asar.unpacked/out/preload/page-guard.test.js': 'x' } }, ['test files'], /out\/preload\/page-guard\.test\.js is a file of the tests/],
    ['it carries a test runner among its modules', { asar: [...ASAR, { path: 'node_modules/vitest/dist/index.js' }] }, ['test files'], /node_modules\/vitest\/dist\/index\.js is a file of the tests/],
    ['it lacks the licence of Electron', { without: ['Contents/Resources/LICENSE.electron.txt'] }, ['license texts'], /^LICENSE\.electron\.txt: missing$/],
    ['it lacks the notices of Chromium and its own notice', { without: ['Contents/Resources/LICENSES.chromium.html', 'Contents/Resources/NOTICE'] }, ['license texts'], /^LICENSES\.chromium\.html: missing\nNOTICE: missing$/],
    ['it lacks the additional permission for the Widevine module', { without: ['Contents/Resources/ADDITIONAL-PERMISSION.txt'] }, ['license texts'], /^ADDITIONAL-PERMISSION\.txt: missing$/],
    ['the additional permission is a stub', { files: { 'Contents/Resources/ADDITIONAL-PERMISSION.txt': 'see NOTICE' } }, ['license texts'], /^ADDITIONAL-PERMISSION\.txt: 10 bytes, less than the 1500 the real text has$/],
    ['a licence text is a stub', { files: { 'Contents/Resources/LICENSE': 'GPL' } }, ['license texts'], /LICENSE: 3 bytes, less than the 30000 the real text has/],
    ['the renderer helper may load libraries of another team', { signed: { 'Contents/Frameworks/Lucium Helper (Renderer).app': { entitlements: trueKeys(['com.apple.security.cs.allow-jit', 'com.apple.security.cs.disable-library-validation']) } } }, ['entitlements'], /Frameworks\/Lucium Helper \(Renderer\)\.app is signed with \[com\.apple\.security\.cs\.allow-jit, com\.apple\.security\.cs\.disable-library-validation\], expected \[com\.apple\.security\.cs\.allow-jit\]/],
    ['the plugin helper cannot load Widevine', { signed: { 'Contents/Frameworks/Lucium Helper (Plugin).app': { entitlements: trueKeys(['com.apple.security.cs.allow-jit']) } } }, ['entitlements'], /Frameworks\/Lucium Helper \(Plugin\)\.app is signed with \[com\.apple\.security\.cs\.allow-jit\], expected \[.*disable-library-validation/],
    ['the app itself has no entitlement', { signed: { '': { entitlements: '' } } }, ['entitlements'], /^the app is signed with \[none\], expected \[/],
    ['a helper is signed by another team', { signed: { 'Contents/Frameworks/Lucium Helper (GPU).app': { team: 'ZZZZZ99999' } } }, ['entitlements'], /Frameworks\/Lucium Helper \(GPU\)\.app: signed by the team ZZZZZ99999, expected ABCDE12345/],
    ['a helper is missing', { without: ['Contents/Frameworks/Lucium Helper (Plugin).app'] }, ['entitlements'], /the helpers are Lucium Helper \(GPU\)\.app, Lucium Helper \(Renderer\)\.app, Lucium Helper\.app, expected Lucium Helper \(GPU\)\.app, Lucium Helper \(Plugin\)\.app/],
    ['it has a helper nobody decided the entitlements of', { files: { 'Contents/Frameworks/Lucium Helper (Alerts).app/Contents/Info.plist': 'x' } }, ['entitlements'], /Lucium Helper \(Alerts\)\.app is a helper bundle this signer does not know/],
    ['the translation helper is missing', { without: ['Contents/Helpers/LuciumTranslate.app'] }, ['translation helper'], /Contents\/Helpers\/LuciumTranslate\.app is missing/],
    ['the translation helper got the entitlements of the app', { signed: { 'Contents/Helpers/LuciumTranslate.app': { entitlements: trueKeys(['com.apple.security.cs.allow-jit']) } } }, ['translation helper'], /it is signed with entitlements \(com\.apple\.security\.cs\.allow-jit\), expected none/],
    ['the translation helper is signed ad hoc', { signed: { 'Contents/Helpers/LuciumTranslate.app': adhoc } }, ['translation helper'], /signed ad hoc, by no certificate/],
    // What the application asks before it starts the helper (translate/system.ts): signed under another identifier it is never started, for anyone.
    ['the translation helper is signed under another identifier', { signed: { 'Contents/Helpers/LuciumTranslate.app': { identifier: 'lucium-translate' } } }, ['translation helper'], /it is signed under the identifier lucium-translate, the application only starts app\.lucium\.browser\.translate: the translation by macOS would be unavailable/],
    ['the translation helper names no protocol', { files: { 'Contents/Helpers/LuciumTranslate.app/Contents/Info.plist': TRANSLATE_PLIST.replace(/<key>LuciumTranslateProtocol<\/key>\s*<integer>\d+<\/integer>/, '') } }, ['translation helper'], /its Info\.plist names the protocol \(none\) \(LuciumTranslateProtocol\), expected \d+: the application would start it again for every batch/],
    ['the translation helper names an older protocol', { files: { 'Contents/Helpers/LuciumTranslate.app/Contents/Info.plist': TRANSLATE_PLIST.replace(/(<key>LuciumTranslateProtocol<\/key>\s*<integer>)\d+/, '$11') } }, ['translation helper'], /its Info\.plist names the protocol 1 /],
    ['the translation helper carries the property list of another bundle', { files: { 'Contents/Helpers/LuciumTranslate.app/Contents/Info.plist': TRANSLATE_PLIST.replace('app.lucium.browser.translate', 'app.lucium.browser') } }, ['translation helper'], /its Info\.plist names the bundle app\.lucium\.browser, expected app\.lucium\.browser\.translate/],
    ['the translation helper has no property list', { without: ['Contents/Helpers/LuciumTranslate.app/Contents/Info.plist'], files: { 'Contents/Helpers/LuciumTranslate.app/Contents/MacOS/lucium-translate': 'x' } }, ['translation helper'], /Helpers\/LuciumTranslate\.app\/Contents\/Info\.plist: ENOENT[^]*its Info\.plist cannot be read/],
    ['the keychain service is missing', { without: ['Contents/XPCServices/LuciumKeychain.xpc'] }, ['keychain service'], /Contents\/XPCServices\/LuciumKeychain\.xpc is missing: Touch ID would be unavailable/],
    ['the keychain service was signed without its entitlements', { signed: { 'Contents/XPCServices/LuciumKeychain.xpc': { entitlements: '' } } }, ['keychain service'], /it is signed with \{\}, expected \{"com\.apple\.application-identifier":"ABCDE12345\.app\.lucium\.browser\.keychain".*Touch ID is unavailable/],
    ['the keychain service was signed again with the entitlements of the app', { signed: { 'Contents/XPCServices/LuciumKeychain.xpc': { entitlements: trueKeys(['com.apple.security.cs.allow-jit']) } } }, ['keychain service'], /it is signed with \{"com\.apple\.security\.cs\.allow-jit":true\}, expected/],
    ['the keychain service has another access group', { signed: { 'Contents/XPCServices/LuciumKeychain.xpc': { entitlements: KEYCHAIN_ENTITLEMENTS.replaceAll('__TEAM_ID__', TEAM).replace('.vault', '.other') } } }, ['keychain service'], /it is signed with .*app\.lucium\.browser\.other/],
    ['the keychain service has no provisioning profile', { without: ['Contents/XPCServices/LuciumKeychain.xpc/Contents/embedded.provisionprofile'] }, ['keychain profile'], /the keychain service has no embedded\.provisionprofile: macOS would refuse to start it/],
    ['its provisioning profile is not one', { profile: Buffer.from('not a profile') }, ['keychain profile'], /embedded\.provisionprofile holds no property list/],
    ['its provisioning profile is of another application', { profile: profileOf({ application: `${TEAM}.dev.former.browser.keychain` }) }, ['keychain profile'], /it authorizes the application "ABCDE12345\.dev\.former\.browser\.keychain", the service is ABCDE12345\.app\.lucium\.browser\.keychain/],
    ['its provisioning profile is of another team', { profile: profileOf({ team: 'ZZZZZ99999' }) }, ['keychain profile'], /it is the profile of the team ZZZZZ99999, not of ABCDE12345/],
    ['its provisioning profile does not grant the access group', { profile: profileOf({ groups: [`${TEAM}.app.lucium.browser.other`] }) }, ['keychain profile'], /it does not grant the keychain access group ABCDE12345\.app\.lucium\.browser\.vault \(it grants: ABCDE12345\.app\.lucium\.browser\.other\)/],
    ['its provisioning profile is a development one', { profile: profileOf({ allDevices: false }) }, ['keychain profile'], /it is not a profile for every Mac/],
    ['its provisioning profile has expired', { profile: profileOf({ expires: '2026-11-20T11:59:59Z' }) }, ['keychain profile'], /it expired on 2026-11-20T11:59:59\.000Z/],
    ['its provisioning profile has no expiration date', { profile: profileOf({ expires: null }) }, ['keychain profile'], /it has no expiration date/],
    ['Gatekeeper rejects it', { results: { spctl: { status: 3, stdout: '', stderr: 'Lucium.app: rejected\nsource=Unnotarized Developer ID\n' } } }, ['Gatekeeper'], /spctl --assess: Lucium\.app: rejected \| source=Unnotarized Developer ID/],
    ['Gatekeeper accepts it without a notarization', { results: { spctl: { status: 0, stdout: '', stderr: 'Lucium.app: accepted\nsource=Developer ID\n' } } }, ['Gatekeeper'], /source=Developer ID/],
    ['no ticket is stapled to it', { results: { stapler: { status: 65, stdout: 'Lucium.app does not have a ticket stapled to it.\n', stderr: '' } } }, ['notarization ticket'], /xcrun stapler validate: Lucium\.app does not have a ticket stapled to it/]
  ]

  it.each(cases)('%s', async (_name, change, names, detail) => {
    const v = await verified(change)
    expect(v.names).toEqual(names)
    expect(v.detailOf(names[0] ?? '')).toMatch(detail)
    expect(v.result.problems).toBe(names.length)
    // An app that failed a check is never started.
    expect(v.launches).toEqual([])
    expect(v.result.launched).toBe(false)
    expect(v.said.at(-1)).toMatch(/refused switches: not checked, the app was not started: 1 check\(s\) failed above/)
    // Every other check was still made: a defect does not hide the next.
    // (The profile is in the keychain service: without the service, there is no profile to read.)
    const made = v.result.checks.map((check) => check.name)
    for (const name of STATIC_CHECKS) if (!(name === 'keychain profile' && names[0] === 'keychain service' && !made.includes(name))) expect(made, name).toContain(name)
    expect(made.length).toBeGreaterThanOrEqual(STATIC_CHECKS.length - 1)
  })

  it('a package without app.asar fails on it, and its other checks are still made', async () => {
    const v = await verified({ asar: null })
    expect(v.names).toEqual(['app.asar'])
    expect(v.detailOf('app.asar')).toMatch(/Contents\/Resources\/app\.asar is missing or is not an asar archive/)
    expect(v.result.checks.map((check) => check.name)).toContain('notarization ticket')
    const garbage = await verified({ files: { 'Contents/Resources/app.asar': 'not an archive, but long enough to have a head' } })
    expect(garbage.names).toEqual(['app.asar'])
  })

  it('a folder that is not a bundle fails at once, and nothing is run on it', async () => {
    const v = await verified({ without: ['Contents/Info.plist'] })
    expect(v.result).toMatchObject({ problems: 1, launched: false })
    expect(v.detailOf('bundle')).toMatch(/is not an application bundle: no Contents\/Info\.plist/)
    expect(v.ran).toEqual([])
    expect(v.launches).toEqual([])
  })

  it('a package whose Info.plist cannot be read says so, with what plutil answered', async () => {
    const v = await verified({ results: { plutil: { status: 1, stdout: '', stderr: 'Info.plist: Property List error: Unexpected character' } } })
    expect(v.names).toEqual(expect.arrayContaining(['Info.plist', 'engine', 'app.asar integrity']))
    expect(v.detailOf('Info.plist')).toMatch(/cannot read .*Info\.plist: Info\.plist: Property List error/)
    const notJson = await verified({ results: { plutil: { status: 0, stdout: '<plist>', stderr: '' } } })
    expect(notJson.detailOf('Info.plist')).toMatch(/plutil did not print .*Info\.plist as JSON/)
  })

  it('a package codesign cannot describe is not signed by anyone', async () => {
    const v = await verified({ results: { describe: { status: 1, stdout: '', stderr: 'Lucium.app: code object is not signed at all' } } })
    expect(v.names).toContain('signer')
    expect(v.detailOf('signer')).toMatch(/codesign -dvvv: Lucium\.app: code object is not signed at all/)
    const unreadable = await verified({ results: { requirement: { status: 1, stdout: '', stderr: 'code object is not signed at all' } } })
    expect(unreadable.detailOf('designated requirement')).toMatch(/codesign -d -r-: code object is not signed at all/)
  })

  it('counts every defect of a package that has several', async () => {
    const v = await verified({ info: { CFBundleIdentifier: 'dev.former.browser', CFBundleShortVersionString: '0.2.15' }, engine: '45.0.0-alpha.14+wvcus', without: ['Contents/Resources/NOTICE'] })
    expect(v.names).toEqual(['identifier', 'version', 'engine', 'license texts'])
    expect(v.result.problems).toBe(4)
    expect(v.said.at(-1)).toMatch(/4 check\(s\) failed above/)
  })
})

/** The way to the icon in Settings, as the English interface writes it: what a message for the maintainer, written in English, must say. */
function iconPathInEnglish(): string {
  const before = getLanguage()
  setLanguage('en')
  try {
    return settingsPath('appIcon')
  } finally {
    setLanguage(before)
  }
}

describe('a copy that carries the icon chosen in Settings', () => {
  const detritus = { status: 1, stdout: '', stderr: 'Lucium.app: resource fork, Finder information, or similar detritus not allowed\nfile with invalid attached data: Disallowed xattr com.apple.FinderInfo found on Lucium.app' }

  it('fails the strict check of the signature, and the line says that the build is not at fault', async () => {
    const v = await verified({ files: { 'Icon\r': '' }, results: { verify: detritus } })
    expect(v.names).toEqual(['signature'])
    expect(v.detailOf('signature')).toBe(`codesign --verify --deep --strict: ${detritus.stderr.split('\n').join(' | ')}\n${CUSTOM_ICON_NOTE}`)
    // The place is the one the window has today, written by the same map as the other paths to the Settings (the window's own test checks it is there).
    expect(CUSTOM_ICON_NOTE).toBe(`a custom icon is set on this copy (${iconPathInEnglish()}): this is not a defect of the build; the build handed out carries none`)
    expect(iconPathInEnglish()).toBe('Settings › About and updates › App icon')
    expect(v.said).toContain(`        ${' '.repeat('signature'.length)}  ${CUSTOM_ICON_NOTE}`)
  })

  it('says nothing of an icon the copy does not carry, nor for another defect of a copy that carries one', async () => {
    const without = await verified({ results: { verify: detritus } })
    expect(without.detailOf('signature')).not.toContain(CUSTOM_ICON_NOTE)
    const broken = await verified({ files: { 'Icon\r': '' }, results: { verify: { status: 1, stdout: '', stderr: 'Lucium.app: a sealed resource is missing or invalid' } } })
    expect(broken.detailOf('signature')).not.toContain(CUSTOM_ICON_NOTE)
    const valid = await verified({ files: { 'Icon\r': '' } })
    expect(valid.names).toEqual([])
  })
})

describe('the team', () => {
  it('is read from the signature when none is expected (--any-team), said, and still compared between the pieces, the requirement and the profile', async () => {
    const v = await verified({ input: { team: null } })
    expect(v.failed).toEqual([])
    expect(v.detailOf('signer')).toMatch(/--any-team: team ABCDE12345 read from the signature, not compared with an expected one; this is not the check of a build to hand out/)
    const mixed = await verified({ input: { team: null }, signed: { 'Contents/Frameworks/Lucium Helper.app': { team: 'ZZZZZ99999' } } })
    expect(mixed.names).toEqual(['entitlements'])
  })

  it('is the team of the official builds unless --team or LUCIUM_TEAM_ID names another: it is never read from the signature', () => {
    const none = { team: null, anyTeam: false }
    // The team the README publishes, read in the signature of the installed application: a changed constant must change the documents too.
    expect(OFFICIAL_TEAM_ID).toBe('9A9AUX9UHT')
    expect(teamChoice(none, undefined)).toEqual({ ok: true, team: OFFICIAL_TEAM_ID, official: true })
    expect(teamChoice(none, '  ')).toEqual({ ok: true, team: OFFICIAL_TEAM_ID, official: true })
    expect(teamChoice(none, ' ABCDE12345 ')).toEqual({ ok: true, team: 'ABCDE12345', official: false })
    expect(teamChoice({ team: 'ZZZZZ99999', anyTeam: false }, 'ABCDE12345')).toEqual({ ok: true, team: 'ZZZZZ99999', official: false })
    expect(teamChoice(none, 'the team')).toEqual({ ok: false, message: 'LUCIUM_TEAM_ID is not a team identifier (10 letters and digits)' })
    // A variable that is not a team is not read when --team names one.
    expect(teamChoice({ team: 'ZZZZZ99999', anyTeam: false }, 'the team')).toEqual({ ok: true, team: 'ZZZZZ99999', official: false })
  })

  it('is the team the READMEs and the release process publish, with the command that reads it in a signature', () => {
    for (const file of ['README.md', 'README.fr.md']) {
      const text = readFileSync(here(file), 'utf8')
      expect(text, file).toContain(`# TeamIdentifier=${OFFICIAL_TEAM_ID}`)
      expect(text, file).toContain('codesign -dv --verbose=2 /Applications/Lucium.app')
    }
    expect(readFileSync(here('docs/community/release-process.md'), 'utf8')).toContain(`\`${OFFICIAL_TEAM_ID}\``)
  })

  it('by default, an app another team signed is not an official build', async () => {
    const chosen = teamChoice({ team: null, anyTeam: false }, undefined)
    if (!chosen.ok) throw new Error(chosen.message)
    const v = await verified({ input: { team: chosen.team } })
    expect(v.names).toContain('signer')
    expect(v.detailOf('signer')).toContain(OFFICIAL_TEAM_ID)
  })

  it('is left out only by --any-team, said in so many words, and never beside a team', () => {
    expect(teamChoice({ team: null, anyTeam: true }, undefined)).toEqual({ ok: true, team: null, official: false })
    expect(teamChoice({ team: null, anyTeam: true }, 'ABCDE12345')).toEqual({ ok: false, message: expect.stringMatching(/LUCIUM_TEAM_ID names the team expected and --any-team expects none/) })
    expect(parseVerifyArgs(['a.app', '--any-team'])).toMatchObject({ ok: true, options: { team: null, anyTeam: true } })
    expect(parseVerifyArgs(['a.app', '--any-team', '--team', 'ABCDE12345'])).toEqual({ ok: false, message: '--team names the team expected and --any-team expects none: give one of the two' })
  })

  it('cannot be read from an app that is not signed: the checks that need one say so instead of passing', async () => {
    const v = await verified({ input: { team: null }, signed: { '': { flags: '0x2(adhoc)', authority: null, team: null } } })
    expect(v.names).toEqual(expect.arrayContaining(['signer', 'designated requirement', 'translation helper', 'keychain service']))
    expect(v.detailOf('signer')).toMatch(/signed by no team \(ad hoc, or not signed\): not a build to hand out/)
    expect(v.detailOf('keychain service')).toMatch(/no team to check its entitlements with/)
  })
})

describe('the launches that must be refused', () => {
  it('start the executable of the bundle with the switch and a throw-away data folder of their own, removed afterwards', async () => {
    const v = await verified()
    expect(v.launches.map((launch) => launch.args.slice(0, -1))).toEqual([['--smoke'], ['--remote-debugging-port=0']])
    expect(v.launches.map((launch) => launch.executable)).toEqual([join(v.app, 'Contents', 'MacOS', 'Lucium'), join(v.app, 'Contents', 'MacOS', 'Lucium')])
    expect(v.launches.map((launch) => launch.args.at(-1))).toEqual(v.folders.map((folder) => `--user-data-dir=${folder}`))
    expect(new Set(v.folders).size).toBe(2)
    expect(v.launches.every((launch) => launch.timeoutMs === 20_000)).toBe(true)
    expect(v.removed).toEqual(v.folders)
    for (const folder of v.folders) expect(existsSync(folder)).toBe(false)
    expect(v.detailOf('refuses --smoke')).toBe('left with code 1 in 180 ms and said so, before it made anything')
  })

  it('are not made with --no-launch, and the output says that the switches were not checked', async () => {
    const v = await verified({ input: { launch: false } })
    expect(v.launches).toEqual([])
    expect(v.result).toMatchObject({ problems: 0, launched: false })
    expect(v.said.at(-1)).toBe('  --    refused switches: NOT CHECKED (--no-launch): the app was not started')
  })

  const cases: Array<[string, Fake, string, RegExp]> = [
    ['the app is still running when the time is up', { launches: { smoke: { code: null, stderr: '', timedOut: true, elapsedMs: 20_004 } } }, 'refuses --smoke', /the app was still running after 20 s with --smoke: it did not refuse the switch \(it was stopped\)/],
    ['the app runs the suites and leaves with 0', { launches: { smoke: { code: 0, stderr: '' } } }, 'refuses --smoke', /the app left with code 0 with --smoke, expected 1\nthe app did not say that it refuses --smoke/],
    ['the app crashes: code 1, but for another reason', { launches: { smoke: { stderr: 'Error: Cannot find module ./smoke-run\n' } } }, 'refuses --smoke', /^the app did not say that it refuses --smoke \("\[launch\] refused: …"\): it left for another reason, or the switch was read$/],
    ['the app is killed by a signal', { launches: { smoke: { code: null } } }, 'refuses --smoke', /the app left with no exit code with --smoke, expected 1/],
    ['the app refuses another switch than the one it was given', { launches: { 'remote-debugging-port': { stderr: REFUSAL('smoke') } } }, 'refuses --remote-debugging-port', /the app did not say that it refuses --remote-debugging-port/],
    ['the app opens the debugging port before it leaves', { devToolsPort: true }, 'refuses --remote-debugging-port', /a DevToolsActivePort file was written in the data folder: the debugging port was opened/]
  ]
  it.each(cases)('fail when %s', async (_name, change, name, detail) => {
    const v = await verified(change)
    expect(v.names).toEqual([name])
    expect(v.detailOf(name)).toMatch(detail)
    // Both launches are made, whatever the first did, and both folders are removed.
    expect(v.launches).toHaveLength(2)
    expect(v.removed).toEqual(v.folders)
  })

  it('remove the data folder when the app cannot be started at all, and let the error out', async () => {
    const fake = fakeApp({ launches: { smoke: 'throws' } })
    await expect(verifyApp(fake.input, fake.deps)).rejects.toThrow('spawn EACCES')
    expect(fake.removed).toEqual(fake.folders)
    expect(fake.folders).toHaveLength(1)
  })

  it('are about switches the application refuses, with the words it says when it does', () => {
    const runtime = readFileSync(here('src/main/runtime.ts'), 'utf8')
    const refused = /export const REFUSED_SWITCHES: readonly string\[\] = \[([^\]]+)\]/.exec(runtime)?.[1] ?? ''
    for (const launch of REFUSED_LAUNCHES) {
      expect(refused, launch.name).toContain(`'${launch.name}'`)
      expect(launch.args[0]?.startsWith(`--${launch.name}`)).toBe(true)
    }
    expect(readFileSync(here('src/main/index.ts'), 'utf8')).toContain(`console.error(\`${LAUNCH_REFUSED_MARK}: this application does not start with \${refused.map((name) => \`--\${name}\`).join(', ')}`)
  })

  it('judge a launch on its code, its words, its time and what it left', () => {
    const good: LaunchResult = { code: 1, stderr: REFUSAL('smoke'), timedOut: false, elapsedMs: 200 }
    expect(launchProblems(good, 'smoke', { devToolsPort: false })).toEqual([])
    expect(launchProblems({ ...good, code: 2 }, 'smoke', { devToolsPort: false })).toEqual(['the app left with code 2 with --smoke, expected 1'])
    expect(launchProblems({ ...good, timedOut: true, elapsedMs: 20_000 }, 'smoke', { devToolsPort: false })).toEqual([expect.stringMatching(/still running after 20 s/)])
    expect(launchProblems(good, 'smoke', { devToolsPort: true })).toEqual([expect.stringMatching(/DevToolsActivePort/)])
  })
})

describe('what codesign prints', () => {
  // The output of `codesign -dvvv` on a signed and notarized build (the team is made up).
  const described = [
    'Executable=/Applications/Lucium.app/Contents/MacOS/Lucium',
    'Identifier=app.lucium.browser',
    'Format=app bundle with Mach-O thin (arm64)',
    'CodeDirectory v=20500 size=449 flags=0x10000(runtime) hashes=3+7 location=embedded',
    'Hash type=sha256 size=32',
    'CDHash=bbae7f46450519d5f19f2c6b40fd94911b9df11a',
    'Authority=Developer ID Application: Example (ABCDE12345)',
    'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA',
    'Timestamp=10 Nov 2026 at 07:46:54',
    'Notarization Ticket=stapled',
    'TeamIdentifier=ABCDE12345',
    'Runtime Version=26.5.0'
  ].join('\n')

  it('is read for the identifier, the team, the flags and the chain of certificates', () => {
    expect(signatureOf(described)).toEqual({ identifier: 'app.lucium.browser', team: 'ABCDE12345', flags: ['runtime'], authorities: ['Developer ID Application: Example (ABCDE12345)', 'Developer ID Certification Authority', 'Apple Root CA'] })
    expect(signatureProblems(signatureOf(described), 'ABCDE12345')).toEqual([])
  })

  it('is read as no team and no certificate for an ad hoc signature, and as nothing for a piece that is not signed', () => {
    const adhoc = signatureOf('Identifier=Lucium\nCodeDirectory v=20400 size=500 flags=0x20002(adhoc,linker-signed) hashes=9+0 location=embedded\nSignature=adhoc\nTeamIdentifier=not set\n')
    expect(adhoc).toEqual({ identifier: 'Lucium', team: null, flags: ['adhoc', 'linker-signed'], authorities: [] })
    expect(signatureProblems(adhoc, 'ABCDE12345')).toEqual(['signed ad hoc, by no certificate', 'signed by the team (none), expected ABCDE12345', 'signed without the hardened runtime'])
    expect(signatureOf('Lucium.app: code object is not signed at all')).toEqual({ identifier: null, team: null, flags: [], authorities: [] })
  })

  it('gives the requirement of a Developer ID build, with or without the mark codesign puts before it', () => {
    const requirement = 'identifier "app.lucium.browser" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "ABCDE12345"'
    const want = { identifier: 'app.lucium.browser', team: 'ABCDE12345' }
    expect(requirementProblems(`Executable=/x\ndesignated => ${requirement}\n`, want)).toEqual([])
    expect(requirementProblems(`# designated => ${requirement.replace('"ABCDE12345"', 'ABCDE12345')}\n`, want)).toEqual([])
    // A longer identifier that starts the same is another application.
    expect(requirementProblems(`designated => ${requirement.replace('app.lucium.browser', 'app.lucium.browser.drm')}\n`, want)[0]).toBe('it does not name the identifier "app.lucium.browser"')
    // A team is named whole: neither the beginning of a longer one, nor no team at all.
    expect(requirementProblems(`designated => ${requirement.replace('ABCDE12345', 'ABCDE123456')}\n`, want)[0]).toBe('it does not name the team ABCDE12345')
    expect(requirementProblems(`designated => ${requirement}\n`, { ...want, team: '' })[0]).toBe('it does not name the team (none)')
  })
})

describe('the property lists the checks read', () => {
  it('give booleans, strings and lists of strings by key, and read no comment', () => {
    expect(plistValues(KEYCHAIN_ENTITLEMENTS.replaceAll('__TEAM_ID__', 'ABCDE12345'))).toEqual({
      'com.apple.application-identifier': 'ABCDE12345.app.lucium.browser.keychain',
      'com.apple.developer.team-identifier': 'ABCDE12345',
      'keychain-access-groups': ['ABCDE12345.app.lucium.browser.vault']
    })
    expect(plistValues('<dict><key>a</key><true/><key>b</key><false/><!-- <key>c</key><true/> --><key>d</key><array/></dict>')).toEqual({ a: true, b: false, d: [] })
    expect(plistValues('')).toEqual({})
  })

  it('find the property list inside the envelope of a provisioning profile', () => {
    const profile = profileOf()
    expect(profilePlist(profile)?.startsWith('<?xml')).toBe(true)
    expect(profilePlist(profile)?.endsWith('</plist>')).toBe(true)
    expect(profilePlist(Buffer.from('</plist> then <?xml'))).toBeNull()
    expect(profilePlist(Buffer.alloc(0))).toBeNull()
    const want = { team: TEAM, applicationIdentifier: `${TEAM}.${ID}.keychain`, accessGroups: [`${TEAM}.${ID}.vault`], now: NOW }
    expect(profileProblems(profilePlist(profile) ?? '', want)).toEqual([])
    // The group itself, without a wildcard, is granted too; a wildcard of another prefix is not.
    expect(profileProblems(profilePlist(profileOf({ groups: [`${TEAM}.${ID}.vault`] })) ?? '', want)).toEqual([])
    expect(profileProblems(profilePlist(profileOf({ groups: ['ZZZZZ99999.*'] })) ?? '', want)).toHaveLength(1)
  })
})

describe('the files left outside app.asar', () => {
  const entry = (path: string, content: string | null = UNPACKED_CONTENT) => ({ path, size: 10, unpacked: true, ...(content === null ? {} : { hash: sha256(content) }) })
  const disk = (files: Record<string, string>) => (path: string): Buffer | null => (path in files ? Buffer.from(files[path] as string) : null)

  it('are the ones the header keeps the hash of: nothing to say', () => {
    const entries = [{ path: 'package.json', size: 10, unpacked: false }, entry('out/preload/page-guard.js'), entry('node_modules/x/index.js')]
    expect(unpackedScriptProblems(entries, ['out/preload/page-guard.js', 'node_modules/x/index.js'], disk({ 'out/preload/page-guard.js': UNPACKED_CONTENT, 'node_modules/x/index.js': UNPACKED_CONTENT }))).toEqual([])
  })

  it('name the script that was changed, the one without a hash and the one that is not listed, each once', () => {
    const entries = [entry('out/preload/page-guard.js'), entry('out/preload/media-bridge.js', null), entry('out/preload/gone.js')]
    const problems = unpackedScriptProblems(entries, ['out/preload/page-guard.js', 'out/preload/media-bridge.js', 'out/preload/planted.js'], disk({ 'out/preload/page-guard.js': 'changed', 'out/preload/media-bridge.js': UNPACKED_CONTENT }))
    expect(problems).toEqual([
      `out/preload/page-guard.js in app.asar.unpacked is not the file app.asar was made with: its SHA-256 is ${sha256('changed')}, the header says ${sha256(UNPACKED_CONTENT)}`,
      'out/preload/media-bridge.js: the header of app.asar keeps no SHA-256 of it, so it cannot be told from another file',
      'out/preload/planted.js is in app.asar.unpacked and app.asar does not list it'
    ])
  })

  it('leave a native module to the signature: signing it after the archive is made changes its bytes', () => {
    expect(isSignedAfterPacking('node_modules/@koromix/koffi-darwin-arm64/koffi.node')).toBe(true)
    expect(isSignedAfterPacking('Frameworks/libffmpeg.dylib')).toBe(true)
    expect(isSignedAfterPacking('out/preload/page-guard.js')).toBe(false)
    expect(isSignedAfterPacking('node_modules/x/node.js')).toBe(false)
    expect(unpackedScriptProblems([entry('a/koffi.node')], ['a/koffi.node', 'b/other.node'], disk({ 'a/koffi.node': 'signed since' }))).toEqual([])
  })

  it('a package whose native module was signed after the archive was made passes', async () => {
    const v = await verified({ files: { 'Contents/Resources/app.asar.unpacked/node_modules/@koromix/koffi-darwin-arm64/koffi.node': 'the file, signed since' } })
    expect(v.failed).toEqual([])
    expect(v.detailOf('unpacked scripts')).toMatch(/^the 1 scripts left outside app\.asar are the ones its header keeps the SHA-256 of/)
    expect(v.detailOf('preload sizes')).toBe(`the 2 preloads weigh 10 bytes at most (the bound is ${PRELOAD_MAX_BYTES})`)
  })
})

describe('the preloads', () => {
  it('are the scripts of out/preload and the preloads of the extension libraries', () => {
    for (const path of ['out/preload/index.js', 'out/preload/page-guard.js', 'node_modules/electron-chrome-extensions/dist/chrome-extension-api.preload.js']) expect(isPreload(path), path).toBe(true)
    for (const path of ['out/main/index.js', 'out/preload/index.js.map', 'out/preload/chunks/shared.js', 'node_modules/x/preload.js']) expect(isPreload(path), path).toBe(false)
  })

  it('may weigh the bound and not a byte more; one that cannot be weighed is left to the check of the files', () => {
    const sizes: Record<string, number | null> = { 'out/preload/a.js': PRELOAD_MAX_BYTES, 'out/preload/b.js': PRELOAD_MAX_BYTES + 1, 'out/preload/c.js': null }
    expect(preloadSizeProblems(Object.keys(sizes), (path) => sizes[path] ?? null)).toEqual([`out/preload/b.js weighs ${PRELOAD_MAX_BYTES + 1} bytes, more than the ${PRELOAD_MAX_BYTES} a preload may: it runs before every page it is given to (a dependency bundled by mistake?)`])
  })

  it('have a bound above the heaviest one of today and far under a bundled library', () => {
    expect(PRELOAD_MAX_BYTES).toBe(64 * 1024)
  })
})

describe('app.asar', () => {
  it('is read for its header and the files it lists, those left outside marked', () => {
    const file = join(work, 'read.asar')
    writeFileSync(file, asarOf([{ path: 'package.json' }, { path: 'out/preload/page-guard.js', unpacked: true }]))
    const read = readAsar(file)
    expect(read?.entries).toEqual([{ path: 'package.json', size: 10, unpacked: false }, { path: 'out/preload/page-guard.js', size: 10, unpacked: true, hash: sha256(UNPACKED_CONTENT) }])
    // A hash that is not a SHA-256 is no hash.
    writeFileSync(file, asarOf([{ path: 'out/preload/page-guard.js', unpacked: true, hash: 'abc' }, { path: 'out/preload/media-bridge.js', unpacked: true, hash: null }]))
    expect(readAsar(file)?.entries).toEqual([{ path: 'out/preload/page-guard.js', size: 10, unpacked: true }, { path: 'out/preload/media-bridge.js', size: 10, unpacked: true }])
    expect(JSON.parse(read?.header ?? '{}')).toHaveProperty('files')
  })

  it('is not one when the file is missing, too short, has another head, a length that is not one, or a header that is not JSON', () => {
    const write = (name: string, content: Buffer): string => {
      writeFileSync(join(work, name), content)
      return join(work, name)
    }
    const good = asarOf([{ path: 'package.json' }])
    expect(readAsar(join(work, 'missing.asar'))).toBeNull()
    expect(readAsar(write('short.asar', good.subarray(0, 10)))).toBeNull()
    expect(readAsar(write('head.asar', Buffer.concat([Buffer.from([9, 0, 0, 0]), good.subarray(4)])))).toBeNull()
    expect(readAsar(write('cut.asar', good.subarray(0, good.length - 5)))).toBeNull()
    const huge = Buffer.from(good)
    huge.writeUInt32LE(0xffffffff, 12)
    expect(readAsar(write('huge.asar', huge))).toBeNull()
    const broken = Buffer.from(good)
    broken.write('!', 16)
    expect(readAsar(write('broken.asar', broken))).toBeNull()
  })

  it('holds a file of the tests when a path is an engine suite, a test helper, a test, a tests folder, a probe extension or a test runner', () => {
    for (const path of ['out/main/smoke-run-C0ffee11.js', 'out/main/smoke.js', 'out/main/app-bundles.test-support-B2BDDH0f.js', 'out/main/keychain-test-support-1.js', 'out/renderer/store.test.js', 'out/main/a.spec.mjs', 'tests/e2e/launch.js', 'compat/api-probe/manifest.json', 'src/__tests__/a.js', 'node_modules/vitest/index.js', 'node_modules/@playwright/test/index.js']) {
      expect(isTestFile(path), path).toBe(true)
    }
    for (const path of ['out/main/index.js', 'out/main/runtime-44vBwoko.js', 'out/renderer/assets/smoke-B1.css', 'out/main/latest-D4.js', 'out/renderer/attestation.js', 'package.json', 'node_modules/koffi/test/a.test.js', 'node_modules/tldts-experimental/dist/index.test.js', 'out/main/compat-C5cgcsuk.js']) {
      expect(isTestFile(path), path).toBe(false)
    }
  })
})

describe('the fuses', () => {
  it('name each fuse that is not at its value, and a fuse whose position is not known', () => {
    expect(fuseProblems({ version: 1, bytes: [0x31, 0x30, 0x72] }, ['A', 'B', 'C'], { A: false, B: true, C: true })).toEqual(['A is on, expected off', 'B is off, expected on', 'C is 0x72, expected on'])
    expect(fuseProblems({ version: 1, bytes: [0x30] }, ['A'], { A: false, Z: true })).toEqual(['the fuse Z has no position in the wire that is known here'])
  })
})

describe('the arguments of pnpm verify:app', () => {
  it('are the application, and the options --no-launch, --team and --version', () => {
    expect(parseVerifyArgs(['/Applications/Lucium.app'])).toEqual({ ok: true, options: { app: '/Applications/Lucium.app', team: null, anyTeam: false, version: null, noLaunch: false, help: false } })
    expect(parseVerifyArgs(['--no-launch', 'a.app', '--team', 'ABCDE12345', '--version', '1.0.0'])).toEqual({ ok: true, options: { app: 'a.app', team: 'ABCDE12345', anyTeam: false, version: '1.0.0', noLaunch: true, help: false } })
    expect(parseVerifyArgs(['--help'])).toMatchObject({ ok: true, options: { help: true } })
  })

  it('are refused without an application, with two, with an unknown option, a missing value, or a team that is not one', () => {
    expect(parseVerifyArgs([])).toEqual({ ok: false, message: 'Which application? Give the path of Lucium.app' })
    expect(parseVerifyArgs(['a.app', 'b.app'])).toMatchObject({ ok: false, message: expect.stringMatching(/Only one application/) })
    expect(parseVerifyArgs(['a.app', '--launch'])).toEqual({ ok: false, message: 'Unknown option: --launch' })
    expect(parseVerifyArgs(['a.app', '--team'])).toEqual({ ok: false, message: '--team needs a value' })
    expect(parseVerifyArgs(['a.app', '--team', '--no-launch'])).toEqual({ ok: false, message: '--team needs a value' })
    expect(parseVerifyArgs(['a.app', '--team', 'the team'])).toMatchObject({ ok: false, message: expect.stringMatching(/--team takes a team identifier/) })
  })
})

describe('the real effects of the check', () => {
  const told = { readFuseWire: async () => null, engineProblem: () => null, entitlementsOf: () => [], noticeProblems: () => [] }

  it('start an app without the variables that drive Electron or Lucium from outside', () => {
    expect(launchEnv({ HOME: '/Users/x', PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', LUCIUM_EXTENSIONS: '/x', NODE_OPTIONS: '--inspect', MAIN_VITE_UPDATE_FEED: 'https://x', VITE_X: '1', NODE_ENV: 'test' })).toEqual({ HOME: '/Users/x', PATH: '/usr/bin', NODE_ENV: 'test' })
  })

  it('run a program without a shell, and say that one could not be started', () => {
    const deps = realVerifyDeps(() => {}, work, told)
    expect(deps.run(process.execPath, ['-e', 'process.stdout.write(process.argv[1]); process.stderr.write("err"); process.exit(3)', 'a b; $HOME'])).toEqual({ status: 3, stdout: 'a b; $HOME', stderr: 'err' })
    const missing = deps.run(join(work, 'no-such-program'), [])
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toMatch(/ENOENT/)
  })

  it('wait for a program that leaves, with its code and what it said, and stop one that does not leave', async () => {
    const deps = realVerifyDeps(() => {}, work, told)
    const left = await deps.launch(process.execPath, ['-e', 'console.error("[launch] refused: --smoke"); process.exit(1)'], 20_000)
    expect(left).toMatchObject({ code: 1, timedOut: false, stderr: '[launch] refused: --smoke\n' })
    const stuck = await deps.launch(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 300)
    expect(stuck).toMatchObject({ code: null, timedOut: true })
    expect(stuck.elapsedMs).toBeGreaterThanOrEqual(250)
    const absent = await deps.launch(join(work, 'no-such-program'), [], 5_000)
    expect(absent).toMatchObject({ code: null, timedOut: false })
    expect(absent.stderr).toMatch(/ENOENT/)
  })

  it('make a data folder under the folder they are given, and remove it', () => {
    const deps = realVerifyDeps(() => {}, work, told)
    const folder = deps.makeTempDir()
    expect(folder.startsWith(join(work, 'lucium-verify-app-'))).toBe(true)
    expect(existsSync(folder)).toBe(true)
    deps.removeDir(folder)
    expect(existsSync(folder)).toBe(false)
    expect(Math.abs(deps.now().getTime() - Date.now())).toBeLessThan(5_000)
  })
})

// Each test starts the script, a Node of its own, up to three times: more than a second on a quiet machine, several times that when every core is taken.
describe('what is asked of the translation helper', () => {
  it('is what the application asks before it starts it: the identifier of system.ts, the protocol the application reads the same way', async () => {
    const { SYSTEM_TRANSLATE_HELPER_IDENTIFIER, helperProtocol } = await import('./translate/system')
    expect(TRANSLATE_HELPER).toEqual({ identifier: SYSTEM_TRANSLATE_HELPER_IDENTIFIER, protocol: 2 })
    // The same reading as the application's, on the same file: a bundle whose Info.plist the two read differently would pass here and run slowly there.
    const bundle = join(work, 'LuciumTranslate.app')
    mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(bundle, 'Contents', 'Info.plist'), TRANSLATE_PLIST)
    expect(helperProtocol(join(bundle, 'Contents', 'MacOS', 'lucium-translate'))).toBe(TRANSLATE_HELPER.protocol)
    expect(translateHelperFacts('<plist><dict><!-- <key>LuciumTranslateProtocol</key><integer>9</integer> --></dict></plist>')).toEqual({ identifier: null, protocol: null })
  })
})

describe('scripts/verify-app.mjs', { timeout: 30_000 }, () => {
  const script = here('scripts/verify-app.mjs')
  const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, LUCIUM_TEAM_ID: '' } })

  it('is what pnpm verify:app runs', () => {
    expect(packageJson.scripts['verify:app']).toBe('node scripts/verify-app.mjs')
  })

  it('refuses a folder that is not an application, with code 1, and says what it expected', () => {
    const folder = join(work, 'empty', 'Lucium.app')
    mkdirSync(folder, { recursive: true })
    const result = run(folder, '--team', 'ABCDE12345')
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`Expected: app.lucium.browser ${VERSION}, on the castLabs Electron ${PINNED}+wvcus, signed by the team ABCDE12345`)
    expect(result.stdout).toMatch(/FAIL {2}bundle: .* is not an application bundle: no Contents\/Info\.plist/)
    expect(result.stderr).toMatch(/1 check\(s\) failed, 0 passed: this is not a build to hand out/)
  })

  it('refuses wrong arguments with code 2, and shows its usage with --help', () => {
    expect(run().status).toBe(2)
    expect(run('a.app', '--team', 'nobody').status).toBe(2)
    const help = run('--help')
    expect(help.status).toBe(0)
    expect(help.stderr).toMatch(/--no-launch +reads only: the app is never started/)
  })

  it('expects the team of the official builds when none is named, and says so; --any-team expects none and the output says what it is worth', () => {
    const folder = join(work, 'no-team', 'Lucium.app')
    mkdirSync(folder, { recursive: true })
    const result = run(folder, '--no-launch')
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`signed by the team ${OFFICIAL_TEAM_ID} (the team of the official builds: --team names another)`)
    expect(run(folder, '--no-launch', '--team', 'ABCDE12345').stdout).toMatch(/signed by the team ABCDE12345\n/)
    const any = run(folder, '--no-launch', '--any-team')
    expect(any.status).toBe(1)
    expect(any.stdout).toContain('signed by any team (--any-team): not the check of a build to hand out')
  })

  it('fails an app that does not carry the public keys of the update feed of the repository, or any app while the repository holds none', () => {
    // A bundle with an Info.plist and an app.asar that holds no key: whatever the list of the repository is, this is not a build to hand out.
    const folder = join(work, 'no-feed-key', 'Lucium.app')
    mkdirSync(join(folder, 'Contents', 'Resources'), { recursive: true })
    writeFileSync(join(folder, 'Contents', 'Info.plist'), 'a property list')
    writeFileSync(join(folder, 'Contents', 'Resources', 'app.asar'), asarOf(ASAR))
    // The binary the fuses are read in, so that this bundle fails on what it is about.
    mkdirSync(join(folder, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A'), { recursive: true })
    writeFileSync(join(folder, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework'), 'no fuse wire')
    const result = run(folder, '--no-launch', '--any-team')
    expect(result.status).toBe(1)
    expect(result.stdout).toMatch(/FAIL {2}update feed keys: (src\/main\/update-feed-keys\.ts holds no public key: a copy of this build would refuse every update feed|app\.asar does not hold the public key \S+ of the update feed)/)
    expect(result.stdout).not.toMatch(/refuses --smoke/)
  })

  it('fails an app whose framework has no binary on its fuses, and goes on to the checks after them', () => {
    const folder = join(work, 'no-framework', 'Lucium.app')
    mkdirSync(join(folder, 'Contents', 'Resources'), { recursive: true })
    writeFileSync(join(folder, 'Contents', 'Info.plist'), 'a property list')
    writeFileSync(join(folder, 'Contents', 'Resources', 'app.asar'), asarOf(ASAR))
    const result = run(folder, '--no-launch', '--any-team')
    expect(result.status).toBe(1)
    expect(result.stdout).toMatch(/FAIL {2}fuses: the binary of the Electron framework could not be read for its fuses \(ENOENT/)
    expect(result.stdout).toMatch(/FAIL {2}update feed keys: /)
    expect(result.stderr).not.toMatch(/ENOENT/)
  })

  // The whole run on a package that passes: the programs that read a signature are stand-ins on the PATH, which answer what codesign, spctl and
  // stapler answered the same checks run here (recorded first, then replayed). plutil is the system's (/usr/bin/plutil, so on macOS only), on
  // property lists written for the purpose. Nothing is signed, and the app is not started (--no-launch).
  it.skipIf(process.platform !== 'darwin')('reads a whole package with --any-team, says that every check passed, and what that is worth (on macOS: plutil)', async () => {
    const fake = fakeApp({ asarContent: `const keys=${JSON.stringify(UPDATE_FEED_PUBLIC_KEYS)};` })
    const plist = (value: unknown): string => {
      if (value === true || value === false) return `<${value}/>`
      if (typeof value === 'string') return `<string>${value}</string>`
      if (Array.isArray(value)) return `<array>${value.map(plist).join('')}</array>`
      return `<dict>${Object.entries(value as Record<string, unknown>).map(([key, inner]) => `<key>${key}</key>${plist(inner)}`).join('')}</dict>`
    }
    const document = (value: unknown): string => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">${plist(value)}</plist>\n`
    writeFileSync(join(fake.app, 'Contents', 'Info.plist'), document(fake.info))
    writeFileSync(join(fake.app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist'), document({ CFBundleVersion: `${PINNED}+wvcus` }))
    writeFileSync(fuseFileOf(fake.app), Buffer.concat([Buffer.from('before'), Buffer.from(FUSE_SENTINEL), Buffer.from([WIRE.version, WIRE.bytes.length, ...WIRE.bytes]), Buffer.from('after')]))

    const answers: Record<string, CommandResult> = {}
    const recording: VerifyDeps = {
      ...fake.deps,
      run: (program, args) => {
        const answer = fake.deps.run(program, args)
        if (program !== '/usr/bin/plutil') answers[[program, ...args].join('\u0000')] = answer
        return answer
      }
    }
    const here = await verifyApp({ ...fake.input, team: null, launch: false, feedKeys: { keys: UPDATE_FEED_PUBLIC_KEYS, problems: publicKeyProblems(UPDATE_FEED_PUBLIC_KEYS) } }, recording)
    expect(here.checks.filter((check) => !check.ok)).toEqual([])

    const bin = join(work, `tools-${++made}`)
    mkdirSync(bin)
    const replay = join(bin, 'answers.json')
    writeFileSync(replay, JSON.stringify(answers))
    const tool = `#!${process.execPath}\nconst answers = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(replay)}, 'utf8'))\nconst answer = answers[[require('node:path').basename(process.argv[1]), ...process.argv.slice(2)].join('\\u0000')]\nif (!answer) { process.stderr.write('not recorded: ' + process.argv.slice(1).join(' ')); process.exit(99) }\nprocess.stdout.write(answer.stdout)\nprocess.stderr.write(answer.stderr)\nprocess.exit(answer.status ?? 1)\n`
    for (const name of ['codesign', 'spctl', 'xcrun']) {
      writeFileSync(join(bin, name), tool)
      chmodSync(join(bin, name), 0o755)
    }
    const result = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, fake.app, '--no-launch', '--any-team'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, LUCIUM_TEAM_ID: '', PATH: `${bin}:${process.env.PATH ?? ''}` } })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('signed by any team (--any-team): not the check of a build to hand out')
    expect(result.stdout).toContain('  ok    signer: Developer ID Application: Example (ABCDE12345), hardened runtime (--any-team: team ABCDE12345 read from the signature, not compared with an expected one; this is not the check of a build to hand out)\n')
    expect(result.stdout).not.toMatch(/FAIL/)
    expect(result.stdout).toContain(`\nThe ${STATIC_CHECKS.length} checks that read the bundle passed. The refused switches were not checked: the app was not started.\n`)
    expect(result.stdout).toMatch(/The signer was not compared with an expected team \(--any-team\): this says nothing of who built this copy\.\n$/)
  })

  it('refuses a team of the environment that is not one', () => {
    const result = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, join(work, 'empty', 'Lucium.app')], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, LUCIUM_TEAM_ID: 'the team' } })
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/LUCIUM_TEAM_ID is not a team identifier/)
  })
})
