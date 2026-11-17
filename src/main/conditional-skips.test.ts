// A test that is skipped shows as a pass. This one keeps the count of what may be skipped: no test is switched off for good (`.skip`, `.todo`,
// `.fails`, `fixme`) or left alone to run (`.only`), and a test skipped under a condition (`skipIf`, `runIf`, Playwright's `test.skip(cond)`)
// is listed here with what it waits for. A new one fails this test until its line and its reason are written; one that went away fails it too.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** The tests that run only under a condition: how many in each file, and what the condition is. */
const CONDITIONAL: Readonly<Record<string, { count: number; waitsFor: string }>> = {
  'scripts/notices/shipped-notices.test.ts': { count: 1, waitsFor: 'Windows excluded: the modes of a Linux package are POSIX modes, which Windows does not keep' },
  'scripts/site-captures/features.test.ts': { count: 1, waitsFor: 'the repository of the site next to this one: absent on a runner' },
  'src/main/backup-store.test.ts': { count: 3, waitsFor: 'Windows, where chmod refuses nothing (it only sets the read-only flag)' },
  'src/main/bench-script.test.ts': { count: 4, waitsFor: 'macOS (the browsers it compares are applications of macOS)' },
  'src/main/blocking/list-store.test.ts': { count: 2, waitsFor: 'Windows: no file mode to read (nothing is narrowed, nothing is told)' },
  'src/main/blocking/service-lifecycle.test.ts': { count: 2, waitsFor: 'a user who is not root (root reads a file whose rights were taken away), and not Windows (chmod refuses nothing there)' },
  'src/main/chromium-switches.test.ts': { count: 1, waitsFor: 'the binary of the engine (macOS): the package may be installed without it' },
  'src/main/engine/storage-hosts.test.ts': { count: 1, waitsFor: 'Windows: chmod 000 does not make a folder unlistable there' },
  'src/main/engine/strict-transport-store.test.ts': { count: 3, waitsFor: 'Windows: chmod 500 does not make a folder refuse a file there' },
  'src/main/engine/web-store.test.ts': { count: 2, waitsFor: 'Windows: a path under a file is reported as not found (not ENOTDIR), and chmod 500 refuses nothing' },
  'src/main/feed-key-build.test.ts': { count: 1, waitsFor: 'Windows excluded: the bash script of the build with a shell stand-in is the maintainer\'s release tooling, run on the maintainer\'s Mac' },
  'src/main/helper-signature.test.ts': { count: 1, waitsFor: 'macOS and its codesign' },
  'src/main/homebrew-cask.test.ts': { count: 2, waitsFor: 'Windows excluded: the script writes the cask of a macOS disk image from the maintainer\'s Mac' },
  'src/main/importers/import-flow.test.ts': { count: 1, waitsFor: 'Windows: a named pipe is made with mkfifo, which Windows does not have' },
  'src/main/importers/service.test.ts': { count: 4, waitsFor: 'macOS and its plutil (one), and Windows excluded for the three that refuse a file with chmod 000' },
  'src/main/importers/sqlite.test.ts': { count: 2, waitsFor: 'Windows: a named pipe is made with mkfifo, which Windows does not have' },
  'src/main/make-dmg.test.ts': { count: 1, waitsFor: 'Windows: shasum is a tool of macOS, where the maker of the image runs' },
  'src/main/password-vault-attempts.test.ts': { count: 1, waitsFor: 'Windows: a link needs a privilege there, and a link to itself is not sure to come back as ELOOP' },
  'src/main/perf-script.test.ts': { count: 3, waitsFor: 'a system with ps, then macOS for the real process tree, and not Windows (the script refuses to measure there)' },
  'src/main/prune-app-backups.test.ts': { count: 1, waitsFor: 'Windows excluded: a bash script of the maintainer\'s release tooling, on the maintainer\'s Mac' },
  'src/main/public-export.test.ts': { count: 2, waitsFor: 'gitleaks installed on the machine, and Windows excluded (the export of the public tree is the maintainer\'s release tooling, run on the maintainer\'s Mac)' },
  'src/main/publish-update-reads.test.ts': { count: 1, waitsFor: 'a user other than root, for whom a folder in mode 000 is really closed, and not Windows' },
  'src/main/shell/app-icon.test.ts': { count: 2, waitsFor: 'a user who is not root (root writes a bundle whose rights were taken away), and not Windows (a file named Icon plus a carriage return is forbidden there)' },
  'src/main/shell/backups.test.ts': { count: 2, waitsFor: 'Windows: chmod 500 does not make a folder refuse a new file there' },
  'src/main/shell/bookmarks-export.test.ts': { count: 1, waitsFor: 'Windows: chmod 555 does not make a folder refuse a new file there' },
  'src/main/shell/bounded-file.test.ts': { count: 2, waitsFor: 'a user who is not root, and not Windows (no mkfifo, no /dev/zero, chmod 000 refuses nothing)' },
  'src/main/shell/bundle-icon.test.ts': { count: 1, waitsFor: 'macOS, its osascript and its codesign (the real script on a throw-away bundle)' },
  'src/main/shell/extension-patch.test.ts': { count: 4, waitsFor: 'the patched library: a test of the same file fails when it is not installed, so these four are never skipped unseen' },
  'src/main/shell/native-messaging-registry.test.ts': { count: 1, waitsFor: 'Windows only: the real reg.exe of the system and a key under the user\'s root (the registry exists nowhere else)' },
  'src/main/shell/quit-clear.test.ts': { count: 1, waitsFor: 'Windows: chmod 500 does not make a folder refuse a new file there' },
  'src/main/shell/space-image-sweep.test.ts': { count: 1, waitsFor: 'Windows: chmod 000 does not make a file unreadable there' },
  'src/main/translate/system-stream.test.ts': { count: 1, waitsFor: 'Windows: the stand-in of the macOS helper is a script run by /bin/sh, which Windows cannot start' },
  'src/main/translate/system.test.ts': { count: 1, waitsFor: 'Windows: the stand-in of the macOS helper is a script run by /bin/sh, which Windows cannot start' },
  'src/main/translate/translate.test.ts': { count: 1, waitsFor: 'a user who is not root' },
  'src/main/update-feed-signature.test.ts': { count: 1, waitsFor: 'Windows: chmod changes no bit there and the mode it reports (666) is not read' },
  'src/main/update-feeds-script.test.ts': { count: 2, waitsFor: 'Windows excluded: the bash script of the build is the maintainer\'s release tooling, run on the maintainer\'s Mac' },
  'src/main/vault-keychain.test.ts': { count: 1, waitsFor: 'macOS on Apple silicon, and the addon built (pnpm build:keychain)' },
  'src/main/verify-app.test.ts': { count: 2, waitsFor: 'macOS and its /usr/bin/plutil, which the script calls by that path (the whole run of scripts/verify-app.mjs on a package), and not Windows (a file named Icon plus a carriage return is forbidden there)' },
  'src/main/workflow-hygiene.test.ts': { count: 1, waitsFor: 'a system with a POSIX shell' },
  'tests/e2e/settings.spec.ts': { count: 1, waitsFor: 'macOS: the reference pictures of the Settings are those of the macOS runner, none is kept for Linux or Windows' },
  'tests/e2e/tabs-effects.spec.ts': { count: 1, waitsFor: 'not Windows: the disposition of the ⌥⌘-click was measured on macOS only' }
}

const CONDITION = /\.(?:skipIf|runIf)\(|\btest\.skip\(\s*[^'"`\s)]/g
const SWITCHED_OFF = /\b(?:it|test|describe|suite|bench)(?:\.\w+)*\.(?:only|todo|fails|skip|fixme)\b(?!\(\s*[^'"`\s)])/g

/** How many tests of a source are skipped under a condition. */
const conditionalSkips = (source: string): number => (source.match(CONDITION) ?? []).length
/** The tests of a source that are switched off, or that switch the others off. */
const switchedOff = (source: string): string[] => source.match(SWITCHED_OFF) ?? []

function testFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'src', 'scripts', 'tests'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((path) => /\.(test|spec)\.tsx?$/.test(path) && path !== 'src/main/conditional-skips.test.ts' && existsSync(join(ROOT, path)))
}

describe('the tests that do not always run', () => {
  const sources = Object.fromEntries(testFiles().map((path) => [path, readFileSync(join(ROOT, path), 'utf8')]))

  it('are the listed ones, each with what it waits for', () => {
    const found = Object.fromEntries(Object.entries(sources).flatMap(([path, source]) => (conditionalSkips(source) > 0 ? [[path, conditionalSkips(source)]] : [])))
    expect(found).toEqual(Object.fromEntries(Object.entries(CONDITIONAL).map(([path, entry]) => [path, entry.count])))
    for (const [path, entry] of Object.entries(CONDITIONAL)) expect(entry.waitsFor.length, path).toBeGreaterThan(10)
  })

  it('has no test switched off for good, and none that runs alone', () => {
    expect(Object.entries(sources).flatMap(([path, source]) => switchedOff(source).map((found) => `${path}: ${found}`))).toEqual([])
  })

  it('counts a condition of vitest and of Playwright, and not a word in a title', () => {
    expect(conditionalSkips("it.skipIf(!onMac)('a', () => {})\ndescribe.runIf(mac)('b', () => {})\ntest.skip(!process.env.X, 'no X')")).toBe(3)
    expect(conditionalSkips("it('is skipped until pnpm install (skipIf) is run', () => {})\nit('b', () => { test.skip() })")).toBe(0)
  })

  it('finds every way to switch a test off or to run it alone', () => {
    expect(switchedOff("it.only('a')\ndescribe.skip('b')\ntest.todo('c')\nit.fails('d')\ntest.fixme('e')\ntest.describe.only('f')\ntest.skip('g', async () => {})\ntest.skip()")).toEqual([
      'it.only',
      'describe.skip',
      'test.todo',
      'it.fails',
      'test.fixme',
      'test.describe.only',
      'test.skip',
      'test.skip'
    ])
    expect(switchedOff("it.skipIf(a)('b')\ntest.skip(!ready, 'not ready')\nconst only = list.only\nit('skips nothing', () => {})")).toEqual([])
  })
})
