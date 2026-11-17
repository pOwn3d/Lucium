// A page that asks to confirm leaving it: its `beforeunload` handler cancels the unload ("Changes you made may not be saved"). Electron has
// no box for that question, and wants the answer inside the event (`will-prevent-unload`). Ignoring the handler always (what the engine did
// before) lets a page that guards typed text lose it on a click or a reload with no word; keeping it always lets a page hold its tab.
// So the user is asked, with a sheet on the window, and the answer decides: "Quitter" lets the page go, "Rester" keeps it. The sheet is
// never a trap: whatever the page does, one click leaves it, and a page cannot bring it back by itself: after "Rester", a navigation the page
// starts again before the user has touched it (a click, a key) is refused without a question, as if the answer were "Rester" again. Without
// that, a page that reloads itself from its own handler would put the system box (which freezes the application) back on screen for ever.
// Only a page on screen is asked; a page nobody looks at has nobody to ask and
// stays, as if the answer were "Rester" (a reload of a tab behind, its automatic reload, « Actualiser tous les onglets »): what it guards is
// not lost without a question, and the user finds it as it was. The sleep asks the same way (`ElectronPage.release`). A window that is gone
// takes its pages with it.
//
// Two ways to ask. Electron wants the answer inside the event, so the system box (a synchronous `showMessageBoxSync`, which freezes the application)
// is the only way to answer at once. When the shell started the navigation itself (the address bar, reload, back, forward: `intend`), `LeaveGate` does
// better: it leaves the handler alone, which keeps the page where it is, asks with a sheet of Lucium that blocks nothing, and on "Quitter"
// grants the next refusal of the page and starts the same navigation again. A navigation the page starts itself (a link) is not known to the shell
// before the page has asked, so it keeps the system box.

import { dialog, type BrowserWindow } from 'electron'
import { t } from '@shared/i18n'
import { assertTestRun } from '../test-seam'

/** Whether the user chooses to leave `site`. Synchronous: Electron reads the answer of the event handler. */
export type LeaveAsker = (win: BrowserWindow, site: string) => boolean

/** The question as a sheet on the window. "Rester" is the default button, so that a stray Return keeps what the user typed. */
export const askWithSheet: LeaveAsker = (win, site) => {
  const choice = dialog.showMessageBoxSync(win, {
    type: 'question',
    buttons: [t('app.quitter'), t('engine.rester')],
    defaultId: 1,
    cancelId: 1,
    message: t('engine.quitter-ce-site'),
    detail: t('engine.site-demande-une-confirmation-les-modifications-que-vous', { site })
  })
  return choice === 0
}

let asker: LeaveAsker = askWithSheet

/** The engine test answers in place of the user (a recorder instead of a sheet nobody could click); null puts the sheet back. */
export function setLeaveAsker(replacement: LeaveAsker | null): void {
  assertTestRun('setLeaveAsker')
  asker = replacement ?? askWithSheet
}

/** How long after the shell started a navigation a refusal of the page still belongs to it: the handler of the page answers within the same turn. */
export const INTENT_WINDOW_MS = 2000
/** After "Quitter", the next refusal of the page is let through for this long (the navigation started again meets the same handler). */
export const GRANT_WINDOW_MS = 3000

export interface LeaveGateHost {
  /** The window the page is on screen in, null when the page is not shown. */
  win(): BrowserWindow | null
  /** The site the page is on, as the interface names it. */
  site(): string
  /** The sheet of the shell: true when the user chose to leave. Absent where the page has no sheet to show (the system box then asks). */
  ask?(site: string): Promise<boolean>
  now?(): number
}

/** What the log says when a page asks again, without a click or a key of the user since the "Rester", to be let go. */
const PESTERING_LOG = '[unload] the page asks again to be let go, with no click or key since the user chose to stay: it stays, without a box'

/**
 * The `will-prevent-unload` of one page. The engine tells it about the navigations the shell starts (`intend`) and hands it the event.
 * A page that is not on screen stays; one that is, leaves on "Quitter" and stays otherwise. Only the last answer is kept: after "Rester", the
 * navigations the page starts itself wait for a click or a key of the user in the page (`noteInput`) before they are asked again.
 */
export class LeaveGate {
  private intent: { redo: () => void; at: number } | null = null
  private grantedAt: number | null = null
  private asking = false
  /** The last answer of the user was "Rester" (the sheet or the system box), and the user has not clicked or typed in the page since. */
  private stayedUntouched = false
  /** The refusals let through without a box since the last answer: the log says it once per series. */
  private quietRefusals = 0

  constructor(private readonly host: LeaveGateHost) {}

  private now(): number {
    return this.host.now?.() ?? Date.now()
  }

  /** The user clicked or typed in the page (a real input event, which no script can make): the page may ask again. */
  noteInput(): void {
    this.stayedUntouched = false
  }

  private answered(leave: boolean): void {
    this.stayedUntouched = !leave
    this.quietRefusals = 0
  }

  /** The shell starts a navigation of this page (address, reload, back, forward): `redo` starts the same one again if the user agrees to leave. */
  intend(redo: () => void): void {
    this.intent = { redo, at: this.now() }
  }

  /**
   * A new document of the page committed. A navigation is refused before it commits, so the one the shell started is over (it went through, or
   * another took its place): a refusal after this belongs to a navigation the page starts itself (a script that reloads it, a link), which keeps the
   * system box. Without it, a page that reloads itself within INTENT_WINDOW_MS of being opened from the address bar got the sheet, and "Quitter"
   * started the address bar's navigation again instead of the page's.
   */
  committed(): void {
    this.intent = null
  }

  onPrevent(event: { preventDefault(): void }): void {
    const now = this.now()
    if (this.grantedAt !== null && now - this.grantedAt < GRANT_WINDOW_MS) {
      this.grantedAt = null
      event.preventDefault()
      return
    }
    const win = this.host.win()
    const intent = this.intent && now - this.intent.at < INTENT_WINDOW_MS ? this.intent : null
    const ask = this.host.ask
    // No sheet to show, or a navigation the shell cannot start again: the system box answers inside the event, as it always did.
    if (win === null || win.isDestroyed() || !intent || !ask) {
      // The page navigates by itself again after a "Rester", the user having done nothing in it since: it stays, and no box comes back.
      if (!intent && win !== null && !win.isDestroyed() && this.stayedUntouched) {
        if (this.quietRefusals++ === 0) console.warn(PESTERING_LOG)
        return
      }
      const asked = win !== null && !win.isDestroyed()
      const leave = mayLeave({ win, site: this.host.site() })
      if (asked) this.answered(leave)
      if (leave) event.preventDefault()
      return
    }
    // The handler is left alone, so the page stays where it is; a second refusal while the sheet is open does not stack another.
    if (this.asking) return
    this.asking = true
    this.intent = null
    void ask
      .call(this.host, this.host.site())
      .catch((error: unknown) => {
        // The page must never hold the user: when the question cannot be asked, the page goes.
        console.error('[unload] cannot ask whether to leave the page; it leaves:', error instanceof Error ? error.message : String(error))
        return true
      })
      .then((leave) => {
        this.asking = false
        this.answered(leave)
        if (!leave) return
        this.grantedAt = this.now()
        intent.redo()
      })
  }
}

export interface UnloadRequest {
  /** The page is on screen in a window that is still there. */
  win: BrowserWindow | null
  /** The site the page is on, as the interface names it. */
  site: string
}

/**
 * Whether the page is to be unloaded after all (the caller then ignores the handler of the page). A page that is not on screen stays without a
 * question (nobody can answer it, and leaving would lose what it guards); a page in a window that is gone leaves; a page on screen leaves when the
 * user says so, and stays otherwise (the navigation that asked is cancelled).
 */
export function mayLeave(request: UnloadRequest): boolean {
  if (request.win === null) return false
  if (request.win.isDestroyed()) return true
  return asker(request.win, request.site)
}
