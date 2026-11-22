// The lock: when it is on, when it asks, how it is opened (the phrase, Touch ID simulated), how fast wrong phrases are taken, when it closes again.
// The file of the phrase, the power events and Touch ID are stand-ins: no prompt of the system, no real sleep.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FREE_TRIES, RETRY_FIRST_MS } from '@shared/lock'
import { defaultSettings, type Settings } from '@shared/model'
import type { LockFiles } from './lock-store'
import { LockService, type PowerEvent, type TouchIdPort } from './lock-service'
import { getLanguage, setLanguage } from '@shared/i18n'

const PHRASE = 'la phrase du verrou'

class FakeFiles implements LockFiles {
  phrase: string | null = null
  exists = vi.fn(() => this.phrase !== null)
  verify = vi.fn(async (phrase: string) => this.phrase !== null && phrase === this.phrase)
  setPhrase = vi.fn(async (phrase: string) => {
    this.phrase = phrase
  })
  clear = vi.fn(() => {
    this.phrase = null
  })
}

function setup(over: Partial<Settings> = {}, hasPhrase = true) {
  const settings: Settings = { ...defaultSettings(), ...over }
  const files = new FakeFiles()
  if (hasPhrase) files.phrase = PHRASE
  const listeners = new Map<PowerEvent, Set<() => void>>()
  const power = {
    on: vi.fn((event: PowerEvent, listener: () => void) => void (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(listener)),
    off: vi.fn((event: PowerEvent, listener: () => void) => void listeners.get(event)?.delete(listener))
  }
  const touchId = { on: true, accept: true, prompt: vi.fn(async () => {}), available: vi.fn(() => touchId.on) }
  touchId.prompt.mockImplementation(async () => {
    if (!touchId.accept) throw new Error('Authentication failed')
  })
  const clock = { now: 1_000_000 }
  const update = vi.fn((patch: Partial<Settings>) => void Object.assign(settings, patch))
  const notify = vi.fn()
  const service = new LockService({ settings: () => settings, spaceIds: () => ['home', 'work', 'perso'], files, touchId: touchId as TouchIdPort, power, update, notify, now: () => clock.now })
  const fire = (event: PowerEvent) => listeners.get(event)?.forEach((listener) => listener())
  const attached = () => [...listeners.values()].reduce((n, set) => n + set.size, 0)
  return { settings, files, power, touchId, clock, update, notify, service, fire, attached }
}

let logged: string[] = []
beforeEach(() => {
  logged = []
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
})
afterEach(() => vi.restoreAllMocks())

describe('the lock off costs nothing', () => {
  it('reads no file and listens to nothing when it is off, at start and afterwards', () => {
    const { service, files, power, attached, update, notify } = setup({ lockEnabled: false })
    service.start()
    // Nothing is changed and nobody is told: a lock that was never on has nothing to repair.
    expect(update).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(files.exists).not.toHaveBeenCalled()
    expect(power.on).not.toHaveBeenCalled()
    expect(attached()).toBe(0)
    expect(service.isActive()).toBe(false)
    expect(service.isAppLocked()).toBe(false)
    expect(service.isSpaceLocked('work')).toBe(false)
    expect(service.lockedSpaces()).toEqual([])
    expect(service.view()).toBeUndefined()
    service.lockNow()
    expect(attached()).toBe(0)
  })

  it('lets go of its listeners and of what it holds when it is turned off', async () => {
    const { service, settings, attached } = setup({ lockEnabled: true, lockApp: true })
    service.start()
    expect(attached()).toBe(3)
    expect(service.isAppLocked()).toBe(true)
    settings.lockEnabled = false
    service.follow()
    expect(attached()).toBe(0)
    expect(service.isAppLocked()).toBe(false)
    expect(service.view()).toBeUndefined()
  })
})

describe('starting', () => {
  it('starts locked when the application is set to, and not otherwise', () => {
    const locked = setup({ lockEnabled: true, lockApp: true })
    locked.service.start()
    expect(locked.service.isAppLocked()).toBe(true)
    expect(locked.service.view()).toMatchObject({ active: true, appLocked: true })
    const open = setup({ lockEnabled: true, lockApp: false, lockedSpaces: ['work'] })
    open.service.start()
    expect(open.service.isAppLocked()).toBe(false)
    expect(open.service.lockedSpaces()).toEqual(['work'])
    expect(open.service.isSpaceLocked('work')).toBe(true)
    expect(open.service.isSpaceLocked('home')).toBe(false)
  })

  it('switches the lock off, and says so, when its file is gone: nobody could open it', () => {
    const { service, update, notify, attached } = setup({ lockEnabled: true, lockApp: true, lockedSpaces: ['work'] }, false)
    service.start()
    expect(update).toHaveBeenCalledWith({ lockEnabled: false, lockApp: false, lockedSpaces: [] })
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/introuvable ou illisible/))
    expect(service.isAppLocked()).toBe(false)
    expect(attached()).toBe(0)
  })
})

describe('unlocking with the phrase', () => {
  it('opens the application with the right phrase, and says so to those who listen', async () => {
    const { service } = setup({ lockEnabled: true, lockApp: true })
    service.start()
    const heard = vi.fn()
    service.subscribe(heard)
    expect(await service.unlock({ target: { scope: 'app' }, phrase: PHRASE })).toEqual({ ok: true })
    expect(service.isAppLocked()).toBe(false)
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('keeps the application closed with a wrong phrase, and says how many tries are left', async () => {
    const { service } = setup({ lockEnabled: true, lockApp: true })
    service.start()
    const reply = await service.unlock({ target: { scope: 'app' }, phrase: 'pas la bonne phrase' })
    expect(reply).toMatchObject({ ok: false, message: expect.stringMatching(/incorrecte.*2 essais/) })
    expect(service.isAppLocked()).toBe(true)
  })

  it('opens a space without opening the application, and the application without opening the spaces', async () => {
    const { service } = setup({ lockEnabled: true, lockApp: true, lockedSpaces: ['work'] })
    service.start()
    await service.unlock({ target: { scope: 'space', spaceId: 'work' }, phrase: PHRASE })
    expect(service.isSpaceLocked('work')).toBe(false)
    expect(service.isAppLocked()).toBe(true)
    service.lockNow()
    expect(service.isSpaceLocked('work')).toBe(true)
    await service.unlock({ target: { scope: 'app' }, phrase: PHRASE })
    expect(service.isAppLocked()).toBe(false)
    expect(service.isSpaceLocked('work')).toBe(true)
  })

  it('answers "already open" for what is not locked, without checking anything', async () => {
    const { service, files } = setup({ lockEnabled: true, lockApp: false, lockedSpaces: ['work'] })
    service.start()
    expect(await service.unlock({ target: { scope: 'app' }, phrase: 'x' })).toEqual({ ok: true })
    expect(await service.unlock({ target: { scope: 'space', spaceId: 'home' }, phrase: 'x' })).toEqual({ ok: true })
    expect(files.verify).not.toHaveBeenCalled()
  })

  it('refuses when the lock is off', async () => {
    const { service } = setup({ lockEnabled: false })
    expect(await service.unlock({ target: { scope: 'app' }, phrase: PHRASE })).toMatchObject({ ok: false })
  })
})

describe('wrong phrases slow down (this fails if the delay is removed)', () => {
  it('refuses even the right phrase during the wait, and takes it after', async () => {
    const { service, clock, files } = setup({ lockEnabled: true, lockApp: true })
    service.start()
    for (let n = 0; n < FREE_TRIES; n++) await service.unlock({ target: { scope: 'app' }, phrase: `fausse phrase ${n}` })
    files.verify.mockClear()
    const blocked = await service.unlock({ target: { scope: 'app' }, phrase: PHRASE })
    expect(blocked).toMatchObject({ ok: false, retryInMs: RETRY_FIRST_MS, message: expect.stringMatching(/Réessayez dans 1\u00a0s/) })
    expect(files.verify).not.toHaveBeenCalled()
    expect(service.isAppLocked()).toBe(true)
    expect(service.view()?.retryInMs).toBe(RETRY_FIRST_MS)
    clock.now += RETRY_FIRST_MS - 1
    expect(await service.unlock({ target: { scope: 'app' }, phrase: PHRASE })).toMatchObject({ ok: false })
    clock.now += 1
    expect(await service.unlock({ target: { scope: 'app' }, phrase: PHRASE })).toEqual({ ok: true })
  })

  it('doubles the wait at each further failure, and forgets the failures after a success', async () => {
    const { service, clock } = setup({ lockEnabled: true, lockApp: true })
    service.start()
    for (let n = 0; n < FREE_TRIES; n++) await service.unlock({ target: { scope: 'app' }, phrase: 'fausse phrase ici' })
    clock.now += RETRY_FIRST_MS
    const second = await service.unlock({ target: { scope: 'app' }, phrase: 'fausse phrase ici' })
    expect(second).toMatchObject({ ok: false, retryInMs: RETRY_FIRST_MS * 2 })
    clock.now += RETRY_FIRST_MS * 2
    expect(await service.unlock({ target: { scope: 'app' }, phrase: PHRASE })).toEqual({ ok: true })
    service.lockNow()
    const fresh = await service.unlock({ target: { scope: 'app' }, phrase: 'fausse phrase ici' })
    expect(fresh).toMatchObject({ ok: false })
    expect(fresh).not.toHaveProperty('retryInMs')
  })

  it('does not check two phrases at once', async () => {
    const { service, files } = setup({ lockEnabled: true, lockApp: true })
    service.start()
    let release = () => {}
    files.verify.mockImplementationOnce(() => new Promise<boolean>((resolve) => (release = () => resolve(true))))
    const first = service.unlock({ target: { scope: 'app' }, phrase: PHRASE })
    const second = await service.unlock({ target: { scope: 'app' }, phrase: PHRASE })
    expect(second).toMatchObject({ ok: false })
    release()
    expect(await first).toEqual({ ok: true })
  })

  it('tells the user, and logs, when the phrase could not be checked', async () => {
    const { service, files } = setup({ lockEnabled: true, lockApp: true })
    service.start()
    files.verify.mockRejectedValueOnce(new Error('disk on fire'))
    expect(await service.unlock({ target: { scope: 'app' }, phrase: PHRASE })).toMatchObject({ ok: false, message: expect.stringMatching(/n’a pas pu être vérifiée/) })
    expect(logged.some((line) => line.includes('[lock] the phrase could not be checked'))).toBe(true)
    expect(service.isAppLocked()).toBe(true)
  })
})

describe('Touch ID (simulated: no prompt of the system)', () => {
  const app = { target: { scope: 'app' } } as const

  it('opens without a phrase when the fingerprint is accepted', async () => {
    const { service, touchId, files } = setup({ lockEnabled: true, lockApp: true })
    service.start()
    expect(await service.unlock(app)).toEqual({ ok: true })
    expect(touchId.prompt).toHaveBeenCalledTimes(1)
    expect(files.verify).not.toHaveBeenCalled()
    expect(service.isAppLocked()).toBe(false)
  })

  it('stays closed, says to type the phrase, and logs, when the fingerprint is refused or cancelled', async () => {
    const { service, touchId } = setup({ lockEnabled: true, lockApp: true })
    service.start()
    touchId.accept = false
    expect(await service.unlock(app)).toMatchObject({ ok: false, message: expect.stringMatching(/Touch ID n’a pas abouti.*phrase/) })
    expect(logged.some((line) => line.includes('Touch ID did not unlock'))).toBe(true)
    expect(service.isAppLocked()).toBe(true)
    // A refused fingerprint is not a wrong phrase: the phrase is not slowed down.
    expect(await service.unlock({ ...app, phrase: PHRASE })).toEqual({ ok: true })
  })

  it('falls back to the phrase where the Mac has no Touch ID, and when the setting is off, without ever prompting', async () => {
    const none = setup({ lockEnabled: true, lockApp: true })
    none.service.start()
    none.touchId.on = false
    expect(await none.service.unlock(app)).toMatchObject({ ok: false, message: expect.stringMatching(/Touch ID n’est pas disponible/) })
    expect(none.service.view()?.touchId).toBe(false)
    const off = setup({ lockEnabled: true, lockApp: true, lockTouchId: false })
    off.service.start()
    expect(await off.service.unlock(app)).toMatchObject({ ok: false })
    expect(off.service.view()?.touchId).toBe(false)
    expect(none.touchId.prompt).not.toHaveBeenCalled()
    expect(off.touchId.prompt).not.toHaveBeenCalled()
  })

  it('offers Touch ID in the view only where it works, and can be given another one', async () => {
    const { service } = setup({ lockEnabled: true, lockApp: true })
    service.start()
    expect(service.view()?.touchId).toBe(true)
    const replacement: TouchIdPort = { available: () => false, prompt: vi.fn() }
    service.setTouchId(replacement)
    expect(service.view()?.touchId).toBe(false)
  })
})

describe('locking again', () => {
  it('locks again at suspend, resume and screen lock: the application and the spaces that were opened', async () => {
    for (const event of ['suspend', 'resume', 'lock-screen'] as const) {
      const { service, fire } = setup({ lockEnabled: true, lockApp: true, lockedSpaces: ['work'] })
      service.start()
      await service.unlock({ target: { scope: 'app' }, phrase: PHRASE })
      await service.unlock({ target: { scope: 'space', spaceId: 'work' }, phrase: PHRASE })
      expect(service.isAppLocked() || service.isSpaceLocked('work')).toBe(false)
      const heard = vi.fn()
      service.subscribe(heard)
      fire(event)
      expect(service.isAppLocked(), event).toBe(true)
      expect(service.isSpaceLocked('work'), event).toBe(true)
      expect(heard).toHaveBeenCalledTimes(1)
    }
  })

  it('locks only the spaces when the application is not set to be locked', async () => {
    const { service, fire } = setup({ lockEnabled: true, lockApp: false, lockedSpaces: ['work'] })
    service.start()
    await service.unlock({ target: { scope: 'space', spaceId: 'work' }, phrase: PHRASE })
    fire('suspend')
    expect(service.isAppLocked()).toBe(false)
    expect(service.isSpaceLocked('work')).toBe(true)
  })
})

describe('changing the lock', () => {
  it('chooses a phrase the first time: it must be long enough, and the lock goes on', async () => {
    const { service, files, settings, update, attached } = setup({}, false)
    expect(await service.configure({ op: 'set-phrase', phrase: 'court' })).toMatchObject({ ok: false, message: expect.stringMatching(/au moins 8/) })
    expect(files.setPhrase).not.toHaveBeenCalled()
    expect(await service.configure({ op: 'set-phrase', phrase: PHRASE })).toEqual({ ok: true })
    expect(files.setPhrase).toHaveBeenCalledWith(PHRASE)
    expect(update).toHaveBeenCalledWith({ lockEnabled: true })
    expect(settings.lockEnabled).toBe(true)
    expect(service.isActive()).toBe(true)
    expect(attached()).toBe(3)
  })

  it('changes the phrase only with the current one (this fails if the current phrase is not asked)', async () => {
    const { service, files } = setup({ lockEnabled: true })
    service.start()
    expect(await service.configure({ op: 'set-phrase', phrase: 'une nouvelle phrase' })).toMatchObject({ ok: false, message: expect.stringMatching(/phrase actuelle/) })
    expect(await service.configure({ op: 'set-phrase', phrase: 'une nouvelle phrase', current: 'pas la bonne phrase' })).toMatchObject({ ok: false, message: expect.stringMatching(/incorrecte/) })
    expect(files.phrase).toBe(PHRASE)
    expect(await service.configure({ op: 'set-phrase', phrase: 'une nouvelle phrase', current: PHRASE })).toEqual({ ok: true })
    expect(files.phrase).toBe('une nouvelle phrase')
  })

  it('switches the lock off only with the phrase, and then forgets the phrase and everything locked (this fails if the phrase is not asked)', async () => {
    const { service, files, settings, attached } = setup({ lockEnabled: true, lockApp: true, lockedSpaces: ['work'] })
    service.start()
    await service.unlock({ target: { scope: 'app' }, phrase: PHRASE })
    expect(await service.configure({ op: 'disable', current: 'pas la bonne phrase' })).toMatchObject({ ok: false })
    expect(settings.lockEnabled).toBe(true)
    expect(files.clear).not.toHaveBeenCalled()
    expect(await service.configure({ op: 'disable', current: PHRASE })).toEqual({ ok: true })
    expect(files.clear).toHaveBeenCalledTimes(1)
    expect(settings).toMatchObject({ lockEnabled: false, lockApp: false, lockedSpaces: [] })
    expect(service.isActive()).toBe(false)
    expect(attached()).toBe(0)
  })

  it('refuses every change while the application is locked', async () => {
    const { service, update } = setup({ lockEnabled: true, lockApp: true })
    service.start()
    for (const config of [{ op: 'app', value: false }, { op: 'disable', current: PHRASE }, { op: 'space', spaceId: 'work', locked: true }, { op: 'touch-id', value: false }, { op: 'set-phrase', phrase: 'une nouvelle phrase', current: PHRASE }] as const) {
      expect(await service.configure(config), config.op).toMatchObject({ ok: false, message: expect.stringMatching(/Déverrouillez Lucium/) })
    }
    expect(update).not.toHaveBeenCalled()
  })

  it('locks a space at once, and takes its lock away only while it is unlocked', async () => {
    const { service, settings, update } = setup({ lockEnabled: true })
    service.start()
    expect(await service.configure({ op: 'space', spaceId: 'work', locked: true })).toEqual({ ok: true })
    expect(update).toHaveBeenCalledWith({ lockedSpaces: ['work'] })
    expect(service.isSpaceLocked('work')).toBe(true)
    expect(await service.configure({ op: 'space', spaceId: 'work', locked: false })).toMatchObject({ ok: false, message: expect.stringMatching(/Déverrouillez l’espace/) })
    expect(settings.lockedSpaces).toEqual(['work'])
    await service.unlock({ target: { scope: 'space', spaceId: 'work' }, phrase: PHRASE })
    expect(await service.configure({ op: 'space', spaceId: 'work', locked: false })).toEqual({ ok: true })
    expect(settings.lockedSpaces).toEqual([])
    expect(service.isSpaceLocked('work')).toBe(false)
  })

  it('locks a space again at once when it is locked while it is unlocked', async () => {
    const { service } = setup({ lockEnabled: true, lockedSpaces: ['work'] })
    service.start()
    await service.unlock({ target: { scope: 'space', spaceId: 'work' }, phrase: PHRASE })
    expect(service.isSpaceLocked('work')).toBe(false)
    await service.configure({ op: 'space', spaceId: 'work', locked: true })
    expect(service.isSpaceLocked('work')).toBe(true)
  })

  it('refuses to lock a space that does not exist, or before a phrase is chosen', async () => {
    const withPhrase = setup({ lockEnabled: true })
    withPhrase.service.start()
    expect(await withPhrase.service.configure({ op: 'space', spaceId: 'ghost', locked: true })).toMatchObject({ ok: false, message: expect.stringMatching(/n’existe pas/) })
    const without = setup({}, false)
    expect(await without.service.configure({ op: 'space', spaceId: 'work', locked: true })).toMatchObject({ ok: false, message: expect.stringMatching(/phrase/) })
    expect(await without.service.configure({ op: 'app', value: true })).toMatchObject({ ok: false, message: expect.stringMatching(/phrase/) })
    expect(without.update).not.toHaveBeenCalled()
  })

  it('switches the application lock and Touch ID on and off, and locks now on request', async () => {
    const { service, update } = setup({ lockEnabled: true })
    service.start()
    expect(await service.configure({ op: 'app', value: true })).toEqual({ ok: true })
    expect(update).toHaveBeenLastCalledWith({ lockApp: true })
    expect(await service.configure({ op: 'touch-id', value: false })).toEqual({ ok: true })
    expect(update).toHaveBeenLastCalledWith({ lockTouchId: false })
    expect(await service.configure({ op: 'lock-now' })).toEqual({ ok: true })
    expect(service.isAppLocked()).toBe(true)
  })

  it('tells the user, and logs, when the phrase could not be saved', async () => {
    const { service, files, settings } = setup({}, false)
    files.setPhrase.mockRejectedValueOnce(new Error('read-only volume'))
    expect(await service.configure({ op: 'set-phrase', phrase: PHRASE })).toMatchObject({ ok: false, message: expect.stringMatching(/n’a pas pu être enregistrée/) })
    expect(logged.some((line) => line.includes('[lock] the phrase could not be saved'))).toBe(true)
    expect(settings.lockEnabled).toBe(false)
  })
})

describe('what the interface is told', () => {
  it('lists the spaces locked now and the spaces set to be locked', async () => {
    const { service } = setup({ lockEnabled: true, lockedSpaces: ['work', 'perso'] })
    service.start()
    await service.unlock({ target: { scope: 'space', spaceId: 'perso' }, phrase: PHRASE })
    expect(service.view()).toMatchObject({ active: true, appLocked: false, lockedSpaces: ['work'], guardedSpaces: ['work', 'perso'], retryInMs: 0 })
  })
})

describe('what the lock screen says follows the language of the interface', () => {
  const before = getLanguage()
  afterEach(() => setLanguage(before))

  it('says the wrong phrase, the wait and Touch ID in English when the language is English (and no longer in French)', async () => {
    setLanguage('en')
    const touch = setup({ lockEnabled: true, lockApp: true, lockTouchId: true })
    touch.service.start()
    touch.touchId.accept = false
    const refused = await touch.service.unlock({ target: { scope: 'app' } })
    expect(refused).toMatchObject({ ok: false, message: 'Touch ID didn’t go through: enter the passphrase.' })
    touch.touchId.on = false
    expect(await touch.service.unlock({ target: { scope: 'app' } })).toMatchObject({ ok: false, message: 'Touch ID isn’t available: enter the passphrase.' })

    const { service } = setup({ lockEnabled: true, lockApp: true })
    service.start()
    expect(await service.unlock({ target: { scope: 'app' }, phrase: 'wrong phrase one' })).toMatchObject({ ok: false, message: 'Wrong passphrase (2 attempts left before a waiting period).' })
    expect(await service.unlock({ target: { scope: 'app' }, phrase: 'wrong phrase two' })).toMatchObject({ ok: false, message: 'Wrong passphrase (1 attempt left before a waiting period).' })
    const third = await service.unlock({ target: { scope: 'app' }, phrase: 'wrong phrase three' })
    expect(third).toMatchObject({ ok: false, message: 'Wrong passphrase. Try again in 1 s.' })
  })

  it('tells in the language of the interface that the file of the phrase went missing', () => {
    setLanguage('en')
    const { service, notify } = setup({ lockEnabled: true, lockApp: true }, false)
    service.start()
    expect(notify).toHaveBeenCalledWith('The lock passphrase file is missing or unreadable: the lock has been turned off.')
  })
})

// The lock of a private window left alone (shared/private-lock.ts): the delay is a setting only the lock's handler changes, and the phrase of a window that holds a lock of
// its own is checked by `confirm`, which opens nothing of the application.
describe('the delay of the lock of a private window', () => {
  it('is set with the lock on, and « never » is always allowed', async () => {
    const { service, settings, update } = setup({ lockEnabled: true })
    service.start()
    expect(await service.configure({ op: 'private-idle', minutes: 15 })).toEqual({ ok: true })
    expect(update).toHaveBeenCalledWith({ lockPrivateIdle: 15 })
    expect(settings.lockPrivateIdle).toBe(15)
    expect(await service.configure({ op: 'private-idle', minutes: 0 })).toEqual({ ok: true })
    expect(settings.lockPrivateIdle).toBe(0)
  })

  it('needs a phrase: nothing could open the window again without one', async () => {
    const { service, settings, update } = setup({ lockEnabled: false }, false)
    const reply = await service.configure({ op: 'private-idle', minutes: 5 })
    expect(reply.ok).toBe(false)
    expect(update).not.toHaveBeenCalled()
    expect(settings.lockPrivateIdle).toBe(0)
    expect(await service.configure({ op: 'private-idle', minutes: 0 })).toEqual({ ok: true })
  })

  it('is refused while the application is locked, like every other change of the lock', async () => {
    const { service, settings } = setup({ lockEnabled: true, lockApp: true })
    service.start()
    expect((await service.configure({ op: 'private-idle', minutes: 5 })).ok).toBe(false)
    expect(settings.lockPrivateIdle).toBe(0)
  })

  it('tells the windows that follow the lock', async () => {
    const { service } = setup({ lockEnabled: true })
    service.start()
    const heard = vi.fn()
    service.subscribe(heard)
    await service.configure({ op: 'private-idle', minutes: 1 })
    expect(heard).toHaveBeenCalledTimes(1)
  })
})

describe('checking a phrase for a window that holds a lock of its own (confirm)', () => {
  it('says yes to the phrase and opens nothing of the application', async () => {
    const { service } = setup({ lockEnabled: true, lockApp: true })
    service.start()
    expect(service.isAppLocked()).toBe(true)
    expect(await service.confirm({ target: { scope: 'app' }, phrase: PHRASE })).toEqual({ ok: true })
    expect(service.isAppLocked()).toBe(true)
  })

  it('counts wrong phrases like the application\'s lock does: the same free tries, then the same wait', async () => {
    const { service } = setup({ lockEnabled: true })
    service.start()
    for (let i = 0; i < FREE_TRIES; i += 1) expect((await service.confirm({ target: { scope: 'app' }, phrase: 'wrong' })).ok).toBe(false)
    const slowed = await service.confirm({ target: { scope: 'app' }, phrase: PHRASE })
    expect(slowed.ok).toBe(false)
    expect(slowed).toMatchObject({ retryInMs: expect.any(Number) })
  })

  it('opens with Touch ID when the request carries no phrase, and refuses while there is no lock at all', async () => {
    const on = setup({ lockEnabled: true })
    on.service.start()
    expect(await on.service.confirm({ target: { scope: 'app' } })).toEqual({ ok: true })
    expect(on.touchId.prompt).toHaveBeenCalledTimes(1)
    const off = setup({ lockEnabled: false }, false)
    expect((await off.service.confirm({ target: { scope: 'app' }, phrase: PHRASE })).ok).toBe(false)
  })
})
