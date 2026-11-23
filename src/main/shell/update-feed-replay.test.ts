// The anti-replay rule on the readers the application really uses (update-fresh.ts): the menu's check, the background look and the look before a quit, each fed by a
// signed feed on a throw-away key and a data folder of the test. An older feed than the last one accepted is refused wherever it is read, and a macOS copy sees nothing
// else change. Nothing reaches the network and no window opens.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { t } from '@shared/i18n'
import { FEED_MEMORY_FILE } from '../update-feed-memory'

const electron = vi.hoisted(() => ({ fetch: vi.fn(), showMessageBox: vi.fn(), openExternal: vi.fn(), userData: '' }))
vi.mock('electron', () => ({
  app: { getVersion: () => '1.1.0', getPath: () => electron.userData, isPackaged: false, on: vi.fn(), off: vi.fn() },
  net: { fetch: electron.fetch },
  dialog: { showMessageBox: electron.showMessageBox },
  shell: { openExternal: electron.openExternal },
  contentTracing: {},
  autoUpdater: {},
  BrowserWindow: { getFocusedWindow: () => null }
}))
const keys = await vi.hoisted(async () => {
  const { newFeedKeyPair } = await import('../update-feed-signature')
  return { ours: newFeedKeyPair() }
})
vi.mock('../update-feed-keys', () => ({ UPDATE_FEED_PUBLIC_KEYS: [keys.ours.publicKey] }))

const { signFeedText } = await import('../update-feed-signature')
const { createAutoUpdater, withdrawnInFeed } = await import('./auto-update')
const { checkForUpdates } = await import('./menu-actions')

const STALE = t('update-check.le-flux-de-mises-a-jour-est-plus-ancien-que-le-dernier-lu')
const WIN_FEED = 'https://lucium.app/updates/win32-x64/feed.json'
const MAC_FEED = 'https://lucium.app/updates/darwin-arm64/feed.json'
const settingsFor = (feed: string): Settings => ({ ...defaultSettings(), autoUpdate: true, updateFeedUrl: feed })

const windowsFile = (version: string, pub_date: string | undefined, extra: Record<string, unknown> = {}) => ({
  currentRelease: version,
  platform: 'win32',
  arch: 'x64',
  kind: 'nsis',
  releases: [{ version, updateTo: { url: `https://lucium.app/updates/win32-x64/Lucium-${version}-setup.exe`, notes: '', sha256: 'c'.repeat(64), size: 10, ...(pub_date === undefined ? {} : { pub_date }) } }],
  ...extra
})
const macFile = (version: string, pub_date: string | undefined, extra: Record<string, unknown> = {}) => ({
  currentRelease: version,
  releases: [{ version, updateTo: { url: `https://lucium.app/updates/darwin-arm64/Lucium-${version}-arm64.zip`, notes: '', ...(pub_date === undefined ? {} : { pub_date }) } }],
  ...extra
})
/** The feed as the server serves it: signed with the key the application carries. */
const serve = (json: unknown, url: string) => async () => {
  const bytes = new TextEncoder().encode(signFeedText(`${JSON.stringify(json, null, 2)}\n`, [keys.ours.privatePem]))
  return { ok: true, status: 200, url, arrayBuffer: async () => bytes.buffer as ArrayBuffer }
}

const real = { platform: Object.getOwnPropertyDescriptor(process, 'platform')!, arch: Object.getOwnPropertyDescriptor(process, 'arch')! }
const runOn = (platform: string, arch: string) => {
  Object.defineProperty(process, 'platform', { value: platform })
  Object.defineProperty(process, 'arch', { value: arch })
}

beforeEach(() => {
  electron.userData = mkdtempSync(join(tmpdir(), 'lucium-feed-replay-'))
  electron.fetch.mockReset()
  electron.showMessageBox.mockReset().mockResolvedValue({ response: 1 })
  vi.stubEnv('LUCIUM_UPDATE_FEED', undefined)
})
afterEach(() => {
  Object.defineProperty(process, 'platform', real.platform)
  Object.defineProperty(process, 'arch', real.arch)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(electron.userData, { recursive: true, force: true })
})

const menuBox = (at: number) => electron.showMessageBox.mock.calls[at]![1] as { message: string; detail: string }
const menu = (feed: string) => checkForUpdates({ win: {} } as Parameters<typeof checkForUpdates>[0], settingsFor(feed), { searching: false })
const background = (feed: string) =>
  createAutoUpdater({ settings: () => settingsFor(feed), update: vi.fn(), noticeWindow: () => null })

describe('a feed older than the last one accepted, on Windows', () => {
  beforeEach(() => runOn('win32', 'x64'))

  it('is refused by the menu, which says why in its box', async () => {
    electron.fetch.mockImplementation(serve(windowsFile('1.2.1', '2026-11-24T09:00:00Z'), WIN_FEED))
    await menu(WIN_FEED)
    expect(menuBox(0).message).toBe(t('app-update.la-version-version-est-disponible', { version: '1.2.1' }))
    electron.fetch.mockImplementation(serve(windowsFile('1.2.0', '2026-11-23T09:00:00Z'), WIN_FEED))
    await menu(WIN_FEED)
    expect(menuBox(1).message).toBe(t('menu-actions.la-verification-des-mises-a-jour-a-echoue'))
    expect(menuBox(1).detail).toBe(STALE)
  })

  it('is refused by the background look, which then offers nothing, and a newer one is offered again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    electron.fetch.mockImplementation(serve(windowsFile('1.2.1', '2026-11-24T09:00:00Z'), WIN_FEED))
    expect((await background(WIN_FEED).check())?.kind).toBe('available')
    electron.fetch.mockImplementation(serve(windowsFile('1.2.0', '2026-11-23T09:00:00Z'), WIN_FEED))
    expect(await background(WIN_FEED).check()).toEqual({ kind: 'failed', reason: STALE })
    expect(error.mock.calls.some(([line]) => String(line).includes('is refused: the feed is dated 2026-11-23'))).toBe(true)
    electron.fetch.mockImplementation(serve(windowsFile('1.2.2', '2026-11-25T09:00:00Z'), WIN_FEED))
    expect((await background(WIN_FEED).check())?.kind).toBe('available')
  })

  it('has its withdrawals not believed by the look before a quit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    electron.fetch.mockImplementation(serve(windowsFile('1.2.1', '2026-11-24T09:00:00Z', { withdrawn: ['1.1.9'] }), WIN_FEED))
    expect(await withdrawnInFeed(WIN_FEED)).toEqual(['1.1.9'])
    electron.fetch.mockImplementation(serve(windowsFile('1.2.0', '2026-11-23T09:00:00Z', { withdrawn: ['1.1.0'] }), WIN_FEED))
    expect(await withdrawnInFeed(WIN_FEED)).toBeNull()
    expect(warn.mock.calls.some(([line]) => String(line).includes(STALE))).toBe(true)
  })

  it('is the same one for the three readers: the date accepted by one is the memory of the others', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    electron.fetch.mockImplementation(serve(windowsFile('1.2.1', '2026-11-24T09:00:00Z'), WIN_FEED))
    await background(WIN_FEED).check()
    electron.fetch.mockImplementation(serve(windowsFile('1.2.0', '2026-11-23T09:00:00Z'), WIN_FEED))
    await menu(WIN_FEED)
    expect(menuBox(0).detail).toBe(STALE)
    expect(JSON.parse(readFileSync(join(electron.userData, FEED_MEMORY_FILE), 'utf8'))).toEqual({ [WIN_FEED]: Date.parse('2026-11-24T09:00:00Z') })
  })

  it('without a date is not readable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    electron.fetch.mockImplementation(serve(windowsFile('1.2.1', undefined), WIN_FEED))
    expect(await background(WIN_FEED).check()).toEqual({ kind: 'failed', reason: t('update-check.le-flux-de-mises-a-jour-n-est-pas-lisible') })
  })
})

describe('on macOS', () => {
  beforeEach(() => runOn('darwin', 'arm64'))

  it('a feed with no date is read as before and no file is written: nothing changes for a copy that is not replayed', async () => {
    electron.fetch.mockImplementation(serve(macFile('1.2.1', undefined, { withdrawn: ['1.1.0'] }), MAC_FEED))
    expect((await background(MAC_FEED).check())?.kind).toBe('withdrawn')
    expect(await withdrawnInFeed(MAC_FEED)).toEqual(['1.1.0'])
    expect(readdirSync(electron.userData)).toEqual([])
  })

  it('a feed with its date is read as before, each time it is read, and an older one is refused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    electron.fetch.mockImplementation(serve(macFile('1.2.1', '2026-11-24T09:00:00Z'), MAC_FEED))
    expect((await background(MAC_FEED).check())?.kind).toBe('available')
    expect((await background(MAC_FEED).check())?.kind).toBe('available')
    electron.fetch.mockImplementation(serve(macFile('1.2.0', '2026-11-20T09:00:00Z'), MAC_FEED))
    expect(await background(MAC_FEED).check()).toEqual({ kind: 'failed', reason: STALE })
  })
})
