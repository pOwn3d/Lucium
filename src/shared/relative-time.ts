// "il y a 3 heures" / "3 hours ago": how long ago something happened, in the language of the interface. The words come from the platform's own
// rules (Intl.RelativeTimeFormat), not from the catalogue, so a language needs nothing more than its locale.

import { getLanguage, type Language } from './i18n'

const MINUTE = 60
const HOUR = 3600
const DAY = 86_400

/**
 * How long before `now` the instant `then` was (both in milliseconds). Under a minute, which includes a date in the future (the clock moved), it is "now".
 * The unit is the largest that holds the whole span: minutes under an hour, hours under a day, days under two weeks, then weeks, months, years.
 */
export function relativeAgo(then: number, now: number, language: Language = getLanguage()): string {
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  const seconds = Math.floor((now - then) / 1000)
  if (seconds < MINUTE) return format.format(0, 'second')
  if (seconds < HOUR) return format.format(-Math.floor(seconds / MINUTE), 'minute')
  if (seconds < DAY) return format.format(-Math.floor(seconds / HOUR), 'hour')
  const days = Math.floor(seconds / DAY)
  if (days < 14) return format.format(-days, 'day')
  if (days < 60) return format.format(-Math.floor(days / 7), 'week')
  if (days < 365) return format.format(-Math.floor(days / 30), 'month')
  return format.format(-Math.floor(days / 365), 'year')
}
