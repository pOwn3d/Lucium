// Two helpers tested on their own (no application is started here). `expectStays`, the control where nothing must happen: a control that could not fail
// would prove nothing, so the helper is shown to fail on a value that changes, even for a moment, within the time watched. `isSettingsWindowUrl`, which
// tells the Settings window from the other windows of the application by its address.

import { expect, test } from '@playwright/test'
import { expectStays, isSettingsWindowUrl } from './helpers'

test('expectStays passes when the value holds for the whole time, and looks once more when the time has passed', async () => {
  const started = Date.now()
  let looks = 0
  await expectStays(() => (looks++, 'none'), 'none', 'nothing opens', 300)
  expect(Date.now() - started).toBeGreaterThanOrEqual(300)
  expect(looks).toBeGreaterThan(2)
})

test('expectStays fails as soon as the value changes, and says what was watched', async () => {
  const started = Date.now()
  const late = () => (Date.now() - started > 150 ? 'sheet' : 'none')
  await expect(expectStays(late, 'none', 'no sheet opens while the function is off', 2000)).rejects.toThrow(/no sheet opens while the function is off/)
  // It did not wait for the end of the time to say so.
  expect(Date.now() - started).toBeLessThan(1500)
})

test('expectStays catches a value that changes and comes back within the time, which a single look at the end would miss', async () => {
  const started = Date.now()
  const blink = () => {
    const elapsed = Date.now() - started
    return elapsed > 150 && elapsed < 450 ? 1 : 0
  }
  await expect(expectStays(blink, 0, 'no window opens', 800)).rejects.toThrow(/no window opens/)
})

test('expectStays compares by value (lists and objects) and takes a reader that answers later', async () => {
  await expectStays(async () => ({ tabs: 2, asked: [] as string[] }), { tabs: 2, asked: [] }, 'nothing is asked for', 150)
  await expect(expectStays(async () => ['/feed.json'], [], 'the feed is not asked', 150)).rejects.toThrow(/the feed is not asked/)
})

test('isSettingsWindowUrl names the page of the Settings window by its file, whatever the folder the run happens in is called', () => {
  const folder = 'file:///Users/me/lucium/.claude/worktrees/settings-int/out/renderer'
  // The interface and its other pages, run from a folder called « settings-… »: not the Settings window (the word was found in the folder).
  expect(isSettingsWindowUrl(`${folder}/index.html`)).toBe(false)
  expect(isSettingsWindowUrl(`${folder}/overlay.html`)).toBe(false)
  expect(isSettingsWindowUrl(`${folder}/littlearc.html?tray=1`)).toBe(false)
  expect(isSettingsWindowUrl('file:///Users/me/settings.html/out/renderer/index.html')).toBe(false)
  expect(isSettingsWindowUrl('http://127.0.0.1:4173/settings.html.txt')).toBe(false)
  // The Settings window, at its first page or at the place it was opened on, in a folder of any name.
  expect(isSettingsWindowUrl(`${folder}/settings.html`)).toBe(true)
  expect(isSettingsWindowUrl(`${folder}/settings.html#protection/network`)).toBe(true)
  expect(isSettingsWindowUrl('file:///Users/me/lucium/out/renderer/settings.html#home')).toBe(true)
  expect(isSettingsWindowUrl('http://localhost:5173/settings.html')).toBe(true)
})
