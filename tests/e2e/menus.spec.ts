// The application menu: the entries the user reaches with the shortcuts of src/shared/keybindings.ts are in it, and the entries chosen here
// open what they say. The effects of the tab entries are checked in tabs.spec.ts.

import { expect, test } from '@playwright/test'
import { launchLucium, type Running } from './launch'
import { chooseMenuEntry, defaultShortcut, isSettingsWindowUrl, menuAccelerators, waitForWindow } from './helpers'

/** The spelling of an accelerator that the comparison uses (Electron writes `Cmd+T` where the catalogue writes `CmdOrCtrl+T`). */
const spelling = (accelerator: string) => accelerator.replace(/cmdorctrl|commandorcontrol|command|cmd/gi, 'mod').replace(/option/gi, 'alt').replace(/control/gi, 'ctrl').replace(/\s+/g, '').toLowerCase()

/** The shortcuts the user is told about (src/shared/keybindings.ts), that the menu must hold. */
const SHORTCUTS = ['CmdOrCtrl+T', 'CmdOrCtrl+W', 'CmdOrCtrl+Shift+T', 'CmdOrCtrl+L', 'CmdOrCtrl+,', defaultShortcut('newLittleArc'), 'CmdOrCtrl+Shift+J', 'CmdOrCtrl+D', defaultShortcut('archive')]

let running: Running

test.beforeEach(async () => {
  running = await launchLucium()
})

test.afterEach(async () => {
  await running.close()
})

test('the menu holds every shortcut of the catalogue', async () => {
  const held = (await menuAccelerators(running.app)).map(spelling)
  const missing = SHORTCUTS.filter((shortcut) => !held.includes(spelling(shortcut)))
  expect(missing).toEqual([])
})

test('the entry of ⌘, opens the Settings window', async () => {
  await chooseMenuEntry(running.app, 'CmdOrCtrl+,')
  const settings = await waitForWindow(running.app, isSettingsWindowUrl)
  await expect(settings.locator('.settings-cat').first()).toBeVisible()
})
