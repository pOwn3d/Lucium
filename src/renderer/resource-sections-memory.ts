// The folded blocks of the resource panel, kept while the window lives: a panel closed and opened again finds them as they were left (as its sort and
// its longer list). Never persisted.

import { DEFAULT_SECTIONS, type ResourceSections } from '@shared/resource-sections'

let sections: ResourceSections = DEFAULT_SECTIONS
const listeners = new Set<() => void>()

/** The same object until something changes (what `useSyncExternalStore` needs). */
export function sectionsMemory(): ResourceSections {
  return sections
}

export function subscribeSections(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function updateSections(change: (now: ResourceSections) => ResourceSections): void {
  sections = change(sections)
  for (const listener of [...listeners]) listener()
}

/** Back to the defaults (tests). */
export function resetSectionsMemory(): void {
  sections = DEFAULT_SECTIONS
  listeners.clear()
}
