import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { Ctx } from '@shared/sidebar'
import { convertChromeBookmarks } from './chrome'
import { convertNetscapeBookmarks } from './netscape'
import { privateImportMessage } from './requests'
import { readChromiumHistory } from './sqlite'

// The sentences the import shows, read in the interface's language: the English ones come from the catalogue, the French ones are unchanged.
const dir = mkdtempSync(join(tmpdir(), 'lucium-import-messages-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (): Ctx => {
  let n = 0
  return { now: 5, newId: () => `m${++n}` }
}

const url = (name: string, href: string) => ({ type: 'url', name, url: href })
const folder = (name: string, children: unknown[]) => ({ type: 'folder', name, children })
const fixture = {
  roots: {
    bookmark_bar: { type: 'folder', name: 'Barre', children: [url('Loose', 'https://loose.example/'), folder('', [url('Nameless', 'https://nameless.example/')])] },
    other: { type: 'folder', name: 'Autres', children: [url('Other one', 'https://other.example/')] },
    synced: { type: 'folder', name: 'Mobile', children: [url('Phone', 'https://phone.example/')] }
  }
}

describe('the sentences of the import follow the language of the interface', () => {
  afterEach(() => setLanguage('fr'))

  describe('in English', () => {
    beforeEach(() => setLanguage('en'))

    it('says why a file cannot be read, in English', () => {
      expect(() => readChromiumHistory(dir)).toThrow('it is not an ordinary file.')
    })

    it('refuses the import in a private window, in English', () => {
      expect(privateImportMessage()).toBe('Import is not available in a private window.')
    })

    it('names the folders it had to name, and the other bookmarks, in English', () => {
      const names = convertChromeBookmarks(fixture, ctx()).folders.map((f) => f.name)
      expect(names).toEqual(['Folder', 'Other bookmarks', 'Mobile bookmarks'])
    })

    it('names the space of an HTML bookmarks file in English', () => {
      const html = '<DL><p>\n    <DT><A HREF="https://a.example/">A</A>\n</DL>'
      expect(convertNetscapeBookmarks(html, ctx()).spaces[0]?.name).toBe('Imported bookmarks')
    })
  })

  describe('in French', () => {
    it('keeps the French sentences and names', () => {
      expect(() => readChromiumHistory(dir)).toThrow('ce n’est pas un fichier ordinaire.')
      expect(privateImportMessage()).toBe('L’import n’est pas disponible dans une fenêtre privée.')
      expect(convertChromeBookmarks(fixture, ctx()).folders.map((f) => f.name)).toEqual(['Dossier', 'Autres favoris', 'Favoris mobiles'])
      const html = '<DL><p>\n    <DT><A HREF="https://a.example/">A</A>\n</DL>'
      expect(convertNetscapeBookmarks(html, ctx()).spaces[0]?.name).toBe('Signets importés')
    })
  })
})
