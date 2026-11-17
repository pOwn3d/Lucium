import { existsSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { launchLucium, type Running } from './launch'
import { openMoreSettings, openSettings, openSettingsPage, pinPanelSize, SETTINGS_PAGE_IDS, SETTINGS_WINDOW_URL } from './helpers'

const CATEGORIES = SETTINGS_PAGE_IDS

let running: Running

test.beforeEach(async () => {
  running = await launchLucium()
})

test.afterEach(async () => {
  await running.close()
})

test('the settings window shows its eleven pages, each with its content', async () => {
  const settings = await openSettings(running.app)
  for (const id of CATEGORIES) {
    await openSettingsPage(settings, id)
    await expect(settings.locator('main.settings-content')).toBeVisible()
  }
})

/**
 * The menu buttons of the page whose value is wider than the room inside them (their width less the padding that holds the chevrons and the icon),
 * as « value: needed > room ». Runs in the page of the Settings: a hidden copy of the text, in the font of the button, gives the width it needs.
 */
function cutMenus(): string[] {
  const probe = document.createElement('span')
  probe.style.cssText = 'position: absolute; left: -10000px; top: 0; visibility: hidden; white-space: pre'
  document.body.append(probe)
  const cut: string[] = []
  for (const select of document.querySelectorAll<HTMLSelectElement>('main.settings-content select')) {
    if (!select.checkVisibility()) continue
    const style = getComputedStyle(select)
    Object.assign(probe.style, { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, fontStyle: style.fontStyle, letterSpacing: style.letterSpacing })
    probe.textContent = select.selectedOptions[0]?.textContent ?? ''
    const room = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    const needed = probe.getBoundingClientRect().width
    // One pixel of slack: the text of the button and its copy are laid out apart, and may round differently.
    if (needed > room + 1) cut.push(`${probe.textContent}: ${Math.ceil(needed)}px > ${Math.floor(room)}px`)
  }
  probe.remove()
  return cut
}

// A menu button shows the whole of its value: at a fixed width, a long one (« Automatique (langue du système) ») was cut under the chevrons.
// Every page, with « Plus de réglages » open.
test('every menu button of the Settings shows its whole value', async () => {
  const settings = await openSettings(running.app)
  const cut: string[] = []
  for (const id of CATEGORIES) {
    await openSettingsPage(settings, id)
    await openMoreSettings(settings)
    cut.push(...(await settings.evaluate(cutMenus)).map((one) => `${id} › ${one}`))
  }
  expect(cut, 'menu buttons whose value is cut').toEqual([])
})

// The visual comparison of the Settings. The pixels depend on the machine (the scale of the screen, the fonts, the version of macOS, the language of
// the system), so there are two sets of reference pictures (playwright.config.ts `snapshotPathTemplate`):
//   - `settings-<category>-darwin-ci.png`, in Git: drawn by the runner of the E2E workflow, the one machine that compares every night. They are
//     drawn again with the workflow's own switch (Actions > E2E > Run workflow > "Draw the reference pictures"), looked at, then committed;
//   - `settings-<category>-darwin-local.png`, not in Git: the pictures of the machine at hand, drawn by its first run.
// A reference that is missing FAILS the test, on a runner as anywhere else: a comparison that is skipped, or that draws its own reference and
// then agrees with it, compares nothing. On a runner nothing is drawn (`updateSnapshots: 'none'`), and the failure says how to draw them. On
// another machine Playwright draws the missing pictures and fails that run; the next run compares with them.
// The window is drawn at 100 %: « Automatique » would size it by the screen of the run, and the picture would hold only part of it (pinPanelSize).
test('each category looks as expected (visual)', async ({}, testInfo) => {
  const missing = CATEGORIES.filter((id) => !existsSync(testInfo.snapshotPath(`settings-${id}.png`, { kind: 'screenshot' })))
  if (testInfo.config.updateSnapshots === 'none') {
    expect(missing, 'reference pictures of the Settings missing on this runner: run the E2E workflow by hand with "Draw the reference pictures", look at the pictures of its artefact "e2e-results", and commit them under tests/e2e/settings.spec.ts-snapshots/').toEqual([])
  }
  await pinPanelSize(running.app, running.page)
  const settings = await openSettings(running.app)
  // Unzoomed, the CSS pixels Playwright measures the page in are those of the window: the picture holds all of it.
  const zoom = await running.app.evaluate(
    ({ BrowserWindow }, source) => BrowserWindow.getAllWindows().find((win) => new RegExp(source).test(win.webContents.getURL()))?.webContents.getZoomFactor() ?? null,
    SETTINGS_WINDOW_URL.source
  )
  expect(zoom, 'the zoom of the Settings window').toBe(1)
  for (const id of CATEGORIES) {
    await openSettingsPage(settings, id)
    await expect(settings.locator('main.settings-content')).toBeVisible()
    await expect(settings).toHaveScreenshot(`settings-${id}.png`, { fullPage: true })
  }
})
