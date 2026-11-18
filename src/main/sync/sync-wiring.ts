// The synchronisation service made from the real pieces of the Mac (docs/synchronisation.md §3.3): the data folder of the application, the sealing of `safeStorage`,
// the host name and the network interfaces of the system. Called once at the launch (main/index.ts). Making the service opens nothing and reads two small files at most:
// the switch is OFF until the person turns it on, and the Mac listens only while they have opened the window by hand (§6.1).

import { hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { electronSecretBox } from './secret-box-electron'
import { IdentityStore } from './identity'
import { SafeClock } from './safe-clock'
import { SyncService, type SessionPorts, type SyncServiceDeps } from './sync-service'
import { SyncStore } from './sync-store'

/** `sync.json`, `sync-identity.json`, `sync-marks.json` and the `sync-base-<id>.json` of each device, next to `state.json` and never part of it: no export, no backup and no copy of the session carries them. */
export const SYNC_FILES = { config: 'sync.json', identity: 'sync-identity.json', marks: 'sync-marks.json' } as const

/** What the person reads on the iPhone: the host name of the Mac without its `.local`, 80 characters at most. */
export function deviceNameOf(name: string): string {
  const cleaned = name.replace(/\.local$/i, '').trim()
  return [...(cleaned === '' ? 'Mac' : cleaned)].slice(0, 80).join('')
}

export interface SyncWiringOptions {
  userData: string
  isLocked: () => boolean
  /** The state and what the exchange of the data needs of this device (§8); without it the service pairs and says `internal` to a session. */
  session?: Omit<SessionPorts, 'marksFile' | 'basesDir'>
  runSession?: SyncServiceDeps['runSession']
}

export function createSyncService(options: SyncWiringOptions): SyncService {
  const box = electronSecretBox()
  return new SyncService({
    store: new SyncStore(join(options.userData, SYNC_FILES.config)),
    identities: new IdentityStore(join(options.userData, SYNC_FILES.identity), box),
    box,
    clock: new SafeClock(),
    hostEnv: () => ({ hostname: hostname(), interfaces: networkInterfaces() }),
    deviceName: () => deviceNameOf(hostname()),
    now: () => Date.now(),
    isLocked: options.isLocked,
    ...(options.session !== undefined ? { session: { ...options.session, marksFile: join(options.userData, SYNC_FILES.marks), basesDir: options.userData } } : {}),
    ...(options.runSession !== undefined ? { runSession: options.runSession } : {})
  })
}
