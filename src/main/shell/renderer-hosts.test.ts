// What the task manager knows of each renderer that is not a tab's page: the window group names the
// surfaces of its windows, its pages that are not tabs and the frames of other sites of its tabs (Browser.rendererHosts, run on a stand-in);
// every other web contents and the service workers are named from Electron (renderer-hosts.ts, over fakes of it).

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RendererHost } from '@shared/processes'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

const fake = vi.hoisted(() => ({ contents: [] as unknown[], throwOnList: false }))
vi.mock('electron', () => {
  const own: Record<string, unknown> = {
    webContents: {
      getAllWebContents: () => {
        if (fake.throwOnList) throw new Error('no list')
        return fake.contents
      }
    }
  }
  return new Proxy(own, { get: (target, name: string) => (name in target ? target[name] : {}) })
})
// A surface of our interface is what surface-guard.ts locked: here, a fake that says so.
vi.mock('./surface-guard', () => ({ isSurfaceLocked: (wc: { surface?: boolean }) => wc.surface === true }))

const { Browser } = await import('./browser')
const { rendererHosts } = await import('./renderer-hosts')
const shell = methodsOf(Browser.prototype)

afterEach(() => {
  fake.contents.length = 0
  fake.throwOnList = false
  vi.restoreAllMocks()
})

describe('what the window group names (Browser.rendererHosts)', () => {
  const contents = (pid: number) => ({ isDestroyed: () => false, getOSProcessId: () => pid })
  const page = (pid: number, frames: number[] = []) => ({ processId: () => pid, frameProcessIds: () => frames })
  const windowOf = (base: number, own: Record<string, unknown> = {}) => ({
    win: { isDestroyed: () => false, webContents: contents(base) },
    overlay: { webContents: contents(base + 1) },
    floating: { current: () => ({ webContents: contents(base + 2) }) },
    tooltipWindow: { current: () => null },
    peek: null,
    webPanel: null,
    sidePanel: null,
    pages: new Map(),
    windowNames: null,
    ...own
  })

  function inventory(nameWindows: boolean): Map<number, RendererHost[]> {
    const main = windowOf(100, { tooltipWindow: { current: () => ({ webContents: contents(103) }) }, pages: new Map([['t1', page(500, [600, 601])], ['gone', page(510, [610])]]) })
    const second = windowOf(200, { windowNames: { own: () => 'Travail' }, peek: { page: page(700) }, webPanel: { page: page(710), title: 'Spotify' }, sidePanel: { page: page(720), name: 'Claude' } })
    const closed = windowOf(300, { win: { isDestroyed: () => true, webContents: contents(300) } })
    const third = windowOf(400)
    const state = { tabs: [{ id: 't1', title: 'Le Monde', customTitle: '' }], settings: { nameWindows } }
    const self = fakeBrowser({ group: new Set([main, second, closed, third]), leader: main, store: { get: () => state } }).self
    return shell['rendererHosts']!.call(self) as Map<number, RendererHost[]>
  }

  it('names the sidebar, the layer, the floating sidebar and the tooltip of each window, after the window', () => {
    const hosts = inventory(false)
    expect(hosts.get(100)).toEqual([{ kind: 'surface', surface: 'window', window: 'fenêtre principale' }])
    expect(hosts.get(101)).toEqual([{ kind: 'surface', surface: 'overlay', window: 'fenêtre principale' }])
    expect(hosts.get(102)).toEqual([{ kind: 'surface', surface: 'floating', window: 'fenêtre principale' }])
    expect(hosts.get(103)).toEqual([{ kind: 'surface', surface: 'tooltip', window: 'fenêtre principale' }])
    expect(hosts.get(200)).toEqual([{ kind: 'surface', surface: 'window', window: 'fenêtre 2' }])
    // The third window of the group is the fourth in it: a window being closed is skipped, and keeps its number.
    expect(hosts.has(300)).toBe(false)
    expect(hosts.get(400)).toEqual([{ kind: 'surface', surface: 'window', window: 'fenêtre 4' }])
  })

  it('uses the name the user gave the window when windows are named', () => {
    expect(inventory(true).get(201)).toEqual([{ kind: 'surface', surface: 'overlay', window: 'Travail' }])
  })

  it('names the Glance, the web panel and an extension\'s side panel, and the frames of other sites after their tab', () => {
    const hosts = inventory(true)
    expect(hosts.get(700)).toEqual([{ kind: 'page', page: 'peek', window: 'Travail' }])
    expect(hosts.get(710)).toEqual([{ kind: 'page', page: 'panel', window: 'Travail', title: 'Spotify' }])
    expect(hosts.get(720)).toEqual([{ kind: 'extension', name: 'Claude' }])
    expect(hosts.get(600)).toEqual([{ kind: 'subframe', tabId: 't1', tabName: 'Le Monde' }])
    expect(hosts.get(601)).toEqual([{ kind: 'subframe', tabId: 't1', tabName: 'Le Monde' }])
    // A page whose tab is gone names nothing.
    expect(hosts.has(610)).toBe(false)
  })
})

describe('what Electron tells of the other renderers (rendererHosts)', () => {
  interface FakeSession {
    persistent: boolean
    extensions: Record<string, string>
    workers: Array<{ scope: string; renderProcessId: number }>
  }
  const session = (own: Partial<FakeSession> = {}) => {
    const s: FakeSession = { persistent: true, extensions: {}, workers: [], ...own }
    return {
      isPersistent: () => s.persistent,
      extensions: { getExtension: (id: string) => (s.extensions[id] ? { name: s.extensions[id] } : null) },
      serviceWorkers: { getAllRunning: () => Object.fromEntries(s.workers.map((w, i) => [i, { ...w, scriptUrl: '', versionId: i }])) }
    }
  }
  const contents = (pid: number, clientId: number, url: string, ses: ReturnType<typeof session>, own: Record<string, unknown> = {}) => ({
    isDestroyed: () => false,
    getOSProcessId: () => pid,
    getProcessId: () => clientId,
    getURL: () => url,
    session: ses,
    mainFrame: { framesInSubtree: [{ processId: clientId, osProcessId: pid }] },
    ...own
  })
  const input = (own: Partial<Parameters<typeof rendererHosts>[0]> = {}) => ({ group: new Map(), pages: new Map(), renderers: [], tabOnOrigin: () => undefined, ...own })
  const EXT = 'abcdefghijklmnopabcdefghijklmnop'

  it('names what the group does not: an extension\'s page, a window of the interface, a private window\'s page, and nothing for a tab', async () => {
    const profile = session({ extensions: { [EXT]: 'Dashlane' } })
    const privateSession = session({ persistent: false })
    fake.contents.push(
      contents(10, 1, `chrome-extension://${EXT}/manifest.json`, profile),
      contents(11, 2, 'file:///x/out/renderer/settings.html', profile, { surface: true }),
      contents(12, 3, 'https://secret.example/', privateSession),
      contents(13, 4, 'https://github.com/', profile),
      contents(14, 5, 'file:///x/out/renderer/index.html', profile, { surface: true })
    )
    const group = new Map<number, RendererHost[]>([[14, [{ kind: 'surface', surface: 'window', window: 'fenêtre principale' }]]])
    const hosts = await rendererHosts(input({ group, pages: new Map([[13, 'GitHub']]) }))
    expect(hosts.get(10)).toEqual([{ kind: 'extension', name: 'Dashlane' }])
    expect(hosts.get(11)).toEqual([{ kind: 'app', page: 'settings' }])
    expect(hosts.get(12)).toEqual([{ kind: 'page', page: 'private' }])
    expect(hosts.has(13)).toBe(false)
    // What the group named stays as it named it.
    expect(hosts.get(14)).toEqual([{ kind: 'surface', surface: 'window', window: 'fenêtre principale' }])
  })

  it('places a service worker in the process of a web contents or a frame, after its extension or a tab of its site', async () => {
    const profile = session({
      extensions: { [EXT]: 'uBlock Origin Lite' },
      workers: [{ scope: `chrome-extension://${EXT}/`, renderProcessId: 7 }, { scope: 'https://mail.example/', renderProcessId: 8 }]
    })
    fake.contents.push(contents(20, 7, `chrome-extension://${EXT}/popup.html`, profile), contents(21, 8, 'https://mail.example/inbox', profile))
    const readCommandLines = vi.fn(async () => '')
    const hosts = await rendererHosts(input({ pages: new Map([[21, 'Boîte de réception']]), renderers: [20, 21], tabOnOrigin: (origin) => (origin === 'https://mail.example' ? 'Boîte de réception' : undefined) }), readCommandLines)
    expect(hosts.get(20)).toEqual([{ kind: 'extension', name: 'uBlock Origin Lite' }, { kind: 'extension', name: 'uBlock Origin Lite' }])
    expect(hosts.get(21)).toEqual([{ kind: 'worker', owner: 'Boîte de réception' }])
    // Every worker was placed through a web contents: no command line was read.
    expect(readCommandLines).not.toHaveBeenCalled()
  })

  it('reads the Chromium id of a process that runs a worker and no web contents from its command line, once', async () => {
    // The worker of process 77 is in none of them (its process just ended): looking for it again does not read the same lines again.
    const profile = session({ extensions: { [EXT]: 'WAVE' }, workers: [{ scope: `chrome-extension://${EXT}/`, renderProcessId: 31 }, { scope: 'https://gone.example/', renderProcessId: 77 }] })
    fake.contents.push(contents(30, 9, 'https://github.com/', profile))
    // 43 is a process whose command line has no id (not a renderer any more): it is not asked about again either.
    const readCommandLines = vi.fn(async (pids: readonly number[]) =>
      pids.map((pid) => (pid === 43 ? `  ${pid} /usr/sbin/other` : `  ${pid} /Lucium Helper (Renderer) --type=renderer --renderer-client-id=${pid === 41 ? 31 : 99} --lang=fr`)).join('\n')
    )
    const asked = input({ pages: new Map([[30, 'GitHub']]), renderers: [30, 41, 42, 43] })
    expect((await rendererHosts(asked, readCommandLines)).get(41)).toEqual([{ kind: 'extension', name: 'WAVE' }])
    expect(readCommandLines).toHaveBeenCalledWith([41, 42, 43])
    expect((await rendererHosts(asked, readCommandLines)).get(41)).toEqual([{ kind: 'extension', name: 'WAVE' }])
    expect(readCommandLines).toHaveBeenCalledTimes(1)
  })

  it('leaves a worker unplaced, and says why, when the command lines cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const profile = session({ workers: [{ scope: 'https://site.example/', renderProcessId: 51 }] })
    fake.contents.push(contents(50, 9, 'https://github.com/', profile))
    const hosts = await rendererHosts(input({ pages: new Map([[50, 'GitHub']]), renderers: [50, 52] }), async () => Promise.reject(new Error('ps is not there')))
    expect([...hosts.values()].flat()).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[task manager]'), 'ps is not there')
  })

  it('keeps what the group named, and says why, when Electron cannot list its web contents: the task manager still lists its processes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fake.throwOnList = true
    const group = new Map<number, RendererHost[]>([[5, [{ kind: 'surface', surface: 'overlay', window: 'fenêtre 2' }]]])
    expect(await rendererHosts(input({ group }))).toEqual(group)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[task manager]'), 'no list')
  })

  it('reads no frame of a web contents whose frames cannot be read, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const broken = contents(60, 1, `chrome-extension://${EXT}/manifest.json`, session({ extensions: { [EXT]: 'MerciApp' } }), {
      mainFrame: {
        get framesInSubtree(): never {
          throw new Error('Render frame was disposed')
        }
      }
    })
    fake.contents.push(broken)
    expect((await rendererHosts(input())).get(60)).toEqual([{ kind: 'extension', name: 'MerciApp' }])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[task manager]'), 'Render frame was disposed')
  })
})
