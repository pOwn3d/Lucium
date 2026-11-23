// The background look and its notice (auto-update.ts), with the feed, the window and the clock given by the test: when the notice comes, when it
// comes back, when it stops coming, and what it offers. Nothing reaches the network and no window opens.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import type { DropOutcome, DroppedNotice, InstallerState, UpdateNotice } from '@shared/auto-update'
import type { FeedAnswer } from '@shared/update-check'
import type { FeedTarget } from '@shared/update-target'

vi.mock('electron', () => ({ app: { getVersion: () => '0.2.1', isPackaged: false, on: vi.fn(), off: vi.fn() }, autoUpdater: {}, BrowserWindow: {}, dialog: {}, net: {}, shell: {} }))

const { AutoUpdater } = await import('./auto-update')

// Each launch starts its updater (the focus is listened to from there); its timers are the test's, and never run unless the test says so.
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const HOUR = 60 * 60 * 1000
const FEED = 'https://test.lucium.app/updates/darwin-arm64/feed.json'
const ZIP = 'https://test.lucium.app/updates/darwin-arm64/Lucium-0.2.2-arm64.zip'
const releaseFile = (version: string): FeedAnswer => ({ ok: true, json: { currentRelease: version, releases: [{ version, updateTo: { url: ZIP.replace('0.2.2', version), notes: '' } }] } })

/** A profile kept across launches (the memory of the notices lives in its settings), and the clock of the test. */
function profile(over: Partial<Settings> = {}) {
  let settings: Settings = { ...defaultSettings(), autoUpdate: true, ...over }
  const clock = { now: 0 }
  return {
    clock,
    settings: () => settings,
    set: (patch: Partial<Settings>) => {
      settings = { ...settings, ...patch }
    }
  }
}

/** One launch of Lucium on that profile: a fresh updater, with a feed, a window that may or may not show the notice, and an installer. */
function launch(p: ReturnType<typeof profile>, options: { answer?: () => FeedAnswer; window?: () => boolean; installer?: InstallerState | null; target?: FeedTarget } = {}) {
  const shown: UpdateNotice[] = []
  const told: DroppedNotice[] = []
  const fetchFeed = vi.fn(async () => (options.answer ?? (() => releaseFile('0.2.2')))())
  let focus: (() => void) | null = null
  const updater = new AutoUpdater({
    settings: p.settings,
    version: '0.2.1',
    // The feed of this test is a release file of macOS (no `platform`): it is read as one, on whatever system the test runs.
    target: options.target ?? { platform: 'darwin', arch: 'arm64' },
    feed: (settings) => (settings.autoUpdate ? FEED : null),
    fetchFeed,
    notify: (notice) => {
      if (options.window && !options.window()) return false
      shown.push(notice)
      return true
    },
    notifyDropped: (notice) => {
      if (options.window && !options.window()) return false
      told.push(notice)
      return true
    },
    remember: (updateNotices) => p.set({ updateNotices }),
    installer: () => options.installer ?? null,
    watchFocus: (listener) => {
      focus = listener
      return () => {
        focus = null
      }
    },
    now: () => p.clock.now
  })
  updater.start()
  return { updater, shown, told, fetchFeed, focus: () => focus?.() }
}

const installer = (state: Partial<Record<'canInstall' | 'isDownloading' | 'isReady', boolean>> & { ready?: string } = {}): InstallerState => ({
  canInstall: () => state.canInstall ?? true,
  isDownloading: () => state.isDownloading ?? false,
  isReady: () => state.isReady ?? false,
  readyVersion: () => state.ready ?? ''
})

describe('the background look', () => {
  it('offers nothing from a release file that is for another system than the one it runs on', async () => {
    // The file of macOS, with no `platform`, is for a Mac: a Windows or a Linux copy that was served it (whatever its signature) takes nothing from it.
    for (const target of [{ platform: 'win32', arch: 'x64' }, { platform: 'linux', arch: 'x64' }] as const) {
      const { updater, shown } = launch(profile(), { target })
      expect(await updater.check(), target.platform).toMatchObject({ kind: 'failed' })
      expect(shown, target.platform).toEqual([])
    }
  })

  it('offers a newer version in a notice, once, and counts the showing in the profile', async () => {
    const p = profile()
    const run = launch(p, { installer: installer() })
    expect((await run.updater.check())?.kind).toBe('available')
    expect(run.shown.map((n) => [n.kind, n.version])).toEqual([['install', '0.2.2']])
    expect(p.settings().updateNotices).toEqual({ version: '0.2.2', shown: 1 })
  })

  it('sends nothing and shows nothing with the setting off', async () => {
    const p = profile({ autoUpdate: false })
    const run = launch(p)
    expect(await run.updater.check()).toBeNull()
    expect(run.fetchFeed).not.toHaveBeenCalled()
    expect(run.shown).toEqual([])
  })

  it('shows nothing when the look fails, and offers the version at the next look that succeeds', async () => {
    const p = profile()
    let answer: FeedAnswer = { ok: false, reason: 'net::ERR_INTERNET_DISCONNECTED' }
    const run = launch(p, { answer: () => answer })
    expect((await run.updater.check())?.kind).toBe('failed')
    expect(run.shown).toEqual([])
    expect(p.settings().updateNotices).toEqual({ version: '', shown: 0 })
    answer = releaseFile('0.2.2')
    p.clock.now += 24 * HOUR
    await run.updater.check()
    expect(run.shown).toHaveLength(1)
  })

  it('shows nothing for a version that is not newer', async () => {
    const run = launch(profile(), { answer: () => releaseFile('0.2.1') })
    expect((await run.updater.check())?.kind).toBe('up-to-date')
    expect(run.shown).toEqual([])
  })
})

describe('a running version the feed lists as withdrawn', () => {
  const withdrawnFile = (version: string): FeedAnswer => {
    const file = releaseFile(version)
    return file.ok ? { ok: true, json: { ...(file.json as object), page: 'https://test.lucium.app/telecharger/', withdrawn: ['0.2.1'] } } : file
  }

  it('is told in the notice, with the version to install; an earlier one only by the download page, even in a run that installs updates', async () => {
    const p = profile()
    const run = launch(p, { answer: () => withdrawnFile('0.2.0'), installer: installer() })
    expect(await run.updater.check()).toMatchObject({ kind: 'withdrawn', newer: false })
    expect(run.shown.map((n) => [n.kind, n.version, n.withdrawn, n.current])).toEqual([['page', '0.2.0', true, '0.2.1']])
    expect(run.shown[0]?.offer.url).toBe('https://test.lucium.app/telecharger/')
    expect(p.settings().updateNotices).toEqual({ version: '0.2.0', shown: 1 })
  })

  it('is told with « Installer » when the version to install is above it', async () => {
    const run = launch(profile(), { answer: () => withdrawnFile('0.2.2'), installer: installer() })
    expect(await run.updater.check()).toMatchObject({ kind: 'withdrawn', newer: true })
    expect(run.shown.map((n) => [n.kind, n.version, n.withdrawn])).toEqual([['install', '0.2.2', true]])
  })

  it('does not mark the notice of an ordinary update as a withdrawal', async () => {
    const run = launch(profile(), { installer: installer() })
    await run.updater.check()
    expect(run.shown[0]?.withdrawn).toBeUndefined()
  })

  it('follows the rules of every notice: once a day, three times at most, never with the setting off', async () => {
    const p = profile()
    for (let launched = 0; launched < 4; launched++) {
      const run = launch(p, { answer: () => withdrawnFile('0.2.0') })
      await run.updater.check()
      await run.updater.check()
      expect(run.shown).toHaveLength(launched < 3 ? 1 : 0)
      run.updater.stop()
    }
    const off = launch(profile({ autoUpdate: false }), { answer: () => withdrawnFile('0.2.0') })
    expect(await off.updater.check()).toBeNull()
    expect(off.shown).toEqual([])
  })

  it('waits for a window that may show it, like any notice', async () => {
    let front = false
    const run = launch(profile(), { answer: () => withdrawnFile('0.2.0'), window: () => front })
    await run.updater.check()
    expect(run.shown).toEqual([])
    front = true
    run.focus()
    expect(run.shown.map((n) => [n.kind, n.withdrawn])).toEqual([['page', true]])
  })
})

describe('« Plus tard »', () => {
  it('does not bring the same version back in the same run before 24 h', async () => {
    const p = profile()
    const run = launch(p)
    await run.updater.check()
    // « Plus tard » closes the notice; another look, or a window that takes the focus, comes before the day is over.
    p.clock.now += 23 * HOUR
    await run.updater.check()
    run.focus()
    expect(run.shown).toHaveLength(1)
    p.clock.now += HOUR
    run.focus()
    expect(run.shown).toHaveLength(2)
  })

  it('brings it back at the next launch, without waiting for the day', async () => {
    const p = profile()
    await launch(p).updater.check()
    p.clock.now += HOUR
    const next = launch(p)
    await next.updater.check()
    expect(next.shown).toHaveLength(1)
  })

  it('does not hold back a newer version', async () => {
    const p = profile()
    let version = '0.2.2'
    const run = launch(p, { answer: () => releaseFile(version) })
    await run.updater.check()
    version = '0.2.3'
    p.clock.now += HOUR
    await run.updater.check()
    expect(run.shown.map((n) => n.version)).toEqual(['0.2.2', '0.2.3'])
  })
})

describe('a version passed over three times', () => {
  it('does not come back by itself at the fourth launch, but the look still finds it (the menu offers it)', async () => {
    const p = profile()
    for (let n = 1; n <= 3; n++) {
      const run = launch(p)
      await run.updater.check()
      expect(run.shown, `launch ${n}`).toHaveLength(1)
    }
    expect(p.settings().updateNotices).toEqual({ version: '0.2.2', shown: 3 })
    const fourth = launch(p)
    expect((await fourth.updater.check())?.kind).toBe('available')
    fourth.focus()
    expect(fourth.shown).toEqual([])
  })

  it('counts only the showings left without « Installer »', async () => {
    const p = profile()
    for (let n = 1; n <= 3; n++) {
      const run = launch(p, { installer: installer() })
      await run.updater.check()
      // The second time, the person clicked « Installer » (the download then failed, say).
      if (n === 2) run.shown[0]!.accepted()
    }
    expect(p.settings().updateNotices).toEqual({ version: '0.2.2', shown: 2 })
    const fourth = launch(p, { installer: installer() })
    await fourth.updater.check()
    expect(fourth.shown).toHaveLength(1)
  })

  it('leaves a newer version free to come', async () => {
    const p = profile({ updateNotices: { version: '0.2.2', shown: 3 } })
    const run = launch(p, { answer: () => releaseFile('0.2.3') })
    await run.updater.check()
    expect(run.shown.map((n) => n.version)).toEqual(['0.2.3'])
    expect(p.settings().updateNotices).toEqual({ version: '0.2.3', shown: 1 })
  })
})

describe('an update already downloaded', () => {
  it('is offered as « Installer et relancer », with the version that waits', async () => {
    const run = launch(profile(), { answer: () => releaseFile('0.2.3'), installer: installer({ isReady: true, ready: '0.2.2' }) })
    await run.updater.check()
    expect(run.shown.map((n) => [n.kind, n.version])).toEqual([['restart', '0.2.2']])
  })

  it('is not offered while its download runs: the boxes of the download follow', async () => {
    const run = launch(profile(), { installer: installer({ isDownloading: true }) })
    await run.updater.check()
    run.focus()
    expect(run.shown).toEqual([])
  })
})

describe('the window of the notice', () => {
  it('waits for a window that may show it (a private window alone, a share, Lucium in the background), without counting, and shows at the next focus', async () => {
    const p = profile()
    let allowed = false
    const run = launch(p, { window: () => allowed })
    await run.updater.check()
    run.focus()
    expect(run.shown).toEqual([])
    expect(p.settings().updateNotices).toEqual({ version: '', shown: 0 })
    allowed = true
    run.focus()
    expect(run.shown).toHaveLength(1)
    expect(p.settings().updateNotices).toEqual({ version: '0.2.2', shown: 1 })
  })

  it('forgets what waited when the setting goes off', async () => {
    const p = profile()
    let allowed = false
    const run = launch(p, { window: () => allowed })
    await run.updater.check()
    run.updater.stop()
    allowed = true
    run.focus()
    expect(run.updater.offer()).toBe(false)
    expect(run.shown).toEqual([])
  })
})

describe('an update already downloaded, then withdrawn from the feed', () => {
  /** An installer whose 0.2.2 waits, and that drops it when the feed lists it (or fails to). */
  const waiting = (outcome: 'dropped' | 'failed' = 'dropped') => {
    const asked: string[][] = []
    let ready = true
    const state: InstallerState = {
      canInstall: () => true,
      isDownloading: () => false,
      isReady: () => ready,
      readyVersion: () => (ready ? '0.2.2' : ''),
      dropWithdrawn: async (withdrawn): Promise<DropOutcome> => {
        asked.push([...withdrawn])
        if (!withdrawn.includes('0.2.2')) return { kind: 'kept' }
        ready = false
        return { kind: outcome, version: '0.2.2' }
      }
    }
    return { state, asked }
  }
  const withdrawing = (current: string, withdrawn: string[]): FeedAnswer => {
    const file = releaseFile(current) as { ok: true; json: Record<string, unknown> }
    return { ok: true, json: { ...file.json, withdrawn } }
  }

  it('is dropped at the next look, said once, and the version the feed offers now is the one to install', async () => {
    const p = profile()
    const { state, asked } = waiting()
    const run = launch(p, { answer: () => withdrawing('0.2.3', ['0.2.2']), installer: state })
    await run.updater.check()
    expect(asked).toEqual([['0.2.2']])
    expect(run.shown.map((n) => [n.kind, n.version, n.dropped])).toEqual([['install', '0.2.3', { version: '0.2.2', failed: false }]])
  })

  it('is said alone when the feed offers nothing newer than the running version', async () => {
    const run = launch(profile(), { answer: () => withdrawing('0.2.1', ['0.2.2']), installer: waiting().state })
    await run.updater.check()
    expect(run.shown).toEqual([])
    expect(run.told).toEqual([{ kind: 'dropped', dropped: { version: '0.2.2', failed: false } }])
  })

  it('is said, with « Lucium n’a pas pu l’écarter », when what Squirrel staged could not be removed', async () => {
    const run = launch(profile(), { answer: () => withdrawing('0.2.3', ['0.2.2']), installer: waiting('failed').state })
    await run.updater.check()
    expect(run.shown.map((n) => n.dropped)).toEqual([{ version: '0.2.2', failed: true }])
  })

  it('is kept, and offered as « Installer et relancer », while the feed does not list it', async () => {
    const run = launch(profile(), { answer: () => withdrawing('0.2.3', ['0.2.0']), installer: waiting().state })
    await run.updater.check()
    expect(run.shown.map((n) => [n.kind, n.version, n.dropped])).toEqual([['restart', '0.2.2', undefined]])
  })

  it('is said even when the version offered with it was passed over three times', async () => {
    const run = launch(profile({ updateNotices: { version: '0.2.3', shown: 3 } }), { answer: () => withdrawing('0.2.3', ['0.2.2']), installer: waiting().state })
    await run.updater.check()
    expect(run.shown.map((n) => n.dropped?.version)).toEqual(['0.2.2'])
  })

  it('dropped at the quit of the last run, is said at the first look of this one, then forgotten', async () => {
    const p = profile({ updateNotices: { version: '0.2.2', shown: 1, dropped: '0.2.2' } })
    const run = launch(p, { answer: () => releaseFile('0.2.1'), installer: installer() })
    await run.updater.check()
    expect(run.told).toEqual([{ kind: 'dropped', dropped: { version: '0.2.2', failed: false } }])
    expect(p.settings().updateNotices).toEqual({ version: '0.2.2', shown: 1 })
    // Told once: the next look says nothing.
    await run.updater.check()
    expect(run.told).toHaveLength(1)
  })

  it('dropped at the last quit with a newer version out since, is said with it, and forgotten once shown', async () => {
    const p = profile({ updateNotices: { version: '0.2.2', shown: 1, dropped: '0.2.2' } })
    const run = launch(p, { answer: () => releaseFile('0.2.3'), installer: installer() })
    await run.updater.check()
    expect(run.shown.map((n) => [n.kind, n.version, n.dropped])).toEqual([['install', '0.2.3', { version: '0.2.2', failed: false }]])
    expect(p.settings().updateNotices).toEqual({ version: '0.2.3', shown: 1 })
  })
})

describe('an update that fixes a flaw the feed says is urgent', () => {
  const urgentFile = (version: string, security: unknown = version): FeedAnswer => {
    const file = releaseFile(version)
    return { ok: true, json: { ...(file as { json: object }).json, security } }
  }

  it('is shown whatever the count: the cap of three showings does not hold it back', async () => {
    const p = profile()
    for (let n = 1; n <= 5; n++) {
      const run = launch(p, { answer: () => urgentFile('0.2.2') })
      await run.updater.check()
      expect(run.shown, `launch ${n}`).toHaveLength(1)
      expect(run.shown[0]!.urgent, `launch ${n}`).toBe(true)
      run.updater.stop()
    }
    // The showings of an urgent notice are not counted: the ordinary rule starts from where it was when the flaw is no longer news.
    expect(p.settings().updateNotices.shown).toBe(0)
  })

  it('is shown even when the version was already passed over three times', async () => {
    const p = profile({ updateNotices: { version: '0.2.2', shown: 3 } })
    const run = launch(p, { answer: () => urgentFile('0.2.2') })
    await run.updater.check()
    expect(run.shown).toHaveLength(1)
    // ... and the count the ordinary notice had is left as it was.
    expect(p.settings().updateNotices).toEqual({ version: '0.2.2', shown: 3 })
  })

  it('reaches the words of the notice: the sidebar toast says the flaw, not the ordinary sentence', async () => {
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(new URL('./app-update.ts', import.meta.url), 'utf8')).toContain('notice.withdrawn === true, notice.dropped, notice.urgent === true)')
  })

  it('is not shown again in the same run before 24 h: urgent is not a nag', async () => {
    const p = profile()
    const run = launch(p, { answer: () => urgentFile('0.2.2') })
    await run.updater.check()
    await run.updater.check()
    run.focus()
    expect(run.shown).toHaveLength(1)
  })

  it('is the ordinary notice, held by the cap, when the feed does not say so, or says it for a version the offer does not reach', async () => {
    for (const answer of [releaseFile('0.2.2'), urgentFile('0.2.2', 'soon'), urgentFile('0.2.2', '0.2.3')]) {
      const p = profile({ updateNotices: { version: '0.2.2', shown: 3 } })
      const run = launch(p, { answer: () => answer })
      await run.updater.check()
      expect(run.shown, JSON.stringify((answer as { json: unknown }).json)).toEqual([])
    }
  })

  it('does not mark the notice urgent when the running version already has the fix', async () => {
    const run = launch(profile(), { answer: () => urgentFile('0.2.2', '0.2.1') })
    await run.updater.check()
    expect(run.shown).toHaveLength(1)
    expect(run.shown[0]!.urgent).toBeUndefined()
  })
})
