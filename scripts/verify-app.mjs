// Checks the application that is handed out, as it is on disk, without opening a window: `pnpm verify:app <path of Lucium.app>`.
//
//   pnpm verify:app dist-drm/mac-arm64/Lucium.app                        the app the build made, before it is published
//   pnpm verify:app /Volumes/Lucium\ 1.0.0/Lucium.app --no-launch        the app of the disk image downloaded from the site
//   pnpm verify:app <Lucium.app> --team <id>                             the build of another team (a modified version)
//   pnpm verify:app /Applications/Lucium.app --no-launch --any-team      an installed copy, read only, whoever signed it
//
// What it checks, every line whatever the one before found (src/main/verify-app.ts):
//   - the signature of the whole bundle (codesign --verify --deep --strict), who signed it (a Developer ID, the hardened runtime), and its
//     designated requirement (the identifier, the team): what an update is checked against;
//   - Info.plist: the identifier of electron-builder.yml (app.lucium.browser), the version of package.json, the address schemes, downgrades refused;
//   - the engine built in: the stable castLabs build ("+wvcus") of the Electron pinned in package.json, never a prerelease
//     (src/main/drm-engine-guard.ts), and the fuses of castLabs' set, read in the binary;
//   - app.asar: the hash of its header is the one Info.plist seals, every unpacked file is there, and no file of the tests is in the package;
//     the scripts left outside it (the preloads of the pages) are the ones its header keeps the SHA-256 of, none is there that it does not list,
//     and no preload weighs more than 64 kB; the public keys of the update feed (src/main/update-feed-keys.ts) are in it. While that file
//     holds no key, or a list a build may not carry, this check fails and says what to run: no app is a build to hand out then;
//   - the licence texts in Contents/Resources;
//   - the entitlements of the app and of each helper, the exact set of its plist (src/main/mac-sign-order.ts); the helper of the system's
//     translation, with none, signed under the identifier the application asks for and naming the protocol of native/system-translate/Info.plist; the keychain service (Touch ID), with its own, and the provisioning profile embedded in it, which must authorize them;
//   - the notarization: Gatekeeper's answer (spctl) and the stapled ticket (stapler validate);
//   - the switches a built app refuses: the app is started twice, with --smoke and with --remote-debugging-port, on a throw-away data folder,
//     and must leave with code 1 and say why, before it makes anything. This is the only check that starts the app, and it is made only when
//     every check above passed: an app that is not the expected build is not run.
//
// Options:
//   --no-launch       reads only: the app is never started (the refused switches are then NOT checked, and the output says so)
//   --team <id>       the team identifier the app must be signed by (default: the environment variable LUCIUM_TEAM_ID, else the team of the
//                     official builds, the one the README publishes). The team is never read from the signature being checked: an app signed
//                     by anyone's Developer ID would pass.
//   --any-team        instead of a team: the team is read from the signature and only its consistency is checked (every piece, the requirement
//                     and the profile name the same one). A look at a copy, NOT the check of a build to hand out; the output says so.
//   --version <x.y.z> the version the app must carry (default: the one of package.json)
//
// It reads the bundle, runs codesign, spctl, stapler and plutil on it, and writes nothing in it. It reads no keychain and no secret.
// Exit code: 0 every check passed, 1 a check failed (each is a line "FAIL"), 2 the arguments are wrong.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.error(`${warning.name}: ${warning.message}`)
})
const { builderFacts, parseVerifyArgs, realVerifyDeps, teamChoice, translateHelperFacts, verifyApp } = await import('../src/main/verify-app.ts')
// What other modules know of a release: the names of the fuses and their reader, the set that is closed, the engine guard, the entitlements of
// each piece, the licence texts. Node resolves no import between two TypeScript files, so this script hands them over.
const { FUSE_NAMES, fuseFileOf, readFuseWire } = await import('../src/main/publish-update.ts')
const { castlabsReleaseFuses, wireName } = await import('../src/main/drm-fuse-trial.ts')
const { ENGINE_EXCEPTION_FILE, drmEngineProblem, readEngineException } = await import('../src/main/drm-engine-guard.ts')
const { entitlementsFor, grantedEntitlements } = await import('../src/main/mac-sign-order.ts')
const { shippedNoticeProblems } = createRequire(import.meta.url)('./notices/shipped-notices.cjs')
const { publicKeyProblems } = await import('../src/main/update-feed-signature.ts')
const { UPDATE_FEED_PUBLIC_KEYS } = await import('../src/main/update-feed-keys.ts')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const usage = () => console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))
/** @type {(message: string) => never} */
const stop = (message) => {
  console.error(`Error: ${message}`)
  process.exit(2)
}

const parsed = parseVerifyArgs(process.argv.slice(2))
if (!parsed.ok) {
  console.error(`Error: ${parsed.message}`)
  usage()
  process.exit(2)
}
if (parsed.options.help) {
  usage()
  process.exit(0)
}
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const pinned = String(packageJson.devDependencies?.electron ?? '')
const exceptionFile = join(root, ENGINE_EXCEPTION_FILE)
const engineException = readEngineException(existsSync(exceptionFile) ? readFileSync(exceptionFile, 'utf8') : null, pinned)
if (engineException.problem) stop(engineException.problem)
const builder = builderFacts(readFileSync(join(root, 'electron-builder.yml'), 'utf8'))
if (!builder) stop('electron-builder.yml names no appId or no address scheme: what the app must carry cannot be read')
const chosen = teamChoice(parsed.options, process.env.LUCIUM_TEAM_ID)
if (!chosen.ok) stop(chosen.message)
const team = chosen.team

const helperFacts = translateHelperFacts(readFileSync(join(root, 'native', 'system-translate', 'Info.plist'), 'utf8'))
if (helperFacts.identifier === null || helperFacts.protocol === null) stop('native/system-translate/Info.plist names no CFBundleIdentifier or no LuciumTranslateProtocol: what the translation helper must carry cannot be read')
const translateHelper = { identifier: /** @type {string} */ (helperFacts.identifier), protocol: /** @type {number} */ (helperFacts.protocol) }

const app = resolve(process.cwd(), /** @type {string} */ (parsed.options.app))
const version = parsed.options.version ?? packageJson.version
const deps = realVerifyDeps((line) => console.log(line), tmpdir(), {
  readFuseWire: (bundle) => readFuseWire(fuseFileOf(bundle)),
  engineProblem: (engine) => drmEngineProblem({ engine, pinned, exception: engineException.exception }),
  entitlementsOf: (piece) => {
    const plist = entitlementsFor(app, piece)
    return plist ? grantedEntitlements(readFileSync(join(root, plist), 'utf8')) : []
  },
  noticeProblems: (resources) => shippedNoticeProblems({ engine: resources, project: resources })
})

console.log(`Lucium.app: ${app}`)
console.log(`Expected: ${builder.identifier} ${version}, on the castLabs Electron ${engineException.exception?.engine ?? pinned}+wvcus${team ? `, signed by the team ${team}${chosen.official ? ' (the team of the official builds: --team names another)' : ''}` : ', signed by any team (--any-team): not the check of a build to hand out'}`)
const result = await verifyApp(
  {
    app,
    version,
    identifier: builder.identifier,
    urlSchemes: builder.urlSchemes,
    team,
    keychainEntitlements: readFileSync(join(root, 'native', 'vault-keychain', 'entitlements.plist.in'), 'utf8'),
    translateHelper,
    fuseNames: FUSE_NAMES,
    feedKeys: { keys: UPDATE_FEED_PUBLIC_KEYS, problems: publicKeyProblems(UPDATE_FEED_PUBLIC_KEYS) },
    fuses: Object.fromEntries(Object.entries(castlabsReleaseFuses().changed).map(([fuse, enabled]) => [wireName(fuse), enabled])),
    launch: !parsed.options.noLaunch,
    launchTimeoutMs: 20_000
  },
  deps
)
const passed = result.checks.length - result.problems
if (result.problems > 0) {
  console.error(`\n${result.problems} check(s) failed, ${passed} passed: this is not a build to hand out.`)
  process.exit(1)
}
console.log(result.launched ? `\nAll ${passed} checks passed.` : `\nThe ${passed} checks that read the bundle passed. The refused switches were not checked: the app was not started.`)
if (team === null) console.log('The signer was not compared with an expected team (--any-team): this says nothing of who built this copy.')
