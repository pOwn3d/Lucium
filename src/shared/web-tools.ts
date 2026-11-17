// The optional web tools (QR code, autoscroll, mouse gestures, synchronized scrolling, page watching, reading aloud, battery
// saver): every one is a setting that is off by default, and costs nothing while it is off. This file is what the
// settings of them are made of when they are read back, and the one place that says whether a tool is on.

import { defaultSettings, type Settings } from './model'
import { cleanPageWatches } from './page-watch'
import { cleanSleepHosts } from './sleep'

export type WebToolsSettings = Pick<
  Settings,
  'qrCode' | 'autoScroll' | 'scrollSync' | 'mouseGestures' | 'mouseGestureExcludedHosts' | 'pageWatch' | 'pageWatches' | 'readAloud' | 'batterySaver'
>

/** The keys of the on/off switches, in the order the settings list them. */
export const WEB_TOOL_SWITCHES = ['qrCode', 'autoScroll', 'scrollSync', 'mouseGestures', 'pageWatch', 'readAloud', 'batterySaver'] as const satisfies readonly (keyof Settings)[]

/** A switch is on only when the file holds exactly `true`: anything else (a string, a number, nothing) is the default, which is off. */
export function cleanWebToolsSettings(settings: Settings): WebToolsSettings {
  const defaults = defaultSettings()
  const flags = Object.fromEntries(WEB_TOOL_SWITCHES.map((key) => [key, settings[key] === true ? true : defaults[key]])) as Pick<Settings, (typeof WEB_TOOL_SWITCHES)[number]>
  return {
    ...flags,
    mouseGestureExcludedHosts: cleanSleepHosts(settings.mouseGestureExcludedHosts),
    pageWatches: cleanPageWatches(settings.pageWatches)
  }
}
