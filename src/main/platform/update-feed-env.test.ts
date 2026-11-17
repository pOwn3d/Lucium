// A .env file that sets MAIN_VITE_UPDATE_FEED (the stable address) or MAIN_VITE_UPDATE_FEED_TEST (the test one) stops every production build,
// not only scripts/build-drm-release.sh (update-feed-env.ts).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRODUCTION_ENV_FILES } from './update-feed-env'

const found = vi.hoisted(() => ({ files: [] as string[] }))
// The configuration is run with the files it would find stood in for: the real reading is tested on a folder of its own below.
vi.mock('./update-feed-env', async (original) => ({ ...(await original<typeof import('./update-feed-env')>()), envFilesSettingFeed: () => found.files }))

let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
  found.files = []
})

describe('the .env files that set the address of an update feed', () => {
  it('are found by the same test as build-drm-release.sh, `export` or not, and a missing file sets nothing', async () => {
    const { envFilesSettingFeed: real } = await vi.importActual<typeof import('./update-feed-env')>('./update-feed-env')
    dir = mkdtempSync(join(tmpdir(), 'lucium-env-'))
    expect(real(dir)).toEqual([])
    writeFileSync(join(dir, '.env'), 'OTHER=1\n# MAIN_VITE_UPDATE_FEED=commented\n')
    writeFileSync(join(dir, '.env.local'), 'A=1\n  export MAIN_VITE_UPDATE_FEED=https://evil.example/feed.json\n')
    writeFileSync(join(dir, '.env.production'), 'MAIN_VITE_UPDATE_FEED=https://evil.example/feed.json\n')
    writeFileSync(join(dir, '.env.development'), 'MAIN_VITE_UPDATE_FEED=https://dev.example/feed.json\n')
    expect(real(dir)).toEqual(['.env.local', '.env.production'])
    expect(PRODUCTION_ENV_FILES).toEqual(['.env', '.env.local', '.env.production', '.env.production.local'])
  })

  it('include the test address: a file that sets MAIN_VITE_UPDATE_FEED_TEST alone is found too (a word boundary after the name would let it through)', async () => {
    const { envFilesSettingFeed: real } = await vi.importActual<typeof import('./update-feed-env')>('./update-feed-env')
    dir = mkdtempSync(join(tmpdir(), 'lucium-env-'))
    writeFileSync(join(dir, '.env'), 'MAIN_VITE_UPDATE_FEED_TEST=https://evil.example/feed.json\n')
    writeFileSync(join(dir, '.env.local'), 'A=1\nexport MAIN_VITE_UPDATE_FEED_TEST=https://evil.example/feed.json\n')
    writeFileSync(join(dir, '.env.production.local'), '# MAIN_VITE_UPDATE_FEED_TEST=commented\nMAIN_VITE_OTHER=1\n')
    expect(real(dir)).toEqual(['.env', '.env.local'])
  })

  it('stop a production build of electron.vite.config.ts, and leave the development server alone', async () => {
    const config = (await import('../../../electron.vite.config')).default as unknown as (env: { mode: string; command: string }) => unknown
    found.files = []
    expect(config({ mode: 'production', command: 'build' })).toHaveProperty('main')
    found.files = ['.env.local']
    expect(() => config({ mode: 'production', command: 'build' })).toThrow(/\.env\.local sets MAIN_VITE_UPDATE_FEED or MAIN_VITE_UPDATE_FEED_TEST/)
    expect(config({ mode: 'development', command: 'serve' })).toHaveProperty('renderer')
  })
})
