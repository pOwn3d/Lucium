import { describe, expect, it } from 'vitest'
import { HistoryBook } from '../history'
import { countImportedHistory, historyProfileOfImport, mergeImportedHistory, mergeImportedHistoryTracked, withHistoryProfile } from './history-target'
import { tempDir } from '../temp-dir'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const page = (url: string) => ({ url, title: url, visitCount: 2, lastVisitAt: 5 })

describe('the profile an import adds its history to', () => {
  it('is the default profile outside of an import', () => {
    expect(historyProfileOfImport()).toBe('default')
  })

  it('follows the import across the waits of its steps, and two imports at once keep their own', async () => {
    const seen: string[] = []
    const run = (profile: string, wait: number) =>
      withHistoryProfile(profile, async () => {
        await sleep(wait)
        seen.push(`${profile}:${historyProfileOfImport()}`)
        await sleep(wait)
        seen.push(`${profile}:${historyProfileOfImport()}`)
      })
    await Promise.all([run('travail', 5), run('perso', 1)])
    expect(seen.sort()).toEqual(['perso:perso', 'perso:perso', 'travail:travail', 'travail:travail'])
    expect(historyProfileOfImport()).toBe('default')
  })

  it('decides which profile’s history receives the pages', async () => {
    const book = new HistoryBook(tempDir('lucium-import-'))
    expect(await withHistoryProfile('travail', async () => mergeImportedHistory(book, [page('https://a.example/')]))).toBe(1)
    expect(mergeImportedHistory(book, [page('https://b.example/')])).toBe(1)
    expect(book.of('travail').search('').map((e) => e.url)).toEqual(['https://a.example/'])
    expect(book.of('default').search('').map((e) => e.url)).toEqual(['https://b.example/'])
  })

  it('counts, and takes back, in the profile it was started for', () => {
    const book = new HistoryBook(tempDir('lucium-import-'))
    const pages = [page('https://a.example/')]
    expect(withHistoryProfile('travail', () => countImportedHistory(book, pages))).toBe(1)
    expect(book.of('travail').size()).toBe(0)
    // The count is that of the profile's own history: a page it already has is not counted, whatever the other profiles hold.
    book.of('travail').merge(pages)
    expect(withHistoryProfile('travail', () => countImportedHistory(book, pages))).toBe(0)
    expect(withHistoryProfile('perso', () => countImportedHistory(book, pages))).toBe(1)
    book.of('travail').clear()
    const tracked = withHistoryProfile('travail', () => mergeImportedHistoryTracked(book, pages))
    expect(tracked.touched).toBe(1)
    expect(book.of('default').size()).toBe(0)
    // The undo runs outside of the import, in another profile's context, and still empties the profile that received the pages.
    expect(withHistoryProfile('perso', () => tracked.undo())).toBe(1)
    expect(book.of('travail').size()).toBe(0)
  })
})
