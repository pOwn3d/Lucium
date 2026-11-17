// The check every update feed goes through before a word of it is read: the menu's look (menu-actions.ts) and the background one (auto-update.ts)
// hand it to `feedAnswer` (shared/update-check.ts). The keys are the ones compiled into this application (update-feed-keys.ts); nothing of the
// profile, of the environment or of the feed itself can name another.

import type { FeedSignatureCheck } from '@shared/update-check'
import { UPDATE_FEED_PUBLIC_KEYS } from '../update-feed-keys'
import { verifyFeed } from '../update-feed-signature'

/**
 * The check for the feed read at `feed`. A refusal writes one line to the error log (Settings › Général › État de Lucium), with the address and
 * the reason; the user is told a sentence that says only that the feed has no valid signature.
 */
export function feedSignatureCheck(feed: string, keys: readonly string[] = UPDATE_FEED_PUBLIC_KEYS, log: (line: string) => void = (line) => console.error(line)): FeedSignatureCheck {
  return (bytes) => {
    const verified = verifyFeed(bytes, keys)
    if (verified.ok) return verified.signed
    log(`[update] the update feed ${feed} is refused: ${verified.problem}. No update is offered and no version is said withdrawn`)
    return null
  }
}
