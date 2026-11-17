import { describe, expect, it } from 'vitest'
import type { Ctx } from '@shared/sidebar'
import { convertChromeBookmarks } from './chrome'

const ctx = (): Ctx => {
  let n = 0
  return { now: 5, newId: () => `new${++n}` }
}

const url = (name: string, href: string) => ({ type: 'url', name, url: href })
const folder = (name: string, children: unknown[]) => ({ type: 'folder', name, children })

const fixture = {
  roots: {
    bookmark_bar: {
      type: 'folder',
      name: 'Barre',
      children: [
        url('Loose', 'https://loose.example/'),
        folder('Docs', [url('MDN', 'https://mdn.example/'), folder('Sous-dossier', [url('Deep', 'https://deep.example/')])]),
        url('Script', 'javascript:alert(1)'),
        url('Extension', 'chrome-extension://abc/page.html')
      ]
    },
    other: { type: 'folder', name: 'Autres', children: [url('Other one', 'https://other.example/')] },
    synced: { type: 'folder', name: 'Mobile', children: [] }
  }
}

describe('convertChromeBookmarks', () => {
  const result = convertChromeBookmarks(fixture, ctx())

  it('makes one space with the bookmarks as pinned tabs anchored on their address', () => {
    // Without the name the sheet shows, the space takes the generic label: the importer writes no browser's name itself.
    expect(result.spaces).toMatchObject([{ name: 'Navigateur basé sur Chromium', profileId: 'default' }])
    expect(result.tabs.every((t) => t.pinned && t.anchorUrl === t.url && t.spaceId === result.spaces[0]!.id)).toBe(true)
    expect(result.tabs.find((t) => t.url === 'https://loose.example/')?.folderId).toBeUndefined()
  })

  it('keeps a folder inside a folder nested', () => {
    expect(result.folders.map((f) => f.name)).toEqual(['Docs', 'Sous-dossier', 'Autres favoris'])
    const [docs, sub] = result.folders
    expect(docs!.parentId).toBeUndefined()
    expect(sub!.parentId).toBe(docs!.id)
    expect(result.tabs.filter((t) => t.folderId === docs!.id).map((t) => t.title)).toEqual(['MDN'])
    expect(result.tabs.find((t) => t.url === 'https://deep.example/')?.folderId).toBe(sub!.id)
  })

  it('names the space after the browser it comes from', () => {
    expect(convertChromeBookmarks(fixture, ctx(), 'Brave').spaces[0]?.name).toBe('Brave')
  })

  it('puts the other bookmarks in their own folder and leaves no folder for an empty root', () => {
    const other = result.folders.find((f) => f.name === 'Autres favoris')!
    expect(result.tabs.filter((t) => t.folderId === other.id).map((t) => t.url)).toEqual(['https://other.example/'])
    expect(result.folders.some((f) => f.name === 'Favoris mobiles')).toBe(false)
  })

  it('counts what it cannot import: non-web addresses', () => {
    expect(result.report).toEqual({ tabs: 4, folders: 3, skipped: 2, overLimit: 0 })
    expect(result.tabs.some((t) => t.url.startsWith('javascript:') || t.url.startsWith('chrome-extension:'))).toBe(false)
  })

  it('returns an empty import for anything that is not a bookmarks file, or has no usable bookmark', () => {
    for (const bad of [null, {}, 'text', { roots: [] }, { roots: { bookmark_bar: { children: [url('x', 'javascript:1')] } } }]) {
      expect(convertChromeBookmarks(bad, ctx()).spaces).toEqual([])
    }
  })

  it('stops at two thousand bookmarks', () => {
    const many = { roots: { bookmark_bar: { children: Array.from({ length: 2100 }, (_, i) => url(`n${i}`, `https://e.example/${i}`)) } } }
    const big = convertChromeBookmarks(many, ctx())
    expect(big.tabs).toHaveLength(2000)
    expect(big.report).toMatchObject({ skipped: 0, overLimit: 100 })
  })
})

describe('convertChromeBookmarks on hostile input', () => {
  it('survives a tree nested ten thousand levels deep (the walk is bounded, not recursive without end) and keeps the top of it', () => {
    let node: unknown = url('au fond', 'https://fond.example/')
    for (let i = 0; i < 40_000; i++) node = folder(`d${i}`, [url(`l${i}`, `https://l${i}.example/`), node])
    const result = convertChromeBookmarks({ roots: { bookmark_bar: { type: 'folder', name: 'Barre', children: [node] } } }, ctx())
    expect(result.tabs.length).toBeGreaterThan(20)
    expect(result.tabs.some((t) => t.url === 'https://fond.example/')).toBe(false)
    expect(result.report.skipped).toBeGreaterThan(0)
  })

  it('keeps a bookmark listed twice in one folder once, and says so', () => {
    const result = convertChromeBookmarks({ roots: { bookmark_bar: { type: 'folder', name: 'Barre', children: [url('A', 'https://a.example/'), url('A encore', 'https://a.example/')] } } }, ctx())
    expect(result.tabs).toHaveLength(1)
    expect(result.report.duplicates).toBe(1)
  })
})
