// Three supports hand the text of the product to a test: `mainSource()` (index.ts and what it wires), `browserSource()` (the layers of the
// shell) and `engineSource()` (the engine). A test that matches this text proves that a line is written, not that it runs: it passes on a line
// in a dead branch, and fails on a renaming that changes nothing. It is the last resort for a line of wiring nothing can run without Electron.
// The tests that use them are listed here. A new one fails this test: exercise the method on a stand-in (stand-in.test-support.ts) or in an
// engine suite instead. One that no longer reads the source fails it too until its line is removed, so the list only gets shorter.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The tests that read the sources of the shell, of the engine or of the start of the application, on 12 November 2026. The one left is a test of structure by design: that
 * nothing reaches the interface around the publication queue is the absence of a caller, which no run of the code can show.
 */
const KNOWN: readonly string[] = [
  'src/main/shell/publish-queue.test.ts'
]

const READS_SOURCE = /\b(?:mainSource|browserSource|engineSource)\(/

describe('the tests that read the text of the product instead of running it', () => {
  it('are the known ones: none is added, and one that stopped is taken off the list', () => {
    const found = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'src'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0')
      .filter((path) => /\.test\.tsx?$/.test(path) && path !== 'src/main/source-reading-tests.test.ts' && existsSync(join(ROOT, path)) && READS_SOURCE.test(readFileSync(join(ROOT, path), 'utf8')))
      .sort()
    expect(found).toEqual([...KNOWN].sort())
  })
})
