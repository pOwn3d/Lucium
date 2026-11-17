import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createInitialState, type Action, type Ctx } from '@shared/sidebar'
import { importFolderOf } from '../shell/menu-actions'
import { ImportService, type ImportDeps } from './service'

// The import on a system other than macOS, played on this machine: a pretend Linux home with the folders its browsers use. What a real Linux
// holds was not looked at (docs/plateformes.md); this holds the part that can be: where the service looks, and what it offers.
const root = mkdtempSync(join(tmpdir(), 'lucium-import-linux-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const put = (relative: string, content: string) => {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
const bookmarks = (url: string) => JSON.stringify({ roots: { bookmark_bar: { type: 'folder', name: 'Barre', children: [{ type: 'url', name: 'Signet', url }] } } })

put('.config/google-chrome/Local State', JSON.stringify({ profile: { info_cache: { Default: { name: 'Perso' } } } }))
put('.config/google-chrome/Default/Bookmarks', bookmarks('https://chrome-linux.example/'))
put('custom-config/BraveSoftware/Brave-Browser/Default/Bookmarks', bookmarks('https://brave-xdg.example/'))
// The macOS layout is also there: a Linux service must not look at it.
put('Library/Application Support/Vivaldi/Default/Bookmarks', bookmarks('https://vivaldi-mac.example/'))
put('Library/Application Support/Arc/StorableSidebar.json', JSON.stringify({ sidebar: { containers: [{ spaces: [], items: [] }] } }))

const WHEN = Date.UTC(2026, 3, 2, 10, 0, 0)
const dispatched: Action[] = []
const service = (extra: Partial<ImportDeps> = {}) => {
  let n = 0
  const ctx: Ctx = { now: WHEN, newId: () => `i${++n}` }
  return new ImportService({
    home: root,
    ctx: () => ctx,
    dispatch: (action) => dispatched.push(action),
    state: () => createInitialState(ctx),
    mergeHistory: (entries) => entries.length,
    chooseFile: async () => null,
    ...extra
  })
}

describe('the import on Linux', () => {
  it('looks in ~/.config, offers Chrome with its profile and the bookmarks file, and offers neither Safari nor Arc', () => {
    const sources = service({ platform: 'linux' }).listSources()
    // "Autre navigateur" (the user picks the file) is offered everywhere.
    expect(sources.map((s) => s.id)).toEqual(['chrome', 'html', 'other'])
    expect(sources[0]!.profiles).toEqual([{ id: 'Default', name: 'Perso' }])
  })

  it('follows XDG_CONFIG_HOME', () => {
    const sources = service({ platform: 'linux', paths: { xdgConfigHome: join(root, 'custom-config') } }).listSources()
    expect(sources.map((s) => s.id)).toEqual(['brave', 'html', 'other'])
  })

  it('imports the bookmarks of the Linux folder', async () => {
    const report = await service({ platform: 'linux' }).run({ source: 'chrome', categories: ['bookmarks'] })
    expect(report.ok).toBe(true)
    expect(report.bookmarks).toBe(1)
    expect(dispatched.length).toBeGreaterThan(0)
  })

  it('refuses a source the system does not have, even when asked for by name', async () => {
    // The Arc file of the pretend home exists: without the system's refusal it would be read.
    const report = await service({ platform: 'linux' }).run({ source: 'arc', categories: ['sidebar'] })
    expect(report.ok).toBe(false)
    expect(report.message).toBe('Ce navigateur n’est pas pris en charge.')
    expect((await service({ platform: 'win32' }).run({ source: 'safari', categories: ['bookmarks'] })).message).toBe('Ce navigateur n’est pas pris en charge.')
  })

  it('finds a Firefox installed as a snap, in its own folder, when the ordinary one is missing', () => {
    // A second pretend home: only the snap folder of Firefox exists in it.
    const snapHome = mkdtempSync(join(tmpdir(), 'lucium-import-snap-'))
    try {
      const profile = join(snapHome, 'snap/firefox/common/.mozilla/firefox/abc123.default')
      mkdirSync(profile, { recursive: true })
      writeFileSync(join(profile, 'places.sqlite'), '')
      const sources = service({ platform: 'linux', home: snapHome }).listSources()
      expect(sources.map((s) => s.id)).toContain('firefox')
      expect(sources.find((s) => s.id === 'firefox')!.profiles).toEqual([{ id: 'abc123.default', name: 'default' }])
    } finally {
      rmSync(snapHome, { recursive: true, force: true })
    }
  })

  it('still looks in Application Support when no platform is given, as it always did', () => {
    expect(service().listSources().map((s) => s.id)).toEqual(expect.arrayContaining(['vivaldi', 'arc', 'safari']))
  })
})

describe('the folder the file chooser opens in', () => {
  it('is the data folder of the browser on each system, or the home folder when the system does not know it', () => {
    expect(importFolderOf('chrome', '/Users/u')).toBe('/Users/u/Library/Application Support/Google/Chrome')
    expect(importFolderOf('chrome', '/home/u', 'linux', {})).toBe('/home/u/.config/google-chrome')
    expect(importFolderOf('chrome', 'C:\\Users\\u', 'win32', { localAppData: 'C:\\Users\\u\\AppData\\Local' })).toBe('C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data')
    expect(importFolderOf('arc', '/home/u', 'linux')).toBe('/home/u')
    expect(importFolderOf('safari', '/Users/u')).toBe('/Users/u/Library/Safari')
    expect(importFolderOf('html', '/home/u', 'linux')).toBe(join('/home/u', 'Downloads'))
  })
})
