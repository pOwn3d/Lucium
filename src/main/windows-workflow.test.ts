// The text of .github/workflows/windows.yml: what it must never do (sign, upload a release, read a secret, hide a failure), and that it reads the registry
// keys build/installer.nsh writes. The workflow itself only runs on GitHub; these tests hold what can be held here.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')
/** The file without its comment lines. */
const code = (text: string): string => text.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')

const workflow = code(read('.github/workflows/windows.yml'))

/** The text of one job: from `  <id>:` to the next job. */
const job = (id: string): string => new RegExp(`^ {2}${id}:\\n([\\s\\S]*?)(?=^ {2}[a-z][a-z-]*:\\n|(?![\\s\\S]))`, 'm').exec(workflow)?.[1] ?? ''

describe('.github/workflows/windows.yml', () => {
  it('has three jobs, on a Windows runner, named so that none of them is a required check of main', () => {
    const names = [...workflow.matchAll(/^ {4}name: (.+)$/gm)].map((match) => match[1])
    expect(names).toEqual(['Unit tests (Windows)', 'Installer (Windows, unsigned)', 'E2E (Windows)'])
    // The seven required checks (docs/community/maintainers.md): none of their names is taken, so nothing here can stand for one of them.
    for (const required of ['Type check', 'Lint', 'Unit tests (Linux)', 'Unit tests (macOS)', 'Build (macOS, unsigned)', 'DCO', 'PR title']) expect(names).not.toContain(required)
    expect(workflow.match(/^ {4}runs-on: windows-latest$/gm)).toHaveLength(3)
  })

  it('starts on a pull request (never one that runs with the rights of the repository), by hand and every night', () => {
    expect(workflow).toMatch(/^on:\n {2}pull_request:\n {4}paths-ignore:/m)
    expect(workflow).toMatch(/^ {2}workflow_dispatch:$/m)
    expect(workflow).toMatch(/^ {2}schedule:\n {4}- cron: '[\d* ]+'$/m)
    expect(workflow).not.toMatch(/pull_request_target|workflow_run/)
    // The nightly run is the E2E one: the other two jobs are what a pull request needs.
    expect(job('unit')).toMatch(/if: \$\{\{ github\.event_name != 'schedule' \}\}/)
    expect(job('installer')).toMatch(/if: \$\{\{ github\.event_name != 'schedule' \}\}/)
    expect(job('e2e')).not.toMatch(/^ {4}if:/m)
  })

  it('hides no failure: no continue-on-error, no retry, no step that always passes', () => {
    expect(workflow).not.toMatch(/continue-on-error|retries|\|\| true|\|\| exit 0|if: failure\(\)|-- *retry/)
    // The only step that runs after a failure keeps the results, and does not judge anything.
    expect(workflow.match(/if: always\(\)/g)).toHaveLength(1)
  })

  it('signs nothing, sends nothing out, reads no secret, and moves no download address', () => {
    expect(workflow).not.toMatch(/secrets\.|GITHUB_TOKEN|GH_TOKEN|CSC_LINK|CSC_KEY_PASSWORD|WIN_CSC|signtool|certificate|gh release|action-gh-release/i)
    expect(workflow).toMatch(/--publish never/)
    expect(workflow).toMatch(/CSC_IDENTITY_AUTO_DISCOVERY: 'false'/)
    expect(workflow).toMatch(/^permissions: \{\}$/m)
    expect(workflow).not.toMatch(/contents: write/)
    expect(workflow).not.toMatch(/ELECTRON_MIRROR|ELECTRON_BUILDER_BINARIES_MIRROR|ELECTRON_CUSTOM_DIR/i)
  })

  it('keeps the installer as an unsigned check build, under a name that says so, for 14 days', () => {
    const installer = job('installer')
    expect(installer).toMatch(/electron-builder --win nsis --x64 --publish never/)
    expect(installer).toMatch(/\$\{file%\.\*\}-UNSIGNED-check-build\.\$\{file##\*\.\}/)
    expect(installer).toMatch(/name: lucium-win-UNSIGNED-check-build\n\s+path: dist\/\*-UNSIGNED-check-build\.exe\n\s+if-no-files-found: error\n\s+retention-days: 14/)
  })

  it('reads the registry keys that build/installer.nsh writes, after the install and after the uninstall', () => {
    const nsh = read('build/installer.nsh')
    // The keys of the script: the client key and the two ProgIDs.
    expect(nsh).toContain('!define LUCIUM_CLIENT_KEY "Software\\Clients\\StartMenuInternet\\${PRODUCT_NAME}"')
    expect(nsh).toContain('!define LUCIUM_URL_PROGID "LuciumURL"')
    expect(nsh).toContain('"Software\\Classes\\lucium"')
    const installer = job('installer')
    for (const key of ['HKCU:\\Software\\Clients\\StartMenuInternet\\Lucium', 'HKCU:\\Software\\Classes\\LuciumURL', 'HKCU:\\Software\\Classes\\lucium', 'HKCU:\\Software\\RegisteredApplications']) {
      expect(installer.split(key).length - 1, key).toBeGreaterThanOrEqual(2)
    }
    expect(installer).toMatch(/'\/S', '\/currentuser', "\/D=\$dir"/)
    expect(installer).toMatch(/'\/S', "_\?=\$dir"/)
    // Each check throws, so that a missing key fails the step.
    expect(installer.match(/throw /g)?.length).toBeGreaterThanOrEqual(8)
  })

  it('runs the whole Playwright suite, with no list of tests left out here', () => {
    const e2e = job('e2e')
    expect(e2e).toMatch(/run: pnpm exec playwright test$/m)
    expect(e2e).not.toMatch(/--grep|--grep-invert|--ignore|--project|\.spec\.ts/)
  })
})
