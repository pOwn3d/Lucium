import type { ArchivedTab } from './model'
import { t } from './i18n'

export type ArchiveBucketId = 'today' | 'yesterday' | 'week' | 'month' | 'older'

export interface ArchiveBucket {
  id: ArchiveBucketId
  label: string
  items: ArchivedTab[]
}

const DAY_MS = 86_400_000
const LABELS: Record<ArchiveBucketId, string> = {
  get today() { return t('archive.aujourd-hui') },
  get yesterday() { return t('archive.hier') },
  get week() { return t('archive.7-derniers-jours') },
  get month() { return t('archive.30-derniers-jours') },
  get older() { return t('archive.plus-ancien') }
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** How many entries `after` has that `before` did not: what an action archived (the archive is capped, so its length alone cannot say). */
export function newlyArchived(before: readonly ArchivedTab[], after: readonly ArchivedTab[]): number {
  if (after === before) return 0
  const known = new Set(before.map((entry) => entry.id))
  return after.reduce((n, entry) => (known.has(entry.id) ? n : n + 1), 0)
}

/** Groups archived tabs by how long ago they were archived, newest first, dropping empty groups. */
export function archiveBuckets(archive: ArchivedTab[], now: number): ArchiveBucket[] {
  const today = startOfDay(now)
  const bucketOf = (at: number): ArchiveBucketId =>
    at >= today ? 'today' : at >= today - DAY_MS ? 'yesterday' : at >= today - 7 * DAY_MS ? 'week' : at >= today - 30 * DAY_MS ? 'month' : 'older'
  const buckets = new Map<ArchiveBucketId, ArchivedTab[]>()
  for (const item of [...archive].sort((a, b) => b.archivedAt - a.archivedAt)) {
    const id = bucketOf(item.archivedAt)
    buckets.set(id, [...(buckets.get(id) ?? []), item])
  }
  return (['today', 'yesterday', 'week', 'month', 'older'] as const)
    .filter((id) => buckets.has(id))
    .map((id) => ({ id, label: LABELS[id], items: buckets.get(id)! }))
}
