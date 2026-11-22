import type { ArchivedTab, Space } from './model'

/** The most sessions `chrome.sessions.getRecentlyClosed` answers, as the extension platform defines it. */
export const MAX_SESSION_RESULTS = 25

/** What the platform calls a closed tab: the one `chrome.sessions` lists and restores. */
export interface ClosedSession {
  /** Seconds since the epoch. */
  lastModified: number
  tab: { sessionId: string; index: number; highlighted: false; active: false; pinned: boolean; incognito: false; url: string; title: string }
}

/**
 * The archive entries an extension of `profileId` may see as recently closed: those of the tabs the person closed (`manual`, or a closed mini window), in a space of that
 * profile, newest first. What was archived for being idle or kept for another device is not "closed", and a private tab is never in the archive. The caller hands the
 * archive the interface is given, so a locked space is already out.
 */
function closedEntries(archive: readonly ArchivedTab[], spaces: readonly Space[], profileId: string): ArchivedTab[] {
  const mine = new Set(spaces.filter((space) => space.profileId === profileId).map((space) => space.id))
  return archive.filter((entry) => (entry.source === 'manual' || entry.source === 'little') && mine.has(entry.spaceId)).sort((a, b) => b.archivedAt - a.archivedAt)
}

export function closedSessions(archive: readonly ArchivedTab[], spaces: readonly Space[], profileId: string, maxResults: number): ClosedSession[] {
  return closedEntries(archive, spaces, profileId)
    .slice(0, maxResults)
    .map((entry) => ({
      lastModified: Math.floor(entry.archivedAt / 1000),
      tab: { sessionId: entry.id, index: 0, highlighted: false, active: false, pinned: entry.pinned === true, incognito: false, url: entry.url, title: entry.title }
    }))
}

/** The entry `chrome.sessions.restore(sessionId)` opens again: the one named, or the latest without a name. Null when it is not a closed tab of this profile. */
export function sessionToRestore(archive: readonly ArchivedTab[], spaces: readonly Space[], profileId: string, sessionId: string | undefined): ArchivedTab | null {
  const list = closedEntries(archive, spaces, profileId)
  return (sessionId === undefined ? list[0] : list.find((entry) => entry.id === sessionId)) ?? null
}

/** `filter.maxResults` of `getRecentlyClosed`: 25 without one; null for a value the platform refuses (not a whole number from 1 to 25). */
export function parseMaxResults(filter: unknown): number | null {
  if (filter === undefined) return MAX_SESSION_RESULTS
  if (typeof filter !== 'object' || filter === null) return null
  const value = (filter as { maxResults?: unknown }).maxResults
  if (value === undefined) return MAX_SESSION_RESULTS
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_SESSION_RESULTS ? value : null
}
