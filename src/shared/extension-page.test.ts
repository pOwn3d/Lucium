import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { ExtensionInfo } from './ipc'
import type { JournalEntry } from './extension-journal'
import { setLanguage } from './i18n'
import {
  ManifestRefusal,
  manifestTooLongMessage,
  checkManifestText,
  cleanExtensionsTarget,
  copyToShow,
  dataAccessLine,
  describeLoadError,
  declaresRequestBlocking,
  declaresServiceWorker,
  describeManifest,
  doneMessages,
  isLegacyManifest,
  legacyManifestLine,
  requestBlockingLine,
  extensionRows,
  extensionState,
  extensionsPath,
  filesNamedBy,
  filterRows,
  insidePath,
  journalOf,
  listedProfiles,
  parseExtensionsLocation,
  internalPageUrl,
  parseExtensionsRequest,
  profileToShow,
  readDeveloperMode,
  sortRows,
  unlistedJournal,
  keptAfterClear,
  writeDeveloperMode,
  DEVELOPER_MODE_KEY,
  type ExtensionDetail
} from './extension-page'
import { frenchSpaces } from './french-typography'
import { displayAddress, internalPageParts, isInternalPageUrl } from './internal-page'
import { extensionsPageOf } from './settings-target'

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)

const info = (over: Partial<ExtensionInfo> = {}): ExtensionInfo => ({ id: A, name: 'Alpha', version: '1.0', profileId: 'default', source: 'unpacked', enabled: true, ...over })
const detail = (over: Partial<ExtensionDetail> = {}): ExtensionDetail => ({ profileId: 'default', id: A, path: '/x', facts: null, workerRunning: false, ...over })

describe('the request of the page', () => {
  it('accepts exactly the keys that go with each operation', () => {
    expect(parseExtensionsRequest({ op: 'details' })).toEqual({ op: 'details' })
    expect(parseExtensionsRequest({ op: 'journal', since: 12 })).toEqual({ op: 'journal', since: 12 })
    expect(parseExtensionsRequest({ op: 'set-enabled', profileId: 'default', extensionId: A, enabled: false })).toEqual({ op: 'set-enabled', profileId: 'default', extensionId: A, enabled: false })
    expect(parseExtensionsRequest({ op: 'set-tab-capture', profileId: 'work', extensionId: A, allowed: true })).toEqual({ op: 'set-tab-capture', profileId: 'work', extensionId: A, allowed: true })
    expect(parseExtensionsRequest({ op: 'reload', profileId: 'work', extensionId: A })).toEqual({ op: 'reload', profileId: 'work', extensionId: A })
    expect(parseExtensionsRequest({ op: 'pack', extensionId: A })).toEqual({ op: 'pack', extensionId: A })
    expect(parseExtensionsRequest({ op: 'copy-id', extensionId: A })).toEqual({ op: 'copy-id', extensionId: A })
    expect(parseExtensionsRequest({ op: 'revoke-granted', profileId: 'default', extensionId: A, name: 'https://*.shop.example/*' })).toEqual({ op: 'revoke-granted', profileId: 'default', extensionId: A, name: 'https://*.shop.example/*' })
    expect(parseExtensionsRequest({ op: 'remove-folder', extensionId: A })).toEqual({ op: 'remove-folder', extensionId: A })
    expect(parseExtensionsRequest({ op: 'clear-journal' })).toEqual({ op: 'clear-journal' })
    expect(parseExtensionsRequest({ op: 'clear-journal', extensionId: A, profileId: 'default' })).toEqual({ op: 'clear-journal', extensionId: A, profileId: 'default' })
    for (const op of ['undo-remove', 'load-unpacked']) expect(parseExtensionsRequest({ op })).toEqual({ op })
  })

  it('refuses an unknown operation, a missing or extra key, and a path where the window may only name an extension', () => {
    const refused: unknown[] = [
      null,
      'reload',
      {},
      { op: 'format-disk' },
      { op: 'details', extra: 1 },
      { op: 'reload', extensionId: A },
      { op: 'reload', profileId: 'default', extensionId: A, path: '/etc' },
      // The folder to load is chosen in the system's box by the main process: a path typed by the page is never taken.
      { op: 'load-unpacked', path: '/Users/me/ext' },
      { op: 'undo-remove', path: '/Users/me/ext' },
      { op: 'pack', extensionId: A, folder: '/' },
      // What goes on the clipboard is the id of an extension and nothing else: no text of the page's choosing.
      { op: 'copy-id', extensionId: A, text: 'rm -rf /' },
      { op: 'copy-id', text: 'rm -rf /' },
      { op: 'copy-id', extensionId: 'nope' },
      { op: 'set-enabled', profileId: 'default', extensionId: A, enabled: 'yes' },
      // The capture of the sound of a tab is allowed with a plain boolean, for a profile and an extension that are ones, and nothing else.
      { op: 'set-tab-capture', profileId: 'default', extensionId: A, allowed: 'yes' },
      { op: 'set-tab-capture', profileId: 'default', extensionId: A, enabled: true },
      { op: 'set-tab-capture', profileId: 'default', extensionId: A, allowed: true, extra: 1 },
      { op: 'set-tab-capture', profileId: '__proto__', extensionId: A, allowed: true },
      { op: 'set-tab-capture', profileId: 'default', extensionId: 'nope', allowed: true },
      { op: 'set-tab-capture', extensionId: A, allowed: true }
    ]
    for (const raw of refused) expect(parseExtensionsRequest(raw), JSON.stringify(raw)).toBeNull()
  })

  // The panel of the site asks « Retirer ? » itself: it says so with `asked: true`, and with nothing that only looks like it.
  it('takes an uninstall that the interface already asked about, only with a plain true', () => {
    expect(parseExtensionsRequest({ op: 'uninstall', profileId: 'default', extensionId: A })).toEqual({ op: 'uninstall', profileId: 'default', extensionId: A })
    expect(parseExtensionsRequest({ op: 'uninstall', profileId: 'default', extensionId: A, asked: true })).toEqual({ op: 'uninstall', profileId: 'default', extensionId: A, asked: true })
    for (const asked of [false, 'true', 1, null, {}]) expect(parseExtensionsRequest({ op: 'uninstall', profileId: 'default', extensionId: A, asked }), JSON.stringify(asked)).toBeNull()
    expect(parseExtensionsRequest({ op: 'uninstall', profileId: 'default', extensionId: 'nope', asked: true })).toBeNull()
    expect(parseExtensionsRequest({ op: 'uninstall', extensionId: A, asked: true })).toBeNull()
    expect(parseExtensionsRequest({ op: 'uninstall', profileId: 'default', extensionId: A, asked: true, path: '/' })).toBeNull()
    // Only an uninstall skips the box: no other operation takes the key.
    expect(parseExtensionsRequest({ op: 'remove-folder', extensionId: A, asked: true })).toBeNull()
  })

  it('refuses an id that is not an extension id and a profile that is not a profile id', () => {
    expect(parseExtensionsRequest({ op: 'reload', profileId: 'default', extensionId: 'nope' })).toBeNull()
    expect(parseExtensionsRequest({ op: 'reload', profileId: '../other', extensionId: A })).toBeNull()
    expect(parseExtensionsRequest({ op: 'clear-journal', extensionId: 'x' })).toBeNull()
    // By numbers: a list of entry numbers, alone, within the size of the journal.
    expect(parseExtensionsRequest({ op: 'clear-journal', ids: [3, 5] })).toEqual({ op: 'clear-journal', ids: [3, 5] })
    for (const ids of [[], [0], [-1], [1.5], ['3'], 'all', Array.from({ length: 501 }, (_unused, index) => index + 1)]) expect(parseExtensionsRequest({ op: 'clear-journal', ids }), JSON.stringify(ids).slice(0, 30)).toBeNull()
    expect(parseExtensionsRequest({ op: 'clear-journal', ids: [3], profileId: 'default' })).toBeNull()
    expect(parseExtensionsRequest({ op: 'journal', since: -1 })).toBeNull()
    expect(parseExtensionsRequest({ op: 'journal', since: 1.5 })).toBeNull()
    expect(parseExtensionsRequest({ op: 'journal', since: '1' })).toBeNull()
  })
})

describe('the request to take a granted permission back', () => {
  it('names a profile, an extension and one short visible name, and nothing else', () => {
    const ask = (over: Record<string, unknown>) => parseExtensionsRequest({ op: 'revoke-granted', profileId: 'default', extensionId: A, name: 'history', ...over })
    expect(ask({})).toEqual({ op: 'revoke-granted', profileId: 'default', extensionId: A, name: 'history' })
    expect(ask({ name: '' })).toBeNull()
    expect(ask({ name: 7 })).toBeNull()
    expect(ask({ name: ['history'] })).toBeNull()
    expect(ask({ name: 'x'.repeat(301) })).toBeNull()
    expect(ask({ name: 'his\u202Etory' })).toBeNull()
    expect(ask({ extensionId: 'nope' })).toBeNull()
    expect(ask({ profileId: 7 })).toBeNull()
    expect(ask({ extra: true })).toBeNull()
    expect(parseExtensionsRequest({ op: 'revoke-granted', extensionId: A, name: 'history' })).toBeNull()
  })
})

describe('where the page opens', () => {
  it('writes the path and the query of each view, and reads them back', () => {
    expect(extensionsPath({ view: 'list' })).toBe('/')
    expect(extensionsPath({ view: 'shortcuts' })).toBe('/shortcuts')
    expect(extensionsPath({ view: 'detail', extensionId: A, profileId: 'work' })).toBe(`/?id=${A}&profile=work`)
    expect(extensionsPath({ view: 'detail', extensionId: A })).toBe(`/?id=${A}`)
    expect(parseExtensionsLocation('/', '')).toEqual({ view: 'list' })
    expect(parseExtensionsLocation('/shortcuts', '')).toEqual({ view: 'shortcuts' })
    expect(parseExtensionsLocation('/', `?id=${A}&profile=work`)).toEqual({ view: 'detail', extensionId: A, profileId: 'work' })
    expect(parseExtensionsLocation('/', `?id=${A}`)).toEqual({ view: 'detail', extensionId: A })
  })

  it('shows the list for an id or a profile that is not one', () => {
    expect(parseExtensionsLocation('/', '?id=nope')).toEqual({ view: 'list' })
    expect(parseExtensionsLocation('/', `?id=${A}&profile=../x`)).toEqual({ view: 'detail', extensionId: A })
    expect(parseExtensionsLocation('/', '?id="><script>')).toEqual({ view: 'list' })
    expect(parseExtensionsLocation('/elsewhere', `?id=${A}`)).toEqual({ view: 'detail', extensionId: A })
  })

  it('makes the address a tab is opened at: an address of the page, which the page reads back as the same target', () => {
    const targets = [{ view: 'list' }, { view: 'shortcuts' }, { view: 'detail', extensionId: A }, { view: 'detail', extensionId: A, profileId: 'work' }] as const
    for (const target of targets) {
      const url = internalPageUrl(target)
      expect(isInternalPageUrl(url), url).toBe(true)
      const parts = internalPageParts(url)!
      expect(parseExtensionsLocation(parts.path, parts.search)).toEqual(target)
      // What the person sees and copies is read by the command bar as the same page.
      expect(extensionsPageOf(displayAddress(url))).toEqual(target)
    }
    expect(internalPageUrl()).toBe('lucium-ui://extensions/')
  })

  it('checks a target the interface sent, key by key', () => {
    expect(cleanExtensionsTarget({ view: 'list' })).toEqual({ view: 'list' })
    expect(cleanExtensionsTarget({ view: 'detail', extensionId: A, profileId: 'work' })).toEqual({ view: 'detail', extensionId: A, profileId: 'work' })
    for (const raw of [null, 'list', { view: 'other' }, { view: 'list', x: 1 }, { view: 'detail' }, { view: 'detail', extensionId: 'nope' }, { view: 'detail', extensionId: A, profileId: '../x' }, { view: 'detail', extensionId: A, extra: 1 }]) {
      expect(cleanExtensionsTarget(raw), JSON.stringify(raw)).toBeNull()
    }
  })
})

describe('the list', () => {
  it('counts one error for a message said twelve times, the way the card shows it', () => {
    const noise: JournalEntry[] = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, at: i, level: 'error', source: 'worker', extensionId: A, profileId: 'default', message: 'Receiving end does not exist', where: 'background.js' }))
    const other: JournalEntry = { id: 13, at: 13, level: 'error', source: 'worker', extensionId: A, profileId: 'default', message: 'another failure' }
    const [row] = extensionRows([info()], [detail()], [...noise, other], 'default')
    expect(row!.errors).toBe(2)
  })

  it('tells an extension switched off from one that did not load', () => {
    expect(extensionState(info())).toBe('enabled')
    expect(extensionState(info({ enabled: false }))).toBe('disabled')
    expect(extensionState(info({ enabled: false }), detail({ failure: 'Chromium refused it' }))).toBe('failed')
    expect(extensionState(info({ enabled: true }), detail({ failure: 'an old failure' }))).toBe('enabled')
  })

  it('draws the rows of one profile, with the errors the journal holds for that copy', () => {
    const journal: JournalEntry[] = [
      { id: 1, at: 1, level: 'error', source: 'worker', extensionId: A, profileId: 'default', message: 'x' },
      { id: 2, at: 1, level: 'error', source: 'worker', extensionId: A, profileId: 'work', message: 'other profile' },
      { id: 3, at: 1, level: 'warning', source: 'page', extensionId: A, profileId: 'default', message: 'y' },
      { id: 4, at: 1, level: 'info', source: 'worker', extensionId: A, profileId: 'default', message: 'z' }
    ]
    const rows = extensionRows([info(), info({ profileId: 'work' }), info({ id: B, name: 'Beta', enabled: false })], [detail()], journal, 'default')
    expect(rows.map((r) => [r.info.name, r.state, r.errors, r.warnings])).toEqual([
      ['Alpha', 'enabled', 1, 1],
      ['Beta', 'disabled', 0, 0]
    ])
    expect(rows[0]!.detail?.path).toBe('/x')
  })

  it('sorts by name without regard to accents or case, then by id, and leaves its argument alone', () => {
    const rows = [{ info: info({ name: 'zèbre', id: B }) }, { info: info({ name: 'Éclair', id: A }) }, { info: info({ name: 'alpha', id: B }) }, { info: info({ name: 'Alpha', id: A }) }]
    const sorted = sortRows(rows)
    expect(sorted.map((r) => `${r.info.name}/${r.info.id[0]}`)).toEqual(['Alpha/a', 'alpha/b', 'Éclair/a', 'zèbre/b'])
    expect(rows[0]!.info.name).toBe('zèbre')
  })

  it('filters by every word, in the name, the id or the description', () => {
    const rows = [
      { info: info({ name: 'Dark Reader' }), detail: { facts: { description: 'Dark mode for every website' } } },
      { info: info({ name: 'uBlock', id: B }), detail: { facts: { description: 'Blocks ads' } } },
      { info: info({ name: 'Bare' }) }
    ]
    expect(filterRows(rows, '')).toHaveLength(3)
    expect(filterRows(rows, '  ')).toHaveLength(3)
    expect(filterRows(rows, 'dark').map((r) => r.info.name)).toEqual(['Dark Reader'])
    expect(filterRows(rows, 'MODE website').map((r) => r.info.name)).toEqual(['Dark Reader'])
    expect(filterRows(rows, 'bbbb').map((r) => r.info.name)).toEqual(['uBlock'])
    expect(filterRows(rows, 'dark ads')).toEqual([])
    expect(filterRows(rows, 'ÉCRAN')).toEqual([])
  })

  it('lists the profiles that have an extension, the default first, and keeps a choice that still holds', () => {
    const infos = [info({ profileId: 'work' }), info({ profileId: 'default' }), info({ profileId: 'alpha' })]
    expect(listedProfiles(infos)).toEqual(['default', 'alpha', 'work'])
    expect(listedProfiles(infos, 'work')).toEqual(['work', 'default', 'alpha'])
    expect(profileToShow(infos, 'work')).toBe('work')
    expect(profileToShow(infos, 'gone')).toBe('default')
    expect(profileToShow(infos, undefined, 'alpha')).toBe('alpha')
    expect(profileToShow([], undefined)).toBeUndefined()
  })

  it('opens the page of an extension in the profile the address names, else the default one, else the first that has it', () => {
    const infos = [info({ profileId: 'work' }), info({ profileId: 'default' }), info({ profileId: 'play' })]
    expect(copyToShow(infos, A, 'play')?.profileId).toBe('play')
    expect(copyToShow(infos, A)?.profileId).toBe('default')
    expect(copyToShow([info({ profileId: 'work' })], A)?.profileId).toBe('work')
    expect(copyToShow(infos, B)).toBeUndefined()
  })
})

describe('what a manifest says', () => {
  const manifest = {
    manifest_version: 3,
    name: 'X',
    version: '1.0',
    description: '  A\u0000 tool  ',
    homepage_url: 'https://example.com/x',
    options_page: 'options.html',
    background: { service_worker: 'sw.js' },
    side_panel: { default_path: 'panel.html' },
    permissions: ['storage', 'history', 'bookmarks', 'tabs'],
    host_permissions: ['https://*.example.com/*'],
    optional_permissions: ['cookies']
  }

  describe('blocking from the code of an extension, whose answers are applied for a Manifest V2 extension only', () => {
    it('finds it in the permission that lets a listener of chrome.webRequest answer', () => {
      expect(declaresRequestBlocking({ manifest_version: 2, permissions: ['webRequest', 'webRequestBlocking', '<all_urls>'] })).toBe(true)
    })

    it('finds none in an extension with declarative rules, which are applied, nor in a permission it is never granted', () => {
      expect(declaresRequestBlocking(manifest)).toBe(false)
      expect(declaresRequestBlocking({ manifest_version: 3, permissions: ['declarativeNetRequest', 'declarativeNetRequestWithHostAccess', 'declarativeNetRequestFeedback', 'webRequest'], declarative_net_request: { rule_resources: [{ id: 'default', enabled: true, path: 'rules.json' }] } })).toBe(false)
      // The optional permissions are never granted here: an extension that only could ask blocks nothing.
      expect(declaresRequestBlocking({ manifest_version: 2, optional_permissions: ['webRequestBlocking'] })).toBe(false)
      // A site named like the permission is not the permission.
      expect(declaresRequestBlocking({ manifest_version: 3, host_permissions: ['https://webRequestBlocking.example/*'] })).toBe(false)
    })

    it('reads a manifest that is not what it should be without failing', () => {
      for (const raw of [null, 'text', 7, [], {}, { permissions: 'webRequestBlocking' }, { permissions: [7, null, {}] }]) expect(declaresRequestBlocking(raw), JSON.stringify(raw)).toBe(false)
    })

    it('reaches the facts of the page, and the warning is written only for an extension that asks to block this way', () => {
      expect(describeManifest(manifest).requestBlocking).toBe(false)
      expect(requestBlockingLine(describeManifest(manifest))).toBeNull()
      expect(requestBlockingLine(null)).toBeNull()
      expect(requestBlockingLine(describeManifest({ ...manifest, permissions: ['declarativeNetRequest', 'storage'] }))).toBeNull()
      const blocker = describeManifest({ ...manifest, permissions: ['webRequest', 'webRequestBlocking'] })
      expect(blocker.requestBlocking).toBe(true)
      setLanguage('fr')
      expect(requestBlockingLine(blocker)).toBe(frenchSpaces('Cette extension demande à bloquer ou à modifier des requêtes depuis son code (« webRequestBlocking »), ce que seule une extension Manifest V2 peut faire. Lucium lui signale les requêtes, mais n’applique pas ce qu’elle répond : ce filtrage-là n’a aucun effet sur les pages. Ses règles déclaratives, si elle en a, s’appliquent.'))
      setLanguage('en')
      expect(requestBlockingLine(blocker)).toBe('This extension asks to block or change requests from its code (“webRequestBlocking”), which only a Manifest V2 extension may do. Lucium tells it about the requests but does not apply what it answers: that filtering has no effect on the pages. Its declarative rules, if it has any, do apply.')
      setLanguage('fr')
    })

    it('tells an extension with a service worker from one made of pages only, and agrees with the facts of the page', () => {
      expect(declaresServiceWorker({ manifest_version: 3, background: { service_worker: 'background.js' } })).toBe(true)
      expect(describeManifest({ ...manifest, background: { service_worker: 'background.js' } }).hasWorker).toBe(true)
      // A popup alone, a Manifest V2 background page or script: nothing a worker could be started from.
      for (const raw of [null, 'text', 7, [], {}, { background: null }, { background: {} }, { background: { page: 'bg.html' } }, { background: { scripts: ['bg.js'] } }, { background: { service_worker: 7 } }]) {
        expect(declaresServiceWorker(raw), JSON.stringify(raw)).toBe(false)
        expect(describeManifest(raw).hasWorker, JSON.stringify(raw)).toBe(false)
      }
    })

    it('warns of the old format on a Manifest V2 extension, in a sentence of its own, and of no other', () => {
      const legacy = describeManifest({ manifest_version: 2, name: 'Classic', version: '1', permissions: ['storage'] })
      expect(legacy.manifestVersion).toBe(2)
      setLanguage('fr')
      expect(legacyManifestLine(legacy)).toBe(frenchSpaces('Cette extension est au format Manifest V2, un format ancien : Lucium la charge, mais certaines de ses fonctions peuvent manquer ou ne pas marcher comme prévu.'))
      setLanguage('en')
      expect(legacyManifestLine(legacy)).toBe('This extension uses Manifest V2, an old format: Lucium loads it, but some of its features may be missing or may not work as expected.')
      setLanguage('fr')
      // A Manifest V3 extension, a manifest that could not be read and one that says nothing of its version have none.
      expect(legacyManifestLine(describeManifest(manifest))).toBeNull()
      expect(legacyManifestLine(describeManifest({ name: 'X', version: '1' }))).toBeNull()
      expect(legacyManifestLine(null)).toBeNull()
      expect(legacyManifestLine(undefined)).toBeNull()
      // The warning of an extension that blocks by its code is another sentence: a Manifest V2 one has the first only.
      expect(requestBlockingLine(legacy)).toBeNull()
    })

    it('says nothing of a Manifest V2 extension that blocks this way: what its listeners answer is applied', () => {
      const classic = describeManifest({ manifest_version: 2, name: 'Classic', version: '1', permissions: ['webRequest', 'webRequestBlocking', '<all_urls>'] })
      expect(classic.requestBlocking).toBe(false)
      expect(requestBlockingLine(classic)).toBeNull()
    })
  })

  it('reads the description, the options page, the worker, the panel and the APIs of the data', () => {
    const facts = describeManifest(manifest)
    expect(facts.description).toBe('A tool')
    expect(facts.homepage).toBe('https://example.com/x')
    expect(facts.optionsPage).toBe('options.html')
    expect(facts.hasWorker).toBe(true)
    expect(facts.sidePanel).toBe(true)
    expect(facts.dataApis).toEqual(['history', 'bookmarks'])
    expect(facts.manifestVersion).toBe(3)
    expect(facts.optionalCount).toBe(1)
    expect(facts.sites.scope).toBe('specific')
    expect(facts.permissions.map((p) => p.id)).toContain('tabs')
    expect(facts.broad).toBe(true)
  })

  it('takes a page of options that leaves the extension, or a home page that is not a web address, for none', () => {
    for (const page of ['../../etc/passwd', 'https://evil.example/', '/abs/../x.html', 'a\u0000b.html', 'javascript:alert(1)', '']) {
      expect(describeManifest({ ...manifest, options_page: page }).optionsPage, page).toBeUndefined()
    }
    expect(describeManifest({ ...manifest, options_ui: { page: 'ui/o.html' }, options_page: undefined }).optionsPage).toBe('ui/o.html')
    expect(describeManifest({ ...manifest, homepage_url: 'javascript:alert(1)' }).homepage).toBeUndefined()
  })

  it('does not fail on a manifest that is not one', () => {
    for (const raw of [null, 'text', 7, [], {}]) expect(describeManifest(raw).permissions).toEqual([])
    expect(describeManifest(null).hasWorker).toBe(false)
  })

  it('keeps a path inside the extension only', () => {
    expect(insidePath('./a/b.html')).toBe('a/b.html')
    expect(insidePath('a\\b')).toBe('a\\b')
    for (const bad of ['..', 'a/../b', '/etc/passwd/..', 'http://x', 'file:///x', '', 7, 'a\u0001']) expect(insidePath(bad), String(bad)).toBeUndefined()
  })

  it('says what the history and bookmarks access comes to, by the setting', () => {
    expect(dataAccessLine([], true)).toBeNull()
    expect(dataAccessLine(['history', 'bookmarks'], true)).toContain('lecture seule')
    expect(dataAccessLine(['history'], false)).toContain('Refusé')
  })
})

describe('the first look at a folder', () => {
  const ok = JSON.stringify({ manifest_version: 3, name: 'X', version: '1.2.3', background: { service_worker: 'sw.js' } })

  it('accepts a Manifest V3 with a name and a version, with or without a BOM', () => {
    expect(checkManifestText(ok).ok).toBe(true)
    expect(checkManifestText(`\uFEFF${ok}`).ok).toBe(true)
  })

  it('accepts a Manifest V2 folder as Settings loads one, and keeps for it every other check', () => {
    const legacy = (over: Record<string, unknown> = {}) => JSON.stringify({ manifest_version: 2, name: 'Old', version: '1.2', background: { scripts: ['bg.js'] }, ...over })
    const checked = checkManifestText(legacy())
    expect(checked.ok).toBe(true)
    expect(checked.ok && isLegacyManifest(checked.manifest)).toBe(true)
    expect(checkManifestText(`\uFEFF${legacy()}`).ok).toBe(true)
    // Past the first look nothing is relaxed: the name, the version and the bound of the review are asked of a Manifest V2 as of a Manifest V3.
    expect(checkManifestText(legacy({ name: ' ' })).ok).toBe(false)
    expect(checkManifestText(legacy({ version: 'one' })).ok).toBe(false)
    expect(checkManifestText(legacy({ permissions: Array.from({ length: 513 }, (_v, i) => `https://site${i}.example/*`) }))).toEqual({ ok: false, message: manifestTooLongMessage() })
    expect(checkManifestText(legacy({ permissions: Array.from({ length: 512 }, (_v, i) => `https://site${i}.example/*`) })).ok).toBe(true)
  })

  it('takes the Manifest V2 folder the engine checks load for real (compat/mv2-blocking-probe), and finds the file it names', () => {
    const folder = fileURLToPath(new URL('../../compat/mv2-blocking-probe/', import.meta.url))
    const checked = checkManifestText(readFileSync(`${folder}manifest.json`, 'utf8'))
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(describeManifest(checked.manifest).manifestVersion).toBe(2)
    expect(filesNamedBy(checked.manifest)).toEqual(['background.js'])
    expect(existsSync(`${folder}background.js`)).toBe(true)
  })

  it('tells a Manifest V2 folder that was just loaded about its format in the same notice, and says only that it is loaded for the others', () => {
    expect(doneMessages.loaded('Old', true)).toBe(frenchSpaces('« Old » est chargée. Cette extension est au format Manifest V2, un format ancien : Lucium la charge, mais certaines de ses fonctions peuvent manquer ou ne pas marcher comme prévu.'))
    expect(doneMessages.loaded('New', false)).toBe(frenchSpaces('« New » est chargée.'))
    expect(doneMessages.loaded('New')).toBe(doneMessages.loaded('New', false))
  })

  it('refuses any other manifest_version, and says that 2 and 3 are the ones accepted', () => {
    for (const version of [1, 4, 0, '2', '3', 2.5, null, true]) {
      const checked = checkManifestText(JSON.stringify({ manifest_version: version, name: 'X', version: '1' }))
      expect(checked, String(version)).toEqual({ ok: false, message: frenchSpaces('manifest.json : « manifest_version » doit valoir 2 ou 3.') })
    }
    // Missing altogether: the same sentence.
    expect(checkManifestText(JSON.stringify({ name: 'X', version: '1' })).ok).toBe(false)
    setLanguage('en')
    expect(checkManifestText(JSON.stringify({ manifest_version: 4, name: 'X', version: '1' }))).toEqual({ ok: false, message: 'manifest.json: “manifest_version” must be 2 or 3.' })
    setLanguage('fr')
  })

  it('says in a sentence what is wrong, naming the field', () => {
    const message = (text: string): string => {
      const checked = checkManifestText(text)
      if (checked.ok) throw new Error('accepted')
      return checked.message
    }
    expect(message('{ "manifest_version": 3, ')).toMatch(/pas du JSON valide/)
    expect(message('[1]')).toMatch(/objet JSON/)
    expect(message('{"manifest_version":4,"name":"X","version":"1"}')).toMatch(/manifest_version.*2 ou 3/)
    expect(message('{"manifest_version":3,"name":" ","version":"1"}')).toMatch(/«\u00a0name\u00a0»/)
    expect(message('{"manifest_version":3,"name":"X"}')).toMatch(/«\u00a0version\u00a0»/)
    expect(message('{"manifest_version":3,"name":"X","version":"one"}')).toMatch(/«\u00a0version\u00a0»/)
  })

  it('refuses a manifest that lists more than the review reads, like a package of the Web Store, and says the bound', () => {
    const many = (count: number) => Array.from({ length: count }, (_v, i) => `https://site${i}.example/*`)
    const withHosts = (count: number) => JSON.stringify({ manifest_version: 3, name: 'X', version: '1.0', host_permissions: many(count) })
    expect(checkManifestText(withHosts(512)).ok).toBe(true)
    const refused = checkManifestText(withHosts(513))
    expect(refused).toEqual({ ok: false, message: frenchSpaces('manifest.json liste trop d’autorisations ou de sites (plus de 512 dans une liste) : Lucium ne pourrait pas tout vous montrer, l’extension n’est donc pas chargée.') })
    // The pages of all the content scripts together count too: the engine would inject into every one of them.
    const scripts = JSON.stringify({ manifest_version: 3, name: 'X', version: '1.0', content_scripts: [{ matches: many(300), js: ['a.js'] }, { matches: many(300), js: ['a.js'] }] })
    expect(checkManifestText(scripts).ok).toBe(false)
  })

  it('lists the files the manifest names, once each, inside the folder', () => {
    const named = filesNamedBy({
      background: { service_worker: 'sw.js' },
      content_scripts: [{ js: ['a.js', 'sw.js'], css: ['a.css'] }, 'junk', { js: [7] }],
      action: { default_popup: 'popup.html' },
      options_ui: { page: 'o.html' },
      options_page: 'o.html',
      side_panel: { default_path: 'p.html' }
    })
    expect(named.sort()).toEqual(['a.css', 'a.js', 'o.html', 'p.html', 'popup.html', 'sw.js'])
    expect(filesNamedBy({ background: { service_worker: '../outside.js' } })).toEqual([])
    expect(filesNamedBy({})).toEqual([])
  })

  it('lists the entry points of a Manifest V2 as well: its background scripts or page, the popup of its browser action or page action', () => {
    const named = filesNamedBy({
      manifest_version: 2,
      background: { scripts: ['bg.js', 'lib.js', 7, '../outside.js'], page: 'bg.html' },
      browser_action: { default_popup: 'popup.html' },
      page_action: { default_popup: 'page-popup.html' },
      content_scripts: [{ js: ['content.js'] }],
      options_ui: { page: 'o.html' }
    })
    expect(named.sort()).toEqual(['bg.html', 'bg.js', 'content.js', 'lib.js', 'o.html', 'page-popup.html', 'popup.html'])
    // Not read by a Manifest V3: the engine never starts those, and a manifest written for two browsers may list files this one does not ship.
    expect(filesNamedBy({ manifest_version: 3, background: { service_worker: 'sw.js', scripts: ['firefox.js'] }, browser_action: { default_popup: 'old.html' } })).toEqual(['sw.js'])
    expect(filesNamedBy({ manifest_version: 2, background: 'bg.js', browser_action: 'popup.html', page_action: null })).toEqual([])
  })
})

describe('what Chromium said when a folder would not load', () => {
  it('puts the usual refusals in words, and keeps the folder out of the sentence', () => {
    expect(describeLoadError(new Error('Manifest file is missing or unreadable'), '/x')).toMatch(/manifest\.json/)
    expect(describeLoadError(new Error('Loading of extension /work/my-ext failed: Manifest version 2 is deprecated'), '/work/my-ext')).toMatch(/Manifest V2/)
    expect(describeLoadError(new Error('Extension already loaded'))).toMatch(/déjà chargée/)
    expect(describeLoadError(new Error('Extension directory not found: /work/gone'), '/work/gone')).toBe(frenchSpaces('Le dossier n’existe plus à cet endroit.'))
    expect(describeLoadError(new Error('Loading extension at /work/my ext failed with: Invalid value for \'content_scripts[0].matches[0]\': Missing scheme separator.'), '/work/my ext')).toBe(frenchSpaces('Le moteur a refusé l’extension : Invalid value for \'content_scripts[0].matches[0]\': Missing scheme separator.'))
    expect(describeLoadError(new Error('Loading extension at /w failed with: Manifest is not valid JSON.  EOF while parsing an object at line 2 column 0'), '/w')).toBe(frenchSpaces('manifest.json n’est pas du JSON valide : EOF while parsing an object at line 2 column 0'))
    expect(describeLoadError(new Error('Invalid value for content_scripts[0].matches at /work/my-ext/manifest.json'), '/work/my-ext')).toBe(frenchSpaces('Le moteur a refusé l’extension : Invalid value for content_scripts[0].matches at /manifest.json'))
  })

  it('says a refusal of Lucium itself as it is, without putting it in the mouth of the engine', () => {
    expect(describeLoadError(new ManifestRefusal(manifestTooLongMessage()), '/work/my-ext')).toBe(manifestTooLongMessage())
    expect(manifestTooLongMessage()).toContain('512')
  })

  it('says it when Chromium said nothing, and cleans what it did say', () => {
    expect(describeLoadError(undefined)).toMatch(/sans dire pourquoi/)
    expect(describeLoadError('weird\u0000text')).toBe(frenchSpaces('Le moteur a refusé l’extension : weird text'))
  })
})

describe('the journal of the cards', () => {
  const entry = (id: number, over: Partial<JournalEntry> = {}): JournalEntry => ({ id, at: id, level: 'info', source: 'worker', message: `m${id}`, ...over })
  const journal = [
    entry(1, { extensionId: A, profileId: 'default' }),
    entry(2, { extensionId: A, profileId: 'work' }),
    entry(3, { extensionId: B, profileId: 'default' }),
    entry(4, { source: 'load', level: 'error', where: '/folder' }),
    entry(5, { extensionId: 'c'.repeat(32), profileId: 'default' })
  ]

  it('gives a card the messages of its extension in its profile', () => {
    expect(journalOf(journal, { id: A, profileId: 'default' }).map((e) => e.id)).toEqual([1])
    expect(journalOf(journal, { id: A, profileId: 'work' }).map((e) => e.id)).toEqual([2])
  })

  it('leaves for the foot of the list what no card shows: a folder that did not load, an extension that is not listed', () => {
    expect(unlistedJournal(journal, [info({ id: A }), info({ id: B })], 'default').map((e) => e.id)).toEqual([4, 5])
    // The search hides a card, not its messages: the caller passes every extension of the profile, so nothing moves down.
    expect(unlistedJournal(journal, [info({ id: A }), info({ id: B }), info({ id: 'c'.repeat(32) })], 'default').map((e) => e.id)).toEqual([4])
  })

  it('"Effacer" at the foot of the list takes away the lines shown there and leaves the journal of every card, in this profile and in the others', () => {
    const shown = unlistedJournal(journal, [info({ id: A }), info({ id: B })], 'default')
    const kept = keptAfterClear(journal, shown.map((e) => e.id))
    expect(kept.map((e) => e.id)).toEqual(journal.map((e) => e.id).filter((id) => id !== 4 && id !== 5))
    expect(journalOf(kept, { id: A, profileId: 'default' }).map((e) => e.id)).toEqual([1])
    expect(journalOf(kept, { id: A, profileId: 'work' }).map((e) => e.id)).toEqual([2])
  })
})

describe('developer mode of the page', () => {
  const store = (initial: string | null) => {
    const kept = new Map<string, string>(initial === null ? [] : [[DEVELOPER_MODE_KEY, initial]])
    return { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value), kept }
  }

  it('is on until the person switches it off (the page showed every tool before the switch), and remembers the choice', () => {
    expect(readDeveloperMode(() => store(null))).toBe(true)
    const kept = store(null)
    expect(writeDeveloperMode(false, () => kept)).toBe(true)
    expect(readDeveloperMode(() => kept)).toBe(false)
    expect(writeDeveloperMode(true, () => kept)).toBe(true)
    expect(readDeveloperMode(() => kept)).toBe(true)
  })

  it('shows the tools when the storage cannot be read, and says so in the log; a choice that cannot be kept is reported, not thrown', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const broken = () => {
      throw new Error('no storage')
    }
    expect(readDeveloperMode(broken)).toBe(true)
    expect(writeDeveloperMode(false, broken)).toBe(false)
    expect(debug).toHaveBeenCalledTimes(2)
    debug.mockRestore()
  })
})
