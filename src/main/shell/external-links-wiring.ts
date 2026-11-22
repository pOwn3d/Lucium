// A part of main() (index.ts), moved out as it was: the links other applications send (and the commands by address, `lucium://…`), where
// they open, the ones that wait for the unlocking, and a second launch of the program. Called where its lines were (after the windows are restored
// and woken), in two steps so that index.ts holds `openExternalUrl` and `flushDeferredLinks` before the first link is opened, as it did. The links
// of the very start wait in index.ts (`pendingExternalUrls`), before the window exists: `listen` opens them.

import { app } from 'electron'
import { routeFor } from '@shared/routing'
import { activeProfileId, profileSearch } from '@shared/profiles'
import { isAutomationUrl } from '@shared/automation-url'
import type { LaunchWindow } from '@shared/launch-flags'
import { isNavigableUrl } from '@shared/url'
import { tp } from '@shared/i18n'
import { WAITING_LINKS_MAX, WaitingLinks } from '@shared/waiting-links'
import type { LockService } from '../lock-service'
import type { WindowView } from '../store'
import { Automation, getAutomation, setAutomation } from './automation'
import type { Browser } from './browser'
import type { LittleArc } from './little'
import { handleFirstLaunchSwitches, handleSecondLaunch } from './single-instance'
import type { WindowManager } from './windows'

export interface ExternalLinksDeps {
  browser: Browser
  store: WindowView
  lock: LockService
  little: LittleArc
  windowManager: WindowManager
  focusMain: () => void
  /** The links that arrived before the browser was ready (index.ts keeps them from the start). */
  pendingExternalUrls: WaitingLinks
}

export interface ExternalLinks {
  /** Opens a link another application sent, or runs a command by address. */
  openExternalUrl: (url: string) => void
  /** Opens the links that waited for the unlocking. */
  flushDeferredLinks: () => void
  /** Opens the links that waited for the browser, then hears a second launch of the program: called once index.ts holds the two above, as before. */
  listen: () => void
}

export function installExternalLinks({ browser, store, lock, little, windowManager, focusMain, pendingExternalUrls }: ExternalLinksDeps): ExternalLinks {
  let openExternalUrl: ((url: string) => void) | null = null
  // A link another application sends while Lucium is locked waits for the unlocking.
  const deferredLinks = new WaitingLinks()
  /** Opens the links that waited, and says how many a queue that was full did not keep (waiting-links.ts). */
  const openWaitingLinks = (waiting: WaitingLinks): void => {
    const { links, dropped } = waiting.take()
    for (const url of links) openExternalUrl?.(url)
    if (dropped > 0) {
      console.warn(`[links] ${dropped} link(s) from other applications were not kept: at most ${WAITING_LINKS_MAX} wait`)
      browser.showToast(tp('app.liens-en-attente-non-ouverts', dropped, { max: WAITING_LINKS_MAX }))
    }
  }
  const flushDeferredLinks = () => openWaitingLinks(deferredLinks)
  // A web address in a tab of the main window, in the space the link rules pick (a rule for the host) or where the user is.
  const openInTab = (url: string, spaceId: ReturnType<typeof routeFor>) => {
    browser.dispatch({ type: 'tab/open', url, spaceId })
    focusMain()
  }
  // Commands by address (`lucium://open?url=…`, shared/automation-url.ts) reach the application the way a link from another app does, and open
  // their pages through the same placement. Off by default; a locked application drops them instead of keeping them for later.
  setAutomation(
    new Automation({
      enabled: () => store.get().settings.urlAutomation,
      locked: () => lock.isAppLocked(),
      openTab: (url) => openInTab(url, routeFor(url, store.get().settings.linkRoutes, store.get().spaces)),
      newTab: () => {
        focusMain()
        browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
      },
      searchTemplate: () => profileSearch(store.get().settings, activeProfileId(store.get())).url,
      now: () => Date.now()
    })
  )
  openExternalUrl = (url) => {
    if (isAutomationUrl(url)) {
      getAutomation()?.handle(url)
      return
    }
    if (lock.isAppLocked()) {
      deferredLinks.add(url)
      return
    }
    if (!isNavigableUrl(url)) {
      console.warn(`[links] ignored a non-web link from another app: ${url.split(':')[0]}:`)
      return
    }
    // A file of the disk (the Finder opened it with Lucium) is not a link from the web: it opens in a tab of the main window, where the user is, never in
    // a mini window and never by a rule for a host (it has none).
    if (url.startsWith('file:')) {
      openInTab(url, undefined)
      return
    }
    const state = store.get()
    // A rule for this host picks the space; otherwise the link opens where the user is.
    const spaceId = routeFor(url, state.settings.linkRoutes, state.spaces)
    // A routing rule wins; otherwise a link from another app opens in a mini window (the default).
    if (!spaceId && state.settings.externalLinksInLittleArc) {
      little.open(url)
      return
    }
    openInTab(url, spaceId)
  }
  // --new-window and --private-window obey the setting of the commands by address (single-instance.ts).
  const launchSwitches = {
    isAppLocked: () => lock.isAppLocked(),
    windowSwitchesAllowed: () => store.get().settings.urlAutomation,
    openLaunchWindow: (kind: LaunchWindow) => void (kind === 'private' ? windowManager.openPrivate({ commandBar: true }) : windowManager.newWindow({ commandBar: true }))
  }
  const listen = (): void => {
    openWaitingLinks(pendingExternalUrls)
    handleFirstLaunchSwitches(process.argv, launchSwitches)
    // A second launch hands its links over, or asks for a window of its own, which a locked application does not open (shell/single-instance.ts).
    app.on('second-instance', (_e, argv) =>
      handleSecondLaunch(argv, {
        openLink: (url) => openExternalUrl?.(url),
        newWindow: () => void windowManager.newWindow({ commandBar: true }),
        focusMain,
        ...launchSwitches
      })
    )
  }
  return { openExternalUrl, flushDeferredLinks, listen }
}
