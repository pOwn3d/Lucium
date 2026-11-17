// What the interface is sent at every change, measured without Electron: the snapshot of `Browser.snapshot()` (browser.ts), which
// `publishHere` (browser-publish.ts) hands to `webContents.send` once per window after `PublishQueue` (publish-queue.ts) has merged the turn's
// requests. Only the two parts that grow with the number of tabs are built here (`state` and `runtime`); the rest of the snapshot is a few hundred bytes.
//
// It prints a table and asserts nothing about time, so it stays out of `pnpm test` (vitest.config.mts). Run it with `pnpm test:snapshot-bench`.
// The numbers it gave are in docs/performance.md (« Taille de l'instantané envoyé aux fenêtres »). `webContents.send` clones its argument with the
// structured clone algorithm, whose serializer is V8's: `v8.serialize` is the closest thing to it outside Electron. It leaves out the transfer between
// the processes and the work of the interface once it has received the message (reading it, drawing the rows), which only a `pnpm perf` run can show.

import { deserialize, serialize } from 'node:v8'
import { afterAll, describe, expect, it } from 'vitest'
import type { Folder, RuntimeState, SidebarState, TabItem, TabRuntime } from '@shared/model'
import type { UiSnapshot } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'

/** The parts of `UiSnapshot` whose size follows the number of tabs. */
type Growing = Pick<UiSnapshot, 'state' | 'runtime'>

const TAB_COUNTS = [500, 2000, 5000] as const
const RUNS = 30
const WARMUP = 5
const SPACES = 4
const FOLDERS_PER_SPACE = 5

const SITES = ['lemonde', 'github', 'wikipedia', 'stackoverflow', 'youtube', 'nytimes', 'figma', 'notion', 'linear', 'vercel', 'mozilla', 'arstechnica']
const SECTIONS = ['articles', 'docs', 'questions', 'pull', 'watch', 'wiki', 'blog', 'issues']
const WORDS = ['Guide', 'Understanding', 'Release', 'notes', 'How', 'to', 'build', 'a', 'fast', 'browser', 'Why', 'tabs', 'sleep', 'Comparing', 'engines', 'Weekly', 'digest', 'Changelog', 'for', 'version', 'Design', 'review', 'Memory', 'budget']

/** An id of the shape the application gives (a UUID), but the same on every run. */
const idOf = (kind: string, n: number): string => `${kind.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

/**
 * `count` tabs spread over a few spaces and folders, a tenth of them pinned, with the titles and addresses of ordinary pages (about 50 and 85 characters)
 * and an icon address each. A tenth of the tabs are awake in `runtime`, the others asleep, as with a large collection.
 */
function buildSnapshotParts(count: number): Growing {
  let n = 0
  const base = createInitialState({ now: 1_700_000_000_000, newId: () => idOf('space', n++) })
  const first = base.spaces[0]!
  const spaces = Array.from({ length: SPACES }, (_, i) => (i === 0 ? first : { ...first, id: idOf('space', 100 + i), name: `Espace ${i + 1}` }))
  const folders: Folder[] = spaces.flatMap((space, s) => Array.from({ length: FOLDERS_PER_SPACE }, (_, f) => ({ id: idOf('folder', s * 10 + f), spaceId: space.id, name: `Dossier ${f + 1}`, collapsed: f % 2 === 0 })))
  const tabs: TabItem[] = []
  const runtimeTabs: Record<string, TabRuntime> = {}
  for (let i = 0; i < count; i++) {
    const space = spaces[i % SPACES]!
    const site = SITES[i % SITES.length]!
    const pinned = i % 10 === 0
    const title = Array.from({ length: 5 + (i % 4) }, (_, w) => WORDS[(i * 7 + w * 3) % WORDS.length]!).join(' ')
    const id = idOf('tab', i)
    tabs.push({
      id,
      spaceId: space.id,
      url: `https://www.${site}.com/${SECTIONS[i % SECTIONS.length]}/2026/11/${title.toLowerCase().replace(/ /g, '-')}-${i}`,
      title: `${title} - ${site}`,
      faviconUrl: `https://www.${site}.com/static/favicon-32x32.png?v=${1000 + (i % 50)}`,
      pinned,
      ...(pinned ? { folderId: folders[(i / 10) % folders.length]!.id } : {}),
      createdAt: 1_700_000_000_000 + i * 1000,
      lastActiveAt: 1_700_100_000_000 + i * 1000
    })
    runtimeTabs[id] = { loading: false, audible: false, muted: false, awake: i % 10 === 0 }
  }
  const state: SidebarState = { ...base, spaces, folders, tabs, activeSpaceId: first.id, activeTabBySpace: Object.fromEntries(spaces.map((space, s) => [space.id, tabs[s]?.id ?? null])) }
  const runtime: RuntimeState = { tabs: runtimeTabs, canGoBack: false, canGoForward: false }
  return { state, runtime }
}

interface Row {
  tabs: number
  stateKb: number
  runtimeKb: number
  totalKb: number
  jsonKb: number
  bytesPerTab: number
  serializeMs: number
  serializeP95Ms: number
  deserializeMs: number
  jsonMs: number
  threeWindowsMb: number
}

const rows: Row[] = []

/** The median and the 95th percentile, in milliseconds, of `RUNS` timed runs after `WARMUP` that are not kept. */
function timed(run: () => unknown): { median: number; p95: number } {
  for (let i = 0; i < WARMUP; i++) run()
  const durations: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now()
    run()
    durations.push(performance.now() - start)
  }
  durations.sort((a, b) => a - b)
  return { median: durations[Math.floor(RUNS / 2)]!, p95: durations[Math.ceil(RUNS * 0.95) - 1]! }
}

const kb = (bytes: number): number => Math.round((bytes / 1024) * 10) / 10
const ms = (value: number): number => Math.round(value * 100) / 100

describe('size and cost of the snapshot sent to a window', () => {
  for (const tabs of TAB_COUNTS) {
    it(`${tabs} tabs`, () => {
      const parts = buildSnapshotParts(tabs)
      expect(parts.state.tabs).toHaveLength(tabs)
      const stateBytes = serialize(parts.state).length
      const runtimeBytes = serialize(parts.runtime).length
      const totalBytes = serialize(parts).length
      const jsonBytes = Buffer.byteLength(JSON.stringify(parts))

      // What is measured is the payload itself: it comes back from the serializer unchanged.
      expect(deserialize(serialize(parts))).toEqual(parts)

      const out = timed(() => serialize(parts))
      const roundTrip = timed(() => deserialize(serialize(parts)))
      const json = timed(() => JSON.stringify(parts))
      rows.push({
        tabs,
        stateKb: kb(stateBytes),
        runtimeKb: kb(runtimeBytes),
        totalKb: kb(totalBytes),
        jsonKb: kb(jsonBytes),
        bytesPerTab: Math.round(totalBytes / tabs),
        serializeMs: ms(out.median),
        serializeP95Ms: ms(out.p95),
        // The round trip includes the serialization: the difference is the receiver's reading alone.
        deserializeMs: ms(Math.max(0, roundTrip.median - out.median)),
        jsonMs: ms(json.median),
        threeWindowsMb: Math.round((totalBytes * 3 * 10) / 1024 / 1024) / 10
      })
    })
  }

  it('grows with the number of tabs and no faster (the size per tab stays about the same)', () => {
    const perTab = rows.map((row) => row.bytesPerTab)
    expect(perTab).toHaveLength(TAB_COUNTS.length)
    expect(Math.max(...perTab) / Math.min(...perTab)).toBeLessThan(1.15)
  })

  afterAll(() => {
    // One table for the whole run; docs/performance.md keeps the figures with the date and the machine.
    console.log(`\nSnapshot sent to a window (state + runtime), median of ${RUNS} runs, Node ${process.version}, ${process.platform}/${process.arch}`)
    console.table(rows)
  })
})
