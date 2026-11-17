// A part of main() (index.ts), moved out as it was: the password vault. The service, its Touch ID, the gate that loads the page bridge
// while the setting is on, the lock of the application that closes the vault, and what stops with the application. Called once, where
// main() had these lines: the order of its will-quit handler among the others is the order of the calls of main().

import { join } from 'node:path'
import { app, powerMonitor, systemPreferences, type BrowserWindow } from 'electron'
import type { ElectronEngine } from '../engine/electron-engine'
import type { LockService, PowerEvent } from '../lock-service'
import { PasswordVault } from '../password-vault'
import type { currentPlatform } from '../platform'
import { isBuiltApp } from '../runtime'
import type { StateStore } from '../store'
import { stopSystemTranslateHelpers } from '../translate/system'
import { VaultKeychain, helperRunner, keychainServiceFor, keychainTransport, stopKeychainHelpers } from '../vault-keychain'
import type { FeatureGates } from './feature-gate'
import { passwordFiles } from './password-ipc'
import { PasswordService, setPasswordService } from './password-service'

export interface PasswordVaultDeps {
  sharedStore: StateStore
  gates: FeatureGates
  engine: ElectronEngine
  lock: LockService
  /** The first window: the dialogs of the vault's files open on it. */
  win: BrowserWindow
  platform: ReturnType<typeof currentPlatform>
  /** The engine test: it never reaches the keychain. */
  smoke: boolean
}

export function installPasswordVault({ sharedStore, gates, engine, lock, win, platform, smoke }: PasswordVaultDeps): void {
  // Settings › Vie privée et sécurité › Mots de passe. The service holds nothing while the vault is closed (no timer, no listener, no file read); the gate loads the
  // page bridge into the sessions while the setting is on and, when it goes off (or at exit), closes the vault and forgets the logins waiting for an answer.
  const passwordPower = { on: (event: PowerEvent, listener: () => void) => powerMonitor.on(event as 'suspend', listener), off: (event: PowerEvent, listener: () => void) => powerMonitor.off(event as 'suspend', listener) }
  const vaultPath = join(app.getPath('userData'), 'passwords.vault')
  // Touch ID for the vault (macOS): the key in the keychain behind the enrolled fingers, through the XPC service of Contents/XPCServices/ and
  // the addon of Contents/Resources/. Nothing is looked at before the panel asks (the addon is loaded at its first use); the engine test never
  // reaches it, nor does a run from the sources (no service in Electron's bundle), nor an application without a team (vault-keychain.ts).
  const vaultTouchId = platform.touchId(systemPreferences)
  const keychain = new VaultKeychain({
    recordPath: `${vaultPath}.touchid`,
    service: keychainServiceFor(vaultPath),
    runner: () => {
      if (smoke || !platform.facts.touchId || !isBuiltApp()) return null
      const transport = keychainTransport(process.resourcesPath)
      return transport ? helperRunner(transport) : null
    },
    canPrompt: () => vaultTouchId.available()
  })
  const passwords = new PasswordService({
    settings: () => sharedStore.get().settings,
    vault: new PasswordVault({ path: vaultPath }),
    power: passwordPower,
    files: passwordFiles(win),
    keychain
  })
  setPasswordService(passwords)
  gates.gate('password-manager', {
    start() {
      engine.setPasswordBridge(true)
      return () => {
        engine.setPasswordBridge(false)
        passwords.stop()
      }
    }
  })
  // The lock of the application closes the vault too; the Mac's own sleep and screen lock are listened to by the service while the vault is open.
  lock.subscribe(() => {
    if (lock.isAppLocked()) passwords.lock()
  })
  app.on('will-quit', () => {
    passwords.stop()
    // A request of the keychain still waiting (a fingerprint prompt) is cancelled, a batch of the system's translation stopped.
    stopKeychainHelpers()
    stopSystemTranslateHelpers()
  })
}
