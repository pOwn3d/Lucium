// The lock of the interface: which of the application and its spaces are locked at this moment, how they are unlocked (the phrase, or Touch ID
// where the Mac has it), and when they lock again (a command, the Mac going to sleep or locking its screen). The rules are shared/lock.ts, the
// phrase's file is lock-store.ts. Nothing here imports Electron: the Touch ID prompt, the power events and the settings are handed in, so
// that every path is tested without a prompt of the system.
//
// While the lock is off it holds nothing: no listener, no timer, no file read (see `start`). It is a lock of the interface, not of the disk.

import { FREE_TRIES, lockPhraseProblem, retryDelayMs, type LockConfig, type LockReply, type LockView, type UnlockRequest } from '@shared/lock'
import type { Settings } from '@shared/model'
import type { LockFiles } from './lock-store'
import { t } from '@shared/i18n'

/** Touch ID as the shell has it: whether this Mac can ask, and the prompt itself (it rejects when the user cancels or the fingerprint fails). */
export interface TouchIdPort {
  available(): boolean
  prompt(reason: string): Promise<void>
}

export type PowerEvent = 'suspend' | 'resume' | 'lock-screen'

/** The Mac's power events (Electron's `powerMonitor`). */
export interface PowerPort {
  on(event: PowerEvent, listener: () => void): void
  off(event: PowerEvent, listener: () => void): void
}

export interface LockDeps {
  settings: () => Settings
  spaceIds: () => string[]
  files: LockFiles
  touchId: TouchIdPort
  power: PowerPort
  /** Applies a change of the lock's settings (the main process dispatches it past the interface's filter). */
  update: (patch: Partial<Settings>) => void
  /** Tells the user something that happened without them asking (the file of the phrase went missing). */
  notify?: (message: string) => void
  now?: () => number
}

/** A Mac (or a test run) where Touch ID is not offered: the phrase is the only way in. */
export const NO_TOUCH_ID: TouchIdPort = { available: () => false, prompt: () => Promise.reject(new Error('Touch ID is not available')) }

const POWER_EVENTS: readonly PowerEvent[] = ['suspend', 'resume', 'lock-screen']

export class LockService {
  private appLocked = false
  private readonly unlocked = new Set<string>()
  private failures = 0
  private blockedUntil = 0
  private checking = false
  private attached = false
  private hasPhrase: boolean | undefined
  private readonly listeners = new Set<() => void>()
  private readonly onPower = () => this.lockNow()

  private touchId: TouchIdPort

  constructor(private readonly deps: LockDeps) {
    this.touchId = deps.touchId
  }

  /** Puts another Touch ID in place (the engine test simulates it: no prompt of the system is ever shown there). */
  setTouchId(port: TouchIdPort): void {
    this.touchId = port
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /** The lock is on and a phrase exists. */
  isActive(): boolean {
    if (!this.deps.settings().lockEnabled) return false
    this.hasPhrase ??= this.deps.files.exists()
    return this.hasPhrase
  }

  /**
   * At application start. Off, this does nothing at all (the file is not even looked at). On, the application starts locked when it is
   * set to, and the power events are listened to. A lock that is on while its file is gone cannot be opened by anyone: it is switched off
   * and the user is told, rather than leaving the application closed for good.
   */
  start(): void {
    const settings = this.deps.settings()
    if (!settings.lockEnabled) return
    if (!this.isActive()) {
      this.deps.update({ lockEnabled: false, lockApp: false, lockedSpaces: [] })
      this.deps.notify?.(t('lock-service.le-fichier-de-la-phrase-du-verrou-est-introuvable'))
      return
    }
    this.appLocked = settings.lockApp
    this.attach()
  }

  /** After a change of the lock's settings or of its phrase: listens to the power events while the lock is on, and lets go of everything when it is not. */
  follow(): void {
    this.hasPhrase = undefined
    if (this.isActive()) this.attach()
    else {
      this.detach()
      this.appLocked = false
      this.unlocked.clear()
      this.failures = 0
      this.blockedUntil = 0
    }
    this.emit()
  }

  stop(): void {
    this.detach()
  }

  private attach(): void {
    if (this.attached) return
    this.attached = true
    for (const event of POWER_EVENTS) this.deps.power.on(event, this.onPower)
  }

  private detach(): void {
    if (!this.attached) return
    this.attached = false
    for (const event of POWER_EVENTS) this.deps.power.off(event, this.onPower)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  isAppLocked(): boolean {
    return this.appLocked && this.isActive()
  }

  isSpaceLocked(spaceId: string): boolean {
    return this.isActive() && this.deps.settings().lockedSpaces.includes(spaceId) && !this.unlocked.has(spaceId)
  }

  /** The spaces locked at this moment. */
  lockedSpaces(): string[] {
    return this.isActive() ? this.deps.settings().lockedSpaces.filter((id) => !this.unlocked.has(id)) : []
  }

  /** What the interface is told; undefined while the lock is off. */
  view(): LockView | undefined {
    if (!this.isActive()) return undefined
    const settings = this.deps.settings()
    return {
      active: true,
      appLocked: this.appLocked,
      lockedSpaces: this.lockedSpaces(),
      guardedSpaces: [...settings.lockedSpaces],
      touchId: settings.lockTouchId && this.touchId.available(),
      retryInMs: this.retryInMs()
    }
  }

  private retryInMs(): number {
    return Math.max(0, this.blockedUntil - this.now())
  }

  /** Locks again what is set to be locked (the command, the Mac going to sleep or locking its screen). */
  lockNow(): void {
    if (!this.isActive()) return
    this.appLocked = this.deps.settings().lockApp
    this.unlocked.clear()
    this.emit()
  }

  /** A phrase tried now, or the reason it is not (too many wrong ones in a row, or another one still being checked). */
  private async tryPhrase(phrase: string): Promise<LockReply> {
    const wait = this.retryInMs()
    if (wait > 0 || this.checking) return { ok: false, message: waitMessage(wait), retryInMs: wait }
    this.checking = true
    let right: boolean
    try {
      right = await this.deps.files.verify(phrase)
    } catch (error) {
      console.error('[lock] the phrase could not be checked:', error)
      return { ok: false, message: t('lock-service.la-phrase-n-a-pas-pu-etre-verifiee') }
    } finally {
      this.checking = false
    }
    if (!right) {
      this.failures++
      const delay = retryDelayMs(this.failures)
      this.blockedUntil = delay > 0 ? this.now() + delay : 0
      const tries = Math.max(0, FREE_TRIES - this.failures)
      return { ok: false, message: delay > 0 ? t('lock-service.phrase-incorrecte-wait', { wait: waitMessage(delay) }) : (tries > 1 ? t('lock-service.phrase-incorrecte-tries-essais-avant-un-delai', { tries }) : t('lock-service.phrase-incorrecte-1-essai-avant-un-delai')), ...(delay > 0 ? { retryInMs: delay } : {}) }
    }
    this.failures = 0
    this.blockedUntil = 0
    return { ok: true }
  }

  /** Unlocks the application or a space with the phrase of the request, or with Touch ID when it carries none. */
  async unlock(request: UnlockRequest): Promise<LockReply> {
    if (!this.isActive()) return { ok: false, message: t('lock-service.le-verrou-n-est-pas-active') }
    const { target } = request
    const guarded = target.scope === 'app' ? this.appLocked : this.isSpaceLocked(target.spaceId)
    if (!guarded) return { ok: true }
    if (request.phrase === undefined) {
      const settings = this.deps.settings()
      if (!settings.lockTouchId || !this.touchId.available()) return { ok: false, message: t('lock-service.touch-id-n-est-pas-disponible-saisissez-la-phrase') }
      try {
        await this.touchId.prompt(t('lock-service.deverrouiller-vos-onglets'))
      } catch (error) {
        // A cancelled prompt or a fingerprint that did not match: the phrase is still the way in.
        console.error('[lock] Touch ID did not unlock:', (error as Error).message ?? error)
        return { ok: false, message: t('lock-service.touch-id-n-a-pas-abouti-saisissez-la-phrase') }
      }
    } else {
      const checked = await this.tryPhrase(request.phrase)
      if (!checked.ok) return checked
    }
    if (target.scope === 'app') this.appLocked = false
    else this.unlocked.add(target.spaceId)
    this.emit()
    return { ok: true }
  }

  /**
   * Changes the lock. Putting more under it (a phrase the first time, the application lock, a space) is free; taking something away is
   * refused while the application is locked and needs the phrase to change or remove it, or the space to be unlocked for its own lock.
   */
  async configure(config: LockConfig): Promise<LockReply> {
    if (this.isAppLocked()) return { ok: false, message: t('lock-service.deverrouillez-lucium-d-abord') }
    switch (config.op) {
      case 'set-phrase': {
        const problem = lockPhraseProblem(config.phrase)
        if (problem) return { ok: false, message: problem }
        if (this.isActive() || this.deps.files.exists()) {
          if (config.current === undefined) return { ok: false, message: t('lock-service.saisissez-la-phrase-actuelle-pour-la-changer') }
          const checked = await this.tryPhrase(config.current)
          if (!checked.ok) return checked
        }
        try {
          await this.deps.files.setPhrase(config.phrase)
        } catch (error) {
          console.error('[lock] the phrase could not be saved:', error)
          return { ok: false, message: t('lock-service.la-phrase-n-a-pas-pu-etre-enregistree') }
        }
        this.deps.update({ lockEnabled: true })
        this.follow()
        return { ok: true }
      }
      case 'disable': {
        if (this.isActive()) {
          const checked = await this.tryPhrase(config.current)
          if (!checked.ok) return checked
        }
        this.deps.files.clear()
        this.deps.update({ lockEnabled: false, lockApp: false, lockedSpaces: [] })
        this.follow()
        return { ok: true }
      }
      case 'app':
        if (config.value && !this.isActive()) return { ok: false, message: t('lock-service.choisissez-d-abord-une-phrase') }
        this.deps.update({ lockApp: config.value })
        return { ok: true }
      case 'touch-id':
        this.deps.update({ lockTouchId: config.value })
        this.emit()
        return { ok: true }
      case 'space': {
        const current = this.deps.settings().lockedSpaces
        if (!this.deps.spaceIds().includes(config.spaceId)) return { ok: false, message: t('lock-service.cet-espace-n-existe-pas') }
        if (config.locked) {
          if (!this.isActive()) return { ok: false, message: t('lock-service.choisissez-d-abord-une-phrase') }
          this.unlocked.delete(config.spaceId)
          if (!current.includes(config.spaceId)) this.deps.update({ lockedSpaces: [...current, config.spaceId] })
        } else {
          if (this.isSpaceLocked(config.spaceId)) return { ok: false, message: t('lock-service.deverrouillez-l-espace-pour-retirer-son-verrou') }
          this.unlocked.delete(config.spaceId)
          this.deps.update({ lockedSpaces: current.filter((id) => id !== config.spaceId) })
        }
        this.emit()
        return { ok: true }
      }
      case 'lock-now':
        this.lockNow()
        return { ok: true }
    }
  }
}

const waitMessage = (ms: number): string => t('lock-service.reessayez-dans-seconds-s', { seconds: Math.max(1, Math.ceil(ms / 1000)) })

let current: LockService | null = null
export const setLockService = (service: LockService | null): void => {
  current = service
}
/** The lock of the running application; null before it is set up (and in a test that has none). */
export const getLockService = (): LockService | null => current
