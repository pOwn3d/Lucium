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
  'scripts/site-captures/features.test.ts': { count: 1, waitsFor: 'the repository of the site next to this one: absent on a runner' },
  'src/main/bench-script.test.ts': { count: 4, waitsFor: 'macOS (the browsers it compares are applications of macOS)' },
  'src/main/blocking/service-lifecycle.test.ts': { count: 2, waitsFor: 'a user who is not root: root reads a file whose rights were taken away' },
  'src/main/chromium-switches.test.ts': { count: 1, waitsFor: 'the binary of the engine (macOS): the package may be installed without it' },
  'src/main/helper-signature.test.ts': { count: 1, waitsFor: 'macOS and its codesign' },
  'src/main/importers/service.test.ts': { count: 1, waitsFor: 'macOS and its plutil' },
  'src/main/perf-script.test.ts': { count: 2, waitsFor: 'a system with ps, then macOS for the real process tree' },
  'src/main/public-export.test.ts': { count: 1, waitsFor: 'gitleaks installed on the machine' },
  'src/main/publish-update-reads.test.ts': { count: 1, waitsFor: 'a user other than root, for whom a folder in mode 000 is really closed' },
  'src/main/shell/app-icon.test.ts': { count: 1, waitsFor: 'a user who is not root: root writes a bundle whose rights were taken away' },
  'src/main/shell/bounded-file.test.ts': { count: 1, waitsFor: 'a user who is not root' },
  'src/main/shell/bundle-icon.test.ts': { count: 1, waitsFor: 'macOS, its osascript and its codesign (the real script on a throw-away bundle)' },
  'src/main/shell/extension-patch.test.ts': { count: 4, waitsFor: 'the patched library: a test of the same file fails when it is not installed, so these four are never skipped unseen' },
  'src/main/translate/translate.test.ts': { count: 1, waitsFor: 'a user who is not root' },
  'src/main/vault-keychain.test.ts': { count: 1, waitsFor: 'macOS on Apple silicon, and the addon built (pnpm build:keychain)' },
  'src/main/verify-app.test.ts': { count: 1, waitsFor: 'macOS and its /usr/bin/plutil, which the script calls by that path (the whole run of scripts/verify-app.mjs on a package)' },
  'src/main/workflow-hygiene.test.ts': { count: 1, waitsFor: 'a system with a POSIX shell' }
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
