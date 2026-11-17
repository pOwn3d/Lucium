// Where Lucium looks for a newer version, and where it may install one from (Lucium › Rechercher les mises à jour…, the About window).
//
// The rule: the built application installs only from the addresses built into it (`MAIN_VITE_UPDATE_FEED`, the stable channel, and
// `MAIN_VITE_UPDATE_FEED_TEST`, the test channel, written by electron-vite at build time, inside app.asar, which the integrity fuse and the
// Developer ID signature seal). Never from LUCIUM_UPDATE_FEED (another process can set it), never from the `updateFeedUrl` setting (a file of
// the profile). Squirrel.Mac installs any build signed by the same team: a feed that another party could name could push an older build of ours,
// so nothing but a built-in address may reach it.
//
// Two channels (the maintainer's decision of 7 November 2026): a build carries the stable address, and may carry a test one. The `updateChannel`
// setting (`stable` by default) only chooses between the two sealed addresses, so that a profile file still cannot name an address: `test` is
// followed only by a build that carries a test address, and a build with one address behaves as it always did, whatever the setting says.
//
// The look runs when the user asks (the menu command, the About button), and in the background while "Rechercher les mises à jour automatiquement"
// is on (auto-update.ts, `backgroundFeed`): the built application then reads the same address as the menu, the built-in one (the maintainer's
// decision of 5 November 2026: the notice of an update comes by itself). A run from the sources never reads the built-in address in the
// background. A build without a built-in address keeps the old behaviour: the address of the environment or of the setting, and a download page
// opened in the browser.

import type { Settings, UpdateChannel } from '@shared/model'
import { isBuiltApp } from '../runtime'

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
  /** LUCIUM_UPDATE_FEED (taken out of the environment of the built application at start-up: runtime.ts). */
  env: string | undefined
  /** The `updateFeedUrl` setting of the profile. */
  setting: string
}

export interface UpdateSources {
  /** The feed the check reads; empty when none is configured. */
  check: string
  /** The feed Squirrel installs from, or null when this run cannot install (not built, not macOS, no built-in https address). */
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
  const builtIn = channelFeed(facts)
  const install = facts.builtApp && facts.platform === 'darwin' && https(builtIn) ? builtIn : null
  if (install) return { check: install, install }
  return { check: (facts.env ?? facts.setting).trim() || builtIn, install: null }
}

/**
 * The feed the background look reads (Réglages › Général, "Rechercher les mises à jour automatiquement"), or null when nothing is to be read:
 * - the setting off: null, whatever else is configured;
 * - the built application: the feed the menu reads (`updateSources`), the built-in address when the build has one, else the one written by hand;
 * - a run from the sources: only an address given by hand (the variable, then the setting), never the built-in one;
 * and always an https address, or null.
 */
export function backgroundFeed(facts: UpdateSourceFacts, autoUpdate: boolean): string | null {
  if (!autoUpdate) return null
  const feed = facts.builtApp ? updateSources(facts).check : (facts.env ?? facts.setting).trim()
  return https(feed) ? feed : null
}

/** The stable address built into this application by electron-vite (replaced by a literal at build time). */
export const builtInFeed = (): string => (import.meta.env.MAIN_VITE_UPDATE_FEED ?? '').trim()

/** The test address built into this application by electron-vite (replaced by a literal at build time); empty for a build made without `--test-feed`. */
export const builtInTestFeed = (): string => (import.meta.env.MAIN_VITE_UPDATE_FEED_TEST ?? '').trim()

/** Whether this build carries a test channel: the Settings show « Recevoir les versions de test » only then (the snapshot's `updateTestChannel`). */
export const testChannelAvailable = (): boolean => hasTestFeed(builtInTestFeed())

/** What the snapshot of a window says of the build: `updateTestChannel` while it carries a test address, nothing otherwise (the Settings hide the choice then). */
export const testChannelOfSnapshot = (): { updateTestChannel?: true } => (testChannelAvailable() ? { updateTestChannel: true } : {})

/** The settings the addresses depend on. */
export type UpdateSourceSettings = Pick<Settings, 'updateFeedUrl' | 'updateChannel'>

const currentFacts = (settings: UpdateSourceSettings): UpdateSourceFacts => ({
  builtIn: builtInFeed(),
  builtInTest: builtInTestFeed(),
  channel: settings.updateChannel,
  builtApp: isBuiltApp(),
  platform: process.platform,
  env: process.env['LUCIUM_UPDATE_FEED'],
  setting: settings.updateFeedUrl
})

/** The two addresses of this run. */
export function currentUpdateSources(settings: UpdateSourceSettings): UpdateSources {
  return updateSources(currentFacts(settings))
}

/** The feed the background look of this run reads for these settings, or null. */
export function currentBackgroundFeed(settings: UpdateSourceSettings & Pick<Settings, 'autoUpdate'>): string | null {
  return backgroundFeed(currentFacts(settings), settings.autoUpdate)
}
