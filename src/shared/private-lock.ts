// The lock of a private window (Réglages › Vie privée et sécurité › Verrouillage › « Verrouiller les fenêtres privées après… »): a private window that has been left alone
// for the delay covers itself with the lock screen of the application, and asks for the phrase (or Touch ID) to be opened again. It is the lock of ONE window: the other windows
// and the spaces are not touched, and a private window does not « reopen » (its tabs live in memory only), so what the lock gives back is the window as it was.
//
// « Left alone » (decision of the plan, line 35: the idle lock rather than the lock when the window goes to the background): no click or key while the window had the focus,
// and the person did not come back to it, for the delay. A window in the background therefore locks after the delay as well: nobody is using it. The state is per window.
// Pure: main/shell/private-lock.ts owns the timer, and Browser asks it whether the window is locked.

import type { LockView } from './lock'

/** The delays offered, in minutes; 0 is « never » (the default: the function costs nothing while it is off). */
export const PRIVATE_IDLE_CHOICES = [0, 1, 5, 15, 30] as const
export type PrivateIdleMinutes = (typeof PRIVATE_IDLE_CHOICES)[number]

/** A delay read from a file or from the interface: one of the choices, and « never » for anything else. */
export function cleanPrivateIdle(raw: unknown): PrivateIdleMinutes {
  return (PRIVATE_IDLE_CHOICES as readonly unknown[]).includes(raw) ? (raw as PrivateIdleMinutes) : 0
}

/** What is known of one private window. */
export interface PrivateLockState {
  /** The last moment the person was seen at this window. */
  lastActiveAt: number
  locked: boolean
}

export const freshPrivateLock = (now: number): PrivateLockState => ({ lastActiveAt: now, locked: false })

/** What the window and the application tell at a look: whether the window has the focus, and when the last click or key was anywhere in the application. */
export interface PrivateLook {
  now: number
  focused: boolean
  lastInputAt: number
}

/**
 * The state after a look. A window that has the focus and saw a click or a key since the last look is where the person is: its last activity moves up to that input. A
 * window that has just got the focus counts as a visit. A locked window stays locked: only unlocking opens it (`unlocked`).
 */
export function afterLook(state: PrivateLockState, look: PrivateLook, justFocused = false): PrivateLockState {
  if (state.locked) return state
  if (justFocused) return { ...state, lastActiveAt: look.now }
  if (look.focused && look.lastInputAt > state.lastActiveAt) return { ...state, lastActiveAt: Math.min(look.lastInputAt, look.now) }
  return state
}

/** Whether the window has been left alone for the delay: the lock is on (a phrase exists), the delay is not « never », and the time is up. */
export function idleLockDue(state: PrivateLockState, minutes: number, now: number, lockActive: boolean): boolean {
  if (state.locked || !lockActive || minutes <= 0) return false
  return now - state.lastActiveAt >= minutes * 60_000
}

export const locked = (state: PrivateLockState): PrivateLockState => (state.locked ? state : { ...state, locked: true })

/** The window is open again (the phrase, or Touch ID, was right): the delay starts from now. */
export const unlocked = (now: number): PrivateLockState => freshPrivateLock(now)

/**
 * What the interface of a locked private window is told of the lock: the application is covered (this window only: no other window reads this), no space is named, and the
 * way in is the one the application's lock offers. `view` is the lock of the application (undefined while it is off: nothing locks then).
 */
export function lockedWindowView(view: LockView | undefined): LockView | undefined {
  if (!view) return undefined
  return { active: true, appLocked: true, lockedSpaces: [], guardedSpaces: [], touchId: view.touchId, retryInMs: view.retryInMs }
}
