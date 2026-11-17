// Every menu of choice (the drop-down lists of the Settings window, one row each) is changed to another entry with the keyboard-independent
// selection of a user, and the new entry must reach the state file (persistence); then it goes back to the entry it had. One test per
// category. Numeric fields and text fields are not in this loop: their rows are listed in the report, not covered here.
// No menu leaves the loop in silence: one that is not changed is either declared below with its reason (SKIPPED, GREYED_OUT) or has no setting
// of its own, and each is written in the report of the test; a menu greyed out that nothing declares fails the test.

import { expect, test, type Page } from '@playwright/test'
import { launchLucium, type Running } from './launch'
import { CATALOGUES } from '../../src/shared/i18n'
import { defaultSettings, SEARCH_ENGINES, type Settings } from '../../src/shared/model'
import { PRESETS, presetOf } from '../../src/shared/settings-presets'
import { leaveSubpage, openMoreSettings, openSettings, openSettingsPage, openSubpage, SETTINGS_PAGE_IDS, settingsOnDisk, subpagesOf, waitForStateFile } from './helpers'

const CATEGORIES = SETTINGS_PAGE_IDS

/** Menus the loop does not change, and why: they open a dialog or depend on what is installed on the machine. */
const SKIPPED: Record<string, string> = {
  dohProvider: 'the provider is a choice that only applies with an encrypted DNS: the network check would follow',
  translateTarget: 'the language to translate to: changing it may start a model download',
  translateModelsDir: 'a folder chosen in the file dialog',
  siteAutoplay: 'the menu of the form for a new site: its choice is a draft, written when the site is added (not a setting of the state)',
  linkRoutes: 'the menu of the form for a new rule: its space is a draft, written when the rule is added (the setting is the list of the rules)'
}

/**
 * Pages that draw no menu of choice with the settings of a new profile, and what they hold instead. A page that draws one fails its test until it leaves
 * this list: its menu is then changed like any other. (A page of the list still has its subpages looked at.)
 */
const NO_MENU: Record<string, string> = {
  keyboard: 'switches, and the rows that open the editor of the shortcuts and the lists of sites (subpages)',
  about: 'the switch of the updates and the grid of the icons of the application (buttons)'
}

/**
 * Menus whose row carries no key (`data-setting`) because a preset row stands for the setting it writes, with the setting they keep, by the name the menu
 * gives assistive technology (in each language the interface may have: the language follows the system unless a test sets it). Without this the loop
 * would leave them out as « no setting of its own ».
 */
const KEYED_BY_NAME: Record<string, string> = Object.fromEntries(
  (['fr', 'en'] as const).map((language): [string, string] => [CATALOGUES[language]?.['settings.delai-de-mise-en-veille'] ?? '', 'sleepAfterMinutes']).filter(([name]) => name !== '')
)

/** Menus that are greyed out with the settings of a new profile, and what they wait for. Any other menu found greyed out fails its test. */
const GREYED_OUT: Record<string, string> = {
  sidebarOpacity: 'waits for a translucent window (windowVibrancy other than "none")',
  annotateAutoClearSeconds: 'waits for the automatic clearing of the annotations (annotateAutoClear, in « Fonctions en option »)'
}

/**
 * What the state keeps for a choice of a menu, when the state does not hold the text of the option as it is: the search engine is kept as its
 * address (the menu shows its name), French is the interface without translation (choosing it switches the translation off), and the menu of the
 * preset « Quand vous ouvrez Lucium » (in its row of the windows of the last session) writes the settings of an option, read back as that option.
 */
const SAVED_AS: Record<string, (choice: string, state: Record<string, unknown>) => boolean> = {
  searchUrlTemplate: (name, state) => state['searchUrlTemplate'] === (SEARCH_ENGINES.find((engine) => engine.name === name)?.url ?? name),
  language: (choice, state) => (choice === 'fr' ? state['interfaceTranslated'] === false : state['interfaceTranslated'] === true && state['language'] === choice),
  restoreWindows: (option, state) => presetOf(PRESETS.lancement, { ...defaultSettings(), ...state } as Settings) === option
  // The level of the sleep is no menu any more but a row of buttons (PresetSettings.tsx, measured in preset-settings.test.ts): the one menu of
  // sleepAfterMinutes left is the delay in minutes, kept as it is.
}

const isSaved = (key: string, choice: string, state: Record<string, unknown>): boolean => (SAVED_AS[key] ? SAVED_AS[key](choice, state) : String(state[key]) === choice)

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
  changed: number
  drawn: number
}

/** Changes every menu the view shows to another entry, and back, each checked in the state file. */
async function changeAll(settings: Page, where: string): Promise<Pass> {
  // Every menu of the view, with the setting it keeps: the key of its row, or else the first key of its group (the menu of the language has no
  // row of its own), or else the one KEYED_BY_NAME gives its name. A menu with none (a folder, the notifications of the sites: kept per origin or per
  // folder) is not checked against the settings. In Profils, the menus are the rows that mirror a setting of another category.
  const found = await settings.locator('main.settings-content select').evaluateAll((selects) =>
    selects.map((select) => ({
      key: select.closest('.pref-row')?.getAttribute('data-setting') || select.closest('section')?.getAttribute('data-setting')?.split(' ')[0] || '',
      name: select.getAttribute('aria-label') ?? ''
    }))
  )
  const menus = found.map((menu) => menu.key || KEYED_BY_NAME[menu.name] || '')
  const pass: Pass = { failures: [], left: [], changed: 0, drawn: menus.length }
  for (const [index, key] of menus.entries()) {
    if (key === '') {
      pass.left.push(`${where}: menu n° ${index + 1}: no setting of its own (kept per site, per folder, or a draft)`)
      continue
    }
    if (SKIPPED[key]) {
      pass.left.push(`${key}: ${SKIPPED[key]}`)
      continue
    }
    const select = settings.locator('main.settings-content select').nth(index)
    if (await select.isDisabled()) {
      // A menu greyed out by mistake would leave the loop untested: only the ones declared may be.
      if (GREYED_OUT[key]) pass.left.push(`${key}: greyed out, ${GREYED_OUT[key]}`)
      else pass.failures.push(`${where} › ${key}: greyed out, and nothing in GREYED_OUT says it should be`)
      continue
    }
    try {
      const original = await select.inputValue()
      // Only an entry the user can choose: a disabled entry is greyed out.
      const other = await select.locator('option').evaluateAll(
        (options, current) => options.map((o) => o as unknown as { value: string; disabled: boolean }).find((o) => o.value !== current && !o.disabled)?.value ?? null,
        original
      )
      if (other === null) {
        pass.failures.push(`${where} › ${key}: no other entry can be chosen (a menu of one choice is declared in SKIPPED, with its reason)`)
        continue
      }
      await select.selectOption(other)
      await waitForStateFile(running.dataDir)
      await expect.poll(() => isSaved(key, other, settingsOnDisk(running.dataDir)), { message: `${key} saved`, timeout: 5_000 }).toBe(true)

      await select.selectOption(original)
      await waitForStateFile(running.dataDir)
      await expect.poll(() => isSaved(key, original, settingsOnDisk(running.dataDir)), { message: `${key} saved back`, timeout: 5_000 }).toBe(true)
      pass.changed++
    } catch (error) {
      pass.failures.push(`${where} › ${key}: ${(error as Error).message.split('\n')[0]}`)
    }
  }
  return pass
}

for (const category of CATEGORIES) {
  test(`the menus of choice of ${category} are saved when changed, and back when changed again`, async () => {
    test.setTimeout(300_000)
    const settings = await openSettings(running.app)
    await openSettingsPage(settings, category)
    await openMoreSettings(settings)

    // The page, then each of its subpages (a list, an editor: src/shared/settings-subpages.ts), opened by its row and left by its way back.
    const passes = [await changeAll(settings, category)]
    const noMenu = NO_MENU[category]
    if (noMenu === undefined) expect(passes[0]!.drawn, `menus drawn in ${category}`).toBeGreaterThan(0)
    else {
      expect(passes[0]!.drawn, `${category} draws a menu: it must leave NO_MENU, to be changed like the others`).toBe(0)
      passes[0]!.left.push(`${category}: no menu on the page (${noMenu})`)
    }
    for (const subpage of await subpagesOf(settings)) {
      await openSubpage(settings, subpage)
      passes.push(await changeAll(settings, `${category} › ${subpage}`))
      await leaveSubpage(settings)
    }
    const failures = passes.flatMap((pass) => pass.failures)
    /** The menus the loop did not change, each with its reason: written in the report, never left out in silence. */
    const left = passes.flatMap((pass) => pass.left)
    const changed = passes.reduce((sum, pass) => sum + pass.changed, 0)
    const drawn = passes.reduce((sum, pass) => sum + pass.drawn, 0)
    test.info().annotations.push({ type: 'menus', description: `${changed} changed and changed back of ${drawn}; left: ${left.join(' | ') || 'none'}` })
    console.log(`[settings-choices] ${category}: ${changed} menu(s) changed of ${drawn}; left: ${left.join(' | ') || 'none'}`)
    expect(failures, `menus that did not persist in ${category}`).toEqual([])
  })
}
