import { extensionMenuCommands } from './keybindings'
import { describe, expect, it } from 'vitest'
import { DATA_API_METHODS } from './extension-data'
import type { DownloadInfo } from './model'
import { hostPatternsOf, isAuthPageUrl, isAuthRedirect, isRelayedEvent, isRequestedDownload, lifecycleEvents, MAX_WINDOW_SIZE, MIN_WINDOW_SIZE, normalizeTabUrl, relayScript, normalizeWindowUrl, parseSuggestedKey, readCommands, redirectUrl, safeDownloadName, searchDownloads, shimAllowed, shimEventAllowed, toChromeDownload, windowBounds, windowUpdate } from './chrome-compat'

describe('normalizeTabUrl', () => {
  it('turns the new tab page into a blank tab', () => {
    expect(normalizeTabUrl('chrome://newtab')).toBe('about:blank')
    expect(normalizeTabUrl('chrome://newtab/')).toBe('about:blank')
    expect(normalizeTabUrl(' CHROME://NEWTAB/ ')).toBe('about:blank')
  })

  it('leaves every other address, and a missing one, as it is', () => {
    expect(normalizeTabUrl('https://example.com/')).toBe('https://example.com/')
    expect(normalizeTabUrl('chrome://settings')).toBe('chrome://settings')
    expect(normalizeTabUrl('chrome://newtab-evil')).toBe('chrome://newtab-evil')
    expect(normalizeTabUrl(undefined)).toBeUndefined()
  })
})

describe('parseSuggestedKey', () => {
  it('reads a macOS key in Electron syntax and the manifest\'s own notation', () => {
    expect(parseSuggestedKey('Command+E', false)).toEqual({ accelerator: 'Cmd+E', label: '⌘E' })
    expect(parseSuggestedKey('Command+Shift+9', false)).toEqual({ accelerator: 'Shift+Cmd+9', label: '⇧⌘9' })
    expect(parseSuggestedKey('MacCtrl+Alt+Y', false)).toEqual({ accelerator: 'Ctrl+Alt+Y', label: '⌃⌥Y' })
  })

  it('reads Ctrl of the cross-platform default as Command, but Ctrl of the mac entry as Control', () => {
    expect(parseSuggestedKey('Ctrl+E', true)).toEqual({ accelerator: 'Cmd+E', label: '⌘E' })
    expect(parseSuggestedKey('Ctrl+E', false)).toEqual({ accelerator: 'Ctrl+E', label: '⌃E' })
  })

  it('reads named keys and function keys', () => {
    expect(parseSuggestedKey('Command+Comma', false)).toEqual({ accelerator: 'Cmd+,', label: '⌘,' })
    expect(parseSuggestedKey('Alt+Up', false)).toEqual({ accelerator: 'Alt+Up', label: '⌥↑' })
    expect(parseSuggestedKey('F5', false)).toEqual({ accelerator: 'F5', label: 'F5' })
  })

  it('refuses a key that the manifest format does not accept', () => {
    for (const key of ['E', 'Shift+E', 'Command+', 'Command+Command+E', 'Meta+E', 'Command+ee', 'Command+F13', '']) expect(parseSuggestedKey(key, false)).toBeNull()
  })
  it('refuses a key that is only a member every object inherits, and every key it accepts is one the menu takes', () => {
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(parseSuggestedKey(`Ctrl+${key}`, true), key).toBeNull()
      expect(parseSuggestedKey(`Command+${key}`, false), key).toBeNull()
    }
    expect(readCommands({ commands: { x: { suggested_key: { default: 'Ctrl+constructor' } } } })).toEqual([{ name: 'x', description: '', accelerator: null, label: '' }])
    // What it writes is what the Extensions menu accepts (keybindings.ts `extensionMenuCommands`): the two lists of keys stay one.
    for (const key of ['Comma', 'Period', 'Space', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Up', 'Down', 'Left', 'Right', 'A', '7', 'F1', 'F12']) {
      const parsed = parseSuggestedKey(`MacCtrl+Alt+Shift+Command+${key}`, false)
      expect(parsed, key).not.toBeNull()
      expect(extensionMenuCommands({ id: 'e', name: 'E', commands: [{ name: 'c', description: '', accelerator: parsed!.accelerator }] }), key).toHaveLength(1)
    }
  })
})

describe('readCommands', () => {
  it('lists the commands with the shortcut of the mac entry, falling back on the default', () => {
    const manifest = {
      commands: {
        'toggle-side-panel': { description: 'Toggle', suggested_key: { default: 'Ctrl+E', mac: 'Command+E' } },
        other: { description: 'Other', suggested_key: { default: 'Alt+Shift+K' } },
        plain: { description: 'No key' }
      }
    }
    expect(readCommands(manifest)).toEqual([
      { name: 'toggle-side-panel', description: 'Toggle', accelerator: 'Cmd+E', label: '⌘E' },
      { name: 'other', description: 'Other', accelerator: 'Alt+Shift+K', label: '⌥⇧K' },
      { name: 'plain', description: 'No key', accelerator: null, label: '' }
    ])
  })

  it('has nothing to list for a manifest without commands', () => {
    expect(readCommands({})).toEqual([])
    expect(readCommands(null)).toEqual([])
  })
})

describe('authorization flow addresses', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop'

  it('builds the redirect URL of an extension', () => {
    expect(redirectUrl(id)).toBe(`https://${id}.chromiumapp.org/`)
    expect(redirectUrl(id, 'cb')).toBe(`https://${id}.chromiumapp.org/cb`)
    expect(redirectUrl(id, '/cb')).toBe(`https://${id}.chromiumapp.org/cb`)
  })

  it('recognizes only the extension\'s own redirect host, over https', () => {
    expect(isAuthRedirect(`https://${id}.chromiumapp.org/cb?code=1`, id)).toBe(true)
    expect(isAuthRedirect(`http://${id}.chromiumapp.org/cb`, id)).toBe(false)
    expect(isAuthRedirect(`https://other.chromiumapp.org/cb`, id)).toBe(false)
    expect(isAuthRedirect(`https://${id}.chromiumapp.org.evil.com/cb`, id)).toBe(false)
    expect(isAuthRedirect(`https://evil.com/${id}.chromiumapp.org/`, id)).toBe(false)
    expect(isAuthRedirect('not a url', id)).toBe(false)
  })

  it('accepts only web pages as authorization pages', () => {
    expect(isAuthPageUrl('https://claude.ai/oauth/authorize?x=1')).toBe(true)
    expect(isAuthPageUrl('http://127.0.0.1:8000/auth')).toBe(true)
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'chrome-extension://abc/page.html', 'about:blank', 'nope', 3, undefined]) expect(isAuthPageUrl(url)).toBe(false)
  })
})

describe('downloads', () => {
  const info = (patch: Partial<DownloadInfo> = {}): DownloadInfo => ({
    id: 'dl-1',
    filename: 'a.bin',
    url: 'https://example.com/a.bin',
    path: '/Users/me/Downloads/a.bin',
    state: 'completed',
    receivedBytes: 10,
    totalBytes: 10,
    startedAt: Date.UTC(2026, 9, 23, 12, 0, 0),
    ...patch
  })

  it('shows a finished download the way chrome.downloads does', () => {
    const item = toChromeDownload(7, info(), 'ext1', Date.UTC(2026, 9, 23, 12, 3, 0))
    expect(item).toMatchObject({ id: 7, state: 'complete', filename: '/Users/me/Downloads/a.bin', bytesReceived: 10, fileSize: 10, exists: true, byExtensionId: 'ext1', startTime: '2026-10-23T12:00:00.000Z' })
    expect(item.endTime).toBe('2026-10-23T12:03:00.000Z')
  })

  // The end is when the download ended, not when an extension asks: without the moment, the optional field is left out.
  it('gives the end of a download only from the moment it ended, never the time of the question', () => {
    expect(toChromeDownload(7, info()).endTime).toBeUndefined()
    expect(toChromeDownload(7, info(), undefined, Number.NaN).endTime).toBeUndefined()
    expect(toChromeDownload(7, info({ state: 'progressing' }), undefined, Date.UTC(2026, 9, 23, 12, 3, 0)).endTime).toBeUndefined()
    expect(toChromeDownload(7, info({ state: 'cancelled' }), undefined, Date.UTC(2026, 9, 23, 12, 1, 0)).endTime).toBe('2026-10-23T12:01:00.000Z')
  })

  it('maps progress, cancellation and failure', () => {
    expect(toChromeDownload(1, info({ state: 'progressing', receivedBytes: 3 }))).toMatchObject({ state: 'in_progress', exists: false })
    expect(toChromeDownload(1, info({ state: 'progressing' })).endTime).toBeUndefined()
    expect(toChromeDownload(1, info({ state: 'cancelled' }))).toMatchObject({ state: 'interrupted', error: 'USER_CANCELED' })
    expect(toChromeDownload(1, info({ state: 'interrupted' }))).toMatchObject({ state: 'interrupted', error: 'NETWORK_FAILED' })
  })

  it('searches by id, url, state, file name, terms (with exclusion) and limit', () => {
    const items = [toChromeDownload(1, info()), toChromeDownload(2, info({ url: 'https://example.com/b.png', path: '/d/b.png', state: 'progressing' })), toChromeDownload(3, info({ path: '/d/c.bin' }))]
    expect(searchDownloads(items, { id: 2 }).map((i) => i.id)).toEqual([2])
    expect(searchDownloads(items, { state: 'complete' }).map((i) => i.id)).toEqual([1, 3])
    expect(searchDownloads(items, { url: 'https://example.com/b.png' }).map((i) => i.id)).toEqual([2])
    expect(searchDownloads(items, { filename: '.bin' }).map((i) => i.id)).toEqual([1, 3])
    expect(searchDownloads(items, { query: ['b.png'] }).map((i) => i.id)).toEqual([2])
    expect(searchDownloads(items, { query: ['example', '-png'] }).map((i) => i.id)).toEqual([1, 3])
    expect(searchDownloads(items, { limit: 1 }).map((i) => i.id)).toEqual([1])
    expect(searchDownloads(items, {})).toHaveLength(3)
  })

  it('keeps a requested file name inside the downloads folder', () => {
    expect(safeDownloadName('report.pdf')).toBe('report.pdf')
    expect(safeDownloadName('sub/dir/report.pdf')).toBe('sub/dir/report.pdf')
    for (const name of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', 'C:\\x', 'a\0b', '..']) expect(safeDownloadName(name)).toBeNull()
  })
})

describe('normalizeWindowUrl', () => {
  it('takes the first address of a list, and makes the new tab page a blank one', () => {
    expect(normalizeWindowUrl(['https://a.example/', 'https://b.example/'])).toBe('https://a.example/')
    expect(normalizeWindowUrl('chrome://newtab/')).toBe('about:blank')
    expect(normalizeWindowUrl('chrome-extension://abc/page.html?x=1')).toBe('chrome-extension://abc/page.html?x=1')
  })

  it('has nothing to show without an address', () => {
    expect(normalizeWindowUrl(undefined)).toBeNull()
    expect(normalizeWindowUrl('')).toBeNull()
    expect(normalizeWindowUrl([])).toBeNull()
  })

  it('refuses what is not a web page, a blank page or an extension page', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'chrome://settings', 'about:config', 'relative/page.html']) expect(() => normalizeWindowUrl(url)).toThrow('Invalid URL')
  })
})

describe('shimAllowed: getMatchedRules', () => {
  it('needs the feedback permission on top of one of the two request-rule permissions', () => {
    expect(shimAllowed({ permissions: ['declarativeNetRequest', 'declarativeNetRequestFeedback'] }, 'declarativeNetRequest', 'getMatchedRules')).toBe(true)
    expect(shimAllowed({ permissions: ['declarativeNetRequestWithHostAccess', 'declarativeNetRequestFeedback'] }, 'declarativeNetRequest', 'getMatchedRules')).toBe(true)
    expect(shimAllowed({ permissions: ['declarativeNetRequest'] }, 'declarativeNetRequest', 'getMatchedRules')).toBe(false)
    expect(shimAllowed({ permissions: ['declarativeNetRequestFeedback'] }, 'declarativeNetRequest', 'getMatchedRules')).toBe(false)
  })
})

describe('shimAllowed', () => {
  const manifest = (permissions: string[], host_permissions: string[] = []) => ({ permissions, host_permissions })

  it('gives each API only to an extension that declared its permission', () => {
    const cases: Array<[string, string, string]> = [
      ['sidePanel', 'open', 'sidePanel'],
      ['tabGroups', 'query', 'tabGroups'],
      ['tabs', 'group', 'tabGroups'],
      ['tabs', 'ungroup', 'tabGroups'],
      ['debugger', 'attach', 'debugger'],
      ['nativeMessaging', 'connect', 'nativeMessaging'],
      ['identity', 'launchWebAuthFlow', 'identity'],
      ['downloads', 'download', 'downloads'],
      ['contextMenus', 'update', 'contextMenus'],
      ['management', 'getAll', 'management']
    ]
    for (const [api, method, permission] of cases) {
      expect(shimAllowed(manifest([permission]), api, method)).toBe(true)
      expect(shimAllowed(manifest(['storage', 'tabs']), api, method)).toBe(false)
      expect(shimAllowed(undefined, api, method)).toBe(false)
    }
  })

  it('serves the paste of a content script to clipboardRead and the copy of a page to clipboardWrite, each alone', () => {
    expect(shimAllowed(manifest(['clipboardRead']), 'clipboard', 'paste')).toBe(true)
    expect(shimAllowed(manifest(['clipboardWrite']), 'clipboard', 'write')).toBe(true)
    expect(shimAllowed(manifest(['clipboardWrite']), 'clipboard', 'paste')).toBe(false)
    expect(shimAllowed(manifest(['clipboardRead']), 'clipboard', 'write')).toBe(false)
    expect(shimAllowed(manifest(['clipboardRead', 'clipboardWrite']), 'clipboard', 'read')).toBe(false)
    expect(shimAllowed(manifest(['storage', 'tabs']), 'clipboard', 'paste')).toBe(false)
    expect(shimAllowed(manifest([], ['<all_urls>']), 'clipboard', 'write')).toBe(false)
    expect(shimAllowed(undefined, 'clipboard', 'paste')).toBe(false)
  })

  it('serves the request rules to an extension that holds one of the two permissions of the API, and only the calls the shims make', () => {
    for (const permission of ['declarativeNetRequest', 'declarativeNetRequestWithHostAccess']) {
      for (const method of ['mirror', 'getEnabledRulesets', 'updateEnabledRulesets', 'updateStaticRules', 'getDisabledRuleIds', 'getAvailableStaticRuleCount']) expect(shimAllowed(manifest([permission]), 'declarativeNetRequest', method), `${permission} ${method}`).toBe(true)
      expect(shimAllowed(manifest([permission]), 'declarativeNetRequest', 'updateSessionRules')).toBe(false)
    }
    // Reading which rules acted is another permission, and gives no right to register rules.
    expect(shimAllowed(manifest(['declarativeNetRequestFeedback', 'webRequest']), 'declarativeNetRequest', 'mirror')).toBe(false)
    expect(shimAllowed(manifest([], ['<all_urls>']), 'declarativeNetRequest', 'mirror')).toBe(false)
    expect(shimAllowed(undefined, 'declarativeNetRequest', 'mirror')).toBe(false)
  })

  it('lets an extension listen to the requests, and be told about them, only with the webRequest permission', () => {
    expect(shimAllowed(manifest(['webRequest']), 'webRequest', 'listen')).toBe(true)
    expect(shimAllowed(manifest(['webRequest']), 'webRequest', 'anything')).toBe(false)
    expect(shimAllowed(manifest(['declarativeNetRequest'], ['<all_urls>']), 'webRequest', 'listen')).toBe(false)
    expect(shimEventAllowed(manifest(['webRequest']), 'webRequest', 'onCompleted')).toBe(true)
    expect(shimEventAllowed(manifest(['declarativeNetRequest'], ['<all_urls>']), 'webRequest', 'onCompleted')).toBe(false)
  })

  it('takes the answer of a blocking listener only from an extension that holds webRequestBlocking', () => {
    expect(shimAllowed(manifest(['webRequest', 'webRequestBlocking']), 'webRequest', 'answer')).toBe(true)
    expect(shimAllowed(manifest(['webRequest']), 'webRequest', 'answer')).toBe(false)
    expect(shimAllowed(manifest(['webRequestBlocking']), 'webRequest', 'answer')).toBe(false)
  })

  it('runs a script in a lent tab only for an extension that holds both activeTab and scripting', () => {
    for (const method of ['executeScript', 'insertCSS', 'removeCSS']) {
      expect(shimAllowed(manifest(['activeTab', 'scripting']), 'scripting', method), method).toBe(true)
      expect(shimAllowed(manifest(['scripting'], ['<all_urls>']), 'scripting', method), method).toBe(false)
      expect(shimAllowed(manifest(['activeTab']), 'scripting', method), method).toBe(false)
    }
    expect(shimAllowed(manifest(['activeTab', 'scripting']), 'scripting', 'registerContentScripts')).toBe(false)
  })

  it('answers a worker for a script of a lent tab only for an extension that holds both activeTab and scripting, and only those three calls', () => {
    for (const method of ['answer', 'toTab', 'changed']) {
      expect(shimAllowed(manifest(['activeTab', 'scripting']), 'lentTab', method), method).toBe(true)
      expect(shimAllowed(manifest(['scripting'], ['<all_urls>']), 'lentTab', method), method).toBe(false)
      expect(shimAllowed(manifest(['activeTab']), 'lentTab', method), method).toBe(false)
      expect(shimAllowed(manifest(['storage']), 'lentTab', method), method).toBe(false)
    }
    for (const method of ['ask', 'executeScript', '', 'toString']) expect(shimAllowed(manifest(['activeTab', 'scripting']), 'lentTab', method), method).toBe(false)
  })

  it('serves contextMenus.update and nothing else of contextMenus: the library has the rest', () => {
    for (const method of ['create', 'remove', 'removeAll', 'anything']) expect(shimAllowed(manifest(['contextMenus']), 'contextMenus', method)).toBe(false)
  })

  it('gives history, bookmarks and browsingData only to an extension that declared that permission, for every method of each', () => {
    for (const [api, methods] of Object.entries(DATA_API_METHODS)) {
      expect(methods.length, api).toBeGreaterThan(0)
      for (const method of methods) {
        expect(shimAllowed(manifest([api]), api, method), `${api}.${method} with the permission`).toBe(true)
        expect(shimAllowed(manifest(['storage', 'tabs', 'history', 'bookmarks', 'browsingData'].filter((p) => p !== api)), api, method), `${api}.${method} without it`).toBe(false)
        expect(shimAllowed(manifest([], ['<all_urls>']), api, method), `${api}.${method} with every site only`).toBe(false)
        expect(shimAllowed(undefined, api, method), `${api}.${method} with no manifest`).toBe(false)
        // The same rule for the events: a permission for one of the three gives nothing of the others.
        expect(shimEventAllowed(manifest([api]), api, 'onAnything')).toBe(true)
        expect(shimEventAllowed(manifest(['downloads']), api, 'onAnything')).toBe(false)
      }
    }
  })

  it('lets a screenshot of the visible tab through with activeTab or with access to every site, not otherwise', () => {
    expect(shimAllowed(manifest(['activeTab']), 'tabs', 'captureVisibleTab')).toBe(true)
    expect(shimAllowed(manifest([], ['<all_urls>']), 'tabs', 'captureVisibleTab')).toBe(true)
    expect(shimAllowed(manifest([], ['https://*/*']), 'tabs', 'captureVisibleTab')).toBe(true)
    expect(shimAllowed(manifest(['tabs'], ['https://example.com/*']), 'tabs', 'captureVisibleTab')).toBe(false)
  })

  it('does not take a host pattern among the permissions of a Manifest V3 extension for access to every site (the extension platform ignores it there), but does in Manifest V2', () => {
    for (const pattern of ['<all_urls>', '*://*/*', 'https://*/*']) {
      expect(shimAllowed({ ...manifest([pattern]), manifest_version: 3 }, 'tabs', 'captureVisibleTab'), `${pattern} in MV3`).toBe(false)
      expect(shimAllowed(manifest([pattern]), 'tabs', 'captureVisibleTab'), `${pattern} without a version`).toBe(false)
      expect(shimAllowed({ ...manifest([pattern]), manifest_version: 2 }, 'tabs', 'captureVisibleTab'), `${pattern} in MV2`).toBe(true)
    }
    expect(hostPatternsOf({ manifest_version: 3, permissions: ['<all_urls>', 'tabs'], host_permissions: ['https://a.example/*', 4] })).toEqual(['https://a.example/*'])
    expect(hostPatternsOf({ manifest_version: 2, permissions: ['<all_urls>', 'tabs'], host_permissions: ['https://a.example/*'] })).toEqual(['https://a.example/*', '<all_urls>'])
    expect(hostPatternsOf(undefined)).toEqual([])
  })

  it('answers which contexts exist to anyone, and refuses a call it does not know', () => {
    expect(shimAllowed(manifest([]), 'runtime', 'sidePanelContexts')).toBe(true)
    expect(shimAllowed(manifest([]), 'events', 'relay')).toBe(true)
    expect(shimAllowed(manifest([]), 'events', 'subscribe')).toBe(true)
    expect(shimAllowed(manifest([]), 'events', 'other')).toBe(false)
    expect(shimAllowed(manifest(['debugger']), 'runtime', 'anythingElse')).toBe(false)
    expect(shimAllowed(manifest(['debugger']), 'fs', 'readFile')).toBe(false)
    expect(shimAllowed(manifest([]), 'tabs', 'discard')).toBe(true)
  })
})

describe('relayed events', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop'

  it('knows which events are relayed to a worker', () => {
    expect(isRelayedEvent('storage.onChanged')).toBe(true)
    expect(isRelayedEvent('alarms.onAlarm')).toBe(true)
    for (const name of ['tabs.onUpdated', 'storage', 'alarms.onAlarm; evil()', undefined, 3]) expect(isRelayedEvent(name)).toBe(false)
  })

  it('writes a script that listens to the event and reports it for this extension', () => {
    const script = relayScript(id, 'storage.onChanged')
    expect(script).toContain('chrome.storage')
    expect(script).toContain('api.onChanged.addListener')
    expect(script).toContain(`'${id}', 'events', 'relay', ['storage.onChanged', args]`)
  })

  it('refuses an extension id that is not one, since the id ends up inside the script', () => {
    expect(() => relayScript("a'); evil(); ('", 'alarms.onAlarm')).toThrow('Invalid extension id')
    expect(() => relayScript('short', 'alarms.onAlarm')).toThrow('Invalid extension id')
  })
})

describe('lifecycleEvents', () => {
  it('installs an extension that was never loaded in the profile', () => {
    expect(lifecycleEvents(undefined, '1.0.0')).toEqual([{ event: 'onInstalled', details: { reason: 'install' } }])
  })

  it('starts an extension that is loaded again at the version it had', () => {
    expect(lifecycleEvents('1.0.0', '1.0.0')).toEqual([{ event: 'onStartup' }])
  })

  it('tells an updated extension what it was, then starts it', () => {
    expect(lifecycleEvents('1.0.0', '1.1.0')).toEqual([{ event: 'onInstalled', details: { reason: 'update', previousVersion: '1.0.0' } }, { event: 'onStartup' }])
  })
})

describe('windowUpdate', () => {
  it('asks for the focus only when focused is true', () => {
    expect(windowUpdate({ focused: true }).focus).toBe(true)
    expect(windowUpdate({ focused: false }).focus).toBe(false)
    expect(windowUpdate({ focused: 'yes' }).focus).toBe(false)
  })

  it('keeps the position and size that were given, rounded, and nothing else', () => {
    expect(windowUpdate({ left: 10.4, top: 20, width: 640, height: 480.6, state: 'maximized' }).bounds).toEqual({ x: 10, y: 20, width: 640, height: 481 })
    expect(windowUpdate({ width: 800 }).bounds).toEqual({ width: 800 })
  })

  it('ignores what is not a number, and a call without anything to do', () => {
    expect(windowUpdate({ left: 'far', top: NaN, width: Infinity }).bounds).toBeNull()
    expect(windowUpdate(undefined)).toEqual({ focus: false, bounds: null })
    expect(windowUpdate({ state: 'normal' })).toEqual({ focus: false, bounds: null })
  })
})

describe('windowBounds', () => {
  it('keeps a position and a size within limits, as whole numbers', () => {
    expect(windowBounds({ left: 1e9, top: -1e9, width: 1e9, height: 3 })).toEqual({ x: 100_000, y: -100_000, width: MAX_WINDOW_SIZE, height: MIN_WINDOW_SIZE })
    expect(windowBounds({ left: 10.6, width: 640.4 })).toEqual({ x: 11, width: 640 })
  })

  it('leaves out what is not a finite number: a size of NaN would make the window refuse it once the window exists', () => {
    expect(windowBounds({ width: NaN, height: 500 })).toEqual({ height: 500 })
    expect(windowBounds({ width: Infinity, left: -Infinity, top: '5', height: null })).toBeNull()
    expect(windowBounds(undefined)).toBeNull()
  })
})

describe('shimEventAllowed', () => {
  const manifest = (...permissions: string[]) => ({ permissions })

  it('delivers the events of an API Lucium provides only to an extension that declared its permission', () => {
    const cases: Array<[string, string, string]> = [
      ['downloads', 'onCreated', 'downloads'],
      ['downloads', 'onChanged', 'downloads'],
      ['tabGroups', 'onCreated', 'tabGroups'],
      ['debugger', 'onEvent', 'debugger'],
      ['sidePanel', 'onOpened', 'sidePanel'],
      ['nativeMessaging', 'port', 'nativeMessaging'],
      ['identity', 'onSignInChanged', 'identity']
    ]
    for (const [api, event, permission] of cases) {
      expect(shimEventAllowed(manifest(permission), api, event), `${api}.${event}`).toBe(true)
      expect(shimEventAllowed(manifest('storage', 'tabs'), api, event), `${api}.${event} without`).toBe(false)
      expect(shimEventAllowed(undefined, api, event)).toBe(false)
    }
  })

  it('delivers nothing of an API it does not know', () => {
    expect(shimEventAllowed(manifest('downloads'), 'fs', 'onChanged')).toBe(false)
  })
})

describe('isRequestedDownload', () => {
  it('knows the download an extension asked for by its address, however the browser writes it', () => {
    expect(isRequestedDownload('http://127.0.0.1:8080', ['http://127.0.0.1:8080/'])).toBe(true)
    expect(isRequestedDownload('https://a.example/file.zip', ['https://a.example/file.zip'])).toBe(true)
  })

  it('also knows it by an address it was redirected from', () => {
    expect(isRequestedDownload('https://a.example/get', ['https://cdn.example/f.zip', 'https://a.example/get', 'https://cdn.example/f.zip'])).toBe(true)
  })

  it('does not take another download for it', () => {
    expect(isRequestedDownload('https://a.example/get', ['https://a.example/other'])).toBe(false)
    expect(isRequestedDownload('https://a.example/get', [])).toBe(false)
  })
})
