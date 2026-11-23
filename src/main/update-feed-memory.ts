// The memory of the anti-replay rule (shared/update-feed-date.ts): the latest date of publication accepted for each address of feed, kept in a small file of the
// data folder. It is the main process's own: it is not in the profile's state (nothing of it reaches a page, an export or a backup), it holds an address that is
// public and a date, and reading or writing it asks nothing of the network.
//
// A file that is missing is the first feed ever read: nothing is refused. A file that cannot be read or is damaged is read as empty and said in the log (the rule
// is then without memory until the next feed is accepted); a file that cannot be written is said in the log too, and the feed that was just accepted stays accepted.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FeedAnswer } from '@shared/update-check'
import { cleanFeedDates, judgeFeedDate, type FeedDates } from '@shared/update-feed-date'
import type { FeedTarget } from '@shared/update-target'
import { replaceFileDurably } from './durable-write'

/** The file of the memory, in the data folder. */
export const FEED_MEMORY_FILE = 'update-feed-seen.json'

/** Where the dates are kept: read whole, written whole. */
export interface FeedDateStore {
  read(): FeedDates
  write(dates: FeedDates): void
}

/** The store in a file of the data folder. */
export function fileFeedDateStore(userDataPath: string, log: (line: string) => void = (line) => console.warn(line)): FeedDateStore {
  const path = join(userDataPath, FEED_MEMORY_FILE)
  return {
    read: () => {
      let text: string
      try {
        text = readFileSync(path, 'utf8')
      } catch (error) {
        // Nothing there yet is the usual case (a first launch, a first feed): no line for that.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(`[update] the memory of the feed dates could not be read, so none is kept: ${(error as Error).message}`)
        return {}
      }
      try {
        return cleanFeedDates(JSON.parse(text) as unknown)
      } catch (error) {
        log(`[update] the memory of the feed dates is damaged, so none is kept: ${(error as Error).message}`)
        return {}
      }
    },
    write: (dates) => replaceFileDurably(path, `${JSON.stringify(dates)}\n`)
  }
}

/**
 * A reader of the feed that applies the anti-replay rule to what `read` gives: a feed older than the last one accepted for its address fails (the reason is
 * the one the check says, the cause goes to the error log with the address), and the date of a feed that is accepted is remembered. Nothing else changes: the
 * answer of a reader that already failed, or of a feed the rule does not judge (a GitHub answer, a macOS file without a usable date), goes through as it was.
 * Reading and writing the memory are synchronous and sit in one turn of the event loop, so two looks that end together cannot overwrite each other's date.
 */
export function freshFeedReader(
  read: (url: string) => Promise<FeedAnswer>,
  store: () => FeedDateStore,
  target: () => FeedTarget,
  log: (line: string) => void = (line) => console.error(line)
): (url: string) => Promise<FeedAnswer> {
  return async (url) => {
    const answer = await read(url)
    if (!answer.ok) return answer
    const memory = store()
    const judged = judgeFeedDate(answer, url, target(), memory.read())
    if (judged.refusal) log(`[update] the update feed ${url} is refused: ${judged.refusal}. No update is offered and no version is said withdrawn`)
    if (judged.changed) {
      try {
        memory.write(judged.memory)
      } catch (error) {
        log(`[update] the date of the update feed ${url} could not be kept, so a later replay of an older feed would not be seen: ${(error as Error).message}`)
      }
    }
    return judged.answer
  }
}
