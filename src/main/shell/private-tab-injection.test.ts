// Decided by the maintainer: the Tweaks and the user scripts are not given to a private tab of a normal window, as a private window has none
// (its state keeps no Tweak, and it runs only the user scripts the user allowed there). browser-site.ts, run on a stand-in for the window.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { cleanBoost } from '@shared/sidebar-state'
import { userScriptMatches, type UserScript } from '@shared/userscript'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

const manager = vi.hoisted(() => ({ matching: vi.fn(), recordFailure: vi.fn() }))
vi.mock('../userscripts', () => ({ userScripts: () => manager }))
// The shell reaches Electron only when a method runs.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const URL_OF_SITE = 'https://site.example/page'
const boost = { ...cleanBoost({ host: 'site.example', css: 'body { color: red }', js: 'window.__tweak = 1', jsEnabled: true } as never, () => 'b1'), enabled: true }
const script = (over: Partial<UserScript> = {}): UserScript => ({ id: 'u1', name: 'Un script', source: 'window.__script = 1', enabled: true, allowPrivate: false, matches: ['https://site.example/*'], excludes: [], runAt: 'document-end', ...over }) as UserScript

function windowWith(tab: { private?: boolean }, privateWindow = false, scripts: UserScript[] = [script()]) {
  const base = createInitialState({ now: 0, newId: () => 'x' })
  const state = { ...base, tabs: [{ id: 't1', url: URL_OF_SITE, title: 'T', ...tab }], boosts: [boost], settings: { ...defaultSettings(), boostsEnabled: true, userScripts: true } }
  const page = { applyCss: vi.fn(), setZoom: vi.fn(), runScript: vi.fn(), evaluate: vi.fn(async () => undefined), reload: vi.fn() }
  manager.matching.mockImplementation((url: string, inPrivate: boolean) => scripts.filter((s) => userScriptMatches(s, url, inPrivate)))
  // The methods of the layer that call each other run on the same stand-in.
  const fake: ReturnType<typeof fakeBrowser> = fakeBrowser({
    store: { get: () => state },
    pages: new Map([['t1', page]]),
    volatileZoom: new Map(),
    isPrivate: () => privateWindow,
    boostsFor: (tab: unknown) => shell.boostsFor!.call(fake.self, tab),
    applyBoost: (id: unknown, run: unknown) => shell.applyBoost!.call(fake.self, id, run)
  })
  return { fake, page }
}

beforeEach(() => {
  manager.matching.mockReset()
  manager.recordFailure.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('the Tweaks of a site', () => {
  it('are given to a normal tab: the stylesheet and the script', () => {
    const { fake, page } = windowWith({})
    shell.applyBoost!.call(fake.self, 't1', true)
    expect(page.applyCss).toHaveBeenCalledWith(expect.stringContaining('color: red'))
    expect(page.runScript).toHaveBeenCalledWith(expect.stringContaining('__tweak'))
  })

  it('are not given to a private tab of a normal window: no stylesheet, no script', () => {
    const { fake, page } = windowWith({ private: true })
    shell.applyBoost!.call(fake.self, 't1', true)
    expect(page.applyCss).toHaveBeenCalledWith('')
    expect(page.runScript).not.toHaveBeenCalled()
  })

  it('are taken off a tab that became private, and the page is not reloaded for a script it does not run', () => {
    const normal = windowWith({})
    shell.refreshBoostsHere!.call(normal.fake.self, [])
    expect(normal.page.reload).toHaveBeenCalledOnce()

    const privateTab = windowWith({ private: true })
    shell.refreshBoostsHere!.call(privateTab.fake.self, ['site.example'])
    expect(privateTab.page.applyCss).toHaveBeenCalledWith('')
    expect(privateTab.page.reload).not.toHaveBeenCalled()
  })
})

describe('the user scripts of a site', () => {
  it('run in a normal tab', () => {
    const { fake, page } = windowWith({})
    shell.applyUserScripts!.call(fake.self, 't1')
    expect(manager.matching).toHaveBeenCalledWith(URL_OF_SITE, false)
    expect(page.evaluate).toHaveBeenCalledOnce()
  })

  it('do not run in a private tab of a normal window, unless the user allowed the script in private windows', () => {
    const refused = windowWith({ private: true })
    shell.applyUserScripts!.call(refused.fake.self, 't1')
    expect(manager.matching).toHaveBeenCalledWith(URL_OF_SITE, true)
    expect(refused.page.evaluate).not.toHaveBeenCalled()

    const allowed = windowWith({ private: true }, false, [script({ allowPrivate: true })])
    shell.applyUserScripts!.call(allowed.fake.self, 't1')
    expect(allowed.page.evaluate).toHaveBeenCalledOnce()
  })

  it('keep the rule of a private window for its own tabs', () => {
    const { fake, page } = windowWith({}, true)
    shell.applyUserScripts!.call(fake.self, 't1')
    expect(manager.matching).toHaveBeenCalledWith(URL_OF_SITE, true)
    expect(page.evaluate).not.toHaveBeenCalled()
  })
})
