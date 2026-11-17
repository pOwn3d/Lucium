// Engine checks for the platform layer (main/platform), run inside a real Electron. On the machine the suite runs on (macOS), the point is that
// moving the platform-specific calls behind the layer changed nothing: the same options reach the windows, the same entries are in the menu,
// the same answers come back. A Windows or Linux run would show, in the same file, that the layer reads its own system (the checks that
// depend on the system are written for every system, so that file is where the first run on a new machine starts).
// `LUCIUM_SMOKE_ONLY=platforms` runs only this file (see index.ts). Nothing here shows a system prompt, runs a program that changes anything,
// or opens a window.

import { Menu, systemPreferences } from 'electron'
import { PLATFORM_FACTS, platformOf } from '@shared/platform'
import { SETTINGS_WINDOW_OPTIONS } from './shell/settings-window'
import type { SmokeContext } from './smoke'
import { currentPlatform, createPlatform } from './platform'
import { noteCheck, recorderOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void

/** The labels of an application menu, level by level, for the entries a macOS menu has and the other systems' lose. */
function labelsOf(menu: Menu | null): string[] {
  return menu ? menu.items.map((item) => item.label) : []
}

function submenuLabels(menu: Menu | null, label: string): string[] {
  const item = menu?.items.find((entry) => entry.label === label)
  return item?.submenu ? item.submenu.items.map((entry) => entry.label || entry.role || entry.type) : []
}

async function smokePlatforms({ browser, win }: SmokeContext, check: Check): Promise<void> {
  const platform = currentPlatform()
  const mac = process.platform === 'darwin'

  check('the layer reads the system this process runs on', platform.id === platformOf(process.platform), `${platform.id} / ${process.platform}`)
  check('its facts are the ones written for that system', platform.facts === PLATFORM_FACTS[platform.id])

  // The windows: macOS keeps the system's buttons where they always were; the others keep the title bar of the system for now.
  check(
    'the Settings window has the options it always had on macOS, and the system title bar elsewhere',
    mac
      ? SETTINGS_WINDOW_OPTIONS.titleBarStyle === 'hidden' && SETTINGS_WINDOW_OPTIONS.trafficLightPosition?.x === 9 && SETTINGS_WINDOW_OPTIONS.trafficLightPosition?.y === 9
      : SETTINGS_WINDOW_OPTIONS.titleBarStyle === undefined && SETTINGS_WINDOW_OPTIONS.trafficLightPosition === undefined,
    JSON.stringify({ style: SETTINGS_WINDOW_OPTIONS.titleBarStyle, lights: SETTINGS_WINDOW_OPTIONS.trafficLightPosition })
  )
  check('the main window can still ask where the buttons are meant to be', typeof browser.trafficLights().visible === 'boolean')

  // The menu: macOS keeps every entry of the menu (including the ones only macOS can use); the others lose exactly those.
  const menu = Menu.getApplicationMenu()
  const application = submenuLabels(menu, 'Lucium')
  const edit = submenuLabels(menu, 'Édition')
  check('the application menu is there with its first and last entries', labelsOf(menu)[0] === 'Lucium' && labelsOf(menu).at(-1) === 'Aide', labelsOf(menu).join(' | '))
  check('Services, Hide and the Substitutions and Speech menus are in the menu on macOS and out of it elsewhere', mac ? application.includes('Services') && application.includes('Masquer Lucium') && edit.includes('Substitutions') && edit.includes('Parole') : !application.includes('Services') && !application.includes('Masquer Lucium') && !edit.includes('Substitutions') && !edit.includes('Parole'), `${application.join(' | ')} // ${edit.join(' | ')}`)
  check('Settings and Quit are in the menu on every system', application.includes('Réglages…') && application.includes('Quitter Lucium'))

  // Shortcuts.
  const newTab = menu?.items.find((entry) => entry.label === 'Fichier')?.submenu?.items.find((entry) => entry.label === 'Nouvel onglet…')
  check('a shortcut of the menu is the one of the system', newTab?.accelerator === 'CmdOrCtrl+T', String(newTab?.accelerator))
  check('the full screen shortcut is the one of macOS there, F11 elsewhere', platform.accelerator('fullscreen', undefined) === (mac ? 'Ctrl+CmdOrCtrl+F' : 'F11'), String(platform.accelerator('fullscreen', undefined)))

  // Touch ID: only asked whether it can, never prompted.
  const touch = platform.touchId(systemPreferences)
  check('Touch ID is offered exactly when macOS says it can', mac ? touch.available() === systemPreferences.canPromptTouchID() : touch.available() === false, String(touch.available()))

  // The battery: a real read, whatever the machine is (a desktop has no battery: unknown).
  const percent = await platform.batteryPercent()
  check('the charge of the battery is a percentage or unknown', percent === null || (Number.isInteger(percent) && percent >= 0 && percent <= 100), String(percent))
  // Away from macOS the reading must not depend on pmset: a simulated Linux without a battery says unknown and runs no program.
  const simulated = await createPlatform('linux', { powerSupplies: () => Promise.resolve([]), pmset: () => Promise.reject(new Error('pmset must not run')) }).batteryPercent()
  check('a simulated Linux without a battery reads nothing and does not run pmset', simulated === null)

  // Words.
  check('the download menu names the file manager of the system', platform.revealLabel === (mac ? 'Afficher dans le Finder' : platform.id === 'win32' ? 'Afficher dans l’Explorateur de fichiers' : 'Afficher dans le dossier'), platform.revealLabel)
  check('a first launch with a link on the command line is handled only where the system has no event for it', platform.commandLineLinks(['x', 'https://example.org/']).length === (mac ? 0 : 1))
  check('the window of this run is still alive after the layer was asked everything', !win.isDestroyed())
}

export async function runPlatformsSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokePlatforms(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokePlatforms ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_PLATFORMS ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
