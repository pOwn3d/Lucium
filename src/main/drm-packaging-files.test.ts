import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ENTITLEMENTS_APP, ENTITLEMENTS_DRM, ENTITLEMENTS_HELPER, grantedEntitlements } from './mac-sign-order'
import { KEYCHAIN_ADDON, KEYCHAIN_HELPER_BUNDLE, keychainPaths } from './vault-keychain'
import { SYSTEM_TRANSLATE_HELPER_BUNDLE, systemTranslateHelperPath } from './translate/system'
import { posix } from './windows.test-support'

// The packaging of the keychain helper of the password vault (Touch ID) and the order of the signatures, read as text: the scripts sign with the
// maintainer's identity and talk to castLabs' service, so none is run here. What must not change silently: EVS before the Developer ID, the fuses of
// the DRM build (castLabs' set by default, castLabs' own with --original-fuses), the helper carried in Contents/XPCServices/ and signed with its own
// rights, its addon in Contents/Resources/ signed by the app's team, the application signed without --deep.
const read = (relative: string) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')
/** The lines that are not comments, so that a comment cannot pass for code. */
const code = (text: string, mark: string): string =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(mark))
    .join('\n')

/** The entitlements a plist grants (`<key>…</key><true/>`), XML comments removed so that a commented-out key does not count. */
const granted = (relative: string): string[] => grantedEntitlements(read(relative))
const JIT = 'com.apple.security.cs.allow-jit'
const UNSIGNED_MEMORY = 'com.apple.security.cs.allow-unsigned-executable-memory'
const LIBRARY_VALIDATION = 'com.apple.security.cs.disable-library-validation'

describe('scripts/package-drm.mjs', () => {
  const script = code(read('scripts/package-drm.mjs'), '//')

  // One file for every piece put disable-library-validation on the main process too.
  it('signs each piece with the plist entitlementsFor names for it, not with one file for all: no plist is named in the script', () => {
    const signing = script.split('\n').filter((line) => line.includes("spawnSync('codesign', ['--force'"))
    expect(signing).toHaveLength(1)
    expect(signing[0]).toContain("...(plist ? ['--entitlements', plist] : [])")
    expect(script).toMatch(/const plist = entitlementsFor\(app, target\)\n\s*return spawnSync\('codesign', \['--force'/)
    expect(script).not.toMatch(/entitlements[^\n]*\.plist/)
    expect(script).not.toContain('DRM_ENTITLEMENTS')
  })

  it('reads the entitlements of every piece back from the signature, wants exactly the keys of its plist, and stops without exactly one plugin helper', () => {
    const verify = script.indexOf('const keysOf = ')
    expect(verify).toBeGreaterThan(script.indexOf("'--verify', '--deep', '--strict'"))
    expect(script).toMatch(/for \(const target of pieces\) \{\n\s*const plist = entitlementsFor\(app, target\)\n\s*const wanted = plist \? grantedEntitlements\(readFileSync\(join\(root, plist\), 'utf8'\)\) : \[\]/)
    expect(script).toMatch(/const signed = grantedEntitlements\(shown\.stdout \?\? ''\)/)
    // Exact: a key the plist does not hold fails as a key it holds and the signature lacks.
    expect(script).toMatch(/if \(shown\.status !== 0 \|\| keysOf\(signed\) !== keysOf\(wanted\)\) \{\n\s*fail\(/)
    expect(script).toMatch(/if \(plugins\.length !== 1\) fail\(/)
    expect(script.indexOf('if (plugins.length !== 1)')).toBeGreaterThan(verify)
  })

  // The plugin helper is the piece the Widevine module is hosted by: without it (or with two) the module would not load. It is counted by its name, since the plist
  // it is signed with is the one of the main process too.
  it('counts the plugin helper bundle by its name, and only it: not its executable, not the other helpers', () => {
    const literal = /if \((\/[^\n]+\/)\.test\(target\)\) plugins\.push\(target\)/.exec(script)?.[1]
    expect(literal).toBeDefined()
    const isPlugin = new RegExp(literal!.slice(1, -1))
    expect(isPlugin.test('/x/Lucium DRM.app/Contents/Frameworks/Lucium DRM Helper (Plugin).app')).toBe(true)
    expect(isPlugin.test('/x/Lucium DRM.app/Contents/Frameworks/Lucium DRM Helper (Plugin).app/Contents/MacOS/Lucium DRM Helper (Plugin)')).toBe(false)
    for (const other of ['', ' (GPU)', ' (Renderer)']) expect(isPlugin.test(`/x/Lucium DRM.app/Contents/Frameworks/Lucium DRM Helper${other}.app`), other).toBe(false)
    expect(isPlugin.test('/x/Lucium DRM.app')).toBe(false)
  })

  it('builds the keychain helper before the application, and hands the identity down only when the Developer ID signs', () => {
    expect(script).toMatch(/run\('bash', \['native\/vault-keychain\/build\.sh', '--arch', 'arm64'\], \{ env: helperEnv \}\)/)
    expect(script).toMatch(/if \(!wantApple\) delete helperEnv\.LUCIUM_SIGN_IDENTITY/)
    expect(script.indexOf('native/vault-keychain/build.sh')).toBeLessThan(script.indexOf("run('node_modules/.bin/electron-builder'"))
  })

  it('builds the addon of the keychain helper the same way, with the same environment, before the application', () => {
    expect(script).toMatch(/run\('bash', \['native\/vault-xpc\/build\.sh', '--arch', 'arm64'\], \{ env: helperEnv \}\)/)
    expect(script.indexOf('native/vault-xpc/build.sh')).toBeLessThan(script.indexOf("run('node_modules/.bin/electron-builder'"))
  })

  it('builds the helper of the system translation the same way, with the same environment, before the application', () => {
    expect(script).toMatch(/run\('bash', \['native\/system-translate\/build\.sh', '--arch', 'arm64'\], \{ env: helperEnv \}\)/)
    expect(script.indexOf('native/system-translate/build.sh')).toBeLessThan(script.indexOf("run('node_modules/.bin/electron-builder'"))
  })

  it('puts the helpers and the addon where the application looks for them, before the EVS signature', () => {
    expect(script).toMatch(/const helperShipped = join\(app, 'Contents', 'XPCServices', 'LuciumKeychain\.xpc'\)/)
    expect(script).toMatch(/const helperBuilt = join\(helperOut, 'LuciumKeychain\.xpc'\)/)
    expect(script).toMatch(/run\('ditto', \[helperBuilt, helperShipped\]\)/)
    expect(script.indexOf("run('ditto', [helperBuilt, helperShipped])")).toBeLessThan(script.indexOf("'sign-pkg'"))
    expect(script).toMatch(/const addonShipped = join\(app, 'Contents', 'Resources', 'vault-xpc\.node'\)/)
    expect(script).toMatch(/run\('ditto', \[addonBuilt, addonShipped\]\)/)
    expect(script.indexOf("run('ditto', [addonBuilt, addonShipped])")).toBeLessThan(script.indexOf("'sign-pkg'"))
    // The bundle is a macOS one, whose paths are written with `/`; `join` writes `\` on Windows.
    const where = keychainPaths('/x/Lucium.app/Contents/Resources')
    expect(posix(where.helper)).toBe(`/x/Lucium.app/Contents/XPCServices/${KEYCHAIN_HELPER_BUNDLE}`)
    expect(posix(where.addon)).toBe(`/x/Lucium.app/Contents/Resources/${KEYCHAIN_ADDON}`)
    expect(script).toMatch(/const translateShipped = join\(app, 'Contents', 'Helpers', 'LuciumTranslate\.app'\)/)
    expect(script).toMatch(/run\('ditto', \[translateBuilt, translateShipped\]\)/)
    expect(script.indexOf("run('ditto', [translateBuilt, translateShipped])")).toBeLessThan(script.indexOf("'sign-pkg'"))
  })

  it('signs with EVS first, then with the Developer ID, then checks the VMP signature again', () => {
    const evs = script.indexOf("'sign-pkg'")
    const apple = script.indexOf('signingOrder(app, [helperShipped, translateShipped])')
    expect(evs).toBeGreaterThan(0)
    expect(apple).toBeGreaterThan(evs)
    expect(script.lastIndexOf("'verify-pkg'")).toBeGreaterThan(apple)
  })

  it('signs the application piece by piece without --deep, leaves the helper out, and checks that the helper kept its own signature', () => {
    const signing = script.split('\n').filter((line) => line.includes("spawnSync('codesign', ['--force'"))
    expect(signing).toHaveLength(1)
    expect(signing[0]).not.toContain('--deep')
    // --deep is only ever a check (codesign --verify), never a signature.
    for (const line of script.split('\n').filter((l) => l.includes("'--deep'"))) expect(line).toContain("'--verify'")
    expect(script).toMatch(/if \(cdhashOf\(helperShipped\) !== helperBefore\) fail\(/)
    expect(script).toMatch(/if \(cdhashOf\(translateShipped\) !== translateBefore\) fail\(/)
  })

  it('stops when the addon or the helper is not signed by the team of the app, or the helper has the keychain rights without its profile', () => {
    const apple = script.indexOf('signingOrder(app, [helperShipped, translateShipped])')
    const team = script.indexOf("if (!appTeam || teamOf(addonShipped) !== appTeam || teamOf(helperShipped) !== appTeam) fail(")
    expect(team).toBeGreaterThan(apple)
    expect(script).toMatch(/const teamOf = \(target\) => \/\^TeamIdentifier=\(\[A-Z0-9\]\{10\}\)\$\/m\.exec/)
    expect(script).toMatch(/if \(helperRights\.includes\('<key>keychain-access-groups<\/key>'\) && !existsSync\(join\(helperShipped, 'Contents', 'embedded\.provisionprofile'\)\)\) \{\n\s*fail\(/)
  })

  it('never writes to /Applications: installing is the job of build-drm-release.sh, which never passes --fuse-trial', () => {
    expect(script).not.toContain('/Applications')
    expect(code(read('scripts/build-drm-release.sh'), '#')).not.toContain('--fuse-trial')
  })

  it('builds a fuse trial in its own folder, under its own identifier and data folder, never in the place of the installed application', () => {
    expect(script).toMatch(/const output = trial\?\.output \?\? join\(root, 'dist-drm'\)/)
    expect(script).toMatch(/if \(trial && asLucium\) fail\(/)
    expect(script).toMatch(/\.\.\.\(trial \? \[`-c\.appId=\$\{trial\.appId\}`, `-c\.extraMetadata\.name=\$\{trial\.dataName\}`, `-c\.extraMetadata\.productName=\$\{trial\.dataName\}`\] :/)
    // The fuses of a trial are its own map (one closed, or castLabs' set), written by the script, never left to electron-builder.yml.
    expect(script).toMatch(/const fuseSet = trial \?\? \(castlabsFuses \? castlabsReleaseFuses\(\) : null\)/)
    expect(script).toMatch(/\.\.\.\(fuseSet \|\| process\.argv\.includes\('--no-fuses'\) \? \[/)
    expect(script).toMatch(/Object\.entries\(fuseSet\?\.fuses \?\? CASTLABS_FUSES\)/)
  })

  it('builds the installed variant with castLabs\' set (--castlabs-fuses) under its real name, identifier and data folder', () => {
    expect(script).toMatch(/const castlabsFuses = process\.argv\.includes\('--castlabs-fuses'\)/)
    // The name and the identifier of a trial are its own; without a trial, --as-lucium keeps the normal application's (no -c.appId) and nothing
    // renames the package inside, so the data folder is the profile of the installed application.
    expect(script).toMatch(/const productName = trial\?\.productName \?\? \(asLucium \? 'Lucium' : 'Lucium DRM'\)/)
    expect(script).toMatch(/\.\.\.\(trial \? \[`-c\.appId=\$\{trial\.appId\}`, `-c\.extraMetadata\.name=\$\{trial\.dataName\}`, `-c\.extraMetadata\.productName=\$\{trial\.dataName\}`\] : asLucium \? \[\] : \['-c\.appId=app\.lucium\.browser\.drm'\]\)/)
    expect(script.match(/extraMetadata\.name/g)).toHaveLength(1)
    // package.json has a productName, which Electron reads before the name: a trial that renamed the name alone would open the user's profile.
    expect(script.match(/extraMetadata\.productName/g)).toHaveLength(1)
    // Its EVS signature goes to the normal cache of the tool, beside the one of the installed build: only a trial's is cached apart.
    expect(script).toMatch(/const evsEnv = trial \? \{ \.\.\.process\.env, EVS_CACHE_FILE: join\(output, 'evs-cache\.json'\) \} : process\.env/)
  })

  it('refuses --castlabs-fuses with --no-fuses or --fuse-trial, before the build', () => {
    expect(script).toMatch(/const fuseOptions = fuseOptionsProblem\(process\.argv\.slice\(2\)\)\nif \(fuseOptions\) fail\(fuseOptions\)/)
    expect(script.indexOf('if (fuseOptions) fail(fuseOptions)')).toBeLessThan(script.indexOf("run('bash', ['native/vault-keychain/build.sh'"))
  })

  // codesign takes a part of a name: "Developer ID" alone passed a check by substring, and signed with whichever identity it matched.
  it('checks the identity by its whole name among the Developer ID Application identities, as the disk image does, before the build', () => {
    expect(script).toMatch(/const \{ chooseIdentity \} = await import\('\.\.\/src\/main\/make-dmg\.ts'\)/)
    const check = script.indexOf("chooseIdentity(spawnSync('security', ['find-identity', '-v', '-p', 'codesigning']")
    expect(check).toBeGreaterThan(0)
    expect(script.slice(check).split('\n').slice(0, 2).join('\n')).toMatch(/if \(!chosen\.ok\) fail\(chosen\.message\)/)
    expect(check).toBeLessThan(script.indexOf("run('bash', ['native/vault-keychain/build.sh'"))
    expect(script).not.toMatch(/\.includes\([^)]*identity/)
  })

  it('stops when Info.plist lacks the sentence of the local network, instead of a warning nobody reads', () => {
    const read = script.indexOf("'Print :NSLocalNetworkUsageDescription'")
    expect(read).toBeGreaterThan(0)
    expect(script.slice(read).split('\n').slice(0, 2).join('\n')).toMatch(/if \(result\.status !== 0 \|\| result\.stdout\.trim\(\) === ''\) fail\('Info\.plist lacks NSLocalNetworkUsageDescription/)
  })

  // Apple notarizes nothing without a timestamp: the refusal came after the build, EVS and the upload.
  it('stops on the first piece signed without a timestamp when the build goes to Apple (--timestamp-required), before it falls back to none', () => {
    expect(script).toMatch(/const timestampRequired = process\.argv\.includes\('--timestamp-required'\)/)
    const stop = script.indexOf("if (timestamp === '--timestamp' && timestampRequired) fail(")
    const fallback = script.indexOf("timestamp = '--timestamp=none'")
    expect(stop).toBeGreaterThan(0)
    expect(stop).toBeLessThan(fallback)
    expect(script.match(/--timestamp=none/g)).toHaveLength(1)
  })

  it('reads the fuse wire back, for a trial and for castLabs\' set, and stops on any other change before the binary is sent to EVS', () => {
    expect(script).toMatch(/^if \(fuseSet\) \{$/m)
    expect(script).toMatch(/const wanted = Object\.entries\(fuseSet\.changed\)/)
    const check = script.indexOf('if (problem) fail(')
    expect(check).toBeGreaterThan(script.indexOf("run('node_modules/.bin/electron-builder'"))
    expect(check).toBeLessThan(script.indexOf("'sign-pkg'"))
    expect(script).toMatch(/trialWireProblem\(await getCurrentFuseWire\(join\(ecsDist, 'Electron\.app'\)\), await getCurrentFuseWire\(app\),/)
    for (const line of script.split('\n').filter((l) => l.includes("'sign-pkg'") || l.includes("'verify-pkg'"))) expect(line).toContain('env: evsEnv')
  })

  it('stops before EVS when the ASAR fuses are closed and the app is not in app.asar, or Info.plist lacks the hash of its header', () => {
    const sign = script.indexOf("'sign-pkg'")
    const asar = script.indexOf('fail(`${fuseCheck}: no Contents/Resources/app.asar')
    const missing = script.indexOf('fail(`${fuseCheck}: no ElectronAsarIntegrity for Resources/app.asar')
    const mismatch = script.indexOf('fail(`${fuseCheck}: the hash of ElectronAsarIntegrity is not the one of the header of app.asar')
    for (const at of [asar, missing, mismatch]) {
      expect(at).toBeGreaterThan(script.indexOf("run('node_modules/.bin/electron-builder'"))
      expect(at).toBeLessThan(sign)
    }
    expect(script).toMatch(/if \(\(fuseSet\.changed\.onlyLoadAppFromAsar \|\| fuseSet\.changed\.enableEmbeddedAsarIntegrityValidation\) && !existsSync\(asar\)\)/)
    expect(script).toMatch(/if \(fuseSet\.changed\.enableEmbeddedAsarIntegrityValidation\) \{/)
    // The hash Electron compares: SHA-256 of the header string of app.asar, read by the @electron/asar electron-builder packed it with.
    expect(script).toMatch(/createHash\('sha256'\)\.update\(builderLib\('@electron\/asar'\)\.getRawHeader\(asar\)\.headerString\)/)
    expect(script).toMatch(/'Print :ElectronAsarIntegrity:Resources\/app\.asar:hash'/)
  })
})

describe('scripts/build-drm-release.sh and scripts/electron-upgrade.mjs', () => {
  const release = code(read('scripts/build-drm-release.sh'), '#')

  it('both ask package-drm.mjs for castLabs\' set by default, the one set EVS signs with the fuses closed', () => {
    expect(release).toMatch(/^NO_INSTALL=0\nFUSES=--castlabs-fuses$/m)
    expect(release).toMatch(/^FLAGS=\("\$FUSES" --as-lucium --vmp\)$/m)
    expect(release).toMatch(/node scripts\/package-drm\.mjs "\$\{FLAGS\[@\]\}"/)
    const upgrade = code(read('scripts/electron-upgrade.mjs'), '//')
    expect(upgrade).toMatch(/const flags = \['--castlabs-fuses', /)
    expect(upgrade).toMatch(/run\('node', \['scripts\/package-drm\.mjs', \.\.\.flags\]/)
  })

  it('keeps the former build, castLabs\' fuses open, behind --original-fuses only', () => {
    expect(release).toMatch(/^ {4}--original-fuses\) FUSES=--no-fuses ;;$/m)
    expect(release.match(/--no-fuses/g)).toHaveLength(1)
  })

  // Signed by the team under the production identifier, a build with castLabs' fuses open would be installed by Squirrel from any feed.
  it('never signs the build with castLabs\' fuses open with a Developer ID: refused before the build with an identity or --notarize, and none looked for', () => {
    const build = release.indexOf('node scripts/package-drm.mjs')
    const identity = release.indexOf('if [ "$FUSES" != "--castlabs-fuses" ] && [ -n "${LUCIUM_SIGN_IDENTITY:-}" ]; then')
    const notarize = release.indexOf('if [ "$FUSES" != "--castlabs-fuses" ] && [ "$NOTARIZE" = 1 ]; then')
    for (const refusal of [identity, notarize]) {
      expect(refusal).toBeGreaterThan(0)
      expect(refusal).toBeLessThan(build)
      expect(release.slice(refusal).split('\n').slice(0, 3).join('\n')).toMatch(/exit 2/)
    }
    // Step 0 looks for no identity at all for that build: the first Developer ID of the keychain is never taken for it.
    const lookup = release.indexOf('SIGN_IDENTITY="$(sed -n')
    const skip = release.indexOf('if [ "$FUSES" != "--castlabs-fuses" ]; then\n  SIGN_IDENTITY=""')
    expect(skip).toBeGreaterThan(0)
    expect(skip).toBeLessThan(lookup)
  })

  it('takes LUCIUM_SIGN_IDENTITY by its whole name, between the quotes security prints it in, never by a part of it', () => {
    expect(release).toContain('if ! grep -qF -- "\\"$LUCIUM_SIGN_IDENTITY\\"" <<<"$IDENTITIES"; then')
    expect(release).not.toContain('grep -qF -- "$LUCIUM_SIGN_IDENTITY"')
  })

  it('asks package-drm.mjs and electron-upgrade.mjs for a timestamp on every piece when the build is notarized, and only then', () => {
    const flag = release.indexOf('if [ "$NOTARIZE" = 1 ]; then FLAGS+=(--timestamp-required); fi')
    expect(flag).toBeGreaterThan(release.indexOf('FLAGS=("$FUSES" --as-lucium --vmp)'))
    expect(flag).toBeLessThan(release.indexOf('node scripts/package-drm.mjs'))
    expect(release.match(/--timestamp-required/g)).toHaveLength(1)
    const upgrade = code(read('scripts/electron-upgrade.mjs'), '//')
    expect(upgrade).toContain("...(args.sign && args.notarize ? ['--timestamp-required'] : [])]")
  })

  // npm leaves its own copies of packages at the root of node_modules, which pnpm neither manages nor removes.
  it('refuses, before the build, a node_modules npm has touched: the tools are those of pnpm-lock.yaml', () => {
    const refusal = release.indexOf('if [ -e node_modules/.package-lock.json ]; then')
    expect(refusal).toBeGreaterThan(0)
    expect(refusal).toBeLessThan(release.indexOf('node scripts/package-drm.mjs'))
    expect(refusal).toBeLessThan(release.indexOf('security find-identity'))
    const block = release.slice(refusal, release.indexOf('\nfi\n', refusal))
    expect(block).toMatch(/rm -rf node_modules && pnpm install --frozen-lockfile/)
    expect(block).toMatch(/exit 2/)
  })

  it('says that the cookies will be encrypted, one way, and recommends a backup of the profile, before installing', () => {
    const warning = release.indexOf('if [ "$FUSES" = "--castlabs-fuses" ]; then\n  echo ""')
    expect(warning).toBeGreaterThan(release.indexOf('node scripts/package-drm.mjs'))
    expect(warning).toBeLessThan(release.indexOf('if [ "$NO_INSTALL" = 1 ]; then'))
    expect(warning).toBeLessThan(release.indexOf('ditto "$APP" /Applications/Lucium.app'))
    // What is printed: the echo lines of the block, so that a text kept but no longer shown does not pass.
    const said = release
      .slice(warning, release.indexOf('\nfi\n', warning))
      .split('\n')
      .filter((line) => /^\s*echo /.test(line))
      .join('\n')
    expect(said).toMatch(/encrypts the cookies of the profile/)
    expect(said).toMatch(/ONE WAY/)
    expect(said).toMatch(/ditto "\$HOME\/Library\/Application Support\/Lucium" "\$HOME\/Library\/Application Support\/lucium-profile-backups\/\$\(date \+%Y%m%d-%H%M%S\)"/)
    expect(said).toMatch(/--original-fuses/)
  })

  it('notarizes only with --notarize, after the last signature and before installing, and refuses before the build without a profile name', () => {
    const build = release.indexOf('node scripts/package-drm.mjs')
    const submit = release.indexOf('xcrun notarytool submit "$WORK/notarize.zip" --keychain-profile "$NOTARY_PROFILE" --wait')
    expect(release).toMatch(/^ {4}--notarize\) NOTARIZE=1 ;;$/m)
    expect(release.indexOf('--notarize needs LUCIUM_NOTARY_PROFILE')).toBeLessThan(build)
    expect(release.indexOf('--notarize needs a Developer ID Application identity')).toBeLessThan(build)
    expect(submit).toBeGreaterThan(build)
    expect(submit).toBeLessThan(release.indexOf('ditto "$APP" /Applications/Lucium.app'))
    // A refusal by Apple stops the script: nothing is stapled, zipped or installed.
    expect(release.slice(submit)).toMatch(/if \[ "\$SUBMIT_STATUS" != 0 \] \|\| \[ "\$ANSWER_STATUS" != "Accepted" \]; then\n(?:.*\n){1,3}?\s*exit 1/)
    const staple = release.indexOf('xcrun stapler staple "$APP"')
    expect(staple).toBeGreaterThan(submit)
    expect(release.indexOf('verify-pkg', staple)).toBeGreaterThan(staple)
    expect(release.indexOf('ditto -c -k --sequesterRsrc --keepParent "$APP" "$ARCHIVE"')).toBeGreaterThan(staple)
    // The credentials stay in the keychain: the script passes a profile name, never a key, a key id or an issuer.
    expect(release).not.toMatch(/--key |--key-id|--issuer|--password/)
  })

  it('installs Lucium.app: refuses while Lucium runs, moves the installed app aside, then puts the new one, and knows no other app name', () => {
    // The app is never replaced while it runs (pgrep reads the name of the executable, CFBundleExecutable).
    expect(release).toMatch(/^APP="dist-drm\/mac-arm64\/Lucium\.app"$/m)
    expect(release).toMatch(/^if pgrep -x Lucium >\/dev\/null; then\n(?:.*\n){1}? {2}exit 0\nfi$/m)
    expect(release).toMatch(/^if \[ -d \/Applications\/Lucium\.app \]; then mv \/Applications\/Lucium\.app "\$BACKUP\/"; fi$/m)
    const refuse = release.indexOf('if pgrep -x Lucium >/dev/null; then')
    const aside = release.indexOf('if [ -d /Applications/Lucium.app ]; then mv /Applications/Lucium.app "$BACKUP/"; fi')
    const install = release.indexOf('ditto "$APP" /Applications/Lucium.app')
    expect(refuse).toBeGreaterThan(release.indexOf('if [ "$NO_INSTALL" = 1 ]; then'))
    expect(aside).toBeGreaterThan(refuse)
    expect(install).toBeGreaterThan(aside)
    // /Applications holds one application of this project, Lucium.app: the script names no other, and looks for no other process.
    expect([...new Set(release.match(/\/Applications\/[A-Za-z ]+\.app/g))]).toEqual(['/Applications/Lucium.app'])
    expect(release.match(/pgrep -x \S+/g)).toEqual(['pgrep -x Lucium'])
    // The signature compared is the one of the app installed.
    expect(release).toMatch(/^INSTALLED_APP="\/Applications\/Lucium\.app"$/m)
    expect(release).toMatch(/codesign -dv "\$INSTALLED_APP"/)
    // The archive handed out after notarization carries the new name.
    expect(release).toMatch(/^ {2}ARCHIVE="dist-drm\/Lucium-\$VERSION-arm64\.zip"$/m)
    // What macOS keeps by path is the user's to move: the script says so after installing.
    const said = release.slice(install)
    for (const step of ['Dock', 'Login Items', 'Default web browser']) expect(said, step).toContain(step)
  })

  it('builds the update feed in with --update-feed only: refused before the build when it is not https, with --original-fuses, or without a Developer ID', () => {
    const build = release.indexOf('node scripts/package-drm.mjs')
    expect(release).toMatch(/^ {4}--update-feed\)\n {6}if \[ \$# -lt 2 \]; then echo .*; exit 2; fi\n {6}UPDATE_FEED="\$2"\n/m)
    expect(release).toMatch(/^ {4}--update-feed=\*\) UPDATE_FEED="\$\{arg#--update-feed=\}" ;;$/m)
    // One plain https address, never combined with castLabs' fuses left open: every build an update reaches reads the encrypted cookies.
    expect(release).toMatch(/^FEED_PATTERN='\^https:\/\/\[A-Za-z0-9\.-\]\+/m)
    const fuses = release.indexOf('if [ "$FUSES" != "--castlabs-fuses" ]; then\n    echo "❌ --update-feed cannot be combined with --original-fuses')
    expect(fuses).toBeGreaterThan(0)
    expect(release.slice(fuses).split('\n').slice(0, 4).join('\n')).toMatch(/exit 2/)
    const developerId = release.indexOf('if [ -n "$UPDATE_FEED" ] && [ "$NEW_SIGNATURE" != "developer-id" ]; then')
    expect(developerId).toBeGreaterThan(0)
    for (const refusal of [release.indexOf('--update-feed takes one plain https address'), fuses, developerId]) expect(refusal).toBeLessThan(build)
  })

  it('hands the address to electron-vite in MAIN_VITE_UPDATE_FEED, and clears any other one (the shell, a .env file) before the build', () => {
    const build = release.indexOf('node scripts/package-drm.mjs')
    const handed = release.indexOf('if [ -n "$UPDATE_FEED" ]; then export MAIN_VITE_UPDATE_FEED="$UPDATE_FEED"; else unset MAIN_VITE_UPDATE_FEED; fi')
    expect(handed).toBeGreaterThan(0)
    expect(handed).toBeLessThan(build)
    expect(release.indexOf("MAIN_VITE_UPDATE_FEED' .env .env.local .env.production .env.production.local; then")).toBeLessThan(build)
    expect(release.match(/MAIN_VITE_UPDATE_FEED=/g)).toHaveLength(1)
  })

  it('checks after the build, before anything is installed, that the address is in app.asar and that downgrades are refused', () => {
    const build = release.indexOf('node scripts/package-drm.mjs')
    const inAsar = release.indexOf('LC_ALL=C grep -a -q -F -- "$UPDATE_FEED" "$APP/Contents/Resources/app.asar"')
    const downgrade = release.indexOf("PlistBuddy -c 'Print :ElectronSquirrelPreventDowngrades' \"$APP/Contents/Info.plist\"")
    for (const check of [inAsar, downgrade]) {
      expect(check).toBeGreaterThan(build)
      expect(check).toBeLessThan(release.indexOf('xcrun notarytool submit'))
      expect(check).toBeLessThan(release.indexOf('ditto "$APP" /Applications/Lucium.app'))
      expect(release.slice(check).split('\n').slice(0, 3).join('\n')).toMatch(/exit 1/)
    }
  })

  it('neither reads nor copies the profile: it only names it in what it prints', () => {
    const touching = release.split('\n').filter((line) => /Application Support\/Lucium["/]/i.test(line))
    expect(touching.length).toBeGreaterThan(0)
    for (const line of touching) expect(line.trimStart(), line).toMatch(/^echo '/)
  })
})

describe('native/vault-keychain/build.sh', () => {
  const build = code(read('native/vault-keychain/build.sh'), '#')

  // The team goes into a pattern and into the entitlements: LUCIUM_TEAM_ID was taken as it came, and only the one read from the identity was checked.
  it('takes a team identifier of ten capital letters and digits only, wherever it came from, before it is used', () => {
    const check = build.indexOf(`printf '%s' "$team" | grep -Eqx '[A-Z0-9]{10}' || fail `)
    expect(check).toBeGreaterThan(build.indexOf('team="${LUCIUM_TEAM_ID:-}"'))
    for (const use of ['"$team.$bundle_id"', 'sed "s/__TEAM_ID__/$team/g"']) expect(build.indexOf(use)).toBeGreaterThan(check)
  })

  it('reads the dots of the access group as dots in the pattern that looks for it in the profile', () => {
    expect(build).toContain('$team\\\\.${access_group_suffix//./\\\\.})')
    expect(build).not.toMatch(/grep -Eq "[^"\n]*\$access_group_suffix\)/)
  })
})

describe('pnpm-workspace.yaml', () => {
  // An allowed build script nobody installs is a standing permission for whichever package takes the name next.
  it('allows the install script of a package only while pnpm-lock.yaml has that package', () => {
    const workspace = read('pnpm-workspace.yaml')
    const block = /^allowBuilds:\n((?:(?: {2}.*)?\n)+)/m.exec(workspace)?.[1] ?? ''
    const allowed = [...block.matchAll(/^ {2}([@\w/.-]+): true$/gm)].map((found) => found[1] as string)
    expect(allowed).toContain('electron')
    const lock = read('pnpm-lock.yaml')
    for (const name of allowed) expect(lock, name).toMatch(new RegExp(`^ {2}'?${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}@`, 'm'))
  })
})

describe('the update installer (electron-builder.yml)', () => {
  it('refuses a downgrade: Squirrel reads ElectronSquirrelPreventDowngrades in the Info.plist of the running application', () => {
    expect(code(read('electron-builder.yml'), '#')).toMatch(/^ {2}extendInfo:\n(?: {4}.*\n|\s*\n)*? {4}ElectronSquirrelPreventDowngrades: true$/m)
  })
})

// « Open With » lists the applications whose Info.plist declares the type of the file. Lucium shows PDF and pictures in a tab (shared/local-documents.ts), so it
// declares them, at the Alternate rank: it is offered, and macOS never makes it the application that opens a PDF or a picture when the user double-clicks one.
describe('the document types of the application (electron-builder.yml)', () => {
  const config = code(read('electron-builder.yml'), '#')
  const block = /^ {4}CFBundleDocumentTypes:\n((?: {6}.*\n|\s*\n)+)/m.exec(config)?.[1] ?? ''
  const types = block
    .split(/^ {6}- /m)
    .slice(1)
    .map((item) => ({
      name: /CFBundleTypeName: (.+)/.exec(item)?.[1],
      role: /CFBundleTypeRole: (\w+)/.exec(item)?.[1],
      rank: /LSHandlerRank: (\w+)/.exec(item)?.[1],
      contentTypes: /LSItemContentTypes: \[(.*)\]/.exec(item)?.[1]?.split(/,\s*/) ?? []
    }))

  it('declares the web pages, the PDF documents and the pictures a tab shows', () => {
    expect(types.map((type) => type.name)).toEqual(['HTML document', 'PDF document', 'Image'])
    expect(types.find((type) => type.name === 'PDF document')?.contentTypes).toEqual(['com.adobe.pdf'])
    expect(types.find((type) => type.name === 'Image')?.contentTypes).toEqual(['public.png', 'public.jpeg', 'com.compuserve.gif', 'org.webmproject.webp', 'public.svg-image'])
    for (const type of types) expect(type.role, type.name).toBe('Viewer')
  })

  it('never makes Lucium the default application for a PDF or a picture: only the web pages, which a browser is for, are not at the Alternate rank', () => {
    for (const type of types.filter((one) => one.name !== 'HTML document')) expect(type.rank, type.name).toBe('Alternate')
  })
})

describe('the normal application (electron-builder.yml, package.json)', () => {
  const config = code(read('electron-builder.yml'), '#')
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts

  it('carries the helper in Contents/XPCServices/ and its addon in Contents/Resources/, where vault-keychain.ts looks for them', () => {
    expect(config).toMatch(/^ {2}extraFiles:\n {4}- from: out-native\/LuciumKeychain\.xpc\n {6}to: XPCServices\/LuciumKeychain\.xpc$/m)
    expect(config).toMatch(/^ {2}extraResources:\n {4}- from: out-native\/vault-xpc\.node\n {6}to: vault-xpc\.node$/m)
    const shipped = keychainPaths('/Applications/Lucium.app/Contents/Resources')
    expect({ helper: posix(shipped.helper), addon: posix(shipped.addon) }).toEqual({ helper: `/Applications/Lucium.app/Contents/XPCServices/${KEYCHAIN_HELPER_BUNDLE}`, addon: `/Applications/Lucium.app/Contents/Resources/${KEYCHAIN_ADDON}` })
  })

  it('carries the helper of the system translation beside it, where translate/system.ts looks for it', () => {
    expect(config).toMatch(/^ {4}- from: out-native\/LuciumTranslate\.app\n {6}to: Helpers\/LuciumTranslate\.app$/m)
    expect(posix(systemTranslateHelperPath({ built: true, resourcesPath: '/Applications/Lucium.app/Contents/Resources', appPath: '' }))).toBe(`/Applications/Lucium.app/Contents/Helpers/${SYSTEM_TRANSLATE_HELPER_BUNDLE}/Contents/MacOS/lucium-translate`)
  })

  it('leaves the helpers out of its own signature, with patterns that match each helper and its files', () => {
    const patterns = /^ {2}signIgnore:\n((?: {4}- '[^']+'\n?)+)/m.exec(config)?.[1]?.match(/'[^']+'/g)?.map((quoted) => quoted.slice(1, -1))
    expect(patterns).toEqual(['Contents/XPCServices/LuciumKeychain\\.xpc', 'Contents/Helpers/LuciumTranslate\\.app'])
    // electron-builder matches these patterns against `/` paths, so the paths are written that way here whatever the system.
    const keychain = keychainPaths('/x/Lucium.app/Contents/Resources')
    const helper = posix(keychain.helper)
    const addon = posix(keychain.addon)
    const translate = posix(systemTranslateHelperPath({ built: true, resourcesPath: '/x/Lucium.app/Contents/Resources', appPath: '' }))
    expect(new RegExp(patterns![0]!).test(helper)).toBe(true)
    expect(new RegExp(patterns![1]!).test(translate)).toBe(true)
    for (const pattern of patterns!) expect(new RegExp(pattern).test('/x/Lucium.app/Contents/Frameworks/Lucium Helper.app')).toBe(false)
    // The addon is signed by the app's own signature: no pattern leaves it out.
    for (const pattern of patterns!) expect(new RegExp(pattern).test(addon)).toBe(false)
  })

  it('is signed with the JIT and the devices a browser asks for, and neither the unsigned executable memory nor the loading of any library', () => {
    const normal = granted('build/entitlements.mac.plist')
    expect(ENTITLEMENTS_APP).toBe('build/entitlements.mac.plist')
    expect(normal).toContain(JIT)
    expect(normal).not.toContain(UNSIGNED_MEMORY)
    expect(normal).not.toContain(LIBRARY_VALIDATION)
    // The signed build of the normal application takes this file, for the app and every helper it signs (electron-builder has one file for all of them).
    expect(scripts['package:signed']).toContain('-c.mac.entitlements=build/entitlements.mac.plist -c.mac.entitlementsInherit=build/entitlements.mac.plist')
    for (const [name, line] of Object.entries(scripts)) expect(line, name).not.toMatch(/entitlements\.drm/)
    expect(config).not.toMatch(/entitlements/)
    expect(code(read('.github/workflows/release.yml'), '#')).not.toMatch(/entitlements\.drm|disable-library-validation|unsigned-executable-memory/)
  })

  it('has the DRM variant give the unsigned executable memory and the loading of libraries signed by another team to its own file alone', () => {
    // Exactly the six keys: the three of the normal build's file (the JIT and the devices), and the two that Widevine needs, which the normal build has not.
    expect([...granted(ENTITLEMENTS_DRM)].sort()).toEqual([...granted(ENTITLEMENTS_APP), UNSIGNED_MEMORY, LIBRARY_VALIDATION].sort())
    expect(granted(ENTITLEMENTS_DRM)).toHaveLength(6)
    expect(granted(ENTITLEMENTS_HELPER)).toEqual([JIT])
    expect(ENTITLEMENTS_DRM).toBe('build/entitlements.drm.mac.plist')
    expect(ENTITLEMENTS_HELPER).toBe('build/entitlements.drm.helper.mac.plist')
    // Any other plist of build/, today or added later, stays without them: the renderer and GPU helpers keep library validation.
    const plists = readdirSync(fileURLToPath(new URL('../../build', import.meta.url))).filter((name) => name.endsWith('.plist'))
    expect(plists.sort()).toEqual(['entitlements.drm.helper.mac.plist', 'entitlements.drm.mac.plist', 'entitlements.mac.plist'])
    for (const name of plists.filter((plist) => plist !== 'entitlements.drm.mac.plist')) {
      expect(granted(`build/${name}`), name).not.toContain(UNSIGNED_MEMORY)
      expect(granted(`build/${name}`), name).not.toContain(LIBRARY_VALIDATION)
    }
  })

  it('builds the helpers before packaging, and does not let the fuses sign them again ad hoc (--deep) before the Developer ID signs', () => {
    for (const name of ['package', 'package:signed']) expect(scripts[name], name).toMatch(/&& pnpm build:native && electron-builder /)
    expect(scripts['build:native']).toBe('pnpm build:keychain && pnpm build:vault-xpc && pnpm build:translate')
    expect(scripts['build:keychain']).toBe('bash native/vault-keychain/build.sh')
    expect(scripts['build:vault-xpc']).toBe('bash native/vault-xpc/build.sh')
    expect(scripts['build:translate']).toBe('bash native/system-translate/build.sh')
    expect(scripts['package:signed']).toContain('-c.electronFuses.resetAdHocDarwinSignature=false')
  })
})

// codesign once refused build/entitlements.drm.mac.plist (« AMFIUnserializeXML: syntax error near line 5 ») because a comment held
// « --apple ». A double hyphen is not allowed inside an XML comment; plutil lets it pass, the strict parser of codesign does not.
describe('the entitlements files', () => {
  it.each([ENTITLEMENTS_APP, ENTITLEMENTS_HELPER, ENTITLEMENTS_DRM])('%s has no double hyphen inside its comments, which codesign refuses', (file) => {
    const comments = [...read(file).matchAll(/<!--([\s\S]*?)-->/g)].map((match) => match[1]!)
    expect(comments.length).toBeGreaterThan(0)
    for (const comment of comments) expect(comment, comment.slice(0, 80)).not.toContain('--')
  })
})
