// The memory of the dates of the update feed (update-feed-memory.ts), on real files of a folder of the test: what is written, what a damaged file does, and what
// a copy does with an older feed after it was relaunched. No network and no Electron.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import type { FeedAnswer } from '@shared/update-check'
import type { FeedTarget } from '@shared/update-target'
import { FEED_MEMORY_FILE, fileFeedDateStore, freshFeedReader } from './update-feed-memory'

const WINDOWS: FeedTarget = { platform: 'win32', arch: 'x64' }
const STABLE = 'https://lucium.app/updates/win32-x64/feed.json'
const TEST = 'https://test.lucium.app/updates/win32-x64/feed.json'
const feed = (version: string, pub_date: string, extra: Record<string, unknown> = {}): FeedAnswer => ({
  ok: true,
  json: {
    currentRelease: version,
    platform: 'win32',
    arch: 'x64',
    kind: 'nsis',
    releases: [{ version, updateTo: { url: `https://lucium.app/updates/win32-x64/Lucium-${version}-setup.exe`, notes: '', sha256: 'b'.repeat(64), size: 10, pub_date } }],
    ...extra
  }
})

let folder: string
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'lucium-feed-memory-'))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

/** One launch of Lucium on the folder: the feed it is given, and the lines it logs. */
function launch(answer: FeedAnswer | (() => FeedAnswer), url = STABLE) {
  const lines: string[] = []
  const read = vi.fn(async () => (typeof answer === 'function' ? answer() : answer))
  const reader = freshFeedReader(read, () => fileFeedDateStore(folder, (line) => lines.push(line)), () => WINDOWS, (line) => lines.push(line))
  return { lines, read, ask: () => reader(url) }
}

describe('the file of the dates', () => {
  it('is not there before the first feed, and that is no problem to say', async () => {
    const lines: string[] = []
    expect(fileFeedDateStore(folder, (line) => lines.push(line)).read()).toEqual({})
    expect(lines).toEqual([])
  })

  it('holds the address (without its query) and the date of the feed accepted, and nothing else', async () => {
    const first = launch(feed('1.2.0', '2026-11-23T09:00:00Z'), `${STABLE}?token=secret`)
    expect((await first.ask()).ok).toBe(true)
    const text = readFileSync(join(folder, FEED_MEMORY_FILE), 'utf8')
    expect(JSON.parse(text)).toEqual({ [STABLE]: Date.parse('2026-11-23T09:00:00Z') })
    expect(text).not.toContain('secret')
    // Owner only, like the other files of the data folder; and no temporary copy left beside it.
    if (process.platform !== 'win32') expect(statSync(join(folder, FEED_MEMORY_FILE)).mode & 0o777).toBe(0o600)
    expect(readdirSync(folder)).toEqual([FEED_MEMORY_FILE])
  })

  it('is read as empty, and the damage is said in the log, when it is not JSON', async () => {
    writeFileSync(join(folder, FEED_MEMORY_FILE), '{ not json')
    const lines: string[] = []
    expect(fileFeedDateStore(folder, (line) => lines.push(line)).read()).toEqual({})
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('damaged')
  })

  it('is read as empty, and the reason is said in the log, when it cannot be read at all', async () => {
    // A folder where the file should be: reading it fails with something other than "nothing there".
    mkdirSync(join(folder, FEED_MEMORY_FILE))
    const lines: string[] = []
    expect(fileFeedDateStore(folder, (line) => lines.push(line)).read()).toEqual({})
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('could not be read')
  })

  it('keeps only what is a date of an address: junk in the file is forgotten', async () => {
    writeFileSync(join(folder, FEED_MEMORY_FILE), JSON.stringify({ [STABLE]: 5, bad: 'x', worse: -3 }))
    expect(fileFeedDateStore(folder).read()).toEqual({ [STABLE]: 5 })
  })
})

describe('a copy that is relaunched', () => {
  it('refuses an older feed than the last one it accepted, in the log with the address, and offers nothing of it', async () => {
    await launch(feed('1.2.1', '2026-11-24T09:00:00Z')).ask()
    const later = launch(feed('1.2.0', '2026-11-23T09:00:00Z', { withdrawn: ['1.1.9'] }))
    const answer = await later.ask()
    expect(answer).toEqual({ ok: false, reason: t('update-check.le-flux-de-mises-a-jour-est-plus-ancien-que-le-dernier-lu') })
    expect(later.lines).toHaveLength(1)
    expect(later.lines[0]).toContain(STABLE)
    expect(later.lines[0]).toContain('No update is offered and no version is said withdrawn')
    // The refusal does not move the memory back.
    expect(fileFeedDateStore(folder).read()).toEqual({ [STABLE]: Date.parse('2026-11-24T09:00:00Z') })
  })

  it('accepts the same feed, and a newer one, and remembers the newer date', async () => {
    await launch(feed('1.2.0', '2026-11-23T09:00:00Z')).ask()
    expect((await launch(feed('1.2.0', '2026-11-23T09:00:00Z')).ask()).ok).toBe(true)
    expect((await launch(feed('1.2.1', '2026-11-24T09:00:00Z')).ask()).ok).toBe(true)
    expect(fileFeedDateStore(folder).read()).toEqual({ [STABLE]: Date.parse('2026-11-24T09:00:00Z') })
  })

  it('keeps the test channel and the stable one apart, each at its own address', async () => {
    await launch(feed('1.2.0', '2026-11-30T09:00:00Z'), STABLE).ask()
    expect((await launch(feed('1.2.1', '2026-11-25T09:00:00Z'), TEST).ask()).ok).toBe(true)
    expect((await launch(feed('1.2.0', '2026-11-29T09:00:00Z'), STABLE).ask()).ok).toBe(false)
    expect(fileFeedDateStore(folder).read()).toEqual({ [STABLE]: Date.parse('2026-11-30T09:00:00Z'), [TEST]: Date.parse('2026-11-25T09:00:00Z') })
  })

  it('has no memory when the file is lost, and takes the next feed as the first: it is the limit the study names', async () => {
    await launch(feed('1.2.1', '2026-11-24T09:00:00Z')).ask()
    rmSync(join(folder, FEED_MEMORY_FILE))
    expect((await launch(feed('1.2.0', '2026-11-23T09:00:00Z')).ask()).ok).toBe(true)
  })

  it('reads a damaged file as empty, says so, and the feed that is read goes on being accepted and is remembered', async () => {
    writeFileSync(join(folder, FEED_MEMORY_FILE), 'garbage')
    const run = launch(feed('1.2.0', '2026-11-23T09:00:00Z'))
    expect((await run.ask()).ok).toBe(true)
    expect(run.lines.some((line) => line.includes('damaged'))).toBe(true)
    expect(fileFeedDateStore(folder).read()).toEqual({ [STABLE]: Date.parse('2026-11-23T09:00:00Z') })
  })

  it('keeps a feed that was accepted when its date cannot be written, and says that a later replay would not be seen', async () => {
    if (process.platform === 'win32') return
    chmodSync(folder, 0o500)
    try {
      const run = launch(feed('1.2.0', '2026-11-23T09:00:00Z'))
      expect((await run.ask()).ok).toBe(true)
      expect(run.lines).toHaveLength(1)
      expect(run.lines[0]).toContain('could not be kept')
      expect(run.lines[0]).toContain(STABLE)
    } finally {
      chmodSync(folder, 0o700)
    }
  })

  it('touches no file when the feed did not answer', async () => {
    const run = launch({ ok: false, reason: 'No response' })
    expect(await run.ask()).toEqual({ ok: false, reason: 'No response' })
    expect(readdirSync(folder)).toEqual([])
    expect(run.lines).toEqual([])
  })
})
