// What the hover card of a tab says: the address split for display, and the tab's state in a few words.

import type { TabResources } from './ipc'
import type { TabItem, TabRuntime } from './model'
import { getLanguage, t } from './i18n'

/** The address as people read it: the host (kept whole, `www.` included) and what follows it, without the scheme or a bare trailing slash. */
export function splitAddress(url: string): { host: string; rest: string } {
  if (!URL.canParse(url)) return { host: url, rest: '' }
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { host: url, rest: '' }
  const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`
  return { host: parsed.host, rest: rest === '/' ? '' : rest }
}

/** "Épinglé · En veille": the states worth a line on the card, in a fixed order. */
export function cardStatus(tab: Pick<TabItem, 'pinned'>, runtime: Pick<TabRuntime, 'audible' | 'muted' | 'awake'> & Partial<Pick<TabRuntime, 'frozen'>> | undefined, badges = false): string {
  // With the tab state badges on, a frozen page is told apart from a sleeping one; off, both are "En veille" as they always were.
  const asleep = runtime && !runtime.awake ? (badges && runtime.frozen === true ? t('tab-state.gele') : t('hover-card.en-veille')) : null
  return [tab.pinned ? t('hover-card.epingle') : null, runtime?.audible ? (runtime.muted ? t('sidebar.son-coupe') : t('hover-card.son-en-cours')) : null, asleep].filter(Boolean).join(' · ')
}

/**
 * A card that shows the resources of its tab measures them when it opens, again a second later, then rarely. The processor figure is an
 * average since the previous measure (Electron says so), so the first measure of a card has nothing to compare with: it gives the memory
 * and the second one gives the processor. Nothing is measured while no card is open.
 */
export const RESOURCES_SECOND_MEASURE_MS = 1000
export const RESOURCES_REFRESH_MS = 3000

/** What the card has of its tab's resources: nothing yet, or the answer (null: the tab has no process) and how many times it was measured. */
export type ResourcesReading = { state: 'waiting' } | { state: 'read'; resources: TabResources | null; measures: number }

/** One decimal, with the decimal mark of the language of the interface ("1,5" in French, "1.5" in English). */
const oneDecimal = (value: number): string => (getLanguage() === 'fr' ? value.toFixed(1).replace('.', ',') : value.toFixed(1))

/** 142 Mo, then 1,2 Go from a gigabyte on (in English 142 MB, 1.2 GB). */
export function formatMemory(memoryMb: number): string {
  return memoryMb >= 1024 ? t('resources.go', { n: oneDecimal(memoryMb / 1024) }) : t('taskmanager.mb-mo', { mb: memoryMb })
}

/**
 * The line of a card that shows the resources of its tab. A tab with no process (asleep, frozen) has "—" for both; a tab measured once has
 * no processor figure yet ("…"); a process shared with other tabs says so, because its figures are not this tab's alone.
 */
export function resourcesLine(reading: ResourcesReading): string {
  if (reading.state === 'waiting') return t('hover-card.memoire-processeur')
  const { resources, measures } = reading
  if (!resources) return t('hover-card.memoire-processeur-2')
  const cpu = measures < 2 ? '…' : t('resources.pourcent', { n: oneDecimal(resources.cpu) })
  const figures = { memory: formatMemory(resources.memoryMb), cpu }
  return resources.shared ? t('hover-card.memoire-memory-processeur-cpu-processus-partage', figures) : t('hover-card.memoire-memory-processeur-cpu', figures)
}

/**
 * Measures the resources of a tab while a card is open: now, a second later, then every few seconds, until the returned function is called
 * (the card closed). A measure that fails ends the polling with a reading of "no process" and tells `onError`: the card then says "—"
 * rather than keep a figure that is no longer true, and the cause reaches the log. A measure that comes back after the stop is dropped.
 */
export function pollResources(measure: () => Promise<TabResources | null>, onReading: (reading: ResourcesReading) => void, onError: (error: unknown) => void): () => void {
  let live = true
  let measures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const next = () => {
    // Through a promise so that a measure that throws and one that rejects end the same way.
    Promise.resolve().then(measure).then(
      (resources) => {
        if (!live) return
        measures += 1
        onReading({ state: 'read', resources, measures })
        timer = setTimeout(next, measures === 1 ? RESOURCES_SECOND_MEASURE_MS : RESOURCES_REFRESH_MS)
      },
      (error: unknown) => {
        if (!live) return
        onReading({ state: 'read', resources: null, measures })
        onError(error)
      }
    )
  }
  next()
  return () => {
    live = false
    clearTimeout(timer)
  }
}
