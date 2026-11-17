// What the first-launch guide (FirstLaunchSheet.tsx) does with the choices made in it: the appearance and
// the blocker go to the settings, the colour to the space on screen, and the browser chosen is imported with the import service of the sheet
// « Importer depuis un autre navigateur… » (a preview, then its confirmation). Kept apart from React so that it can be tested.

import type { Action } from '@shared/sidebar'
import type { ImportCategory, ImportReport, ImportRequest } from '@shared/import-sources'
import type { OverlayRequest } from '@shared/ipc'
import type { Settings, SidebarState } from '@shared/model'
import { adsBlockingPatch } from '@shared/privacy-dashboard'
import { GUIDED_SETUP_REQUEST } from '@shared/settings-guide'

/** The colours the guide offers for the first space, by name: the one the space has now comes first and changes nothing. */
export const FIRST_LAUNCH_COLORS = [
  { id: 'persimmon', hex: '#d84e54' },
  { id: 'bluegreen', hex: '#2b8e82' },
  { id: 'deepviolet', hex: '#43299f' },
  { id: 'sunburst', hex: '#e8a800' }
] as const
export type FirstLaunchColor = (typeof FIRST_LAUNCH_COLORS)[number]['id']

/** The choices of the guide. A field left `null` is a choice the user did not touch: the setting keeps its value. */
export interface FirstLaunchChoices {
  appearance: Settings['interfaceAppearance'] | null
  blocker: boolean | null
  color: FirstLaunchColor | null
  /** The browser to import from, or null for none (start empty). */
  source: string | null
  profile?: string
  categories: ImportCategory[]
  /** Once the guide is done, open the complete configuration of the Settings (offered, never ticked for the user). */
  quickSetup: boolean
}

export const NO_CHOICES: FirstLaunchChoices = { appearance: null, blocker: null, color: null, source: null, categories: [], quickSetup: false }

/** The actions that record the choices: the settings changed, and the colour of the space on screen. Nothing for a choice left as it was. */
export function firstLaunchActions(choices: FirstLaunchChoices, state: Pick<SidebarState, 'spaces' | 'activeSpaceId'>): Action[] {
  const actions: Action[] = []
  const patch: Partial<Settings> = {
    ...(choices.appearance !== null ? { interfaceAppearance: choices.appearance } : {}),
    ...(choices.blocker !== null ? adsBlockingPatch(choices.blocker) : {})
  }
  if (Object.keys(patch).length > 0) actions.push({ type: 'settings/update', patch })
  const hex = FIRST_LAUNCH_COLORS.find((color) => color.id === choices.color)?.hex
  const space = state.spaces.find((sp) => sp.id === state.activeSpaceId)
  // The first colour of the theme drives the others (its harmony): every colour of the gradient takes the one chosen, the harmony derives the rest.
  if (hex && space) actions.push({ type: 'space/update', id: space.id, patch: { theme: { baseColors: space.theme.baseColors.map(() => hex) } } })
  return actions
}

/** What opens when the guide is done (its last button, or « Terminé » after the import): the complete configuration when it was asked for. */
export function firstLaunchFollowUp(choices: Pick<FirstLaunchChoices, 'quickSetup'>): OverlayRequest | null {
  return choices.quickSetup ? GUIDED_SETUP_REQUEST : null
}

/** The request of the import the guide asks for, or null when no browser is chosen or nothing of it is ticked. */
export function firstLaunchRequest(choices: FirstLaunchChoices): ImportRequest | null {
  if (choices.source === null || choices.categories.length === 0) return null
  return {
    source: choices.source,
    categories: [...choices.categories],
    ...(choices.profile ? { profile: choices.profile } : {})
  }
}

export interface FirstLaunchImportApi {
  firstLaunchPreview(request: ImportRequest): Promise<ImportReport>
  firstLaunchConfirm(token: string): Promise<ImportReport>
}

/**
 * Runs the import of the guide: the preview reads what would come in, then its key carries it out (the user confirmed with the last button of the
 * guide, after a summary of what is taken). A preview with nothing to import, or refused (macOS asks for disk access, a file is to be chosen), is the
 * answer as it is: nothing is written.
 */
export async function runFirstLaunchImport(api: FirstLaunchImportApi, request: ImportRequest): Promise<ImportReport> {
  const preview = await api.firstLaunchPreview(request)
  if (!preview.ok || preview.token === undefined) return preview
  return api.firstLaunchConfirm(preview.token)
}
