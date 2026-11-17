// The wrong master phrases of the password vault, counted so that a relaunch does not give fresh tries. The count and the end of the wait live in
// a small file beside the vault (`passwords.vault.attempts`, 0600, written by password-vault.ts); this file is the rules, with no disk in it.
//
// What the file holds is a number of failures and a time: nothing secret (no phrase, no hash of one, nothing of the vault). It is a brake on
// someone who tries phrases through the application; it is not a protection of the sealed file itself (that is the scrypt cost), and whoever can
// delete the file can delete the vault. So it must never be able to shut the owner out for good:
//  - a missing, unreadable or damaged file counts as no failure at all;
//  - the wait is never longer than the schedule gives for the count (a clock set far ahead, or a file edited by hand, cannot make it longer);
//  - the schedule is bounded (RETRY_MAX_MS), and a right phrase clears the count.

import { RETRY_MAX_MS, retryDelayMs } from '@shared/lock'
import { isRecord } from '@shared/record'

export interface Attempts {
  /** Wrong phrases since the last right one. */
  failures: number
  /** When the wait after the last wrong one ends (milliseconds since the epoch); 0 when there is none. */
  until: number
}

export const NO_ATTEMPTS: Attempts = Object.freeze({ failures: 0, until: 0 })

/** A file larger than this is not ours. The count stops far beyond the point where the wait reaches its cap. */
export const ATTEMPTS_FILE_MAX = 1024
const FAILURES_MAX = 1000

/** The count and the end of the wait in the text of the file; anything that is not exactly that is no failure at all. */
export function parseAttempts(text: string): Attempts {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return NO_ATTEMPTS
  }
  if (!isRecord(raw) || raw['v'] !== 1) return NO_ATTEMPTS
  const { failures, until } = raw
  if (typeof failures !== 'number' || !Number.isInteger(failures) || failures < 1 || failures > FAILURES_MAX) return NO_ATTEMPTS
  if (typeof until !== 'number' || !Number.isFinite(until) || until < 0) return NO_ATTEMPTS
  return { failures, until }
}

/** The text of the file for these attempts. */
export function attemptsText(attempts: Attempts): string {
  return JSON.stringify({ v: 1, failures: attempts.failures, until: attempts.until })
}

/**
 * How long to wait before the next phrase is tried (0: now). Bounded by the schedule's own wait for the count, so that an `until` out of reach
 * (the clock went back, the file was edited) shortens nothing and lengthens nothing beyond what a real run of failures would have given.
 */
export function waitMs(attempts: Attempts, now: number): number {
  const cap = Math.min(RETRY_MAX_MS, retryDelayMs(attempts.failures))
  return Math.min(cap, Math.max(0, attempts.until - now))
}

/** The attempts after one more wrong phrase at `now`: the same schedule as the lock of the application (shared/lock.ts). */
export function afterWrongPhrase(attempts: Attempts, now: number): Attempts {
  const failures = Math.min(FAILURES_MAX, attempts.failures + 1)
  const delay = retryDelayMs(failures)
  return { failures, until: delay > 0 ? now + delay : 0 }
}
