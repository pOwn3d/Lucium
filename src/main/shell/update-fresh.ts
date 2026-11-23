// The anti-replay rule on the two readers of the update feed (menu-actions.ts for the menu and the About button, auto-update.ts for the background look and the
// check before a quit installs): both read the feed through here, so that an older feed than the last one accepted is refused wherever it is asked for.

import { app } from 'electron'
import type { FeedAnswer } from '@shared/update-check'
import { runningTarget } from '@shared/update-target'
import { fileFeedDateStore, freshFeedReader } from '../update-feed-memory'

/** `read`, with the date of publication of the feed it gives checked against the memory of the data folder, and remembered when accepted. */
export const withFeedFreshness = (read: (url: string) => Promise<FeedAnswer>): ((url: string) => Promise<FeedAnswer>) =>
  freshFeedReader(
    read,
    () => fileFeedDateStore(app.getPath('userData')),
    () => runningTarget(process.platform, process.arch)
  )
