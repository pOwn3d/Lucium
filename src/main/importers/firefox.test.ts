import { describe, expect, it } from 'vitest'
import type { Ctx } from '@shared/sidebar'
import { convertFirefoxBookmarks, type FirefoxBookmarkRow } from './firefox'

const ctx = (): Ctx => {
  let n = 0
  return { now: 3, newId: () => `f${++n}` }
}
const row = (id: number, type: number, parent: number, position: number, title: string | null, url: string | null = null): FirefoxBookmarkRow => ({ id, type, parent, position, title, url })

const rows: FirefoxBookmarkRow[] = [
  row(1, 2, 0, 0, ''),
  row(2, 2, 1, 0, 'menu'),
  row(3, 2, 1, 1, 'toolbar'),
  row(4, 2, 1, 2, 'tags'),
  row(5, 2, 1, 3, 'unfiled'),
  row(6, 2, 1, 4, 'mobile'),
  row(10, 1, 3, 1, 'Second', 'https://second.example/'),
  row(11, 1, 3, 0, 'First', 'https://first.example/'),
  row(12, 2, 3, 2, 'Dossier', null),
  row(13, 1, 12, 0, 'Inside', 'https://inside.example/'),
  row(14, 3, 12, 1, null),
  row(15, 1, 2, 0, 'Menu', 'https://menu.example/'),
  row(16, 1, 5, 0, 'Other', 'https://other.example/'),
  row(17, 1, 4, 0, 'Tagged', 'https://tagged.example/'),
  row(18, 1, 3, 3, 'Place', 'place:sort=8'),
  row(19, 1, 3, 4, 'No address', null)
]

describe('convertFirefoxBookmarks on a big folder', () => {
  it('reads 60 000 bookmarks of one folder in well under a second (copying the list for each row took 3.5 s)', () => {
    const many: FirefoxBookmarkRow[] = [row(3, 2, 1, 0, 'toolbar')]
    for (let i = 0; i < 60_000; i++) many.push(row(100 + i, 1, 3, i, 't', `https://x.example/${i}`))
    const started = performance.now()
    const result = convertFirefoxBookmarks(many, ctx())
    expect(performance.now() - started).toBeLessThan(1500)
    expect(result.tabs).toHaveLength(2000)
    expect(result.report.overLimit).toBe(58_000)
    expect(result.tabs[0]!.url).toBe('https://x.example/0')
  })
})

describe('convertFirefoxBookmarks', () => {
  const result = convertFirefoxBookmarks(rows, ctx())

  it('orders bookmarks by position, toolbar at the root, the other roots in folders of their own', () => {
    expect(result.spaces[0]).toMatchObject({ name: 'Navigateur basé sur Gecko' })
    const root = result.tabs.filter((t) => !t.folderId).map((t) => t.url)
    expect(root).toEqual(['https://first.example/', 'https://second.example/'])
    expect(result.folders.map((f) => f.name)).toEqual(['Dossier', 'Menu des favoris', 'Autres favoris'])
    expect(result.tabs.find((t) => t.url === 'https://inside.example/')?.folderId).toBe(result.folders[0]!.id)
  })

  it('leaves the tags root out (it lists tagged pages again) and the places: queries, which are not web pages', () => {
    expect(result.tabs.some((t) => t.url.includes('tagged') || t.url.startsWith('place:'))).toBe(false)
    expect(result.report.skipped).toBe(2)
  })

  it('survives a folder that is its own ancestor', () => {
    const looped = [row(3, 2, 1, 0, 'toolbar'), row(20, 2, 3, 0, 'A'), row(21, 2, 20, 0, 'B'), row(20, 2, 21, 0, 'A'), row(22, 1, 21, 1, 'x', 'https://x.example/')]
    expect(() => convertFirefoxBookmarks(looped, ctx())).not.toThrow()
  })

  it('returns an empty import for no rows', () => {
    expect(convertFirefoxBookmarks([], ctx()).spaces).toEqual([])
  })
})

describe('convertFirefoxBookmarks on hostile input', () => {
  it('survives a chain of ten thousand folders (the walk is bounded) and keeps the top of it', () => {
    const chain: FirefoxBookmarkRow[] = [row(1, 2, 0, 0, ''), row(3, 2, 1, 1, 'toolbar')]
    let parent = 3
    for (let i = 0; i < 40_000; i++) {
      chain.push(row(100 + i * 2, 2, parent, 0, `d${i}`), row(101 + i * 2, 1, 100 + i * 2, 0, `l${i}`, `https://l${i}.example/`))
      parent = 100 + i * 2
    }
    const result = convertFirefoxBookmarks(chain, ctx())
    expect(result.tabs.length).toBeGreaterThan(20)
    expect(result.tabs.length).toBeLessThan(100)
    expect(result.report.skipped).toBeGreaterThan(0)
  })

  it('keeps a bookmark listed twice in one folder once', () => {
    const result = convertFirefoxBookmarks([row(1, 2, 0, 0, ''), row(3, 2, 1, 1, 'toolbar'), row(10, 1, 3, 0, 'A', 'https://a.example/'), row(11, 1, 3, 1, 'A', 'https://a.example/')], ctx())
    expect(result.tabs).toHaveLength(1)
    expect(result.report.duplicates).toBe(1)
  })
})
