// The two channels of the lock, as `registerIpc` registers them for a window: who may unlock, who may change the lock, and what reaches the service.
// The readers of the requests are tested alone (shared/lock.test.ts) and the service too (lock-service.test.ts); here it is the handlers that are run,
// with the guard of the window and the service in their real places.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import type { LockReply } from '@shared/lock'
import { t } from '@shared/i18n'
import { setLockService } from '../lock-service'
import type { ScopedIpc } from './ipc-scope'
import { registerLockIpc } from './lock-ipc'

type Handler = (event: { sender: object }, raw: unknown) => Promise<LockReply>

/** The lock's channels of one window: the guard answers `trusted`, the window is private or not. */
function windowLock(options: { trusted?: boolean; private?: boolean; windowLocked?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const ipc: ScopedIpc = { on: () => undefined, handle: (channel, listener) => void handlers.set(channel, listener as unknown as Handler) }
  const guard = vi.fn(() => options.trusted ?? true)
  const unlockWindow = vi.fn()
  registerLockIpc(ipc, guard, { isPrivate: () => options.private === true, isWindowLocked: () => options.windowLocked === true, unlockWindow } as never)
  const sender = {}
  return { guard, sender, unlockWindow, ask: (channel: string, raw: unknown) => handlers.get(channel)!({ sender }, raw) }
}

/** A lock service that takes everything it is asked, and keeps it. */
function service() {
  const lock = { unlock: vi.fn(async () => ({ ok: true }) as LockReply), confirm: vi.fn(async () => ({ ok: true }) as LockReply), configure: vi.fn(async () => ({ ok: true }) as LockReply), isAppLocked: vi.fn(() => false) }
  setLockService(lock as never)
  return lock
}

const REFUSED = { ok: false, message: t('feature.demande-refusee') }
const INVALID = { ok: false, message: t('feature.demande-invalide') }

afterEach(() => setLockService(null))

describe('changing the lock (lock-configure)', () => {
  it('goes to the service from a normal window, as the reader of the request understood it', async () => {
    const lock = service()
    const window = windowLock()
    expect(await window.ask(Channel.lockConfigure, { op: 'disable', current: 'the phrase', more: 'ignored' })).toEqual({ ok: true })
    expect(lock.configure).toHaveBeenCalledWith({ op: 'disable', current: 'the phrase' })
    expect(window.guard).toHaveBeenCalledWith(window.sender, Channel.lockConfigure)
  })

  it('is refused to a private window, whatever it asks: the service hears nothing', async () => {
    const lock = service()
    const window = windowLock({ private: true })
    for (const request of [{ op: 'disable', current: 'the phrase' }, { op: 'app', value: false }, { op: 'set-phrase', phrase: 'another phrase' }, { op: 'space', spaceId: 's1', locked: false }, { op: 'lock-now' }]) {
      expect(await window.ask(Channel.lockConfigure, request)).toEqual(REFUSED)
    }
    expect(lock.configure).not.toHaveBeenCalled()
  })

  it('is refused when the guard of the window says no (an untrusted sender, a locked application)', async () => {
    const lock = service()
    expect(await windowLock({ trusted: false }).ask(Channel.lockConfigure, { op: 'disable', current: 'the phrase' })).toEqual(REFUSED)
    expect(lock.configure).not.toHaveBeenCalled()
  })

  it('never hands the service a request that is not one', async () => {
    const lock = service()
    const window = windowLock()
    for (const request of [null, 'disable', [], {}, { op: 'unknown' }, { op: 'disable' }, { op: 'app', value: 'false' }, { op: 'set-phrase', phrase: 'x'.repeat(100_000) }]) {
      expect(await window.ask(Channel.lockConfigure, request)).toEqual(INVALID)
    }
    expect(lock.configure).not.toHaveBeenCalled()
  })

  it('answers that the request is invalid while there is no lock service', async () => {
    expect(await windowLock().ask(Channel.lockConfigure, { op: 'lock-now' })).toEqual(INVALID)
  })
})

describe('unlocking (lock-unlock)', () => {
  it('goes to the service from any window, a private one included', async () => {
    const lock = service()
    for (const window of [windowLock(), windowLock({ private: true })]) {
      expect(await window.ask(Channel.lockUnlock, { target: { scope: 'app' }, phrase: 'the phrase' })).toEqual({ ok: true })
      expect(window.guard).toHaveBeenCalledWith(window.sender, Channel.lockUnlock)
    }
    expect(lock.unlock).toHaveBeenCalledTimes(2)
    expect(lock.unlock).toHaveBeenLastCalledWith({ target: { scope: 'app' }, phrase: 'the phrase' })
  })

  it('is refused when the guard of the window says no: a page that is not a surface of ours cannot try phrases', async () => {
    const lock = service()
    expect(await windowLock({ trusted: false }).ask(Channel.lockUnlock, { target: { scope: 'app' }, phrase: 'a guess' })).toEqual(REFUSED)
    expect(lock.unlock).not.toHaveBeenCalled()
  })

  it('never hands the service a request that is not one', async () => {
    const lock = service()
    const window = windowLock()
    for (const request of [null, 'app', {}, { target: 'app' }, { target: { scope: 'everything' } }, { target: { scope: 'space' } }, { target: { scope: 'app' }, phrase: 1 }, { target: { scope: 'app' }, phrase: 'x'.repeat(100_000) }]) {
      expect(await window.ask(Channel.lockUnlock, request)).toEqual(INVALID)
    }
    expect(lock.unlock).not.toHaveBeenCalled()
  })
})

// A private window left alone holds a lock of its own (shared/private-lock.ts): its lock screen asks for the application's target, the phrase is checked as the application's is
// (`confirm`, which opens nothing), and only that window opens.
describe('unlocking a private window left alone (lock-unlock)', () => {
  const request = { target: { scope: 'app' }, phrase: 'the phrase' }

  it('checks the phrase, opens this window, and leaves the application\'s lock out of it', async () => {
    const lock = service()
    const window = windowLock({ private: true, windowLocked: true })
    expect(await window.ask(Channel.lockUnlock, request)).toEqual({ ok: true })
    expect(lock.confirm).toHaveBeenCalledWith(request)
    expect(window.unlockWindow).toHaveBeenCalledTimes(1)
    expect(lock.unlock).not.toHaveBeenCalled()
  })

  it('keeps the window locked when the phrase is wrong, and passes the answer on (the waits and tries are the service\'s)', async () => {
    const lock = service()
    const wrong: LockReply = { ok: false, message: 'Phrase incorrecte', retryInMs: 1000 }
    lock.confirm.mockResolvedValueOnce(wrong)
    const window = windowLock({ private: true, windowLocked: true })
    expect(await window.ask(Channel.lockUnlock, request)).toEqual(wrong)
    expect(window.unlockWindow).not.toHaveBeenCalled()
  })

  it('opens the window with the application when both are locked: one phrase, the application\'s own unlocking', async () => {
    const lock = service()
    lock.isAppLocked.mockReturnValue(true)
    const window = windowLock({ private: true, windowLocked: true })
    expect(await window.ask(Channel.lockUnlock, request)).toEqual({ ok: true })
    expect(lock.unlock).toHaveBeenCalledWith(request)
    expect(lock.confirm).not.toHaveBeenCalled()
    expect(window.unlockWindow).toHaveBeenCalledTimes(1)
  })

  it('does not open the window for a space\'s unlocking, and a window that is not locked is unlocked as it always was', async () => {
    const lock = service()
    const locked = windowLock({ private: true, windowLocked: true })
    await locked.ask(Channel.lockUnlock, { target: { scope: 'space', spaceId: 's1' }, phrase: 'the phrase' })
    expect(locked.unlockWindow).not.toHaveBeenCalled()
    expect(lock.unlock).toHaveBeenCalledTimes(1)
    const open = windowLock({ private: true })
    await open.ask(Channel.lockUnlock, request)
    expect(open.unlockWindow).not.toHaveBeenCalled()
    expect(lock.confirm).not.toHaveBeenCalled()
  })
})

