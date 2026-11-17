// `pnpm test:coverage` measures which lines of the product the unit tests run. Two things break it without a word: the provider at another
// version than vitest (they are released together and refuse each other), and a measure that counts the tests or the engine suites as product,
// which moves the figure without any line being more or less tested.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import config from '../../vitest.config.mjs'

const require = createRequire(import.meta.url)
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const installed = (name: string): string => (JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as { version: string }).version
const manifest = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as { scripts: Record<string, string>; devDependencies: Record<string, string> }

/** Whether a glob of the configuration (`**`, `*`, `{a,b}`) matches a path. */
function matches(glob: string, path: string): boolean {
  const pattern = glob
    .replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\{([^}]*)\}/g, (_all, list: string) => `(?:${list.split(',').join('|')})`)
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*')
  return new RegExp(`^${pattern}$`).test(path)
}

describe('the measure of coverage', () => {
  const coverage = config.test?.coverage as { provider: string; include: string[]; exclude: string[]; thresholds?: unknown }
  const measured = (path: string): boolean => coverage.include.some((glob) => matches(glob, path)) && !coverage.exclude.some((glob) => matches(glob, path))

  it('has its provider installed at the version of vitest, and a command to run it', () => {
    expect(coverage.provider).toBe('v8')
    expect(installed('@vitest/coverage-v8')).toBe(installed('vitest'))
    expect(manifest.scripts['test:coverage']).toBe('vitest run --coverage')
  })

  it('counts the product, in every process', () => {
    for (const path of ['src/main/index.ts', 'src/main/shell/lock-ipc.ts', 'src/main/engine/electron-page.ts', 'src/shared/url.ts', 'src/preload/media-bridge.ts', 'src/renderer/Sidebar.tsx']) expect(measured(path), path).toBe(true)
  })

  it('counts neither the tests, their supports, the engine suites nor the code of other projects', () => {
    for (const path of [
      'src/shared/url.test.ts',
      'src/renderer/render.test-support.ts',
      'src/shared/page-annotate-test-support.ts',
      'src/main/smoke.ts',
      'src/main/smoke-sec1.ts',
      'src/main/translate/vendor/bergamot/glue.ts',
      'src/renderer/env.d.ts',
      'scripts/perf.mjs',
      'tests/e2e/tabs.spec.ts'
    ]) {
      expect(measured(path), path).toBe(false)
    }
  })

  it('has no threshold: the figure finds the code nothing runs, it is not a mark to reach', () => {
    expect(coverage.thresholds).toBeUndefined()
  })
})
