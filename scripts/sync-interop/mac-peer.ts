// The Mac of the interoperability check (scripts/sync-interop/README.md): the REAL synchronisation service of the Mac (src/main/sync/, the same listener, pairing, session, merge and
// `sync/apply` of the reducer), run under Node with no Electron and no window, over a state it holds itself. It listens on a real address of this machine's local network (the
// door's filter of docs/synchronisation.md §6.2 is NOT relaxed), and a small control server on the loopback lets the iPhone side (the real Swift, in a simulator) drive it:
// pair it, change its tabs, read what it holds, read what it cost.
//
// What is a stand-in, and only that: the sealing of the identity key (a reversible XOR instead of `safeStorage`, which needs Electron) and the state holder (a plain object
// instead of the window's store). Nothing here is written outside a throw-away folder.

import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SidebarState, TabItem } from '@shared/model'
import { createInitialState, normalize, reduce, type Ctx } from '@shared/sidebar'
import { defaultTheme } from '@shared/theme'
import type { Action as SidebarAction } from '@shared/sidebar-actions'
import type { SyncPatch } from '@shared/sidebar-sync'
import { SYNC_CATEGORIES, type SyncCategory } from '@shared/sync-ipc'
import { isLocalAddress } from '../../src/main/sync/address-policy'
import { IdentityStore } from '../../src/main/sync/identity'
import { SafeClock } from '../../src/main/sync/safe-clock'
import type { SecretBox } from '../../src/main/sync/secret-box'
import { SyncService, type SessionPorts } from '../../src/main/sync/sync-service'
import { BaseStore } from '../../src/main/sync/bases'
import { SyncStore } from '../../src/main/sync/sync-store'

const box: SecretBox = { available: () => true, seal: (plain) => Buffer.from(plain.map((b) => b ^ 5)), open: (sealed) => Buffer.from(sealed.map((b) => b ^ 5)) }

/** The address of this machine the iPhone side is told to use: a private IPv4 of one interface, never the loopback (the filter of §6.2 refuses it). */
export function chooseHost(env: NodeJS.ProcessEnv = process.env, interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): { name: string; address: string } {
  const wanted = env.LUCIUM_INTEROP_INTERFACE
  const found: Array<{ name: string; address: string }> = []
  for (const [name, list] of Object.entries(interfaces)) {
    if (wanted !== undefined && wanted !== '' && name !== wanted) continue
    for (const info of list ?? []) if (info.family === 'IPv4' && !info.internal && isLocalAddress(info.address)) found.push({ name, address: info.address })
  }
  // The physical interfaces first (`en*`), then the rest (bridges of virtual machines).
  found.sort((a, b) => Number(!a.name.startsWith('en')) - Number(!b.name.startsWith('en')) || a.name.localeCompare(b.name))
  const first = found[0]
  if (first === undefined) throw new Error('this machine has no private IPv4 address on a network interface: the check needs a real local address (set LUCIUM_INTEROP_INTERFACE to choose the interface)')
  return first
}

export interface PeerSession {
  at: number
  /** What `host.apply` cost, in milliseconds (the reducer's `sync/apply`), summed over the session. */
  applyMs: number
  applies: number
}

export interface PeerSummary {
  spaces: Array<{ id: string; name: string }>
  folders: Array<{ id: string; spaceId: string; name: string }>
  /** Pinned tabs, then Today tabs, in the state's order. */
  tabs: Array<{ id: string; spaceId: string; pinned: boolean; title: string; url: string; customTitle: string | null; icon: string | null }>
  archive: Array<{ id: string; source: string; url: string }>
  favorites: Array<{ id: string; url: string }>
  shownTabBySpace: Record<string, string | null>
}

export function summaryOf(state: SidebarState): PeerSummary {
  return {
    spaces: state.spaces.map((space) => ({ id: space.id, name: space.name })),
    folders: state.folders.map((folder) => ({ id: folder.id, spaceId: folder.spaceId, name: folder.name })),
    tabs: state.tabs.map((tab) => ({ id: tab.id, spaceId: tab.spaceId, pinned: tab.pinned, title: tab.title, url: tab.url, customTitle: tab.customTitle ?? null, icon: tab.icon ?? null })),
    archive: state.archive.map((entry) => ({ id: entry.id, source: entry.source ?? '', url: entry.url })),
    favorites: state.favorites.map((favorite) => ({ id: favorite.id, url: favorite.url })),
    shownTabBySpace: { ...state.activeTabBySpace }
  }
}

/** The state of a Mac that has one space of its own and nothing else, through `normalize` (the door every state goes through). */
function initialState(): SidebarState {
  const base = createInitialState({ now: Date.now(), newId: () => randomUUID() })
  const space = { id: 'sp-mac', name: 'Du Mac', emoji: '🍎', theme: defaultTheme(), profileId: 'default' }
  return normalize({ ...base, spaces: [space], activeSpaceId: space.id, folders: [], tabs: [], favorites: [] } as SidebarState)
}

export class MacPeer {
  state: SidebarState
  readonly dir = mkdtempSync(join(tmpdir(), 'lucium-interop-mac-'))
  readonly host: { name: string; address: string }
  readonly service: SyncService
  readonly sessions: PeerSession[] = []
  readonly lockedSpaces = new Set<string>()
  /** The codes the Mac showed in the question « Autoriser ? », in order: the iPhone's must be the same (§4.6, §4.7). */
  readonly codesShown: string[] = []
  private readonly listeners: Array<() => void> = []
  private current: PeerSession = { at: 0, applyMs: 0, applies: 0 }
  private answerTimer: NodeJS.Timeout | null = null
  private answer: 'allow' | 'refuse' | 'none' = 'allow'
  private readonly cpuAtStart = process.cpuUsage()

  constructor(options: { host?: { name: string; address: string } } = {}) {
    this.host = options.host ?? chooseHost()
    this.state = initialState()
    const ports: SessionPorts = {
      host: {
        state: () => this.state,
        apply: (patch: SyncPatch) => {
          const started = performance.now()
          this.state = reduce(this.state, { type: 'sync/apply', patch }, this.ctx())
          this.current.applyMs += performance.now() - started
          this.current.applies++
          this.notify()
        },
        isSpaceLocked: (spaceId) => this.lockedSpaces.has(spaceId),
        isAppLocked: () => false
      },
      subscribe: (listener) => (this.listeners.push(listener), () => void this.listeners.splice(this.listeners.indexOf(listener), 1)),
      marksFile: join(this.dir, 'sync-marks.json'),
      basesDir: this.dir,
      appVersion: '1.1.4-interop',
      stateVersion: 1
    }
    this.service = new SyncService({
      store: new SyncStore(join(this.dir, 'sync.json')),
      identities: new IdentityStore(join(this.dir, 'sync-identity.json'), box),
      box,
      clock: new SafeClock(),
      // Only the chosen address is written in the QR and in `hello.hosts`; a name that is not `.local` is never written.
      hostEnv: () => ({ hostname: 'interop-mac', interfaces: { [this.host.name]: [{ address: this.host.address, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${this.host.address}/24` }] } }),
      deviceName: () => 'Mac interop',
      now: () => Date.now(),
      isLocked: () => false,
      session: ports
    })
  }

  private ctx(): Ctx {
    return { now: Date.now(), newId: () => randomUUID() }
  }

  notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /** What a person does at the Mac: an action of the reducer, then the state's subscribers (the marks) are told, as the window's store does. */
  dispatch(action: SidebarAction): void {
    this.state = reduce(this.state, action, this.ctx())
    this.notify()
  }

  /** `count` Today tabs in `spaceId`, each older than the 20 seconds an admission asks (§27.3), the page and title written from `prefix`. */
  seedToday(count: number, spaceId: string, prefix: string, ageMs = 120_000): void {
    const now = Date.now()
    const made: TabItem[] = []
    for (let index = 0; index < count; index++) {
      const id = `${prefix}-${String(index).padStart(3, '0')}`
      made.push({ id, spaceId, url: `https://${id}.example/page/${randomBytes(4).toString('hex')}`, title: `Page ${id}`, pinned: false, createdAt: now - ageMs - index, lastActiveAt: now - ageMs - index } as TabItem)
    }
    this.state = normalize({ ...this.state, tabs: [...this.state.tabs, ...made] })
    this.notify()
  }

  async enable(categories: SyncCategory[]): Promise<void> {
    await this.service.setEnabled(true)
    for (const category of SYNC_CATEGORIES) this.service.setCategory(category, categories.includes(category))
  }

  /** Opens a pairing and answers its question the way a person would (`allow` by default), a hundred milliseconds after it appears. */
  async pair(answer: 'allow' | 'refuse' | 'none' = 'allow'): Promise<{ qr: string; code: string; address: string }> {
    this.answer = answer
    await this.service.startPairing()
    this.answerTimer ??= setInterval(() => {
      const confirm = this.service.status().confirm
      if (confirm === null || confirm.waiting || this.answer === 'none') return
      this.codesShown.push(confirm.code)
      this.service.answer(this.answer === 'allow')
    }, 100)
    this.answerTimer.unref()
    const pairing = this.service.status().pairing
    if (pairing === null) throw new Error('the pairing sheet is not open')
    return { qr: pairing.qr, code: pairing.code, address: pairing.address }
  }

  /** Marks a session's start for the cost counters: called by the control server when the iPhone says one begins. */
  beginSession(): void {
    this.current = { at: Date.now(), applyMs: 0, applies: 0 }
    this.sessions.push(this.current)
  }

  metrics(): { cpuMs: number; rssBytes: number; heapBytes: number; sessions: PeerSession[]; uptimeS: number } {
    const used = process.cpuUsage(this.cpuAtStart)
    const memory = process.memoryUsage()
    return { cpuMs: (used.user + used.system) / 1000, rssBytes: memory.rss, heapBytes: memory.heapUsed, sessions: this.sessions, uptimeS: process.uptime() }
  }

  /** The Mac is done: the timer, the door and the identity of this peer go. The control server (ControlServer) is not this object's. */
  async dispose(): Promise<void> {
    if (this.answerTimer !== null) clearInterval(this.answerTimer)
    this.answerTimer = null
    await this.service.dispose()
  }
}

/** The control server: JSON in, JSON out, on the loopback only. It owns the current Mac, and `POST /reset` replaces it by a brand new one (a new identity, a new door, an empty state). */
export class ControlServer {
  peer: MacPeer
  private server: Server | null = null
  readonly stopped: Promise<void>
  private resolveStopped: () => void = () => undefined

  constructor(private readonly make: () => MacPeer = () => new MacPeer()) {
    this.peer = make()
    this.stopped = new Promise((resolve) => (this.resolveStopped = resolve))
  }

  /** Starts listening; returns the port. */
  async serve(port = 0): Promise<number> {
    const server = createServer((request, response) => void this.handle(request, response))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
    return (server.address() as { port: number }).port
  }

  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (code: number, value: unknown): void => {
      response.writeHead(code, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    try {
      const peer = this.peer
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const input = request.method === 'POST' ? await this.body(request) : {}
      switch (`${request.method} ${url.pathname}`) {
        case 'GET /state':
          return reply(200, summaryOf(peer.state))
        case 'GET /status': {
          const { pairing: _pairing, ...status } = peer.service.status()
          return reply(200, { ...status, codesShown: peer.codesShown, locked: [...peer.lockedSpaces] })
        }
        case 'GET /base': {
          const base = new BaseStore(peer.dir).get(url.searchParams.get('peer') ?? '', Date.now())
          return reply(200, base === null ? null : { hash: base.hash, entities: Object.values(base.snapshot.entities).reduce((sum, kind) => sum + Object.keys(kind).length, 0) })
        }
        case 'GET /metrics':
          return reply(200, peer.metrics())
        case 'POST /reset':
          await peer.dispose()
          this.peer = this.make()
          return reply(200, { ok: true })
        case 'POST /enable':
          await peer.enable((input.categories as SyncCategory[] | undefined) ?? ['structure'])
          return reply(200, { ok: true })
        case 'POST /categories':
          for (const category of SYNC_CATEGORIES) peer.service.setCategory(category, ((input.categories as SyncCategory[] | undefined) ?? []).includes(category))
          return reply(200, { ok: true })
        case 'POST /pair':
          return reply(200, await peer.pair((input.answer as 'allow' | 'refuse' | 'none' | undefined) ?? 'allow'))
        case 'POST /dispatch':
          peer.dispatch(input.action as SidebarAction)
          return reply(200, { ok: true })
        case 'POST /seed-today':
          peer.seedToday(Number(input.count), String(input.spaceId), String(input.prefix), input.ageMs === undefined ? undefined : Number(input.ageMs))
          return reply(200, { ok: true })
        case 'POST /lock-space':
          if (input.locked === true) peer.lockedSpaces.add(String(input.id))
          else peer.lockedSpaces.delete(String(input.id))
          peer.notify()
          return reply(200, { ok: true })
        case 'POST /begin-session':
          peer.beginSession()
          return reply(200, { ok: true })
        case 'POST /stop':
          reply(200, { ok: true })
          return void setTimeout(() => void this.stop(), 50)
        default:
          return reply(404, { error: `no route ${request.method} ${url.pathname}` })
      }
    } catch (error) {
      console.error('[mac-peer] a request failed:', error)
      reply(500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  async stop(): Promise<void> {
    await this.peer.dispose()
    await new Promise<void>((resolve) => (this.server === null ? resolve() : this.server.close(() => resolve())))
    this.resolveStopped()
  }
}
