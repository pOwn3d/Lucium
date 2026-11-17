// The screens the pane « Taille des fenêtres et des panneaux » draws: asked of the main process, and a failure is told (the pane then draws only the screens
// that have a saved choice, and its controls wait), never swallowed. Without a window: the question, the answer and the log come in as functions.

import type { ScreenView } from '@shared/panel-scale'

/**
 * Asks for the connected screens and hands them on. An answer that is not a list is ignored (the pane keeps what it had); a failed question is written to
 * the log with what it was about, and the pane keeps what it had.
 */
export async function loadScreens(ask: () => Promise<ScreenView[]>, set: (screens: ScreenView[]) => void, log: (message: string, error: unknown) => void): Promise<void> {
  try {
    const list = await ask()
    if (Array.isArray(list)) set(list)
  } catch (error) {
    log('[settings] cannot read the screens for the size of the panels:', error)
  }
}
