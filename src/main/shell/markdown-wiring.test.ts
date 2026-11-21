// The two joints of « Enregistrer la page en Markdown… » that markdown-export.test.ts cannot see: the private flag the shell computes for the page
// (a private tab, or any tab of a private window) before the export asks the user, and the channel of the command bar choosing between the
// save and the picker.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import { createInitialState, reduce } from '@shared/sidebar'
import type { Browser } from './browser'
import type { ScopedIpc } from './ipc-scope'
import type { MarkdownTarget } from './markdown-export'

const exporter = vi.hoisted(() => ({ savePage: vi.fn(), exportPage: vi.fn(), copySelection: vi.fn() }))
vi.mock('./markdown-export', () => exporter)
vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  return new Proxy({} as Record<string, unknown>, { get: (_t, prop: string) => (inert(prop) ? undefined : stub) })
})

const { Browser: BrowserClass } = await import('./browser')
const { registerFeatureIpc } = await import('./feature-ipc')

beforeEach(() => {
  exporter.savePage.mockReset().mockResolvedValue(undefined)
  exporter.exportPage.mockReset().mockResolvedValue(undefined)
})

let n = 0
const ctx = { now: 1, newId: () => `t${++n}` }
function shellOf(tab: { private?: boolean }, windowIsPrivate: boolean) {
  const state = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://example.com/a', ...tab }, ctx)
  const page = {}
  return {
    page,
    self: { store: { get: () => state }, followPaneFocus: () => {}, activePage: () => page, win: { id: 'win' }, isPrivate: () => windowIsPrivate, showToast: () => {} }
  }
}
const proto = BrowserClass.prototype as unknown as Record<string, (this: object, ...args: unknown[]) => unknown>
// The real markdownTarget runs on the stand-in: it is the line under test.
const saveFrom = (self: object) => proto['saveMarkdownPage']!.call({ ...self, markdownTarget: proto['markdownTarget'] })
const targetSaved = () => exporter.savePage.mock.calls.at(-1)![0] as MarkdownTarget

describe('the private flag of the page that is saved as Markdown', () => {
  it('is set for a private tab of a normal window', async () => {
    const { self } = shellOf({ private: true }, false)
    await saveFrom(self)
    expect(targetSaved()).toMatchObject({ url: 'https://example.com/a', private: true })
  })

  it('is set for any tab of a private window', async () => {
    const { self } = shellOf({}, true)
    await saveFrom(self)
    expect(targetSaved().private).toBe(true)
  })

  it('is not set for a normal tab of a normal window', async () => {
    const { self } = shellOf({}, false)
    await saveFrom(self)
    expect(targetSaved().private).toBe(false)
  })
})

describe('the command bar channel of the Markdown export', () => {
  function channel() {
    let listener!: (event: { sender: unknown }, mode: unknown) => void
    const ipc = { on: (name: string, fn: typeof listener) => void (name === Channel.markdownExport && (listener = fn)), handle: () => {} } as unknown as ScopedIpc
    const browser = { closeOverlay: vi.fn(), saveMarkdownPage: vi.fn().mockResolvedValue(undefined), exportMarkdown: vi.fn().mockResolvedValue(undefined), isPrivate: () => false, useTranslator: () => undefined }
    registerFeatureIpc(ipc, () => true, browser as unknown as Browser, {} as never, {} as never)
    return { browser, send: (mode: unknown) => listener({ sender: {} }, mode) }
  }

  it('saves the whole page for the word « save »', () => {
    const { browser, send } = channel()
    send('save')
    expect(browser.saveMarkdownPage).toHaveBeenCalledTimes(1)
    expect(browser.exportMarkdown).not.toHaveBeenCalled()
  })

  it('opens the picker for « pick », for no word and for any other word', () => {
    const { browser, send } = channel()
    for (const mode of ['pick', undefined, 'SAVE', 42]) send(mode)
    expect(browser.exportMarkdown).toHaveBeenCalledTimes(4)
    expect(browser.saveMarkdownPage).not.toHaveBeenCalled()
  })
})
