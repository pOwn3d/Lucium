import { existsSync, mkdirSync, readFileSync, readdirSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATA_FILE_MAX_BYTES, SIDE_FILES_KEPT, backUpBeforeRestore, copyBeforeRestore, firstFree, lastSetAsideAt, pruneSideFiles, readTextBounded, setAside, sideFiles, writeFileAtomic, writeFileAtomicAsync } from './persist'
import { StateStore, loadState } from './store'
import { HistoryStore } from './history'
import { takePersistenceNotices } from './persistence-notices'
import { tempDir } from './temp-dir'

const dir = () => tempDir('lucium-persist-')
const names = (folder: string) => readdirSync(folder).sort()

beforeEach(() => {
  takePersistenceNotices()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('reading a data file with a bound', () => {
  it('reads a regular file up to the bound and refuses what is larger, with its name and its size', () => {
    const folder = dir()
    const path = join(folder, 'state.json')
    writeFileSync(path, 'abcd')
    expect(readTextBounded(path, 4)).toBe('abcd')
    expect(() => readTextBounded(path, 3)).toThrow(/state\.json is 4 bytes, more than the 3/)
  })

  it('refuses what is not a regular file, and says a missing one is missing (the callers tell a first run by the code)', () => {
    const folder = dir()
    mkdirSync(join(folder, 'folder'))
    expect(() => readTextBounded(join(folder, 'folder'), 100)).toThrow(/not a regular file/)
    expect(() => readTextBounded(join(folder, 'absent.json'), 100)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })

  it('makes loadState set a state file beyond the bound aside instead of reading it whole, and start afresh', () => {
    const folder = dir()
    const path = join(folder, 'state.json')
    writeFileSync(path, '')
    // A sparse file: it costs no disk, and reading it whole would cost the memory of its size.
    truncateSync(path, DATA_FILE_MAX_BYTES + 1)
    expect(loadState(path).spaces).toHaveLength(1)
    expect(names(folder).filter((n) => n.startsWith('state.json.corrupt-'))).toHaveLength(1)
    expect(takePersistenceNotices()).toEqual([expect.objectContaining({ kind: 'set-aside', file: 'state.json', reason: expect.stringContaining('more than the') })])
  })
})

describe('the file of a more recent version', () => {
  it('is set aside under its own name, and the damaged ones that come after never push it out', () => {
    const folder = dir()
    const path = join(folder, 'state.json')
    writeFileSync(path, '{"version":2}')
    expect(setAside(path, 100, 'future')).toBe(join(folder, 'state.json.future-100'))
    for (let n = 1; n <= SIDE_FILES_KEPT + 2; n++) {
      writeFileSync(path, `{ broken ${n}`)
      setAside(path, n * 1000)
    }
    expect(names(folder).filter((n) => n.includes('.future-'))).toEqual(['state.json.future-100'])
    expect(names(folder).filter((n) => n.includes('.corrupt-'))).toHaveLength(SIDE_FILES_KEPT)
    expect(readFileSync(join(folder, 'state.json.future-100'), 'utf8')).toBe('{"version":2}')
  })

  it('keeps the three most recent of them, as the damaged ones are', () => {
    const folder = dir()
    const path = join(folder, 'state.json')
    for (let n = 1; n <= SIDE_FILES_KEPT + 2; n++) {
      writeFileSync(path, `{"version":${n + 1}}`)
      setAside(path, n * 1000, 'future')
    }
    expect(names(folder)).toEqual(['state.json.future-3000', 'state.json.future-4000', 'state.json.future-5000'])
  })
})

describe('the files set aside next to a data file', () => {
  it('keeps the three most recent of each sort, whatever the order they were made in, and touches nothing else', () => {
    const folder = dir()
    const path = join(folder, 'state.json')
    writeFileSync(path, 'live')
    writeFileSync(join(folder, 'history.json.corrupt-1'), 'another file’s')
    // Milliseconds of different lengths: 999 is older than 1000 although "999" sorts after "1000" as text.
    for (const time of [1000, 999, 20_000, 5, 300_000]) writeFileSync(join(folder, `state.json.corrupt-${time}`), String(time))
    for (const day of ['09', '10', '11', '12', '13']) writeFileSync(join(folder, `state.json.avant-restauration-2026-10-${day}T10-00-00`), day)

    pruneSideFiles(path, 'corrupt')

    expect(names(folder).filter((n) => n.includes('.corrupt-') && n.startsWith('state'))).toEqual(['state.json.corrupt-1000', 'state.json.corrupt-20000', 'state.json.corrupt-300000'])
    expect(names(folder)).toContain('history.json.corrupt-1')
    expect(names(folder)).toContain('state.json')
    expect(names(folder).filter((n) => n.includes('avant-restauration'))).toHaveLength(5)

    pruneSideFiles(path, 'avant-restauration')
    expect(names(folder).filter((n) => n.includes('avant-restauration'))).toEqual([
      'state.json.avant-restauration-2026-10-11T10-00-00',
      'state.json.avant-restauration-2026-10-12T10-00-00',
      'state.json.avant-restauration-2026-10-13T10-00-00'
    ])
  })

  it('lists the most recent first', () => {
    const folder = dir()
    for (const time of [9, 10, 100]) writeFileSync(join(folder, `state.json.corrupt-${time}`), '')
    expect(sideFiles(join(folder, 'state.json'), 'corrupt').map((p) => p.split('corrupt-')[1])).toEqual(['100', '10', '9'])
  })

  it('purges when an unreadable file is put aside: five breakdowns leave three files, the latest', () => {
    const folder = dir()
    const path = join(folder, 'state.json')
    for (let n = 1; n <= 5; n++) {
      writeFileSync(path, `{ broken ${n}`)
      setAside(path, n * 1000)
    }
    expect(names(folder)).toEqual(['state.json.corrupt-3000', 'state.json.corrupt-4000', 'state.json.corrupt-5000'])
    expect(readFileSync(join(folder, 'state.json.corrupt-5000'), 'utf8')).toBe('{ broken 5')
    expect(SIDE_FILES_KEPT).toBe(3)
  })

  it('puts aside two files in the same millisecond without one replacing the other', () => {
    const folder = dir()
    const path = join(folder, 'state.json')
    writeFileSync(path, 'first')
    const a = setAside(path, 7)
    writeFileSync(path, 'second')
    const b = setAside(path, 7)
    expect(a).not.toBe(b)
    expect([readFileSync(a, 'utf8'), readFileSync(b, 'utf8')]).toEqual(['first', 'second'])
  })

  it('copies before a restoration under a name that is never reused, and purges its own sort', () => {
    const folder = dir()
    const path = join(folder, 'state.json')
    writeFileSync(path, 'current')
    const when = new Date('2026-10-24T09:00:00Z')
    const first = copyBeforeRestore(path, when)
    writeFileSync(path, 'newer')
    const second = copyBeforeRestore(path, when)
    expect(first).not.toBe(second)
    expect([readFileSync(first, 'utf8'), readFileSync(second, 'utf8')]).toEqual(['current', 'newer'])
    for (let n = 1; n <= 5; n++) copyBeforeRestore(path, new Date(Date.UTC(2026, 9, 24, 10, n)))
    expect(sideFiles(path, 'avant-restauration')).toHaveLength(3)
    expect(readFileSync(path, 'utf8')).toBe('newer')
  })
})

describe('when a state file was last set aside', () => {
  it('is the latest time written in the names of the damaged and newer files, whatever else is in the folder', () => {
    const folder = dir()
    const path = join(folder, 'state.json')
    expect(lastSetAsideAt(path)).toBeUndefined()
    writeFileSync(path, '{')
    expect(setAside(path, 1_700_000_000_000)).toBe(`${path}.corrupt-1700000000000`)
    writeFileSync(join(folder, 'history.json.corrupt-1800000000000'), 'another file’s')
    writeFileSync(join(folder, 'state.json.avant-restauration-2026-10-09T10-00-00'), 'x')
    expect(lastSetAsideAt(path)).toBe(1_700_000_000_000)
    writeFileSync(path, '{')
    setAside(path, 1_700_000_500_000, 'future')
    // Two set aside in the same millisecond: the second has a counter after its time.
    writeFileSync(path, '{')
    setAside(path, 1_700_000_500_000, 'future')
    expect(names(folder)).toContain('state.json.future-1700000500000-1')
    expect(lastSetAsideAt(path)).toBe(1_700_000_500_000)
  })

  it('is unknown, with a line in the journal, when the folder cannot be listed', () => {
    const error = vi.mocked(console.error)
    expect(lastSetAsideAt(join(dir(), 'gone', 'state.json'))).toBeUndefined()
    expect(error.mock.calls.some(([line]) => String(line).includes('cannot list the files set aside'))).toBe(true)
  })
})

describe('firstFree', () => {
  it('answers the name itself, or the first free numbered one, with the extension at the end', () => {
    const folder = dir()
    const base = join(folder, 'capture-2026-10-24T10-00-00')
    expect(firstFree(base, '.png')).toBe(`${base}.png`)
    writeFileSync(`${base}.png`, '')
    expect(firstFree(base, '.png')).toBe(`${base}-1.png`)
    writeFileSync(`${base}-1.png`, '')
    expect(firstFree(base, '.png')).toBe(`${base}-2.png`)
    expect(firstFree(base)).toBe(base)
  })
})

describe('what a real run leaves behind', () => {
  it('loadState keeps at most three corrupt copies over many runs, and tells the user each time', () => {
    const folder = dir()
    const path = join(folder, 'state.json')
    let backups = 0
    for (let run = 1; run <= 5; run++) {
      writeFileSync(path, `{ broken ${run}`)
      vi.spyOn(Date, 'now').mockReturnValue(1_000 * run)
      expect(loadState(path).spaces).toHaveLength(1)
      backups += takePersistenceNotices().filter((n) => n.kind === 'set-aside').length
    }
    expect(backups).toBe(5)
    expect(names(folder)).toEqual(['state.json.corrupt-3000', 'state.json.corrupt-4000', 'state.json.corrupt-5000'])
  })

  it('a corrupt state is reported with the file, the reason and where it went', () => {
    const folder = dir()
    const path = join(folder, 'state.json')
    writeFileSync(path, '{ not json')
    loadState(path)
    const [notice] = takePersistenceNotices()
    expect(notice).toMatchObject({ kind: 'set-aside', file: 'state.json' })
    if (notice?.kind !== 'set-aside') throw new Error('unreachable')
    expect(notice.reason).toMatch(/JSON|token/i)
    expect(existsSync(notice.backup)).toBe(true)
    expect(readFileSync(notice.backup, 'utf8')).toBe('{ not json')
  })

  it('a readable state raises no notice', () => {
    const path = join(dir(), 'state.json')
    new StateStore(loadState(path), path).flush()
    loadState(path)
    expect(takePersistenceNotices()).toEqual([])
  })

  it('a corrupt history is set aside and reported too, and starts empty', () => {
    const folder = dir()
    const path = join(folder, 'history.json')
    writeFileSync(path, '{"not": "an array"}')
    const history = new HistoryStore(path)
    expect(history.size()).toBe(0)
    expect(takePersistenceNotices()).toMatchObject([{ kind: 'set-aside', file: 'history.json' }])
    expect(names(folder).filter((n) => n.startsWith('history.json.corrupt-'))).toHaveLength(1)
  })
})

describe('backUpBeforeRestore', () => {
  it('saves the state first and copies the file', () => {
    const path = join(dir(), 'state.json')
    writeFileSync(path, 'on disk')
    const flush = vi.fn(() => true)
    expect(backUpBeforeRestore(flush, path)).toBeNull()
    expect(flush).toHaveBeenCalledOnce()
    expect(sideFiles(path, 'avant-restauration')).toHaveLength(1)
  })

  it('needs no copy when there is no file yet', () => {
    expect(backUpBeforeRestore(() => true, join(dir(), 'state.json'))).toBeNull()
  })

  it('gives the reason, and copies nothing, when the current state cannot be saved first', () => {
    const path = join(dir(), 'state.json')
    writeFileSync(path, 'old')
    expect(backUpBeforeRestore(() => false, path)).toMatch(/n’a pas pu être enregistré/)
    expect(sideFiles(path, 'avant-restauration')).toEqual([])
  })
})

describe('a write that fails', () => {
  /** A place the rename cannot take: a folder that holds a file stands where the file goes. */
  const blocked = (): string => {
    const path = join(dir(), 'state.json')
    mkdirSync(path)
    writeFileSync(join(path, 'inside'), 'x')
    return path
  }

  it('removes its temporary file when the rename is refused, and lets the failure through', () => {
    const path = blocked()
    expect(() => writeFileAtomic(path, '{"complete":"copy"}')).toThrow()
    expect(existsSync(`${path}.tmp`)).toBe(false)
    expect(names(join(path, '..'))).toEqual(['state.json'])
  })

  it('does the same when it does not hold the process', async () => {
    const path = blocked()
    await expect(writeFileAtomicAsync(path, '{"complete":"copy"}', () => true)).rejects.toThrow()
    expect(existsSync(`${path}.tmp-async`)).toBe(false)
    expect(names(join(path, '..'))).toEqual(['state.json'])
  })

  it('still puts the file in place when nothing stands in the way', async () => {
    const path = join(dir(), 'state.json')
    writeFileAtomic(path, 'one')
    expect(await writeFileAtomicAsync(path, 'two', () => true)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('two')
    expect(names(join(path, '..'))).toEqual(['state.json'])
  })
})
