import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { appFilesFor, fakeRoot, REPO, scriptOf, wholeListsFolder, type FakeRoot } from './test-support'

// scripts/ios-archive.sh signs and sends: it is the maintainer's alone (AGENTS.md, section 7). These tests never run it in the repository. Each one runs a
// copy of it in a temporary root, with stand-ins for xcodebuild, xcodegen and plutil first on the PATH: what the script does, or stops doing when a guard
// is removed, reaches a log file and nothing else.

// A shell script and POSIX stand-ins: the Windows runner has no such PATH (its separator is `;`) and nothing here is run there by anyone. The pure modules are tested everywhere.
const shell = describe.skipIf(process.platform === 'win32')

const roots: FakeRoot[] = []
afterAll(() => {
  for (const { root } of roots) rmSync(root, { recursive: true, force: true })
})

interface Run {
  status: number | null
  stdout: string
  stderr: string
  /** The commands the stand-ins were asked to run, in order. */
  commands: string[]
  root: FakeRoot
}

function run(lists: Record<string, string> | null, args: string[], env: Record<string, string> = {}, prepare: (root: FakeRoot) => void = () => undefined): Run {
  const root = fakeRoot(lists)
  roots.push(root)
  prepare(root)
  const clean = { ...process.env }
  delete clean.LUCIUM_IOS_TEAM
  delete clean.LUCIUM_IOS_OUT
  const result = spawnSync('bash', [scriptOf(root.root), ...args], {
    encoding: 'utf8',
    cwd: root.root,
    env: { ...clean, ...env, PATH: `${root.bin}:${process.env.PATH ?? ''}`, STUB_LOG: root.log, LUCIUM_IOS_OUT: join(root.root, 'out') },
    timeout: 60_000
  })
  const commands = existsSync(root.log) ? readFileSync(root.log, 'utf8').trim().split('\n') : []
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, commands, root }
}

const lists = wholeListsFolder()
const whole = { STUB_APP_FILES: appFilesFor(lists) }

shell('scripts/ios-archive.sh refuses to archive without the filter lists (docs/ios.md, section 6.3)', () => {
  it('starts nothing at all on a checkout where the lists were never prepared, and says how to prepare them', () => {
    const result = run(null, ['--build', '1000'], whole)
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/REFUSED/)
    expect(result.stderr).toMatch(/filter-lists-registry\.json is missing/)
    expect(result.stderr).toMatch(/node scripts\/ios-filter-lists\.mjs/)
    // Neither the project generator nor Xcode was asked for anything.
    expect(result.commands).toEqual([])
    expect(result.stdout).not.toMatch(/== (Build|Xcode project|Archive)/)
  })

  it('refuses a folder that holds some of the lists only, and one whose file was cut', () => {
    const partial = run(wholeListsFolder(['easylist']), ['--build', '1000'], whole)
    expect(partial.status).toBe(1)
    expect(partial.stderr).toMatch(/the list easyprivacy is not in the registry/)
    expect(partial.commands).toEqual([])
    const cut = { ...lists, 'easylist.network.json': '[]' }
    const result = run(cut, ['--build', '1000'], whole)
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/easylist\.network\.json is not the file the registry describes/)
    expect(result.commands).toEqual([])
  })

  it('refuses a checkout that lost the page guard, which is committed', () => {
    const result = run(lists, ['--build', '1000'], whole, ({ root }) => rmSync(join(root, 'ios/Lucium/Guard/guard-runtime.js')))
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/guard-runtime\.js is missing: run node scripts\/ios-guard\.mjs/)
    expect(result.commands).toEqual([])
  })

  it('refuses in a dry run too, and a dry run starts nothing in any case', () => {
    const refused = run(null, ['--dry-run'], whole)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toMatch(/REFUSED/)
    const dry = run(lists, ['--dry-run'], whole)
    expect(dry.status).toBe(0)
    expect(dry.commands).toEqual([])
  })

  it('refuses an archive whose application does not carry the lists, and exports nothing', () => {
    const files = Object.keys(lists).filter((name) => name !== 'filter-lists-registry.json').concat('guard-runtime.js', 'guard-rules.json')
    const result = run(lists, ['--build', '1000'], { STUB_APP_FILES: files.join(' ') })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/does not carry filter-lists-registry\.json/)
    expect(result.commands.some((command) => command.startsWith('xcodebuild archive'))).toBe(true)
    expect(result.commands.some((command) => command.includes('-exportArchive'))).toBe(false)
  })
})

shell('scripts/ios-archive.sh archives, exports and sends', () => {
  it('runs the steps in order, with the team, the build number and the permission to talk to Apple, and sends', () => {
    const result = run(lists, ['--build', '1234'], whole)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const [generate, archive, exported] = result.commands
    expect(result.commands).toHaveLength(3)
    expect(generate).toBe('xcodegen generate')
    expect(archive).toMatch(/^xcodebuild archive /)
    for (const argument of ['-scheme Lucium', '-configuration Release', '-destination generic/platform=iOS', '-allowProvisioningUpdates', 'DEVELOPMENT_TEAM=9A9AUX9UHT', 'CURRENT_PROJECT_VERSION=1234', 'CODE_SIGN_STYLE=Automatic', `-archivePath ${join(result.root.root, 'out/Lucium-1234.xcarchive')}`]) {
      expect(archive).toContain(argument)
    }
    expect(exported).toMatch(/^xcodebuild -exportArchive /)
    for (const argument of ['-allowProvisioningUpdates', `-archivePath ${join(result.root.root, 'out/Lucium-1234.xcarchive')}`, `-exportOptionsPlist ${join(result.root.root, 'out/ExportOptions-1234.plist')}`]) {
      expect(exported).toContain(argument)
    }
    const plist = readFileSync(join(result.root.root, 'out/ExportOptions-1234.plist'), 'utf8')
    expect(plist).toContain('<key>method</key>\n\t<string>app-store-connect</string>')
    expect(plist).toContain('<key>destination</key>\n\t<string>upload</string>')
    expect(plist).toContain('<key>teamID</key>\n\t<string>9A9AUX9UHT</string>')
    expect(plist).toContain('<key>testFlightInternalTestingOnly</key>\n\t<true/>')
    expect(result.stdout).toMatch(/build 1234 was handed to App Store Connect/)
    expect(result.stdout).toMatch(/internal TestFlight only/)
  })

  it('only exports with --export-only: the destination is export and the message says nothing is sent', () => {
    const result = run(lists, ['--build', '1234', '--export-only'], whole)
    expect(result.status).toBe(0)
    expect(readFileSync(join(result.root.root, 'out/ExportOptions-1234.plist'), 'utf8')).toContain('<key>destination</key>\n\t<string>export</string>')
    expect(result.stdout).toMatch(/Nothing was sent/)
    expect(readdirSync(join(result.root.root, 'out/export-1234'))).toEqual(['Lucium.ipa'])
  })

  it('lets external testers in only when asked to', () => {
    const result = run(lists, ['--build', '1234', '--allow-external'], whole)
    expect(readFileSync(join(result.root.root, 'out/ExportOptions-1234.plist'), 'utf8')).not.toContain('testFlightInternalTestingOnly')
    expect(result.stdout).toMatch(/internal AND external TestFlight/)
  })

  it('takes the team from LUCIUM_IOS_TEAM or --team, and refuses what is not a team', () => {
    expect(run(lists, ['--build', '1234'], { ...whole, LUCIUM_IOS_TEAM: 'ABCDE12345' }).commands[1]).toContain('DEVELOPMENT_TEAM=ABCDE12345')
    expect(run(lists, ['--build', '1234', '--team', 'ZZZZZ99999'], whole).commands[1]).toContain('DEVELOPMENT_TEAM=ZZZZZ99999')
    const refused = run(lists, ['--build', '1234', '--team', 'not-a-team'], whole)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toMatch(/is not an Apple team identifier/)
    expect(refused.commands).toEqual([])
  })

  it('makes a build number from the clock when none is given, and refuses one that is not a number', () => {
    const result = run(lists, [], whole)
    expect(result.status).toBe(0)
    const build = /CURRENT_PROJECT_VERSION=(\d+)/.exec(result.commands[1]!)![1]!
    // After 18 November 2026 (462 000 minutes into the year) and never a date-shaped number.
    expect(Number(build)).toBeGreaterThan(462_000)
    expect(result.stdout).toContain(`build ${build}`)
    const refused = run(lists, ['--build', '007'], whole)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toMatch(/is not a whole number/)
    expect(refused.commands).toEqual([])
  })

  it('names the application after the project file, which is the one place the identifier is written', () => {
    const project = readFileSync(join(REPO, 'ios/project.yml'), 'utf8')
    const id = /^\s*PRODUCT_BUNDLE_IDENTIFIER: (app\.lucium\.browser\.ios)$/m.exec(project)![1]!
    expect(run(lists, ['--dry-run'], whole).stdout).toContain(`application   ${id},`)
  })

  it('shows what it would do on a dry run, and only that', () => {
    const result = run(lists, ['--dry-run', '--build', '1234'], whole)
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/would run: xcodegen generate/)
    expect(result.stdout).toMatch(/would run: xcodebuild archive .*CURRENT_PROJECT_VERSION=1234/)
    expect(result.stdout).toMatch(/would run: xcodebuild -exportArchive/)
    expect(result.stdout).toMatch(/Dry run: nothing was built, signed or sent/)
    expect(existsSync(join(result.root.root, 'out'))).toBe(false)
  })
})

shell('scripts/ios-archive.sh stops, and says why, when a step fails', () => {
  it('stops when the archive fails: nothing is exported, and the message says where to look', () => {
    const result = run(lists, ['--build', '1234'], { ...whole, STUB_FAIL: 'archive' })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/the archive failed, so nothing was exported or sent/)
    expect(result.stderr).toMatch(/Settings > Accounts/)
    expect(result.stderr).toContain('archive-1234.log')
    expect(result.commands.some((command) => command.includes('-exportArchive'))).toBe(false)
  })

  it('refuses to export an archive that has another build number than the one asked for', () => {
    const result = run(lists, ['--build', '1234'], { ...whole, STUB_ARCHIVE_BUILD: '1' })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/the archive has the build number 1, not 1234/)
    expect(result.stderr).toMatch(/Nothing left this Mac/)
    expect(result.commands.some((command) => command.includes('-exportArchive'))).toBe(false)
  })

  it('says what to look at when the export fails, and does not claim it was sent', () => {
    const result = run(lists, ['--build', '1234'], { ...whole, STUB_FAIL: 'export' })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/the export failed/)
    expect(result.stderr).toMatch(/--build <a larger number>/)
    expect(result.stderr).toMatch(/App Store Connect > Apps > Lucium > TestFlight/)
    expect(result.stdout).not.toMatch(/handed to App Store Connect/)
  })
})

describe('what the script says about itself matches the repository', () => {
  const script = readFileSync(join(REPO, 'scripts/ios-archive.sh'), 'utf8')
  it('uses the team the documentation gives for the project', () => {
    const team = /^default_team="([A-Z0-9]{10})"$/m.exec(script)![1]!
    expect(readFileSync(join(REPO, 'docs/ios.md'), 'utf8')).toContain(`\`${team}\``)
  })
  it('is executable, like the other scripts of the iOS application', () => {
    const mode = spawnSync('git', ['ls-files', '-s', 'scripts/ios-archive.sh'], { cwd: REPO, encoding: 'utf8' }).stdout
    // Not yet added to the index in a fresh working tree: only a file Git knows has a mode to check.
    if (mode.trim() !== '') expect(mode.startsWith('100755')).toBe(true)
  })
})
