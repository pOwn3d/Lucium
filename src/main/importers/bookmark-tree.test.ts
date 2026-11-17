import { describe, expect, it } from 'vitest'
import { MAX_IMPORTED_FOLDERS } from '@shared/import-sources'
import type { Ctx } from '@shared/sidebar'
import { MAX_BOOKMARKS, buildBookmarkSpace, type BookmarkNode } from './bookmark-tree'

const ctx = (): Ctx => {
  let n = 0
  return { now: 7, newId: () => `id${++n}` }
}
const link = (title: string, url: string): BookmarkNode => ({ kind: 'link', title, url })
const folder = (title: string, children: BookmarkNode[]): BookmarkNode => ({ kind: 'folder', title, children })
const look = { name: 'Test', emoji: '🧪', hue: 100 }

describe('buildBookmarkSpace', () => {
  it('pins every link, anchored on its address, and falls back to the address as a title', () => {
    const { tabs } = buildBookmarkSpace(ctx(), look, [{ nodes: [link('  Un  ', 'https://a.example/'), link('', 'https://b.example/')] }])
    expect(tabs.map((t) => [t.title, t.pinned, t.anchorUrl])).toEqual([['Un', true, 'https://a.example/'], ['https://b.example/', true, 'https://b.example/']])
  })

  it('keeps folders nested and puts a labelled group in a folder of its own', () => {
    const result = buildBookmarkSpace(ctx(), look, [{ nodes: [folder('A', [folder('B', [link('x', 'https://x.example/')])])] }, { label: 'Autres', nodes: [link('y', 'https://y.example/')] }])
    expect(result.folders.map((f) => [f.name, result.folders.find((p) => p.id === f.parentId)?.name])).toEqual([['A', undefined], ['B', 'A'], ['Autres', undefined]])
  })

  it('leaves no folder behind for a folder that holds no link, however deep', () => {
    const result = buildBookmarkSpace(ctx(), look, [{ nodes: [folder('Vide', [folder('Encore vide', [])]), folder('Mauvais', [link('js', 'javascript:1')]), link('ok', 'https://ok.example/')] }])
    expect(result.folders).toEqual([])
    expect(result.report).toEqual({ tabs: 1, folders: 0, skipped: 1, overLimit: 0 })
  })

  it('refuses addresses that are not web pages, and counts them', () => {
    const result = buildBookmarkSpace(ctx(), look, [{ nodes: [link('a', 'https://a.example/'), link('f', 'file:///etc/passwd'), link('e', 'chrome-extension://x/y')] }], 3)
    expect(result.tabs).toHaveLength(1)
    expect(result.report.skipped).toBe(5)
  })

  it('stops at the limit and counts the rest apart from what is not a web page', () => {
    const many = Array.from({ length: MAX_BOOKMARKS + 5 }, (_, i) => link(`n${i}`, `https://e.example/${i}`))
    const result = buildBookmarkSpace(ctx(), look, [{ nodes: [...many, link('js', 'javascript:1')] }])
    expect(result.tabs).toHaveLength(MAX_BOOKMARKS)
    expect(result.report).toMatchObject({ skipped: 1, overLimit: 5 })
  })

  it('counts as skipped an address that has the prefix of a web page and nothing it could open', () => {
    const result = buildBookmarkSpace(ctx(), look, [{ nodes: [link('a', 'https://'), link('b', 'http://exa mple/'), link('c', 'https://c.example/\n<x>'), link('ok', 'https://ok.example/')] }])
    expect(result.tabs.map((t) => t.url)).toEqual(['https://ok.example/'])
    expect(result.report).toMatchObject({ skipped: 3, overLimit: 0 })
  })

  it('refuses an address of 2 MB, and cuts a title or a folder name to what the state keeps', () => {
    const result = buildBookmarkSpace(ctx(), look, [
      { nodes: [link('huge', 'https://big.example/' + 'a'.repeat(2_000_000)), folder('d'.repeat(5000), [link('t'.repeat(5000), 'https://ok.example/')])] }
    ])
    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0]!.title).toHaveLength(1000)
    expect(result.folders[0]!.name).toHaveLength(200)
    expect(result.report.skipped).toBe(1)
  })

  it('keeps the links of the folders beyond the folder limit where their parent is, instead of losing them', () => {
    let deep: BookmarkNode = link('end', 'https://end.example/')
    for (let i = MAX_IMPORTED_FOLDERS + 20; i > 0; i--) deep = folder(`f${i}`, [deep])
    const result = buildBookmarkSpace(ctx(), look, [{ nodes: [deep] }])
    expect(result.folders).toHaveLength(MAX_IMPORTED_FOLDERS)
    expect(result.tabs.map((t) => t.url)).toEqual(['https://end.example/'])
    expect(result.tabs[0]!.folderId).toBe(result.folders.at(-1)!.id)
    expect(result.report.overLimit).toBe(0)
  })

  it('makes no space at all when nothing can be imported', () => {
    expect(buildBookmarkSpace(ctx(), look, [{ nodes: [] }]).spaces).toEqual([])
    expect(buildBookmarkSpace(ctx(), look, [])).toMatchObject({ spaces: [], tabs: [], folders: [] })
  })
})

describe('buildBookmarkSpace: duplicates', () => {
  it('keeps a link once when it is listed twice in the same folder, however the address is written', () => {
    const result = buildBookmarkSpace(ctx(), look, [{ nodes: [link('Un', 'https://a.example/'), link('Deux', 'https://a.example/'), link('Trois', 'HTTPS://A.EXAMPLE/'), folder('D', [link('Un', 'https://a.example/'), link('Un bis', 'https://a.example/')])] }])
    expect(result.tabs.map((t) => [t.title, t.folderId === undefined])).toEqual([['Un', true], ['Un', false]])
    expect(result.report).toMatchObject({ tabs: 2, duplicates: 2 + 1 })
  })

  it('does not call a link a duplicate of one in another folder: each folder keeps its own', () => {
    const result = buildBookmarkSpace(ctx(), look, [{ nodes: [folder('A', [link('x', 'https://x.example/')]), folder('B', [link('x', 'https://x.example/')])] }])
    expect(result.tabs).toHaveLength(2)
    expect(result.report.duplicates).toBeUndefined()
  })

  it('reports duplicates even when nothing else is left to import', () => {
    const result = buildBookmarkSpace(ctx(), look, [{ nodes: [link('a', 'javascript:1')] }])
    expect(result.report.duplicates).toBeUndefined()
    const twice = buildBookmarkSpace(ctx(), look, [{ nodes: [link('a', 'https://a.example/'), link('a', 'https://a.example/')] }])
    expect(twice.report.duplicates).toBe(1)
  })
})
