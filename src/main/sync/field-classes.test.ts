// The classes of the fields (docs/synchronisation.md §10.2) against the shared vectors and against the model of the Mac: a field the Mac renames or adds without a
// decision makes this fail.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultSettings } from '@shared/model'
import { LOCK_SETTING_KEYS } from '@shared/lock'
import { SYNCED_SETTING_KEYS } from '@shared/sidebar-sync'
import { ARCHIVE_PER_SPACE_SENT, FIELD_CLASSES, KINDS, NEVER_KINDS, SYNCED_SETTINGS, type EntityKind } from './field-classes'
import { ARCHIVE_PER_SPACE } from './limits'
import { messageVectors } from './sync-vectors.test-support'

const model = readFileSync(join(__dirname, '../../shared/model.ts'), 'utf8')
function membersOf(name: string): string[] {
  const start = model.indexOf(`export interface ${name} {`)
  expect(start, `interface ${name}`).toBeGreaterThan(-1)
  const end = model.indexOf('\n}', start)
  return [...model.slice(start, end).matchAll(/^ {2}([A-Za-z]\w*)\??:/gm)].map((m) => m[1] as string)
}
const MODEL_OF: Record<EntityKind, string> = { space: 'Space', folder: 'Folder', tab: 'TabItem', favorite: 'Favorite', archived: 'ArchivedTab' }

describe('the classes of the fields', () => {
  it.each(KINDS)('put every field of %s in model.ts in one class, and only one', (kind) => {
    const { synced, seed, local } = FIELD_CLASSES[kind]
    const classified = [...synced, ...seed, ...local]
    expect(new Set(classified).size, 'a field in two classes').toBe(classified.length)
    expect([...classified].sort()).toEqual([...membersOf(MODEL_OF[kind])].sort())
  })

  it('are the classes of the vectors the iPhone reads', () => {
    expect(Object.keys(FIELD_CLASSES).sort()).toEqual(Object.keys(messageVectors.fieldClasses).sort())
    for (const kind of KINDS) expect(FIELD_CLASSES[kind], kind).toEqual(messageVectors.fieldClasses[kind])
  })

  it('keep what is private to the device out of the synchronised class', () => {
    expect(FIELD_CLASSES.tab.local).toEqual(expect.arrayContaining(['private', 'lastActiveAt', 'faviconUrl', 'windowKey', 'container']))
    expect(FIELD_CLASSES.space.local).toEqual(expect.arrayContaining(['image', 'background', 'webPanels']))
    expect(FIELD_CLASSES.archived.local).toContain('history')
  })

  it('send the page a pinned tab is on once, as a seed: it is noise afterwards', () => {
    expect(FIELD_CLASSES.tab.seed).toEqual(['url', 'title'])
    expect(FIELD_CLASSES.folder.seed).toEqual(['collapsed'])
  })
})

describe('the closed list of settings', () => {
  it('is the list of the vectors, and of the reducer that writes it', () => {
    expect([...SYNCED_SETTINGS]).toEqual(messageVectors.settingsAllowed)
    expect([...SYNCED_SETTING_KEYS]).toEqual(messageVectors.settingsAllowed)
  })

  it('names settings that exist, never one of the never-list, and no lock setting', () => {
    const known = new Set(Object.keys(defaultSettings()))
    for (const key of SYNCED_SETTINGS) {
      expect(known.has(key), key).toBe(true)
      expect(messageVectors.settingsNever, key).not.toContain(key)
    }
    for (const key of LOCK_SETTING_KEYS) expect(SYNCED_SETTINGS as readonly string[], key).not.toContain(key)
    for (const key of ['proxy', 'proxyEnabled', 'dohCustomUrl', 'updateFeedUrl', 'customFilterLists', 'extensionPaths', 'ollamaConfig', 'passwordManager', 'boostsEnabled', 'userScripts']) expect(SYNCED_SETTINGS as readonly string[], key).not.toContain(key)
  })
})

describe('what never travels', () => {
  it('are the kinds of the vectors, and code and secrets are among them', () => {
    expect([...NEVER_KINDS]).toEqual(messageVectors.neverKinds)
    for (const kind of ['boost', 'userScript', 'extension', 'password', 'vault', 'lock']) expect(NEVER_KINDS).toContain(kind)
  })

  it('sends the same number of archived tabs per space as the protocol says', () => {
    expect(ARCHIVE_PER_SPACE_SENT).toBe(ARCHIVE_PER_SPACE)
    expect(ARCHIVE_PER_SPACE_SENT).toBe(500)
  })
})
