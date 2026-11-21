// "Me le rappeler": put a tab away until a chosen time; it comes back as a tab of its space, with a local notification.
// Pure rules shared by the reducer (sidebar-library.ts), the menus and the main-process timer; the shape of an entry is in model.ts and what
// the state file may hold in state-clean.ts.

import { TAB_REMINDER_LIMIT, tabName, type TabItem, type TabReminder } from './model'
import type { Ctx } from './sidebar'
import { isReadLaterUrl, readLaterFavicon } from './state-clean'
import { t } from './i18n'

/** What a reminder asks of the list. `unsupported`: not a web page; `full`: the list is at its limit; `soon`: the time is not in the future. */
export type TabReminderOutcome = 'saved' | 'updated' | 'full' | 'unsupported' | 'soon'

export function tabReminderOutcome(list: readonly TabReminder[], tab: Pick<TabItem, 'url'>, dueAt: number, now: number): TabReminderOutcome {
  if (!isReadLaterUrl(tab.url)) return 'unsupported'
  if (!Number.isFinite(dueAt) || dueAt <= now) return 'soon'
  if (list.some((r) => r.url === tab.url)) return 'updated'
  return list.length >= TAB_REMINDER_LIMIT ? 'full' : 'saved'
}

/** The entry for a tab, null for a tab that cannot be put away. */
export function tabReminderOf(tab: TabItem, dueAt: number, ctx: Ctx): TabReminder | null {
  if (!isReadLaterUrl(tab.url)) return null
  const favicon = readLaterFavicon(tab.faviconUrl)
  return { id: ctx.newId(), url: tab.url, title: tabName(tab), ...(favicon ? { faviconUrl: favicon } : {}), spaceId: tab.spaceId, dueAt, createdAt: ctx.now }
}

/** The list with the entry added (or, for an address already there, moved to the new time), soonest first. */
export function withReminder(list: readonly TabReminder[], entry: TabReminder): TabReminder[] {
  const rest = list.filter((r) => r.url !== entry.url)
  return [...rest, entry].sort((a, b) => a.dueAt - b.dueAt)
}

/** The reminders whose time has come, soonest first. */
export const dueReminders = (list: readonly TabReminder[], now: number): TabReminder[] => list.filter((r) => r.dueAt <= now)

/** When the main process next has to look: the earliest pending time, or null when nothing is pending (then no timer runs). */
export const nextReminderAt = (list: readonly TabReminder[]): number | null => (list.length === 0 ? null : Math.min(...list.map((r) => r.dueAt)))

export type ReminderPresetId = 'tonight' | 'tomorrow' | 'week'

const HOUR_MS = 3_600_000

/** The hour of "ce soir" and of "demain matin", local time. */
export const EVENING_HOUR = 18
export const MORNING_HOUR = 9

const at = (day: Date, hour: number): number => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0, 0, 0).getTime()

/**
 * The time a preset stands for. "Ce soir" is 18:00 today, or three hours from now when 18:00 has passed or is under an hour away ("ce soir"
 * must not be in the past); "demain matin" is 09:00 tomorrow; "dans une semaine" is 09:00 seven days on. Local time, so a change of
 * clock in between moves nothing the user can see.
 */
export function reminderTime(preset: ReminderPresetId, now: number): number {
  const today = new Date(now)
  switch (preset) {
    case 'tonight': {
      const evening = at(today, EVENING_HOUR)
      return evening - now >= HOUR_MS ? evening : now + 3 * HOUR_MS
    }
    case 'tomorrow':
      return at(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1), MORNING_HOUR)
    case 'week':
      return at(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7), MORNING_HOUR)
  }
}

export const REMINDER_PRESETS: readonly ReminderPresetId[] = ['tonight', 'tomorrow', 'week']

export function reminderPresetLabel(preset: ReminderPresetId): string {
  switch (preset) {
    case 'tonight':
      return t('reminder.ce-soir')
    case 'tomorrow':
      return t('reminder.demain-matin')
    case 'week':
      return t('reminder.dans-une-semaine')
  }
}

/** "lun. 24 nov., 09:00": when a reminder falls due, in the language of the interface. */
export function reminderWhen(dueAt: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(dueAt)
}

/** The sentence of the toast that tells what putting a tab away did. */
export function tabReminderNotice(outcome: TabReminderOutcome, when: string): string {
  switch (outcome) {
    case 'saved':
    case 'updated':
      return t('reminder.rappel-programme', { when })
    case 'full':
      return t('reminder.trop-de-rappels', { TAB_REMINDER_LIMIT })
    case 'unsupported':
      return t('reminder.seules-les-pages-web')
    case 'soon':
      return t('reminder.heure-passee')
  }
}
