import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APP_FILE,
  BUNDLE_ID,
  DATA_FOLDER,
  FEED_URL,
  FEED_VERSION_KEY,
  SHARED_FOLDERS,
  STABLE_FOLDER,
  ZAP_TRASH,
  archiveNameOf,
  buildRecordNameOf,
  caskProblems,
  caskText,
  dmgNameOf,
  imageRecordNameOf,
  makeCask,
  parseCaskArgs,
  readSum,
  sumNameOf,
  zapProblems,
  type CaskDeps
} from './homebrew-cask'
import * as dmg from './make-dmg'
import * as publication from './publish-update'
import { buildRecordNameOf as gateBuildRecordNameOf, buildRecordOf, readBuildRecord } from './release-gate'
import { releaseFile } from './update-feed-file'
import { onWindows } from './windows.test-support'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SHA = 'ab'.repeat(32)
const sha256Of = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The whole file, as the tap holds it, for version 1.2.3. */
const EXPECTED = `# Written by scripts/make-cask.mjs of the Lucium repository, from the published disk image and its sum.
# Do not edit by hand: run the script again (docs/community/homebrew.md in that repository).
cask "lucium" do
  version "1.2.3"
  sha256 "${SHA}"

  url "https://lucium.app/updates/darwin-arm64/Lucium-#{version}-arm64.dmg"
  name "Lucium"
  desc "Web browser with a vertical sidebar"
  homepage "https://lucium.app/"

  livecheck do
    url "https://lucium.app/updates/darwin-arm64/feed.json"
    strategy :json do |json|
      json["currentRelease"]
    end
  end

  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :ventura

  app "Lucium.app"

  zap trash: [
    "~/Library/Application Support/Lucium",
    "~/Library/Caches/app.lucium.browser",
    "~/Library/Caches/app.lucium.browser.ShipIt",
    "~/Library/HTTPStorages/app.lucium.browser",
    "~/Library/Preferences/app.lucium.browser.plist",
    "~/Library/Preferences/ByHost/app.lucium.browser.ShipIt.*.plist",
    "~/Library/Saved Application State/app.lucium.browser.savedState",
  ]
end
`

describe('the cask', () => {
  it('is the file the tap holds, line for line', () => {
    expect(caskText({ version: '1.2.3', sha256: SHA })).toBe(EXPECTED)
  })

  it('names what the release names: the image and its place on the stable channel, the app, the identifier, the data folder', () => {
    for (const version of ['1.0.0', '12.34.56']) {
      expect(dmgNameOf(version)).toBe(dmg.dmgNameOf(version))
      expect(dmgNameOf(version)).toBe(publication.dmgNameOf(version))
      expect(sumNameOf(version)).toBe(dmg.sumNameOf(version))
      expect(imageRecordNameOf(version)).toBe(dmg.imageRecordNameOf(version))
      expect(buildRecordNameOf(version)).toBe(gateBuildRecordNameOf(version))
      expect(archiveNameOf(version)).toBe(publication.archiveNameOf(version))
    }
    const stable = publication.PUBLIC_CHANNELS['stable']
    expect(STABLE_FOLDER).toBe(stable?.baseUrl)
    expect(FEED_URL).toBe(new URL(publication.FEED_NAME, stable?.baseUrl).href)
    expect(APP_FILE).toBe(dmg.APP_FILE)
    expect(readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')).toMatch(new RegExp(`^appId: ${BUNDLE_ID.replaceAll('.', '\\.')}$`, 'm'))
    expect(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).productName).toBe(DATA_FOLDER)
    // The address Homebrew downloads is the one publish-update.mjs checks online after it sent the image.
    const sent = publication.remotePlan({ archive: '/d/Lucium-1.2.3-arm64.zip', feed: '/d/feed.json', channel: { host: 'u@h', folder: '/srv/u', baseUrl: STABLE_FOLDER }, sshKey: '/k', disk: { dmg: '/d/Lucium-1.2.3-arm64.dmg', sum: '/d/Lucium-1.2.3-arm64.dmg.sha256' } })
    expect(sent.disk?.dmgUrl).toBe(`${STABLE_FOLDER}${dmgNameOf('1.2.3')}`)
    expect(EXPECTED).toContain(`url "${STABLE_FOLDER}Lucium-#{version}-arm64.dmg"`)
  })

  it('reads, for livecheck, the key of the feed that names the version on offer', () => {
    const feed = releaseFile({ version: '2.0.1', base: STABLE_FOLDER, fileName: 'Lucium-2.0.1-arm64.zip', sha256: SHA, size: 10, date: new Date('2026-11-11T12:00:00Z'), notes: 'n' })
    expect((feed as unknown as Record<string, unknown>)[FEED_VERSION_KEY]).toBe('2.0.1')
    expect(EXPECTED).toContain(`json["${FEED_VERSION_KEY}"]`)
  })

  it('copies the application and nothing else: no script, nothing that touches the quarantine mark', () => {
    const text = caskText({ version: '1.2.3', sha256: SHA })
    const stanzas = text.split('\n').filter((line) => !line.startsWith('#')).join('\n')
    expect(stanzas).not.toMatch(/preflight|postflight|uninstall|system_command|xattr|quarantine|installer|script|pkg /)
    expect(text.match(/^ {2}app "/gm)).toEqual(['  app "'])
    expect(text).toContain('  auto_updates true\n')
    expect(text).toContain('  depends_on arch: :arm64\n')
    // The string form (">= :ventura") is deprecated by Homebrew 7: the symbol alone means "this version or later".
    expect(text).toContain('  depends_on macos: :ventura\n')
  })

  it('uses https for every address, and refuses any other', () => {
    for (const address of EXPECTED.match(/"[a-z]+:\/\/[^"]*"/g) ?? []) expect(address).toMatch(/^"https:\/\//)
    expect(EXPECTED.match(/"[a-z]+:\/\/[^"]*"/g)).toHaveLength(3)
    const facts = { version: '1.2.3', sha256: SHA }
    expect(caskProblems(facts)).toEqual([])
    expect(caskProblems({ ...facts, folder: 'http://lucium.app/updates/darwin-arm64/' })).toEqual(['the folder of the image must be https and end with "/": http://lucium.app/updates/darwin-arm64/'])
    expect(caskProblems({ ...facts, folder: 'https://lucium.app/updates/darwin-arm64' })).toHaveLength(1)
    expect(caskProblems({ ...facts, homepage: 'http://lucium.app/' })).toEqual(['the homepage must be https: http://lucium.app/'])
    expect(caskProblems({ ...facts, feed: 'http://lucium.app/updates/darwin-arm64/feed.json' })).toEqual(['the feed must be https: http://lucium.app/updates/darwin-arm64/feed.json'])
    expect(caskProblems({ ...facts, feed: 'https://user:pass@lucium.app/feed.json' })).toHaveLength(1)
    expect(caskProblems({ ...facts, homepage: 'https://lucium.app/?ref="x"' })).toHaveLength(1)
    expect(() => caskText({ ...facts, homepage: 'http://lucium.app/' })).toThrow('the homepage must be https')
  })

  it('refuses a version that is not three numbers, and a SHA-256 that is not 64 lowercase hexadecimal digits', () => {
    for (const version of ['1.2', 'v1.2.3', '1.2.3-beta.1', '1.2.3.4', '']) expect(caskProblems({ version, sha256: SHA }), version).toEqual([`the version "${version}" is not three numbers`])
    for (const sha256 of [SHA.toUpperCase(), SHA.slice(1), `${SHA}0`, 'z'.repeat(64)]) expect(caskProblems({ version: '1.2.3', sha256 })).toEqual(['the SHA-256 is not 64 lowercase hexadecimal digits'])
  })
})

describe('zap', () => {
  it('trashes one entry named after Lucium directly inside a shared folder of ~/Library, never the folder itself', () => {
    expect(zapProblems(ZAP_TRASH)).toEqual([])
    for (const path of ZAP_TRASH) {
      const parent = path.slice(0, path.lastIndexOf('/'))
      expect(SHARED_FOLDERS, path).toContain(parent)
      expect(path.slice(parent.length + 1), path).toMatch(new RegExp(`^(?:${DATA_FOLDER}|${BUNDLE_ID.replaceAll('.', '\\.')}(?:\\..+)?)$`))
    }
    // What the code and the build name: the data folder of Electron (productName), and Squirrel's work folder (docs/drm.md, section 12).
    expect(ZAP_TRASH).toContain('~/Library/Application Support/Lucium')
    expect(ZAP_TRASH).toContain('~/Library/Caches/app.lucium.browser.ShipIt')
  })

  it('refuses a shared folder, a folder of another application or of the maintainer, and anything outside ~/Library', () => {
    for (const shared of SHARED_FOLDERS) expect(zapProblems([shared]), shared).not.toEqual([])
    const refused = [
      '~/Library',
      '~/Library/Application Support/lucium-secrets',
      '~/Library/Application Support/lucium-app-backups',
      '~/Library/Application Support/Ollama',
      '~/Library/Caches/*',
      '~/Library/Caches/app.lucium.browserx',
      '~/Library/Application Support/Lucium/../Google',
      '~/Library/Application Support/Lucium/Default',
      '~/Library/Logs/DiagnosticReports/Lucium',
      '~/Downloads/Lucium',
      '~/Lucium',
      '/Library/Application Support/Lucium',
      'Lucium'
    ]
    for (const path of refused) expect(zapProblems([path]), path).toHaveLength(1)
    expect(zapProblems([])).toEqual(['zap trashes nothing: the cask would leave every file of Lucium behind'])
    expect(zapProblems([ZAP_TRASH[0] as string, ZAP_TRASH[0] as string])).toEqual(['zap names a path twice'])
    expect(() => caskText({ version: '1.2.3', sha256: SHA, zap: [...ZAP_TRASH, '~/Library/Caches'] })).toThrow('~/Library/Caches: zap trashes only an entry directly inside')
  })
})

describe('the sum of the image', () => {
  it('is read from the line make-dmg.mjs writes, for the image it names', () => {
    expect(readSum(dmg.sumLineOf(SHA, 'Lucium-1.2.3-arm64.dmg'), 'Lucium-1.2.3-arm64.dmg')).toEqual({ sha256: SHA })
    expect(readSum(`${SHA} *Lucium-1.2.3-arm64.dmg\n`, 'Lucium-1.2.3-arm64.dmg')).toEqual({ sha256: SHA })
  })

  it('is refused when it names another file, is not one line, or is not a SHA-256', () => {
    expect(readSum(dmg.sumLineOf(SHA, 'Lucium-1.2.2-arm64.dmg'), 'Lucium-1.2.3-arm64.dmg')).toEqual({ problem: 'it names "Lucium-1.2.2-arm64.dmg", the image is Lucium-1.2.3-arm64.dmg' })
    expect(readSum(dmg.sumLineOf(SHA, 'dist-drm/Lucium-1.2.3-arm64.dmg'), 'Lucium-1.2.3-arm64.dmg')).toHaveProperty('problem')
    for (const text of ['', SHA, `${SHA.toUpperCase()}  Lucium-1.2.3-arm64.dmg`, `${dmg.sumLineOf(SHA, 'Lucium-1.2.3-arm64.dmg')}${dmg.sumLineOf(SHA, 'Lucium-1.2.3-arm64.dmg')}`]) {
      expect(readSum(text, 'Lucium-1.2.3-arm64.dmg'), text).toEqual({ problem: 'it is not one line "<sha256>  <name>", as shasum -a 256 prints it' })
    }
  })
})

describe('the arguments of scripts/make-cask.mjs', () => {
  it('take the tap, and the image when it is not the one of package.json', () => {
    expect(parseCaskArgs(['--tap', '../tap'])).toEqual({ ok: true, options: { help: false, tap: '../tap', image: null } })
    expect(parseCaskArgs(['--tap=../tap', 'dist-drm/Lucium-1.0.0-arm64.dmg'])).toEqual({ ok: true, options: { help: false, tap: '../tap', image: 'dist-drm/Lucium-1.0.0-arm64.dmg' } })
    expect(parseCaskArgs(['--help'])).toEqual({ ok: true, options: { help: true, tap: null, image: null } })
  })

  it('refuse a missing tap, an option for a folder, an unknown option and two images', () => {
    expect(parseCaskArgs([])).toMatchObject({ ok: false, message: expect.stringContaining('--tap <folder> is required') })
    expect(parseCaskArgs(['--tap', '--help'])).toEqual({ ok: false, message: '--tap needs the folder of the tap' })
    expect(parseCaskArgs(['--tap='])).toEqual({ ok: false, message: '--tap needs the folder of the tap' })
    expect(parseCaskArgs(['--tap', 't', '--force'])).toEqual({ ok: false, message: 'Unknown option: --force' })
    expect(parseCaskArgs(['--tap', 't', 'a.dmg', 'b.dmg'])).toEqual({ ok: false, message: 'One disk image at a time: a.dmg, then b.dmg' })
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// makeCask, on files held in memory

const IMAGE = '/dist/Lucium-1.2.3-arm64.dmg'
const TAP = '/tap'

/** The files a release leaves beside its image, as the build, make-dmg.mjs and the build record write them. */
function release(version = '1.2.3', image = 'the bytes of the image'): Map<string, string> {
  const name = dmgNameOf(version)
  const sha256 = sha256Of(image)
  const record = buildRecordOf({ version, archive: { name: archiveNameOf(version), sha256: SHA, size: 100 }, start: { commit: 'c'.repeat(40), modified: false }, end: { commit: 'c'.repeat(40), modified: false }, now: new Date('2026-11-11T12:00:00Z') })
  return new Map([
    [`/dist/${name}`, image],
    [`/dist/${sumNameOf(version)}`, dmg.sumLineOf(sha256, name)],
    [`/dist/${buildRecordNameOf(version)}`, JSON.stringify(record)],
    [`/dist/${imageRecordNameOf(version)}`, JSON.stringify(dmg.imageRecordOf({ version, image: { sha256, size: Buffer.byteLength(image) }, executable: { sha256: SHA, size: 5 } }))],
    [TAP, '(a folder)']
  ])
}

function fake(files: Map<string, string>, fail: { read?: string; hash?: string; write?: boolean } = {}): CaskDeps & { written: Map<string, string>; made: string[] } {
  const written = new Map<string, string>()
  const made: string[] = []
  return {
    written,
    made,
    exists: (path) => files.has(path),
    readText: (path) => {
      if (path === fail.read) throw new Error(`EACCES: permission denied, open '${path}'`)
      const text = files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    sha256File: async (path) => {
      if (path === fail.hash) throw new Error(`EIO: i/o error, read '${path}'`)
      const text = files.get(path) ?? ''
      return { sha256: sha256Of(text), size: Buffer.byteLength(text) }
    },
    readBuildRecord,
    makeDir: (path) => made.push(path),
    writeText: (path, text) => {
      if (fail.write) throw new Error(`EROFS: read-only file system, open '${path}'`)
      written.set(path, text)
    }
  }
}

/** The problems of a run that must write nothing. */
async function refused(files: Map<string, string>, image = IMAGE, fail: Parameters<typeof fake>[1] = {}): Promise<string[]> {
  const deps = fake(files, fail)
  const result = await makeCask({ image, tap: TAP }, deps)
  expect(deps.written.size, 'nothing is written when there is a problem').toBe(0)
  if (result.ok) throw new Error('makeCask accepted what it must refuse')
  return result.problems
}

describe('makeCask', () => {
  it('writes Casks/lucium.rb in the tap, with the version of the image and the SHA-256 of its sum', async () => {
    const files = release()
    const deps = fake(files)
    const result = await makeCask({ image: IMAGE, tap: TAP }, deps)
    const sha256 = sha256Of('the bytes of the image')
    expect(result).toEqual({ ok: true, version: '1.2.3', sha256, size: 22, caskFile: '/tap/Casks/lucium.rb', text: caskText({ version: '1.2.3', sha256 }) })
    expect(deps.made).toEqual(['/tap/Casks'])
    expect([...deps.written]).toEqual([['/tap/Casks/lucium.rb', caskText({ version: '1.2.3', sha256 })]])
  })

  it('takes the SHA-256 from the sum, and refuses a sum that is not the image of the folder', async () => {
    const files = release()
    files.set(IMAGE, 'an image made again after its sum')
    const problems = await refused(files)
    expect(problems).toEqual([
      `/dist/Lucium-1.2.3-arm64.dmg.sha256 says ${sha256Of('the bytes of the image')}, the image has SHA-256 ${sha256Of('an image made again after its sum')}: the sum is not the image's. Make the image again (scripts/make-dmg.mjs)`,
      // The record of the image was written with the old image too, and says so on its own.
      expect.stringContaining('/dist/Lucium-1.2.3-arm64.dmg.json: it describes another image')
    ])
    // The sum alone wrong, the record right: the sum is still refused.
    const sumOnly = release()
    sumOnly.set('/dist/Lucium-1.2.3-arm64.dmg.sha256', dmg.sumLineOf(SHA, 'Lucium-1.2.3-arm64.dmg'))
    expect(await refused(sumOnly)).toEqual([`/dist/Lucium-1.2.3-arm64.dmg.sha256 says ${SHA}, the image has SHA-256 ${sha256Of('the bytes of the image')}: the sum is not the image's. Make the image again (scripts/make-dmg.mjs)`])
  })

  it('refuses when the image or its sum is missing', async () => {
    const noImage = release()
    noImage.delete(IMAGE)
    expect(await refused(noImage)).toEqual(['/dist/Lucium-1.2.3-arm64.dmg is missing: scripts/make-dmg.mjs makes it, and the cask describes the image that is published'])
    const noSum = release()
    noSum.delete('/dist/Lucium-1.2.3-arm64.dmg.sha256')
    expect(await refused(noSum)).toEqual(['/dist/Lucium-1.2.3-arm64.dmg.sha256 is missing: scripts/make-dmg.mjs writes it with the image, and the cask takes its SHA-256 from it'])
  })

  it('refuses a sum that names another image', async () => {
    const files = release()
    files.set('/dist/Lucium-1.2.3-arm64.dmg.sha256', dmg.sumLineOf(sha256Of('the bytes of the image'), 'Lucium-1.2.2-arm64.dmg'))
    expect(await refused(files)).toEqual(['/dist/Lucium-1.2.3-arm64.dmg.sha256: it names "Lucium-1.2.2-arm64.dmg", the image is Lucium-1.2.3-arm64.dmg'])
  })

  it('refuses a build the records do not show notarized: without its build record', async () => {
    const files = release()
    files.delete('/dist/Lucium-1.2.3-arm64.build.json')
    expect(await refused(files)).toEqual([expect.stringMatching(/^\/dist\/Lucium-1\.2\.3-arm64\.build\.json is missing: .*--notarize.*nothing says the build was notarized$/)])
  })

  it('refuses a build record of another version, of another archive, of a modified tree, or that is not a record', async () => {
    const other = release()
    other.set('/dist/Lucium-1.2.3-arm64.build.json', release('1.2.2').get('/dist/Lucium-1.2.2-arm64.build.json') as string)
    expect(await refused(other)).toEqual([
      '/dist/Lucium-1.2.3-arm64.build.json is the record of 1.2.2, the image is 1.2.3',
      '/dist/Lucium-1.2.3-arm64.build.json names the archive Lucium-1.2.2-arm64.zip, not Lucium-1.2.3-arm64.zip'
    ])
    const modified = release()
    const record = JSON.parse(modified.get('/dist/Lucium-1.2.3-arm64.build.json') as string)
    modified.set('/dist/Lucium-1.2.3-arm64.build.json', JSON.stringify({ ...record, clean: false }))
    expect(await refused(modified)).toEqual([`/dist/Lucium-1.2.3-arm64.build.json: the working tree was modified when ${'c'.repeat(12)} was built; that build is published nowhere, and no cask describes it`])
    const broken = release()
    broken.set('/dist/Lucium-1.2.3-arm64.build.json', '{')
    expect(await refused(broken)).toEqual(['/dist/Lucium-1.2.3-arm64.build.json: it is not a JSON object'])
  })

  it('refuses an image the records do not show notarized: without its record, or with the record of another image or version', async () => {
    const none = release()
    none.delete('/dist/Lucium-1.2.3-arm64.dmg.json')
    expect(await refused(none)).toEqual([expect.stringMatching(/^\/dist\/Lucium-1\.2\.3-arm64\.dmg\.json is missing: .*notarized, stapled and accepted by Gatekeeper$/)])
    const another = release()
    another.set('/dist/Lucium-1.2.3-arm64.dmg.json', JSON.stringify(dmg.imageRecordOf({ version: '1.2.3', image: { sha256: SHA, size: 22 }, executable: { sha256: SHA, size: 5 } })))
    expect(await refused(another)).toEqual([expect.stringContaining('/dist/Lucium-1.2.3-arm64.dmg.json: it describes another image')])
    const version = release()
    version.set('/dist/Lucium-1.2.3-arm64.dmg.json', JSON.stringify({ ...JSON.parse(version.get('/dist/Lucium-1.2.3-arm64.dmg.json') as string), version: '1.2.2' }))
    expect(await refused(version)).toEqual(['/dist/Lucium-1.2.3-arm64.dmg.json: it is the record of version "1.2.2", the image is 1.2.3'])
    const notJson = release()
    notJson.set('/dist/Lucium-1.2.3-arm64.dmg.json', 'not json')
    expect(await refused(notJson)).toEqual([expect.stringMatching(/^\/dist\/Lucium-1\.2\.3-arm64\.dmg\.json: it is not JSON \(.+\)$/)])
  })

  it('refuses an image whose name is not one make-dmg.mjs writes, and a tap that does not exist', async () => {
    expect(await refused(release(), '/dist/Lucium-1.2.3.dmg')).toEqual(['Lucium-1.2.3.dmg is not the name make-dmg.mjs gives an image (Lucium-<three numbers>-arm64.dmg)'])
    const files = release()
    files.delete(TAP)
    expect(await refused(files)).toEqual([expect.stringMatching(/^\/tap does not exist: clone the tap pOwn3d\/homebrew-lucium there first/)])
  })

  it('says every problem at once', async () => {
    const files = release()
    files.delete('/dist/Lucium-1.2.3-arm64.dmg.sha256')
    files.delete('/dist/Lucium-1.2.3-arm64.dmg.json')
    const record = JSON.parse(files.get('/dist/Lucium-1.2.3-arm64.build.json') as string)
    files.set('/dist/Lucium-1.2.3-arm64.build.json', JSON.stringify({ ...record, clean: false }))
    expect(await refused(files)).toHaveLength(3)
  })

  it('says why a file cannot be read or written, and writes nothing then', async () => {
    expect(await refused(release(), IMAGE, { read: '/dist/Lucium-1.2.3-arm64.dmg.sha256' })).toEqual(["cannot read /dist/Lucium-1.2.3-arm64.dmg.sha256: EACCES: permission denied, open '/dist/Lucium-1.2.3-arm64.dmg.sha256'"])
    expect(await refused(release(), IMAGE, { hash: IMAGE })).toEqual([`cannot read ${IMAGE}: EIO: i/o error, read '${IMAGE}'`])
    const deps = fake(release(), { write: true })
    expect(await makeCask({ image: IMAGE, tap: TAP }, deps)).toEqual({ ok: false, problems: ["cannot write /tap/Casks/lucium.rb: EROFS: read-only file system, open '/tap/Casks/lucium.rb'"] })
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The script, run as the maintainer runs it, on the files of a demonstration release in a folder of the test

const SCRIPT = join(ROOT, 'scripts', 'make-cask.mjs')
const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function demo(): { dist: string; tap: string; run: (...args: string[]) => { status: number | null; out: string } } {
  const root = mkdtempSync(join(tmpdir(), 'lucium-make-cask-'))
  folders.push(root)
  const dist = join(root, 'dist')
  const tap = join(root, 'tap')
  mkdirSync(dist)
  mkdirSync(tap)
  for (const [path, text] of release('0.0.0', 'a demonstration image')) if (path.startsWith('/dist/')) writeFileSync(join(dist, path.slice('/dist/'.length)), text)
  return {
    dist,
    tap,
    run: (...args) => {
      const done = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: root } })
      return { status: done.status, out: `${done.stdout}${done.stderr}` }
    }
  }
}

describe('scripts/make-cask.mjs', () => {
  // Windows: the script writes the cask of a macOS disk image from the maintainer's Mac (docs/community/homebrew.md), and reads the path of the image with `/` only.
  it.skipIf(onWindows)('writes the cask of the image into the tap, and says where its SHA-256 comes from', () => {
    const { dist, tap, run } = demo()
    const done = run('--tap', tap, join(dist, 'Lucium-0.0.0-arm64.dmg'))
    expect(done.status, done.out).toBe(0)
    expect(readFileSync(join(tap, 'Casks', 'lucium.rb'), 'utf8')).toBe(caskText({ version: '0.0.0', sha256: sha256Of('a demonstration image') }))
    expect(done.out).toContain('read from Lucium-0.0.0-arm64.dmg.sha256; the image hashed here (21 bytes) has the same')
  })

  // Windows: same as above, the path of the image is read with `/` only.
  it.skipIf(onWindows)('writes nothing and ends with 1 when a file is wrong, saying which', () => {
    const { dist, tap, run } = demo()
    writeFileSync(join(dist, 'Lucium-0.0.0-arm64.dmg.sha256'), dmg.sumLineOf(SHA, 'Lucium-0.0.0-arm64.dmg'))
    const done = run('--tap', tap, join(dist, 'Lucium-0.0.0-arm64.dmg'))
    expect(done.status).toBe(1)
    expect(done.out).toContain(`❌ Nothing written:\n  ${join(dist, 'Lucium-0.0.0-arm64.dmg.sha256')} says ${SHA}`)
    expect(existsSync(join(tap, 'Casks'))).toBe(false)
  })

  it('ends with 2 and its usage when the arguments are wrong', () => {
    const done = demo().run()
    expect(done.status).toBe(2)
    expect(done.out).toContain('Error: --tap <folder> is required')
    expect(done.out).toContain('node scripts/make-cask.mjs --tap ../homebrew-lucium')
  })
})
