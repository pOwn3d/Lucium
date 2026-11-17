// Engine checks for the new space sheet, the downloads popover and the Settings window (profile dialogs, shortcuts, the fold « Plus de réglages »).
// Driven the way a user drives the UI: real key and mouse events in the overlay, clicks through the page in the Settings window.

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow as ElectronWindow, type WebContents } from 'electron'
import type { OverlayRequest } from '@shared/ipc'
import { NAMED_COLORS } from '@shared/theme-colors'
import type { SmokeContext } from './smoke'
import { sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'

type Check = (name: string, ok: boolean, detail?: string) => void
interface Rect {
  x: number
  y: number
  width: number
  height: number
}


const waitFor = waiterOf(6000, 100)

/** The box of the first element matching `selector` (and containing `text`, when given), in the page's coordinates. */
const rectIn = (wc: WebContents, selector: string, text?: string): Promise<Rect | null> =>
  wc.executeJavaScript(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const el = ${text === undefined ? 'els[0]' : `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))`}
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })()`) as Promise<Rect | null>

async function waitRect(wc: WebContents, selector: string, text?: string): Promise<Rect | null> {
  for (let i = 0; i < 40; i++) {
    const rect = await rectIn(wc, selector, text)
    if (rect && rect.width > 0 && rect.height > 0) return rect
    await sleep(100)
  }
  return null
}

/** A left click with real mouse events, in the middle of the box. */
async function clickRect(wc: WebContents, rect: Rect): Promise<void> {
  const x = Math.round(rect.x + rect.width / 2)
  const y = Math.round(rect.y + rect.height / 2)
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 })
  await sleep(150)
}

/**
 * A click on the element, brought into view first as a user scrolls to it: a click sent below the window reaches nothing (the fold « Plus de
 * réglages » of « Vie privée » is under its presets and its four switches). An element already in view does not move.
 */
async function clickOn(wc: WebContents, selector: string, text?: string): Promise<boolean> {
  if (!(await waitRect(wc, selector, text))) return false
  const rect = await wc.executeJavaScript(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const el = ${text === undefined ? 'els[0]' : `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))`}
    if (!el) return null
    el.scrollIntoView({ block: 'nearest' })
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })()`) as Rect | null
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
    await sleep(50)
  }
  await sleep(200)
}

const pressKey = async (wc: WebContents, keyCode: string): Promise<void> => {
  wc.sendInputEvent({ type: 'keyDown', keyCode })
  wc.sendInputEvent({ type: 'keyUp', keyCode })
  await sleep(200)
}

const evaluate = <T>(wc: WebContents, script: string): Promise<T> => wc.executeJavaScript(script) as Promise<T>
const textOf = (wc: WebContents, selector: string): Promise<string> => evaluate(wc, `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`)

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

export async function smokeSettings(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win, overlayView } = ctx
  const ui = overlayView.webContents
  const settings = () => store.get().settings
  // The overlay mounts its panel again on every request: let the previous one's DOM go before touching anything.
  const openPanel = async (request: OverlayRequest, ready: string): Promise<void> => {
    browser.openOverlay(request)
    await waitRect(ui, ready)
    await sleep(500)
  }
  const section = async (name: string, run: () => Promise<void>) => {
    console.log(`[smoke] -- section: ${name}`)
    try {
      await run()
    } catch (error) {
      check(`${name} runs to the end`, false, String(error))
    }
    browser.closeOverlay()
  }

  // ---------- the new space sheet ----------
  await section('the new space sheet', async () => {
    browser.dispatch({ type: 'settings/update', patch: { profileNames: { ...settings().profileNames, 'smoke-work': 'Travail' } } })
    const spacesBefore = store.get().spaces.length
    const activeBefore = store.get().activeSpaceId

    const nameField = '.spacecreate input[placeholder="Clients, Veille, Vacances…"]'
    await openPanel({ panel: 'spacecreate' }, nameField)
    check('the sheet opens as a modal overlay panel', browser.currentOverlay()?.panel === 'spacecreate')
    check('it puts the cursor in the name field', await evaluate<boolean>(ui, `document.activeElement === document.querySelector(${JSON.stringify(nameField)})`))
    const createDisabled = () => evaluate<boolean>(ui, `document.querySelector('.spacecreate .tk-btn.primary')?.disabled ?? true`)
    check('“Créer l’espace” is off while the name is empty, and the foot says why', (await createDisabled()) && (await textOf(ui, '.spacecreate .sc-hint')) === 'Donnez un nom pour créer')

    await typeKeys(ui, 'atelier')
    check('typing fills the name, and the preview shows it', (await evaluate<string>(ui, `document.querySelector(${JSON.stringify(nameField)}).value`)) === 'atelier' && (await textOf(ui, '.spacecreate-title')) === 'atelier', await textOf(ui, '.spacecreate-title'))
    check('with a name, “Créer l’espace” is on', !(await createDisabled()))

    const gradientBefore = await evaluate<string>(ui, `getComputedStyle(document.querySelector('.spacecreate-preview')).backgroundImage`)
    check('a click on an emoji picks it, and the preview follows', (await clickOn(ui, '.spacecreate .sc-emoji button', '🎨')) && (await textOf(ui, '.spacecreate-icon')) === '🎨')
    const preset = NAMED_COLORS.find((color) => color.id === 'coral')!.hex
    check('a click on a named colour picks it', (await clickOn(ui, '.spacecreate-swatch[aria-label="Corail"]')) && (await evaluate<string>(ui, `document.querySelector('.spacecreate-swatch[aria-pressed=true]')?.getAttribute('aria-label') ?? ''`)) === 'Corail')
    const gradientAfter = await evaluate<string>(ui, `getComputedStyle(document.querySelector('.spacecreate-preview')).backgroundImage`)
    check('the preview shows the new colours live', gradientAfter !== gradientBefore && gradientAfter.includes('linear-gradient'), `${gradientBefore} -> ${gradientAfter}`)

    await setValue(ui, '.spacecreate select', '__new__')
    check('“Nouveau profil…” asks for a name and moves the cursor to it', (await waitRect(ui, '.spacecreate input.new-profile')) !== null && (await evaluate<boolean>(ui, `document.activeElement === document.querySelector('.spacecreate input.new-profile')`)))
    check('with no name for the profile, “Créer l’espace” is off', await createDisabled())
    await typeKeys(ui, 'travail')
    check('a profile name that is taken says so, whatever its case', (await textOf(ui, '.spacecreate [role=alert]')) === 'Un profil de ce nom existe déjà.' && (await createDisabled()), await textOf(ui, '.spacecreate [role=alert]'))
    await setValue(ui, '.spacecreate input.new-profile', '')
    await typeKeys(ui, 'clients')
    check('a free name clears the message and turns “Créer l’espace” on', (await textOf(ui, '.spacecreate [role=alert]')) === '' && !(await createDisabled()))

    await clickOn(ui, '.spacecreate .tk-btn.primary', 'Créer l’espace')
    check('“Créer l’espace” creates one space and closes the sheet', (await waitFor(() => store.get().spaces.length === spacesBefore + 1)) && (await waitFor(() => browser.currentOverlay() === null)), `${spacesBefore} -> ${store.get().spaces.length}`)
    const made = store.get().spaces.at(-1)
    check('the space has the name, the icon and the profile of the sheet, and is the active one', made?.name === 'atelier' && made.emoji === '🎨' && made.profileId === 'clients' && store.get().activeSpaceId === made.id, JSON.stringify(made && { n: made.name, e: made.emoji, p: made.profileId }))
    check('and the colour picked, which leads its theme', made?.theme.baseColors[0] === preset, JSON.stringify(made?.theme.baseColors))
    check('the new profile is named', settings().profileNames['clients'] === 'clients', JSON.stringify(settings().profileNames))

    // A name another space has is refused, whatever its case.
    await openPanel({ panel: 'spacecreate' }, nameField)
    await typeKeys(ui, 'ATELIER')
    check('a name another space already has is said to be taken, and nothing can be created with it', (await createDisabled()) && (await textOf(ui, '.spacecreate .sc-hint')) === 'Ce nom est déjà pris' && (await textOf(ui, '.spacecreate [role=alert]')).includes('existe déjà'), await textOf(ui, '.spacecreate [role=alert]'))
    await pressKey(ui, 'Escape')
    await waitFor(() => browser.currentOverlay() === null)

    // “Personnaliser…” opens the theme editor of the new space once it exists.
    await openPanel({ panel: 'spacecreate' }, nameField)
    await typeKeys(ui, 'perso2')
    await clickOn(ui, '.spacecreate .sc-link', 'Personnaliser')
    check('“Personnaliser…” is armed with a note', (await evaluate<string>(ui, `document.querySelector('.spacecreate .sc-link[aria-pressed=true]')?.textContent ?? ''`)).includes('Personnaliser') && (await evaluate<string>(ui, `[...document.querySelectorAll('.spacecreate .sc-help')].map((el) => el.textContent).join(' ')`)).includes('éditeur de thème'))
    await clickOn(ui, '.spacecreate .tk-btn.primary', 'Créer l’espace')
    const second = () => store.get().spaces.at(-1)
    check('creating then opens the theme editor of the new space', (await waitFor(() => browser.currentOverlay()?.panel === 'theme')) && (browser.currentOverlay() as { spaceId?: string } | null)?.spaceId === second()?.id && second()?.name === 'perso2', `${JSON.stringify(browser.currentOverlay())} last space: ${second()?.id} ${second()?.name}`)
    browser.closeOverlay()

    // Escape leaves the sheet without creating anything.
    const count = store.get().spaces.length
    await openPanel({ panel: 'spacecreate' }, nameField)
    await typeKeys(ui, 'x')
    await pressKey(ui, 'Escape')
    check('Escape closes the sheet and creates nothing', (await waitFor(() => browser.currentOverlay() === null)) && store.get().spaces.length === count)

    // Put things back.
    for (const space of store.get().spaces.filter((s) => s.name === 'atelier' || s.name === 'perso2')) browser.dispatch({ type: 'space/delete', id: space.id })
    const { clients: _clients, 'smoke-work': _work, ...names } = settings().profileNames
    browser.dispatch({ type: 'settings/update', patch: { profileNames: names } })
    browser.dispatch({ type: 'space/select', id: activeBefore })
  })

  // ---------- the downloads popover ----------
  await section('the downloads popover', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'lucium-smoke-popover-'))
    const previousProfiles = settings().profiles
    browser.dispatch({ type: 'settings/update', patch: { profiles: { ...previousProfiles, default: { ...previousProfiles['default'], downloadDir: folder } } } })
    // The slow download keeps its response open, so the file stays "in progress" until the check lets go of it.
    const slow: { response: ServerResponse | null } = { response: null }
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/octet-stream')
      if (req.url === '/slow') {
        res.setHeader('content-disposition', 'attachment; filename="smoke-slow.pdf"')
        res.setHeader('content-length', '100000')
        res.write(Buffer.alloc(40_000, 3))
        slow.response = res
        return
      }
      res.setHeader('content-disposition', `attachment; filename="smoke-${req.url?.slice(1) ?? 'x'}.bin"`)
      res.end(Buffer.alloc(2048, 1))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const names = () => browser.snapshot().downloads.map((d) => d.filename)
    const opened: string[] = []
    try {
      for (const name of ['one', 'two']) {
        browser.dispatch({ type: 'tab/open', url: `${base}/${name}` })
        await waitFor(() => browser.snapshot().downloads.some((d) => d.filename === `smoke-${name}.bin` && d.state === 'completed'))
      }
      browser.dispatch({ type: 'tab/open', url: `${base}/slow` })
      await waitFor(() => browser.snapshot().downloads.some((d) => d.filename === 'smoke-slow.pdf' && d.receivedBytes > 0))
      opened.push(...store.get().tabs.filter((t) => t.url.startsWith(base)).map((t) => t.id))

      await openPanel({ panel: 'downloads' }, '.dlpop-row')
      const card = await waitRect(ui, '.dlpop')
      check('the downloads open as a popover card', !!card && browser.currentOverlay()?.panel === 'downloads')
      check('it is not a dimmed modal: its backdrop is transparent', (await evaluate<string>(ui, `getComputedStyle(document.querySelector('.backdrop')).backgroundColor`)) === 'rgba(0, 0, 0, 0)')
      // While a file comes, the button is the chip of the footer and its name is the file's (aria-label): it is found by its class, which both forms have.
      const button = await rectIn(win.webContents, '.footer-downloads')
      check(
        'it sits just above the downloads button of the sidebar, bottom left, about 320 px wide',
        !!card && !!button && card.y + card.height <= button.y + 1 && button.y - (card.y + card.height) < 40 && card.x <= button.x && card.x + card.width > button.x + button.width / 2 && Math.abs(card.width - 320) <= 2,
        JSON.stringify({ card, button })
      )
      // Earlier checks of the same run may have downloaded files too: the list holds every one of them.
      const rows = await evaluate<number>(ui, `document.querySelectorAll('.dlpop-row').length`)
      const firstRow = await evaluate<string>(ui, `document.querySelector('.dlpop-row .dlpop-name')?.textContent ?? ''`)
      check('there is one row per file, the newest first', rows === browser.snapshot().downloads.length && firstRow === 'smoke-slow.pdf', JSON.stringify({ rows, firstRow, known: browser.snapshot().downloads.length }))
      check('a row has its icon with the extension, its name and its size', (await evaluate<string>(ui, `[...document.querySelectorAll('.dlpop-row')].find((r) => r.textContent.includes('smoke-one.bin'))?.innerText.replace(/\\s+/g, ' ') ?? ''`)).includes('BIN') && (await evaluate<string>(ui, `[...document.querySelectorAll('.dlpop-row')].find((r) => r.textContent.includes('smoke-one.bin'))?.querySelector('.dlpop-status')?.textContent ?? ''`)) === frenchSpaces('2 Ko'))
      check('a running download shows its progress bar and how far it is', (await evaluate<number>(ui, `document.querySelectorAll('.dlpop progress').length`)) === 1 && (await textOf(ui, '.dlpop-row.progressing .dlpop-status')).includes(' sur '), await textOf(ui, '.dlpop-row.progressing .dlpop-status'))

      await clickOn(ui, '.dlpop-row.progressing .dlpop-button[aria-label="Annuler le téléchargement"]')
      check('its cancel button stops it', await waitFor(() => browser.snapshot().downloads.find((d) => d.filename === 'smoke-slow.pdf')?.state === 'cancelled'), JSON.stringify(browser.snapshot().downloads.map((d) => [d.filename, d.state])))
      slow.response?.destroy()

      await clickOn(ui, '.dlpop-row.cancelled .dlpop-button[aria-label="Retirer de la liste"]')
      check('the remove button of a row takes only that file off the list', (await waitFor(() => !names().includes('smoke-slow.pdf'))) && names().includes('smoke-one.bin'), names().join(','))

      await pressKey(ui, 'Escape')
      check('Escape closes the popover', await waitFor(() => browser.currentOverlay() === null))

      await openPanel({ panel: 'downloads' }, '.dlpop-head .link-button')
      const clearAll = await waitRect(ui, '.dlpop-head .link-button', 'Tout effacer')
      if (clearAll) await clickRect(ui, clearAll)
      check('“Tout effacer” removes the finished downloads and the empty list says so', (await waitFor(() => names().length === 0)) && (await textOf(ui, '.dlpop-empty')).includes('Aucun téléchargement'), names().join(','))
    } finally {
      slow.response?.destroy()
      server.close()
      for (const id of opened) browser.dispatch({ type: 'tab/close', id })
      browser.dispatch({ type: 'settings/update', patch: { profiles: previousProfiles } })
      rmSync(folder, { recursive: true, force: true })
    }
  })

  // ---------- the Settings window ----------
  const settingsWindows = () => ElectronWindow.getAllWindows().filter((w) => w.getTitle() === 'Réglages')
  const openPane = async (pane: 'keyboard' | 'profiles' | 'protection', label: string, anchor?: 'shortcuts') => {
    browser.openOverlay({ panel: 'settings', pane, ...(anchor ? { anchor } : {}) })
    await waitFor(() => settingsWindows().length === 1)
    const wc = settingsWindows()[0]!.webContents
    await waitFor(async () => (await textOf(wc, '.settings-cat[aria-current=page]')).includes(label), 6000)
    return wc
  }
  const clickText = (wc: WebContents, text: string, scope = 'button') =>
    evaluate<string>(wc, `(() => { const el = [...document.querySelectorAll(${JSON.stringify(scope)})].find((e) => e.textContent.trim().includes(${JSON.stringify(text)})); if (!el) return 'missing'; el.click(); return 'ok' })()`)
  const setArchive = (wc: WebContents, hours: number) =>
    evaluate<string>(wc, `(() => {
      const row = [...document.querySelectorAll('.pref-row')].find((r) => r.textContent.includes('Archiver les onglets du jour inactifs'))
      const el = row?.querySelector('select')
      if (!el) return 'missing'
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(String(hours))})
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return 'ok'
    })()`)

  // The editor of the shortcuts is on its subpage of Clavier et souris (`#keyboard/shortcuts`; `#navigation/shortcuts` leads there too).
  await section('the shortcuts pane', async () => {
    const wc = await openPane('keyboard', 'Clavier et souris', 'shortcuts')
    await waitRect(wc, '.shortcut-row')
    check('the list opens on every shortcut, under “Raccourcis par défaut”', (await textOf(wc, '.shortcuts-head')) === 'Raccourcis par défaut' && (await evaluate<number>(wc, `document.querySelectorAll('.shortcut-basics').length`)) === 0)
    const labels = await evaluate<string[]>(wc, `[...document.querySelectorAll('section[aria-label="Tous les raccourcis"] .shortcut-label')].map((l) => l.firstChild.textContent)`)
    const sorted = [...labels].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }))
    check('…alphabetically', labels.length > 30 && JSON.stringify(labels) === JSON.stringify(sorted), labels.slice(0, 4).join(' | '))
    check('“Découvrir les raccourcis essentiels” narrows the list to the seven essentials', (await clickText(wc, 'Découvrir les raccourcis essentiels')) === 'ok' && (await waitFor(async () => (await evaluate<number>(wc, `document.querySelectorAll('.shortcut-basics .shortcut-row').length`)) === 7)))
    check('…and the same button brings the whole list back', (await clickText(wc, 'Voir tous les raccourcis')) === 'ok' && (await waitFor(async () => (await evaluate<number>(wc, `document.querySelectorAll('.shortcut-basics').length`)) === 0 && (await evaluate<number>(wc, `document.querySelectorAll('.shortcut-row').length`)) > 30)))
    await setValue(wc, '.shortcuts-search input[type=search]', 'xyzzy')
    check('a search with no match says “Aucun raccourci”', (await waitFor(async () => (await textOf(wc, '.shortcut-empty')) === 'Aucun raccourci')) && (await evaluate<number>(wc, `document.querySelectorAll('.shortcut-row').length`)) === 0)
    await setValue(wc, '.shortcuts-search input[type=search]', 'epingler')
    check('a search finds a command whatever its accents', await waitFor(async () => (await evaluate<number>(wc, `document.querySelectorAll('.shortcut-row').length`)) >= 1))
    await setValue(wc, '.shortcuts-search input[type=search]', 'Commande T')
    check('…or by its shortcut, spelled as the placeholder shows', await waitFor(async () => (await evaluate<string>(wc, `[...document.querySelectorAll('.shortcut-label')].map((l) => l.textContent).join('|')`)).includes('Nouvel onglet')))
    await setValue(wc, '.shortcuts-search input[type=search]', '')
    check('clearing the search brings the whole list back', await waitFor(async () => (await evaluate<number>(wc, `document.querySelectorAll('.shortcut-row').length`)) > 30))
  })

  await section('the profile dialogs', async () => {
    const original = { autoArchiveHours: settings().autoArchiveHours, profiles: settings().profiles, profileNames: settings().profileNames }
    browser.dispatch({ type: 'settings/update', patch: { autoArchiveHours: 12, profiles: {}, profileNames: { ...original.profileNames, 'smoke-work': 'Travail' } } })
    const spaceId = store.get().spaces[0]!.id
    const profileOfFirst = store.get().spaces[0]!.profileId
    const originalSpaceName = store.get().spaces[0]!.name
    const wc = await openPane('profiles', 'Profils')
    await waitRect(wc, '.profile-list')

    // Step 1: the name.
    check('“Ajouter un profil” opens the first step of a two-step dialog', (await clickText(wc, 'Ajouter un profil')) === 'ok' && (await waitRect(wc, '.dialog')) !== null && (await textOf(wc, '.dialog h2')) === 'Créer un profil')
    const continueDisabled = () => evaluate<boolean>(wc, `[...document.querySelectorAll('.dialog button')].find((b) => b.textContent.includes('Continuer'))?.disabled ?? true`)
    check('it asks what to call the profile and cannot go on without a name', (await textOf(wc, '.dialog')).includes(frenchSpaces('Comment voulez-vous appeler ce profil ?')) && (await continueDisabled()))
    await setValue(wc, '.dialog input', '   ')
    check('a name of blanks gives “Nom de profil invalide.”', (await waitFor(async () => (await textOf(wc, '.dialog-error')) === 'Nom de profil invalide.')) && (await continueDisabled()))
    await setValue(wc, '.dialog input', 'travail')
    check('a name that exists gives “Un profil de ce nom existe déjà.”, whatever its case', (await waitFor(async () => (await textOf(wc, '.dialog-error')) === 'Un profil de ce nom existe déjà.')) && (await continueDisabled()))
    await setValue(wc, '.dialog input', 'Projet Test')
    check('a free name clears the message and allows going on', (await waitFor(async () => (await textOf(wc, '.dialog-error')) === '')) && !(await continueDisabled()))

    // Step 2: the spaces.
    await clickText(wc, 'Continuer')
    check('step two asks which spaces use the profile, one box each, with the warning about separate data', (await waitFor(async () => (await evaluate<number>(wc, `document.querySelectorAll('.dialog-space input').length`)) === store.get().spaces.length)) && (await textOf(wc, '.dialog')).includes(frenchSpaces('Quels espaces doivent utiliser ce profil ?')) && (await textOf(wc, '.dialog-note')).includes('Chaque profil a ses propres données'))
    await evaluate(wc, `document.querySelector('.dialog-space input').click()`)
    await clickText(wc, 'Créer le profil')
    check('creating names the profile and moves the ticked space to it', await waitFor(() => settings().profileNames['projet-test'] === 'Projet Test' && store.get().spaces.find((s) => s.id === spaceId)?.profileId === 'projet-test'), JSON.stringify(settings().profileNames))
    check('the dialog is gone and the new profile is the one shown', (await waitFor(async () => (await evaluate<number>(wc, `document.querySelectorAll('.dialog').length`)) === 0)) && (await waitFor(async () => (await textOf(wc, '.profile-list button.current')).includes('Projet Test'))))

    // The archive delay of the default profile, with other profiles that follow it.
    await clickText(wc, 'Profil par défaut', '.profile-list button')
    await setArchive(wc, 24)
    check('changing the default profile’s delay while others follow it asks whom it applies to', (await waitFor(async () => (await textOf(wc, '.dialog h2')) === frenchSpaces('Appliquer à tous les profils ?'))) && (await textOf(wc, '.dialog')).includes(frenchSpaces('Voulez-vous appliquer ce changement à tous vos profils, ou seulement à votre profil « Profil par défaut » ?')), await textOf(wc, '.dialog'))
    await clickText(wc, 'Annuler', '.dialog button')
    // The witnesses: the dialog going away with the click, then a question to the main process on the channel a change would have taken, which
    // it answers only once it has handled what the window sent before.
    const dialogGone = await waitFor(async () => (await evaluate<number>(wc, `document.querySelectorAll('.dialog').length`)) === 0)
    await evaluate(wc, 'window.lucium.getSnapshot().then(() => 0)')
    check('cancelling changes nothing', settings().autoArchiveHours === 12 && dialogGone)

    await setArchive(wc, 24)
    await waitFor(async () => (await textOf(wc, '.dialog h2')) === frenchSpaces('Appliquer à tous les profils ?'))
    await clickText(wc, 'Seulement ce profil')
    check('“Seulement ce profil” changes the default and keeps the others at their delay', await waitFor(() => settings().autoArchiveHours === 24 && settings().profiles['projet-test']?.autoArchiveHours === 12 && settings().profiles['smoke-work']?.autoArchiveHours === 12), JSON.stringify({ top: settings().autoArchiveHours, profiles: settings().profiles }))
    check('and says what will happen', (await waitFor(async () => (await textOf(wc, '.pref-message')).includes('après 1 jour'))) && (await textOf(wc, '.pref-message')).includes(frenchSpaces('les onglets du profil « Profil par défaut »')), await textOf(wc, '.pref-message'))

    await setArchive(wc, 0)
    check('with no profile left that follows it, the change applies without a question, and “never” is worded as such', (await waitFor(() => settings().autoArchiveHours === 0)) && (await evaluate<number>(wc, `document.querySelectorAll('.dialog').length`)) === 0 && (await waitFor(async () => (await textOf(wc, '.pref-message')) === 'Lucium n’archivera jamais vos onglets automatiquement.')), await textOf(wc, '.pref-message'))

    browser.dispatch({ type: 'settings/update', patch: { profiles: {} } })
    await sleep(300)
    await setArchive(wc, 6)
    await waitFor(async () => (await textOf(wc, '.dialog h2')) === frenchSpaces('Appliquer à tous les profils ?'))
    await clickText(wc, 'Tous les profils')
    check('“Tous les profils” gives every profile the delay', await waitFor(() => settings().autoArchiveHours === 6 && Object.values(settings().profiles).every((p) => p.autoArchiveHours === undefined)), JSON.stringify({ top: settings().autoArchiveHours, profiles: settings().profiles }))

    // Renaming to a name that exists is refused with the message, and the name stays.
    await clickText(wc, 'Projet Test', '.profile-list button')
    await waitFor(async () => (await textOf(wc, '.profile-list button.current')).includes('Projet Test'))
    await clickText(wc, 'Renommer le profil')
    // The field of the box is named by its label, “Nom du profil”: a name of its own carried the identifier of the profile, which a screen reader read.
    const renameField = '.dialog input'
    const fieldShown = await waitFor(async () => (await textOf(wc, '.dialog h2')) === 'Renommer votre profil' && (await evaluate<number>(wc, `document.querySelectorAll('.dialog input').length`)) === 1)
    const field = await evaluate<{ value: string; ownName: string | null; label: string }>(wc, `(() => { const i = document.querySelector('.dialog input'); return { value: i?.value ?? '', ownName: i?.getAttribute('aria-label') ?? null, label: i?.closest('label')?.textContent ?? '' } })()`)
    check('“Renommer le profil” opens a box with one field holding the name, named by its label and not by the identifier of the profile', fieldShown && field.value === 'Projet Test' && field.ownName === null && field.label.includes('Nom du profil') && !field.label.includes('projet-test'), JSON.stringify(field))
    await setValue(wc, renameField, 'TRAVAIL')
    check('renaming a profile to a name that exists is refused with its message', (await waitFor(async () => (await textOf(wc, '.dialog-error')) === 'Un profil de ce nom existe déjà.')) && (await evaluate<boolean>(wc, `[...document.querySelectorAll('.dialog button')].find((b) => b.textContent.includes('Renommer'))?.disabled ?? false`)) && settings().profileNames['projet-test'] === 'Projet Test', JSON.stringify({ error: await textOf(wc, '.dialog-error'), names: settings().profileNames }))
    await setValue(wc, renameField, 'Projet Renommé')
    await waitFor(async () => (await textOf(wc, '.dialog-error')) === '')
    await clickText(wc, 'Renommer', '.dialog button.primary')
    check('a free name renames the profile, and only the profile', (await waitFor(() => settings().profileNames['projet-test'] === 'Projet Renommé')) && store.get().spaces.find((s) => s.id === spaceId)?.name === originalSpaceName, JSON.stringify(settings().profileNames))

    // Put things back.
    browser.dispatch({ type: 'space/update', id: spaceId, patch: { profileId: profileOfFirst } })
    browser.dispatch({ type: 'settings/update', patch: original })
  })

  // The level « Essentiel / Tous les réglages » is gone: each page shows its main rows at the top and folds the others into « Plus de réglages », a
  // button that says what it holds (SettingsMore.tsx). A link to a group that waits in it opens it by itself (settings-anchor.ts).
  await section('the fold « Plus de réglages »', async () => {
    const wc = await openPane('protection', 'Vie privée')
    await waitFor(async () => (await evaluate<number>(wc, `document.querySelectorAll('.pref-row').length`)) > 0)
    const fold = () => evaluate<{ count: number; expanded: string | null; hidden: boolean | null; line: string; rows: number }>(wc, `(() => { const b = document.querySelector('.settings-content .more-settings-toggle'); const body = document.querySelector('.settings-content .more-settings-body'); return { count: document.querySelectorAll('.settings-content .more-settings').length, expanded: b?.getAttribute('aria-expanded') ?? null, hidden: body?.hidden ?? null, line: b?.querySelector('.more-settings-what')?.textContent ?? '', rows: [...(body?.querySelectorAll('.pref-row') ?? [])].filter((r) => r.getBoundingClientRect().height > 0).length } })()`)
    check('no level to choose: the head of the page holds no « Essentiel / Tous les réglages »', (await evaluate<number>(wc, `document.querySelectorAll('.settings-level').length`)) === 0 && !(await textOf(wc, '.settings-content')).includes('Tous les réglages'))
    const closed = await fold()
    check('the page has one fold « Plus de réglages », closed, that says what it holds', closed.count === 1 && closed.expanded === 'false' && closed.hidden === true && closed.line.length > 0 && closed.rows === 0, JSON.stringify(closed))
    await clickOn(wc, '.settings-content .more-settings-toggle')
    check('a click opens it: its rows are shown', await waitFor(async () => { const now = await fold(); return now.expanded === 'true' && now.hidden === false && now.rows > 0 }), JSON.stringify(await fold()))
    await clickOn(wc, '.settings-content .more-settings-toggle')
    check('a second click closes it', await waitFor(async () => (await fold()).hidden === true))

    // A link to a group that waits in the fold of another page: the page opens with its fold open, the group lit.
    browser.openOverlay({ panel: 'settings', pane: 'appearance', anchor: 'panelsize' })
    const landed = () => evaluate<{ inFold: boolean; open: boolean; lit: boolean }>(wc, `(() => { const g = document.getElementById('panelsize'); const body = g?.closest('.more-settings-body'); return { inFold: !!body, open: body ? !body.hidden : false, lit: g?.classList.contains('pref-flash') ?? false } })()`)
    check('a link to a group in the fold opens the fold by itself and lights the group (#appearance/panelsize)', await waitFor(async () => { const now = await landed(); return now.inFold && now.open && now.lit }), JSON.stringify(await landed()))

    // Aide › État de Lucium…: « À propos et mises à jour », its fold opened, the focus on the title of « État de Lucium » (settings-links.test.ts).
    browser.openOverlay({ panel: 'settings', pane: 'about', anchor: 'status' })
    const status = () => evaluate<{ open: boolean; focus: string }>(wc, `(() => { const g = document.getElementById('status'); const body = g?.closest('.more-settings-body'); const a = document.activeElement; return { open: body ? !body.hidden : false, focus: a?.matches('.pref-section > h3') ? (a.querySelector('.pref-title')?.textContent ?? '') : '' } })()`)
    check('the anchor of Aide › État de Lucium… opens « À propos et mises à jour », unfolds « Plus de réglages » and puts the focus on « État de Lucium »', await waitFor(async () => { const now = await status(); return now.open && now.focus === 'État de Lucium' }), JSON.stringify(await status()))
    for (const w of settingsWindows()) w.close()
  })
}
