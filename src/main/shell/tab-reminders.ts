// The timer of "Rappel d'onglet": it wakes up for the earliest pending reminder, tells the user with a local notification, then asks the reducer
// to bring the tabs back (`reminder/fire`). Nothing is armed while no reminder waits, and nothing at all while the setting is off (the gate).

import type { SidebarState, TabReminder } from '@shared/model'
import { dueReminders, nextReminderAt } from '@shared/tab-reminder'
import type { FeatureGates, GateStore } from './feature-gate'

/**
 * The longest the timer sleeps. Node's timers do not count the time the Mac is asleep, so a long wait could end late after a wake-up:
 * looking at the wall clock every few minutes bounds that delay (and keeps the delay under the 24 days a timer can hold).
 */
export const REMINDER_MAX_WAIT_MS = 5 * 60_000

export interface TabReminderDeps {
  store: GateStore
  now(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
  /** A local notification for a reminder that falls due; choosing it shows the window. */
  notify(reminder: TabReminder): void
  /** Brings the due tabs back: the reducer's `reminder/fire`. */
  fire(): void
}

/** Ties the timer to its setting: armed for the earliest reminder as it starts, and again each time the list changes. */
export function gateTabReminders(gates: FeatureGates, deps: TabReminderDeps): void {
  gates.gate('tab-reminders', {
    start() {
      let timer: unknown = null
      const disarm = (): void => {
        if (timer !== null) deps.clearTimer(timer)
        timer = null
      }
      const arm = (state: SidebarState): void => {
        disarm()
        const next = nextReminderAt(state.tabReminders)
        if (next === null) return
        timer = deps.setTimer(function tabReminderTick() {
          timer = null
          const now = deps.now()
          const current = deps.store.get()
          const due = dueReminders(current.tabReminders, now)
          for (const reminder of due) deps.notify(reminder)
          // The reducer removes what it brings back, which re-arms the timer through the subscription; nothing due: look again.
          if (due.length > 0) deps.fire()
          else arm(current)
        }, Math.min(Math.max(next - deps.now(), 0), REMINDER_MAX_WAIT_MS))
      }
      let list = deps.store.get().tabReminders
      arm(deps.store.get())
      const unsubscribe = deps.store.subscribe((state) => {
        if (state.tabReminders === list) return
        list = state.tabReminders
        arm(state)
      })
      return () => {
        unsubscribe()
        disarm()
      }
    }
  })
}
