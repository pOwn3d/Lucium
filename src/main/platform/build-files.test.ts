import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REPOSITORY_URL } from '@shared/about'

// The files that build Lucium for the other systems are drafts that nobody has run. What they must never do is checked here as text, because the
// two things that would hurt (publishing something, signing with something that is not the project's) happen silently once a workflow runs.
const read = (relative: string): string => readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8')

/** The lines of a YAML file that are not comments, so that a comment saying "no secret" cannot be mistaken for a use. */
const code = (text: string): string => text.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')

describe('.github/workflows/build.yml', () => {
  const raw = read('.github/workflows/build.yml')
  const workflow = code(raw)

  it('reads no secret and publishes nothing', () => {
    expect(workflow).not.toMatch(/secrets\./)
    expect(workflow).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|CSC_LINK|CSC_KEY_PASSWORD|APPLE_|WIN_CSC/)
    expect(workflow).not.toMatch(/gh release|action-gh-release|softprops|npm publish|--publish (always|onTag|onTagOrDraft)/)
    expect(workflow).toMatch(/--publish never/)
  })

  it('has a read-only token and is started by hand or by a version tag, never by a pull request from a fork', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m)
    expect(workflow).not.toMatch(/contents: write/)
    expect(workflow).not.toMatch(/pull_request_target/)
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:/m)
    // The tag is the check that a version packages (the release workflow builds nothing). No branch, no pull request, no timer.
    expect(workflow).toMatch(/^ {2}push:\n {4}tags: \['v\*'\]\n\n/m)
    expect(workflow).not.toMatch(/^ {2}(pull_request|schedule):/m)
    expect(workflow).not.toMatch(/branches:/)
  })

  it('does not look for a signing identity, and lets Windows and Linux fail without failing the run', () => {
    expect(workflow).toMatch(/CSC_IDENTITY_AUTO_DISCOVERY: 'false'/)
    expect(workflow).toMatch(/continue-on-error: \$\{\{ matrix\.experimental \}\}/)
    expect(workflow).toMatch(/os: windows-latest\n\s+experimental: true/)
    expect(workflow).toMatch(/os: ubuntu-latest\n\s+experimental: true/)
  })

  // electron-builder downloads its Windows and Linux tools, and Electron itself, from an address a variable can move: the workflows leave it alone.
  it('never moves the address electron-builder and Electron download from', () => {
    const folder = (relative: string): string[] => readdirSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)))
    // The steps of the local actions (.github/actions/<name>/action.yml) run in the workflows: they are held to the same rule.
    const files = [...folder('.github/workflows/').filter((name) => /\.ya?ml$/.test(name)).map((name) => `.github/workflows/${name}`), ...folder('.github/actions/').map((name) => `.github/actions/${name}/action.yml`)]
    expect(files).toContain('.github/actions/setup/action.yml')
    for (const file of files) {
      expect(code(read(file)), file).not.toMatch(/(?:ELECTRON(?:_BUILDER)?_(?:BINARIES_)?(?:CUSTOM_DIR|MIRROR|NIGHTLY_MIRROR))|electron_(?:builder_binaries_)?mirror/i)
    }
  })

  it('keeps the packages three days and only when asked', () => {
    expect(workflow).toMatch(/retention-days: 3/)
    expect(workflow.match(/if: \$\{\{ inputs\.package \}\}/g)?.length).toBe(2)
  })
})

// The Linux test suite (linux.yml): it starts the application on a runner, with `sudo` for the AppArmor profile and the package manager. What it must never
// do is checked as text: switch the sandbox of Chromium off, hand anything out, sign, hold a secret, take the name of a required check, or run on the rights
// of a fork.
describe('.github/workflows/linux.yml', () => {
  const workflow = code(read('.github/workflows/linux.yml'))
  const script = code(read('scripts/linux-ci.sh'))
  const REQUIRED_CHECKS = ['Type check', 'Lint', 'Unit tests (Linux)', 'Unit tests (macOS)', 'Build (macOS, unsigned)', 'DCO', 'PR title']

  it('never switches the sandbox of Chromium off: no switch, no variable, in the workflow, its script and the launcher of the E2E tests', () => {
    const off = /--no-sandbox|--disable-setuid-sandbox|--disable-gpu-sandbox|--disable-seccomp-filter-sandbox|ELECTRON_DISABLE_SANDBOX|\bno-sandbox\b/
    expect(workflow).not.toMatch(off)
    expect(code(read('tests/e2e/launch.ts').replaceAll('//', '#'))).not.toMatch(off)
    // The script talks about the switch to find it in a process and to say that it is refused, never to pass it.
    for (const line of script.split('\n').filter((candidate) => off.test(candidate))) expect(line).toMatch(/grep|fail |refused/)
    // And what proves the sandbox is on: a renderer without a seccomp filter fails the smoke test.
    expect(script).toMatch(/\[ "\$seccomp" = 2 \] \|\| \{ fail /)
  })

  it('reads no secret, signs nothing and leaves the packages on the runner', () => {
    expect(workflow).not.toMatch(/secrets\./)
    expect(workflow).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|CSC_LINK|CSC_KEY_PASSWORD|APPLE_|WIN_CSC/)
    expect(workflow).not.toMatch(/gh release|action-gh-release|softprops|npm publish|--publish (always|onTag|onTagOrDraft)/)
    expect(workflow).toMatch(/--publish never/)
    expect(workflow).toMatch(/CSC_IDENTITY_AUTO_DISCOVERY: 'false'/)
    expect(workflow).not.toMatch(/contents: write|pull_request_target|workflow_run/)
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m)
    expect(workflow.match(/^ {4}permissions:\n {6}contents: read$/gm)).toHaveLength(2)
  })

  it('runs on a pull request that touches the code, every night and by hand, and builds nothing for macOS', () => {
    expect(workflow).toMatch(/^on:\n {2}pull_request:\n {4}paths:\n/m)
    expect(workflow).toContain("      - 'src/**'\n")
    expect(workflow).toContain("      - 'tests/e2e/**'\n")
    expect(workflow).toContain("      - 'electron-builder.yml'\n")
    expect(workflow).toMatch(/^ {2}schedule:\n {4}- cron: '\d+ \d+ \* \* \*'\n {2}workflow_dispatch:$/m)
    expect(workflow).not.toMatch(/macos|windows/)
  })

  it('names its jobs so that none is mistaken for a required check of main, and none is one', () => {
    const names = [...workflow.matchAll(/^ {4}name: (.+)$/gm)].map((match) => match[1]!)
    expect(names).toEqual(['Linux packages (${{ matrix.arch }})', 'E2E (Linux, xvfb)'])
    for (const name of names) expect(REQUIRED_CHECKS).not.toContain(name)
    // The names ci.yml and pr-conventions.yml give the required checks are still there, written once each.
    const gates = code(read('.github/workflows/ci.yml')) + code(read('.github/workflows/pr-conventions.yml'))
    for (const name of REQUIRED_CHECKS) expect(gates.match(new RegExp(`^ {4}name: ${name.replace(/[()]/g, '\\$&')}$`, 'gm')), name).toHaveLength(1)
  })

  it('makes the AppImage and the deb for x64 and for arm64, unsigned, and keeps them under names that say so', () => {
    expect(workflow).toMatch(/- arch: x64\n {12}os: ubuntu-24\.04\n {12}flag: --x64\n {10}- arch: arm64\n {12}os: ubuntu-24\.04-arm\n {12}flag: --arm64\n/)
    expect(workflow).toMatch(/electron-builder --linux AppImage deb "\$ARCH_FLAG" --publish never/)
    expect(workflow).toMatch(/mv "\$file" "\$\{file%\.\*\}-UNSIGNED-check-build\.\$\{file##\*\.\}"/)
    expect(workflow).toMatch(/name: lucium-linux-\$\{\{ matrix\.arch \}\}-UNSIGNED-check-build\n {10}path: dist\/\*-UNSIGNED-check-build\.\*\n {10}if-no-files-found: error\n {10}retention-days: 7\n/)
  })

  it('starts the packages themselves: the deb installed with apt, the AppImage as the machine has it and once user namespaces are allowed', () => {
    expect(workflow).toContain('apt-get install -y ./dist/*-UNSIGNED-check-build.deb')
    expect(workflow).toMatch(/smoke "deb-\$\{\{ matrix\.arch \}\}" start \/usr\/bin\/lucium/)
    expect(workflow).toMatch(/if unshare -Ur true 2>\/dev\/null; then expect=start; fi\n\s+bash scripts\/linux-ci\.sh smoke "appimage-\$\{\{ matrix\.arch \}\}-as-is" "\$expect" "\$appimage"/)
    expect(workflow).toMatch(/bash scripts\/linux-ci\.sh unrestrict\n[\s\S]*smoke "appimage-\$\{\{ matrix\.arch \}\}-userns" start /)
  })

  it('runs the Playwright suite under a virtual screen, after the profile that lets the Electron binary of the tests create its sandbox', () => {
    expect(workflow).toMatch(/sandbox-profile "\$\(node -p "require\('electron'\)"\)"\n/)
    expect(workflow).toMatch(/xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24' pnpm exec playwright test\n/)
    expect(workflow.indexOf('linux-ci.sh sandbox-profile')).toBeLessThan(workflow.indexOf('pnpm exec playwright test'))
  })

  it('leaves the other workflows alone: the engine chain stays in smoke-macos.yml, and ci.yml starts no window', () => {
    expect(workflow).not.toMatch(/pnpm test:engine/)
    expect(code(read('.github/workflows/ci.yml'))).not.toMatch(/linux-ci\.sh|xvfb|playwright/)
  })

  it('refuses to run its script anywhere but on Linux', () => {
    expect(script).toMatch(/if \[ "\$\(uname -s\)" != Linux \]; then\n\s+echo "linux-ci\.sh: Linux only[^\n]*\n\s+exit 2\n/)
  })
})

describe('electron-builder.yml', () => {
  const config = code(read('electron-builder.yml'))

  it('keeps what the macOS build had: unsigned, the directory target first, the fuses', () => {
    expect(config).toMatch(/^ {2}identity: null$/m)
    expect(config).toMatch(/^ {2}target:\n {4}- target: dir\n {6}arch: \[arm64\]/m)
    for (const fuse of ['runAsNode: false', 'enableNodeOptionsEnvironmentVariable: false', 'enableNodeCliInspectArguments: false', 'onlyLoadAppFromAsar: true', 'resetAdHocDarwinSignature: true']) {
      expect(config, fuse).toContain(fuse)
    }
    expect(config).toMatch(/^appId: app\.lucium\.browser$/m)
  })

  it('leaves the engine tests and their helpers out of the package', () => {
    // The exclusions of `files`, each as the expression of the file names it takes out of out/main.
    const excluded = [...config.matchAll(/^ {2}- '!out\/main\/([^'/]+)'$/gm)].map((match) => new RegExp(`^${match[1]!.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`))
    const mainDir = fileURLToPath(new URL('..', import.meta.url))
    const sources = (readdirSync(mainDir, { recursive: true, encoding: 'utf8' }) as string[]).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    // A suite, or a helper of the tests: the bundler names a piece after the module it is made for (`smoke-run-PcDh0X2Q.js`).
    const testOnly = sources.filter((file) => /(^|\/)smoke[^/]*\.ts$/.test(file) || /test-support\.ts$/.test(file))
    expect(testOnly.length).toBeGreaterThan(60)
    expect(testOnly).toContain('smoke-run.ts')
    expect(testOnly).toContain('importers/app-bundles.test-support.ts')
    const shipped = testOnly.filter((file) => {
      const piece = `${file.split('/').pop()!.replace(/\.ts$/, '')}-PcDh0X2Q.js`
      return !excluded.some((pattern) => pattern.test(piece))
    })
    expect(shipped).toEqual([])
    // And the exclusions take nothing else: the entry of the main process and an ordinary piece stay.
    for (const kept of ['index.js', 'runtime-44vBwoko.js', 'model-D59hRkrE.js']) expect(excluded.some((pattern) => pattern.test(kept)), kept).toBe(false)
  })

  it('declares one command scheme, lucium, and no alias', () => {
    expect(config.match(/CFBundleURLSchemes: \[.*\]/g)).toEqual(['CFBundleURLSchemes: [http, https]', 'CFBundleURLSchemes: [lucium]'])
  })

  it('builds Windows and Linux without any certificate and without publishing', () => {
    expect(config).not.toMatch(/cscLink|cscKeyPassword|certificateFile|certificateSubjectName|signtoolOptions|azureSignOptions|publisherName/)
    expect(config).not.toMatch(/^ *publish:/m)
    expect(config).toMatch(/- target: nsis/)
    expect(config).toMatch(/- target: AppImage/)
    expect(config).toMatch(/- target: deb/)
  })

  it('gives the Windows build its own icon, an .ico with every size Windows asks for', () => {
    expect(config).toMatch(/^win:\n(?: {2}.*\n)*? {2}icon: build\/icon\.ico$/m)
    const ico = readFileSync(fileURLToPath(new URL('../../../build/icon.ico', import.meta.url)))
    // ICONDIR: reserved 0, type 1 (icon), number of images; then 16 bytes per image whose first byte is the width (0 stands for 256).
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1])
    const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + i * 16] || 256).sort((a, b) => a - b)
    expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256])
  })

  it('makes the two macOS archives per processor and nothing universal', () => {
    expect(config).toMatch(/- target: zip\n {6}arch: \[x64, arm64\]/)
    expect(config).toMatch(/- target: dmg\n {6}arch: \[x64, arm64\]/)
    expect(config).not.toMatch(/universal/)
  })
})

describe('build/installer.nsh', () => {
  const raw = read('build/installer.nsh')
  const script = raw.split('\n').filter((line) => !line.trimStart().startsWith(';')).join('\n')
  const macro = (name: string): string => new RegExp(`!macro ${name}\\n([\\s\\S]*?)!macroend`).exec(script)?.[1] ?? ''

  it('exists where electron-builder looks for it, and defines the two macros it calls', () => {
    expect(macro('customInstall')).not.toBe('')
    expect(macro('customUnInstall')).not.toBe('')
  })

  it('lists Lucium as a web browser Windows can offer for http and https, with the command that starts it', () => {
    const install = macro('customInstall')
    expect(install).toMatch(/Capabilities\\URLAssociations" "http" "\$\{LUCIUM_URL_PROGID\}"/)
    expect(install).toMatch(/Capabilities\\URLAssociations" "https" "\$\{LUCIUM_URL_PROGID\}"/)
    expect(install).toMatch(/Software\\RegisteredApplications" "\$\{PRODUCT_NAME\}" "\$\{LUCIUM_CLIENT_KEY\}\\Capabilities"/)
    // The address goes after "--" and in quotes: an address that begins with a dash is never read as a switch.
    expect(install).toContain(`'"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" -- "%1"'`.replace('\\\$', '\\$'))
  })

  it('writes under the root of the install (SHELL_CONTEXT), never straight into HKLM or HKCU, and never under HKCR', () => {
    expect(script).not.toMatch(/\b(HKLM|HKCU|HKCR|HKEY_[A-Z_]+)\b/)
    const writes = script.split('\n').filter((line) => /^\s*(WriteReg|DeleteReg)/.test(line))
    expect(writes.length).toBeGreaterThan(10)
    // The client key is a define that starts with "Software\\" (the first lines of the file).
    expect(script).toContain('!define LUCIUM_CLIENT_KEY "Software\\')
    for (const line of writes) expect(line).toMatch(/SHELL_CONTEXT "(?:Software\\|\$\{LUCIUM_CLIENT_KEY\})/)
  })

  it('removes everything it wrote when the application is uninstalled or updated', () => {
    const keysOf = (text: string, command: string): string[] => [...text.matchAll(new RegExp(`${command} SHELL_CONTEXT "([^"]+)"`, 'g'))].map((match) => match[1]!)
    const written = keysOf(macro('customInstall'), 'WriteRegStr')
    const removed = macro('customUnInstall')
    const deleted = keysOf(removed, 'DeleteRegKey')
    expect(written.length).toBeGreaterThan(10)
    // Every key written is the deleted key or lies under one; the one value in a key that is not ours (RegisteredApplications) is deleted by name.
    for (const key of written.filter((key) => key !== 'Software\\RegisteredApplications')) expect(deleted.some((gone) => key === gone || key.startsWith(`${gone}\\`)), key).toBe(true)
    expect(removed).toContain('DeleteRegValue SHELL_CONTEXT "Software\\RegisteredApplications" "${PRODUCT_NAME}"')
  })

  it('runs no program, opens no window and reads no secret', () => {
    expect(script).not.toMatch(/\b(Exec|ExecWait|ExecShell|ExecShellWait|nsExec|MessageBox|InetC|NSISdl|inetc)\b/i)
    expect(script).not.toMatch(/password|token|secret|certificate/i)
  })
})

// Electron names the profile folder (~/Library/Application Support/Lucium) and the keychain key that encrypts the cookies ("Lucium Safe
// Storage") after app.name, which is the productName of the package.json inside app.asar, else its name. electron-builder's own productName never
// reaches that package.json: the productName of package.json is what counts. Renaming the package, dropping or changing its productName (in
// package.json, under extraMetadata, or with -c.extraMetadata outside the fuse trials) would open an empty profile and lose every session.
describe('the internal name that keeps the profile and the cookie key', () => {
  const pkg = JSON.parse(read('package.json')) as Record<string, unknown>
  const config = code(read('electron-builder.yml'))
  const extraMetadata = /^extraMetadata:\n((?: {2}.*\n)+)/m.exec(`${config}\n`)?.[1] ?? ''

  it('package.json is named lucium and its productName is Lucium, the name of the profile folder', () => {
    expect(pkg.name).toBe('lucium')
    expect(pkg.productName).toBe('Lucium')
    expect(config).toMatch(/^productName: Lucium$/m)
  })

  it('electron-builder.yml writes neither a name nor a productName into the package.json of the app', () => {
    expect(extraMetadata).toContain('homepage:')
    expect(extraMetadata).not.toMatch(/^ {2}(name|productName):/m)
  })

  it('the scripts pass -c.extraMetadata only for the fuse trials, and nothing in the code renames the application', () => {
    const drm = read('scripts/package-drm.mjs')
    const uses = drm.split('\n').filter((line) => line.includes('extraMetadata') && !line.trimStart().startsWith('//'))
    expect(uses).toHaveLength(1)
    expect(uses[0]).toMatch(/trial \? \[`-c\.appId=\$\{trial\.appId\}`, `-c\.extraMetadata\.name=\$\{trial\.dataName\}`, `-c\.extraMetadata\.productName=\$\{trial\.dataName\}`\]/)
    for (const script of ['scripts/build-drm-release.sh', 'scripts/electron-upgrade.mjs', 'scripts/dev-electron.mjs']) {
      expect(read(script), script).not.toMatch(/extraMetadata|productName=/i)
    }
    expect(JSON.stringify(pkg.scripts)).not.toMatch(/extraMetadata/)
    const sources = readdirSync(fileURLToPath(new URL('../../', import.meta.url)), { recursive: true, encoding: 'utf8' }).filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    expect(sources.length).toBeGreaterThan(100)
    for (const file of sources) expect(read(`src/${file}`), file).not.toMatch(/\bapp\.setName\(|\bapp\.name\s*=[^=]/)
  })
})

// The address of the repository is REPOSITORY_URL (src/shared/about.ts), which the application's links are made from. The files that cannot import it
// (YAML, the issue forms, the scripts' user agents) write it out: every address of a GitHub repository of the project they hold must be that one.
describe('the address of the repository', () => {
  const holders = ['electron-builder.yml', 'scripts/electron-upgrade.mjs', 'scripts/electron-watch.mjs', ...readdirSync(fileURLToPath(new URL('../../../.github/ISSUE_TEMPLATE/', import.meta.url))).map((file) => `.github/ISSUE_TEMPLATE/${file}`)]
  const own = /https:\/\/github\.com\/[\w.-]+\/lucium\b/gi

  it('is github.com/pOwn3d/Lucium, and the homepage of the package', () => {
    expect(REPOSITORY_URL).toBe('https://github.com/pOwn3d/Lucium')
    expect(code(read('electron-builder.yml'))).toMatch(new RegExp(`^ {2}homepage: ${REPOSITORY_URL.replaceAll('.', '\\.')}$`, 'm'))
  })

  it('is the only repository of the project named by the build file, the issue forms and the scripts', () => {
    let found = 0
    for (const file of holders) {
      for (const address of read(file).match(own) ?? []) {
        expect(address, file).toBe(REPOSITORY_URL)
        found += 1
      }
    }
    expect(found).toBeGreaterThanOrEqual(10)
  })
})
