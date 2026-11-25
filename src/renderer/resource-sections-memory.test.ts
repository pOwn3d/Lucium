import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toggleDetails, toggleSection } from '@shared/resource-sections'
import { resetSectionsMemory, sectionsMemory, subscribeSections, updateSections } from './resource-sections-memory'

beforeEach(resetSectionsMemory)

describe('the folded blocks kept while the window lives', () => {
  it('finds them as they were left when the panel opens again, and starts with everything open', () => {
    expect(sectionsMemory().open.tabs).toBe(true)
    updateSections((now) => toggleSection(now, 'tabs'))
    updateSections(toggleDetails)
    expect(sectionsMemory().open.tabs).toBe(false)
    expect(sectionsMemory().details).toBe(true)
  })

  it('tells the panels that listen, and the same object comes back until something changes', () => {
    const listener = vi.fn()
    const off = subscribeSections(listener)
    const before = sectionsMemory()
    expect(sectionsMemory()).toBe(before)
    updateSections((now) => toggleSection(now, 'release'))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(sectionsMemory()).not.toBe(before)
    off()
    updateSections((now) => toggleSection(now, 'release'))
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
