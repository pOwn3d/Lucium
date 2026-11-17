import type * as nodeFs from 'node:fs'
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SIDE_FILES_KEPT, allowWrites, copiesFromNewerVersion, copyOnVersionChange, copyToResume, sideFiles, versionOfCopy, writerVersionOf, writesRefused } from './persist'
import { takePersistenceNotices } from './persistence-notices'
import { mayDeleteBackgroundMedia } from './shell/background-media-sweep'
import { StateStore, WRITER_FIELD, loadState, readState } from './store'
import { tempDir } from './temp-dir'

// The first launch of a version of the application over a state another version wrote: an older version that is put back after a bad update, or
// the update itself. The real file system, with the copy wrapped so that a test can make it fail as a full disk does.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, copyFileSync: vi.fn(actual.copyFileSync) }
})
const real = await vi.importActual<typeof nodeFs>('node:fs')

const OLDER = '0.3.0'
const NEWER = '0.3.1'
const SYNC = { asyncWrites: false } as const
let errors: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  takePersistenceNotices()
  vi.mocked(copyFileSync).mockImplementation(real.copyFileSync)
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const statePath = (): string => join(tempDir('lucium-version-change-'), 'state.json')
const namesBeside = (path: string): string[] => readdirSync(join(path, '..')).sort()
const copiesOf = (path: string): string[] => sideFiles(path, 'version-change')
const fileOf = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> & { tabs: Array<Record<string, unknown>>; settings: Record<string, unknown> }

/** A session of `version` on the profile at `path`: it reads the file as the application does at launch, opens `url` when given, and saves. */
const session = (path: string, version: string, url?: string) => {
  const loaded = readState(path, version)
  const store = new StateStore(loaded.state, path, undefined, { ...SYNC, appVersion: version })
  if (url) store.dispatch({ type: 'tab/open', url })
  const saved = store.flush()
  return { loaded, store, saved }
}

/**
 * A profile the newer version used: its state file says so, and one of its tabs carries a field only that version knows (what an older build cannot
 * keep: it rebuilds a tab from the fields of its own model). Answers the text of the file.
 */
const usedByNewer = (path: string): string => {
  session(path, NEWER, 'https://example.org/a')
  const file = fileOf(path)
  writeFileSync(path, JSON.stringify({ ...file, tabs: file.tabs.map((tab) => ({ ...tab, laterTabField: { kept: 'only by the newer version' } })) }))
  return readFileSync(path, 'utf8')
}

describe('the version that wrote the state file', () => {
  it('is written in the file by the store, and is no part of the state in memory', () => {
    const path = statePath()
    const { store } = session(path, OLDER, 'https://example.org/a')
    expect(fileOf(path)[WRITER_FIELD]).toBe(OLDER)
    expect(WRITER_FIELD in store.get()).toBe(false)
    expect(WRITER_FIELD in loadState(path)).toBe(false)
  })

  it('is always the version that writes: the one of a previous run is never written back as a field this version does not know', () => {
    const path = statePath()
    session(path, NEWER, 'https://example.org/a')
    session(path, OLDER, 'https://example.org/b')
    expect(fileOf(path)[WRITER_FIELD]).toBe(OLDER)
    // A store that is given no version (a tool, a test) says nothing rather than the version of the run before it.
    new StateStore(readState(path).state, path, undefined, SYNC).flush()
    expect(WRITER_FIELD in fileOf(path)).toBe(false)
  })

  it('is read only when it is a version: anything else is a file that does not say', () => {
    expect(writerVersionOf('0.3.1')).toBe('0.3.1')
    expect(writerVersionOf(' 1.0.0 ')).toBe('1.0.0')
    for (const value of [undefined, null, 3, '', 'latest', '../0.3.1', { version: '0.3.1' }, `1.${'0'.repeat(40)}`]) expect(writerVersionOf(value), JSON.stringify(value)).toBeNull()
  })
})

describe('the same version started again', () => {
  it('keeps no copy and tells nothing', () => {
    const path = statePath()
    session(path, OLDER, 'https://example.org/a')
    const { loaded } = session(path, OLDER, 'https://example.org/b')
    expect(loaded).toMatchObject({ readable: true, fromNewerVersion: false })
    expect(namesBeside(path)).toEqual(['state.json'])
    expect(takePersistenceNotices()).toEqual([])
  })

  it('keeps no copy for a new profile: there is no file yet', () => {
    const path = statePath()
    expect(readState(path, OLDER)).toMatchObject({ fresh: true, fromNewerVersion: false })
    expect(namesBeside(path)).toEqual([])
  })
})

describe('an older version started over the state of a newer one', () => {
  it('keeps a copy of the file, byte for byte, before anything is written: as soon as the file is read, before a store exists', () => {
    const path = statePath()
    const before = usedByNewer(path)
    const loaded = readState(path, OLDER)
    const copies = copiesOf(path)
    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatch(/state\.json\.version-change-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-from-0\.3\.1$/)
    expect(readFileSync(copies[0] as string, 'utf8')).toBe(before)
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(loaded).toMatchObject({ readable: true, fresh: false, fromNewerVersion: true })
    // The state is the user's: the older version shows the tabs it knows how to show.
    expect(loaded.state.tabs.map((tab) => tab.url)).toEqual(['https://example.org/a'])
  })

  it('keeps in the copy what the older version loses when it writes the file', () => {
    const path = statePath()
    const before = usedByNewer(path)
    session(path, OLDER, 'https://example.org/b')
    // The loss the copy is there for: the older version rebuilt the tab from the fields it knows.
    expect(readFileSync(path, 'utf8')).not.toContain('laterTabField')
    expect(fileOf(path)[WRITER_FIELD]).toBe(OLDER)
    const [copy] = copiesOf(path)
    expect(readFileSync(copy as string, 'utf8')).toBe(before)
    expect(fileOf(copy as string).tabs[0]?.['laterTabField']).toEqual({ kept: 'only by the newer version' })
  })

  it('tells the user which version wrote the data, where the copy is, and once: the next launch of the same version says nothing', () => {
    const path = statePath()
    usedByNewer(path)
    session(path, OLDER, 'https://example.org/b')
    const [copy] = copiesOf(path)
    expect(takePersistenceNotices()).toEqual([{ kind: 'older-version', file: 'state.json', copy, writer: NEWER, running: OLDER }])
    session(path, OLDER, 'https://example.org/c')
    expect(takePersistenceNotices()).toEqual([])
    expect(copiesOf(path)).toEqual([copy])
  })

  it('deletes nothing the state no longer names while that copy is kept: this version may not know what the newer one named', () => {
    const path = statePath()
    session(path, OLDER)
    expect(mayDeleteBackgroundMedia(path, true, OLDER)).toBe(true)
    usedByNewer(path)
    session(path, OLDER, 'https://example.org/b')
    expect(copiesFromNewerVersion(path, OLDER)).toHaveLength(1)
    expect(mayDeleteBackgroundMedia(path, true, OLDER)).toBe(false)
    // Back on the newer version, the copy is one of its own: it knows everything the copy names.
    expect(copiesFromNewerVersion(path, NEWER)).toEqual([])
    expect(mayDeleteBackgroundMedia(path, true, NEWER)).toBe(true)
  })

  describe('when the copy cannot be made', () => {
    const diskFull = () => {
      throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' })
    }

    it('writes nothing over the file in this run, tells the user, and logs it: the file is the only place its data exists', () => {
      const path = statePath()
      const before = usedByNewer(path)
      vi.mocked(copyFileSync).mockImplementation(diskFull)
      try {
        const { loaded, store, saved } = session(path, OLDER, 'https://example.org/b')
        expect(loaded.fromNewerVersion).toBe(true)
        expect(saved).toBe(false)
        expect(writesRefused(path)).toBe(true)
        expect(readFileSync(path, 'utf8')).toBe(before)
        // The session goes on in memory, and no later write gets through either.
        store.dispatch({ type: 'tab/open', url: 'https://example.org/c' })
        expect(store.flush()).toBe(false)
        expect(readFileSync(path, 'utf8')).toBe(before)
        expect(namesBeside(path)).toEqual(['state.json'])
        // One notice, the one that explains it: the failed save has nothing to add.
        expect(takePersistenceNotices()).toEqual([{ kind: 'older-version-kept', file: 'state.json', writer: NEWER, running: OLDER, reason: 'ENOSPC: no space left on device, copyfile' }])
        expect(errors.mock.calls.map((call: unknown[]) => String(call[0])).join('\n')).toMatch(/written by Lucium 0\.3\.1, newer than this 0\.3\.0, and could not be copied \(ENOSPC[^)]*\): nothing is written over it in this run/)
      } finally {
        allowWrites(path)
      }
    })

    it('lets the next launch try again: once the copy can be made, the file is written as usual', () => {
      const path = statePath()
      usedByNewer(path)
      vi.mocked(copyFileSync).mockImplementation(diskFull)
      session(path, OLDER)
      // A new launch is a new process: the refusal does not outlive the run.
      allowWrites(path)
      vi.mocked(copyFileSync).mockImplementation(real.copyFileSync)
      takePersistenceNotices()
      expect(session(path, OLDER, 'https://example.org/b').saved).toBe(true)
      expect(copiesOf(path)).toHaveLength(1)
      expect(fileOf(path)[WRITER_FIELD]).toBe(OLDER)
    })
  })
})

describe('a newer version started over the state of an older one (the update)', () => {
  it('keeps a copy of the file as the older version left it, says nothing, and writes as usual', () => {
    const path = statePath()
    session(path, OLDER, 'https://example.org/a')
    const before = readFileSync(path, 'utf8')
    const { loaded, saved } = session(path, NEWER, 'https://example.org/b')
    expect(loaded).toMatchObject({ readable: true, fromNewerVersion: false })
    expect(saved).toBe(true)
    const copies = copiesOf(path)
    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatch(/-from-0\.3\.0$/)
    expect(readFileSync(copies[0] as string, 'utf8')).toBe(before)
    expect(takePersistenceNotices()).toEqual([])
    expect(mayDeleteBackgroundMedia(path, true, NEWER)).toBe(true)
  })

  it('goes on when the copy cannot be made, and logs why: an update is not held back by a full disk', () => {
    const path = statePath()
    session(path, OLDER, 'https://example.org/a')
    vi.mocked(copyFileSync).mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device, copyfile')
    })
    const { loaded, saved } = session(path, NEWER, 'https://example.org/b')
    expect(loaded.fromNewerVersion).toBe(false)
    expect(saved).toBe(true)
    expect(writesRefused(path)).toBe(false)
    expect(takePersistenceNotices()).toEqual([])
    expect(errors.mock.calls.map((call: unknown[]) => String(call[0])).join('\n')).toMatch(/written by Lucium 0\.3\.0 and could not be copied before this 0\.3\.1 writes it \(ENOSPC[^)]*\); the launch goes on/)
  })

  it('keeps a copy of a file that does not say which version wrote it, under "unknown"', () => {
    const path = statePath()
    new StateStore(loadState(path), path, undefined, SYNC).flush()
    expect(WRITER_FIELD in fileOf(path)).toBe(false)
    const { loaded } = session(path, OLDER)
    expect(loaded.fromNewerVersion).toBe(false)
    expect(copiesOf(path).map((copy) => copy.replace(/^.*-from-/, ''))).toEqual(['unknown'])
    expect(takePersistenceNotices()).toEqual([])
  })
})

describe('the way back to the newer version', () => {
  it('offers the copy made on the way down, once: the state the newer version had left, with what the older one did not keep', () => {
    const path = statePath()
    const before = usedByNewer(path)
    session(path, OLDER, 'https://example.org/b')
    const [down] = copiesOf(path)
    takePersistenceNotices()
    const { loaded } = session(path, NEWER, 'https://example.org/c')
    expect(loaded.fromNewerVersion).toBe(false)
    expect(takePersistenceNotices()).toEqual([{ kind: 'copy-to-resume', file: 'state.json', copy: down }])
    expect(readFileSync(down as string, 'utf8')).toBe(before)
    // The state of the older version is kept too, before the newer one writes it again.
    expect(copiesOf(path).map((copy) => versionOfCopy(copy)).sort()).toEqual([OLDER, NEWER])
    session(path, NEWER, 'https://example.org/d')
    expect(takePersistenceNotices()).toEqual([])
  })

  it('offers the copy to a version above the one that wrote it, and never the copy of a version above the running one', () => {
    const path = statePath()
    writeFileSync(path, '{}')
    const at = (day: number) => new Date(Date.UTC(2026, 10, day, 9, 0, 0))
    const fromNewer = copyOnVersionChange(path, NEWER, at(11))
    expect(copyToResume(path, OLDER, NEWER)).toBe(fromNewer)
    expect(copyToResume(path, OLDER, '0.3.2')).toBe(fromNewer)
    // Not an update, or a file that does not say: nothing to offer.
    expect(copyToResume(path, NEWER, NEWER)).toBeNull()
    expect(copyToResume(path, NEWER, OLDER)).toBeNull()
    expect(copyToResume(path, null, NEWER)).toBeNull()
    // The copy of 0.4.0 is not for 0.3.1 to restore; the copies of the version that wrote the file, or of older ones, hold nothing more than the file.
    const fromLater = copyOnVersionChange(path, '0.4.0', at(12))
    copyOnVersionChange(path, OLDER, at(13))
    expect(copyToResume(path, OLDER, NEWER)).toBe(fromNewer)
    expect(copyToResume(path, OLDER, '0.4.0')).toBe(fromLater)
    expect(copyToResume(path, '0.4.0', '0.5.0')).toBeNull()
  })
})

describe('the launch of the application', () => {
  // The entry point needs Electron, so its source is read: the rules above only hold when the launch gives its version to the read and to the store.
  const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

  it('reads the state with its version, before the store that writes exists, and gives the store the same version', () => {
    expect(index).toMatch(/const loadedState = readState\(statePath, app\.getVersion\(\)\)\n\s*const sharedStore = new StateStore\(loadedState\.state, statePath, undefined, \{ appVersion: app\.getVersion\(\) \}\)/)
  })

  it('deletes what the state no longer names only when the state is not a later version’s', () => {
    expect(index).toMatch(/const stateTrusted = mayDeleteBackgroundMedia\(statePath, loadedState\.readable && !loadedState\.fromNewerVersion, app\.getVersion\(\)\)/)
  })
})

describe('the copies kept on a change of version', () => {
  it('carry their date and the version that wrote the file, never replace one another, and only the three most recent stay', () => {
    const path = statePath()
    writeFileSync(path, 'one')
    const when = new Date(Date.UTC(2026, 10, 10, 8, 30, 5))
    const first = copyOnVersionChange(path, NEWER, when)
    expect(first).toBe(`${path}.version-change-2026-11-10T08-30-05-from-0.3.1`)
    writeFileSync(path, 'two')
    const second = copyOnVersionChange(path, NEWER, when)
    expect(second).toBe(`${first}-1`)
    expect([readFileSync(first, 'utf8'), readFileSync(second, 'utf8')]).toEqual(['one', 'two'])
    expect([versionOfCopy(first), versionOfCopy(second), versionOfCopy(`${path}.version-change-2026-11-10T08-30-05-from-unknown`), versionOfCopy(`${path}.corrupt-1`)]).toEqual([NEWER, NEWER, null, null])
    for (let day = 11; day <= 14; day++) copyOnVersionChange(path, OLDER, new Date(Date.UTC(2026, 10, day)))
    const kept = copiesOf(path)
    expect(kept).toHaveLength(SIDE_FILES_KEPT)
    expect(kept.map((copy) => copy.slice(`${path}.version-change-`.length))).toEqual(['2026-11-14T00-00-00-from-0.3.0', '2026-11-13T00-00-00-from-0.3.0', '2026-11-12T00-00-00-from-0.3.0'])
  })

  it('are not taken for files set aside as damaged or of a newer format', () => {
    const path = statePath()
    writeFileSync(path, '{}')
    copyOnVersionChange(path, OLDER)
    expect(sideFiles(path, 'corrupt')).toEqual([])
    expect(sideFiles(path, 'future')).toEqual([])
    expect(sideFiles(path, 'avant-restauration')).toEqual([])
  })
})
