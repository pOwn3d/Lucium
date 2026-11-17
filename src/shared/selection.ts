// Multiple selection of sidebar tabs (⌘-click, ⇧-click). It is interface state, never saved: the pure rules live here.

import { copyableUrl, formatCopiedUrl } from './copy-url'
import { tabName, type TabItem } from './model'
import { t, tp } from './i18n'

export interface Selection {
  /** The selected tabs, in sidebar order. Empty or one tab means "no multiple selection". */
  ids: string[]
  /** Where a ⇧-click starts its range: the tab clicked last. */
  anchor: string | null
}

export const NO_SELECTION: Selection = { ids: [], anchor: null }

export interface ClickModifiers {
  /** ⌘ (Ctrl elsewhere): add the tab to the selection or take it out. */
  toggle: boolean
  /** ⇧: select everything between the anchor and the tab. */
  range: boolean
}

export interface ClickOutcome {
  selection: Selection
  /** The click also makes the tab the one shown (a plain click does, a ⌘ or ⇧ click only changes the selection). */
  activate: boolean
}

const inOrder = (ids: Iterable<string>, order: string[]): string[] => {
  const wanted = new Set(ids)
  return order.filter((id) => wanted.has(id))
}

/** One tab is not a multiple selection: it collapses to nothing, so the sidebar shows a plain selected tab. */
const settle = (ids: string[], anchor: string | null): Selection => ({ ids: ids.length >= 2 ? ids : [], anchor })

/**
 * What a click on a row does to the selection. `order` is the rows on screen, top to bottom (a tab hidden in a collapsed
 * folder cannot be clicked, so it is not in it); `activeId` is the tab being shown, which counts as selected when the
 * first ⌘-click or ⇧-click starts a selection.
 */
export function clickSelection(current: Selection, id: string, mods: ClickModifiers, order: string[], activeId: string | null): ClickOutcome {
  const plain: ClickOutcome = { selection: { ids: [], anchor: id }, activate: true }
  if (!order.includes(id)) return plain

  if (mods.range) {
    const from = current.anchor && order.includes(current.anchor) ? current.anchor : activeId && order.includes(activeId) ? activeId : null
    if (!from) return plain
    const a = order.indexOf(from)
    const b = order.indexOf(id)
    return { selection: settle(order.slice(Math.min(a, b), Math.max(a, b) + 1), from), activate: false }
  }

  if (mods.toggle) {
    const base = current.ids.length > 0 ? current.ids : activeId && order.includes(activeId) ? [activeId] : []
    // With nothing selected yet and nothing shown, there is no selection to extend: the click selects the tab.
    if (base.length === 0) return plain
    const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id]
    return { selection: settle(inOrder(next, order), id), activate: false }
  }

  return plain
}

/** Drops the tabs that are gone (closed, archived, in a collapsed folder or another space) from a selection. */
export function pruneSelection(current: Selection, valid: Set<string>): Selection {
  const ids = current.ids.filter((id) => valid.has(id))
  if (ids.length === current.ids.length && (current.anchor === null || valid.has(current.anchor))) return current
  return settle(ids, current.anchor && valid.has(current.anchor) ? current.anchor : null)
}

/** The ids of the selection that are really tabs, in the order of `order`. */
export function selectedInOrder(current: Selection, order: string[]): string[] {
  return inOrder(current.ids, order)
}

/** One `[title](url)` line per tab. Parentheses in the address are percent-encoded so they cannot close the link early. */
export function markdownLinks(tabs: Array<Pick<TabItem, 'url' | 'title' | 'customTitle'>>, strip = false): string {
  return tabs
    .map((tab) => formatCopiedUrl('markdown', { url: copyableUrl(tab.url, strip).replace(/\(/g, '%28').replace(/\)/g, '%29'), title: tabName(tab), selection: '' }))
    .join('\n')
}

export interface GroupSummary {
  count: number
  /** Today tabs: the ones "Archive" takes (a pinned tab is only put to sleep). */
  archivable: number
  pinned: number
  allPinned: boolean
}

export function groupSummary(tabs: Array<Pick<TabItem, 'pinned'>>): GroupSummary {
  const pinned = tabs.filter((t) => t.pinned).length
  return { count: tabs.length, archivable: tabs.length - pinned, pinned, allPinned: tabs.length > 0 && pinned === tabs.length }
}

/** The wording of the group menu for a selection. */
export function groupLabels(summary: GroupSummary): { archive: string; pin: string; close: string; copyLinks: string; newFolder: string } {
  return {
    archive: tp('selection.archiver-count-onglets', summary.archivable),
    pin: summary.allPinned ? tp('selection.desepingler-count-onglets', summary.count) : tp('selection.epingler-count-onglets', summary.count - summary.pinned),
    close: tp('selection.fermer-count-onglets', summary.count),
    copyLinks: t('selection.copier-les-liens-en-markdown'),
    newFolder: t('selection.nouveau-dossier-avec-la-selection')
  }
}

/**
 * The one row of the list the Tab key stops on: the tab on screen when it has a row, else the first row (the arrow keys go on from there). A list
 * of three hundred rows that were all stops would cost three hundred presses to get past it.
 */
export function tabStop(order: readonly string[], activeId: string | null | undefined): string | null {
  return activeId !== null && activeId !== undefined && order.includes(activeId) ? activeId : (order[0] ?? null)
}
