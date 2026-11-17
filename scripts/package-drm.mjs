// Builds "Lucium DRM": Lucium on the castLabs build of Electron ("ECS"), which can load Widevine, the module protected videos need
// (only Netflix has been checked, docs/drm.md). A second application next to the normal one (dist-drm/mac-arm64/Lucium DRM.app); it shares its data (profiles, tabs, settings) because the
// name of the application inside does not change. macOS on Apple silicon only.
//
//   node scripts/package-drm.mjs                  builds the application, not signed
//   node scripts/package-drm.mjs --vmp            + signs it with the EVS service of castLabs (a free account, made once: `evs-account signup`; the password is typed here)
//   node scripts/package-drm.mjs --vmp --apple    + signs it with the Developer ID of LUCIUM_SIGN_IDENTITY (after the VMP signature, never before), with the
//                                                  hardened runtime, piece by piece and without --deep (src/main/mac-sign-order.ts), each piece with the entitlements
//                                                  it needs and no more (`entitlementsFor`: disable-library-validation and the unsigned executable memory for the
//                                                  main process and the plain and plugin helpers, which Widevine needs; not for the renderer and GPU helpers), then checks what is shipped: `codesign --verify --deep
//                                                  --strict`, the entitlements of every piece, the keychain helper's own signature, `evs-vmp verify-pkg`; any
//                                                  failure stops it
//   --as-lucium                                 builds it under the name and the identifier of the normal application (dist-drm/mac-arm64/Lucium.app), to be
//                                                  installed in its place; without it, "Lucium DRM" is a second application beside it
//   --castlabs-fuses                               the fuses of the installed variant (scripts/build-drm-release.sh passes it by default):
//                                                  castLabs' set, exactly (CASTLABS_SIGNED_SET of src/main/drm-fuse-trial.ts), the one EVS signs besides
//                                                  castLabs' defaults: runAsNode, enableNodeOptionsEnvironmentVariable and enableNodeCliInspectArguments off,
//                                                  onlyLoadAppFromAsar and enableEmbeddedAsarIntegrityValidation on, enableCookieEncryption on. The name,
//                                                  the identifier and the data folder stay the real ones (with --as-lucium: Lucium, app.lucium.browser,
//                                                  the user's profile). The fuse wire, app.asar and the hash of its header are checked before EVS, as for a
//                                                  trial. Cookie encryption is one way: from the first launch the profile's cookies are encrypted (docs/drm.md).
//                                                  Not with --no-fuses nor --fuse-trial.
//   --no-fuses                                     keeps the fuses of castLabs' build as they are, open (the earlier DRM build; what
//                                                  scripts/build-drm-release.sh --original-fuses passes, to go back). Never with --apple: the
//                                                  Developer ID does not sign castLabs' fuses left open; nor does it sign --as-lucium without
//                                                  --castlabs-fuses, which leaves them open as well.
//   --timestamp-required                           with --apple: stops when Apple's timestamp server does not answer, instead of signing without
//                                                  (scripts/build-drm-release.sh --notarize passes it: Apple notarizes nothing without a timestamp)
//   --fuse-trial <fuse>                            a trial copy: castLabs' fuses with this one closed (runAsNode, enableNodeOptionsEnvironmentVariable,
//                                                  enableNodeCliInspectArguments, onlyLoadAppFromAsar, enableEmbeddedAsarIntegrityValidation), in
//                                                  dist-drm-trial/<fuse>/mac-arm64/Lucium essai <fuse>.app, with an identifier and a data folder of its own
//                                                  (src/main/drm-fuse-trial.ts). The fuse wire is read back and compared with castLabs' build before EVS sees it.
//                                                  Never with --as-lucium: a trial copy never takes the place of the installed application.
//   --fuse-trial castlabs-set                      the same, with the one set castLabs says EVS signs: the five closed and cookie encryption on
//                                                  (castlabs/electron-releases#152), in dist-drm-trial/castlabs-set/. The two ASAR fuses being closed, the
//                                                  script also checks that the app is in Resources/app.asar and that Info.plist holds the hash of its header.
//
// The keychain helper of the password vault (Touch ID, src/main/vault-keychain.ts), an XPC service, is built first by native/vault-keychain/build.sh and
// put in Contents/XPCServices/. With --apple it is signed there by the Developer ID with its own entitlements and its provisioning profile
// (LUCIUM_KEYCHAIN_PROFILE, LUCIUM_TEAM_ID); without the profile it is signed without them and Lucium says Touch ID is unavailable. Without --apple
// it is signed ad hoc. The addon through which the main process reaches it is built next by native/vault-xpc/build.sh and put in Contents/Resources/,
// outside app.asar; it is one of the pieces the Developer ID signs (the same team as the main process, which then needs no exception to load it).
// The helper of the system's translation (macOS 26+, src/main/translate/system.ts) is built by native/system-translate/build.sh and put in Contents/Helpers/.
// With --apple it is signed by the Developer ID with the hardened runtime and no entitlement; without it, ad hoc. Neither helper is signed again with the
// entitlements of the application.
//
// Where things are: LUCIUM_ECS_DIST (the unzipped castLabs Electron, with Electron.app in it) and LUCIUM_EVS_BIN (the folder of `evs-vmp`); both default to
// ~/Library/Application Support/lucium-drm-tools/, outside the repository. The default engine folder is ecs-<the Electron package.json pins>.
//
// The engine is checked before anything is built (src/main/drm-engine-guard.ts; docs/drm.md, « Le garde-fou du moteur »): a prerelease (alpha, beta,
// nightly) or a build without "+wvcus" is always refused, and so is a version that is not the Electron pinned in package.json, unless
// build/drm-engine-exception.json, the only place for it, names another stable one and says why. No option of this script lifts the check.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Node reads the TypeScript of the signing order by itself; its notice that the package has no "type" is not news.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON' && warning.name !== 'ExperimentalWarning') console.error(`${warning.name}: ${warning.message}`)
})
const { entitlementsFor, grantedEntitlements, signingOrder } = await import('../src/main/mac-sign-order.ts')
const { ENGINE_EXCEPTION_FILE, drmEngineProblem, expectedEngine, readEngineException } = await import('../src/main/drm-engine-guard.ts')
const { CASTLABS_FUSES, CASTLABS_SET, TRIAL_FUSES, castlabsReleaseFuses, fuseOptionsProblem, fuseTrial, trialWireProblem, wireName } = await import('../src/main/drm-fuse-trial.ts')
// The licence texts a build must carry, the engine's and the project's (CommonJS, shared with scripts/after-pack.cjs).
const { engineNoticeProblems, shippedNoticeProblems } = createRequire(import.meta.url)('./notices/shipped-notices.cjs')
// The identity is checked as the disk image checks it: its whole name, among the Developer ID Application identities of the keychain.
const { chooseIdentity } = await import('../src/main/make-dmg.ts')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tools = join(homedir(), 'Library/Application Support/lucium-drm-tools')
/** The Electron the project is written and tested for, and the exception that lets the DRM variant be built on another stable one (none, most of the time). */
const pinnedElectron = String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies?.electron ?? '')
const engineExceptionPath = join(root, ENGINE_EXCEPTION_FILE)
const engineException = readEngineException(existsSync(engineExceptionPath) ? readFileSync(engineExceptionPath, 'utf8') : null, pinnedElectron)
const ecsDist = process.env.LUCIUM_ECS_DIST ?? join(tools, `ecs-${expectedEngine(pinnedElectron, engineException.exception)}`)
const evsBin = process.env.LUCIUM_EVS_BIN ?? join(tools, 'evs-venv/bin')
const identity = process.env.LUCIUM_SIGN_IDENTITY
const wantVmp = process.argv.includes('--vmp')
const wantApple = process.argv.includes('--apple')
const asLucium = process.argv.includes('--as-lucium')
const trialAt = process.argv.indexOf('--fuse-trial')
const trial = trialAt === -1 ? null : fuseTrial(root, process.argv[trialAt + 1] ?? '')
const castlabsFuses = process.argv.includes('--castlabs-fuses')
/** The build will be sent to Apple (scripts/build-drm-release.sh --notarize): Apple refuses a piece signed without a timestamp, after the whole build. */
const timestampRequired = process.argv.includes('--timestamp-required')
/** The fuses written over castLabs' build and read back before EVS: the trial's, or castLabs' set for the real application (--castlabs-fuses). */
const fuseSet = trial ?? (castlabsFuses ? castlabsReleaseFuses() : null)
/** How the messages of the checks of fuseSet name the build. */
const fuseCheck = trial ? 'fuse trial' : 'castlabs fuses'
// The name shown and the name of the .app. It never reaches app.name (the productName of package.json, `Lucium`), which names the profile: see electron-builder.yml.
const productName = trial?.productName ?? (asLucium ? 'Lucium' : 'Lucium DRM')
const output = trial?.output ?? join(root, 'dist-drm')
const app = join(output, 'mac-arm64', `${productName}.app`)
/** The keychain helper as build.sh makes it, and where the application carries it (src/main/vault-keychain.ts, `keychainPaths`). */
const helperOut = join(root, 'out-native')
const helperBuilt = join(helperOut, 'LuciumKeychain.xpc')
const helperShipped = join(app, 'Contents', 'XPCServices', 'LuciumKeychain.xpc')
/** The addon that reaches it, and where the application carries it (`keychainPaths` too). */
const addonBuilt = join(helperOut, 'vault-xpc.node')
const addonShipped = join(app, 'Contents', 'Resources', 'vault-xpc.node')
/** The helper of the system's translation as its build.sh makes it, and where the application carries it (src/main/translate/system.ts, `systemTranslateHelperPath`). */
const translateBuilt = join(helperOut, 'LuciumTranslate.app')
const translateShipped = join(app, 'Contents', 'Helpers', 'LuciumTranslate.app')

/** @type {(message: string) => never} */
const fail = (message) => {
  console.error(`package-drm: ${message}`)
  process.exit(1)
}
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options })
  if (result.status !== 0) fail(`${command} ${args[0] ?? ''} failed (exit ${result.status})`)
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('this builds the Apple silicon application, on a Mac')
// A wrong exception file is said first: the folder looked for below depends on it.
if (engineException.problem) fail(engineException.problem)
if (!existsSync(join(ecsDist, 'Electron.app'))) fail(`no Electron.app in ${ecsDist}: set LUCIUM_ECS_DIST to the unzipped castLabs build (docs/drm.md)`)
if (!existsSync(join(ecsDist, 'version'))) fail(`no version file in ${ecsDist}: the engine cannot be checked, so nothing is built on it`)
// The castLabs archive carries the licence of Electron and the notices of Chromium beside Electron.app. electron-builder copies Electron.app alone from
// an unzipped engine, so scripts/after-pack.cjs takes the two files from this folder: an engine folder that lost them is refused before the build.
const engineNotices = engineNoticeProblems(ecsDist)
if (engineNotices.length > 0) fail(`${ecsDist} lacks the notices of the engine (${engineNotices.join('; ')}): unzip the whole castLabs archive, not Electron.app alone (docs/drm.md)`)
const electronVersion = readFileSync(join(ecsDist, 'version'), 'utf8').trim().replace(/^v/, '')
// The guard of the engine: what is shipped is the stable castLabs build of the pinned Electron, or the build stops here.
const engineProblem = drmEngineProblem({ engine: electronVersion, pinned: pinnedElectron, exception: engineException.exception })
if (engineProblem) fail(`${engineProblem} (engine read from ${ecsDist})`)
if (engineException.exception) {
  console.warn(`package-drm: engine exception (${ENGINE_EXCEPTION_FILE}): built on ${electronVersion} while package.json pins Electron ${pinnedElectron}: ${engineException.exception.reason}`)
}

// Everything that can be wrong is said before the two minutes of the build, not after.
const fuseOptions = fuseOptionsProblem(process.argv.slice(2))
if (fuseOptions) fail(fuseOptions)
if (trialAt !== -1 && !trial) fail(`--fuse-trial takes one fuse (${TRIAL_FUSES.join(', ')}) or ${CASTLABS_SET} (the five closed, cookie encryption on)`)
if (trial && asLucium) fail('--fuse-trial builds a copy beside the installed application, never in its place: not with --as-lucium')
if (wantApple && !wantVmp) fail('--apple goes after --vmp: the signature of Apple is put over the one of the service, never under it')
if (wantApple && !identity) fail('LUCIUM_SIGN_IDENTITY is not set (a "Developer ID Application: …" identity)')
// Only the name of the identity goes through here (it is written in every app it signs); its private key stays in the keychain.
// Its whole name, never a part of one: codesign takes a part of a name too, and would then sign with an identity nobody chose by name.
if (wantApple) {
  const chosen = chooseIdentity(spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }).stdout ?? '', identity ?? null)
  if (!chosen.ok) fail(chosen.message)
}
if (wantVmp && !existsSync(join(evsBin, 'evs-vmp'))) fail(`no evs-vmp in ${evsBin}: install castlabs-evs (docs/drm.md)`)

console.log(`package-drm: ${productName} on the castLabs Electron ${electronVersion} (package.json pins ${pinnedElectron})`)
// The keychain helper first (a few seconds, and swiftc missing is said before the build). It is signed by the Developer ID only when the app will be:
// without --apple the identity is not handed down, and the helper is signed ad hoc like the app.
/** @type {NodeJS.ProcessEnv} */
const helperEnv = { ...process.env, LUCIUM_NATIVE_OUT: helperOut }
if (!wantApple) delete helperEnv.LUCIUM_SIGN_IDENTITY
run('bash', ['native/vault-keychain/build.sh', '--arch', 'arm64'], { env: helperEnv })
run('bash', ['native/vault-xpc/build.sh', '--arch', 'arm64'], { env: helperEnv })
run('bash', ['native/system-translate/build.sh', '--arch', 'arm64'], { env: helperEnv })
run('node_modules/.bin/electron-vite', ['build'])
// Not signed here: the VMP signature of the service has to come before the one of Apple.
// castLabs' FAQ: the free EVS signs the unmodified binaries and those where only fuses of its "supported set" changed, and answers "Binary signature denied"
// to any other. In practice it signs the default fuse wire and one static set of all of them (castlabs/electron-releases#152, July 2025), not a part of it:
// each of the five fuses the app closes, closed alone (--fuse-trial), was refused on 45.0.0-alpha.14 (docs/drm.md, « Essais des
// fusibles »), and `--fuse-trial castlabs-set`, that one set, was signed; Netflix played in it. So the installed variant has that set (--castlabs-fuses).
run('node_modules/.bin/electron-builder', [
  '--mac',
  '--dir',
  `-c.electronDist=${ecsDist}`,
  `-c.electronVersion=${electronVersion}`,
  `-c.productName=${productName}`,
  // The identifier of the normal application when it is replaced; its own otherwise (two applications of one identifier confuse the system).
  // A trial copy also renames the package inside, its productName included: Electron names the data folder after the productName (else the name), so
  // the copy never opens the user's profile.
  ...(trial ? [`-c.appId=${trial.appId}`, `-c.extraMetadata.name=${trial.dataName}`, `-c.extraMetadata.productName=${trial.dataName}`] : asLucium ? [] : ['-c.appId=app.lucium.browser.drm']),
  `-c.directories.output=${output}`,
  '-c.mac.identity=null',
  // Every fuse is written here, never left to electron-builder.yml: --no-fuses at castLabs' (Electron's) defaults (a fuse set to its default leaves
  // the binary unchanged, which the service accepts); --castlabs-fuses castLabs' set; a trial closes one, or sets castLabs' set.
  ...(fuseSet || process.argv.includes('--no-fuses') ? [
    ...Object.entries(fuseSet?.fuses ?? CASTLABS_FUSES).map(([fuse, value]) => `-c.electronFuses.${fuse}=${value}`),
    // A closed fuse changes the framework, whose ad hoc signature Apple silicon then refuses (exit 137). With --apple the Developer ID signs it all
    // again after EVS; without it, the build is signed ad hoc again here, before EVS (EVS hashes the code, not its signature: castlabs_evs hash_macho_wv0).
    `-c.electronFuses.resetAdHocDarwinSignature=${Boolean(fuseSet) && !wantApple}`
  ] : [])
])

// electron-builder writes the arm64 build to `mac` (its name when the architecture is not given); this script signs and checks `mac-arm64`.
// Without this move, every signature would be put over the build of the previous run, and the new code would never be shipped.
const packaged = join(output, 'mac')
const shipped = join(output, 'mac-arm64')
if (existsSync(packaged)) {
  rmSync(shipped, { recursive: true, force: true })
  renameSync(packaged, shipped)
}

// Before any signature: the licence of Lucium, its notice, the additional permission, the notices of the npm packages, the licence of Electron and the notices of Chromium are in
// the application that will be handed out (scripts/after-pack.cjs put the last two there and already refused a build without them; read again here
// on the folder that is signed, after the move above).
const shippedNotices = shippedNoticeProblems({ engine: join(app, 'Contents', 'Resources'), project: join(app, 'Contents', 'Resources') })
if (shippedNotices.length > 0) fail(`the application lacks licence texts it must carry: ${shippedNotices.join('; ')}`)
console.log('package-drm: licence texts in Contents/Resources: LICENSE, NOTICE, ADDITIONAL-PERMISSION.txt, THIRD-PARTY-NOTICES.txt, LICENSE.electron.txt, LICENSES.chromium.html')

if (fuseSet) {
  // Before EVS sees it: the wire of the binary is castLabs' but the fuses of the set, each to its value. Read back with the @electron/fuses
  // electron-builder wrote it with (not a dependency of the project: reached through electron-builder), and compared position by position, those it has
  // no name for included.
  const builder = createRequire(realpathSync(join(root, 'node_modules', 'electron-builder', 'package.json')))
  const builderLib = createRequire(builder.resolve('app-builder-lib/package.json'))
  const { FuseV1Options, getCurrentFuseWire } = builderLib('@electron/fuses')
  const wanted = Object.entries(fuseSet.changed).map(([fuse, enabled]) => ({ fuse, position: FuseV1Options[wireName(fuse)], enabled }))
  const problem = trialWireProblem(await getCurrentFuseWire(join(ecsDist, 'Electron.app')), await getCurrentFuseWire(app), wanted, fuseSet.name)
  if (problem) fail(`${fuseCheck}: ${problem}`)
  // The build is never launched here, so what the two ASAR fuses need is checked on what is shipped; without it the app would not start, whatever EVS
  // says. Closed, onlyLoadAppFromAsar makes Electron load the application from Resources/app.asar only (`asar: true` of electron-builder.yml makes it).
  // Closed, enableEmbeddedAsarIntegrityValidation makes it hash the header of app.asar and compare it with ElectronAsarIntegrity of Info.plist, which
  // electron-builder writes whatever the fuses (app-builder-lib, asar/integrity.js): the hash is recomputed here with its @electron/asar.
  const asar = join(app, 'Contents', 'Resources', 'app.asar')
  if ((fuseSet.changed.onlyLoadAppFromAsar || fuseSet.changed.enableEmbeddedAsarIntegrityValidation) && !existsSync(asar)) {
    fail(`${fuseCheck}: no Contents/Resources/app.asar, the app would refuse to start`)
  }
  if (fuseSet.changed.enableEmbeddedAsarIntegrityValidation) {
    const written = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :ElectronAsarIntegrity:Resources/app.asar:hash', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' })
    const header = createHash('sha256').update(builderLib('@electron/asar').getRawHeader(asar).headerString).digest('hex')
    if (written.status !== 0) fail(`${fuseCheck}: no ElectronAsarIntegrity for Resources/app.asar in Info.plist, the app would refuse to start`)
    if (written.stdout.trim() !== header) fail(`${fuseCheck}: the hash of ElectronAsarIntegrity is not the one of the header of app.asar, the app would refuse to start`)
    console.log(`package-drm: ${fuseCheck}: Resources/app.asar, its header hash written in Info.plist (ElectronAsarIntegrity)`)
  }
  const set = wanted.map(({ fuse, enabled }) => `${fuse}=${enabled}`).join(', ')
  console.log(`package-drm: ${trial ? `fuse trial ${trial.name}` : fuseCheck}: ${set}, every other fuse as in castLabs' build`)
  if (!trial) console.log('package-drm: cookie encryption on: from the first launch, the cookies of the profile are encrypted as they are written, one way (docs/drm.md)')
}

// The keychain helper in Contents/XPCServices/, before any signature (EVS reads the Electron framework only: castlabs_evs `_detect_pkgs`). electron-builder.yml
// copies it as well (mac.extraFiles); it is put again here with ditto, which keeps the signature build.sh made, and checked where it is.
rmSync(helperShipped, { recursive: true, force: true })
mkdirSync(dirname(helperShipped), { recursive: true })
run('ditto', [helperBuilt, helperShipped])
run('codesign', ['--verify', '--strict', helperShipped])
// Its addon in Contents/Resources/ (electron-builder.yml copies it too, mac.extraResources): the one of this build, whatever an earlier run left.
rmSync(addonShipped, { force: true })
run('ditto', [addonBuilt, addonShipped])
// The same for the helper of the system's translation (no entitlement: nothing of its signature is to keep but its own).
rmSync(translateShipped, { recursive: true, force: true })
run('ditto', [translateBuilt, translateShipped])
run('codesign', ['--verify', '--strict', translateShipped])

const evs = join(evsBin, 'evs-vmp')
// The service asks for the password of the account itself when it has no session (nothing of it goes through here); without a terminal it does not ask.
const noAsk = process.stdin.isTTY ? [] : ['-n']
// The signatures of a trial are cached apart: EVS keeps its last 16 in ~/.config/evs/cache.json, and the trials must not push out the one of the
// installed build. The session of the account (~/.config/evs/config.json) is the same.
const evsEnv = trial ? { ...process.env, EVS_CACHE_FILE: join(output, 'evs-cache.json') } : process.env
if (wantVmp) {
  run(evs, [...noAsk, 'sign-pkg', join(output, 'mac-arm64')], { env: evsEnv })
  execFileSync(evs, [...noAsk, 'verify-pkg', join(output, 'mac-arm64')], { stdio: 'inherit', env: evsEnv })
}

// The sentence macOS shows when a page reaches a device of the local network (electron-builder.yml writes it): without it the system refuses those
// pages without a question. Checked on what is shipped, and a build without it stops here like any other failed check.
if (wantVmp) {
  const infoPlist = join(app, 'Contents', 'Info.plist')
  const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :NSLocalNetworkUsageDescription', infoPlist], { encoding: 'utf8' })
  if (result.status !== 0 || result.stdout.trim() === '') fail('Info.plist lacks NSLocalNetworkUsageDescription: the pages of the devices of the local network would be refused (electron-builder.yml, mac.extendInfo)')
  console.log('package-drm: NSLocalNetworkUsageDescription is in Info.plist')
}

/** The hash of the code directory of a signed piece (`codesign -dvvv` writes it to the standard error): the same hash is the same signature. */
const cdhashOf = (target) => /^CDHash=([0-9a-f]+)$/m.exec(spawnSync('codesign', ['-dvvv', target], { encoding: 'utf8' }).stderr ?? '')?.[1] ?? null

if (wantApple) {
  const helperBefore = cdhashOf(helperShipped)
  if (!helperBefore) fail(`${relative(root, helperShipped)} has no signature to keep`)
  const translateBefore = cdhashOf(translateShipped)
  if (!translateBefore) fail(`${relative(root, translateShipped)} has no signature to keep`)
  // Piece by piece, the deepest first, the application last, and never --deep: --deep would sign the keychain helper again with the entitlements of the
  // app, over its own (its access group, authorized by its profile), and Touch ID would be refused (src/main/mac-sign-order.ts).
  // The timestamp server of Apple is sometimes too slow: once it fails, the pieces left are signed without it (enough for the Mac it is built on).
  let timestamp = '--timestamp'
  // Each piece gets the entitlements it needs (entitlementsFor): library validation and the unsigned executable memory stay on in the renderer and GPU helpers.
  const sign = (target) => {
    const plist = entitlementsFor(app, target)
    return spawnSync('codesign', ['--force', '--options', 'runtime', timestamp, ...(plist ? ['--entitlements', plist] : []), '--sign', identity, target], { cwd: root, stdio: 'inherit' }).status === 0
  }
  const pieces = signingOrder(app, [helperShipped, translateShipped])
  for (const target of pieces) {
    if (sign(target)) continue
    // A build that goes to Apple stops here, on the first piece, not after the build, EVS and the upload: Apple notarizes nothing without a timestamp.
    if (timestamp === '--timestamp' && timestampRequired) fail(`no timestamp from Apple on ${relative(output, target)}: a build that is notarized needs one on every piece. Run it again when the timestamp server of Apple answers`)
    if (timestamp === '--timestamp') {
      console.warn('package-drm: no timestamp from Apple, signing without')
      timestamp = '--timestamp=none'
      if (sign(target)) continue
    }
    fail(`codesign failed on ${relative(output, target)}`)
  }
  console.log(`package-drm: ${pieces.length} pieces signed by the Developer ID, without --deep (the two helpers are left as their build.sh signed them)`)
  // The checks are made on what is shipped, after the last signature (the one of Apple): any failure stops here, before anything is installed
  // (scripts/build-drm-release.sh) or sent to Apple (scripts/electron-upgrade.mjs).
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  // The keychain helper was not signed again: the same signature as build.sh made, with its own rights (or none, without a profile).
  if (cdhashOf(helperShipped) !== helperBefore) fail('the keychain helper was signed again over its own signature: Touch ID would be refused')
  if (cdhashOf(translateShipped) !== translateBefore) fail('the translation helper was signed again over its own signature, with the entitlements of the app')
  const helperRights = spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', helperShipped], { encoding: 'utf8' }).stdout ?? ''
  if (helperRights.includes('<key>keychain-access-groups</key>') && !existsSync(join(helperShipped, 'Contents', 'embedded.provisionprofile'))) {
    fail('the keychain helper has the keychain entitlements but no embedded.provisionprofile: macOS would refuse to start it')
  }
  console.log(
    helperRights.includes('<key>keychain-access-groups</key>')
      ? 'package-drm: keychain helper: its own entitlements and provisioning profile (Touch ID can be offered)'
      : 'package-drm: keychain helper signed without the keychain entitlements (no LUCIUM_KEYCHAIN_PROFILE): Lucium will say Touch ID is unavailable'
  )
  // The addon is loaded by the main process under the hardened runtime: signed by the same team as the app, it needs no exception for it.
  const teamOf = (target) => /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(spawnSync('codesign', ['-dv', target], { encoding: 'utf8' }).stderr ?? '')?.[1] ?? null
  const appTeam = teamOf(app)
  if (!appTeam || teamOf(addonShipped) !== appTeam || teamOf(helperShipped) !== appTeam) fail('the keychain addon or helper is not signed by the team of the app: Touch ID would be refused')
  console.log('package-drm: keychain addon and helper signed by the team of the app')
  // What each piece was signed with, read back from the signature of what is shipped: exactly the keys of the plist entitlementsFor names for it, none for
  // a library, a framework, the crash handler or the updater. Widevine (another vendor's signature) needs library validation off in the main process, the
  // plain helper and the plugin helper; the renderer and GPU helpers keep it.
  const keysOf = (keys) => [...keys].sort().join(', ')
  const plugins = []
  for (const target of pieces) {
    const plist = entitlementsFor(app, target)
    const wanted = plist ? grantedEntitlements(readFileSync(join(root, plist), 'utf8')) : []
    // `--entitlements - --xml` is the current spelling of `--entitlements :-` (deprecated by codesign).
    const shown = spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', target], { encoding: 'utf8' })
    const signed = grantedEntitlements(shown.stdout ?? '')
    if (shown.status !== 0 || keysOf(signed) !== keysOf(wanted)) {
      fail(`${relative(output, target)}: signed with [${keysOf(signed)}], expected [${keysOf(wanted)}] (${plist ?? 'no entitlement'})${shown.status === 0 ? '' : `, codesign -d exit ${shown.status}`}`)
    }
    if (/ Helper \(Plugin\)\.app$/.test(target)) plugins.push(target)
  }
  if (plugins.length !== 1) fail(`${plugins.length} plugin helper(s) found, expected one: the Widevine module would not load`)
  console.log(`package-drm: entitlements of the ${pieces.length} pieces checked, each the exact set of its plist; the renderer and GPU helpers keep library validation`)
  // The VMP signature has to survive the one of Apple: checked again on the final package.
  run(evs, [...noAsk, 'verify-pkg', join(output, 'mac-arm64')], { env: evsEnv })
}
console.log(`package-drm: ${app}${wantVmp ? '' : ' (not signed: the protected videos will not play before the VMP signature)'}`)
if (trial) console.log(`package-drm: trial copy, its own data folder: ${join(homedir(), 'Library/Application Support', trial.dataName)} (not installed anywhere)`)
