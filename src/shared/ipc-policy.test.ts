import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOWNLOAD_FOLDERS_MAX, DownloadFolders, interfaceMayDispatch, MAIN_ONLY_ACTIONS } from './ipc-policy'
import { createInitialState, reduce } from './sidebar'
import type { Action } from './sidebar-actions'

const known = ['/ext/a', '/ext/b']

describe('interfaceMayDispatch', () => {
  it('lets the ordinary actions through', () => {
    expect(interfaceMayDispatch({ type: 'tab/open', url: 'https://example.org/' }, known)).toBe(true)
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { sidebarWidth: 300 } }, known)).toBe(true)
  })

  it('refuses a tab that claims to be an extension page: only an extension asking the main process opens one (this fails if the flag is trusted)', () => {
    const page = `chrome-extension://${'a'.repeat(32)}/options.html`
    expect(interfaceMayDispatch({ type: 'tab/open', url: page, allowExtensionPages: true }, known)).toBe(false)
    expect(interfaceMayDispatch({ type: 'tab/open', url: page, allowExtensionPages: false }, known)).toBe(false)
    expect(interfaceMayDispatch({ type: 'tab/open', url: 'https://example.org/', allowExtensionPages: 1 }, known)).toBe(false)
    expect(interfaceMayDispatch({ type: 'tab/open', url: 'https://example.org/', background: true, private: true }, known)).toBe(true)
  })

  it('refuses what only the main process dispatches: replacing the whole state, merging an import', () => {
    for (const type of MAIN_ONLY_ACTIONS) expect(interfaceMayDispatch({ type }, known)).toBe(false)
    expect(MAIN_ONLY_ACTIONS.has('state/restore') && MAIN_ONLY_ACTIONS.has('import/merge') && MAIN_ONLY_ACTIONS.has('import/revert')).toBe(true)
  })

  it('refuses a restored copy of the session: it replaces the spaces and tabs, after a copy only the main process makes', () => {
    expect(MAIN_ONLY_ACTIONS.has('backup/restore')).toBe(true)
    expect(interfaceMayDispatch({ type: 'backup/restore', copy: { spaces: [], tabs: [] } }, known)).toBe(false)
  })

  it('refuses a whole split view sent by the interface: only the main process, which kept the closed one, puts it back', () => {
    const split = { id: 'sp', spaceId: 's', tabIds: ['a', 'b'], orientation: 'horizontal', ratios: [0.5, 0.5] }
    expect(MAIN_ONLY_ACTIONS.has('split/restore')).toBe(true)
    expect(interfaceMayDispatch({ type: 'split/restore', split }, known)).toBe(false)
    // The actions the bar of a split view sends itself are the interface's own.
    expect(interfaceMayDispatch({ type: 'split/ratios', id: 'sp', ratios: [0.3, 0.7] }, known)).toBe(true)
    expect(interfaceMayDispatch({ type: 'split/move', tabId: 'a', direction: 1 }, known)).toBe(true)
  })

  it('lets the interface tidy the tabs, but never send the undo of a tidy: the main process worked out what to put back', () => {
    expect(MAIN_ONLY_ACTIONS.has('tabs/untidy')).toBe(true)
    expect(interfaceMayDispatch({ type: 'tabs/untidy', tabs: [{ id: 'a', folderId: 'f', index: 0 }], folderIds: ['f'] }, known)).toBe(false)
    expect(interfaceMayDispatch({ type: 'tabs/tidy', groups: [{ name: 'GitHub', tabIds: ['a', 'b'] }] }, known)).toBe(true)
    expect(interfaceMayDispatch({ type: 'folder/bottom', id: 'f', bottom: true }, known)).toBe(true)
  })

  it('refuses anything that is not an action with a short string type', () => {
    for (const odd of [null, undefined, 5, 'tab/open', [], {}, { type: 5 }, { type: '' }, { type: 'x'.repeat(65) }]) expect(interfaceMayDispatch(odd, known)).toBe(false)
  })

  it('lets the interface remove an extension from the list, never add one', () => {
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { extensionPaths: ['/ext/a'] } }, known)).toBe(true)
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { extensionPaths: [] } }, known)).toBe(true)
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { extensionPaths: ['/ext/a', '/tmp/evil'] } }, known)).toBe(false)
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { extensionPaths: 5 } }, known)).toBe(false)
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { extensionPaths: [5] } }, known)).toBe(false)
  })

  it('refuses a settings patch that is not a plain object or carries __proto__', () => {
    for (const patch of [null, 'x', [], undefined]) expect(interfaceMayDispatch({ type: 'settings/update', patch }, known)).toBe(false)
    expect(interfaceMayDispatch({ type: 'settings/update', patch: JSON.parse('{"__proto__":{"polluted":true}}') }, known)).toBe(false)
  })

  it('lets the interface forget an application remembered for a type of file, never name one', () => {
    const apps = { pdf: '/Applications/Preview.app', txt: '/Applications/TextEdit.app' }
    const update = (openWithApps: unknown) => interfaceMayDispatch({ type: 'settings/update', patch: { openWithApps } }, known, apps)
    expect(update({ pdf: '/Applications/Preview.app' })).toBe(true)
    expect(update({})).toBe(true)
    expect(update({ ...apps, png: '/Applications/Preview.app' })).toBe(false)
    expect(update({ pdf: '/Users/me/Downloads/evil.app' })).toBe(false)
    expect(update('x')).toBe(false)
    expect(update(JSON.parse('{"__proto__":{}}'))).toBe(false)
    // With nothing remembered yet, nothing may be named either.
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { openWithApps: { pdf: '/Applications/Preview.app' } } }, known)).toBe(false)
  })
})

describe('the folder of the translation models', () => {
  // The folder is chosen in the system's box by the main process: a path the interface sends, however plausible, is never kept.
  it('is never set by the interface, whatever the path', () => {
    for (const path of ['/Users/moi/Modeles', '', '/etc', '../..', 5]) {
      expect(interfaceMayDispatch({ type: 'settings/update', patch: { translateModelsDir: path } }, known)).toBe(false)
      expect(interfaceMayDispatch({ type: 'settings/update', patch: { sidebarWidth: 300, translateModelsDir: path } }, known)).toBe(false)
    }
  })

  it('leaves the other settings of the function to the interface', () => {
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { translateLocal: true, translateTarget: 'de' } }, known)).toBe(true)
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { interfaceTranslated: true, language: 'en' } }, known)).toBe(true)
  })
})

describe('the protection a profile began with', () => {
  // What « modified » and « Rétablir » compare the protection with is set when the profile is made or its file first read: a patch of the interface never moves it.
  it('is never written by the interface, alone or with other settings', () => {
    for (const value of ['standard', 'renforcee', 'x', 5]) {
      expect(interfaceMayDispatch({ type: 'settings/update', patch: { protectionBaseline: value } }, known)).toBe(false)
      expect(interfaceMayDispatch({ type: 'settings/update', patch: { blockCookieBanners: true, protectionBaseline: value } }, known)).toBe(false)
    }
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { blockCookieBanners: true, sendGpc: false } }, known)).toBe(true)
  })
})

describe('what only the main process says', () => {
  // Each of these is sent by one place of the main process (the pictures folder, the icon resolver, the launch, an extension's call).
  it('refuses the picture of a tab, the answer of the icon resolver, the profiles put back at launch and the wish of an extension for its side panel', () => {
    for (const type of ['tab/image', 'favicon/fill', 'profile/revert-missing', 'sidepanel/behavior']) expect(MAIN_ONLY_ACTIONS.has(type), type).toBe(true)
    expect(interfaceMayDispatch({ type: 'tab/image', id: 't', image: 'a.png' }, known)).toBe(false)
    expect(interfaceMayDispatch({ type: 'favicon/fill', entries: [] }, known)).toBe(false)
    expect(interfaceMayDispatch({ type: 'profile/revert-missing', ids: ['work'] }, known)).toBe(false)
    expect(interfaceMayDispatch({ type: 'sidepanel/behavior', extensionId: 'a'.repeat(32), openOnActionClick: true }, known)).toBe(false)
  })

  it('leaves the answers to permissions to the interface: the site panel and the settings change them', () => {
    expect(interfaceMayDispatch({ type: 'permission/set', origin: 'https://a.example', permission: 'geolocation', decision: 'deny' }, known)).toBe(true)
    expect(interfaceMayDispatch({ type: 'container/permission', id: 'c', origin: 'https://a.example', permission: 'geolocation', decision: 'deny' }, known)).toBe(true)
  })

  it('refuses the address of the updates, which has no control in the interface', () => {
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { updateFeedUrl: 'https://evil.example/latest' } }, known)).toBe(false)
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { updateFeedUrl: null } }, known)).toBe(false)
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { autoUpdate: false } }, known)).toBe(true)
  })
})

describe('the folder a profile downloads into', () => {
  const patch = (profiles: unknown) => ({ type: 'settings/update', patch: { profiles } })

  it('is a folder the user picked in the folder box, never a path the interface sends on its own', () => {
    const folders = new DownloadFolders()
    expect(interfaceMayDispatch(patch({ work: { downloadDir: '/Users/x/Library/LaunchAgents' } }), known, {}, folders)).toBe(false)
    folders.note('/Users/x/Downloads/Work')
    expect(interfaceMayDispatch(patch({ work: { downloadDir: '/Users/x/Downloads/Work' } }), known, {}, folders)).toBe(true)
    expect(interfaceMayDispatch(patch({ work: { downloadDir: '/Users/x/Downloads/Work' }, perso: { downloadDir: '/Users/x/Library/LaunchAgents' } }), known, {}, folders)).toBe(false)
    // Not a text: nothing the reducer would keep, and nothing let through either.
    expect(interfaceMayDispatch(patch({ work: { downloadDir: ['/Users/x/Downloads/Work'] } }), known, {}, folders)).toBe(false)
  })

  it('names no folder at all for a caller that knows none', () => {
    expect(interfaceMayDispatch(patch({ work: { downloadDir: '/Users/x/Downloads/Work' } }), known)).toBe(false)
    expect(interfaceMayDispatch(patch({ work: { historyOff: true } }), known)).toBe(true)
    expect(interfaceMayDispatch(patch({}), known)).toBe(true)
  })

  it('keeps the folders the profiles already have: the other settings of a profile change, and a reset is undone', () => {
    const folders = new DownloadFolders()
    folders.noteProfiles({ work: { downloadDir: '/Volumes/Work/In' }, perso: { historyOff: true }, broken: null })
    expect(interfaceMayDispatch(patch({ work: { downloadDir: '/Volumes/Work/In', historyOff: true } }), known, {}, folders)).toBe(true)
    // The folder was dropped by a reset since: « Annuler » puts it back.
    folders.noteProfiles({})
    expect(interfaceMayDispatch(patch({ work: { downloadDir: '/Volumes/Work/In' } }), known, {}, folders)).toBe(true)
  })

  it('remembers a bounded number of folders, the most recent ones', () => {
    const folders = new DownloadFolders()
    for (let i = 0; i < DOWNLOAD_FOLDERS_MAX + 3; i++) folders.note(`/d/${i}`)
    expect(folders.has('/d/0')).toBe(false)
    expect(folders.has('/d/3')).toBe(true)
    expect(folders.has(`/d/${DOWNLOAD_FOLDERS_MAX + 2}`)).toBe(true)
    for (const value of [null, undefined, '', 3, {}]) folders.note(value)
    expect(folders.has('')).toBe(false)
  })

  it('is what the dispatch channel checks, with the folder the box answered', () => {
    const source = readFileSync(join(__dirname, '..', 'main', 'shell', 'ipc.ts'), 'utf8')
    expect(source).toContain('interfaceMayDispatch(action, store.get().settings.extensionPaths, store.get().settings.openWithApps, downloadFolders)')
    expect(source).toMatch(/downloadFolders\.noteProfiles\(store\.get\(\)\.settings\.profiles\)\n\s+if \(!interfaceMayDispatch\(/)
    expect(source).toMatch(/const folder = picked\.canceled \? null : \(picked\.filePaths\[0\] \?\? null\)\n\s+downloadFolders\.note\(folder\)/)
  })
})

describe('what the interface sends is not typed until it is checked', () => {
  const source = readFileSync(join(__dirname, '..', 'main', 'shell', 'ipc.ts'), 'utf8')

  it('declares as unknown what the handlers of the interface receive and then check', () => {
    expect(source).toContain('ipcMain.handle(Channel.dispatch, (e, action: unknown) => {')
    expect(source).toContain('ipcMain.handle(Channel.searchHistory, (e, query: unknown, limit?: unknown, profileId?: unknown) =>')
    expect(source).toContain('ipcMain.handle(Channel.suggest, (e, query: unknown) => {')
    // No handler takes a value of the interface under a type it has not earned.
    expect(source.match(/ipcMain\.handle\(Channel\.\w+, (?:async )?\(e(?:, \w+\??: (?!unknown)[^,)]+)+/g) ?? []).toEqual([])
  })
})

describe('the calls of the preload', () => {
  it('are all made by the interface: a channel nobody calls is a way in that serves nothing', () => {
    const preload = readFileSync(join(__dirname, '..', 'preload', 'index.ts'), 'utf8')
    const methods = [...preload.matchAll(/^  ([A-Za-z0-9_]+): \(/gm)].map((match) => match[1]!)
    expect(methods.length).toBeGreaterThan(100)
    const renderer = join(__dirname, '..', 'renderer')
    const interfaceCode = (readdirSync(renderer, { recursive: true }) as string[])
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\./.test(file))
      .map((file) => readFileSync(join(renderer, file), 'utf8'))
      .join('\n')
    const uncalled = methods.filter((method) => !new RegExp(`\\b${method}\\b`).test(interfaceCode))
    // `unusedProfiles` is called through the object the settings hand to shared/profile-purge.ts; `importRun` by the engine suites of the
    // import only (the interface previews, then confirms).
    expect(uncalled.sort()).toEqual(['importRun', 'unusedProfiles'])
  })
})

describe('what the reducer keeps of an action the interface sends', () => {
  const ctx = { now: 1, newId: () => 'x' }
  const start = createInitialState(ctx)
  const send = (action: unknown) => reduce(start, action as Action, ctx)

  it('keeps an answer to a permission only when it is one, for an origin and a permission that can be keys', () => {
    expect(send({ type: 'permission/set', origin: 'https://a.example', permission: 'geolocation', decision: 'allow' }).sitePermissions).toEqual({ 'https://a.example': { geolocation: 'allow' } })
    for (const action of [
      { type: 'permission/set', origin: 'https://a.example', permission: 'geolocation', decision: 'yes' },
      { type: 'permission/set', origin: 'https://a.example', permission: 'geolocation', decision: true },
      { type: 'permission/set', origin: 'https://a.example', permission: 'geolocation' },
      { type: 'permission/set', origin: '__proto__', permission: 'geolocation', decision: 'allow' },
      { type: 'permission/set', origin: 'https://a.example', permission: '__proto__', decision: 'allow' },
      { type: 'permission/set', origin: ['https://a.example'], permission: 'geolocation', decision: 'allow' },
      { type: 'permission/set', origin: 'https://a.example', permission: 7, decision: 'allow' },
      { type: 'permission/set', origin: `https://${'a'.repeat(3000)}.example`, permission: 'geolocation', decision: 'allow' }
    ]) {
      expect(send(action), JSON.stringify(action).slice(0, 120)).toBe(start)
    }
  })

  it('keeps the wish of an extension for its side panel only as a boolean under an id', () => {
    expect(send({ type: 'sidepanel/behavior', extensionId: 'ext1', openOnActionClick: true }).sidePanelBehavior).toEqual({ ext1: true })
    for (const action of [
      { type: 'sidepanel/behavior', extensionId: 'ext1', openOnActionClick: 'yes' },
      { type: 'sidepanel/behavior', extensionId: 'ext1', openOnActionClick: { toString: 1 } },
      { type: 'sidepanel/behavior', extensionId: '__proto__', openOnActionClick: true },
      { type: 'sidepanel/behavior', extensionId: ['ext1'], openOnActionClick: true }
    ]) {
      expect(send(action), JSON.stringify(action)).toBe(start)
    }
  })

  it('counts a choice of the command bar only under a text', () => {
    expect(send({ type: 'commandbar/used', key: 'url:https://a.example/' }).commandBarUsage).toEqual({ default: { 'url:https://a.example/': 1 } })
    for (const key of [['url:https://a.example/'], { length: 3 }, 12, null]) expect(send({ type: 'commandbar/used', key }), JSON.stringify(key)).toBe(start)
  })
})
