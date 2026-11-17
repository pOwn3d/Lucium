// The automatic copies of the session: when to make one, and how one is put back. A copy is made every few minutes (Settings › Téléchargements et fichiers) when the
// spaces and tabs changed since the last one, and when the application quits; the newest few are kept (backup-store.ts). Restoring one makes a
// copy of what it replaces first, so that it can be undone. Nothing here imports Electron: the state, the clock and the effects are handed in.
// It only ever sees the shared state of the normal windows; a private window has a store of its own that is never written anywhere.

import type { SidebarState } from '@shared/model'
import { backupPlan } from '@shared/backup-settings'
import type { ClosedPagesScope } from '@shared/closed-history'
import { profileOfSpace } from '@shared/profiles'
import { copyAfterForgetting, copyDataOf, copyFingerprint, hasSessionContent, holdsRestorableContent, isBackupId, type BackupListing, type BackupRestoreResult, type CopyReason, type SessionCopyData } from '@shared/session-backups'
import type { BackupFiles } from '../backup-store'
import { reportPersistenceNotice } from '../persistence-notices'
import type { FeatureGates } from './feature-gate'
import { t, tp } from '@shared/i18n'

export interface BackupDeps {
  files: BackupFiles
  /** The state saved on disk, the one of the normal windows. */
  state: () => SidebarState
  /**
   * The settings of that state, read at every change of the state to follow the schedule. The reducer keeps the same object while no setting
   * changes, so nothing is worked out again for a title or an icon that moved. Without it, they are read from `state`.
   */
  settings?: () => SidebarState['settings']
  /** Calls the listener at every change of the state; answers the function that stops it. */
  subscribe: (listener: () => void) => () => void
  /** Why no copy may be put back now (a space is locked: lock.ts `restoreRefusal`), or null. Without it nothing refuses. */
  refusal?: () => string | null
  /** Replaces the session with a copy's. */
  apply: (copy: SessionCopyData) => void
  toast: (message: string, action?: { label: string; run: () => void }) => void
  now?: () => number
}

/** What a request to make a copy came to: a new copy, nothing to do (nothing changed, nothing to keep, or the copies are off), or a failure. */
export type CopyOutcome = { ok: true; id: string | null } | { ok: false; reason: string }

export class SessionBackups {
  private timer: NodeJS.Timeout | null = null
  private unsubscribe: (() => void) | null = null
  private armed = ''
  /** The settings the schedule was last worked out from: the same object means the same schedule. */
  private followed: SidebarState['settings'] | null = null
  /** What the newest copy holds; undefined until it is first needed (read from disk then), null when there is none. */
  private lastPrint: string | null | undefined
  /** The last write failed (the user was told once, not at each try). */
  private failing = false

  constructor(private readonly deps: BackupDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /**
   * Starts the schedule, and follows the settings: switching the copies off or changing the delay takes effect at once.
   * `switchedOn`: the copies were just switched on during the session, so the first copy is made now rather than after the delay.
   */
  start(options: { switchedOn?: boolean } = {}): void {
    if (this.unsubscribe) return
    if (options.switchedOn) this.armed = 'off'
    this.unsubscribe = this.deps.subscribe(() => this.follow())
    this.follow()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.armed = ''
    this.followed = null
  }

  private follow(): void {
    // Called at every change of the state: a tab's title, an icon, the time a tab was last used. Only a change of the settings can move the schedule.
    const settings = this.deps.settings ? this.deps.settings() : this.deps.state().settings
    if (settings === this.followed) return
    this.followed = settings
    const plan = backupPlan(settings)
    const key = plan.enabled ? `${plan.everyMs}:${plan.keep}` : 'off'
    if (key === this.armed) return
    const before = this.armed
    this.armed = key
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!plan.enabled) return
    // Switching the copies on is asked for now: the first copy does not wait for the delay. Keeping fewer copies is asked for now too.
    if (before === 'off') this.backUp('auto')
    else if (before !== '') this.deps.files.prune(plan.keep)
    this.schedule(plan.everyMs)
  }

  /** The settings are followed by `follow`, which re-arms this at every change of the delay or of the switch: the delay here never goes stale. */
  private schedule(everyMs: number): void {
    this.timer = setTimeout(() => {
      this.backUp('auto')
      this.schedule(everyMs)
    }, everyMs)
    // A schedule must never be what keeps the application alive.
    this.timer.unref()
  }

  private printOfNewest(): string | null {
    if (this.lastPrint === undefined) {
      const newest = this.deps.files.newest()
      this.lastPrint = newest ? copyFingerprint(newest.data) : null
    }
    return this.lastPrint
  }

  /**
   * Makes a copy of the session now. A scheduled one (`auto`, `quit`) is made only when the copies are on, there is a tab, and the session is
   * not what the newest copy already holds. A manual one and the one before a restoration are asked for, so they are made whenever there is a tab.
   */
  backUp(reason: CopyReason): CopyOutcome {
    const state = this.deps.state()
    const plan = backupPlan(state.settings)
    const asked = reason === 'manual' || reason === 'before-restore'
    if (!asked && !plan.enabled) return { ok: true, id: null }
    // Nothing to keep: a copy of nothing would push a useful one out. A scheduled copy needs a tab; one asked for (and the one before a restoration,
    // which the restoration can be undone with) also keeps what a session with no open tab holds: folders, the archive, several spaces.
    if (!(asked ? holdsRestorableContent(state) : hasSessionContent(state))) return { ok: true, id: null }
    const data = copyDataOf(state)
    const print = copyFingerprint(data)
    if (!asked && print === this.printOfNewest()) return { ok: true, id: null }
    try {
      const id = this.deps.files.write({ createdAt: this.now(), reason, data }, plan.keep)
      this.lastPrint = print
      if (this.failing) {
        this.failing = false
        console.error('[backups] copies can be written again')
      }
      return { ok: true, id }
    } catch (error) {
      const message = String((error as Error).message ?? error)
      console.error(`[backups] cannot write a copy of the session (${reason}); the next scheduled one will try again:`, error)
      if (!this.failing) {
        this.failing = true
        reportPersistenceNotice({ kind: 'backup-failed', reason: message })
      }
      return { ok: false, reason: message }
    }
  }

  /**
   * Forgets in the copies on disk the pages the archived tabs went through (see `copyAfterForgetting`): clearing the history, or a site's, reaches them
   * as it reaches the state. All the copies are edited, whether the copies are on or not (the files stay when the function is switched off). A copy that
   * cannot be edited stays as it was; it is logged and counted.
   */
  forgetPages(scope: ClosedPagesScope): { rewritten: number; left: number } {
    const state = this.deps.state()
    const currentSpaces = new Set(state.spaces.filter((space) => profileOfSpace(state, space.id) === scope.profileId).map((space) => space.id))
    const result = this.deps.files.edit((text) => copyAfterForgetting(text, scope, currentSpaces))
    if (result.left > 0) console.error(`[backups] ${result.left} copy(ies) of the session could not be cleaned of the pages of the closed tabs and still hold them`)
    return result
  }

  list(): BackupListing {
    return { enabled: backupPlan(this.deps.state().settings).enabled, ...this.deps.files.list() }
  }

  /**
   * Puts a copy back. The copy is read and checked first, then the session it replaces is copied (and nothing is replaced if that fails: the
   * session about to go would exist nowhere else), then the spaces and tabs of the copy take its place. The notice offers to undo it.
   */
  restore(id: unknown): BackupRestoreResult {
    if (!isBackupId(id)) return { ok: false, message: t('backups.cette-copie-n-existe-pas') }
    // A copy replaces every space, the locked ones too. Refused before the copy of the present session is made: a refusal leaves nothing behind.
    const refusal = this.deps.refusal?.() ?? null
    if (refusal !== null) return { ok: false, message: refusal }
    let copy
    try {
      copy = this.deps.files.read(id)
    } catch (error) {
      console.error(`[backups] the copy ${id} cannot be restored, it cannot be read:`, error)
      return { ok: false, message: t('backups.copie-illisible') }
    }
    const before = this.backUp('before-restore')
    if (!before.ok) return { ok: false, message: t('backups.la-session-actuelle-n-a-pas-pu-etre-copiee', { reason: before.reason }) }
    this.deps.apply(copy.data)
    const tabs = copy.data.tabs.length
    const spaces = copy.data.spaces.length
    const undo = before.id
    this.deps.toast(
      t('backups.copie-restauree', { tabs: tp('backups.onglets', tabs, { count: tabs }), spaces: tp('backups.espaces', spaces, { count: spaces }) }),
      undo ? { label: t('menu.annuler'), run: () => void this.restore(undo) } : undefined
    )
    return { ok: true, tabs, spaces }
  }
}

let current: SessionBackups | null = null
export const setSessionBackups = (service: SessionBackups | null): void => {
  current = service
}
/** The service the menus and the panel talk to; null before the application has set it up. */
export const getSessionBackups = (): SessionBackups | null => current

/**
 * The copies run (a subscription to the state and a timer) only while "Copies automatiques" is on, and stop with it. The application's
 * launch with the copies on is not "switching on": the first copy waits for the delay, as before.
 */
export function gateBackups(gates: FeatureGates, backups: SessionBackups): void {
  let launching = true
  gates.gate('auto-backup', {
    start: () => {
      backups.start({ switchedOn: !launching })
      return () => backups.stop()
    }
  })
  launching = false
}
