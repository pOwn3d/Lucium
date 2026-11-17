// The engine test builds the main process with the names of its functions and classes kept (LUCIUM_KEEP_NAMES=1, set by `pnpm test:engine`): the zero-cost
// checks of src/main/smoke-features.ts tell which code made a timer or a subscription by those names, and a minified bundle renames them (the run of
// 10 November 2026 lost 19 checks that way). The bundle that ships keeps the shape it has: minified, with its names mangled.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The check of the .env files for an update feed is not what is looked at here (update-feed-env.test.ts does that).
vi.mock('./platform/update-feed-env', () => ({ envFilesSettingFeed: () => [] }))

interface MainBuild {
  main: { build: { minify: boolean; rolldownOptions: { output: { keepNames: boolean } } } }
}
const mainBuild = async (): Promise<MainBuild['main']['build']> => {
  const config = (await import('../../electron.vite.config')).default as unknown as (env: { mode: string; command: string }) => MainBuild
  return config({ mode: 'production', command: 'build' }).main.build
}

afterEach(() => vi.unstubAllEnvs())

describe('the build of the main process', () => {
  it('ships minified with its names mangled, unless the engine test asks for them', async () => {
    vi.stubEnv('LUCIUM_KEEP_NAMES', '')
    const build = await mainBuild()
    expect(build.minify).toBe(true)
    expect(build.rolldownOptions.output.keepNames).toBe(false)
  })

  it('keeps the names of its functions and classes, still minified, with LUCIUM_KEEP_NAMES=1', async () => {
    vi.stubEnv('LUCIUM_KEEP_NAMES', '1')
    const build = await mainBuild()
    expect(build.rolldownOptions.output.keepNames).toBe(true)
    expect(build.minify).toBe(true)
  })

  it('keeps nothing for any other value of the variable', async () => {
    for (const value of ['0', 'true', 'yes']) {
      vi.stubEnv('LUCIUM_KEEP_NAMES', value)
      expect((await mainBuild()).rolldownOptions.output.keepNames).toBe(false)
    }
  })

  it('is the one `pnpm test:engine` runs before the engine test', () => {
    const scripts = (JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    expect(scripts['test:engine']).toMatch(/^LUCIUM_KEEP_NAMES=1 electron-vite build && /)
  })
})
