// Which tools a page carries, from the settings and the site it is on: the one place that decides (Browser.toolsFor asks it). All off costs
// one comparison per setting and hands back the shared frozen "none", so that a page with nothing to carry is compared by identity.

import { gesturesOn } from './gestures'
import type { Settings } from './model'
import { NO_PAGE_TOOLS, type PageTools } from './page-tools'
import { vimKeysOn } from './vim-keys'

type ToolSettings = Pick<Settings, 'autoScroll' | 'mouseGestures' | 'mouseGestureExcludedHosts' | 'scrollSync' | 'vimKeys' | 'vimKeysExcludedHosts'>

/** Whether any tool may be wanted by some page at all (the settings alone): when not, no page is looked at. */
export const anyToolWanted = (settings: ToolSettings): boolean => settings.autoScroll || settings.mouseGestures || settings.scrollSync || settings.vimKeys

/**
 * The tools of a page at `url`: what the settings switched on, minus the gestures and the Vim keys on a site that is left out of them.
 * `scrollSyncCarried` is whether the page is a pane of a split view that scrolls together (decided by the window, not by a setting).
 */
export function pageToolsFor(settings: ToolSettings, url: string, scrollSyncCarried: boolean): PageTools {
  if (!anyToolWanted(settings)) return NO_PAGE_TOOLS
  return {
    autoScroll: settings.autoScroll,
    mouseGestures: gesturesOn(settings.mouseGestures, settings.mouseGestureExcludedHosts, url),
    scrollSync: settings.scrollSync && scrollSyncCarried,
    vimKeys: vimKeysOn(settings.vimKeys, settings.vimKeysExcludedHosts, url)
  }
}
