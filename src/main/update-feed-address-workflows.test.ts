// The addresses of the update feeds that the Windows and Linux builds carry (carte 850, lot 0 of the automatic updates of those systems). They are built into
// app.asar by electron-vite from MAIN_VITE_UPDATE_FEED and MAIN_VITE_UPDATE_FEED_TEST, as the build of macOS does (scripts/build-drm-release.sh), and nothing reads
// them yet (update-source.test.ts). The workflows run on GitHub only: what can be held here is their text. Held: the packaging builds carry the address of the
// folder of their own system, the builds that only test carry none, and the address is the one the publication will write at (publish-update.ts).
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { INSTALLER_KINDS } from '@shared/update-target'
import { FEED_NAME, PUBLIC_CHANNELS } from './publish-update'

const here = (relative: string): string => fileURLToPath(new URL(`../../${relative}`, import.meta.url))
const code = (text: string): string => text.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
const workflow = (name: string): string => code(readFileSync(here(`.github/workflows/${name}`), 'utf8'))
/** The text of one job: from `  <id>:` to the next job. */
const job = (text: string, id: string): string => new RegExp(`^ {2}${id}:\\n([\\s\\S]*?)(?=^ {2}[a-z][a-z-]*:\\n|(?![\\s\\S]))`, 'm').exec(text)?.[1] ?? ''
/** The step called Build of a job: its name, its environment and its command. */
const buildStep = (text: string): string => /^ {6}- name: Build\n([\s\S]*?)(?=^ {6}[-#]|(?![\s\S]))/m.exec(text)?.[1] ?? ''
const addresses = (step: string): { stable: string | undefined; test: string | undefined } => ({
  stable: /^ {10}MAIN_VITE_UPDATE_FEED: (.+)$/m.exec(step)?.[1],
  test: /^ {10}MAIN_VITE_UPDATE_FEED_TEST: (.+)$/m.exec(step)?.[1]
})

const windows = workflow('windows.yml')
const linux = workflow('linux.yml')
/** What scripts/build-drm-release.sh accepts as an address (FEED_PATTERN): one plain https address. */
const PLAIN_HTTPS = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?\/[A-Za-z0-9._~/%-]*$/

describe('the Build step of the packaging job of windows.yml', () => {
  const step = buildStep(job(windows, 'installer'))

  it('builds the addresses of the feed of Windows x64 into the application, stable and test, as the folder the publication writes at', () => {
    expect(step).toMatch(/run: pnpm build$/m)
    expect(addresses(step)).toEqual({ stable: 'https://lucium.app/updates/win32-x64/feed.json', test: 'https://test.lucium.app/updates/win32-x64/feed.json' })
  })
})

describe('the Build step of the packaging job of linux.yml', () => {
  const step = buildStep(job(linux, 'packages'))

  it('builds the addresses of the feed of its own architecture into the application, stable and test', () => {
    expect(step).toMatch(/run: pnpm build$/m)
    expect(addresses(step)).toEqual({
      stable: 'https://lucium.app/updates/linux-${{ matrix.arch }}/feed.json',
      test: 'https://test.lucium.app/updates/linux-${{ matrix.arch }}/feed.json'
    })
  })

  it('runs for the architectures that have a folder of feed, and no other', () => {
    const arches = [...job(linux, 'packages').matchAll(/^ {10}- arch: (\S+)$/gm)].map((match) => match[1])
    expect(arches).toEqual(['x64', 'arm64'])
    for (const arch of arches) expect(Object.keys(INSTALLER_KINDS)).toContain(`linux-${arch}`)
  })
})

describe('the addresses of the feeds of the builds of Windows and Linux', () => {
  it('are plain https addresses of the folder of a system that has a build, ending with the name of the release file', () => {
    const found = [addresses(buildStep(job(windows, 'installer'))), addresses(buildStep(job(linux, 'packages')))].flatMap((pair) => [pair.stable, pair.test])
    expect(found).toHaveLength(4)
    for (const address of found) {
      const filled = (address ?? '').replace('${{ matrix.arch }}', 'x64')
      expect(filled, address).toMatch(PLAIN_HTTPS)
      const [, host, folder, name] = /^https:\/\/([^/]+)\/updates\/([^/]+)\/([^/]+)$/.exec(filled) ?? []
      expect(['lucium.app', 'test.lucium.app'], address).toContain(host)
      expect(Object.keys(INSTALLER_KINDS), address).toContain(folder)
      expect(name, address).toBe(FEED_NAME)
    }
  })

  it('follow the folders of macOS: the same host, the same path, only the system changes', () => {
    expect(PUBLIC_CHANNELS['stable']!.baseUrl).toBe('https://lucium.app/updates/darwin-arm64/')
    expect(PUBLIC_CHANNELS['test']!.baseUrl).toBe('https://test.lucium.app/updates/darwin-arm64/')
  })

  it('are built in by those two steps only: no other build of a workflow carries an address, and none writes a .env file', () => {
    const files = readdirSync(here('.github/workflows')).filter((name) => /\.ya?ml$/.test(name))
    const holders = files.flatMap((name) => [...workflow(name).matchAll(/MAIN_VITE_UPDATE_FEED/g)].map(() => name))
    expect(holders.sort()).toEqual(['linux.yml', 'linux.yml', 'windows.yml', 'windows.yml'])
    for (const name of files) expect(workflow(name), name).not.toMatch(/\.env\b/)
    // The builds that only test (E2E, the smoke of the packages) carry no address.
    expect(buildStep(job(windows, 'e2e'))).not.toMatch(/MAIN_VITE_UPDATE_FEED/)
    expect(buildStep(job(linux, 'e2e'))).not.toMatch(/MAIN_VITE_UPDATE_FEED/)
  })
})
