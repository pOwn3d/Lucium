// The sealing of the device key by `safeStorage` (docs/synchronisation.md §3.3). The only file of src/main/sync/ that imports Electron.
//
// `safeStorage` seals a string: the bytes travel as base64. On macOS the first use may make the system ask the person to let Lucium use its own keychain item
// ("Lucium Safe Storage"): it happens when the synchronisation is switched on for the first time, never at launch (docs/synchronisation.md §17, to verify on a build).

import { safeStorage } from 'electron'
import type { SecretBox } from './secret-box'

export function electronSecretBox(): SecretBox {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    seal: (plain) => safeStorage.encryptString(plain.toString('base64')),
    open: (sealed) => Buffer.from(safeStorage.decryptString(sealed), 'base64')
  }
}
