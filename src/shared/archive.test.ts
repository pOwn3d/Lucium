import { describe, expect, it } from 'vitest'
import { archiveBuckets } from './archive'
import type { ArchivedTab } from './model'

const DAY = 86_400_000
const now = new Date(2026, 9, 23, 15, 0, 0).getTime() // 23 Oct 2026, 15:00
const tab = (id: string, archivedAt: number): ArchivedTab => ({ id, spaceId: 's', url: `https://${id}.fr/`, title: id, archivedAt })

describe('archiveBuckets', () => {
  it('groups by age, newest first, and drops empty groups', () => {
    const buckets = archiveBuckets(
      [tab('old', now - 90 * DAY), tab('today-early', new Date(2026, 9, 23, 0, 1).getTime()), tab('yesterday', now - DAY), tab('week', now - 5 * DAY), tab('month', now - 20 * DAY), tab('today-late', now - 1000)],
      now
    )
    expect(buckets.map((b) => b.id)).toEqual(['today', 'yesterday', 'week', 'month', 'older'])
    expect(buckets[0]!.items.map((i) => i.id)).toEqual(['today-late', 'today-early'])
    expect(buckets[4]!.items.map((i) => i.id)).toEqual(['old'])
  })

  it('returns nothing for an empty archive', () => {
    expect(archiveBuckets([], now)).toEqual([])
  })

  it('treats just-after-midnight as today and just-before as yesterday', () => {
    const midnight = new Date(2026, 9, 23, 0, 0, 0).getTime()
    const ids = (at: number) => archiveBuckets([tab('x', at)], now)[0]!.id
    expect(ids(midnight)).toBe('today')
    expect(ids(midnight - 1)).toBe('yesterday')
  })
})
