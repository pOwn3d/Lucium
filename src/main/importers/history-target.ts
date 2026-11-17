// Which profile's history an import adds its pages to: the profile of the space the user was in, in the window the import was started
// from. The import service is one object for the whole application and runs for seconds (it reads files between its steps), so the
// profile is carried along the run instead of being looked up when the pages arrive, when another window or space may be in front.

import { AsyncLocalStorage } from 'node:async_hooks'
import type { HistoryEntry } from '@shared/model'
import { DEFAULT_HISTORY_PROFILE, type HistoryBook } from '../history'

const target = new AsyncLocalStorage<string>()

/** Runs an import (or anything that adds pages to the history) for a profile. */
export function withHistoryProfile<T>(profileId: string, run: () => T): T {
  return target.run(profileId, run)
}

/** The profile of the import being run; the default profile for pages that arrive outside of one. */
export function historyProfileOfImport(): string {
  return target.getStore() ?? DEFAULT_HISTORY_PROFILE
}

/** What the import service calls with the pages it read: they join the history of the profile of the import being run. Answers how many were added or changed. */
export const mergeImportedHistory = (book: HistoryBook, entries: HistoryEntry[]): number => book.of(historyProfileOfImport()).merge(entries)

/** How many of these pages the history of the import's profile would gain or change, without touching it (the preview). */
export const countImportedHistory = (book: HistoryBook, entries: HistoryEntry[]): number => book.of(historyProfileOfImport()).wouldChange(entries)

/** `mergeImportedHistory`, and the way back (the "Annuler l'import" of the sheet). The undo acts on the history that received the pages, whatever profile is current when it runs. */
export const mergeImportedHistoryTracked = (book: HistoryBook, entries: HistoryEntry[]): { touched: number; undo: () => number } => book.of(historyProfileOfImport()).mergeTracked(entries)
