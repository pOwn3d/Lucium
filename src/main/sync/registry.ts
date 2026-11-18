// The one synchronisation service of the application, set at the launch (main/index.ts) and read by the IPC handler (shell/sync-ipc.ts) and by what closes it
// (the lock, the Settings window, the quit). The same pattern as the lock service: a module-level reference, `null` where no service was made (a test, a build
// without it). Nothing in it listens: the service holds a switch that is off until the person turns it on.

import type { SyncService } from './sync-service'

let current: SyncService | null = null

export const setSyncService = (service: SyncService | null): void => {
  current = service
}

export const getSyncService = (): SyncService | null => current
