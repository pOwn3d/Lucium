// Two devices of the synchronisation in one test: each with its own state, marks, bases and clock, joined by a pair of real sockets, running `runSession` against each
// other. What a test asserts is what a person would see: the same spaces, folders, tabs and favourites on both, and nothing written when a session fails.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInitialState, normalize, reduce, type Ctx } from '@shared/sidebar'
import type { Favorite, Folder, SidebarState, Space, TabItem } from '@shared/model'
import type { SyncPatch } from '@shared/sidebar-sync'
import type { SyncCategory } from '@shared/sync-ipc'
import { defaultTheme } from '@shared/theme'
import { tempDir } from '../temp-dir'
import { BaseStore } from './bases'
import { Channel } from './channel'
import { MarkBook } from './marks'
import { runSession, type SessionDeps, type SessionResult } from './session'
import { admittedTodayTabs, trackedViewOf } from './state-view'
import { socketPair } from './sync-net.test-support'

export const MAC_ID = 'mac-device-0000000001'
export const PHONE_ID = 'iphone-device-0000001'
export const NOW = 1_790_000_000_000

export interface Seed {
  spaces?: Array<Partial<Space> & { id: string }>
  folders?: Array<Partial<Folder> & { id: string; spaceId: string }>
  tabs?: Array<Partial<TabItem> & { id: string; spaceId: string }>
  favorites?: Array<Partial<Favorite> & { id: string }>
  settings?: Record<string, unknown>
}

/** A state made of what the test names, through `normalize` (the door every state goes through). */
export function stateOf(seed: Seed): SidebarState {
  const base = createInitialState({ now: NOW, newId: () => 'unused' })
  const spaces = (seed.spaces ?? [{ id: 'sp-main' }]).map((space) => ({ name: space.id, emoji: '🏠', theme: defaultTheme(), profileId: 'default', ...space }))
  return normalize({
    ...base,
    spaces,
    activeSpaceId: spaces[0]!.id,
    folders: (seed.folders ?? []).map((folder) => ({ name: folder.id, collapsed: false, ...folder })),
    tabs: (seed.tabs ?? []).map((tab) => ({ url: `https://${tab.id}.example/`, title: tab.id, pinned: true, createdAt: NOW, lastActiveAt: NOW, ...tab })),
    favorites: (seed.favorites ?? []).map((favorite) => ({ url: `https://${favorite.id}.example/`, title: favorite.id, profileId: 'default', ...favorite })),
    settings: { ...base.settings, ...seed.settings }
  } as SidebarState)
}

export class Device {
  state: SidebarState
  readonly marks: MarkBook
  readonly bases: BaseStore
  clock = NOW
  categories: Set<SyncCategory>
  locked = new Set<string>()
  appLocked = false
  stateVersion = 1
  openTabs: Array<{ id: string; spaceId: string; url: string; title: string; lastActiveAt: number }> = []
  /** The tabs a session closed that were the selected one of their space (§27.5). */
  shownClosed: Array<{ id: string; spaceId: string; onScreen: boolean }[]> = []
  received: Array<{ peer: string; items: unknown[] }> = []
  refused: Array<Array<{ kind: string; id: string; reason: string }>> = []
  unpaired: string[] = []
  done: string[] = []
  warnings: string[] = []
  applied: SyncPatch[] = []
  saves = 0
  merge: SessionDeps['merge']
  /** Called with the host just before the merge result is applied: a test makes the person act in the middle of a session. */
  duringSession: (() => void) | undefined

  constructor(
    readonly id: string,
    readonly platform: 'mac' | 'ios',
    seed: Seed,
    categories: SyncCategory[] = ['structure']
  ) {
    this.state = stateOf(seed)
    this.marks = new MarkBook(id)
    const dir = tempDir('lucium-sync-device-')
    mkdirSync(dir, { recursive: true })
    this.bases = new BaseStore(join(dir))
    this.categories = new Set(categories)
  }

  /** The state changes the way a person changes it: through the reducer, with a clock that moves. */
  edit(change: (state: SidebarState) => SidebarState, advanceMs = 1000): void {
    this.clock += advanceMs
    this.state = change(this.state)
    this.marks.update(trackedViewOf(this.state, this.admitted()), this.clock)
  }

  /** The Today tabs the book holds, as the tracker follows them between two sessions (§27.3: only a session admits a new one). */
  admitted(): ReadonlySet<string> {
    return admittedTodayTabs(this.state, { book: this.marks, now: this.clock, admitNew: false, isSpaceLocked: () => false })
  }

  private deps(): SessionDeps {
    const device = this
    const host = {
      state: () => device.state,
      apply: (patch: SyncPatch) => {
        device.duringSession?.()
        device.applied.push(patch)
        const ctx: Ctx = { now: device.clock, newId: () => 'made' }
        device.state = reduce(device.state, { type: 'sync/apply', patch }, ctx)
      },
      isSpaceLocked: (spaceId: string) => device.locked.has(spaceId),
      isAppLocked: () => device.appLocked
    }
    return {
      device: { id: this.id, name: this.id, platform: this.platform },
      host,
      marks: this.marks,
      saveMarks: () => void this.saves++,
      bases: this.bases,
      categories: () => this.categories,
      now: () => this.clock,
      appVersion: '1.2.0',
      stateVersion: this.stateVersion,
      hosts: () => ['mac.local'],
      ...(this.merge !== undefined ? { merge: this.merge } : {}),
      openTabs: () => this.openTabs,
      onOpenTabs: (peer, items) => void this.received.push({ peer, items }),
      onUnpair: (peer) => void this.unpaired.push(peer),
      onRefused: (_peer, refused) => void this.refused.push(refused),
      onShownTabsClosed: (_peer, tabs) => void this.shownClosed.push(tabs),
      onDone: (peer) => void this.done.push(peer),
      onWarning: (_peer, code) => void this.warnings.push(code)
    }
  }

  run(channel: Channel, peerId: string): Promise<SessionResult> {
    return runSession(channel, peerId, this.deps())
  }
}

/** Runs one session between two devices over a pair of real sockets; both results come back. */
export async function sync(mac: Device, phone: Device): Promise<{ mac: SessionResult; phone: SessionResult }> {
  const sockets = await socketPair()
  try {
    const macChannel = new Channel(sockets.server, { phase: 'session', role: 'mac' })
    const phoneChannel = new Channel(sockets.client, { phase: 'session', role: 'ios' })
    const [a, b] = await Promise.all([mac.run(macChannel, phone.id), phone.run(phoneChannel, mac.id)])
    return { mac: a, phone: b }
  } finally {
    sockets.close()
  }
}

/** What the two devices must agree on after a session: every synchronised entity with its synchronised fields, and the order of every list. */
export const synced = (device: Device): ReturnType<typeof trackedViewOf> => trackedViewOf(device.state, device.admitted())
