import { describe, expect, it } from 'vitest'
import { applyOptions, panelContextsOf, panelProfile, panelUrl, resolvePanel } from './sidepanel'

const ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn'

describe('resolvePanel', () => {
  it('uses the manifest path when nothing was set, and is disabled when there is no path at all', () => {
    expect(resolvePanel(undefined, 'tab1', 'panel.html')).toEqual({ enabled: true, path: 'panel.html' })
    expect(resolvePanel(undefined, 'tab1', undefined)).toEqual({ enabled: false, path: undefined })
  })

  it('lets a tab override the extension-wide options, field by field', () => {
    let config = applyOptions(undefined, undefined, { path: 'default.html', enabled: true })
    config = applyOptions(config, 'tab1', { path: 'only-here.html' })
    expect(resolvePanel(config, 'tab1', undefined)).toEqual({ enabled: true, path: 'only-here.html' })
    expect(resolvePanel(config, 'tab2', undefined)).toEqual({ enabled: true, path: 'default.html' })
  })

  it('can disable the panel for one tab only', () => {
    let config = applyOptions(undefined, undefined, { path: 'p.html' })
    config = applyOptions(config, 'tab1', { enabled: false })
    expect(resolvePanel(config, 'tab1', undefined).enabled).toBe(false)
    expect(resolvePanel(config, 'tab2', undefined).enabled).toBe(true)
  })

  it('ignores fields of the wrong type', () => {
    const config = applyOptions(undefined, undefined, { path: 42 as unknown as string, enabled: 'yes' as unknown as boolean })
    expect(config.defaults).toEqual({})
  })
})

describe('panelUrl', () => {
  it('builds an extension URL from a relative path', () => {
    expect(panelUrl(ID, 'sidepanel.html')).toBe(`chrome-extension://${ID}/sidepanel.html`)
    expect(panelUrl(ID, '/ui/index.html?x=1')).toBe(`chrome-extension://${ID}/ui/index.html?x=1`)
  })

  it('takes the address of its own extension\'s page as it is (Merci gives chrome.runtime.getURL(...) with a query)', () => {
    expect(panelUrl(ID, `chrome-extension://${ID}/extension-window.html?page=maia`)).toBe(`chrome-extension://${ID}/extension-window.html?page=maia`)
    expect(panelUrl(ID, `chrome-extension://${ID}//ui/index.html#x`)).toBe(`chrome-extension://${ID}/ui/index.html#x`)
  })

  it('refuses the address of another extension, and its own written in a way that leaves it', () => {
    const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'
    expect(panelUrl(ID, `chrome-extension://${OTHER}/p.html`)).toBeNull()
    expect(panelUrl(ID, `chrome-extension://${ID}/../p.html`)).toBeNull()
    expect(panelUrl(ID, `chrome-extension://${ID}/a/../../p.html`)).toBeNull()
    expect(panelUrl(ID, `chrome-extension://${ID}`)).toBeNull()
    expect(panelUrl(ID, `chrome-extension://${ID}/`)).toBeNull()
    expect(panelUrl(ID, `chrome-extension://${ID}/https://evil.example/`)).toBeNull()
    expect(panelUrl(ID, `CHROME-EXTENSION://${ID}/p.html`)).toBeNull()
  })

  it('refuses absolute URLs, traversal, empty paths and malformed extension ids', () => {
    expect(panelUrl(ID, 'https://evil.example/')).toBeNull()
    expect(panelUrl(ID, 'javascript:alert(1)')).toBeNull()
    expect(panelUrl(ID, '../other/page.html')).toBeNull()
    expect(panelUrl(ID, '')).toBeNull()
    expect(panelUrl('not-an-id', 'p.html')).toBeNull()
  })
})

describe('panelProfile', () => {
  const state = { activeSpaceId: 'home', spaces: [{ id: 'home', profileId: 'default' }, { id: 'office', profileId: 'work' }] }

  it('is the profile of the space of the tab, and of the space on screen when no tab is known', () => {
    expect(panelProfile(state, { spaceId: 'office' }, false)).toBe('work')
    expect(panelProfile(state, { spaceId: 'office', private: false }, false)).toBe('work')
    expect(panelProfile(state, undefined, false)).toBe('default')
    expect(panelProfile(state, { spaceId: 'gone' }, false)).toBe('default')
  })

  it('is none over a private tab and in a private window: no extension is given those', () => {
    expect(panelProfile(state, { spaceId: 'office', private: true }, false)).toBeNull()
    expect(panelProfile(state, { spaceId: 'office' }, true)).toBeNull()
    expect(panelProfile(state, undefined, true)).toBeNull()
  })
})

describe('panelContextsOf', () => {
  const docked = [
    { extensionId: ID, path: 'panel.html', profileId: 'home', windowId: 1 },
    { extensionId: ID, path: 'panel.html', profileId: 'work', windowId: 2 },
    { extensionId: 'p'.repeat(32), path: 'other.html', profileId: 'home', windowId: 3 }
  ]

  it('reports the panel of the extension in the windows of its own profile, and not the one the same extension has open for another profile', () => {
    expect(panelContextsOf(docked, ID, 'home')).toEqual([{ documentUrl: `chrome-extension://${ID}/panel.html`, windowId: 1 }])
    expect(panelContextsOf(docked, ID, 'work')).toEqual([{ documentUrl: `chrome-extension://${ID}/panel.html`, windowId: 2 }])
  })

  it('reports nothing for a profile or an extension that has no panel open, or whose panel has no valid path', () => {
    expect(panelContextsOf(docked, ID, 'elsewhere')).toEqual([])
    expect(panelContextsOf(docked, 'q'.repeat(32), 'home')).toEqual([])
    expect(panelContextsOf([{ extensionId: ID, path: '../x.html', profileId: 'home', windowId: 1 }], ID, 'home')).toEqual([])
  })
})

