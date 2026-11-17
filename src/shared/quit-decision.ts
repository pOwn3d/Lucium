// What happens when the application is asked to quit: the rule of the question ("Avertir avant de quitter") and of the erasure at quit. Pure; the
// main process wires it (index.ts, `before-quit`) and `shell/system-quit.ts` tells it when the system is the one asking.

import { confirmButtons, type ConfirmButtons } from './confirm-box'
import { t, tp } from './i18n'
import { settingsPath } from './settings-path'

/** How long a quit asked by the system may take before the process is ended anyway (a stuck window or erasure must not hold a shutdown). */
export const SYSTEM_QUIT_DEADLINE_MS = 10_000

export interface QuitFacts {
  /** The quit is already decided: the question was answered, or the last window closed (that already is a decision to quit). */
  confirmed: boolean
  /** The system asked (SIGTERM, SIGINT, SIGHUP, shutdown, restart, logout). Nobody is there to answer a question: the quit goes ahead. */
  system: boolean
  /** Settings › Général › « Avertir avant de quitter ». */
  warnBeforeQuitting: boolean
  /** The downloads in progress (read only when it can change the answer). */
  downloading: () => number
}

/**
 * `go`: the quit goes ahead. `ask`: it is held for the question. A quit the system asked is never held, whatever the setting says and whatever
 * the downloads in progress (a shutdown that waits for an answer nobody gives is a Mac that does not shut down); ⌘Q and the Dock keep the question.
 */
export function quitStep(facts: QuitFacts): 'go' | 'ask' {
  if (facts.system || facts.confirmed) return 'go'
  if (facts.warnBeforeQuitting) return 'ask'
  return facts.downloading() > 0 ? 'ask' : 'go'
}

/**
 * The erasure of the sites "à la fermeture de Lucium" at quit: `wait` holds the quit for it (a few seconds at most), `defer` writes the marker and lets
 * the quit go, so that the next launch does the erasure (see quit-clear.ts). The system waits for nobody: a shutdown is not held for 8 seconds of erasure.
 */
export function quitClearStep(facts: { system: boolean }): 'wait' | 'defer' {
  return facts.system ? 'defer' : 'wait'
}

/** What quitting would lose beyond the windows and tabs, which come back at the next launch. */
export interface QuitLoss {
  /** Downloads in progress: they are cancelled. */
  downloading: number
  /** Tabs of private (and guest) windows: nothing of them is kept. */
  privateTabs: number
}

/** Whether quitting loses something that does not come back. */
export const quitLosesData = (loss: QuitLoss): boolean => loss.downloading > 0 || loss.privateTabs > 0

export interface QuitQuestion extends ConfirmButtons {
  type: 'question' | 'warning'
  message: string
  detail: string
  /** Offers "Quitter et ne plus demander" (not while downloads are in progress: that question stays). */
  offersNeverAsk: boolean
}

/**
 * The question asked on ⌘Q. When quitting loses something (downloads, private tabs), the box says so and "Annuler" is its default button, so that
 * a Return typed at once does not throw it away; when nothing is lost, "Quitter" stays the default and the box is the plain question it was.
 */
export function quitQuestion(loss: QuitLoss): QuitQuestion {
  const destroys = quitLosesData(loss)
  const lines: string[] = []
  if (loss.downloading > 0) lines.push(t('app.des-telechargements-sont-en-cours-quitter-l'))
  if (loss.privateTabs > 0) lines.push(tp('app.onglets-des-fenetres-privees-perdus', loss.privateTabs))
  if (loss.downloading === 0) lines.push(t('app.cette-confirmation-se-desactive-dans-reglages', { settingsPath: settingsPath('quitWarning') }))
  return {
    type: destroys ? 'warning' : 'question',
    ...confirmButtons(t('app.quitter'), t('confirm-box.annuler'), destroys),
    message: loss.downloading > 0 ? t('app.telechargements-en-cours') : t('app.quitter-lucium'),
    detail: lines.join('\n\n'),
    offersNeverAsk: loss.downloading === 0
  }
}

export interface QuitHostCandidate {
  id: string
  destroyed: boolean
  /** Shown on a screen: not hidden, not minimized. */
  visible: boolean
}

/**
 * The window the question of the quit hangs from: the one the user works in when it can be seen, else another that can be; null (a box of its own) when none
 * can. A question hung from a window nobody sees is never answered, and the quit that waits for it never ends (⌘Q and the system's quit
 * did nothing for hours).
 */
export function quitDialogHost(windows: readonly QuitHostCandidate[], focusedId: string | null): string | null {
  const shown = windows.filter((w) => !w.destroyed && w.visible)
  return (shown.find((w) => w.id === focusedId) ?? shown[0])?.id ?? null
}
