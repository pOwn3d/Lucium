// The layout bar under a split view of two panes: 30 / 70, 50 / 50, 70 / 30, "Échanger" and, while the setting that offers it is on,
// "Défilement synchronisé". What the bar shows and what each button does are decided here; the UI only draws the items and runs their actions.

import { t } from './i18n'
import { tabName, type SidebarState } from './model'
import type { SplitView } from './model'
import type { Action } from './sidebar'
import { hasSplitBar } from './split'

/** The share of the first pane of each ratio button. */
export const SPLIT_PRESETS = [0.3, 0.5, 0.7] as const

/** Two shares are the same preset when they are within half a percent (a drag never lands exactly on a preset). */
const PRESET_TOLERANCE = 0.005

export type SplitBarItem =
  | { kind: 'ratio'; first: number; pressed: boolean }
  | { kind: 'swap' }
  | { kind: 'sync'; pressed: boolean }

/**
 * The buttons of the bar of a split view, in order. None for a split view that has no bar (more than two panes). "Défilement synchronisé" is there
 * only while the setting "Défilement synchronisé des volets" is on (`scrollSync`); `synced` is whether this split view scrolls together now.
 */
export function splitBarItems(split: SplitView, options: { scrollSync: boolean; synced: boolean }): SplitBarItem[] {
  if (!hasSplitBar(split)) return []
  const first = split.ratios[0] ?? 0.5
  return [
    ...SPLIT_PRESETS.map((share): SplitBarItem => ({ kind: 'ratio', first: share, pressed: Math.abs(first - share) < PRESET_TOLERANCE })),
    { kind: 'swap' },
    ...(options.scrollSync ? [{ kind: 'sync', pressed: options.synced } satisfies SplitBarItem] : [])
  ]
}

/** The reducer action of a button. "Échanger" is the move of the first pane one place on: the two pages trade places and each keeps its size. "Défilement synchronisé" is not a state change of the sidebar (null). */
export function splitBarAction(split: SplitView, item: SplitBarItem): Action | null {
  if (!hasSplitBar(split)) return null
  if (item.kind === 'ratio') return { type: 'split/ratios', id: split.id, ratios: [item.first, 1 - item.first] }
  if (item.kind === 'swap') return { type: 'split/move', tabId: split.tabIds[0]!, direction: 1 }
  return null
}

/** "30 / 70": what a ratio button says. */
export const presetLabel = (first: number): string => `${Math.round(first * 100)} / ${100 - Math.round(first * 100)}`

/** The name of a closed pane in the notice: long titles are cut. */
const NOTICE_TITLE_MAX = 32
const clipTitle = (title: string): string => (title.length > NOTICE_TITLE_MAX ? `${title.slice(0, NOTICE_TITLE_MAX - 1).trimEnd()}…` : title)

/**
 * After a pane left its split view: the notice the sidebar shows ("Volet « X » fermé") and the action of its "Annuler", which puts the
 * split view back as it was (same panes, same order, same shares). Null when the action was not the closing of a pane, or changed nothing.
 */
export function paneClosedUndo(before: SidebarState, after: SidebarState, action: Action): { notice: string; undo: Action } | null {
  if (action.type !== 'split/remove') return null
  const split = before.splits.find((sp) => sp.tabIds.includes(action.tabId))
  const tab = before.tabs.find((candidate) => candidate.id === action.tabId)
  if (!split || !tab) return null
  const now = after.splits.find((sp) => sp.id === split.id)
  // Nothing happened when the tab is still in the split view it was in.
  if (now?.tabIds.includes(tab.id)) return null
  return { notice: t('split-bar.volet-title-ferme', { title: clipTitle(tabName(tab)) }), undo: { type: 'split/restore', split } }
}
