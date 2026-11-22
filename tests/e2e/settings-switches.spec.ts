// Every switch of the Settings window is flipped with a click of the user, and the new value must reach the state file of the data folder
// (persistence), then go back the same way. One test per category, so that a failure names the category (and its subpage); inside, every key
// that failed is listed. The keys in SKIPPED are not flipped here, with the reason: they open a sheet that needs a secret, or they reach the network.
// No switch leaves the loop in silence: one that is not flipped is declared below with its reason (SKIPPED, GREYED_OUT) and written in the
// report of the test; a switch greyed out that nothing declares fails the test.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launchLucium, type Running } from './launch'
import { leaveSubpage, openMoreSettings, openSettings, openSettingsPage, openSubpage, SETTINGS_PAGE_IDS, settingsOnDisk, subpagesOf, waitForStateFile } from './helpers'

const CATEGORIES = SETTINGS_PAGE_IDS

/** Switches that the loop does not flip, and why. Their own tests (or a manual check) cover them. */
const SKIPPED: Record<string, string> = {
  lockEnabled: 'opens the sheet of the passphrase (a secret the test must not type)',
  lockApp: 'same sheet of the passphrase as lockEnabled',
  lockTouchId: 'asks Touch ID, which a test cannot answer',
  webStoreUpdates: 'looks for extension updates on the Chrome Web Store (network)'
}

/** Switches said in the affirmative over a setting stored the other way round: on screen « on » is `false` in the state file. */
const INVERTED: Record<string, string> = {
  historyOff: '« Garder l’historique des pages visitées » is on while historyOff is false'
}

/** Switches that are greyed out with the settings of a new profile, and what they wait for. Any other switch found greyed out fails its test. */
const GREYED_OUT: Record<string, string> = {
  fingerprintStrict: 'waits for the protection against fingerprinting to be on',
  siteDataClearOnQuit: 'waits for the erasure of site data at closing (siteDataClearOnCloseEnabled)',
  siteDataClearOnQuitAll: 'waits for the erasure of site data at closing and for its switch (siteDataClearOnCloseEnabled, siteDataClearOnQuit)',
  translateSystemEngine: 'waits for the translation of the system, which this machine may not have'
}

let running: Running

test.beforeEach(async () => {
  running = await launchLucium()
})

test.afterEach(async () => {
  await running.close()
})

/** What the loop did on one view of the window (a page with its fold open, or one of its subpages). */
interface Pass {
  failures: string[]
  left: string[]
  flipped: number
  drawn: number
}

/** Flips every switch the view shows, and back, each checked in the state file. */
async function flipAll(settings: Page, where: string): Promise<Pass> {
  // In Profils, the switches are the rows that mirror a setting of another category (the only switches of that category).
  const keys = await settings.locator('main.settings-content .pref-row[data-setting]').evaluateAll((rows) =>
    [...new Set(rows.filter((row) => row.querySelector('input[role="switch"]')).map((row) => row.getAttribute('data-setting') ?? ''))].filter(Boolean)
  )
  const pass: Pass = { failures: [], left: [], flipped: 0, drawn: keys.length }
  for (const key of keys) {
    if (SKIPPED[key]) {
      pass.left.push(`${key}: ${SKIPPED[key]}`)
      continue
    }
    const input = settings.locator(`.pref-row[data-setting="${key}"] input[role="switch"]`).first()
    if (await input.isDisabled()) {
      // A switch greyed out by mistake would leave the loop untested: only the ones declared may be.
      if (GREYED_OUT[key]) pass.left.push(`${key}: greyed out, ${GREYED_OUT[key]}`)
      else pass.failures.push(`${where} › ${key}: greyed out, and nothing in GREYED_OUT says it should be`)
      continue
    }
    try {
      const before = await input.isChecked()
      await input.evaluate((element) => (element as unknown as { click: () => void }).click())
      await expect(input).toBeChecked({ checked: !before })
      await waitForStateFile(running.dataDir)
      // The value on disk is what the switch shows, or its opposite for a switch said in the affirmative over a negative setting.
      const stored = (shown: boolean): boolean => (INVERTED[key] ? !shown : shown)
      await expect.poll(() => settingsOnDisk(running.dataDir)[key], { message: `${key} saved`, timeout: 5_000 }).toBe(stored(!before))

      await input.evaluate((element) => (element as unknown as { click: () => void }).click())
      await expect(input).toBeChecked({ checked: before })
      await waitForStateFile(running.dataDir)
      await expect.poll(() => settingsOnDisk(running.dataDir)[key], { message: `${key} saved back`, timeout: 5_000 }).toBe(stored(before))
      pass.flipped++
    } catch (error) {
      pass.failures.push(`${where} › ${key}: ${(error as Error).message.split('\n')[0]}`)
    }
  }
  return pass
}

for (const category of CATEGORIES) {
  test(`the switches of ${category} are saved when flipped and when flipped back`, async () => {
    test.setTimeout(300_000)
    const settings = await openSettings(running.app)
    await openSettingsPage(settings, category)
    // « Plus de réglages » opened: the rows that wait there are drawn too, so that every switch of the page is tested.
    await openMoreSettings(settings)
    // The first change of the window creates the state file: wait for it (the store saves a moment after a change).
    await expect.poll(() => existsSync(join(running.dataDir, 'state.json')), { timeout: 10_000 }).toBe(true)

    // The page, then each of its subpages (a list, an editor: src/shared/settings-subpages.ts), opened by its row and left by its way back.
    const passes = [await flipAll(settings, category)]
    expect(passes[0]!.drawn, `switches drawn in ${category}`).toBeGreaterThan(0)
    for (const subpage of await subpagesOf(settings)) {
      await openSubpage(settings, subpage)
      passes.push(await flipAll(settings, `${category} › ${subpage}`))
      await leaveSubpage(settings)
    }
    const failures = passes.flatMap((pass) => pass.failures)
    /** The switches the loop did not flip, each with its reason: written in the report, never left out in silence. */
    const left = passes.flatMap((pass) => pass.left)
    const flipped = passes.reduce((sum, pass) => sum + pass.flipped, 0)
    const drawn = passes.reduce((sum, pass) => sum + pass.drawn, 0)
    test.info().annotations.push({ type: 'switches', description: `${flipped} flipped and flipped back of ${drawn}; left: ${left.join(' | ') || 'none'}` })
    console.log(`[settings-switches] ${category}: ${flipped} switch(es) flipped of ${drawn}; left: ${left.join(' | ') || 'none'}`)
    expect(failures, `switches that did not persist in ${category}`).toEqual([])
  })
}
