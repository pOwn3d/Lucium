// The blocking mode of a site (Standard or Strict, from the site panel): what the state keeps for it, and what the user sees of it. The
// effect of a rule on a request is not tested here: the lists of rules come from the Internet, and the test has no Internet.

import { expect, test } from '@playwright/test'
import { launchLucium, type Running } from './launch'
import { dispatch, openMoreSettings, openSettings, openSettingsPage, settingsOnDisk, waitForStateFile, waitForState } from './helpers'

const SITE = 'example.com'

let running: Running

test.beforeEach(async () => {
  running = await launchLucium()
})

test.afterEach(async () => {
  await running.close()
})

test('a site set to Strict keeps its mode, and "null" makes it follow the general mode again', async () => {
  await dispatch(running.page, { type: 'blocking/site-mode', site: SITE, mode: 'strict' })
  await waitForState(running.page, (s) => s.state.settings.blockModeSites[SITE] === 'strict', 'strict kept')
  await waitForStateFile(running.dataDir)
  await expect.poll(() => settingsOnDisk(running.dataDir).blockModeSites).toMatchObject({ [SITE]: 'strict' })

  await dispatch(running.page, { type: 'blocking/site-mode', site: SITE, mode: null })
  await waitForState(running.page, (s) => s.state.settings.blockModeSites[SITE] === undefined, 'mode of the site removed')
  await waitForStateFile(running.dataDir)
  await expect.poll(() => (settingsOnDisk(running.dataDir).blockModeSites as Record<string, unknown>)[SITE]).toBeUndefined()
})

test('the general blocking mode is a choice of the Protection category, and its value is kept', async () => {
  // The menu is greyed out while no blocker is on: the blocker of advertising is switched on first, by the same setting the switch writes.
  await dispatch(running.page, { type: 'settings/update', patch: { blockAds: true } })
  const settings = await openSettings(running.app)
  await openSettingsPage(settings, 'protection')
  // The mode waits in « Plus de réglages », at the foot of the page: opened, it shows it.
  await openMoreSettings(settings)
  const select = settings.locator('.pref-row[data-setting="blockMode"] select').first()
  await expect(select).toBeEnabled()
  await select.selectOption('strict')
  await waitForStateFile(running.dataDir)
  await expect.poll(() => settingsOnDisk(running.dataDir).blockMode).toBe('strict')
})
