// The visit history does not keep an address longer than HISTORY_URL_MAX: a page cannot fill the 20 000 places of the history with addresses of megabytes.

import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HISTORY_URL_MAX } from '@shared/state-clean'
import { HistoryStore } from './history'
import { takePersistenceNotices } from './persistence-notices'
import { tempDir } from './temp-dir'

afterEach(() => void takePersistenceNotices())
const addressOf = (length: number): string => `https://a.example/#${'x'.repeat(length - 'https://a.example/#'.length)}`
const store = (): HistoryStore => new HistoryStore(join(tempDir('lucium-history-length-'), 'h.json'))

describe('HistoryStore and the length of an address', () => {
  it('records an address up to the ceiling, and none longer', () => {
    const history = store()
    history.record(addressOf(HISTORY_URL_MAX), 'ok', 1)
    history.record(addressOf(HISTORY_URL_MAX + 1), 'too long', 2)
    expect(history.size()).toBe(1)
    expect(history.isDirty()).toBe(true)
    expect(history.search('', 10).map((e) => e.title)).toEqual(['ok'])
  })

  it('does not merge a page of another browser whose address is longer, and says so in the preview of the import', () => {
    const history = store()
    const imported = [
      { url: 'https://b.example/', title: 'B', visitCount: 1, lastVisitAt: 5 },
      { url: addressOf(HISTORY_URL_MAX + 1), title: 'huge', visitCount: 1, lastVisitAt: 6 }
    ]
    expect(history.wouldChange(imported)).toBe(1)
    expect(history.merge(imported)).toBe(1)
    expect(history.size()).toBe(1)
  })
})
