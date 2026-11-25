import { describe, expect, it } from 'vitest'
import { DEFAULT_SECTIONS, allFolded, setAllSections, toggleDetails, toggleSection, warningShown } from './resource-sections'

describe('the folded blocks of the resource panel', () => {
  it('starts with every block open and the long texts closed', () => {
    expect(DEFAULT_SECTIONS.open).toEqual({ tabs: true, others: true, release: true })
    expect(DEFAULT_SECTIONS.details).toBe(false)
  })

  it('folds one block without touching the others, and does not change the object it was given', () => {
    const next = toggleSection(DEFAULT_SECTIONS, 'others')
    expect(next.open).toEqual({ tabs: true, others: false, release: true })
    expect(DEFAULT_SECTIONS.open.others).toBe(true)
    expect(toggleSection(next, 'others').open.others).toBe(true)
  })

  it('folds and unfolds all, and says when all are folded', () => {
    const none = setAllSections(DEFAULT_SECTIONS, false)
    expect(allFolded(none)).toBe(true)
    expect(allFolded(toggleSection(none, 'tabs'))).toBe(false)
    expect(setAllSections(none, true).open).toEqual(DEFAULT_SECTIONS.open)
    expect(setAllSections(toggleDetails(DEFAULT_SECTIONS), false).details).toBe(true)
  })

  it('shows the warning of the strongest strength when it is engaged, runs, or the details are open, not otherwise', () => {
    expect(warningShown({ details: false, engaged: false, running: false })).toBe(false)
    expect(warningShown({ details: true, engaged: false, running: false })).toBe(true)
    expect(warningShown({ details: false, engaged: true, running: false })).toBe(true)
    expect(warningShown({ details: false, engaged: false, running: true })).toBe(true)
  })
})
