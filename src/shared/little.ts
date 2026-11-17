import { t } from './i18n'

// Mini windows are meant to be short-lived: left without activity past a delay they are closed and archived, unless the pin "Garder ouvert" is on.

/**
 * Where a mini window comes from: the space of the tab whose link opened it, or of the window whose command bar did. Its page is made with the
 * profile of that space (the cookies the link was clicked with), and it is archived there, or opened there as a tab. Without one, the space the
 * main window is on.
 */
export interface LittleOrigin {
  spaceId?: string
}

const HOUR_MS = 3_600_000

/**
 * Whether a mini window whose last activity (opened, brought to the front, went to another page) was at `activeAt` is to be closed and
 * archived: `hours` (0 = never) have passed since, and the window is not kept (the pin "Garder ouvert" leaves it out of the archiving).
 */
export function littleArcExpired(activeAt: number, now: number, hours: number, kept = false): boolean {
  return !kept && hours > 0 && now - activeAt >= hours * HOUR_MS
}

/** What the banner of the window says of its archiving: the pin is on (nothing is archived), there is no delay, or the delay in hours. */
export type LittleStrip = { kind: 'kept' } | { kind: 'never' } | { kind: 'after'; hours: number }

export function littleStrip(kept: boolean, hours: number): LittleStrip {
  if (kept) return { kind: 'kept' }
  return Number.isFinite(hours) && hours > 0 ? { kind: 'after', hours } : { kind: 'never' }
}

/** The sentence of the banner: "Fermée et archivée après 12 h sans activité", "Gardée ouverte : pas d’archivage automatique" or "Jamais archivée automatiquement". */
export function littleStripText(strip: LittleStrip): string {
  if (strip.kind === 'kept') return t('littlearc.gardee-ouverte-pas-d-archivage')
  if (strip.kind === 'never') return t('littlearc.jamais-archivee-automatiquement')
  const { unit, n } = littleDelayParts(strip.hours)
  return t('littlearc.fermee-et-archivee-apres-delay', { delay: t(unit === 'days' ? 'littlearc.delai-jours' : 'littlearc.delai-heures', { n }) })
}

/** "12 h", "1 j", "7 j": the delay as the banner writes it (whole days from 24 h on, when it is a whole number of them). */
export function littleDelayParts(hours: number): { unit: 'hours' | 'days'; n: number } {
  return hours >= 24 && hours % 24 === 0 ? { unit: 'days', n: hours / 24 } : { unit: 'hours', n: hours }
}
