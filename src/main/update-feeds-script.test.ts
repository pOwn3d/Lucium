import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { onWindows } from './windows.test-support'

// The two update channels in scripts/build-drm-release.sh: --update-feed (stable) and --test-feed (test). The script signs with the maintainer's
// identity, builds for two minutes and installs in /Applications, so it is never run whole here. Its first part, the reading and the checks of its
// arguments, is: the text of the script up to the line that starts the build is written into a folder of its own (the root the script finds above
// `scripts/` is that folder, where it looks for the .env files) and run alone. Nothing a guard removed from the script could let through reaches a
// signature, a build or the installation, because none of them is in that part. The order of the checks after the build is read as text, as
// drm-packaging-files.test.ts reads the rest of the script.
const script = readFileSync(fileURLToPath(new URL('../../scripts/build-drm-release.sh', import.meta.url)), 'utf8')
const BUILD_STARTS = '\nAPP="dist-drm/mac-arm64/Lucium.app"'
const argumentsPart = script.slice(0, script.indexOf(BUILD_STARTS))
/** The lines that are not comments, so that a comment cannot pass for code. */
const code = (text: string): string => text.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')

const STABLE = 'https://lucium.app/updates/darwin-arm64/feed.json'
const TEST = 'https://test.lucium.app/updates/darwin-arm64/feed.json'

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** The arguments part of the script, run with `args`, in a folder holding `files`; it prints what electron-vite would receive if it got as far as the build. */
function run(args: string[], files: Record<string, string> = {}, env: Record<string, string> = {}): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'lucium-build-arguments-'))
  folders.push(root)
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'scripts', 'arguments.sh'), `${argumentsPart}\necho "REACHED stable=\${MAIN_VITE_UPDATE_FEED-unset} test=\${MAIN_VITE_UPDATE_FEED_TEST-unset}"\n`)
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text)
  const result = spawnSync('bash', [join(root, 'scripts', 'arguments.sh'), ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root, ...env } })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

// Each check runs the shell script of the build, several times: seconds when the whole suite shares the machine.
const SCRIPT_RUNS = { timeout: 30_000 }

// Windows: this runs the bash script of the build, the maintainer's release tooling, on the maintainer's Mac (docs/community/release-process.md).
describe.skipIf(onWindows)('the part of build-drm-release.sh that is run here', SCRIPT_RUNS, () => {
  it('stops before anything is built, signed or installed', () => {
    expect(script).toContain(BUILD_STARTS)
    const executed = code(argumentsPart)
    for (const later of ['package-drm.mjs', 'codesign', 'notarytool submit', 'security find-identity', 'ditto', '/Applications']) expect(executed, later).not.toContain(later)
    expect(run([]).output).toBe('REACHED stable=unset test=unset\n')
  })
})

// Windows: same as above, the bash script of the build is the maintainer's release tooling.
describe.skipIf(onWindows)('--test-feed: the test channel sealed beside the stable one', SCRIPT_RUNS, () => {
  it('hands both addresses to electron-vite, whichever way they are written', () => {
    expect(run(['--update-feed', STABLE, '--test-feed', TEST])).toEqual({ status: 0, output: `REACHED stable=${STABLE} test=${TEST}\n` })
    expect(run([`--update-feed=${STABLE}`, `--test-feed=${TEST}`])).toEqual({ status: 0, output: `REACHED stable=${STABLE} test=${TEST}\n` })
    expect(run(['--test-feed', TEST, '--update-feed', STABLE, '--no-install', '--notarize'], {}, { LUCIUM_NOTARY_PROFILE: 'profil' }).output).toBe(`REACHED stable=${STABLE} test=${TEST}\n`)
  })

  it('leaves a build with the stable address alone as it was: no test address is handed on', () => {
    expect(run(['--update-feed', STABLE])).toEqual({ status: 0, output: `REACHED stable=${STABLE} test=unset\n` })
  })

  it('takes both addresses from its options only: what the shell holds is cleared, for either one', () => {
    const shell = { MAIN_VITE_UPDATE_FEED: 'https://shell.example/feed.json', MAIN_VITE_UPDATE_FEED_TEST: 'https://shell.example/test.json' }
    expect(run([], {}, shell).output).toBe('REACHED stable=unset test=unset\n')
    expect(run(['--update-feed', STABLE], {}, shell).output).toBe(`REACHED stable=${STABLE} test=unset\n`)
    expect(run(['--update-feed', STABLE, '--test-feed', TEST], {}, shell).output).toBe(`REACHED stable=${STABLE} test=${TEST}\n`)
  })

  it('refuses an address that is not one plain https address, as --update-feed does, before the build', () => {
    const bad = ['http://test.lucium.app/feed.json', 'https://bad host/feed.json', `${TEST}?token=1`, `${TEST}#top`, 'https://test.lucium.app', 'ftp://test.lucium.app/feed.json', '"https://test.lucium.app/feed.json"', `https://test.lucium.app/${'a'.repeat(500)}`]
    for (const address of bad) {
      for (const args of [['--update-feed', STABLE, '--test-feed', address], ['--update-feed', STABLE, `--test-feed=${address}`]]) {
        const result = run(args)
        expect(result.status, address).toBe(2)
        expect(result.output, address).not.toContain('REACHED')
        expect(result.output, address).toContain('--test-feed takes one plain https address')
      }
    }
  })

  it('refuses a test address given without a value', () => {
    const result = run(['--update-feed', STABLE, '--test-feed'])
    expect(result.status).toBe(2)
    expect(result.output).toContain('--test-feed needs an address')
  })

  it('refuses a test address without the stable one: a build follows the stable channel by default, and would have none', () => {
    const result = run(['--test-feed', TEST])
    expect(result.status).toBe(2)
    expect(result.output).toContain('--test-feed needs --update-feed too')
    expect(result.output).not.toContain('REACHED')
  })

  it('refuses both addresses with --original-fuses, as the stable one is: every build a feed reaches keeps castLabs\' set', () => {
    for (const args of [['--original-fuses', '--update-feed', STABLE, '--test-feed', TEST], ['--original-fuses', '--test-feed', TEST]]) {
      const result = run(args)
      expect(result.status, args.join(' ')).toBe(2)
      expect(result.output, args.join(' ')).not.toContain('REACHED')
    }
  })

  it('refuses a project whose .env file sets either address, in any file Vite reads for a build, with or without `export`', () => {
    for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
      for (const line of ['MAIN_VITE_UPDATE_FEED_TEST=https://evil.example/feed.json', 'export MAIN_VITE_UPDATE_FEED_TEST=https://evil.example/feed.json', '  MAIN_VITE_UPDATE_FEED=https://evil.example/feed.json']) {
        const result = run(['--update-feed', STABLE, '--test-feed', TEST], { [name]: `OTHER=1\n${line}\n` })
        expect(result.status, `${name}: ${line}`).toBe(2)
        expect(result.output, `${name}: ${line}`).toContain('sets MAIN_VITE_UPDATE_FEED or MAIN_VITE_UPDATE_FEED_TEST')
        expect(result.output, `${name}: ${line}`).not.toContain('REACHED')
      }
    }
    // A comment, or another variable, sets nothing.
    expect(run(['--update-feed', STABLE], { '.env': '# MAIN_VITE_UPDATE_FEED_TEST=https://evil.example/feed.json\nMAIN_VITE_OTHER=1\n' }).status).toBe(0)
  })

  it('names --test-feed among the options it knows when it meets one it does not', () => {
    const result = run(['--nothing'])
    expect(result.status).toBe(2)
    expect(result.output).toContain('--test-feed <https address>')
  })
})

describe('--test-feed, after the build', SCRIPT_RUNS, () => {
  const executed = code(script)
  const stops = (at: number): string => executed.slice(at).split('\n').slice(0, 3).join('\n')

  it('checks that the test address is in app.asar too, before anything is notarized or installed, and stops at once if it is not', () => {
    const build = executed.indexOf('node scripts/package-drm.mjs')
    const inAsar = executed.indexOf('LC_ALL=C grep -a -q -F -- "$TEST_FEED" "$APP/Contents/Resources/app.asar"')
    expect(inAsar).toBeGreaterThan(build)
    expect(inAsar).toBeLessThan(executed.indexOf('xcrun notarytool submit'))
    expect(inAsar).toBeLessThan(executed.indexOf('ditto "$APP" /Applications/Lucium.app'))
    expect(executed.slice(inAsar).split('\n').slice(0, 3).join('\n')).toMatch(/MAIN_VITE_UPDATE_FEED_TEST[\s\S]*exit 1/)
    // The stable address keeps its own check.
    expect(stops(executed.indexOf('LC_ALL=C grep -a -q -F -- "$UPDATE_FEED" "$APP/Contents/Resources/app.asar"'))).toMatch(/exit 1|MAIN_VITE_UPDATE_FEED\. Nothing is installed/)
  })

  it('tells the maintainer how to write the release file of each channel after a notarized build', () => {
    expect(script).toContain('node scripts/make-update-feed.mjs $ARCHIVE ${UPDATE_FEED%/*}/ > dist-drm/feed.json')
    // The line for the test channel is said only for a build that carries one.
    expect(script).toContain('if [ -n "$TEST_FEED" ]; then echo "   The release file of the test feed: node scripts/make-update-feed.mjs $ARCHIVE ${TEST_FEED%/*}/ > dist-drm/feed-test.json"; fi')
  })
})
