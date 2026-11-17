// The window manager of the running application, for the modules that reach it without being handed it (the IPC handlers, the engine test).
// Kept apart from windows.ts, which makes the manager and registers the IPC of each window: a handler that imported windows.ts to read the
// manager closed a loop of imports (ipc.ts → its handlers → windows.ts → ipc.ts), which only held because nothing read it while the modules load.

import type { WindowManager } from './windows'

let current: WindowManager | null = null

/** Called once, by the manager itself as it is made. */
export function setWindowManager(manager: WindowManager): void {
  current = manager
}

/** The window manager of the running application (the engine smoke test reaches it from here). */
export function getWindowManager(): WindowManager {
  if (!current) throw new Error('The window manager is not ready')
  return current
}
