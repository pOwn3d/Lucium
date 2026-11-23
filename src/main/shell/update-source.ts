// Where Lucium looks for a newer version, and where it may install one from (Lucium › Rechercher les mises à jour…, the About window).
//
// The rule: the built application installs only from the addresses built into it (`MAIN_VITE_UPDATE_FEED`, the stable channel, and
// `MAIN_VITE_UPDATE_FEED_TEST`, the test channel, written by electron-vite at build time, inside app.asar, which the integrity fuse and the
// Developer ID signature seal). Never from LUCIUM_UPDATE_FEED (another process can set it), never from the `updateFeedUrl` setting (a file of
// the profile). Squirrel.Mac installs any build signed by the same team: a feed that another party could name could push an older build of ours,
// so nothing but a built-in address may reach it. The same holds on Windows, where the installer the feed names is run: only the built-in address,
// signed by a key of the application, ever names one (windows-update.ts). And on Linux, where an AppImage replaces itself with the file the feed names
// (appimage-update.ts) and a .deb is only told (deb-update.ts): the built-in address of the system is read in the folder of the packaging the copy is
// (`linuxFeedAddress`: `…/linux-x64/appimage/feed.json` or `…/deb/feed.json`), and a copy that is neither reads none.
//
// Two channels (the maintainer's decision of 7 November 2026): a build carries the stable address, and may carry a test one. The `updateChannel`
// setting (`stable` by default) only chooses between the two sealed addresses, so that a profile file still cannot name an address: `test` is
// followed only by a build that carries a test address, and a build with one address behaves as it always did, whatever the setting says.
//
// The look runs when the user asks (the menu command, the About button), and in the background while the switch of the system is on (auto-update.ts,
// `backgroundFeed`): the built application then reads the same address as the menu, the built-in one (the maintainer's decision of 5 November 2026: the
// notice of an update comes by itself). The switch is `autoUpdate` on macOS (on by default) and `windowsAutoUpdate` on Windows (off by default, the maintainer's
// decision of 23 November 2026: AGENTS.md §5, a request nobody asked for is off; shared/platform.ts, `autoUpdateOn`), and the same `windowsAutoUpdate` on Linux.
// A run from the sources never reads the
// built-in address in the background. A build without a built-in address keeps the old behaviour: the address of the environment or of the setting, and a
// download page opened in the browser.

import type { Settings, UpdateChannel } from '@shared/model'
import { linuxFeedAddress, type LinuxPackaging } from '@shared/linux-install'
import { autoUpdateOn, updatesByHand } from '@shared/platform'
import { isBuiltApp } from '../runtime'
import { currentLinuxInstall } from '../platform/linux-install'

const https = (url: string): boolean => /^https:\/\/\S+$/i.test(url)

/** What decides the two addresses. */
export interface UpdateSourceFacts {
  /** The stable address built into the application (empty when the build had none). */
  builtIn: string
  /** The test address built into the application (empty when the build had none). */
  builtInTest: string
  /** The `updateChannel` setting of the profile. */
  channel: UpdateChannel
  /** The built application (`isBuiltApp`), as opposed to a run from the sources. */
  builtApp: boolean
  platform: NodeJS.Platform
  /** On Linux, what this copy is installed as (shared/linux-install.ts): its feed is the one of its packaging, and a copy that is neither reads none. Elsewhere null. */
  packaging: LinuxPackaging | null
  /** LUCIUM_UPDATE_FEED (taken out of the environment of the built application at start-up: runtime.ts). */
  env: string | undefined
  /** The `updateFeedUrl` setting of the profile. */
  setting: string
}

export interface UpdateSources {
  /** The feed the check reads; empty when none is configured. */
  check: string
  /** The feed the installer installs from (Squirrel.Mac, the NSIS installer of Windows, the AppImage that replaces itself), or null when this run cannot install (not built, a .deb, which is only told, a copy that is none of the above, no built-in https address). */
  install: string | null
}

/** Whether a build carries a test address it may follow: an https one (the build script refuses any other; this is the same test, kept in the application). */
export const hasTestFeed = (builtInTest: string): boolean => https(builtInTest.trim())

/**
 * The address built in for the channel this run follows: the test one when the setting asks for the test channel and the build carries one, the
 * stable one in every other case (the default, an unknown word cleaned away, a build that carries no test address).
 */
export function channelFeed(facts: Pick<UpdateSourceFacts, 'builtIn' | 'builtInTest' | 'channel'>): string {
  return facts.channel === 'test' && hasTestFeed(facts.builtInTest) ? facts.builtInTest.trim() : facts.builtIn.trim()
}

/**
 * The feed to read and the feed to install from. When this run can install, both are the built-in address of the channel, so that what the check
 * offers is what Squirrel downloads. Otherwise the check reads the environment, then the setting, then the built-in address (a development build
 * made with one), and nothing installs.
 */
export function updateSources(facts: UpdateSourceFacts): UpdateSources {
  // Windows and Linux builds carry the address of their feed (the CI builds: .github/workflows/windows.yml, linux.yml). Windows reads it (windows-update.ts). On
  // Linux the build is one for both packagings, so the address is the system's and each copy reads the folder of its own (`linuxFeedAddress`); a copy that is
  // neither an AppImage nor a .deb reads no built-in address, so that its check, its menu and its Settings do what they did before the address was there.
  const builtIn = facts.platform === 'linux' ? linuxFeedAddress(channelFeed(facts), facts.packaging) : channelFeed(facts)
  // Only an AppImage installs from it: a .deb is told, with a command to run as root.
  const installs = facts.platform === 'darwin' || facts.platform === 'win32' || (facts.platform === 'linux' && facts.packaging === 'appimage')
  const install = facts.builtApp && installs && https(builtIn) ? builtIn : null
  if (install) return { check: install, install }
  return { check: (facts.env ?? facts.setting).trim() || builtIn, install: null }
}

/**
 * The feed the background look reads (Réglages › Général, "Rechercher les mises à jour automatiquement"), or null when nothing is to be read:
 * - the switch of this system off (`autoUpdateOn`: `autoUpdate` everywhere but Windows, `windowsAutoUpdate` there and only there): null, whatever else is
 *   configured. On Windows `autoUpdate` is not read at all, so that the old switch (on by default in the 1.1.5, never chosen) asks nothing of the network;
 * - the built application: the feed the menu reads (`updateSources`), the built-in address when the build has one, else the one written by hand;
 * - a run from the sources: only an address given by hand (the variable, then the setting), never the built-in one;
 * and always an https address, or null.
 */
export function backgroundFeed(facts: UpdateSourceFacts, switches: UpdateSwitches): string | null {
  if (!autoUpdateOn(switches, facts.platform)) return null
  const feed = facts.builtApp ? updateSources(facts).check : (facts.env ?? facts.setting).trim()
  return https(feed) ? feed : null
}

/** The two switches of the look in the background: the system reads one of them (`autoUpdateOn`). */
export type UpdateSwitches = Pick<Settings, 'autoUpdate' | 'windowsAutoUpdate'>

/** The stable address built into this application by electron-vite (replaced by a literal at build time). */
export const builtInFeed = (): string => (import.meta.env.MAIN_VITE_UPDATE_FEED ?? '').trim()

/** The test address built into this application by electron-vite (replaced by a literal at build time); empty for a build made without `--test-feed`. */
export const builtInTestFeed = (): string => (import.meta.env.MAIN_VITE_UPDATE_FEED_TEST ?? '').trim()

/** Whether this build carries a test channel: the Settings show « Recevoir les versions de test » only then (the snapshot's `updateTestChannel`). */
export const testChannelAvailable = (): boolean => !updatesByHand(process.platform, currentLinuxInstall().packaging) && hasTestFeed(builtInTestFeed())

/** What the snapshot of a window says of the build: `updateTestChannel` while it carries a test address, nothing otherwise (the Settings hide the choice then). */
export const testChannelOfSnapshot = (): { updateTestChannel?: true } => (testChannelAvailable() ? { updateTestChannel: true } : {})

/** What the snapshot of a window says of the update path of this copy: `updatesByHand` when it has none (the Settings then show a sentence, not a switch). */
export const updatesByHandOfSnapshot = (): { updatesByHand?: true } => (updatesByHand(process.platform, currentLinuxInstall().packaging) ? { updatesByHand: true } : {})

/** The settings the addresses depend on. */
export type UpdateSourceSettings = Pick<Settings, 'updateFeedUrl' | 'updateChannel'>

const currentFacts = (settings: UpdateSourceSettings): UpdateSourceFacts => ({
  builtIn: builtInFeed(),
  builtInTest: builtInTestFeed(),
  channel: settings.updateChannel,
  builtApp: isBuiltApp(),
  platform: process.platform,
  packaging: process.platform === 'linux' ? currentLinuxInstall().packaging : null,
  env: process.env['LUCIUM_UPDATE_FEED'],
  setting: settings.updateFeedUrl
})

/** The two addresses of this run. */
export function currentUpdateSources(settings: UpdateSourceSettings): UpdateSources {
  return updateSources(currentFacts(settings))
}

/** The feed the background look of this run reads for these settings, or null. */
export function currentBackgroundFeed(settings: UpdateSourceSettings & UpdateSwitches): string | null {
  return backgroundFeed(currentFacts(settings), settings)
}
