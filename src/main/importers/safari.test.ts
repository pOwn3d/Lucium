import { describe, expect, it } from 'vitest'
import { parsePlist } from '@shared/plist'
import type { Ctx } from '@shared/sidebar'
import { convertSafariBookmarks } from './safari'

const ctx = (): Ctx => {
  let n = 0
  return { now: 9, newId: () => `s${++n}` }
}

// The shape of Safari's Bookmarks.plist after `plutil -convert xml1`.
const leaf = (title: string, url: string) => `<dict><key>URIDictionary</key><dict><key>title</key><string>${title}</string></dict><key>URLString</key><string>${url}</string><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string></dict>`
const list = (title: string, children: string) => `<dict><key>Children</key><array>${children}</array><key>Title</key><string>${title}</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string></dict>`
const proxy = '<dict><key>Title</key><string>History</string><key>WebBookmarkType</key><string>WebBookmarkTypeProxy</string></dict>'
const plist = (children: string) => parsePlist(`<?xml version="1.0"?><plist version="1.0"><dict><key>Children</key><array>${children}</array><key>WebBookmarkType</key><string>WebBookmarkTypeList</string></dict></plist>`)

const fixture = plist(
  proxy +
    list('BookmarksBar', leaf('Barre', 'https://bar.example/') + list('Outils', leaf('Deep', 'https://deep.example/') + list('Plus', leaf('Deeper', 'https://deeper.example/')))) +
    list('BookmarksMenu', leaf('Menu', 'https://menu.example/') + leaf('Script', 'javascript:alert(1)')) +
    list('com.apple.ReadingList', leaf('À lire', 'https://read.example/')) +
    list('Vide', '')
)

describe('convertSafariBookmarks', () => {
  const result = convertSafariBookmarks(fixture, ctx())

  it('puts the Favorites bar at the root and the other lists in folders of their own, nested folders staying nested', () => {
    expect(result.spaces).toMatchObject([{ name: 'Navigateur de macOS', profileId: 'default' }])
    expect(result.tabs.find((t) => t.url === 'https://bar.example/')?.folderId).toBeUndefined()
    const names = result.folders.map((f) => [f.name, result.folders.find((p) => p.id === f.parentId)?.name ?? null])
    expect(names).toEqual([['Outils', null], ['Plus', 'Outils'], ['Menu des favoris', null], ['Liste de lecture', null]])
  })

  it('keeps web bookmarks only, and counts the others', () => {
    expect(result.tabs.map((t) => t.url)).toEqual(['https://bar.example/', 'https://deep.example/', 'https://deeper.example/', 'https://menu.example/', 'https://read.example/'])
    expect(result.report).toEqual({ tabs: 5, folders: 4, skipped: 1, overLimit: 0 })
  })

  it('does not import the proxies (History, Top Sites) or an empty list as folders', () => {
    expect(result.folders.some((f) => f.name === 'History' || f.name === 'Vide')).toBe(false)
  })

  it('does not take for bookmarks what a proxy carries, even in a file that gives a proxy children', () => {
    const odd = plist(`<dict><key>Children</key><array>${leaf('Intrus', 'https://intrus.example/')}</array><key>Title</key><string>History</string><key>WebBookmarkType</key><string>WebBookmarkTypeProxy</string></dict>${list('BookmarksBar', leaf('Barre', 'https://bar.example/'))}`)
    expect(convertSafariBookmarks(odd, ctx()).tabs.map((t) => t.url)).toEqual(['https://bar.example/'])
  })

  it('returns an empty import for anything that is not a bookmarks file', () => {
    for (const bad of [null, 'x', {}, { Children: 'no' }, [], plist('')]) expect(convertSafariBookmarks(bad, ctx()).spaces, JSON.stringify(bad)).toEqual([])
  })
})

describe('convertSafariBookmarks on hostile input', () => {
  it('survives lists nested far deeper than the bound and keeps the top of them (the converter is given the parsed tree, whatever the parser accepted)', () => {
    let inner: unknown = { WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://fond.example/', URIDictionary: { title: 'au fond' } }
    for (let i = 0; i < 100_000; i++) inner = { WebBookmarkType: 'WebBookmarkTypeList', Title: `d${i}`, Children: [{ WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: `https://l${i}.example/`, URIDictionary: { title: `l${i}` } }, inner] }
    const result = convertSafariBookmarks({ Children: [{ WebBookmarkType: 'WebBookmarkTypeList', Title: 'BookmarksBar', Children: [inner] }] }, ctx())
    expect(result.tabs.length).toBeGreaterThan(20)
    expect(result.tabs.some((t) => t.url === 'https://fond.example/')).toBe(false)
    expect(result.report.skipped).toBeGreaterThan(0)
  })

  it('keeps a bookmark listed twice in one folder once', () => {
    const result = convertSafariBookmarks(plist(list('BookmarksBar', leaf('A', 'https://a.example/') + leaf('A', 'https://a.example/'))), ctx())
    expect(result.tabs).toHaveLength(1)
    expect(result.report.duplicates).toBe(1)
  })
})
