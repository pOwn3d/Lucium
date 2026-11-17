// The Settings window as a user drives it: the search (its words and its synonyms, nothing found, Escape, the shortcuts ⌘F and /), « Plus de réglages »,
// the sidebar of pages with the arrow keys and the dot of the pages that hold a changed setting, "Rétablir" with its undo, the buttons of the presets, the
// subpages, and the names the controls give to assistive technology.

import { expect, test, type Page } from '@playwright/test'
import { launchLucium, type Running } from './launch'
import { defaultSettings, type Settings } from '../../src/shared/model'
import { PRESETS, presetKeys, presetOf, type PresetId } from '../../src/shared/settings-presets'
import { openSettings, openSettingsPage, SETTINGS_PAGE_IDS, setSettings, settingsOnDisk, waitForStateFile } from './helpers'

let running: Running
let settings: Page

test.beforeEach(async () => {
  running = await launchLucium()
  // The tests read texts of the interface (a word typed in the search, the name of a subpage): French, which the interface is without translation. By
  // default it follows the language of the system, and a runner may have another.
  await setSettings(running.page, { interfaceTranslated: false })
  settings = await openSettings(running.app)
})

test.afterEach(async () => {
  await running.close()
})

/** The row of a setting, drawn in the Settings window (its switch is clicked the way a mouse click reaches it). */
const row = (key: string) => settings.locator(`main.settings-content .pref-row[data-setting="${key}"]`).first()

test.describe('search', () => {
  test('a word finds the row of the setting it names', async () => {
    await settings.locator('.settings-search').fill('publicités')
    await expect(settings.locator('.settings-results')).toBeVisible()
    await expect(settings.locator('.settings-results .pref-row[data-setting="blockAds"]')).toBeVisible()
  })

  test('a synonym finds a row whose own words do not say it: "ads" finds the blocker of advertising', async () => {
    await settings.locator('.settings-search').fill('ads')
    await expect(settings.locator('.settings-results .pref-row[data-setting="blockAds"]')).toBeVisible()
  })

  test('a synonym finds the automatic copies: "backup" finds autoBackup', async () => {
    await settings.locator('.settings-search').fill('backup')
    await expect(settings.locator('.settings-results .pref-row[data-setting="autoBackup"]')).toBeVisible()
  })

  test('a search with no result says so and offers words to try', async () => {
    await settings.locator('.settings-search').fill('zzqxwv')
    await expect(settings.locator('.settings-empty')).toBeVisible()
    await expect(settings.locator('.settings-empty .settings-suggestions button').first()).toBeVisible()
  })

  test('Escape clears the search and gives back the category that was shown', async () => {
    await openSettingsPage(settings, 'tabs')
    const search = settings.locator('.settings-search')
    await search.fill('ads')
    await search.press('Escape')
    await expect(search).toHaveValue('')
    await expect(settings.locator('.settings-cat[data-cat="tabs"]')).toHaveAttribute('aria-current', 'page')
  })

  test('⌘F and "/" put the cursor in the search', async () => {
    // The title of the window bar is a drag area (no click reaches it): the title of the pane takes the focus away from the search.
    await settings.locator('h2.settings-pane-title').click()
    await settings.keyboard.press('/')
    await expect(settings.locator('.settings-search')).toBeFocused()
    await settings.locator('h2.settings-pane-title').click()
    await settings.keyboard.press('Meta+f')
    await expect(settings.locator('.settings-search')).toBeFocused()
  })
})

test.describe('« Plus de réglages »', () => {
  test('opens on a click and draws the rows that wait in it, which its line named; nothing is kept in the state', async () => {
    await openSettingsPage(settings, 'appearance')
    // The rows in the fold stay in the markup, hidden: the rows drawn are the ones with a box on the page.
    const drawnRows = () => settings.locator('main.settings-content .pref-row').evaluateAll((rows) => rows.filter((row) => row.getClientRects().length > 0).length)
    const top = await drawnRows()
    const toggle = settings.locator('main.settings-content .more-settings-toggle')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle.locator('.more-settings-what')).toContainText('Fenêtre')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(drawnRows).toBeGreaterThan(top)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(drawnRows).toBe(top)
  })
})

test.describe('the sidebar', () => {
  test('a page that holds a setting not at its default says so with a dot and its count, and « Réglages modifiés » counts it', async () => {
    const dot = settings.locator('.settings-cat[data-cat="appearance"] .settings-cat-changed')
    const link = settings.locator('.settings-changed-link')
    // A new profile has nothing changed on this page.
    await expect(dot).toHaveCount(0)
    await setSettings(running.page, { forceReduceMotion: true })
    await expect(dot).toHaveCount(1)
    // The dot is no text: a screen reader is told how many settings of the page changed.
    await expect(dot.locator('.sr-only')).toHaveText(/^1 /)
    await expect(link).toBeEnabled()
    await expect(link.locator('.settings-changed-count')).toHaveText(/^[1-9]\d*$/)
    await setSettings(running.page, { forceReduceMotion: false })
    await expect(dot).toHaveCount(0)
  })
})

test.describe('presets', () => {
  // The three presets drawn as buttons; the fourth, « Quand vous ouvrez Lucium », is a menu that settings-choices.spec.ts changes with the others.
  const ROWS: ReadonlyArray<{ pageId: 'tabs' | 'navigation' | 'protection'; presetRow: string; id: PresetId }> = [
    { pageId: 'tabs', presetRow: '.preset-row[data-setting="sleepAfterMinutes"]', id: 'veille' },
    { pageId: 'navigation', presetRow: '.preset-row[data-setting="externalLinksInLittleArc"]', id: 'liens' },
    { pageId: 'protection', presetRow: '.preset-row[data-search="protectionLevel"]', id: 'protection' }
  ]
  for (const { pageId, presetRow, id } of ROWS) {
    test(`${id}: each button writes the settings of its option, and « Annuler » puts them back`, async () => {
      const preset = PRESETS[id]
      // The state file over the defaults of a new profile, as settings-choices.spec.ts reads the menu of the launch.
      const onDisk = (): Settings => ({ ...defaultSettings(), ...settingsOnDisk(running.dataDir) }) as Settings
      const written = (): string => JSON.stringify(presetKeys(preset).map((key) => (onDisk() as unknown as Record<string, unknown>)[key]))
      await openSettingsPage(settings, pageId)
      await waitForStateFile(running.dataDir)
      const buttons = settings.locator(`main.settings-content ${presetRow} .preset-buttons`)
      await expect(buttons).toHaveAttribute('role', 'radiogroup')
      const start = written()
      for (const option of preset.options) {
        const button = buttons.locator(`[data-option="${option.id}"]`)
        // The option the profile is on writes nothing: no notice comes with it.
        if ((await button.getAttribute('aria-checked')) === 'true') continue
        await button.click()
        await expect(button).toHaveAttribute('aria-checked', 'true')
        await waitForStateFile(running.dataDir)
        await expect.poll(() => presetOf(preset, onDisk()), { message: `${id}: ${option.id} saved` }).toBe(option.id)

        // « Annuler » of the notice that says how many settings changed.
        await settings.locator(`main.settings-content ${presetRow} .preset-notice .link-button`).click()
        await waitForStateFile(running.dataDir)
        await expect.poll(written, { message: `${id}: ${option.id} undone` }).toBe(start)
      }
    })
  }
})

test.describe('reset of a category', () => {
  test('a changed setting is put back by "Rétablir", and "Annuler" brings the change back', async () => {
    await openSettingsPage(settings, 'appearance')
    await waitForStateFile(running.dataDir)
    const before = settingsOnDisk(running.dataDir).forceReduceMotion === true
    const input = row('forceReduceMotion').locator('input[role="switch"]')
    await input.evaluate((element) => (element as unknown as { click: () => void }).click())
    await waitForStateFile(running.dataDir)
    await expect.poll(() => settingsOnDisk(running.dataDir).forceReduceMotion).toBe(!before)

    await settings.locator('.reset-bar button').click()
    await waitForStateFile(running.dataDir)
    await expect.poll(() => settingsOnDisk(running.dataDir).forceReduceMotion).toBe(before)

    await expect(settings.locator('.settings-toast')).toBeVisible()
    await settings.locator('.settings-toast button').click()
    await waitForStateFile(running.dataDir)
    await expect.poll(() => settingsOnDisk(running.dataDir).forceReduceMotion).toBe(!before)
  })
})

test.describe('keyboard and names', () => {
  test('the arrow keys move down and up the sidebar and open the page they reach', async () => {
    await settings.locator('.settings-cat[data-cat="home"]').focus()
    await settings.keyboard.press('ArrowDown')
    await expect(settings.locator('.settings-cat[data-cat="appearance"]')).toBeFocused()
    await expect(settings.locator('.settings-cat[data-cat="appearance"]')).toHaveAttribute('aria-current', 'page')
    await settings.keyboard.press('ArrowUp')
    await expect(settings.locator('.settings-cat[data-cat="home"]')).toBeFocused()
    await settings.keyboard.press('End')
    await expect(settings.locator('.settings-cat[data-cat="about"]')).toBeFocused()
    await settings.keyboard.press('Home')
    await expect(settings.locator('.settings-cat[data-cat="home"]')).toBeFocused()
  })

  test('each entry of the sidebar says its name', async () => {
    const entries = settings.locator('.settings-cat')
    await expect(entries).toHaveCount(SETTINGS_PAGE_IDS.length)
    for (const entry of await entries.all()) {
      await expect(entry.locator('.settings-cat-name')).not.toBeEmpty()
    }
  })

  test('the band, the search and the window title have names', async () => {
    await expect(settings.locator('nav.settings-nav')).toHaveAttribute('aria-label', /.+/)
    await expect(settings.locator('.settings-search')).toHaveAttribute('aria-label', /.+/)
    await expect(settings.locator('h1.settings-title')).toBeVisible()
  })

  test('every switch of the page has a name for assistive technology', async () => {
    await openSettingsPage(settings, 'home')
    const unnamed = await settings.locator('main.settings-content input[role="switch"]').evaluateAll((inputs) => inputs.filter((input) => !(input.getAttribute('aria-label') ?? '').trim()).length)
    expect(unnamed).toBe(0)
  })

  test('the button of « Plus de réglages » says whether it is open, and names the region it opens', async () => {
    await openSettingsPage(settings, 'tabs')
    const toggle = settings.locator('main.settings-content .more-settings-toggle')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const region = await toggle.getAttribute('aria-controls')
    expect(region).toBeTruthy()
    await expect(settings.locator(`[id="${region}"]`)).toBeHidden()
  })

  test('a subpage opens from the keyboard on its name, and Escape leads back to its row', async () => {
    await openSettingsPage(settings, 'protection')
    const entry = settings.locator('main.settings-content [data-subpage-entry="network"] button')
    await expect(entry).toContainText('DNS chiffré et proxy')
    await entry.focus()
    await settings.keyboard.press('Enter')
    await expect(settings.locator('#pane-heading')).toHaveText('DNS chiffré et proxy')
    await expect(settings.locator('#pane-heading')).toBeFocused()
    await expect(settings.locator('main.settings-content .subpage-back')).toHaveAttribute('aria-label', 'Revenir à Vie privée et sécurité')
    await expect(settings.locator('.settings-cat[data-cat="protection"]')).toHaveAttribute('aria-current', 'page')
    await settings.keyboard.press('Escape')
    await expect(settings.locator('#pane-heading')).toHaveText('Vie privée et sécurité')
    await expect(entry).toBeFocused()
  })
})
