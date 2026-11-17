// The notices of a window (the short messages at the foot of the sidebar), kept for a while so that one that went by too fast can be read again
// (« Notifications récentes »). In memory only, per window: nothing is written, and quitting forgets them.

export interface NoticeEntry {
  /** When the notice appeared (ms since the epoch). */
  at: number
  message: string
  /** Its second line, when it had one. */
  detail?: string
}

/** How many notices are kept: the oldest go first. */
export const NOTICE_LOG_MAX = 30

export class NoticeLog {
  private entries: Array<NoticeEntry & { id: number }> = []

  /** A notice appeared. The same words twice in a row are one entry (a notice that comes back), with the time of the latest. */
  record(id: number, at: number, message: string, detail?: string): void {
    const last = this.entries[this.entries.length - 1]
    if (last && last.message === message && last.detail === detail) {
      last.id = id
      last.at = at
      return
    }
    this.entries.push({ id, at, message, ...(detail !== undefined ? { detail } : {}) })
    if (this.entries.length > NOTICE_LOG_MAX) this.entries.splice(0, this.entries.length - NOTICE_LOG_MAX)
  }

  /** The notice with this id has new words (the progress of a long job): the entry says what it ended with. A notice already replaced is left as it was. */
  revise(id: number, message: string, detail?: string): void {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return
    entry.message = message
    if (detail !== undefined) entry.detail = detail
    else delete entry.detail
  }

  /** The notices, the latest first. */
  list(): NoticeEntry[] {
    return this.entries.map(({ at, message, detail }) => ({ at, message, ...(detail !== undefined ? { detail } : {}) })).reverse()
  }
}
