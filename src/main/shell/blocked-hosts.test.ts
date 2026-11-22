import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc-channels'

const listed = [{ host: 'ads.example', count: 3 }]
vi.mock('../blocking', () => ({ blockingService: () => ({ blockedHosts: (id: string) => (id === 'unknown' ? [] : listed) }) }))

const { BrowserNetwork } = await import('./browser-network')

type Asked = (this: unknown, tabId: string) => unknown
const blockedHosts = BrowserNetwork.prototype.blockedHosts as unknown as Asked

const windowWith = (privateWindow: boolean, tabs: Array<{ id: string; private?: boolean }>) => ({ isPrivate: () => privateWindow, store: { get: () => ({ tabs }) } })

describe('the hosts blocked on a tab, as the window gives them', () => {
  it('lists them for a tab of this window', () => {
    expect(blockedHosts.call(windowWith(false, [{ id: 'a' }]), 'a')).toEqual(listed)
  })

  it('lists none for a private tab, however many hosts the blocker saw', () => {
    expect(blockedHosts.call(windowWith(false, [{ id: 'a', private: true }]), 'a')).toEqual([])
  })

  it('lists none in a private window', () => {
    expect(blockedHosts.call(windowWith(true, [{ id: 'a' }]), 'a')).toEqual([])
  })

  it('lists none for a tab this window does not hold', () => {
    expect(blockedHosts.call(windowWith(false, [{ id: 'a' }]), 'b')).toEqual([])
  })
})

describe('the channel of the hosts blocked on a tab', () => {
  const source = (path: string): string => readFileSync(join(__dirname, path), 'utf8')

  it('is named once, asked through the preload, and answered only to a guarded sender that sent a text', () => {
    expect(Channel.blockedHosts).toBe('lucium:blocked-hosts')
    expect(source('../../preload/index.ts')).toContain('blockedHosts: (tabId) => ipcRenderer.invoke(Channel.blockedHosts, tabId)')
    expect(source('ipc.ts')).toContain("ipcMain.handle(Channel.blockedHosts, (e, tabId: unknown) => (guard(e.sender, Channel.blockedHosts) && typeof tabId === 'string' ? browser.blockedHosts(tabId) : []))")
  })
})
