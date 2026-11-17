// The history search of the panel: a slow answer to an older query must not overwrite the answer to the query on screen, and a failed
// request gives no answer instead of an unhandled rejection.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { HistoryEntry } from '@shared/model'
import { latestHistorySearch } from './ManagePanels'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const page = (title: string) => [{ url: `https://${title}.fr/`, title } as HistoryEntry]

describe('latestHistorySearch', () => {
  it('ignores the late answer to an older query', async () => {
    const answers = new Map<string, ReturnType<typeof deferred<HistoryEntry[]>>>()
    const ask = latestHistorySearch((query) => {
      const answer = deferred<HistoryEntry[]>()
      answers.set(query, answer)
      return answer.promise
    })

    const slow = ask('a')
    const fast = ask('ab')
    answers.get('ab')!.resolve(page('ab'))
    expect(await fast).toEqual(page('ab'))

    answers.get('a')!.resolve(page('a'))
    expect(await slow).toBeUndefined()
  })

  it('keeps the answer of the last query when it comes before an older one', async () => {
    const answers = new Map<string, ReturnType<typeof deferred<HistoryEntry[]>>>()
    const ask = latestHistorySearch((query) => {
      const answer = deferred<HistoryEntry[]>()
      answers.set(query, answer)
      return answer.promise
    })
    const first = ask('a')
    const last = ask('ab')
    answers.get('ab')!.resolve(page('ab'))
    answers.get('a')!.resolve(page('a'))
    expect(await last).toEqual(page('ab'))
    expect(await first).toBeUndefined()
  })

  it('gives no answer for a failed request, and the cause goes to the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failure = new Error('ipc down')
    const ask = latestHistorySearch(() => Promise.reject(failure))
    await expect(ask('a')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[history] the search failed:', failure)
    warn.mockRestore()
  })
})

// What only a window can show (a change of space under an open panel) is read in the source: the panels that list one profile are made again
// when the profile on screen changes, and what the history panel asks names the profile it lists.
describe('the panels that list one profile', () => {
  const source = (name: string): string => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')

  it('the history panel is made again for another profile, and its requests name the one it lists', () => {
    const panel = source('./ManagePanels.tsx')
    expect(panel).toContain('<HistoryList key={profileId} profileId={profileId} />')
    expect(panel).toContain('api().searchHistory(text, HISTORY_ROWS, profileId)')
    // Every page forgotten from the panel (one page, a whole day) names the profile: none goes to the profile of the space on screen at that time.
    expect(panel.match(/act\.forgetHistory\(/g)).toHaveLength(2)
    expect(panel.match(/act\.forgetHistory\((?:entry\.)?url, profileId\)/g)).toHaveLength(2)
  })

  it('the sheet of the cookies by site is made again for another profile: what it removes is what it lists', () => {
    expect(source('./CookieManager.tsx')).toContain('<CookieSheet key={activeProfileId(snapshot.state)} snapshot={snapshot} />')
  })

  it('the confirmation of « Effacer les données de navigation » does not follow the profile on screen: it closes when the profile changes', () => {
    expect(source('./SettingsCategories.tsx')).toContain('<ClearDataRow key={`clear-${activeProfileId(snapshot.state)}`}')
  })
})
