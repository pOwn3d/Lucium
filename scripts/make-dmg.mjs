// Makes the disk image people download: Lucium.app and a link to Applications, signed with the Developer ID of the build, notarized by Apple, the
// ticket stapled, and its SHA-256 sum. It is made of the app that is already built, notarized and archived for the update feed (dist-drm/mac-arm64/
// Lucium.app): never of a rebuilt one. It publishes nothing; scripts/publish-update.mjs sends the image beside the archive.
//
//   node scripts/make-dmg.mjs                 dist-drm/Lucium-<version of package.json>-arm64.dmg and dist-drm/Lucium-<version>-arm64.dmg.sha256
//   node scripts/make-dmg.mjs --dry-run       every command printed, none run that copies, signs, sends or writes (the checks that only read are made)
//
// What it does, and stops at the first thing that is wrong (it says what, and that dist-drm/ holds nothing of the run):
//   1. checks the app: the version of its Info.plist is package.json's and the notarization ticket is stapled;
//   2. finds the identity: LUCIUM_SIGN_IDENTITY when it is set (a "Developer ID Application: …" name of the keychain), else the first
//      Developer ID Application identity of the keychain, as scripts/build-drm-release.sh does;
//   3. copies the app (ditto) and a link to /Applications into a staging folder of the temporary folder, and checks the copy: the same signature
//      (CDHash), codesign --verify --deep --strict, the ticket;
//   4. hdiutil create -volname "Lucium <version>" -fs HFS+ -format UDZO;
//   5. codesign --sign <identity> --timestamp on the image;
//   6. xcrun notarytool submit … --keychain-profile <LUCIUM_NOTARY_PROFILE, default lucium> --wait: Apple must answer Accepted;
//   7. xcrun stapler staple, then validate; spctl -a -t open --context context:primary-signature -v must say "source=Notarized Developer ID";
//   8. only then moves the image to dist-drm/ and writes its sum there (`<hash>  <name>`, what shasum -a 256 -c reads), and its record
//      (Lucium-<version>-arm64.dmg.json: the sum of the image and of the executable of the app it holds, which scripts/publish-update.mjs
//      compares with the archive; it stays on the Mac); the staging folder is removed.
//
// Options:
//   --dry-run     prints every command and runs none that copies, signs, sends or writes
//   --app <app>   the built app the image is made of (default: dist-drm/mac-arm64/Lucium.app)
//
// Environment: LUCIUM_SIGN_IDENTITY (optional), LUCIUM_NOTARY_PROFILE (optional, default lucium). Both are names: the credentials stay in the
// keychain and are never read or printed here.
// Exit code: 0 done (or dry run done), 1 a step failed, 2 the arguments are wrong.
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.error(`${warning.name}: ${warning.message}`)
})
const { describeDmgFailure, makeDmg, parseDmgArgs, realDmgDeps, resolveDmgInput } = await import('../src/main/make-dmg.ts')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const usage = () => console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))

const parsed = parseDmgArgs(process.argv.slice(2))
if (!parsed.ok) {
  console.error(`Error: ${parsed.message}`)
  usage()
  process.exit(2)
}
if (parsed.options.help) {
  usage()
  process.exit(0)
}
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
const input = resolveDmgInput(parsed.options, {
  cwd: process.cwd(),
  root,
  tmpRoot: tmpdir(),
  version,
  signIdentity: process.env.LUCIUM_SIGN_IDENTITY,
  notaryProfile: process.env.LUCIUM_NOTARY_PROFILE
})

const result = await makeDmg(input, realDmgDeps((line) => console.log(line)))
if (!result.ok) {
  console.error(`\n${describeDmgFailure(result, input.outDir)}`)
  process.exit(1)
}
if (result.made) console.log(`\n${result.dmg}\n  ${result.made.size} bytes\n  SHA-256 ${result.made.sha256}\n  ${result.made.stapler}\n  ${result.made.gatekeeper.replace(/\n/g, '\n  ')}\n${result.sum}`)
