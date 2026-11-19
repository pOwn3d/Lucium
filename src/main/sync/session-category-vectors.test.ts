// The categories announced and taken as common (docs/synchronisation.md §10.1, card 516), held together with LuciumKit by ios/Contracts/sync-categories-vectors.json:
// this plays the file against the Mac's functions, SyncCategoryTests.swift plays it against the phone's. Change one side and the other fails.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NEEDS_STRUCTURE, SYNC_CATEGORIES, type SyncCategory } from '@shared/sync-ipc'
import { announcedCategories, commonCategories } from './session'

interface Vectors {
  order: SyncCategory[]
  needStructure: SyncCategory[]
  announced: Array<{ ticked: SyncCategory[]; announced: SyncCategory[] }>
  common: Array<{ ticked: SyncCategory[]; theirs: string[]; common: SyncCategory[] }>
}

const vectors = JSON.parse(readFileSync(join(__dirname, '../../../ios/Contracts/sync-categories-vectors.json'), 'utf8')) as Vectors
const inOrder = (set: ReadonlySet<SyncCategory>): SyncCategory[] => SYNC_CATEGORIES.filter((category) => set.has(category))

describe('the shared vectors of the categories', () => {
  it('name the categories in the order of the code, and the ones that need the structure', () => {
    expect(vectors.order).toEqual([...SYNC_CATEGORIES])
    expect([...NEEDS_STRUCTURE].sort()).toEqual(vectors.needStructure)
  })

  it('give what a device announces for each set of categories it ticked', () => {
    expect(vectors.announced).toHaveLength(2 ** SYNC_CATEGORIES.length)
    for (const vector of vectors.announced) expect(inOrder(announcedCategories(new Set(vector.ticked))), `ticked [${vector.ticked}]`).toEqual(vector.announced)
  })

  it('give the categories a session takes as common', () => {
    expect(vectors.common.length).toBeGreaterThan(256)
    for (const vector of vectors.common) expect(inOrder(commonCategories(announcedCategories(new Set(vector.ticked)), vector.theirs)), `ticked [${vector.ticked}] with [${vector.theirs}]`).toEqual(vector.common)
  })
})
