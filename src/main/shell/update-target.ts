// The system this copy runs on, as the feeds are read against it (shared/update-target.ts): its platform and architecture, and on Linux the one kind of installer its
// packaging takes (an AppImage reads the feed of AppImages, a .deb the feed of .deb). A copy that is neither reads no feed on Linux, so its kind is left open.

import { runningTarget, type FeedTarget } from '@shared/update-target'
import { currentLinuxInstall } from '../platform/linux-install'

export function currentFeedTarget(): FeedTarget {
  const { packaging } = currentLinuxInstall()
  return runningTarget(process.platform, process.arch, process.platform === 'linux' && packaging ? packaging : undefined)
}
