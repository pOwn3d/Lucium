// « Exporter les données… » and « Exporter les signets (HTML)… » with windows of their own: the real handlers of `registerIpc` of the second window,
// over the real views of one shared state (main/store.ts). The data file is what « Restaurer les données… » reads back: it holds the tabs of every
// window, not only the ones the window that asked lists; the bookmarks file, with the Today tabs asked for, holds those of every window as well.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import { createInitialState, reduce, type Ctx } from '@shared/sidebar'
import { selectionOf } from '@shared/window-selection'
import { fakeBrowser } from './browser-fake.test-support'
import { invokeFrom } from './ipc-fake.test-support'

const folder = mkdtempSync(join(tmpdir(), 'export-windows-'))
afterAll(() => rmSync(folder, { recursive: true, force: true }))
const saveTo = vi.hoisted(() => ({ path: '' }))

vi.mock('electron', async () => {
  const { fakeElectron } = await import('./ipc-fake.test-support')
  const base = fakeElectron()
  return new Proxy(
    { ipcMain: base['ipcMain'], dialog: { showSaveDialog: async () => ({ canceled: false, filePath: saveTo.path }) }, BrowserWindow: { fromWebContents: () => null } } as Record<string, unknown>,
    { has: (_target, prop) => typeof prop === 'string' && prop !== 'then' && prop !== '__esModule', get: (target, prop: string) => (prop in target ? target[prop] : base[prop]) }
  )
})

const { registerIpc } = await import('./ipc')
const { StateStore, WindowView } = await import('../store')

/** The interface of the second window: the one that asks. */
const UI = 7

let n = 0
const ctx: Ctx = { now: 1_000, newId: () => `t${++n}` }
let initial = createInitialState(ctx)
initial = { ...initial, settings: { ...initial.settings, independentWindows: true } }
initial = reduce(initial, { type: 'tab/open', url: 'https://first.example/' }, ctx)
const shared = new StateStore(initial, null)
const views = new Set<InstanceType<typeof WindowView>>()
new WindowView(shared, selectionOf(shared.get()), views, true)
const second = new WindowView(shared, selectionOf(shared.get()), views, false, 'window-1')
second.dispatch({ type: 'tab/open', url: 'https://second.example/' })
const browser = fakeBrowser({ isPrivate: () => false })
registerIpc(browser.self as never, second as never, {} as never, new Set([UI]))

describe('an export asked from a window with tabs of its own', () => {
  it('lists the tabs of the other windows too: the file restores the whole session', async () => {
    expect(second.get().tabs.map((tab) => tab.url)).toEqual(['https://second.example/'])
    saveTo.path = join(folder, 'data.json')
    const reply = await invokeFrom(UI, Channel.exportData)
    expect(reply).toMatchObject({ ok: true })
    const saved = JSON.parse(readFileSync(saveTo.path, 'utf8')) as { tabs: Array<{ url: string }> }
    expect(saved.tabs.map((tab) => tab.url).sort()).toEqual(['https://first.example/', 'https://second.example/'])
  })

  it('writes the Today tabs of every window in the bookmarks file, as the data file does', async () => {
    saveTo.path = join(folder, 'bookmarks.html')
    const reply = await invokeFrom(UI, Channel.exportBookmarks, { includeToday: true })
    expect(reply).toMatchObject({ path: saveTo.path })
    const html = readFileSync(saveTo.path, 'utf8')
    expect(html).toContain('https://first.example/')
    expect(html).toContain('https://second.example/')
  })
})
