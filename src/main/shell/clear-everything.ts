// « Tout effacer » and « Nouvelle identité »: the question, then the erasure. One flow for the menu (app-menu-wiring.ts) and for the command bar
// (ipc.ts), with the box, the erasure, the notice and the new window handed in so that each rule is tested without Electron (clear-everything.test.ts).

import { clearAllChoices, clearAllPrompt, type ClearAllKind, type ClearAllScope } from '@shared/clear-all'
import { t } from '@shared/i18n'
import type { SidebarState } from '@shared/model'
import { activeProfileId } from '@shared/profiles'

export interface ClearEverythingDeps {
  state(): SidebarState
  isPrivate(): boolean
  /** The question box; answers the index of the button pressed. */
  ask(options: { type: 'warning'; buttons: string[]; defaultId: number; cancelId: number; message: string; detail: string }): Promise<number>
  /** The erasure (Browser.clearEverything / Browser.newIdentity). */
  run(kind: ClearAllKind, scope: ClearAllScope): Promise<unknown>
  /** « Nouvelle identité » ends in a window of its own. */
  openWindow(): void
  notify(message: string): void
}

export type ClearEverythingOutcome = 'cancelled' | 'done' | 'failed' | 'refused'

/** Asks, and erases when the answer is yes. A failure is logged with its context and told to the user, never swallowed. */
export async function askAndClear(kind: ClearAllKind, deps: ClearEverythingDeps): Promise<ClearEverythingOutcome> {
  // A private window holds no profile data: its session goes with it.
  if (deps.isPrivate()) {
    deps.notify(t('clear-all.indisponible-dans-une-fenetre-privee'))
    return 'refused'
  }
  const state = deps.state()
  const choices = clearAllChoices(state)
  const cancel = choices.length - 1
  const prompt = clearAllPrompt(state, activeProfileId(state), kind)
  const answer = await deps.ask({ type: 'warning', buttons: choices.map((choice) => choice.label), defaultId: cancel, cancelId: cancel, ...prompt })
  const scope = choices[answer]?.scope ?? null
  if (scope === null) return 'cancelled'
  try {
    await deps.run(kind, scope)
  } catch (error) {
    console.error(`[clear] « ${kind} » did not go through:`, error)
    deps.notify(String((error as Error)?.message ?? error))
    return 'failed'
  }
  if (kind === 'identity') deps.openWindow()
  deps.notify(kind === 'identity' ? t('clear-all.nouvelle-identite-prete') : t('clear-all.donnees-effacees'))
  return 'done'
}

/** What starts the flow from outside the menu (the command bar, through IPC): installed once by the menus (app-menu-wiring.ts), which know the windows. */
let starter: ((kind: ClearAllKind) => void) | null = null

export function setClearEverythingStarter(start: ((kind: ClearAllKind) => void) | null): void {
  starter = start
}

/** The command bar asked for « Tout effacer » or « Nouvelle identité »: the question is asked in the window in front. False when no menu is installed to ask it. */
export function startClearEverything(kind: unknown): boolean {
  if ((kind !== 'everything' && kind !== 'identity') || starter === null) {
    console.warn('[clear] the request to clear everything was ignored:', kind === 'everything' || kind === 'identity' ? 'the menus are not installed' : 'not a known kind')
    return false
  }
  starter(kind)
  return true
}
