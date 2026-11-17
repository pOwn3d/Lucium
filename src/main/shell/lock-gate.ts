// The lock, for the surfaces that listen on a channel of their own. The channels `registerIpc` registers are shut by its guard while the
// application is locked (OPEN_WHILE_LOCKED, src/shared/lock.ts). The mini windows, the application windows, the floating video, the bar of the
// annotation and the two windows of a share register theirs directly on `ipcMain`, and relied on being closed when the lock comes
// (src/main/index.ts): a window that list forgets would still be answered. They ask here before they act, so the lock holds whatever is still open.
// A new channel cannot forget both: src/main/ipc-lock-coverage.test.ts fails on a handler that reaches neither this nor the guard of `registerIpc`.

import { getLockService } from '../lock-service'

/** True (with a line in the log) when the application is locked: the message on `channel` is not acted on. */
export function shutByLock(channel: string): boolean {
  if (getLockService()?.isAppLocked() !== true) return false
  console.warn(`[lock] ignored ${channel}: the application is locked`)
  return true
}
