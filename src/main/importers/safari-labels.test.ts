// The labels of the Safari import preview come from the catalogue, in the language of the application (not a French string in the code).
import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { parsePlist } from '@shared/plist'
import type { Ctx } from '@shared/sidebar'
import { convertSafariBookmarks } from './safari'

const ctx = (): Ctx => {
  let n = 0
  return { now: 9, newId: () => `s${++n}` }
}

const leaf = (title: string, url: string) => `<dict><key>URIDictionary</key><dict><key>title</key><string>${title}</string></dict><key>URLString</key><string>${url}</string><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string></dict>`
const list = (title: string, children: string) => `<dict><key>Children</key><array>${children}</array><key>Title</key><string>${title}</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string></dict>`
const fixture = parsePlist(
  `<?xml version="1.0"?><plist version="1.0"><dict><key>Children</key><array>${list('BookmarksMenu', leaf('Menu', 'https://menu.example/'))}${list('com.apple.ReadingList', leaf('Later', 'https://read.example/'))}</array><key>WebBookmarkType</key><string>WebBookmarkTypeList</string></dict></plist>`
)

/** The names of the folders the import makes, in order. */
const folderNames = (): string[] => convertSafariBookmarks(fixture, ctx()).folders.map((folder) => folder.name)

describe('the Safari import labels', () => {
  afterEach(() => setLanguage('fr'))

  it('are in English when the interface is in English', () => {
    setLanguage('en')
    expect(folderNames()).toEqual(['Bookmarks menu', 'Reading List'])
  })

  it('are in French when the interface is in French', () => {
    setLanguage('fr')
    expect(folderNames()).toEqual(['Menu des favoris', 'Liste de lecture'])
  })
})
