// The sweep of the pictures of spaces keeps what a copy of the session still names: putting the copy back brings the picture back. Against real folders.
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarState } from '@shared/model'
import { copyDataOf } from '@shared/session-backups'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { BackupFiles } from '../backup-store'
import { tempDir } from '../temp-dir'
import { imagesNamedByCopies, sweepStoredImages } from './space-image-sweep'
import { onWindows } from '../windows.test-support'
import { SpaceImageStore } from './space-images'

const IN_STATE = 'aaaaaaaaaaaaaaaaaaaaaaaa.png'
const IN_COPY = 'bbbbbbbbbbbbbbbbbbbbbbbb.png'
const IN_TAB_OF_COPY = 'cccccccccccccccccccccccc.png'
const BEFORE_RESTORE = 'dddddddddddddddddddddddd.png'
const ORPHAN = 'eeeeeeeeeeeeeeeeeeeeeeee.png'

let n = 0
const ctx = () => ({ now: 1_700_000_000_000, newId: () => `id${++n}` })
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx()), state)

let root: string
let warnings: unknown[][]
const stored = (): string[] => readdirSync(join(root, 'space-images')).sort()
const store = (): SpaceImageStore => new SpaceImageStore(join(root, 'space-images'), { shrink: async () => Buffer.alloc(0) })

/** A state whose first space wears `image`, with one tab that wears `tabImage` when given. */
function stateWith(image: string, tabImage?: string): SidebarState {
  let state = run(createInitialState(ctx()), { type: 'tab/open', url: 'https://a.example/', background: true })
  state = run(state, { type: 'space/image', id: state.spaces[0]!.id, image })
  return tabImage ? { ...state, tabs: state.tabs.map((tab) => ({ ...tab, image: tabImage })) } : state
}

beforeEach(() => {
  root = tempDir('lucium-image-sweep-')
  mkdirSync(join(root, 'space-images'))
  for (const name of [IN_STATE, IN_COPY, IN_TAB_OF_COPY, BEFORE_RESTORE, ORPHAN]) writeFileSync(join(root, 'space-images', name), 'x')
  warnings = []
  vi.spyOn(console, 'warn').mockImplementation((...args) => void warnings.push(args))
})
afterEach(() => vi.restoreAllMocks())

describe('the sweep of the pictures of spaces and tabs', () => {
  it('keeps the pictures an automatic copy names, for a space or for a tab, and those the copy made before a restoration names', () => {
    new BackupFiles(join(root, 'session-backups')).write({ createdAt: 1_700_000_000_000, reason: 'auto', data: copyDataOf(stateWith(IN_COPY, IN_TAB_OF_COPY)) }, 5)
    writeFileSync(join(root, 'state.json.avant-restauration-2026-11-03T10-00-00'), JSON.stringify({ version: 1, spaces: [{ id: 's', image: BEFORE_RESTORE }] }))
    expect(sweepStoredImages(store(), stateWith(IN_STATE), root)).toBe(1)
    expect(stored()).toEqual([IN_STATE, IN_COPY, IN_TAB_OF_COPY, BEFORE_RESTORE])
  })

  it('deletes what no copy names: without copies, only the pictures of the state stay', () => {
    expect(sweepStoredImages(store(), stateWith(IN_STATE), root)).toBe(4)
    expect(stored()).toEqual([IN_STATE])
  })

  it('does not open the copies when no picture would go', () => {
    const asked = vi.fn(() => new Set<string>())
    expect(store().sweep(new Set([IN_STATE, IN_COPY, IN_TAB_OF_COPY, BEFORE_RESTORE, ORPHAN]), asked)).toBe(0)
    expect(asked).not.toHaveBeenCalled()
  })

  // Windows: `chmod 000` does not make a file unreadable there (it only sets the read-only flag).
  it.skipIf(onWindows)('deletes no picture when a copy made before a restoration cannot be read, and says so', () => {
    const copy = join(root, 'state.json.avant-restauration-2026-11-03T10-00-00')
    writeFileSync(copy, '{}')
    chmodSync(copy, 0o000)
    writeFileSync(join(root, 'space-images', `${ORPHAN}.tmp`), 'x')
    expect(imagesNamedByCopies(root)).toBeNull()
    // The leftover of an unfinished import is nobody's picture: it goes all the same.
    expect(sweepStoredImages(store(), stateWith(IN_STATE), root)).toBe(1)
    expect(stored()).toEqual([IN_STATE, IN_COPY, IN_TAB_OF_COPY, BEFORE_RESTORE, ORPHAN])
    expect(warnings.some(([line]) => String(line).includes('picture(s) nothing in the state names are kept'))).toBe(true)
    expect(warnings.some(([line]) => String(line).includes('[space image] the copy') && String(line).includes('no picture is deleted'))).toBe(true)
  })

  it('skips an automatic copy that cannot be read, with a line in the journal: it cannot be restored either', () => {
    mkdirSync(join(root, 'session-backups'))
    writeFileSync(join(root, 'session-backups', 'copie-1700000000000.json'), 'not a copy')
    expect(imagesNamedByCopies(root)).toEqual(new Set())
    expect(warnings.some(([line]) => String(line).includes('[space image] the automatic copy copie-1700000000000 could not be read; its pictures are not kept'))).toBe(true)
  })
})
