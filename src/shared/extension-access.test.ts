import { describe, expect, it } from 'vitest'
import {
  accessOf,
  ActiveTabGrants,
  alreadyGranted,
  notGranted,
  canCaptureTab,
  canReadTab,
  extensionNavigableUrl,
  globMatch,
  hasHostAccess,
  isMatchPattern,
  libraryCallError,
  libraryEventArgs,
  libraryResult,
  matchPattern,
  tabMatchesQuery,
  visibleCookies,
  visibleNavigation,
  visibleTab,
  visibleWindow,
  windowFilterOf,
  type AccessContext
} from './extension-access'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'.slice(0, 32)

/** Whether the text is a match pattern of the extension platform (what `matchPattern` takes). */
const isPatternOf = (pattern: string): boolean => isMatchPattern(pattern)

function context(permissions: string[] = [], hosts: string[] = [], grants = new ActiveTabGrants()): AccessContext {
  return { extensionId: ID, access: accessOf({ permissions, host_permissions: hosts }), grants }
}
const env = { tabUrl: (n: number) => (n === 1 ? 'https://bank.example/account' : undefined) }

describe('accessOf', () => {
  it('reads the permissions and the host permissions, and the hosts a Manifest V2 extension lists among its permissions', () => {
    const access = accessOf({ manifest_version: 2, permissions: ['tabs', 'https://a.example/*', '<all_urls>', 7, null], host_permissions: ['https://b.example/*'] })
    expect([...access.permissions]).toEqual(['tabs'])
    expect(access.hosts).toEqual(['https://b.example/*', 'https://a.example/*', '<all_urls>'])
  })

  it('grants nothing for a host pattern written among the permissions of a Manifest V3 extension, which is what the extension platform does with it', () => {
    for (const manifest_version of [3, undefined, '2']) {
      const manifest = { manifest_version, permissions: ['tabs', 'https://a.example/*', '<all_urls>'], host_permissions: ['https://b.example/*'] }
      const access = accessOf(manifest)
      expect([...access.permissions], String(manifest_version)).toEqual(['tabs'])
      expect(access.hosts, String(manifest_version)).toEqual(['https://b.example/*'])
    }
    // Nothing follows from it: no look at a page, no capture of a tab.
    const ctx = { extensionId: ID, access: accessOf({ manifest_version: 3, permissions: ['<all_urls>'] }), grants: new ActiveTabGrants() }
    expect(hasHostAccess(ctx.access, 'https://bank.example/account')).toBe(false)
    expect(canCaptureTab(ctx, { id: 1, url: 'https://bank.example/account' })).toBe(false)
    const legacy = { extensionId: ID, access: accessOf({ manifest_version: 2, permissions: ['<all_urls>'] }), grants: new ActiveTabGrants() }
    expect(hasHostAccess(legacy.access, 'https://bank.example/account')).toBe(true)
    expect(canCaptureTab(legacy, { id: 1, url: 'https://bank.example/account' })).toBe(true)
  })

  it('takes a manifest that is not what it should be for one that declares nothing', () => {
    for (const manifest of [undefined, null, 'tabs', { permissions: 'tabs' }, { permissions: { has: 1 } }]) {
      const access = accessOf(manifest)
      expect(access.permissions.size).toBe(0)
      expect(access.hosts).toEqual([])
    }
  })
})

describe('globMatch', () => {
  it('matches a run of characters with * and everything else literally', () => {
    expect(globMatch('*', '')).toBe(true)
    expect(globMatch('a*c', 'abbbc')).toBe(true)
    expect(globMatch('a*c', 'abbbd')).toBe(false)
    expect(globMatch('*.example.com/*', 'www.example.com/x?y=1')).toBe(true)
    expect(globMatch('a.c', 'abc')).toBe(false)
    expect(globMatch('(a)+', '(a)+')).toBe(true)
    expect(globMatch('a**b', 'axxb')).toBe(true)
    expect(globMatch('', '')).toBe(true)
    expect(globMatch('', 'a')).toBe(false)
  })

  it('answers a pattern of stars against a title that almost matches at once, where a regular expression takes seconds', () => {
    const pattern = '*a'.repeat(14) + '*b'
    const title = 'a'.repeat(32)
    const start = performance.now()
    expect(globMatch(pattern, title)).toBe(false)
    expect(performance.now() - start).toBeLessThan(50)
  })

  it('gives up on a match that needs more steps than it is allowed, instead of working on it', () => {
    const limits = { maxPattern: 512, maxText: 8192, maxSteps: 50 }
    expect(globMatch('*a*a*a', 'a'.repeat(1000), limits)).toBe(false)
    expect(globMatch('*a*a*a', 'a'.repeat(1000))).toBe(true)
  })

  it('gives up on what is out of proportion instead of working on it', () => {
    expect(globMatch('a'.repeat(1000), 'a'.repeat(1000))).toBe(false)
    expect(globMatch('*', 'a'.repeat(100_000))).toBe(false)
    const start = performance.now()
    expect(globMatch('*a'.repeat(200) + '*b', 'a'.repeat(8000))).toBe(false)
    expect(performance.now() - start).toBeLessThan(200)
  })
})

describe('matchPattern', () => {
  it('reads the match patterns of a manifest', () => {
    expect(matchPattern('<all_urls>', 'https://a.example/x')).toBe(true)
    expect(matchPattern('<all_urls>', 'file:///etc/passwd')).toBe(false)
    expect(matchPattern('<all_urls>', 'chrome-extension://abc/x')).toBe(false)
    expect(matchPattern('*://*/*', 'http://a.example/')).toBe(true)
    expect(matchPattern('https://*.example.com/*', 'https://www.example.com/a')).toBe(true)
    expect(matchPattern('https://*.example.com/*', 'https://example.com/')).toBe(true)
    expect(matchPattern('https://*.example.com/*', 'https://evilexample.com/')).toBe(false)
    expect(matchPattern('https://*.example.com/*', 'http://www.example.com/')).toBe(false)
    expect(matchPattern('https://example.com/path/*', 'https://example.com/other')).toBe(false)
    expect(matchPattern('http://localhost/*', 'http://localhost:3000/x')).toBe(true)
    expect(matchPattern('http://localhost:3000/*', 'http://localhost:4000/x')).toBe(false)
    expect(matchPattern('https://example.com/*', 'https://EXAMPLE.com/x')).toBe(true)
  })

  it('does not take what is not a pattern for one', () => {
    for (const pattern of ['https://example.com', 'example.com', 'https:///*', 'https://exa*mple.com/*', '', 'javascript:*']) expect(matchPattern(pattern, 'https://example.com/')).toBe(false)
  })

  it('finds out whether any host permission of the extension covers an address', () => {
    const access = accessOf({ host_permissions: ['https://a.example/*'] })
    expect(hasHostAccess(access, 'https://a.example/x')).toBe(true)
    expect(hasHostAccess(access, 'https://b.example/x')).toBe(false)
    expect(hasHostAccess(accessOf({}), 'https://a.example/x')).toBe(false)
  })
})

describe('ActiveTabGrants', () => {
  it('holds a tab until it goes to another origin, and forgets it when it closes', () => {
    const grants = new ActiveTabGrants()
    grants.grant(ID, 5, 'https://a.example/one')
    expect(grants.has(ID, 5, 'https://a.example/two')).toBe(true)
    expect(grants.has(ID, 5, 'https://b.example/')).toBe(false)
    expect(grants.has(OTHER, 5, 'https://a.example/one')).toBe(false)
    expect(grants.has(ID, 6, 'https://a.example/one')).toBe(false)
    grants.forgetTab(5)
    expect(grants.has(ID, 5, 'https://a.example/one')).toBe(false)
  })

  it('takes a tab back from one extension only: the others keep it, and so does the same extension on another tab', () => {
    const grants = new ActiveTabGrants()
    grants.grant(ID, 5, 'https://a.example/')
    grants.grant(OTHER, 5, 'https://a.example/')
    grants.grant(ID, 6, 'https://a.example/')
    grants.revoke(ID, 5)
    expect(grants.has(ID, 5, 'https://a.example/')).toBe(false)
    expect(grants.has(OTHER, 5, 'https://a.example/')).toBe(true)
    expect(grants.has(ID, 6, 'https://a.example/')).toBe(true)
    // Nothing to take back is nothing.
    expect(() => grants.revoke(ID, 99)).not.toThrow()
  })

  it('tells two blank pages apart by their whole address', () => {
    const grants = new ActiveTabGrants()
    grants.grant(ID, 5, 'about:blank')
    expect(grants.has(ID, 5, 'about:blank')).toBe(true)
    expect(grants.has(ID, 5, 'data:text/html,hi')).toBe(false)
  })
})

describe('what an extension sees of a tab', () => {
  const tab = { id: 1, url: 'https://bank.example/account', pendingUrl: 'https://bank.example/next', title: 'My account', favIconUrl: 'https://bank.example/i.png', active: true, windowId: 3 }

  it('hides the address, the title and the icon from an extension that has neither "tabs" nor a host permission for the page', () => {
    expect(visibleTab(context(['storage']), tab)).toEqual({ id: 1, active: true, windowId: 3 })
  })

  it('shows them with "tabs", with a host permission for the page, with activeTab on that tab, and for its own pages', () => {
    expect(visibleTab(context(['tabs']), tab)).toBe(tab)
    expect(visibleTab(context([], ['https://*.bank.example/*']), tab)).toBe(tab)
    const grants = new ActiveTabGrants()
    grants.grant(ID, 1, tab.url)
    expect(visibleTab(context(['activeTab'], [], grants), tab)).toBe(tab)
    const own = { id: 2, url: `chrome-extension://${ID}/panel.html`, title: 'panel' }
    expect(visibleTab(context(), own)).toBe(own)
  })

  it('does not show a page that is not the one of another site, nor one the tab has left', () => {
    expect(visibleTab(context([], ['https://other.example/*']), tab)).not.toHaveProperty('url')
    const grants = new ActiveTabGrants()
    grants.grant(ID, 1, 'https://elsewhere.example/')
    expect(visibleTab(context(['activeTab'], [], grants), tab)).not.toHaveProperty('url')
  })

  it('never changes the tab it was given: the library keeps the same object for the next caller', () => {
    const original = { ...tab }
    visibleTab(context(), tab)
    expect(tab).toEqual(original)
  })

  it('hides them in the tabs of a window too', () => {
    const window = { id: 3, tabs: [tab], focused: true }
    expect(visibleWindow(context(), window).tabs[0]).not.toHaveProperty('url')
    expect(window.tabs[0]).toHaveProperty('url')
  })
})

describe('tabMatchesQuery', () => {
  const tab = { id: 1, url: 'https://bank.example/account', title: 'My account' }

  it('matches the title and the address of a tab the extension may read', () => {
    const ctx = context(['tabs'])
    expect(tabMatchesQuery(ctx, tab, { title: 'My *' })).toBe(true)
    expect(tabMatchesQuery(ctx, tab, { title: 'Other*' })).toBe(false)
    expect(tabMatchesQuery(ctx, tab, { url: 'https://bank.example/*' })).toBe(true)
    expect(tabMatchesQuery(ctx, tab, { url: ['https://x.example/*', '*://*/account'] })).toBe(true)
    expect(tabMatchesQuery(ctx, tab, { url: 'https://x.example/*' })).toBe(false)
    expect(tabMatchesQuery(ctx, tab, {})).toBe(true)
  })

  it('matches nothing by the title or the address of a tab it may not read: the filter would give the page away', () => {
    expect(tabMatchesQuery(context(['storage']), tab, { title: 'My *' })).toBe(false)
    expect(tabMatchesQuery(context(['storage']), tab, { url: 'https://bank.example/*' })).toBe(false)
    expect(tabMatchesQuery(context(['storage']), tab, {})).toBe(true)
  })

  it('does not run for long on a pattern of stars', () => {
    const start = performance.now()
    expect(tabMatchesQuery(context(['tabs']), { id: 1, url: 'https://a.example/', title: 'a'.repeat(32) }, { title: '*a'.repeat(14) + '*b' })).toBe(false)
    expect(performance.now() - start).toBeLessThan(50)
  })
})

describe('libraryCallError', () => {
  it('refuses the cookies to an extension that did not declare them, whatever the host permissions', () => {
    for (const name of ['cookies.get', 'cookies.getAll', 'cookies.set', 'cookies.remove', 'cookies.getAllCookieStores']) {
      expect(libraryCallError(context(['storage'], ['<all_urls>']), name, [{ url: 'https://a.example/' }], env)).toBe(`The extension has no permission to use chrome.${name}.`)
    }
  })

  it('also wants a host permission for the address of a cookie', () => {
    expect(libraryCallError(context(['cookies']), 'cookies.get', [{ url: 'https://a.example/', name: 'sid' }], env)).toMatch(/Extension manifest must request permission to access this host/)
    expect(libraryCallError(context(['cookies'], ['https://a.example/*']), 'cookies.get', [{ url: 'https://a.example/', name: 'sid' }], env)).toBeNull()
    expect(libraryCallError(context(['cookies'], ['https://a.example/*']), 'cookies.set', [{ url: 'https://b.example/', name: 'sid', value: 'x' }], env)).not.toBeNull()
    expect(libraryCallError(context(['cookies'], ['https://a.example/*']), 'cookies.remove', [{ name: 'sid' }], env)).not.toBeNull()
    expect(libraryCallError(context(['cookies']), 'cookies.getAll', [{}], env)).toBeNull()
    expect(libraryCallError(context(['cookies']), 'cookies.getAll', [{ url: 'https://a.example/' }], env)).not.toBeNull()
  })

  it('refuses web navigation, menus and notifications to an extension that did not declare them', () => {
    for (const [name, permission] of [['webNavigation.getAllFrames', 'webNavigation'], ['contextMenus.create', 'contextMenus'], ['notifications.create', 'notifications']] as const) {
      expect(libraryCallError(context(['storage']), name, [{}], env)).not.toBeNull()
      expect(libraryCallError(context([permission]), name, [{}], env)).toBeNull()
    }
  })

  it('wants a host permission, or the tab handed over, to put a style in a page', () => {
    expect(libraryCallError(context(['tabs']), 'tabs.insertCSS', [1, { code: 'body{}' }], env)).toMatch(/must request permission/)
    expect(libraryCallError(context([], ['https://bank.example/*']), 'tabs.insertCSS', [1, { code: 'body{}' }], env)).toBeNull()
    const grants = new ActiveTabGrants()
    grants.grant(ID, 1, 'https://bank.example/account')
    expect(libraryCallError(context(['activeTab'], [], grants), 'tabs.insertCSS', [1, { code: 'body{}' }], env)).toBeNull()
  })

  it('lets through the tabs and windows calls that need no permission on the extension platform', () => {
    for (const name of ['tabs.get', 'tabs.query', 'tabs.create', 'tabs.update', 'windows.getAll', 'windows.create']) expect(libraryCallError(context(), name, [{}], env)).toBeNull()
  })
})

describe('what the library answers', () => {
  const tab = { id: 1, url: 'https://bank.example/account', title: 'My account' }

  it('takes the address and title out of the tabs and windows an extension without access receives', () => {
    const ctx = context()
    expect(libraryResult(ctx, 'tabs.get', tab)).toEqual({ id: 1 })
    expect(libraryResult(ctx, 'tabs.query', [tab, tab])).toEqual([{ id: 1 }, { id: 1 }])
    expect(libraryResult(ctx, 'tabs.create', tab)).toEqual({ id: 1 })
    expect(libraryResult(ctx, 'tabs.update', tab)).toEqual({ id: 1 })
    expect(libraryResult(ctx, 'windows.getAll', [{ id: 3, tabs: [tab] }])).toEqual([{ id: 3, tabs: [{ id: 1 }] }])
    expect(libraryResult(ctx, 'windows.get', { id: 3, tabs: [tab] })).toEqual({ id: 3, tabs: [{ id: 1 }] })
    expect(libraryResult(ctx, 'tabs.get', undefined)).toBeUndefined()
  })

  it('leaves them to an extension that may read them', () => {
    expect(libraryResult(context(['tabs']), 'tabs.query', [tab])).toEqual([tab])
  })

  it('gives the cookies of the sites the extension has a host permission for, and no other', () => {
    const cookies = [
      { name: 'a', domain: 'a.example', path: '/', secure: true },
      { name: 'b', domain: '.b.example', path: '/', secure: false }
    ]
    expect(visibleCookies(context(['cookies'], ['https://a.example/*']), cookies)).toEqual([cookies[0]])
    expect(visibleCookies(context(['cookies'], ['*://*.b.example/*']), cookies)).toEqual([cookies[1]])
    expect(visibleCookies(context(['cookies']), cookies)).toEqual([])
    expect(libraryResult(context(['cookies'], ['https://a.example/*']), 'cookies.getAll', cookies)).toEqual([cookies[0]])
    // A single cookie that is not of a site the extension has a host permission for is not handed over either.
    expect(libraryResult(context(['cookies'], ['https://a.example/*']), 'cookies.get', cookies[1])).toBeNull()
    expect(libraryResult(context(['cookies'], ['https://a.example/*']), 'cookies.set', cookies[1])).toBeNull()
    expect(libraryResult(context(['cookies'], ['https://a.example/*']), 'cookies.get', cookies[0])).toEqual(cookies[0])
  })
})

describe('libraryEventArgs', () => {
  const tab = { id: 1, url: 'https://bank.example/account', title: 'My account' }

  it('does not deliver the events of an API the extension did not declare', () => {
    for (const name of ['cookies.onChanged', 'webNavigation.onCommitted', 'notifications.onClicked', 'contextMenus.onClicked']) expect(libraryEventArgs(context(['storage']), name, [{}])).toBeNull()
    expect(libraryEventArgs(context(['webNavigation']), 'webNavigation.onCommitted', [{ url: 'https://a.example/' }])).toEqual([{ url: 'https://a.example/' }])
  })

  it('delivers a change of cookie only for a site the extension has a host permission for', () => {
    const change = { removed: false, cookie: { name: 'sid', domain: 'bank.example', path: '/', secure: true } }
    expect(libraryEventArgs(context(['cookies']), 'cookies.onChanged', [change])).toBeNull()
    expect(libraryEventArgs(context(['cookies'], ['https://bank.example/*']), 'cookies.onChanged', [change])).toEqual([change])
  })

  it('takes the address out of tab events for an extension that may not read it', () => {
    const ctx = context()
    expect(libraryEventArgs(ctx, 'tabs.onCreated', [tab])).toEqual([{ id: 1 }])
    expect(libraryEventArgs(ctx, 'browserAction.onClicked', [tab])).toEqual([{ id: 1 }])
    expect(libraryEventArgs(ctx, 'tabs.onUpdated', [1, { status: 'loading', url: tab.url }, tab])).toEqual([1, { status: 'loading' }, { id: 1 }])
    expect(libraryEventArgs(ctx, 'tabs.onUpdated', [1, { url: tab.url, title: tab.title }, tab])).toBeNull()
    expect(libraryEventArgs(ctx, 'windows.onCreated', [{ id: 3, tabs: [tab] }])).toEqual([{ id: 3, tabs: [{ id: 1 }] }])
    expect(libraryEventArgs(ctx, 'tabs.onRemoved', [1, { windowId: 3 }])).toEqual([1, { windowId: 3 }])
    // A keyboard shortcut of the extension hands it the tab on screen, and a moved window its tabs: the same rule holds.
    expect(libraryEventArgs(ctx, 'commands.onCommand', ['run', tab])).toEqual(['run', { id: 1 }])
    expect(libraryEventArgs(ctx, 'windows.onBoundsChanged', [{ id: 3, tabs: [tab] }])).toEqual([{ id: 3, tabs: [{ id: 1 }] }])
  })

  it('leaves tab events whole for an extension that may read the tabs', () => {
    const args = [1, { url: tab.url }, tab]
    expect(libraryEventArgs(context(['tabs']), 'tabs.onUpdated', args)).toBe(args)
  })
})

describe('extensionNavigableUrl', () => {
  it('lets an extension open a web page, the blank page and its own pages', () => {
    expect(extensionNavigableUrl('https://example.com/a', ID)).toBe('https://example.com/a')
    expect(extensionNavigableUrl('http://127.0.0.1:8080/', ID)).toBe('http://127.0.0.1:8080/')
    expect(extensionNavigableUrl('about:blank', ID)).toBe('about:blank')
    expect(extensionNavigableUrl('chrome://newtab', ID)).toBe('about:blank')
    expect(extensionNavigableUrl(`chrome-extension://${ID}/panel.html?x=1`, ID)).toBe(`chrome-extension://${ID}/panel.html?x=1`)
    expect(extensionNavigableUrl('options.html', ID)).toBe(`chrome-extension://${ID}/options.html`)
  })

  it('never lets an extension open the Extensions page by its own address: chrome://extensions is the one way, and the browser opens it', () => {
    for (const url of ['lucium-ui://extensions/', 'lucium-ui://extensions/shortcuts', `lucium-ui://extensions/?id=${ID}`, 'LUCIUM-UI://EXTENSIONS/']) expect(extensionNavigableUrl(url, ID), url).toBeNull()
  })

  it('refuses a local file, a document made of data, a source view, a page of another extension and the pages of the browser', () => {
    for (const url of [
      'file:///etc/passwd',
      'data:text/html,<script>1</script>',
      'blob:https://a.example/uuid',
      'view-source:https://example.com/',
      `chrome-extension://${OTHER}/panel.html`,
      'chrome://settings',
      'javascript:alert(1)',
      'devtools://devtools/bundled/inspector.html',
      'ftp://example.com/',
      'about:srcdoc',
      '',
      '//evil.example/x',
      42,
      undefined,
      null
    ]) {
      expect(extensionNavigableUrl(url, ID), String(url)).toBeNull()
    }
  })
})

describe('canCaptureTab', () => {
  const tab = { id: 1, url: 'https://bank.example/account' }

  it('wants the page of every site, or a tab the user handed over to an extension that declared activeTab', () => {
    expect(canCaptureTab(context([], ['<all_urls>']), tab)).toBe(true)
    expect(canCaptureTab(context(['activeTab']), tab)).toBe(false)
    const grants = new ActiveTabGrants()
    grants.grant(ID, 1, tab.url)
    expect(canCaptureTab(context(['activeTab'], [], grants), tab)).toBe(true)
    expect(canCaptureTab(context([], [], grants), tab)).toBe(false)
    expect(canCaptureTab(context(['activeTab'], [], grants), { id: 1, url: 'https://elsewhere.example/' })).toBe(false)
  })

  it('covers a blank tab with every site declared, but not a local file, a page of the browser or one of another extension', () => {
    const all = context([], ['<all_urls>'])
    expect(canCaptureTab(all, { id: 1, url: 'about:blank' })).toBe(true)
    for (const url of ['file:///etc/hosts', 'chrome://settings', `chrome-extension://${OTHER}/p.html`, 'view-source:https://a.example/']) expect(canCaptureTab(all, { id: 1, url }), url).toBe(false)
    expect(canCaptureTab(all, { id: 1, url: `chrome-extension://${ID}/panel.html` })).toBe(true)
  })

  it('does not take the permission of one site for the page of every site', () => {
    expect(canCaptureTab(context(['tabs'], ['https://bank.example/*']), tab)).toBe(false)
  })
})

describe('alreadyGranted', () => {
  it('answers a permission request with what the manifest holds, since nothing can be granted', () => {
    const access = accessOf({ permissions: ['tabs'], host_permissions: ['https://a.example/*'] })
    expect(alreadyGranted(access, { permissions: ['tabs'] })).toBe(true)
    expect(alreadyGranted(access, { origins: ['https://a.example/*'] })).toBe(true)
    expect(alreadyGranted(access, { permissions: ['cookies'] })).toBe(false)
    expect(alreadyGranted(access, { permissions: ['tabs'], origins: ['https://b.example/*'] })).toBe(false)
    expect(alreadyGranted(access, undefined)).toBe(true)
  })

  it('names what a request asks for beyond the manifest, permissions then sites, a few at most and each cut short', () => {
    const access = accessOf({ permissions: ['tabs'], host_permissions: ['https://a.example/*'] })
    expect(notGranted(access, { permissions: ['tabs', 'cookies', 7], origins: ['https://a.example/*', 'https://b.example/*'] })).toEqual(['cookies', '7', 'https://b.example/*'])
    expect(notGranted(access, { permissions: ['tabs'] })).toEqual([])
    expect(notGranted(access, { permissions: Array.from({ length: 40 }, (_unused, index) => `p${index}`) })).toHaveLength(12)
    expect(notGranted(access, { origins: [`https://${'a'.repeat(300)}.example/*`] })[0]).toHaveLength(120)
  })
})

describe('windowFilterOf', () => {
  const inside = { id: 1, windowId: 3 }
  const outside = { id: 2, windowId: 4 }

  it('asks for nothing when the query names neither filter', () => {
    expect(windowFilterOf({}, 3)).toBeNull()
    expect(windowFilterOf({ currentWindow: 'yes' }, 3)).toBeNull()
  })

  it('keeps the tabs of the window that had the focus last for currentWindow and lastFocusedWindow, and the others for false', () => {
    for (const key of ['currentWindow', 'lastFocusedWindow'] as const) {
      expect(windowFilterOf({ [key]: true }, 3)!(inside)).toBe(true)
      expect(windowFilterOf({ [key]: true }, 3)!(outside)).toBe(false)
      expect(windowFilterOf({ [key]: false }, 3)!(inside)).toBe(false)
      expect(windowFilterOf({ [key]: false }, 3)!(outside)).toBe(true)
    }
  })

  it('needs both when both are given', () => {
    expect(windowFilterOf({ currentWindow: true, lastFocusedWindow: false }, 3)!(inside)).toBe(false)
    expect(windowFilterOf({ currentWindow: true, lastFocusedWindow: true }, 3)!(inside)).toBe(true)
  })

  it('does not filter when the library no longer knows which window had the focus (it keeps the number of a window that was closed): the tabs are listed, not none', () => {
    expect(windowFilterOf({ currentWindow: true }, undefined)).toBeNull()
    expect(windowFilterOf({ currentWindow: false }, undefined)).toBeNull()
  })
})


describe('a tab lent to an extension that goes to another site', () => {
  const HERE = 'https://shop.example/basket'

  it('is no longer lent when it comes back: the loan ended when it left, and only a new click of the user gives another', () => {
    const grants = new ActiveTabGrants()
    grants.grant(ID, 1, HERE)
    // Another page of the same site, then another address in the same document: still the origin the user lent.
    grants.navigated(1, 'https://shop.example/pay')
    expect(grants.has(ID, 1, 'https://shop.example/pay')).toBe(true)
    grants.navigated(1, 'https://bank.example/account')
    expect(grants.has(ID, 1, 'https://bank.example/account')).toBe(false)
    // Back, by a link, a redirect or the Back button.
    grants.navigated(1, HERE)
    expect(grants.has(ID, 1, HERE)).toBe(false)
    grants.grant(ID, 1, HERE)
    expect(grants.has(ID, 1, HERE)).toBe(true)
  })

  it('ends for every extension the tab was lent to, and for that tab alone', () => {
    const grants = new ActiveTabGrants()
    grants.grant(ID, 1, HERE)
    grants.grant(OTHER, 1, HERE)
    grants.grant(ID, 11, HERE)
    grants.grant(ID, 2, 'about:blank')
    grants.navigated(1, 'https://bank.example/')
    grants.navigated(1, HERE)
    expect(grants.has(ID, 1, HERE)).toBe(false)
    expect(grants.has(OTHER, 1, HERE)).toBe(false)
    expect(grants.has(ID, 11, HERE)).toBe(true)
    // A page without an origin of its own is told apart by its whole address.
    grants.navigated(2, 'about:blank#top')
    expect(grants.has(ID, 2, 'about:blank')).toBe(false)
  })
})

// The Extensions page (chrome://extensions) is the browser's own page, at `lucium-ui://extensions/`: no content script, no request rule, no capture and no
// executeScript of an extension reaches it (they all read the address through the rules above), and its address is told to an extension with "tabs" only, as Chrome's.
describe('the Extensions page, for an extension', () => {
  const PAGE = 'lucium-ui://extensions/'
  const EVERYWHERE = ['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*', 'file:///*', 'ftp://*/*', 'ws://*/*', 'wss://*/*']
  const page = { id: 7, url: PAGE, title: 'Extensions', pendingUrl: PAGE, favIconUrl: 'data:image/png;base64,AA' }

  it('is reached by no host permission, whatever it says: not even the widest', () => {
    for (const url of [PAGE, 'lucium-ui://extensions/shortcuts', `lucium-ui://extensions/?id=${ID}`]) {
      for (const host of EVERYWHERE) {
        expect(matchPattern(host, url), `${host} ${url}`).toBe(false)
        expect(hasHostAccess(accessOf({ host_permissions: [host] }), url), `${host} ${url}`).toBe(false)
      }
      // A pattern that names the scheme is no match pattern at all.
      for (const host of ['lucium-ui://*/*', 'lucium-ui://extensions/*', 'chrome://extensions/*', 'chrome://*/*']) {
        expect(isPatternOf(host), host).toBe(false)
        expect(matchPattern(host, url), host).toBe(false)
      }
    }
  })

  it('cannot be captured, with every site declared or with a hand-over (activeTab): it is not a page of the web', () => {
    const grants = new ActiveTabGrants()
    grants.grant(ID, 7, PAGE)
    for (const permissions of [[], ['activeTab']]) {
      for (const hosts of [[], ['<all_urls>'], ['https://*/*']]) {
        const ctx = context(permissions, hosts, grants)
        expect(canCaptureTab(ctx, { id: 7, url: PAGE }), `${permissions} ${hosts}`).toBe(false)
        expect(canCaptureTab(ctx, { id: 7, url: 'lucium-ui://extensions/shortcuts' }), `${permissions} ${hosts}`).toBe(false)
      }
    }
    // The same call captures a page of the web, so the refusals above are the page's.
    const web = new ActiveTabGrants()
    web.grant(ID, 8, 'https://example.org/')
    expect(canCaptureTab(context(['activeTab'], [], web), { id: 8, url: 'https://example.org/' })).toBe(true)
    expect(canCaptureTab(context([], ['<all_urls>']), { id: 8, url: 'https://example.org/' })).toBe(true)
  })

  it('is never handed to an extension by a click on its icon or its shortcut (activeTab): the hand-over is not made', () => {
    const grants = new ActiveTabGrants()
    grants.grant(ID, 7, PAGE)
    expect(grants.has(ID, 7, PAGE)).toBe(false)
    grants.grant(ID, 8, 'https://example.org/')
    expect(grants.has(ID, 8, 'https://example.org/')).toBe(true)
    for (const look of ['lucium-ui://extensions@evil/', 'LUCIUM-UI://EXTENSIONS/', ' lucium-ui://evil/']) {
      grants.grant(ID, 9, look)
      expect(grants.has(ID, 9, look), look).toBe(false)
    }
  })

  it('has its address and its title told to an extension that has "tabs", and to none that has a host permission or the hand-over only', () => {
    expect(canReadTab(context(['tabs']), page)).toBe(true)
    for (const hosts of [['<all_urls>'], ['https://*/*'], ['http://*/*', 'file:///*']]) expect(canReadTab(context([], hosts), page), hosts.join()).toBe(false)
    const handed = new ActiveTabGrants()
    handed.grant(ID, 7, PAGE)
    expect(canReadTab(context(['activeTab'], ['<all_urls>'], handed), page)).toBe(false)
    expect(canReadTab(context(), { id: 7, url: 'https://example.org/' })).toBe(false)
  })

  it('is seen without its address, its title and its icon by an extension that may not read it, and at Chrome’s address by one that may', () => {
    const blind = visibleTab(context([], ['<all_urls>']), page)
    expect(blind).toEqual({ id: 7 })
    const told = visibleTab(context(['tabs']), page)
    expect(told).toMatchObject({ id: 7, url: 'chrome://extensions/', pendingUrl: 'chrome://extensions/', title: 'Extensions' })
    expect(JSON.stringify(told)).not.toContain('lucium-ui')
    expect(visibleTab(context(['tabs']), { id: 7, url: `lucium-ui://extensions/?id=${ID}&profile=work` })).toMatchObject({ url: `chrome://extensions/?id=${ID}&profile=work` })
    expect(visibleTab(context(['tabs']), { id: 7, url: 'lucium-ui://extensions/shortcuts' })).toMatchObject({ url: 'chrome://extensions/shortcuts' })
    // A tab of the web is given whole, as it was (the same object).
    const web = { id: 8, url: 'https://example.org/', title: 'x' }
    expect(visibleTab(context(['tabs']), web)).toBe(web)
    // An address that only looks like the page is no page of ours: it is told as it is.
    expect(visibleTab(context(['tabs']), { id: 9, url: 'lucium-ui://extensions@evil/' })).toMatchObject({ url: 'lucium-ui://extensions@evil/' })
  })

  it('is told the same way in the answers of tabs.query, tabs.get and windows, and in the events of tabs', () => {
    const ctx = context(['tabs'])
    expect(libraryResult(ctx, 'tabs.query', [page, { id: 8, url: 'https://example.org/' }])).toMatchObject([{ url: 'chrome://extensions/' }, { url: 'https://example.org/' }])
    expect(libraryResult(ctx, 'tabs.get', page)).toMatchObject({ url: 'chrome://extensions/' })
    expect(libraryResult(ctx, 'windows.get', { id: 1, tabs: [page] })).toMatchObject({ tabs: [{ url: 'chrome://extensions/' }] })
    expect(libraryEventArgs(ctx, 'tabs.onCreated', [page])).toMatchObject([{ url: 'chrome://extensions/' }])
    expect(libraryEventArgs(ctx, 'tabs.onUpdated', [7, { url: PAGE, status: 'complete' }, page])).toMatchObject([7, { url: 'chrome://extensions/', status: 'complete' }, { url: 'chrome://extensions/' }])
    expect(JSON.stringify(libraryEventArgs(ctx, 'tabs.onUpdated', [7, { url: PAGE }, page]))).not.toContain('lucium-ui')
    // For an extension that may not read the tab, the change that carries the address is not told at all.
    expect(libraryEventArgs(context([], ['<all_urls>']), 'tabs.onUpdated', [7, { url: PAGE }, page])).toBeNull()
    expect(JSON.stringify(libraryResult(context([], ['<all_urls>']), 'tabs.query', [page]))).not.toContain('lucium-ui')
  })

  it('is told in the navigation of the tab (webNavigation) at Chrome’s address to an extension that may read tabs, and to no other', () => {
    const details = { tabId: 7, frameId: 0, parentFrameId: -1, url: PAGE, timeStamp: 3 }
    const reader = context(['tabs', 'webNavigation'])
    for (const name of ['onBeforeNavigate', 'onCommitted', 'onCompleted', 'onDOMContentLoaded', 'onHistoryStateUpdated', 'onCreatedNavigationTarget', 'onErrorOccurred', 'onReferenceFragmentUpdated']) {
      expect(libraryEventArgs(reader, `webNavigation.${name}`, [details]), name).toEqual([{ ...details, url: 'chrome://extensions/' }])
      expect(libraryEventArgs(context(['webNavigation'], ['<all_urls>']), `webNavigation.${name}`, [details]), name).toBeNull()
      expect(libraryEventArgs(context(['tabs']), `webNavigation.${name}`, [details]), name).toBeNull()
    }
    expect(libraryEventArgs(reader, 'webNavigation.onCommitted', [{ ...details, url: `lucium-ui://extensions/?id=${ID}&profile=work` }])).toEqual([{ ...details, url: `chrome://extensions/?id=${ID}&profile=work` }])
    // What is not the page goes as it was, the same arguments: a page of the web, and an address that only looks like the page's (it is no page of ours).
    const web = { ...details, url: 'https://example.org/' }
    expect(libraryEventArgs(context(['webNavigation']), 'webNavigation.onCommitted', [web])).toEqual([web])
    expect(libraryEventArgs(context(['webNavigation']), 'webNavigation.onCommitted', [web])![0]).toBe(web)
    // Any address of the scheme is the browser's: a look-alike is told to nobody who may not read tabs, and to the others as it is (it is no page of ours to rename).
    const look = { ...details, url: 'lucium-ui://extensions@evil/' }
    expect(libraryEventArgs(context(['webNavigation']), 'webNavigation.onCommitted', [look])).toBeNull()
    expect(libraryEventArgs(reader, 'webNavigation.onCommitted', [look])).toEqual([look])
    // An event without an address in its details (a tab replaced by another) is given as it is.
    const replaced = { replacedTabId: 7, tabId: 8, timeStamp: 3 }
    expect(libraryEventArgs(context(['webNavigation']), 'webNavigation.onTabReplaced', [replaced])).toEqual([replaced])
    // The API that was not declared sends nothing, as before.
    expect(libraryEventArgs(context(['tabs']), 'webNavigation.onCommitted', [web])).toBeNull()
    expect(JSON.stringify(libraryEventArgs(reader, 'webNavigation.onCommitted', [details]))).not.toContain('lucium-ui')
  })

  it('is told in the frames of webNavigation.getFrame and getAllFrames the same way', () => {
    const frame = { url: PAGE, frameId: 0, parentFrameId: -1, documentId: 'x' }
    const sub = { url: 'https://example.org/embed', frameId: 3, parentFrameId: 0 }
    expect(libraryResult(context(['tabs', 'webNavigation']), 'webNavigation.getFrame', frame)).toEqual({ ...frame, url: 'chrome://extensions/' })
    expect(libraryResult(context(['webNavigation'], ['<all_urls>']), 'webNavigation.getFrame', frame)).toBeNull()
    expect(libraryResult(context(['webNavigation']), 'webNavigation.getFrame', null)).toBeNull()
    expect(libraryResult(context(['tabs', 'webNavigation']), 'webNavigation.getAllFrames', [frame, sub])).toEqual([{ ...frame, url: 'chrome://extensions/' }, sub])
    expect(libraryResult(context(['webNavigation'], ['<all_urls>']), 'webNavigation.getAllFrames', [frame, sub])).toEqual([sub])
    expect(libraryResult(context(['webNavigation']), 'webNavigation.getAllFrames', null)).toBeNull()
    expect(visibleNavigation(context(['webNavigation']), sub)).toBe(sub)
    expect(visibleNavigation(context(['webNavigation']), 'not a detail')).toBe('not a detail')
  })

  it('is found by an extension that may read it with the pattern it would use in Chrome, and by none that may not', () => {
    const query = (ctx: AccessContext, url: string) => tabMatchesQuery(ctx, page, { url })
    expect(query(context(['tabs']), 'chrome://extensions/*')).toBe(true)
    expect(query(context(['tabs']), 'chrome://extensions/')).toBe(true)
    expect(query(context(['tabs']), 'lucium-ui://*')).toBe(false)
    expect(query(context(['tabs']), 'https://*/*')).toBe(false)
    expect(query(context([], ['<all_urls>']), 'chrome://extensions/*')).toBe(false)
    expect(query(context([], ['<all_urls>']), '<all_urls>')).toBe(false)
  })
})
