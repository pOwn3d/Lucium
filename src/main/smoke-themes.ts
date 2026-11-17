// Engine checks for the theme codes, the ready themes and "apply to every space", run inside a real Electron: the menu of a space copies,
// pastes and applies a theme through the real clipboard and the real toast; the theme editor is driven with real mouse and key events
// (a ready theme, the code fields, the link that applies to every space); the state is read back from disk the way a restart reads it.
// Called from the engine smoke test: `await smokeThemes(ctx, check)`; `LUCIUM_SMOKE_ONLY=themes` runs only this file (see index.ts).
// The system clipboard is saved first and put back at the end.

import { app, clipboard, Menu, screen, type WebContents } from 'electron'
import { join } from 'node:path'
import { cleanTheme, hexToRgb, type SpaceTheme } from '@shared/theme'
import { encodeThemeCode } from '@shared/theme-code'
import { READY_THEMES } from '@shared/theme-presets'
import type { SmokeContext } from './smoke'
import { menuItems, showMenu } from './shell/context-menus'
import { loadState } from './store'
import { noteCheck, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void

interface Box {
  x: number
  y: number
  w: number
  h: number
}


const waitFor = waiterOf(4000, 50)

const code = (theme: SpaceTheme) => encodeThemeCode(theme)
const HOSTILE = 'luc1_bd93f9;}body{display:none}_custom_155_85_grain_10_light_vivid_dark'
const DRACULA = READY_THEMES.find((t) => t.id === 'dracula')!

export async function smokeThemes(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win, overlayView } = ctx
  const chrome = win.webContents
  const ui = overlayView.webContents
  const state = () => store.get()
  const statePath = join(app.getPath('userData'), 'state.json')

  const evaluate = <T>(from: WebContents, script: string) =>
    (from.executeJavaScript(script) as Promise<T>).catch((error: unknown) => {
      throw new Error(`${String(error)} -- in: ${script.replace(/\s+/g, ' ').slice(0, 200)}`)
    })
  const rect = (from: WebContents, selector: string, nth = 0) =>
    evaluate<Box | null>(from, `(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } })()`)
  const count = (from: WebContents, selector: string) => evaluate<number>(from, `document.querySelectorAll(${JSON.stringify(selector)}).length`)
  const textOf = (from: WebContents, selector: string) => evaluate<string>(from, `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`)
  const labelsOf = (from: WebContents, selector: string) => evaluate<string[]>(from, `[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => el.getAttribute('aria-label') ?? el.textContent)`)
  const mouse = (from: WebContents, type: 'mouseDown' | 'mouseMove' | 'mouseUp', x: number, y: number) =>
    from.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 } as Electron.MouseInputEvent)
  const clickAt = async (from: WebContents, box: Box) => {
    const x = box.x + box.w / 2
    const y = box.y + box.h / 2
    mouse(from, 'mouseMove', x, y)
    await sleep(40)
    mouse(from, 'mouseDown', x, y)
    await sleep(30)
    mouse(from, 'mouseUp', x, y)
    await sleep(200)
  }
  /** A real click on the nth element matching, scrolled into view first. */
  const click = async (from: WebContents, selector: string, nth = 0): Promise<boolean> => {
    await evaluate(from, `document.querySelectorAll(${JSON.stringify(selector)})[${nth}]?.scrollIntoView({ block: 'nearest' })`)
    await sleep(60)
    const box = await rect(from, selector, nth)
    if (!box) return false
    await clickAt(from, box)
    return true
  }
  const clickLabelled = async (from: WebContents, selector: string, label: string): Promise<boolean> => {
    const labels = await labelsOf(from, selector)
    const at = labels.findIndex((l) => l.trim() === label)
    return at !== -1 && click(from, selector, at)
  }
  /** Sets an input the way React notices (the native setter, then the event it listens to). */
  const setValue = (from: WebContents, selector: string, value: string, nth = 0) =>
    evaluate(from, `(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]; if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok' })()`)
  const pressEnter = async () => {
    ui.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    ui.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await sleep(250)
  }
  const typeKeys = async (text: string) => {
    for (const ch of text) {
      ui.sendInputEvent({ type: 'keyDown', keyCode: ch })
      ui.sendInputEvent({ type: 'char', keyCode: ch })
      ui.sendInputEvent({ type: 'keyUp', keyCode: ch })
      await sleep(40)
    }
    await sleep(200)
  }

  const themeOf = (id: string) => state().spaces.find((s) => s.id === id)!.theme
  const toast = () => browser.snapshot().toast
  const menuOf = (id: string, clipboardText?: string) => menuItems({ kind: 'space', id }, browser, store, win, { clipboardText })
  const entry = (id: string, label: string, clipboardText?: string) => menuOf(id, clipboardText).find((item) => item.label === label)
  const press = (id: string, label: string, clipboardText?: string) => (entry(id, label, clipboardText)?.click as (() => void) | undefined)?.()
  const clipboardNow = () => clipboard.readText()
  const setClipboard = async (text: string) => {
    await clipboard.writeText(text)
    await sleep(30)
  }
  const sameTheme = (a: SpaceTheme, b: SpaceTheme) => code(a) === code(b)

  // ---- set up: a window of the measured size, two spaces with their own themes, the user's clipboard put aside ----
  const keptClipboard = await clipboard.readText()
  const savedBounds = win.getBounds()
  const workArea = screen.getPrimaryDisplay().workArea
  win.setBounds({ x: workArea.x, y: workArea.y, width: 1680, height: 888 })
  win.showInactive()
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: true, sidebarWidth: 323, showToolbar: true } })
  await sleep(500)

  // Every native menu that opens is recorded (with its entries' state) instead of shown.
  const nativeMenus: Array<Array<{ label: string; enabled: boolean }>> = []
  const realPopup = Menu.prototype.popup
  Menu.prototype.popup = function (this: Menu) {
    nativeMenus.push(this.items.map((item) => ({ label: item.label, enabled: item.enabled })))
    return this
  } as never

  const originalThemes = state().spaces.map((s) => ({ id: s.id, theme: s.theme }))
  const previousSpace = state().activeSpaceId
  const makeSpace = (name: string, hue: number, emoji: string) => {
    browser.dispatch({ type: 'space/create', name, emoji, hue })
    return state().activeSpaceId
  }
  const a = makeSpace('Thèmes A', 20, '🅰️')
  const b = makeSpace('Thèmes B', 200, '🅱️')
  const aTheme: SpaceTheme = cleanTheme({ baseColors: ['#336699', '#996633'], harmony: 'custom', angle: 90, intensity: 0.7, overlay: 'fine', noise: 0.3, translucency: 'dark', vibrant: false, appearance: 'dark' })
  browser.dispatch({ type: 'space/update', id: a, patch: { theme: aTheme } })
  const bBefore = themeOf(b)
  await sleep(300)

  // ================= the menu of a space =================
  // The menu is in blocks: the entries without the titles and the separators of the blocks.
  const labels = menuOf(a)
    .filter((item) => item.type !== 'header' && item.type !== 'separator')
    .map((item) => item.label ?? '')
  check('the space menu starts with "Personnaliser l’espace…", the name and the profile, and gains the theme entries in a block after them', labels.slice(0, 3).join('|') === 'Personnaliser l’espace…|Renommer l’espace…|Définir le profil' && labels.indexOf('Copier le thème') === 3 && labels[4] === 'Coller le thème' && labels[5] === 'Appliquer ce thème à tous les espaces', labels.join(' | '))
  check('and keeps its last ones (Gérer les espaces…, then the block that erases: Vider les onglets du jour, Supprimer l’espace…)', labels.at(-1) === 'Supprimer l’espace…' && labels.at(-3) === 'Gérer les espaces…', labels.join(' | '))
  check('"Coller le thème" is greyed when no clipboard text was given', entry(a, 'Coller le thème')?.enabled === false)
  check('"Appliquer ce thème à tous les espaces" is on with several spaces', entry(a, 'Appliquer ce thème à tous les espaces')?.enabled === true)

  // ---- copy ----
  await setClipboard('rien du tout')
  press(a, 'Copier le thème')
  check('"Copier le thème" puts the code of the space’s theme on the real clipboard', await waitFor(async () => (await clipboardNow()) === code(aTheme)), await clipboardNow())
  check('and says so in a toast', toast()?.message === 'Thème copié', JSON.stringify(toast()))
  check('the code is a single short line of plain characters', /^luc1_[0-9a-f]{6}(-[0-9a-f]{6}){0,2}_[a-z]+_\d+_\d+_[a-z]+_\d+_[a-z]+_[a-z]+_[a-z]+$/.test(await clipboardNow()) && (await clipboardNow()).length < 120, await clipboardNow())

  // ---- which clipboards turn "Coller le thème" on ----
  const pasteEnabledFor = async (text: string) => {
    await setClipboard(text)
    const real = await clipboardNow()
    return entry(a, 'Coller le thème', real)?.enabled === true
  }
  check('"Coller le thème" is on for a theme code on the clipboard', await pasteEnabledFor(code(aTheme)))
  check('…for a colour with or without the #, and for rgb()', (await pasteEnabledFor('#336699')) && (await pasteEnabledFor('336699')) && (await pasteEnabledFor('rgb(51, 102, 153)')))
  const refused = ['bonjour', '', '   ', 'luc2_000000', 'luc1_bd93f9_custom', HOSTILE, 'javascript:alert(1)', '<script>alert(1)</script>', '#12345', 'x'.repeat(5000)]
  let allGreyed = true
  for (const text of refused) if (await pasteEnabledFor(text)) allGreyed = false
  check('…and greyed for words, nothing, another version, a broken code, a hostile code, a script, a short colour and a huge text', allGreyed)

  // ---- the menu as the sidebar opens it: the clipboard is read when it is asked for, then the native menu pops up ----
  const popupEnabled = async (text: string) => {
    await setClipboard(text)
    const opened = nativeMenus.length
    showMenu({ kind: 'space', id: a }, browser, store, win)
    const popped = await waitFor(() => nativeMenus.length === opened + 1)
    return popped ? nativeMenus[opened]!.find((item) => item.label === 'Coller le thème')?.enabled : undefined
  }
  check('right-clicking a space opens one native menu whose "Coller le thème" is on for a theme on the clipboard', (await popupEnabled(code(aTheme))) === true)
  check('…and off when the clipboard holds anything else (the clipboard is read each time the menu opens)', (await popupEnabled('bonjour')) === false && (await popupEnabled(HOSTILE)) === false && (await popupEnabled('#abcdef')) === true)
  const popups = nativeMenus.length

  // ---- paste ----
  await setClipboard(code(aTheme))
  press(b, 'Coller le thème', await clipboardNow())
  check('"Coller le thème" gives the theme of A to B', await waitFor(() => sameTheme(themeOf(b), aTheme)), JSON.stringify(themeOf(b)))
  check('…while A keeps its own', sameTheme(themeOf(a), aTheme))
  check('…and says so in a toast', await waitFor(() => toast()?.message === 'Thème collé'), JSON.stringify(toast()))
  check('the other space (the first) was not touched', sameTheme(themeOf(originalThemes[0]!.id), originalThemes[0]!.theme))

  const intensityOfB = themeOf(b).intensity
  await setClipboard('#FF8800')
  press(b, 'Coller le thème', await clipboardNow())
  check('a colour on the clipboard becomes the base colour of B', await waitFor(() => themeOf(b).baseColors[0] === '#ff8800'), JSON.stringify(themeOf(b).baseColors))
  check('…and nothing else of the theme changes', themeOf(b).intensity === intensityOfB && themeOf(b).overlay === aTheme.overlay && themeOf(b).angle === aTheme.angle)

  browser.dispatch({ type: 'space/update', id: b, patch: { theme: bBefore } })
  await setClipboard(HOSTILE)
  const beforeHostile = code(themeOf(b))
  press(b, 'Coller le thème', await clipboardNow())
  check('a hostile code forced through the (greyed) entry changes nothing and is answered by a toast', (await waitFor(() => (toast()?.message ?? '').includes('incomplet ou abîmé'))) && code(themeOf(b)) === beforeHostile, JSON.stringify(toast()))
  const sidebarStyle = await evaluate<string>(chrome, `document.querySelector('[style*="--bg-gradient"]')?.getAttribute('style') ?? ''`)
  check('and nothing of it reached the style of the window', !sidebarStyle.includes('display:none') && !sidebarStyle.includes('}'), sidebarStyle.slice(0, 200))

  // ---- apply to every space, and undo from the toast with a real click ----
  const before = state().spaces.map((s) => ({ id: s.id, theme: s.theme }))
  const total = state().spaces.length
  press(a, 'Appliquer ce thème à tous les espaces')
  check('"Appliquer ce thème à tous les espaces" gives A’s theme to every space', await waitFor(() => state().spaces.every((s) => sameTheme(s.theme, aTheme))), state().spaces.map((s) => code(s.theme)).join(' '))
  check(`…and the toast says "Thème appliqué aux ${total} espaces" with an Annuler button`, toast()?.message === `Thème appliqué aux ${total} espaces` && toast()?.action === 'Annuler', JSON.stringify(toast()))
  check('…the sidebar shows it (the gradient of the window is the one of A’s theme)', await waitFor(async () => (await evaluate<string>(chrome, `document.querySelector('[style*="--bg-gradient"]')?.style.getPropertyValue('--bg-gradient') ?? ''`)).startsWith('linear-gradient(90deg,')))
  check('the toast’s Annuler button is on screen', (await rect(chrome, '.toast-action')) !== null)
  check('a real click on Annuler puts back every space’s previous theme', (await click(chrome, '.toast-action')) && (await waitFor(() => before.every((p) => sameTheme(themeOf(p.id), p.theme)))), state().spaces.map((s) => code(s.theme)).join(' '))

  // ================= the theme editor =================
  // The menu has no entry for the theme editor any more ("Personnaliser l’espace…" opens the panel of the space, whose link opens the editor): it is opened as the Espaces menu does.
  const bBeforeEditor = themeOf(b)
  browser.openOverlay({ panel: 'theme', spaceId: b })
  const opened = await waitFor(async () => (await rect(ui, '.theme-pop')) !== null, 5000)
  check('the theme editor of B opens', opened && browser.currentOverlay()?.panel === 'theme')
  await sleep(300)
  // A list of named themes (dark, light, the other spaces' own) beside the drawing of the sidebar, and no page of pastilles any more.
  const pop = await rect(ui, '.theme-pop')
  check('the panel is 420 px wide', !!pop && Math.abs(pop.w - 420) <= 1.5, JSON.stringify(pop))
  const listed = await evaluate<string[]>(ui, `[...document.querySelectorAll('.tp-theme span')].map((el) => el.textContent ?? '')`)
  check('it lists every ready theme once, by its name, dark ones first, and opens on none of them being current for a theme of B’s own', READY_THEMES.every((t) => listed.filter((name) => name === t.name).length === 1) && listed[0] === 'Dracula', listed.join(', '))
  check('there is no page, no arrow, no row of pastilles and no empty place', (await count(ui, '.ready-theme')) === 0 && (await count(ui, '.ready-arrow')) === 0 && (await count(ui, '.preset')) === 0 && (await count(ui, '.preset-arrow')) === 0)
  check('the titles of the groups are there: Sombres, Clairs', (await evaluate<string[]>(ui, `[...document.querySelectorAll('.tp-group')].map((el) => el.textContent ?? '')`)).slice(0, 2).join() === 'Sombres,Clairs')
  check('a drawing of the sidebar stands beside the list', (await rect(ui, '.tp-thumb')) !== null && (await rect(ui, '.tp-list')) !== null)
  check('nothing overflows sideways', await evaluate<boolean>(ui, `(() => { const p = document.querySelector('.theme-pop'); return p.scrollWidth <= p.clientWidth })()`))
  const fit = await evaluate<{ client: number; surface: number }>(ui, `(() => { const p = document.querySelector('.theme-pop'); return { client: p.clientHeight, surface: window.innerHeight } })()`)
  check('the panel fits its surface (what does not is scrolled inside it)', fit.client <= fit.surface, JSON.stringify(fit))
  check('there is one primary button, "Terminé"', (await count(ui, '.theme-pop .tk-btn.primary')) === 1 && (await textOf(ui, '.theme-pop .tk-btn.primary')) === 'Terminé')

  // ---- the drawing takes the theme under the pointer, and gives it back; a click applies the theme ----
  const thumbBackground = () => evaluate<string>(ui, `getComputedStyle(document.querySelector('.tp-thumb')).backgroundImage`)
  const themeButton = (name: string) => `[...document.querySelectorAll('.tp-theme')].find((el) => el.textContent.startsWith(${JSON.stringify(name)}))`
  const atRest = await thumbBackground()
  await evaluate(ui, `${themeButton('Dracula')}.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`)
  await evaluate(ui, `${themeButton('Dracula')}.focus()`)
  check('the drawing of the sidebar takes the theme of the one that has the focus, before any click', await waitFor(async () => (await thumbBackground()) !== atRest) && sameTheme(themeOf(b), bBeforeEditor), await thumbBackground())
  await evaluate(ui, `document.activeElement.blur()`)
  check('…and gives back the theme of the space when the focus leaves', await waitFor(async () => (await thumbBackground()) === atRest, 3000), await thumbBackground())

  // ---- a ready theme, applied live ----
  check('a click on Dracula gives B the Dracula theme', (await evaluate<boolean>(ui, `(() => { const el = ${themeButton('Dracula')}; el?.click(); return !!el })()`)) && (await waitFor(() => sameTheme(themeOf(b), DRACULA.theme))), JSON.stringify(themeOf(b)))
  await sleep(400)
  const gradient = await evaluate<string>(chrome, `document.querySelector('[style*="--bg-gradient"]')?.style.getPropertyValue('--bg-gradient') ?? ''`)
  check('the sidebar behind the editor takes the palette’s own background (#282a36)', gradient === 'linear-gradient(155deg, #282a36, #282a36)', gradient)
  // The pixels, not only the style: the colour of the sidebar between its left edge and its rows.
  const sidebar = await rect(chrome, '.sidebar')
  if (sidebar) {
    const image = await chrome.capturePage({ x: Math.round(sidebar.x + 3), y: Math.round(sidebar.y + sidebar.h / 2), width: 1, height: 1 })
    const [blue, green, red] = [...image.toBitmap()]
    const want = hexToRgb(DRACULA.background)
    check('and the pixel of the sidebar there is that colour (±4)', Math.abs((red ?? 0) - want.r) <= 4 && Math.abs((green ?? 0) - want.g) <= 4 && Math.abs((blue ?? 0) - want.b) <= 4, `rgb(${red},${green},${blue})`)
  } else check('the sidebar was found to read a pixel from', false)
  check('the theme is marked as the current one in the list', (await evaluate<string>(ui, `document.querySelector('.tp-theme[aria-pressed="true"] span')?.textContent ?? ''`)) === 'Dracula')
  const light = READY_THEMES.find((t) => t.id === 'github-light')!
  check('a light theme, far down the list, makes the space light', (await evaluate<boolean>(ui, `(() => { const el = ${themeButton(light.name)}; el?.click(); return !!el })()`)) && (await waitFor(() => sameTheme(themeOf(b), light.theme))) && themeOf(b).appearance === 'light')
  await evaluate<boolean>(ui, `(() => { const el = ${themeButton('Dracula')}; el?.click(); return !!el })()`)
  await waitFor(() => sameTheme(themeOf(b), DRACULA.theme))

  // ---- the named colours, the hue, the strength and the texture ----
  check('the ten named colours are there, and a click on one gives the space that colour first', (await count(ui, '.tp-swatch')) === 10 && (await click(ui, '.tp-swatch', 3)) && (await waitFor(() => themeOf(b).baseColors[0] === '#e05d5d')), JSON.stringify(themeOf(b).baseColors))
  await evaluate(ui, `(() => { const r = document.querySelector('.tp-sliders label:nth-child(2) input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(r, '40'); r.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  check('the strength slider sets the intensity', await waitFor(() => Math.abs(themeOf(b).intensity - 0.4) < 0.01), String(themeOf(b).intensity))
  await evaluate(ui, `(() => { const r = document.querySelector('.tp-sliders select'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(r, 'fine'); r.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  check('the texture select sets the texture, with an amount to see it', await waitFor(() => themeOf(b).overlay === 'fine' && themeOf(b).noise > 0), JSON.stringify([themeOf(b).overlay, themeOf(b).noise]))
  // « Réinitialiser » goes back to the theme the panel opened with (ThemeEditor.tsx, as Escape does), not to the last ready theme applied from the list: B is its
  // own again, and Dracula is picked once more for the checks of the state on disk and of the code fields that follow.
  check('"Réinitialiser" gives B back the theme it had when the panel opened', (await clickLabelled(ui, '.theme-pop .tk-btn', 'Réinitialiser')) && (await waitFor(() => sameTheme(themeOf(b), bBeforeEditor))), code(themeOf(b)))
  check('…and a click on Dracula gives B that theme again', (await evaluate<boolean>(ui, `(() => { const el = ${themeButton('Dracula')}; el?.click(); return !!el })()`)) && (await waitFor(() => sameTheme(themeOf(b), DRACULA.theme))), code(themeOf(b)))

  // ---- the state, read back from disk like a restart does ----
  check('the state is written to disk', store.flush())
  const reloaded = loadState(statePath)
  const reloadedB = reloaded.spaces.find((s) => s.id === b)
  check('read back from disk, B still has the Dracula theme, exactly', !!reloadedB && sameTheme(reloadedB.theme, DRACULA.theme) && JSON.stringify(reloadedB.theme) === JSON.stringify(DRACULA.theme), JSON.stringify(reloadedB?.theme))
  check('…and A its own', sameTheme(reloaded.spaces.find((s) => s.id === a)!.theme, aTheme))
  check('…and the editor opened again on that state would mark Dracula as current', READY_THEMES.find((t) => sameTheme(t.theme, reloadedB!.theme))?.id === 'dracula')

  // ---- the code fields (advanced controls) ----
  await evaluate(ui, `document.querySelector('.theme-advanced').open = true`)
  await waitFor(async () => (await evaluate<string>(ui, `document.querySelector('.theme-advanced input[aria-label="Code du thème"]')?.value ?? ''`)) === code(DRACULA.theme))
  check('the advanced controls hold the code of the theme, read-only, and a paste field', (await evaluate<string>(ui, `document.querySelector('.theme-advanced input[aria-label="Code du thème"]')?.value ?? ''`)) === code(DRACULA.theme) && (await evaluate<boolean>(ui, `document.querySelector('.theme-advanced input[aria-label="Code du thème"]').readOnly`)) && (await count(ui, '.theme-advanced input[aria-label="Coller un code de thème"]')) === 1)
  await setClipboard('avant')
  check('"Copier" next to the code copies it', (await click(ui, '.theme-advanced .code-row .tk-btn', 1)) && (await waitFor(async () => (await clipboardNow()) === code(DRACULA.theme))), await clipboardNow())
  check('…and the button says "Copié" for a moment', (await labelsOf(ui, '.theme-advanced .code-row .tk-btn')).includes('Copié'), (await labelsOf(ui, '.theme-advanced .code-row .tk-btn')).join(','))
  const baseHex = themeOf(b).baseColors[0]!
  await setClipboard('avant')
  check('"Copier" next to the colour code copies the base colour as #rrggbb', (await click(ui, '.theme-advanced label .code-row .tk-btn')) && (await waitFor(async () => (await clipboardNow()) === baseHex)), `${await clipboardNow()} / ${baseHex}`)

  // Pasting a code into the field and pressing Enter.
  await setValue(ui, '.theme-advanced input[aria-label="Coller un code de thème"]', code(aTheme))
  await click(ui, '.theme-advanced input[aria-label="Coller un code de thème"]')
  await pressEnter()
  check('a code typed in the paste field and Enter apply the whole theme', await waitFor(() => sameTheme(themeOf(b), aTheme)), JSON.stringify(themeOf(b)))
  check('…the field is emptied and the editor says "Thème collé"', (await evaluate<string>(ui, `document.querySelector('.theme-advanced input[aria-label="Coller un code de thème"]').value`)) === '' && (await textOf(ui, '.theme-pop > p[role="status"]')) === 'Thème collé', await textOf(ui, '.theme-pop > p[role="status"]'))

  // A hostile text is refused with a sentence.
  const beforeEditorHostile = code(themeOf(b))
  await setValue(ui, '.theme-advanced input[aria-label="Coller un code de thème"]', HOSTILE)
  await click(ui, '.theme-advanced input[aria-label="Coller un code de thème"]')
  await pressEnter()
  const hostileMessage = await textOf(ui, '.theme-pop > p[role="status"]')
  check('a hostile code in the paste field is refused with a readable sentence, and the theme does not change', hostileMessage.includes('incomplet ou abîmé') && code(themeOf(b)) === beforeEditorHostile, hostileMessage)
  check('…the refused text stays in the field so it can be fixed, and the message is a warning', (await evaluate<string>(ui, `document.querySelector('.theme-advanced input[aria-label="Coller un code de thème"]').value`)) === HOSTILE && (await evaluate<boolean>(ui, `document.querySelector('.theme-pop > p[role="status"]').classList.contains('warning')`)))
  await setValue(ui, '.theme-advanced input[aria-label="Coller un code de thème"]', 'bonjour tout le monde')
  await click(ui, '.theme-advanced input[aria-label="Coller un code de thème"]')
  await pressEnter()
  check('a sentence is refused too ("ni un code de thème ni une couleur")', (await textOf(ui, '.theme-pop > p[role="status"]')).includes('ni un code de thème ni une couleur') && code(themeOf(b)) === beforeEditorHostile)
  await setValue(ui, '.theme-advanced input[aria-label="Coller un code de thème"]', '')

  // The "Coller" button reads the clipboard.
  await setClipboard('#00aa55')
  check('the "Coller" button, with an empty field, pastes the clipboard (a colour: the base colour)', (await clickLabelled(ui, '.theme-advanced .code-row .tk-btn', 'Coller')) && (await waitFor(() => themeOf(b).baseColors[0] === '#00aa55')), JSON.stringify(themeOf(b).baseColors))
  await setClipboard('pas un thème')
  const beforeRefusedClipboard = code(themeOf(b))
  await clickLabelled(ui, '.theme-advanced .code-row .tk-btn', 'Coller')
  // The witness: the shell's answer to the paste, the sentence it shows in place of the one of the colour pasted before; the theme is decided by then.
  await waitFor(async () => (await textOf(ui, '.theme-pop > p[role="status"]')).includes('ni un code de thème ni une couleur'))
  check('…and a clipboard that is not a theme is refused with a sentence', (await textOf(ui, '.theme-pop > p[role="status"]')).includes('ni un code de thème ni une couleur') && code(themeOf(b)) === beforeRefusedClipboard)

  // The colour field accepts a code without its "#".
  const field = '.theme-advanced label input.tk-field'
  await click(ui, field)
  await evaluate(ui, `document.querySelector(${JSON.stringify(field)}).select()`)
  await typeKeys('ff8800')
  check('the colour code field takes six digits without the #', await waitFor(() => themeOf(b).baseColors[0] === '#ff8800'), JSON.stringify(themeOf(b).baseColors))
  await evaluate(ui, `document.querySelector(${JSON.stringify(field)}).blur()`)

  // ---- apply to every space from the editor ----
  const draftTheme = themeOf(b)
  await clickLabelled(ui, '.tp-link', 'Appliquer à tous les espaces')
  check('"Appliquer à tous les espaces" in the editor gives every space the theme being edited', await waitFor(() => state().spaces.every((s) => sameTheme(s.theme, draftTheme))), state().spaces.map((s) => code(s.theme)).join(' '))
  check('…with the same toast and its Annuler', toast()?.message === `Thème appliqué aux ${state().spaces.length} espaces` && toast()?.action === 'Annuler', JSON.stringify(toast()))
  check('…and the editor stays open', browser.currentOverlay()?.panel === 'theme')
  browser.runToastAction(toast()!.id)
  check('the toast’s action undoes it', await waitFor(() => state().spaces.some((s) => !sameTheme(s.theme, draftTheme)) && sameTheme(themeOf(b), draftTheme)))

  // ---- the channel between the editor and the shell refuses what is not one of its three requests ----
  const ask = (request: string) => evaluate<{ ok: boolean; message: string }>(ui, `window.lucium.themeCode(${request})`)
  await setClipboard('avant')
  const invalid = [`{ kind: 'paste' }`, `{ kind: 'paste', spaceId: '' }`, `{ kind: 'nope', spaceId: ${JSON.stringify(b)} }`, 'null', `{ kind: 'copy' }`, `{ kind: 'copy', text: 'x'.repeat(3000) }`, `{ kind: 'apply-all', spaceId: ${JSON.stringify(b)}, theme: 'red' }`]
  const answers = await Promise.all(invalid.map(ask))
  check('a request that is not exactly one of the three is answered "Demande invalide." and does nothing', answers.every((r) => r.ok === false && r.message === 'Demande invalide.') && (await clipboardNow()) === 'avant', JSON.stringify(answers))
  const refusedCopy = await ask(`{ kind: 'copy', text: 'rm -rf / # not a theme' }`)
  check('a copy of a text that is neither a theme nor a colour is refused and the clipboard is left alone', refusedCopy.ok === false && (await clipboardNow()) === 'avant', JSON.stringify(refusedCopy))
  const goodCopy = await ask(`{ kind: 'copy', text: ' 336699 ' }`)
  check('a copy of a colour works through the channel, in its canonical form', goodCopy.ok === true && (await waitFor(async () => (await clipboardNow()) === '#336699')), JSON.stringify(goodCopy))
  const gone = await ask(`{ kind: 'paste', spaceId: 'no-such-space', text: '#336699' }`)
  check('a paste into a space that does not exist says so', gone.ok === false && gone.message === 'Cet espace n’existe plus.', JSON.stringify(gone))

  // ---- no native menu opened by any of this, but the ones asked for ----
  check('none of the other steps opened a native menu', nativeMenus.length === popups, JSON.stringify(nativeMenus.slice(popups)))

  // ---- clean up ----
  Menu.prototype.popup = realPopup
  browser.closeOverlay()
  browser.dispatch({ type: 'space/select', id: previousSpace })
  browser.dispatch({ type: 'space/delete', id: a })
  browser.dispatch({ type: 'space/delete', id: b })
  browser.dispatch({ type: 'space/apply-themes', entries: originalThemes })
  check('with a single space left, "Appliquer ce thème à tous les espaces" is greyed', state().spaces.length > 1 || entry(state().spaces[0]!.id, 'Appliquer ce thème à tous les espaces')?.enabled === false)
  await clipboard.writeText(keptClipboard)
  win.setBounds(savedBounds)
}

/** `LUCIUM_SMOKE_ONLY=themes`: only these checks, with their own report (a quick loop while working on themes). Returns the exit code. */
export async function runThemesSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  const complaints: string[] = []
  ctx.overlayView.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') complaints.push(`${event.level}: ${event.message.slice(0, 300)}`)
  })
  try {
    const verbose = process.env['LUCIUM_THEMES_VERBOSE'] === '1'
    await smokeThemes(ctx, (name, ok, detail) => {
      noteCheck(checks, name, ok, detail)
      if (verbose) console.log(`THEMES ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail.slice(0, 400)}`}`)
    })
  } catch (error) {
    noteCheck(checks, 'smokeThemes ran to the end', false, String((error as Error).stack ?? error))
    console.log(`THEMES FAIL smokeThemes ran to the end -- ${String((error as Error).message ?? error).slice(0, 400)}`)
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_THEMES ${JSON.stringify({ checks, complaints, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
