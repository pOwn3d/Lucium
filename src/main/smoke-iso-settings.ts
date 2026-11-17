// Engine checks for the Settings window and the panels around it: the window (its title bar, the sidebar of its 11 pages, the head of a
// page, its fold « Plus de réglages », "Rétablir" at its foot), the rows of each page (order, effect of each control), the theme editor,
// the space sheets, the standard dialog and the task manager. They check behaviour: what opens, what each control changes, keyboard and
// focus, names and texts, and that nothing is hidden or clipped. No exact size, position or colour is compared.
// Real input (sendInputEvent) drives every control.
// Called from the engine smoke test: `await smokeIsoSettings(ctx, check)`. `runIsoSettingsSmoke` is the same with its own report, for
// LUCIUM_SMOKE_ONLY=iso-settings (quick loop). LUCIUM_ISOS_VERBOSE=1 prints every check as it goes.

import { BrowserWindow as ElectronWindow, Menu, globalShortcut, type WebContents } from 'electron'
import { AutoUpdater } from './shell/auto-update'
import { LittleShortcut } from './shell/little-shortcut'
import { SETTINGS_PAGES, type SettingsAnchor, type SettingsPage } from '@shared/ipc'
import { defaultSettings, type Settings } from '@shared/model'
import { littleForms } from '@shared/little-name'
import type { SmokeContext } from './smoke'
import { noteCheck, OPEN_MORE_SETTINGS, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'

type Check = (name: string, ok: boolean, detail?: string) => void

interface Rect {
  x: number
  y: number
  width: number
  height: number
}


const waitFor = waiterOf(6000, 60)

const evaluate = <T>(wc: WebContents, script: string): Promise<T> => wc.executeJavaScript(script) as Promise<T>
const textOf = (wc: WebContents, selector: string): Promise<string> => evaluate(wc, `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`)
const count = (wc: WebContents, selector: string): Promise<number> => evaluate(wc, `document.querySelectorAll(${JSON.stringify(selector)}).length`)

/** The box of the first element matching `selector` (and containing `text`, when given), in the page's coordinates. */
const rectIn = (wc: WebContents, selector: string, text?: string): Promise<Rect | null> =>
  evaluate(
    wc,
    `(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
      const el = ${text === undefined ? 'els[0]' : `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))`}
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })()`
  )

async function waitRect(wc: WebContents, selector: string, text?: string): Promise<Rect | null> {
  for (let i = 0; i < 60; i++) {
    const rect = await rectIn(wc, selector, text)
    if (rect && rect.width > 0 && rect.height > 0) return rect
    await sleep(100)
  }
  return null
}

const mouse = (wc: WebContents, type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) =>
  wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 } as Electron.MouseInputEvent)

/** A left click with real mouse events, in the middle of the box. */
async function clickRect(wc: WebContents, rect: Rect): Promise<void> {
  const x = rect.x + rect.width / 2
  const y = rect.y + rect.height / 2
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) mouse(wc, type, x, y)
  await sleep(150)
}

/** Brings the element into view the way a user scrolls to it, and returns its box there. */
async function scrolledRect(wc: WebContents, selector: string, text?: string): Promise<Rect | null> {
  if (!(await waitRect(wc, selector, text))) return null
  await evaluate(
    wc,
    `(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = ${text === undefined ? 'els[0]' : `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))`}; el?.scrollIntoView({ block: 'nearest' }) })()`
  )
  await sleep(60)
  return rectIn(wc, selector, text)
}

async function clickOn(wc: WebContents, selector: string, text?: string): Promise<boolean> {
  const rect = await scrolledRect(wc, selector, text)
  if (!rect) return false
  await clickRect(wc, rect)
  return true
}

async function typeKeys(wc: WebContents, text: string): Promise<void> {
  for (const ch of text) {
    const keyCode = ch === ' ' ? 'Space' : ch
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'char', keyCode: ch })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(40)
  }
  await sleep(150)
}

const pressKey = async (wc: WebContents, keyCode: string, modifiers: Array<'shift' | 'control' | 'alt' | 'meta'> = []): Promise<void> => {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await sleep(200)
}

/** Sets an input or a select the way React notices (the native setter, then the event it listens to). */
const setValue = (wc: WebContents, selector: string, value: string): Promise<unknown> =>
  evaluate(
    wc,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return 'missing'
      const select = el instanceof HTMLSelectElement
      Object.getOwnPropertyDescriptor(select ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event(select ? 'change' : 'input', { bubbles: true }))
      return 'ok'
    })()`
  )

/** Whether `inner` lies inside `outer` (nothing clipped), give or take `slack` px. */
const inside = (inner: Rect | null | undefined, outer: Rect | null | undefined, slack = 1) =>
  !!inner && !!outer && inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack

/** The name of each page, as its head says it (settings.cat-*), and as its entry in the sidebar says it: the run is in French. */
const PANE_LABELS: Readonly<Record<SettingsPage, string>> = {
  home: 'Pour commencer',
  appearance: 'Apparence',
  tabs: 'Onglets et fenêtres',
  navigation: 'Navigation',
  protection: 'Vie privée et sécurité',
  files: 'Téléchargements et fichiers',
  tools: 'Extensions et outils',
  keyboard: 'Clavier et souris',
  profiles: 'Profils',
  features: 'Fonctions en option',
  about: 'À propos et mises à jour'
}
/** The names of the subpages these checks open, as their head writes them (the French of the catalogue). */
const SUBPAGE_LABELS: Readonly<Partial<Record<SettingsAnchor, string>>> = {
  shortcuts: 'Raccourcis clavier',
  permissions: 'Autorisations mémorisées',
  sitesearches: 'Recherches par mot-clé',
  linkroutes: 'Diriger les liens de certains sites vers un espace'
}
const PANE_SHORT_LABELS: Readonly<Record<SettingsPage, string>> = {
  ...PANE_LABELS,
  protection: 'Vie privée',
  files: 'Téléchargements',
  about: 'À propos'
}

export async function smokeIsoSettings(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, overlayView } = ctx
  const ui = overlayView.webContents
  const settings = () => store.get().settings
  const settingsWindows = () => ElectronWindow.getAllWindows().filter((w) => w.getTitle() === 'Réglages')
  const original: Partial<Settings> = {}
  const remember = (...keys: Array<keyof Settings>) => {
    for (const key of keys) if (!(key in original)) (original as Record<string, unknown>)[key] = structuredClone(settings()[key])
  }
  const patch = (changes: Partial<Settings>) => {
    remember(...(Object.keys(changes) as Array<keyof Settings>))
    browser.dispatch({ type: 'settings/update', patch: changes })
  }

  const section = async (name: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (error) {
      check(`${name} runs to the end`, false, String((error as Error)?.stack ?? error))
    }
    browser.closeOverlay()
  }

  /** The page the sidebar marks as shown, and the name its head gives it. */
  const shownPane = async (wc: WebContents) => ({
    id: await evaluate<string>(wc, `document.querySelector('.settings-cat[aria-current=page]')?.dataset.cat ?? ''`),
    heading: await textOf(wc, '#pane-heading')
  })
  /** Whether the page is shown (the sidebar marks it), under its name, or under the name of its subpage `sub` (the page stays marked). */
  const isShown = async (wc: WebContents, pane: SettingsPage, sub?: SettingsAnchor) => {
    const shown = await shownPane(wc)
    return shown.id === pane && shown.heading === (sub === undefined ? PANE_LABELS[pane] : SUBPAGE_LABELS[sub])
  }
  /**
   * Opens the Settings window on `pane` (or switches the open one), at the group `anchor` if given (a subpage when it names one: its head is waited
   * for), waits for the page to be drawn, and opens its fold « Plus de réglages » (`more`), so that every row of the page can be reached: the window
   * keeps it open while it stays open. A subpage has no fold.
   */
  const openPane = async (pane: SettingsPage, anchor?: SettingsAnchor, more = true): Promise<WebContents> => {
    browser.openOverlay({ panel: 'settings', pane, ...(anchor ? { anchor } : {}) })
    await waitFor(() => settingsWindows().length === 1)
    const wc = settingsWindows()[0]!.webContents
    const sub = anchor !== undefined && SUBPAGE_LABELS[anchor] !== undefined ? anchor : undefined
    await waitFor(() => isShown(wc, pane, sub), 6000)
    await waitRect(wc, '.settings-content > *')
    if (more && sub === undefined) await waitFor(() => evaluate<boolean>(wc, OPEN_MORE_SETTINGS), 3000)
    await sleep(250)
    return wc
  }
  const labelsOf = (wc: WebContents, scope: string) =>
    evaluate<string[]>(wc, `[...document.querySelectorAll(${JSON.stringify(scope + ' .pref-row > .pref-label')})].map((l) => l.firstChild?.textContent?.trim() || l.textContent.trim())`)
  /** The titles of the groups of the category shown (the count beside a title is not part of it). */
  const groupTitles = (wc: WebContents) => evaluate<string[]>(wc, `[...document.querySelectorAll('.settings-content .pref-section h3 .pref-title')].map((t) => t.textContent.trim())`)
  /** Whether the element is inside the visible part of the scrolling content, near its top (where a link to a group scrolls it). */
  const nearTopOfContent = (wc: WebContents, selector: string) =>
    evaluate<boolean>(wc, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); const c = document.querySelector('.settings-content'); if (!el || !c) return false; const top = el.getBoundingClientRect().top - c.getBoundingClientRect().top; return top >= -1 && top < 160 })()`)
  /**
   * Clicks the switch whose name (its aria-label, the label of its row) starts with `label`, with a real mouse click; true when the setting `key` flipped,
   * then flips it back. A row with an illustration is a <div>, the others a <label>: the switch is found by its name either way.
   */
  const flips = async (wc: WebContents, label: string, key: keyof Settings): Promise<boolean> => {
    const before = settings()[key]
    const locate = () =>
      evaluate<Rect | null>(
        wc,
        `(() => { const el = [...document.querySelectorAll('input[role=switch]')].find((e) => (e.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(label)})); if (!el || el.disabled) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height } })()`
      )
    const rect = await locate()
    if (!rect) return false
    remember(key)
    await clickRect(wc, rect)
    const flipped = await waitFor(() => settings()[key] === !before, 3000)
    await clickRect(wc, (await locate()) ?? rect)
    const back = await waitFor(() => settings()[key] === before, 3000)
    return flipped && back
  }

  // ======================= the window: its title bar, the sidebar, the head, the fold and the foot of a page =======================
  await section('the window and its sidebar', async () => {
    const wc = await openPane('about', 'icon', false)
    const w = settingsWindows()[0]!
    const [cw, ch] = w.getContentSize()
    check('it can be resized but not zoomed, and keeps its title for the window list', w.isResizable() && !w.isMaximizable() && w.getTitle() === 'Réglages')
    check('its title bar says “Réglages”, whatever the page', (await textOf(wc, '.settings-title')) === 'Réglages')
    check('the head of the page names it once, with its blurb under the name', (await textOf(wc, '#pane-heading')) === 'À propos et mises à jour' && (await textOf(wc, '.settings-pane-head .settings-blurb')) === 'Version, mises à jour, icône du Dock, état de Lucium.', await textOf(wc, '.settings-pane-head'))
    check('opened at the group “icon”, the page is scrolled to the icon of the application', await waitFor(() => nearTopOfContent(wc, '#icon'), 3000))

    const entries = () =>
      evaluate<Array<{ id: string; name: string; x: number; y: number; current: boolean; glyphs: number }>>(
        wc,
        `[...document.querySelectorAll('.settings-cats .settings-cat')].map((b) => { const r = b.getBoundingClientRect(); return { id: b.dataset.cat, name: b.querySelector('.settings-cat-name')?.textContent ?? '', x: r.x, y: r.y, current: b.getAttribute('aria-current') === 'page', glyphs: b.querySelectorAll('svg').length } })`
      )
    const sidebar = await entries()
    check('the sidebar holds the 11 pages in their order, each with its name', JSON.stringify(sidebar.map((t) => t.id)) === JSON.stringify(SETTINGS_PAGES) && sidebar.every((t) => t.name === PANE_SHORT_LABELS[t.id as SettingsPage]), sidebar.map((t) => `${t.id}:${t.name}`).join('|'))
    check('the entries are one column, top to bottom, each with its pictogram', sidebar.length === 11 && sidebar.every((t, i) => Math.abs(t.x - sidebar[0]!.x) <= 0.5 && t.glyphs === 1 && (i === 0 || t.y > sidebar[i - 1]!.y)), JSON.stringify(sidebar.map((t) => [Math.round(t.x), Math.round(t.y)])))
    check('the sidebar is 204 px wide, at the left of the page', Math.round((await rectIn(wc, '.settings-nav'))?.width ?? 0) === 204 && ((await rectIn(wc, '.settings-content'))?.x ?? 0) >= 204)
    check('only the page shown is marked, and only it takes the Tab key', sidebar.filter((t) => t.current).map((t) => t.id).join() === 'about' && (await evaluate<string>(wc, `[...document.querySelectorAll('.settings-cat')].filter((b) => b.tabIndex === 0).map((b) => b.dataset.cat).join()`)) === 'about')
    check('« Réglages modifiés » is at the foot of the sidebar, under the pages', ((await rectIn(wc, '.settings-nav-foot .settings-changed-link'))?.y ?? 0) > (sidebar.at(-1)?.y ?? Infinity))

    // Every entry answers a real click, and the window keeps its size: a page taller than the window scrolls inside it.
    for (const pane of SETTINGS_PAGES) {
      const rect = await rectIn(wc, `.settings-cat[data-cat="${pane}"]`)
      if (rect) await clickRect(wc, rect)
      check(`a click on “${PANE_SHORT_LABELS[pane]}” shows that page under its full name`, !!rect && (await waitFor(() => isShown(wc, pane), 3000)) && (await evaluate<string>(wc, 'location.hash')) === `#${pane}`, JSON.stringify(await shownPane(wc)))
      check(`the window keeps its size on “${PANE_SHORT_LABELS[pane]}”`, JSON.stringify(w.getContentSize()) === JSON.stringify([cw, ch]), String(w.getContentSize()))
    }
    // The arrows go down and up the sidebar and open the page they reach.
    await evaluate(wc, `document.querySelector('.settings-cat[aria-current=page]')?.focus()`)
    await pressKey(wc, 'Down')
    check('↓ on the last page goes round to the first one', await waitFor(() => isShown(wc, 'home'), 3000), JSON.stringify(await shownPane(wc)))
    // The window moves the focus to the entry it opened on the next frame; given here too, so that a window the system draws less often does not lag behind.
    await evaluate(wc, `document.querySelector('.settings-cat[aria-current=page]')?.focus()`)
    await pressKey(wc, 'Down')
    check('↓ opens the next page', await waitFor(() => isShown(wc, 'appearance'), 3000), JSON.stringify(await shownPane(wc)))

    // « Plus de réglages », at the foot of the page: closed, it says what it holds; a real click opens it, another closes it.
    await openPane('protection', undefined, false)
    const fold = () => evaluate<{ expanded: string | null; hidden: boolean | null; line: string }>(wc, `(() => { const b = document.querySelector('.settings-content .more-settings-toggle'); return { expanded: b?.getAttribute('aria-expanded') ?? null, hidden: document.querySelector('.settings-content .more-settings-body')?.hidden ?? null, line: b?.querySelector('.more-settings-what')?.textContent ?? '' } })()`)
    const closed = await fold()
    check('« Plus de réglages » is closed at first, and its line names what it holds', closed.expanded === 'false' && closed.hidden === true && closed.line.startsWith('Contient') && closed.line.includes('Mode de blocage'), JSON.stringify(closed))
    await clickOn(wc, '.settings-content .more-settings-toggle')
    check('a click opens it, and its rows are shown', await waitFor(async () => (await fold()).expanded === 'true' && (await fold()).hidden === false && (await rectIn(wc, '[data-setting~="httpsUpgrade"]')) !== null, 3000), JSON.stringify(await fold()))
    await clickOn(wc, '.settings-content .more-settings-toggle')
    check('another click closes it', await waitFor(async () => (await fold()).expanded === 'false', 3000), JSON.stringify(await fold()))
    check('no level to choose any more: the head of the page holds its name and its blurb only', (await count(wc, '.settings-level')) === 0)
    check('“Rétablir les valeurs par défaut” closes the page, under its fold', (await evaluate<boolean>(wc, `document.querySelector('.settings-content')?.lastElementChild?.classList.contains('reset-bar') === true`)) && (await textOf(wc, '.reset-bar .button')) === 'Rétablir les valeurs par défaut')

    await pressKey(wc, 'W', ['meta'])
    check('⌘W closes the window of Settings, not a tab behind it', await waitFor(() => settingsWindows().length === 0, 3000))
  })

  // ======================= « Pour commencer », and the updates in « À propos et mises à jour » =======================
  await section('the page « Pour commencer »', async () => {
    const wc = await openPane('home')
    check('it starts with the one entry of the guide', (await count(wc, '.settings-content .guide-card')) === 1 && (await textOf(wc, '.guide-card b')) === 'Régler en quelques questions')
    // Ten rows of a setting, and the level of protection, a preset drawn again under its search id; four of the eleven are presets.
    check('it draws again the choices of the first minutes, marked as mirrors, four of them presets', (await count(wc, '.settings-content [data-mirror]:is([data-setting], [data-search="protectionLevel"])')) === 11 && (await count(wc, '.settings-content .preset-row[data-mirror]')) === 4)
    // Every switch of the page may be on, or every one off (with a new profile the mirrors left as switches are all off): the colour that is missing
    // is then read from a copy of a switch with the other state, set beside it.
    const switchColours = await evaluate<{ on: string | null; off: string | null }>(wc, `(() => { const all = [...document.querySelectorAll('input[role=switch]')]; let on = all.find((e) => e.checked); let off = all.find((e) => !e.checked); let copy = null; if (!off && on) { copy = on.cloneNode(); copy.checked = false; on.after(copy); off = copy } else if (!on && off) { copy = off.cloneNode(); copy.checked = true; off.after(copy); on = copy } const colours = { on: on ? getComputedStyle(on).backgroundColor : null, off: off ? getComputedStyle(off).backgroundColor : null }; copy?.remove(); return colours })()`)
    check('a switch that is on is not the colour of one that is off', switchColours.on !== null && switchColours.off !== null && switchColours.on !== switchColours.off, JSON.stringify(switchColours))
    // The launch is a preset whose menu writes the windows of the last session and the loading of the tabs: « Une seule fenêtre », then back.
    remember('restoreWindows', 'loadAllTabsAtLaunch')
    const launchMenu = '.settings-content [data-mirror] select[aria-label="Quand vous ouvrez Lucium"]'
    await setValue(wc, launchMenu, 'une-fenetre')
    const oneWindow = await waitFor(() => settings().restoreWindows === false && settings().loadAllTabsAtLaunch === false, 3000)
    await setValue(wc, launchMenu, 'affiches')
    check('the mirror of « Quand vous ouvrez Lucium » changes the very settings, and back', oneWindow && (await waitFor(() => settings().restoreWindows === true, 3000)), JSON.stringify({ restoreWindows: settings().restoreWindows, loadAllTabsAtLaunch: settings().loadAllTabsAtLaunch }))
    // The text as the window draws it, with the non-breaking spaces inside the quotation marks (french-typography.ts).
    await clickOn(wc, '.settings-content .home-open', frenchSpaces('Ouvrir « Vie privée et sécurité »'))
    check('« Ouvrir « Vie privée et sécurité » » leads to its category', await waitFor(() => isShown(wc, 'protection'), 3000), JSON.stringify(await shownPane(wc)))

    const about = await openPane('about')
    check('« À propos et mises à jour » starts with the automatic updates', (await labelsOf(about, '.settings-content')).indexOf('Rechercher les mises à jour automatiquement') === 0, (await labelsOf(about, '.settings-content')).slice(0, 3).join('|'))
    // One line under the switch, the whole text (the request, what the server sees) behind « En savoir plus ».
    check('the “automatic update” row explains itself in one line, and the rest behind « En savoir plus »', (await evaluate<string>(about, `(() => { const row = document.querySelector('[data-setting="autoUpdate"]'); return (row?.querySelector('.pref-hint')?.textContent ?? '') + ' | ' + (row?.querySelector('.pref-more-text')?.textContent ?? '') })()`)).match(/chaque jour.* \| .*une fois par jour/) !== null)
    check('the “automatic update” switch changes the setting', await flips(about, 'Rechercher les mises à jour automatiquement', 'autoUpdate'))
    const tabs = await openPane('tabs')
    check('“Avertir avant de quitter”, beside the warning before closing a window, changes the setting', await flips(tabs, 'Avertir avant de quitter', 'warnBeforeQuitting'))
  })

  // ======================= Links (Navigation) =======================
  await section('the Links group of Navigation', async () => {
    const wc = await openPane('navigation', 'links')
    check('opened at the group “links”, the category is scrolled to it', await waitFor(() => nearTopOfContent(wc, '#links'), 3000))
    check('no picture on top of the group: the first thing is the text', (await rectIn(wc, '.links-hero')) === null)
    // The rows at the top of the page, then those of « Plus de réglages » (opened), in that order.
    const text = await textOf(wc, '.settings-content')
    const little = littleForms('fr')
    // At the top, the preset « Liens venus d’autres applications »; in the fold, the mini window, the Peek, then the rest of « Liens », whose first row
    // is the switch the preset stands for.
    // The row of the subpage of the routes is at the top, under the preset.
    const order = ['Liens venus d’autres applications', 'Diriger les liens de certains sites vers un espace', `La ${little.s} est une fenêtre`, `Fermer et archiver les ${little.p} oubliées`, 'Le Coup d’œil affiche', 'Coup d’œil avec ⇧-clic sur un lien', 'Coup d’œil pour les liens vers d’autres sites', `Ouvrir les liens d’autres applications dans une ${little.s}`]
    // Each text is looked for after the one before it: a hint may quote the label of a later row (the mini window's links row names « Coup d’œil pour les liens vers d’autres sites »).
    const positions: number[] = []
    for (const label of order) positions.push(text.indexOf(label, positions.length === 0 ? 0 : positions.at(-1)! + 1))
    check('the texts and rows come in order', positions.every((p) => p >= 0), JSON.stringify(positions))
    check('the second peek row carries its note', (await evaluate<boolean>(wc, `[...document.querySelectorAll('.pane-links .pref-hint')].some((h) => h.textContent.includes('Seulement pour les liens'))`)))
    check('a line separates the Peek from the mini window', (await count(wc, '.pane-links .pref-sep')) === 1)

    check('“Ouvrir les liens d’autres applications…” changes the setting', await flips(wc, `Ouvrir les liens d’autres applications dans une ${little.s}`, 'externalLinksInLittleArc'))
    check('the first peek switch changes the setting', await flips(wc, 'Coup d’œil avec ⇧-clic sur un lien', 'peekWithShift'))
    check('the second peek switch changes the setting', await flips(wc, 'Coup d’œil pour les liens vers d’autres sites', 'peekOnExternalLinks'))
    remember('littleArcArchiveHours')
    await setValue(wc, `select[aria-label="Fermer et archiver les ${little.p} oubliées"]`, '24')
    check('the delay menu changes how long mini-windows are kept', await waitFor(() => settings().littleArcArchiveHours === 24, 3000), String(settings().littleArcArchiveHours))

    // Link routing, on its subpage « Diriger les liens de certains sites vers un espace ».
    patch({ linkRoutes: [] })
    const space = store.get().spaces[0]!
    const routes = '.settings-content [data-subpage="linkroutes"]'
    await clickOn(wc, '.settings-content [data-subpage-entry="linkroutes"] button')
    check('the row of the routes opens their subpage, its name focused', await waitFor(() => isShown(wc, 'navigation', 'linkroutes'), 3000) && (await evaluate<string>(wc, `document.activeElement?.id ?? ''`)) === 'pane-heading' && (await textOf(wc, routes)).includes('Aucune règle'))
    const addDisabled = () => evaluate<boolean>(wc, `[...document.querySelectorAll('${routes} .pref-form .button')].find((b) => b.textContent.trim() === 'Ajouter')?.disabled ?? true`)
    check('a rule cannot be added without a site and a space', await addDisabled())
    await clickOn(wc, `${routes} input[aria-label="Site"]`)
    await typeKeys(wc, 'smoke-route.example')
    await setValue(wc, `${routes} select[aria-label="Espace"]`, space.id)
    check('with both, it can', await waitFor(async () => !(await addDisabled()), 3000))
    await clickOn(wc, `${routes} .pref-form .button`, 'Ajouter')
    check('adding it routes the site to the space', await waitFor(() => settings().linkRoutes.some((r) => r.host === 'smoke-route.example' && r.spaceId === space.id), 3000), JSON.stringify(settings().linkRoutes))
    await clickOn(wc, `${routes} .link-button`, 'Retirer')
    check('“Retirer” takes the rule away', await waitFor(() => settings().linkRoutes.length === 0, 3000))
    await clickOn(wc, '.settings-content .subpage-back')
    check('the way back leads to Navigation, the focus on the row of the routes', await waitFor(() => isShown(wc, 'navigation'), 3000) && (await evaluate<boolean>(wc, `document.activeElement?.closest('[data-subpage-entry="linkroutes"]') !== null`)))
    patch({ linkRoutes: original.linkRoutes ?? [] })

    // ⌥⌘N, the mini window from any application, is a shortcut valid outside Lucium: it is set in Clavier et souris. Its row follows the shortcut of the
    // command, and cannot be switched while there is none.
    const keyboard = await openPane('keyboard')
    check('the mini-window shortcut switch (Clavier et souris) changes the setting', await flips(keyboard, `Raccourci de la ${little.s} dans toutes les applications`, 'littleArcShortcut'))
    patch({ keyBindings: { ...settings().keyBindings, newLittleArc: '' } })
    check('without a shortcut for the command, the row says so and its switch is off the table', await waitFor(async () => (await evaluate<boolean>(keyboard, `(() => { const row = document.querySelector('.settings-content [data-setting="littleArcShortcut"]'); return !!row && row.querySelector('input[role=switch]').disabled && row.textContent.includes('n’a pas de raccourci') && row.textContent.includes('donnez-lui-en un') })()`)), 3000))
    patch({ keyBindings: { ...settings().keyBindings, newLittleArc: 'CmdOrCtrl+Alt+L' } })
    check('with another shortcut, the hint of the row shows it', await waitFor(async () => (await textOf(keyboard, '.settings-content [data-setting="littleArcShortcut"]')).includes(`⌥⌘L ouvre une ${little.s}`), 3000))
    patch({ keyBindings: original.keyBindings ?? {} })
  })

  // ======================= the site searches (Navigation; they were in the box "Réglages de la recherche" of the Profiles pane) =======================
  await section('the site searches of Navigation', async () => {
    const wc = await openPane('navigation', 'sitesearches')
    const group = 'section.pref-section[data-setting~="siteSearches"]'
    const searchesBefore = settings().siteSearches.length
    check('the group “Recherche dans un site” lists the site searches', (await waitRect(wc, group)) !== null && (await evaluate<string>(wc, `document.querySelector(${JSON.stringify(`${group} h3 .pref-title`)})?.textContent ?? ''`)) === 'Recherche dans un site' && (await count(wc, `${group} .pref-row code`)) === searchesBefore)
    await clickOn(wc, `${group} input[aria-label="Mot-clé"]`)
    await typeKeys(wc, 'smk')
    await clickOn(wc, `${group} input[aria-label="Nom"]`)
    await typeKeys(wc, 'Fumée')
    await clickOn(wc, `${group} input[aria-label="Adresse"]`)
    await typeKeys(wc, 'https://smoke.example/?q=%s')
    await clickOn(wc, `${group} .pref-form .button`, 'Ajouter')
    check('a keyword, a name and an address with %s add a site search', await waitFor(() => settings().siteSearches.some((x) => x.keyword === 'smk' && x.url === 'https://smoke.example/?q=%s'), 3000), JSON.stringify(settings().siteSearches.at(-1)))
    // "Retirer" of the row of this search, not of the first one listed.
    const remove = await evaluate<Rect | null>(
      wc,
      `(() => { const row = [...document.querySelectorAll(${JSON.stringify(`${group} .pref-row`)})].find((r) => r.querySelector('code')?.textContent === 'smk'); const b = row?.querySelector('.link-button'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`
    )
    if (remove) await clickRect(wc, remove)
    check('and “Retirer” takes it away', !!remove && (await waitFor(() => !settings().siteSearches.some((x) => x.keyword === 'smk'), 3000)) && settings().siteSearches.length === searchesBefore)
  })

  // ======================= Shortcuts (Clavier et souris) =======================
  await section('the shortcuts of Clavier et souris', async () => {
    patch({ keyBindings: {} })
    const wc = await openPane('keyboard', 'shortcuts')
    await waitRect(wc, '.shortcut-row')
    check('opened at “shortcuts”, the window shows the subpage of the editor', await waitFor(() => nearTopOfContent(wc, '#shortcuts'), 3000))
    const callout = await rectIn(wc, '.shortcuts-callout')
    const calloutButton = await rectIn(wc, '.shortcuts-callout .button')
    check('the “start with the basics” banner is shown, its button inside it', !!callout && callout.height > 0 && inside(calloutButton, callout), JSON.stringify({ callout, calloutButton }))
    const box = await rectIn(wc, '.shortcuts-box')
    const searchBox = await rectIn(wc, '.shortcuts-search')
    check('the list is a box with its search field shown', !!box && box.height > 0 && !!searchBox && searchBox.height > 0, JSON.stringify({ box, searchBox }))
    const row = await rectIn(wc, '.shortcut-row')
    const pill = await rectIn(wc, '.shortcut-row .shortcut-key')
    check('a row shows its shortcut in a pill that stays inside the row', !!row && !!pill && pill.width > 0 && inside(pill, row), JSON.stringify({ row, pill }))
    check('an unset shortcut reads “---”', await evaluate<boolean>(wc, `[...document.querySelectorAll('.shortcut-key')].some((k) => k.textContent === '---')`))
    check('the column beside it has the two keys, “Raccourcis personnalisés” and the reset button', (await textOf(wc, '.shortcuts-aside h2')) === 'Raccourcis personnalisés' && (await count(wc, '.shortcuts-aside .keycap')) === 2 && (await textOf(wc, '.shortcuts-aside-foot .button')) === 'Tout réinitialiser')

    // Recording a shortcut with the real keys. The search field of the list, not the one of the window.
    const search = '.shortcuts-search input[type=search]'
    const labelOf = (id: string) => evaluate<string>(wc, `[...document.querySelectorAll('.shortcut-row')].find((r) => r.querySelector('.shortcut-label').textContent === ${JSON.stringify(id)})?.querySelector('.shortcut-key').textContent ?? ''`)
    await setValue(wc, search, 'Épingler / désépingler')
    await waitFor(async () => (await count(wc, '.shortcut-row')) === 1, 3000)
    check('a command shows the shortcut it has (⌘D for the pin)', (await labelOf('Épingler / désépingler l’onglet')) === '⌘D', await labelOf('Épingler / désépingler l’onglet'))
    await clickOn(wc, '.shortcut-key')
    check('a click on the pill makes it listen', (await textOf(wc, '.shortcut-key.recording')) === 'Appuyez…')
    await pressKey(wc, 'Escape')
    check('Escape stops listening and keeps the shortcut', (await labelOf('Épingler / désépingler l’onglet')) === '⌘D' && (await count(wc, '.shortcut-key.recording')) === 0 && settings().keyBindings['pin'] === undefined)
    await clickOn(wc, '.shortcut-key')
    await pressKey(wc, 'Shift')
    check('a modifier alone is not a shortcut: the pill keeps listening', (await count(wc, '.shortcut-key.recording')) === 1)
    await pressKey(wc, '9', ['meta', 'alt', 'shift'])
    check('a combination is recorded', await waitFor(() => settings().keyBindings['pin'] === 'CmdOrCtrl+Alt+Shift+9', 3000), JSON.stringify(settings().keyBindings))
    check('the row shows it, under “Raccourcis personnalisés”, with “Réinitialiser”', await waitFor(async () => (await textOf(wc, 'section[aria-label="Raccourcis personnalisés"]')).includes('⌥⇧⌘9') && (await textOf(wc, 'section[aria-label="Raccourcis personnalisés"]')).includes('Réinitialiser'), 3000))
    check('and the menu bar follows', Menu.getApplicationMenu()?.items.some((m) => m.submenu?.items.some((i) => i.accelerator === 'CmdOrCtrl+Alt+Shift+9')) === true)
    await clickOn(wc, '.shortcut-reset')
    check('“Réinitialiser” gives the command its shortcut back', await waitFor(() => settings().keyBindings['pin'] === undefined, 3000))
    await clickOn(wc, '.shortcut-key')
    await pressKey(wc, 'Backspace')
    check('Backspace turns the shortcut off', await waitFor(() => settings().keyBindings['pin'] === '', 3000) && (await labelOf('Épingler / désépingler l’onglet')) === '---', await labelOf('Épingler / désépingler l’onglet'))

    // Conflicts, the basics and the resets.
    await setValue(wc, search, '')
    patch({ keyBindings: { newWindow: 'CmdOrCtrl+T' } })
    check('a shortcut used twice is shown in the warning colour', await waitFor(async () => (await count(wc, '.shortcut-key.clash')) === 2, 3000))
    check('…and written out under both commands, with the name of the other', (await count(wc, '.shortcut-clash-note')) === 2 && (await textOf(wc, '.shortcut-clash-note')).startsWith(frenchSpaces('En conflit avec « ')))
    await clickOn(wc, '.shortcuts-aside-foot .round-button')
    check('the “…” button opens a menu with the resets', (await waitRect(wc, '.menu-pop')) !== null && (await textOf(wc, '.menu-pop')).includes('Réinitialiser tous les raccourcis') && (await textOf(wc, '.menu-pop')).includes('Retirer les raccourcis en conflit'))
    await clickOn(wc, '.menu-pop button', 'Retirer les raccourcis en conflit')
    check('“Retirer les raccourcis en conflit” keeps the shortcut the user saved (newWindow) and switches the default command off', await waitFor(() => settings().keyBindings['newWindow'] === 'CmdOrCtrl+T' && settings().keyBindings['newTab'] === '', 3000), JSON.stringify(settings().keyBindings))
    check('the status line says what was kept and what was removed', await waitFor(async () => (await textOf(wc, '.shortcuts-notice')).includes('Raccourci retiré de') && (await textOf(wc, '.shortcuts-notice')).includes('Annuler le retrait'), 3000))
    await clickOn(wc, '.shortcuts-notice button', 'Annuler le retrait')
    check('“Annuler le retrait” gives the default command its shortcut back', await waitFor(() => settings().keyBindings['newWindow'] === 'CmdOrCtrl+T' && settings().keyBindings['newTab'] === undefined, 3000), JSON.stringify(settings().keyBindings))
    check('“Tout réinitialiser” is enabled once something is customised, and resets everything', (await evaluate<boolean>(wc, `!document.querySelector('.shortcuts-aside-foot .button').disabled`)) && (await clickOn(wc, '.shortcuts-aside-foot .button', 'Tout réinitialiser')) && (await waitFor(() => Object.keys(settings().keyBindings).length === 0, 3000)))
    check('…and is disabled again', await waitFor(async () => await evaluate<boolean>(wc, `document.querySelector('.shortcuts-aside-foot .button').disabled`), 3000))
    patch({ keyBindings: original.keyBindings ?? {} })
  })

  // ======================= Icon (À propos et mises à jour) =======================
  await section('the icon of the application', async () => {
    remember('appIcon')
    const wc = await openPane('about', 'icon')
    check('eight icons (the fan logo in eight colours), one radio each, the current one marked', (await count(wc, '#icon [role=radio]')) === 8 && (await count(wc, '#icon [role=radio][aria-checked=true]')) === 1 && (await textOf(wc, '#icon .icon-current')) === 'Icône actuelle')
    const other = await evaluate<string>(wc, `[...document.querySelectorAll('#icon [role=radio]')].find((r) => r.getAttribute('aria-checked') === 'false').textContent`)
    await clickOn(wc, '#icon [role=radio][aria-checked=false]')
    check('a click on another icon picks it for the Dock', await waitFor(() => settings().appIcon !== original.appIcon, 3000) && (await waitFor(async () => (await textOf(wc, '#icon [role=radio][aria-checked=true]')).includes(other.split('Icône')[0]!.trim()), 3000)), `${settings().appIcon} / ${other}`)
    patch({ appIcon: original.appIcon as string })
  })

  // ======================= the rows of the former Advanced pane, each in the category of what it does now =======================
  await section('the rows of the advanced settings, in their categories', async () => {
    let wc = await openPane('tabs')
    // « Fenêtre » waits in « Plus de réglages » (the drag of the window); the windows of the last session are a switch of « Au lancement », under its preset.
    const windowCard = await evaluate<{ labels: string[]; icons: number } | null>(
      wc,
      `(() => { const groups = [...document.querySelectorAll('.settings-content .pref-section')].filter((x) => x.querySelector('h3 .pref-title')?.textContent === 'Fenêtre').map((s) => s.querySelector('.pref-group.with-icons')).filter(Boolean); if (groups.length === 0) return null; const rows = groups.flatMap((g) => [...g.querySelectorAll('.pref-row')]); return { labels: rows.map((r) => r.querySelector('.pref-label')?.firstChild?.textContent?.trim() ?? ''), icons: groups.reduce((n, g) => n + g.querySelectorAll('.pref-icon').length, 0) } })()`
    )
    check('Onglets et fenêtres › Fenêtre is a card of rows with icons: drag the window', !!windowCard && windowCard.labels[0]!.startsWith('Déplacer la fenêtre depuis le haut des pages'), JSON.stringify(windowCard))
    check('each row of such a card has its icon', !!windowCard && windowCard.labels.length > 0 && windowCard.icons === windowCard.labels.length, JSON.stringify(windowCard))
    check('“Rouvrir les fenêtres de la session précédente” changes the setting', await flips(wc, 'Rouvrir les fenêtres de la session précédente', 'restoreWindows'))
    check('“Déplacer la fenêtre depuis le haut des pages” changes the setting', await flips(wc, 'Déplacer la fenêtre depuis le haut des pages', 'dragWindowFromToolbar'))
    check('“Image dans l’image en quittant un onglet vidéo” changes the setting', await flips(wc, 'Image dans l’image en quittant un onglet vidéo', 'autoPictureInPicture'))

    wc = await openPane('appearance')
    check('“Adresse complète dans la barre d’outils” (Apparence › Affichage) changes the setting', await flips(wc, 'Adresse complète dans la barre d’outils', 'fullUrlInToolbar'))
    check('“Donner le thème de l’espace aux pages web” (Apparence) changes the setting', await flips(wc, 'Donner le thème de l’espace aux pages web', 'allowThemeToSites'))
    // The previews were a dialog of the former General pane; their switch is a row of Apparence › Affichage now.
    check('“Afficher les aperçus au survol des onglets” (Apparence › Affichage) is the hover cards of the sidebar', await flips(wc, 'Afficher les aperçus au survol des onglets', 'hoverCards'))

    wc = await openPane('tools')
    check('“Activer les Retouches…” (Extensions et outils) changes the setting', await flips(wc, 'Activer les Retouches sur les sites web', 'boostsEnabled'))
    check('the extensions have a group of their own in Extensions et outils', (await groupTitles(wc)).includes('Extensions'), (await groupTitles(wc)).join('|'))

    // What Lucium added to the former Advanced pane is in Vie privée et sécurité, each group titled; the remembered permissions on their subpage.
    wc = await openPane('protection')
    const titles = await groupTitles(wc)
    check('Vie privée et sécurité holds the groups Lucium added, titled', ['Protection', 'Bloqueur', 'Pistage et HTTPS', 'Autorisations des sites', 'Verrouillage', 'Réseau et listes de filtres'].every((t) => titles.includes(t)), titles.join('|'))
    wc = await openPane('protection', 'permissions')
    check('opened at “permissions”, the window shows the subpage of the remembered permissions', (await waitFor(() => nearTopOfContent(wc, '#permissions'), 3000)) && (await textOf(wc, '#pane-heading')) === 'Autorisations mémorisées')
  })

  // ======================= Profiles =======================
  await section('the Profiles category', async () => {
    patch({ profileNames: {}, profiles: {}, searchSuggestions: true, autoArchiveHours: 12 })
    const wc = await openPane('profiles')
    await waitRect(wc, '.profile-box')
    check('the introduction comes first', (await textOf(wc, '.pref-intro')).includes('Les profils séparent vos données entre les espaces'))
    check('the list of profiles is a box whose title band says “Vos profils”', (await rectIn(wc, '.profile-box')) !== null && (await textOf(wc, '.profile-box-head')) === 'Vos profils')
    check('a profile is a button of its own (reached with Tab, not a list of options); the one picked is marked as pressed, the default one first', (await rectIn(wc, '.profile-list button')) !== null && (await textOf(wc, '.profile-list button.current')).includes('Profil par défaut') && (await evaluate<string>(wc, `document.querySelector('.profile-list button.current')?.getAttribute('aria-pressed') ?? ''`)) === 'true' && (await count(wc, '.profile-list button[aria-pressed="true"]')) === 1 && (await count(wc, '.profile-list [role=option]')) === 0)
    check('its foot has + − and the rename pictogram', (await count(wc, '.profile-box-foot button')) === 3)
    const details = await evaluate<string[]>(wc, `[...document.querySelectorAll('.profile-details .pref-section h3 .pref-title')].map((t) => t.textContent.trim())`)
    check('the settings of the profile picked: its own rows, its history and network, its data', JSON.stringify(details) === JSON.stringify([frenchSpaces('Profil « Profil par défaut »'), 'Historique et réseau', 'Vos données et réglages']), details.join('|'))
    const labels = (await labelsOf(wc, '.profile-details')).join('|')
    const order = ['Moteur de recherche', 'Inclure les suggestions de recherche', 'Archiver les onglets du jour inactifs', 'Dossier de téléchargement', 'Effacer les données de navigation', 'Effacer les données des profils inutilisés']
    const where = order.map((t) => labels.indexOf(t))
    check('the rows are there in this order: search engine, suggestions, archiving, downloads, clearing', where.every((p, i) => p >= 0 && (i === 0 || p > where[i - 1]!)), labels.slice(0, 400))

    check('“Inclure les suggestions de recherche” changes the setting', await flips(wc, 'Inclure les suggestions de recherche', 'searchSuggestions'))
    remember('searchUrlTemplate')
    await setValue(wc, '.profile-details select[aria-label="Moteur de recherche"]', 'Google')
    check('the search engine menu changes the engine of the default profile', await waitFor(() => settings().searchUrlTemplate.includes('google.'), 3000), settings().searchUrlTemplate)
    // "Personnalisé" leads to the address of an engine of one's own; the settings keep it only once it can search (a half-typed one would be put back to the old engine).
    await setValue(wc, '.profile-details select[aria-label="Moteur de recherche"]', '__custom__')
    check('“Personnalisé” opens the search dialog with the address of the engine', (await waitRect(wc, '.dialog')) !== null && (await textOf(wc, '.dialog h2')) === 'Réglages de la recherche' && (await count(wc, '.dialog input[aria-label="Adresse de recherche"]')) === 1)
    await clickOn(wc, '.dialog input[aria-label="Adresse de recherche"]')
    await typeKeys(wc, 'https://moteur.example/?q=')
    check('a half-typed address is not kept and is flagged: the engine stays', settings().searchUrlTemplate.includes('google.') && (await count(wc, '.dialog [role=alert]')) === 1, settings().searchUrlTemplate)
    await typeKeys(wc, '%s')
    check('once it can search, the address is the engine of the profile', await waitFor(() => settings().searchUrlTemplate === 'https://moteur.example/?q=%s', 3000), settings().searchUrlTemplate)
    check('…and the engine menu says “Personnalisé”', (await evaluate<string>(wc, `document.querySelector('.profile-details select[aria-label="Moteur de recherche"]').value`)) === '__custom__')
    await pressKey(wc, 'Escape')
    await waitFor(async () => (await count(wc, '.dialog')) === 0, 3000)
    await setValue(wc, '.profile-details select[aria-label="Archiver les onglets du jour inactifs"]', '24')
    check('“Archiver les onglets du jour inactifs” changes the delay', await waitFor(() => settings().autoArchiveHours === 24, 3000), String(settings().autoArchiveHours))
    check('and says what it does', (await waitFor(async () => (await textOf(wc, '.profile-details .pref-message')).includes('après 1 jour'), 3000)), await textOf(wc, '.profile-details .pref-message'))
    patch({ autoArchiveHours: 12 })

    // "Effacer les données de navigation": a button of the group "Vos données et réglages" (it was a row with an arrow in the former "Your Data and Settings").
    // What says that the data were cleared is the sentence of the row (the footnote of the group says « effacées » too, of the profiles nobody uses).
    const clear = '.profile-details .pref-row .button'
    const clearedSentence = frenchSpaces('Données du profil « Profil par défaut » effacées.')
    const statuses = () => evaluate<string[]>(wc, `[...document.querySelectorAll('.profile-details [role=status]')].map((el) => el.textContent.trim())`)
    const saysCleared = async () => (await statuses()).includes(clearedSentence)
    const boxAndRow = async () => JSON.stringify({ boxes: await count(wc, '.adlg'), statuses: await statuses() })
    await clickOn(wc, clear, 'Effacer')
    check('“Effacer les données de navigation” asks first, in the standard box',(await waitRect(wc, '.adlg')) !== null && (await textOf(wc, '.adlg-title')) === frenchSpaces('Effacer les données de navigation ?') && (await count(wc, '.adlg[role=alertdialog]')) === 1)
    await pressKey(wc, 'Escape')
    check('Escape cancels it', (await waitFor(async () => (await count(wc, '.adlg')) === 0, 3000)) && !(await saysCleared()), await boxAndRow())
    await clickOn(wc, clear, 'Effacer')
    await waitRect(wc, '.adlg')
    check('“Annuler” has the focus when the box opens (it is the default button of a box that erases)', await evaluate<boolean>(wc, `document.activeElement === document.querySelector('.adlg-cancel')`))
    await pressKey(wc, 'Return')
    check('Return presses “Annuler”, not the red button: the box goes and nothing is erased', (await waitFor(async () => (await count(wc, '.adlg')) === 0, 3000)) && !(await saysCleared()), await boxAndRow())
    await clickOn(wc, clear, 'Effacer')
    await waitRect(wc, '.adlg')
    await clickOn(wc, '.adlg-danger')
    check('the red button clears the profile’s data and the category says so', await waitFor(saysCleared, 6000), await boxAndRow())

    // The standard box, on the deletion of a profile nobody uses.
    patch({ profileNames: { 'smoke-del': 'À supprimer' } })
    await waitFor(async () => (await textOf(wc, '.profile-list')).includes('À supprimer'), 3000)
    await clickOn(wc, '.profile-list button', 'À supprimer')
    check('a profile no space uses can be deleted: the “−” button is on', await waitFor(async () => !(await evaluate<boolean>(wc, `[...document.querySelectorAll('.profile-box-foot button')][1].disabled`)), 3000))
    await clickOn(wc, '.profile-box-foot button', 'Supprimer le profil')
    const dialog = await waitRect(wc, '.adlg')
    check('the box names the profile to delete', !!dialog && (await textOf(wc, '.adlg-title')) === frenchSpaces('Supprimer le profil « À supprimer » ?'))
    const parts = await evaluate<Record<string, Rect>>(wc, `(() => { const g = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }; return { icon: g('.adlg-icon'), title: g('.adlg-title'), cancel: g('.adlg-cancel'), confirm: g('.adlg-btn:not(.adlg-cancel)') } })()`)
    const apart = (a: Rect, b: Rect) => a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1
    check('the icon, the title and both buttons are inside the box, and the two buttons do not overlap', !!dialog && ['icon', 'title', 'cancel', 'confirm'].every((part) => inside(parts[part], dialog)) && apart(parts['cancel']!, parts['confirm']!), JSON.stringify({ dialog, parts }))
    check('Cancel has its key (Escape) written on it, the red confirmation none (Return does not erase)', (await textOf(wc, '.adlg-cancel kbd')) === 'ESC' && (await count(wc, '.adlg-danger')) === 1 && (await count(wc, '.adlg-danger kbd')) === 0)
    await pressKey(wc, 'Escape')
    check('Escape leaves the profile alone', (await waitFor(async () => (await count(wc, '.adlg')) === 0, 3000)) && settings().profileNames['smoke-del'] === 'À supprimer')
    await clickOn(wc, '.profile-box-foot button', 'Supprimer le profil')
    await waitRect(wc, '.adlg')
    await clickOn(wc, '.adlg-danger')
    check('the red button deletes it', await waitFor(() => settings().profileNames['smoke-del'] === undefined, 6000), JSON.stringify(settings().profileNames))
    check('the default profile cannot be deleted: its “−” is off and says why', (await waitFor(async () => (await textOf(wc, '.profile-list button.current')).includes('Profil par défaut'), 3000)) && (await evaluate<boolean>(wc, `[...document.querySelectorAll('.profile-box-foot button')][1].disabled && [...document.querySelectorAll('.profile-box-foot button')][1].title.includes('ne peut pas être supprimé')`)))
    patch({ profileNames: original.profileNames ?? {}, profiles: original.profiles ?? {} })
  })

  // ======================= the theme panel (a list of themes, the drawing of the sidebar, the advanced controls under a disclosure) =======================
  await section('the theme editor', async () => {
    const space = store.get().spaces[0]!
    const originalTheme = structuredClone(space.theme)
    browser.dispatch({ type: 'space/select', id: space.id })
    // A page that declares no colour is the one on screen (« Couleur du site » is checked on it below): the tab an earlier check left there may declare one.
    browser.dispatch({ type: 'tab/open', url: 'about:blank' })
    const plainTab = store.get().tabs.at(-1)!.id
    await sleep(300)
    const themeOf = () => store.get().spaces.find((x) => x.id === space.id)!.theme
    browser.dispatch({ type: 'space/update', id: space.id, patch: { theme: { ...originalTheme, baseColors: ['#4f6bd6', '#d6a74f'], harmony: 'complementary', appearance: 'auto', overlay: 'grain', noise: 0.5, intensity: 0.5, angle: 135 } } })
    browser.openOverlay({ panel: 'theme', spaceId: space.id })
    await waitRect(ui, '.theme-pop')
    // The panel is read once its list and its drawing of the sidebar are there.
    await waitFor(async () => (await count(ui, '.tp-theme')) >= 20 && (await rectIn(ui, '.tp-thumb')) !== null)
    check('nothing overflows sideways: no horizontal scroll bar', await evaluate<boolean>(ui, `(() => { const p = document.querySelector('.theme-pop'); return p.scrollWidth <= p.clientWidth })()`))
    check('the list holds the ready themes by name, no page and no arrow, and the drawing of the sidebar stands beside it', (await count(ui, '.tp-theme')) >= 20 && (await count(ui, '.preset-arrow')) === 0 && (await count(ui, '.ready-arrow')) === 0 && (await rectIn(ui, '.tp-thumb')) !== null)
    check('three buttons say the appearance: Auto, Clair, Sombre', (await evaluate<string[]>(ui, `[...document.querySelectorAll('.tp-head .ip-seg button')].map((b) => b.textContent)`)).join() === 'Auto,Clair,Sombre')

    // The three modes.
    for (const [label, mode] of [['Clair', 'light'], ['Sombre', 'dark'], ['Auto', 'auto']] as const) {
      await clickOn(ui, '.tp-head .ip-seg button', label)
      check(`the “${label}” button makes the theme ${mode}`, await waitFor(() => themeOf().appearance === mode, 3000), themeOf().appearance)
    }

    // A named colour, the hue and the strength.
    await clickOn(ui, '.tp-swatch[aria-label="Corail"]')
    check('a click on a named colour gives it to the theme', await waitFor(() => themeOf().baseColors[0] === '#e05d5d', 3000), themeOf().baseColors[0])
    await setValue(ui, '.tp-sliders label:nth-child(2) input', '30')
    check('the strength slider sets the intensity', await waitFor(() => Math.abs(themeOf().intensity - 0.3) < 0.01, 3000), String(themeOf().intensity))

    // Advanced controls: the pad, + and −, the codes.
    await evaluate(ui, `document.querySelector('.theme-advanced').open = true`)
    await sleep(200)
    const padBox = await rectIn(ui, '.color-pad')
    check('the colour pad is shown inside the disclosure', !!padBox && padBox.width > 0 && padBox.height > 0 && inside(padBox, await rectIn(ui, '.theme-advanced')), JSON.stringify(padBox))
    const minus = '.pad-count button[aria-label="Retirer une couleur"]'
    const plus = '.pad-count button[aria-label="Ajouter une couleur"]'
    await clickOn(ui, plus)
    check('+ adds a third colour, and is off at three', (await waitFor(() => themeOf().baseColors.length === 3, 3000)) && (await evaluate<boolean>(ui, `document.querySelector('${plus}').disabled`)))
    await clickOn(ui, minus)
    await clickOn(ui, minus)
    check('− removes them down to one', await waitFor(() => themeOf().baseColors.length === 1, 3000) && (await evaluate<boolean>(ui, `document.querySelector('${minus}').disabled`)))
    await clickOn(ui, plus)
    await waitFor(() => themeOf().baseColors.length === 2, 3000)
    const pad = (await rectIn(ui, '.color-pad'))!
    const before = themeOf().baseColors[0]
    mouse(ui, 'mouseMove', pad.x + pad.width * 0.3, pad.y + pad.height * 0.5)
    mouse(ui, 'mouseDown', pad.x + pad.width * 0.3, pad.y + pad.height * 0.5)
    for (const f of [0.35, 0.4, 0.6]) {
      mouse(ui, 'mouseMove', pad.x + pad.width * f, pad.y + pad.height * 0.5)
      await sleep(40)
    }
    mouse(ui, 'mouseUp', pad.x + pad.width * 0.6, pad.y + pad.height * 0.5)
    check('a drag across the pad moves the first colour and the others follow', await waitFor(() => themeOf().baseColors[0] !== before && themeOf().baseColors[1] !== undefined, 3000), JSON.stringify(themeOf().baseColors))
    await clickOn(ui, '.theme-advanced label input.tk-field')
    await evaluate(ui, `document.querySelector('.theme-advanced label input.tk-field').select()`)
    await typeKeys(ui, '#336699')
    check('a colour code typed in the field is the first colour', await waitFor(() => themeOf().baseColors[0] === '#336699', 3000), themeOf().baseColors[0])
    await clickOn(ui, '.segmented button', 'Monochrome')
    check('a harmony button changes the harmony', await waitFor(() => themeOf().harmony === 'monochrome', 3000))
    check('the gradient’s direction, the amount of texture and the two other options are there', (await textOf(ui, '.theme-advanced')).includes('Direction du dégradé') && (await textOf(ui, '.theme-advanced')).includes('Quantité de texture') && (await textOf(ui, '.theme-advanced')).includes('Couleurs vives') && (await textOf(ui, '.theme-advanced')).includes('Translucidité'))
    const siteColourClicked = await clickOn(ui, '.tp-foot .tk-btn', 'Couleur du site')
    const siteColourSaid = await waitFor(async () => (await textOf(ui, '.tp-note.warning')).includes('ne déclare pas de couleur'), 3000)
    check('there is no site colour to take on this page: the panel says so', siteColourClicked && siteColourSaid, JSON.stringify({ clicked: siteColourClicked, note: await textOf(ui, '.tp-note'), tab: store.get().tabs.find((t) => t.id === store.get().activeTabBySpace[store.get().activeSpaceId])?.url, colours: themeOf().baseColors }))
    await clickOn(ui, '.tp-foot .tk-btn', 'Réinitialiser')
    check('“Réinitialiser” brings back the colours the panel opened with', await waitFor(() => themeOf().baseColors[0] === '#4f6bd6' && themeOf().baseColors.length === 2, 3000), JSON.stringify(themeOf().baseColors))
    // Escape goes back to the theme the panel opened with, and closes it; “Terminé” keeps what was done.
    await clickOn(ui, '.tp-swatch[aria-label="Vert"]')
    await waitFor(() => themeOf().baseColors[0] === '#5fbe72', 3000)
    await pressKey(ui, 'Escape')
    check('Escape puts the colours the panel opened with back, and closes it', (await waitFor(() => browser.currentPanel() === null, 3000)) && themeOf().baseColors[0] === '#4f6bd6', JSON.stringify(themeOf().baseColors))
    browser.openOverlay({ panel: 'theme', spaceId: space.id })
    await waitRect(ui, '.theme-pop')
    await clickOn(ui, '.tp-swatch[aria-label="Vert"]')
    await clickOn(ui, '.tp-foot .tk-btn.primary', 'Terminé')
    check('“Terminé” keeps them and closes the panel', (await waitFor(() => browser.currentPanel() === null, 3000)) && themeOf().baseColors[0] === '#5fbe72', JSON.stringify(themeOf().baseColors))
    browser.dispatch({ type: 'space/update', id: space.id, patch: { theme: originalTheme } })
    if (store.get().tabs.some((t) => t.id === plainTab)) browser.dispatch({ type: 'tab/close', id: plainTab })
  })

  // ======================= the space sheet, the space manager, history, the tab editor =======================
  await section('the space sheet and the managers', async () => {
    browser.openOverlay({ panel: 'spacecreate' })
    await waitRect(ui, '.spacecreate')
    const sheet = await rectIn(ui, '.sh.spacecreate')
    check('the sheet is a small editor of the templates, shown', !!sheet && sheet.width > 0 && sheet.height > 0, JSON.stringify(sheet))
    check('its main button is off while the name is empty, and the foot says why', (await evaluate<boolean>(ui, `document.querySelector('.spacecreate .tk-btn.primary').disabled`)) && (await textOf(ui, '.spacecreate .sc-hint')) === 'Donnez un nom pour créer')
    check('it proposes eight icons and ten named colours', (await count(ui, '.spacecreate .sc-emoji button')) === 8 && (await count(ui, '.spacecreate .spacecreate-swatch')) === 10)
    await clickOn(ui, '.spacecreate input.tk-field')
    await typeKeys(ui, 'vacances')
    check('a name that says something brings its icons first: “vacances” gives 🏖️', await waitFor(async () => (await textOf(ui, '.spacecreate-icon')) === '🏖️', 3000), await textOf(ui, '.spacecreate-icon'))
    check('…and turns the main button on', await waitFor(() => evaluate<boolean>(ui, `!document.querySelector('.spacecreate .tk-btn.primary').disabled`), 3000))
    await clickOn(ui, '.spacecreate .tk-btn', 'Annuler')
    check('“Annuler” closes the sheet and creates nothing', await waitFor(() => browser.currentPanel() === null, 3000))

    // The space manager.
    const spaces = () => store.get().spaces
    const spacesBeforeCreate = spaces().length
    browser.dispatch({ type: 'space/create', name: 'Gérée', emoji: '🧪', hue: 200 })
    await waitFor(() => spaces().length === spacesBeforeCreate + 1, 3000)
    const extra = spaces().at(-1)!.id
    browser.openOverlay({ panel: 'spaces' })
    await waitRect(ui, '.sm-row')
    check('the manager lists every space, with its profile and its tabs', (await count(ui, '.sm-row:not(.archived)')) === spaces().length && (await textOf(ui, '.sm-panel')).includes('Gérée'))
    const orderBefore = spaces().map((x) => x.id)
    const index = orderBefore.indexOf(extra)
    await clickOn(ui, `.sm-row[data-id="${extra}"] button[aria-label^="Monter"]`)
    check('↑ moves a space up', await waitFor(() => spaces().map((x) => x.id).indexOf(extra) === index - 1, 3000), spaces().map((x) => x.id).join())
    await clickOn(ui, `.sm-row[data-id="${extra}"] button[aria-label^="Descendre"]`)
    check('↓ moves it down again', await waitFor(() => spaces().map((x) => x.id).indexOf(extra) === index, 3000))
    check('the first space cannot go up, the last cannot go down', (await evaluate<boolean>(ui, `document.querySelector('.sm-row:first-child button[aria-label^="Monter"]').disabled && document.querySelector('.sm-row:not(.archived):last-of-type button[aria-label^="Descendre"]').disabled`)))
    await clickOn(ui, `.sm-row[data-id="${extra}"] button[aria-label^="Supprimer"]`)
    check('“Supprimer” takes the row away at once and offers “Annuler” for eight seconds; nothing is deleted yet', (await count(ui, `.sm-row[data-id="${extra}"]`)) === 0 && (await textOf(ui, '.lp-undo')).includes('Annuler') && spaces().some((x) => x.id === extra))
    await clickOn(ui, '.lp-undo .tk-btn')
    check('“Annuler” brings the row back, and the space was never deleted', (await waitFor(async () => (await count(ui, `.sm-row[data-id="${extra}"]`)) === 1, 3000)) && spaces().some((x) => x.id === extra))
    await clickOn(ui, `.sm-row[data-id="${extra}"] button[aria-label^="Supprimer"]`)
    check('and left alone for eight seconds, the deletion is made', await waitFor(() => !spaces().some((x) => x.id === extra), 11000))
    await clickOn(ui, '.sm-row:first-child .lp-main')
    check('a click on a row opens “Personnaliser l’espace” for that space', await waitFor(() => (browser.currentOverlay() as { panel?: string; spaceId?: string } | null)?.panel === 'space' && (browser.currentOverlay() as { spaceId?: string }).spaceId === spaces()[0]!.id, 3000))
    browser.openOverlay({ panel: 'spaces' })
    await waitRect(ui, '.sm-row')
    await clickOn(ui, '.sm-panel .lp-head .tk-btn', 'Nouvel espace')
    check('“Nouvel espace…” opens the sheet', await waitFor(() => browser.currentOverlay()?.panel === 'spacecreate', 3000))
    browser.openOverlay({ panel: 'spaces' })
    await waitRect(ui, '.sm-row')
    await clickOn(ui, '.sm-panel .lp-foot .tk-btn.primary', 'Terminé')
    check('“Terminé” closes the manager', await waitFor(() => browser.currentPanel() === null, 3000))

    // The history.
    ctx.history.of('default').record('https://smoke-history.example/alpha', 'Alpha de fumée', Date.now())
    ctx.history.of('default').record('https://smoke-history.example/beta', 'Bêta de fumée', Date.now() - 1000)
    browser.openOverlay({ panel: 'history' })
    await waitRect(ui, '.hist-pages li')
    check('the history opens with its search field focused', await waitFor(() => evaluate<boolean>(ui, `document.activeElement === document.querySelector('.hist-panel input[type=search]')`), 3000))
    await typeKeys(ui, 'bêta de fumée')
    check('typing filters the list', await waitFor(async () => (await count(ui, '.hist-pages li')) === 1 && (await textOf(ui, '.hist-pages')).includes('Bêta de fumée'), 3000))
    await clickOn(ui, '.hist-pages li .tk-btn', 'Oublier')
    // The page leaves the list at once and is forgotten for good when the six seconds to take it back have passed.
    check('“Oublier” forgets the page', await waitFor(async () => (await textOf(ui, '.hist-panel')).includes('Aucun résultat'), 3000) && (await waitFor(() => ctx.history.of('default').search('Bêta de fumée').length === 0, 9000)))
    await setValue(ui, '.hist-panel input[type=search]', 'alpha de fumée')
    await waitFor(async () => (await count(ui, '.hist-pages li')) === 1, 3000)
    const tabsBefore = store.get().tabs.length
    await clickOn(ui, '.hist-pages li .lp-main')
    check('a click on a page opens it in a tab and closes the panel', (await waitFor(() => store.get().tabs.length === tabsBefore + 1 && store.get().tabs.some((t) => t.url.includes('smoke-history.example/alpha')), 3000)) && browser.currentPanel() === null)
    for (const t of store.get().tabs.filter((x) => x.url.includes('smoke-history.example'))) browser.dispatch({ type: 'tab/close', id: t.id })
    ctx.history.of('default').remove('https://smoke-history.example/alpha')

    // The tab editor.
    browser.dispatch({ type: 'tab/open', url: 'about:blank' })
    const tab = store.get().tabs.at(-1)!
    browser.openOverlay({ panel: 'tab', tabId: tab.id, focus: 'name' })
    await waitRect(ui, '.tab-editor input.tk-field')
    await typeKeys(ui, 'Renommé')
    // Return as a keyboard types it, with its character: a form sends itself on it (implicit submission), not on the bare key down.
    ui.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    ui.sendInputEvent({ type: 'char', keyCode: '\r' })
    ui.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    check('Return in the name field renames the tab and closes the panel', await waitFor(() => store.get().tabs.find((t) => t.id === tab.id)?.customTitle === 'Renommé' && browser.currentPanel() === null, 3000), JSON.stringify({ customTitle: store.get().tabs.find((t) => t.id === tab.id)?.customTitle, panel: browser.currentPanel(), field: await evaluate<string>(ui, `document.querySelector('.tab-editor input.tk-field')?.value ?? 'gone'`), focus: await evaluate<string>(ui, `document.activeElement?.className ?? ''`) }))
    browser.openOverlay({ panel: 'tab', tabId: tab.id, focus: 'icon' })
    await waitRect(ui, '.tab-editor .emoji')
    await clickOn(ui, '.tab-editor .emoji', '🔥')
    await clickOn(ui, '.tab-editor .tk-btn.primary', 'Enregistrer')
    check('an emoji picked and saved gives the tab that icon', await waitFor(() => store.get().tabs.find((t) => t.id === tab.id)?.icon === '🔥', 3000))
    browser.openOverlay({ panel: 'tab', tabId: tab.id, focus: 'icon' })
    await waitRect(ui, '.tab-editor .emoji')
    await clickOn(ui, '.tab-editor .tk-btn', 'Reprendre l’icône du site')
    await clickOn(ui, '.tab-editor .tk-btn.primary', 'Enregistrer')
    check('“Reprendre l’icône du site” takes it back', await waitFor(() => !store.get().tabs.find((t) => t.id === tab.id)?.icon, 3000))
    browser.closeOverlay()
    browser.dispatch({ type: 'tab/close', id: tab.id })
  })

  // ======================= the task manager =======================
  await section('the task manager', async () => {
    const item = (...path: string[]) => {
      let items = Menu.getApplicationMenu()!.items
      let found
      for (const label of path) {
        found = items.find((i) => i.label === label)
        items = found?.submenu?.items ?? []
      }
      return found
    }
    item('Aide', 'Dépannage', 'Ouvrir le gestionnaire de tâches')?.click()
    const taskWindow = () => ElectronWindow.getAllWindows().find((w) => w.getTitle() === 'Gestionnaire de tâches')
    check('the task manager opens in a window of its own', await waitFor(() => !!taskWindow(), 5000))
    const wc = taskWindow()!.webContents
    await waitFor(async () => (await count(wc, '.task-manager tbody tr')) > 1, 6000)
    // The Settings window is no longer a fixed dark grey: it follows the appearance with the tokens, and the task manager takes the same background (--s-bg).
    check('it has the background of the Settings window (the --s-bg token, light or dark like the system)', await evaluate<boolean>(wc, `(() => { const probe = document.createElement('div'); probe.style.background = 'var(--s-bg)'; document.body.append(probe); const wanted = getComputedStyle(probe).backgroundColor; probe.remove(); return wanted !== '' && wanted !== 'rgba(0, 0, 0, 0)' && getComputedStyle(document.querySelector('.task-manager')).backgroundColor === wanted })()`))
    check('its columns are the task, the type, the memory, the processor (in % of a core) and the process id', JSON.stringify(await evaluate<string[]>(wc, `[...document.querySelectorAll('.task-manager th')].map((h) => h.textContent.replace(/[▲▼ ]+$/, ''))`)) === JSON.stringify(['Tâche', 'Type', 'Mémoire', 'Processeur (% d’un cœur)', 'ID du processus']))
    const rows = () => evaluate<string[]>(wc, `[...document.querySelectorAll('.task-manager tbody tr td:last-child')].map((c) => c.textContent)`)
    await clickOn(wc, '.task-sort', 'ID du processus')
    const ascending = (await rows()).map(Number)
    check('a click on a header sorts by it, ascending first', ascending.length > 1 && ascending.every((v, i) => i === 0 || v >= ascending[i - 1]!) && (await evaluate<string>(wc, `document.querySelector('th[aria-sort=ascending]')?.textContent ?? ''`)).includes('ID du processus'), ascending.join())
    await clickOn(wc, '.task-sort', 'ID du processus')
    const descending = (await rows()).map(Number)
    check('and a second click reverses it', descending.every((v, i) => i === 0 || v <= descending[i - 1]!), descending.join())
    check('with no row picked, “Mettre fin au processus” is off', await evaluate<boolean>(wc, `document.querySelector('.task-total .button').disabled`))
    // The click is on the name of the row, in its upper part: the application's row is the last of the list (sorted by process id, descending), and its
    // lower part lies under the horizontal scroll bar the list has when its names are long (the table is then wider than the 720 px window).
    await evaluate(wc, `[...document.querySelectorAll('.task-manager tbody tr')].find((r) => r.textContent.includes('Application'))?.querySelector('td')?.scrollIntoView({ block: 'center', inline: 'start' })`)
    await sleep(100)
    const appCell = await evaluate<Rect | null>(wc, `(() => { const cell = [...document.querySelectorAll('.task-manager tbody tr')].find((r) => r.textContent.includes('Application'))?.querySelector('td'); if (!cell) return null; const r = cell.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
    const appRow = appCell ? { ...appCell, height: Math.min(12, appCell.height) } : null
    const appHit = appRow ? await evaluate<string>(wc, `(() => { const el = document.elementFromPoint(${appRow.x + appRow.width / 2}, ${appRow.y + appRow.height / 2}); return el ? el.tagName.toLowerCase() + '.' + el.className + ' in ' + (el.closest('tr')?.textContent.slice(0, 40) ?? 'no row') : 'nothing' })()`) : 'no row'
    if (appRow) await clickRect(wc, appRow)
    check('a click on the application’s row picks it, and the button stays off (only tabs can be ended)', (await waitFor(async () => (await count(wc, 'tr.selected')) === 1, 3000)) && (await evaluate<boolean>(wc, `document.querySelector('.task-total .button').disabled`)), JSON.stringify({ appRow, appHit, selected: await count(wc, 'tr.selected'), rows: await evaluate<string[]>(wc, `[...document.querySelectorAll('.task-manager tbody tr')].slice(0, 6).map((r) => r.className + ':' + r.textContent.slice(0, 40))`) }))
    // The list is redrawn every two seconds, and a tab's process can go in between: pick again until the button answers.
    if ((await count(wc, '.task-manager tbody tr[data-kind=tab]')) > 0) {
      let on = false
      for (let attempt = 0; attempt < 4 && !on; attempt++) {
        await clickOn(wc, '.task-manager tbody tr[data-kind=tab]')
        on = await waitFor(async () => !(await evaluate<boolean>(wc, `document.querySelector('.task-total .button').disabled`)), 1500)
      }
      check('a click on a tab’s row turns the button on', on)
    }
    taskWindow()?.close()
    check('closing it leaves no task manager window', await waitFor(() => !taskWindow(), 3000))
  })

  // ======================= what runs behind the switches =======================
  await section('the automatic update and the mini-window shortcut', async () => {
    const offer = { tag_name: 'v9.9.9', html_url: 'https://example.org/releases/v9.9.9', body: '' }
    const announced: string[] = []
    let looked = 0
    let on = true
    const updater = new AutoUpdater({
      settings: () => ({ ...defaultSettings(), autoUpdate: on, updateFeedUrl: 'https://example.org/latest' }),
      version: '0.1.0',
      feed: (settings) => (settings.autoUpdate ? settings.updateFeedUrl : null),
      fetchFeed: async () => {
        looked++
        return { ok: true, json: offer }
      },
      notify: (notice) => {
        announced.push(notice.version)
        return true
      },
      remember: () => undefined
    })
    on = false
    check('with “Rechercher les mises à jour automatiquement” off, the updater looks at nothing', (await updater.check()) === null && looked === 0)
    on = true
    const outcome = await updater.check()
    check('with it on, it reads the feed and announces a newer version', outcome?.kind === 'available' && looked === 1 && announced.join() === '9.9.9')
    await updater.check()
    check('and announces it once in a day', looked === 2 && announced.length === 1)

    const press = () => undefined
    const shortcut = new LittleShortcut(press)
    const accelerator = 'CmdOrCtrl+Alt+Shift+F13'
    check('the mini-window shortcut is registered with the system when the setting is on', shortcut.sync(true, accelerator) && globalShortcut.isRegistered(accelerator))
    shortcut.sync(false, accelerator)
    check('and released when it goes off', !globalShortcut.isRegistered(accelerator) && shortcut.held() === null)
    shortcut.stop()
  })

  // Put every setting back.
  browser.dispatch({ type: 'settings/update', patch: original })
  for (const w of settingsWindows()) w.close()
}

/** The same checks with their own report, for LUCIUM_SMOKE_ONLY=iso-settings. */
export async function runIsoSettingsSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    const verbose = process.env['LUCIUM_ISOS_VERBOSE'] === '1'
    await smokeIsoSettings(ctx, (name, ok, detail) => {
      noteCheck(checks, name, ok, detail)
      if (verbose) console.log(`ISO-SETTINGS ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail.slice(0, 400)}`}`)
    })
  } catch (error) {
    noteCheck(checks, 'smokeIsoSettings ran to the end', false, String((error as Error)?.stack ?? error))
    console.log(`ISO-SETTINGS FAIL smokeIsoSettings ran to the end -- ${String((error as Error)?.stack ?? error)}`)
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_ISO_SETTINGS ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
