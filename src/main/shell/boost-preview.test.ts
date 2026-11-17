// The script being typed in the Tweak editor (browser-site.ts): a page runs the saved script only, and the one being typed runs once, in the
// page shown, when the person asks for the preview. Run on a stand-in for the window, then through the real handler of the channel.

import { describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import { t } from '@shared/i18n'
import { defaultSettings, type Boost, type SidebarState } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { cleanBoost } from '@shared/sidebar-state'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

// The shell reaches Electron only when a method runs.
vi.mock('electron', () => new Proxy({ app: { getPath: () => '/nonexistent', getAppPath: () => '/nonexistent' }, BrowserWindow: { fromWebContents: () => null } } as Record<string, unknown>, { get: (target, name: string) => (name in target ? target[name] : {}) }))
vi.mock('../userscripts', () => ({ userScripts: () => ({ matching: () => [], recordFailure: () => undefined }), readScriptFile: () => null }))
const { Browser } = await import('./browser')
const { registerFeatureIpc } = await import('./feature-ipc')
const shell = methodsOf(Browser.prototype)

const tweak = (over: Partial<Boost> = {}): Boost => ({ ...cleanBoost({ id: 'b1', host: 'site.example', js: 'window.__saved = 1', jsDraft: 'window.__typed = 1' }, () => 'b1'), ...over })

function windowWith(boost: Boost, over: { url?: string; privateTab?: boolean; privateWindow?: boolean; boostsEnabled?: boolean; noPage?: boolean } = {}) {
  const base = createInitialState({ now: 0, newId: () => 'x' })
  const state: SidebarState = {
    ...base,
    tabs: [{ id: 't1', spaceId: base.activeSpaceId, url: over.url ?? 'https://www.site.example/page', title: 'T', ...(over.privateTab ? { private: true } : {}) }] as SidebarState['tabs'],
    activeTabBySpace: { [base.activeSpaceId]: 't1' },
    boosts: [boost],
    settings: { ...defaultSettings(), boostsEnabled: over.boostsEnabled ?? true }
  }
  const page = { applyCss: vi.fn(), setZoom: vi.fn(), runScript: vi.fn(), evaluate: vi.fn(async () => undefined), reload: vi.fn() }
  const fake: ReturnType<typeof fakeBrowser> = fakeBrowser({
    store: { get: () => state },
    pages: new Map(over.noPage ? [] : [['t1', page]]),
    volatileZoom: new Map(),
    isPrivate: () => over.privateWindow === true,
    boostsFor: (tab: unknown) => shell.boostsFor!.call(fake.self, tab)
  })
  return {
    page,
    load: () => shell.applyBoost!.call(fake.self, 't1', true),
    preview: (id = 'b1') => shell.previewBoostScript!.call(fake.self, id) as { ok: boolean; message: string }
  }
}

describe('a Tweak whose script is being typed', () => {
  it('gives a page that loads the saved script, never the one being typed', () => {
    const { page, load } = windowWith(tweak())
    load()
    expect(page.runScript.mock.calls).toEqual([['window.__saved = 1']])
  })

  it('gives a page that loads nothing at all while no script was ever saved', () => {
    const { page, load } = windowWith(tweak({ js: '' }))
    load()
    expect(page.runScript).not.toHaveBeenCalled()
  })

  it('runs the script being typed once in the page shown when the preview is asked for, and says so', () => {
    const { page, preview } = windowWith(tweak())
    expect(preview()).toEqual({ ok: true, message: t('boost-editor.apercu-lance-dans-la-page-affichee') })
    expect(page.runScript.mock.calls).toEqual([['window.__typed = 1']])
    // Nothing was stored by it: a page that loads afterwards still gets the saved script.
    expect(page.reload).not.toHaveBeenCalled()
  })

  it.each([
    ['in a private tab', { privateTab: true }],
    ['in a private window', { privateWindow: true }],
    ['on a page of another site', { url: 'https://other.example/' }],
    ['with the Tweaks switched off', { boostsEnabled: false }],
    ['when the tab has no page', { noPage: true }]
  ])('runs nothing %s, and says why in the log and in its answer', (_name, over) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { page, preview } = windowWith(tweak(), over)
    expect(preview()).toEqual({ ok: false, message: t('boost-editor.l-apercu-ne-peut-pas-etre-lance-ici') })
    expect(page.runScript).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Tweak b1 was not run: no-page'))
    warn.mockRestore()
  })

  it('runs neither a script that does not show what it runs, nor one that still waits to be switched on, nor one of an unknown Tweak', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const hidden = windowWith(tweak({ jsDraft: 'a()\n// x\u2028b()' }))
    expect(hidden.preview().message).toBe(t('userscript.la-ligne-line-contient-une-fin-de-ligne-invisible', { line: 2 }))
    expect(hidden.page.runScript).not.toHaveBeenCalled()
    const waiting = windowWith(tweak({ jsEnabled: false }))
    expect(waiting.preview()).toEqual({ ok: false, message: t('boost-editor.ce-script-n-est-pas-execute') })
    expect(waiting.page.runScript).not.toHaveBeenCalled()
    const unknown = windowWith(tweak())
    expect(unknown.preview('other')).toEqual({ ok: false, message: t('boost-editor.il-n-y-a-aucun-script-a-lancer') })
    expect(unknown.page.runScript).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('the channel of the preview', () => {
  function handler(guard = true) {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const ipc = { on: (channel: string, run: never) => void handlers.set(channel, run), handle: (channel: string, run: never) => void handlers.set(channel, run) }
    const previewBoostScript = vi.fn((id: string) => ({ ok: true, message: id }))
    const browser = new Proxy({ isPrivate: () => false, previewBoostScript }, { get: (target, name) => (name in target ? (target as Record<string | symbol, unknown>)[name] : () => undefined) })
    registerFeatureIpc(ipc as never, () => guard, browser as never, { get: () => ({ settings: defaultSettings(), spaces: [] }) } as never, {} as never)
    return { ask: (id: unknown) => handlers.get(Channel.boostPreview)!({ sender: {} }, id), previewBoostScript }
  }

  it('hands the id of a Tweak to the shell, and nothing else: the code is never taken from the interface', () => {
    const { ask, previewBoostScript } = handler()
    expect(ask('b1')).toEqual({ ok: true, message: 'b1' })
    for (const bad of [undefined, null, 5, '', 'a b', 'x'.repeat(65), { id: 'b1' }, ['b1'], 'window.x = 1']) expect(ask(bad), JSON.stringify(bad)).toEqual({ ok: false, message: t('feature.demande-invalide') })
    expect(previewBoostScript.mock.calls).toEqual([['b1']])
  })

  it('refuses a surface that is not the interface', () => {
    const { ask, previewBoostScript } = handler(false)
    expect(ask('b1')).toEqual({ ok: false, message: t('feature.demande-refusee') })
    expect(previewBoostScript).not.toHaveBeenCalled()
  })
})
