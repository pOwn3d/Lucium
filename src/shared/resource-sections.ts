// Which blocks of the resource panel are folded away (ResourcePanel.tsx). Pure logic: the panel keeps the result for the window's life, like its sort.

/** The blocks the person can fold: the list of tabs, « Autres processus » and « Libérer maintenant ». */
export const RESOURCE_SECTIONS = ['tabs', 'others', 'release'] as const
export type ResourceSection = (typeof RESOURCE_SECTIONS)[number]

/** Open or folded, for each block, and whether the long texts of « Libérer maintenant » are shown (« Détails »). */
export interface ResourceSections {
  open: Record<ResourceSection, boolean>
  details: boolean
}

/** Every block open (what the panel always was), the long texts behind « Détails ». */
export const DEFAULT_SECTIONS: ResourceSections = { open: { tabs: true, others: true, release: true }, details: false }

export function toggleSection(sections: ResourceSections, section: ResourceSection): ResourceSections {
  return { ...sections, open: { ...sections.open, [section]: !sections.open[section] } }
}

export function toggleDetails(sections: ResourceSections): ResourceSections {
  return { ...sections, details: !sections.details }
}

/** All blocks are folded: the button next to the sort then unfolds them, otherwise it folds them. */
export function allFolded(sections: ResourceSections): boolean {
  return RESOURCE_SECTIONS.every((section) => !sections.open[section])
}

export function setAllSections(sections: ResourceSections, open: boolean): ResourceSections {
  return { ...sections, open: { tabs: open, others: open, release: open } }
}

/**
 * The warning of the strongest strength costs notifications, so it is never left behind « Détails » at the moment of the action: it shows when the person
 * has the pointer or the focus on « Fort », while that strength runs, or when « Détails » is open.
 */
export function warningShown(state: { details: boolean; engaged: boolean; running: boolean }): boolean {
  return state.details || state.engaged || state.running
}
