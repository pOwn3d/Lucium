// Engine checks for the command bar's own commands: real keystrokes in the overlay, then the effect on the state.
// Called from the engine smoke test: `await smokeCommandBar(ctx, check)`.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BrowserWindow } from 'electron'
import type { SmokeContext } from './smoke'
import { skippedBecause, sleep, waiterOf } from './smoke-kit'


const waitFor = waiterOf(8000, 100)

export async function smokeCommandBar(
  { browser, store, engine, overlayView }: SmokeContext,
  check: (name: string, ok: boolean, detail?: string) => void
): Promise<void> {
  const ui = overlayView.webContents
  const state = () => store.get()
  const cleanup: string[] = []

  // Pages whose title is given by the URL, so that tabs are told apart by what the bar shows.
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(`<title>${decodeURIComponent((req.url ?? '/').slice(1))}</title><body>cb</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const openTab = async (title: string): Promise<string> => {
    browser.dispatch({ type: 'tab/open', url: `${base}/${encodeURIComponent(title)}` })
    const id = state().tabs.at(-1)!.id
    await waitFor(() => state().tabs.find((t) => t.id === id)?.title === title)
    return id
  }

  // What is typed stays between the user and the bar: no request to the search engine for these words.
  const suggestionsBefore = state().settings.searchSuggestions
  browser.dispatch({ type: 'settings/update', patch: { searchSuggestions: false } })

  const home = state().activeSpaceId
  const homeName = state().spaces.find((sp) => sp.id === home)!.name
  browser.dispatch({ type: 'space/create', name: 'Smokeland', emoji: '🧪', hue: 120 })
  browser.dispatch({ type: 'space/create', name: 'Zephyr', emoji: '🌬️', hue: 300 })
  const smokeland = state().spaces.find((sp) => sp.name === 'Smokeland')!
  const zephyr = state().spaces.find((sp) => sp.name === 'Zephyr')!
  browser.dispatch({ type: 'space/select', id: home })

  const keyPress = async (keyCode: string, times = 1) => {
    for (let i = 0; i < times; i++) {
      ui.sendInputEvent({ type: 'keyDown', keyCode })
      ui.sendInputEvent({ type: 'keyUp', keyCode })
      await sleep(40)
    }
  }
  const typeText = async (text: string) => {
    for (const ch of text) {
      const keyCode = ch === ' ' ? 'Space' : ch
      ui.sendInputEvent({ type: 'keyDown', keyCode })
      ui.sendInputEvent({ type: 'char', keyCode: ch })
      ui.sendInputEvent({ type: 'keyUp', keyCode })
      await sleep(50)
    }
    await sleep(350)
  }
  const fieldFocused = async () => String(await ui.executeJavaScript(`document.activeElement === document.querySelector('.palette-input') ? 'yes' : ''`)) === 'yes'
  const openBar = async (text: string) => {
    // A request sent while the overlay page is still starting is lost: ask again until the field has the focus, then type.
    for (let attempt = 0; attempt < 4; attempt++) {
      browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
      if (await waitFor(fieldFocused, 3000)) break
    }
    await sleep(200)
    await typeText(text)
  }
  const rows = () =>
    ui.executeJavaScript(
      `[...document.querySelectorAll('.results li[role="option"]')].map((li) => ({ label: li.querySelector('.label')?.textContent ?? '', hint: li.querySelector('.hint')?.textContent ?? '', tile: li.querySelector('.space-tile')?.textContent ?? '', selected: li.classList.contains('selected') }))`
    ) as Promise<Array<{ label: string; hint: string; tile: string; selected: boolean }>>
  /** Moves the highlight down to the row with this label, then presses Enter. */
  const choose = async (label: string): Promise<boolean> => {
    const list = await rows()
    const at = list.findIndex((r) => r.label === label)
    if (at < 0) return false
    await keyPress('Down', at - list.findIndex((r) => r.selected))
    await keyPress('Return')
    return true
  }
  const closeBar = () => browser.closeOverlay()

  // Focus on <space>: the other spaces answer to their name, never the current one; Enter goes there.
  await openBar('smokeland')
  let list = await rows()
  check('typing a space name offers "Aller à l’espace <nom>" first, with the emoji of the space in a tile', list[0]?.label === 'Aller à l’espace Smokeland' && list[0]?.tile === '🧪', JSON.stringify(list.slice(0, 3)))
  await keyPress('Return')
  check('Enter on it makes that space the current one and closes the bar', (await waitFor(() => state().activeSpaceId === smokeland.id)) && browser.currentPanel() === null, `${state().activeSpaceId} panel=${browser.currentPanel()}`)
  browser.dispatch({ type: 'space/select', id: home })
  await openBar(homeName.toLowerCase())
  list = await rows()
  check('the space you are in is not offered', !list.some((r) => r.label === `Aller à l’espace ${homeName}`), JSON.stringify(list.map((r) => r.label)))
  closeBar()

  // Move to Today/Pinned in <space>: the current tab goes to another space.
  const moving = await openTab('cb move today')
  await openBar('deplacer zephyr')
  list = await rows()
  check('"deplacer zephyr" (no accent) offers moving the tab to Today and to Pinned of that space', list.some((r) => r.label === 'Déplacer vers Aujourd’hui dans Zephyr') && list.some((r) => r.label === 'Déplacer vers Épinglés dans Zephyr'), JSON.stringify(list.map((r) => r.label)))
  check('and never to the space the tab is in', !list.some((r) => r.label.endsWith(`dans ${homeName}`)))
  await choose('Déplacer vers Aujourd’hui dans Zephyr')
  check('"Aujourd’hui dans Zephyr" moves the tab there, unpinned, without leaving the current space', await waitFor(() => state().tabs.find((t) => t.id === moving)?.spaceId === zephyr.id), JSON.stringify(state().tabs.find((t) => t.id === moving)))
  check('the tab is in Today there and the current space did not change', state().tabs.find((t) => t.id === moving)?.pinned === false && state().activeSpaceId === home)
  const pinning = await openTab('cb move pinned')
  await openBar('epingles zephyr')
  await choose('Déplacer vers Épinglés dans Zephyr')
  check('"Épinglés dans Zephyr" moves the tab there and pins it', await waitFor(() => state().tabs.find((t) => t.id === pinning)?.spaceId === zephyr.id && state().tabs.find((t) => t.id === pinning)?.pinned === true), JSON.stringify(state().tabs.find((t) => t.id === pinning)))

  // A new folder, and the shortcuts editor.
  const foldersBefore = state().folders.length
  const folderIdsBefore = new Set(state().folders.map((f) => f.id))
  await openBar('dossier')
  list = await rows()
  check('"dossier" offers "Nouveau dossier"', list.some((r) => r.label === 'Nouveau dossier'), JSON.stringify(list.map((r) => r.label)))
  await choose('Nouveau dossier')
  check('and it creates a folder in the current space', await waitFor(() => state().folders.length === foldersBefore + 1 && state().folders.at(-1)?.spaceId === home), JSON.stringify(state().folders.at(-1)))

  const settingsWindows = () => BrowserWindow.getAllWindows().filter((w) => w.getTitle() === 'Réglages')
  const selectedPane = async () => String(await settingsWindows()[0]?.webContents.executeJavaScript(`document.querySelector('.settings-cat[aria-current=page]')?.textContent ?? ''`))
  const paneIs = (name: string) => waitFor(async () => (await selectedPane()).includes(name), 6000)
  await openBar('raccourcis')
  list = await rows()
  // The editor of the shortcuts is a subpage of Clavier et souris: the pane entry is named after it, "Réglages › Modifier les raccourcis clavier".
  check('"raccourcis" offers "Modifier les raccourcis clavier" and "Réglages › Modifier les raccourcis clavier"', list.some((r) => r.label === 'Modifier les raccourcis clavier') && list.some((r) => r.label === 'Réglages › Modifier les raccourcis clavier'), JSON.stringify(list.map((r) => r.label)))
  await choose('Modifier les raccourcis clavier')
  const heading = async () => String(await settingsWindows()[0]?.webContents.executeJavaScript(`document.querySelector('#pane-heading')?.textContent ?? ''`))
  check('"Modifier les raccourcis clavier" opens the Settings on the subpage of the editor in Clavier et souris, and closes the bar', (await waitFor(() => settingsWindows().length === 1)) && (await paneIs('Clavier et souris')) && (await waitFor(async () => (await heading()) === 'Raccourcis clavier', 6000)) && browser.currentPanel() === null, `${await selectedPane()} ${await heading()} panel=${browser.currentPanel()}`)
  await openBar('onglets')
  // A category entry carries the full title of the category ("Onglets et fenêtres"), the sidebar of the window its short name ("Onglets").
  await choose('Réglages › Onglets et fenêtres')
  check('"Réglages › Onglets et fenêtres" switches the same window to that category', (await paneIs('Onglets')) && settingsWindows().length === 1, await selectedPane())
  settingsWindows()[0]?.close()
  await waitFor(() => settingsWindows().length === 0)

  // Use an extension's action: the bar clicks the extension's toolbar icon, which opens its popup (icons are not shown inside a split view).
  const extensions = [...new Map(engine.listExtensions().map((e) => [e.id, e])).values()]
  if (extensions.length > 0) {
    // A popup is opened for the current tab: there must be one.
    const extensionHost = await openTab('cb extension host')
    cleanup.push(extensionHost)
    let opened = false
    let tried = ''
    for (const extension of extensions) {
      const before = engine.extensionPopupCount()
      // The first word is enough to find it, and spares the keyboard events from punctuation.
      const typed = extension.name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().split(' ')[0] ?? ''
      if (typed.length < 3) continue
      await openBar(typed)
      list = await rows()
      if (!list.some((r) => r.label === extension.name)) continue
      await choose(extension.name)
      tried += `${extension.name} `
      if (await waitFor(() => engine.extensionPopupCount() > before, 3000)) {
        opened = true
        break
      }
    }
    check('choosing a loaded extension in the bar opens its popup (the first one that has one)', opened && browser.currentPanel() !== 'commandbar', `tried: ${tried}`)
  } else check('choosing a loaded extension in the bar opens its popup (the first one that has one)', true, skippedBecause('no extension is loaded in this run'))
  // The renderer is not trusted: an id that is no loaded extension never reaches the browser.
  const activated: string[] = []
  const realActivate = browser.activateExtension.bind(browser)
  browser.activateExtension = (id: string) => {
    activated.push(id)
    return realActivate(id)
  }
  await ui.executeJavaScript(`window.lucium.activateExtension('f'.repeat(32))`)
  // The witness: the request is a message without an answer; a question asked after it on the same channel is answered only once the main
  // process has handled it.
  await ui.executeJavaScript('window.lucium.getSnapshot().then(() => 0)')
  check('an id that is not a loaded extension is ignored by the main process', activated.length === 0, activated.join(','))
  if (extensions.length > 0) {
    await ui.executeJavaScript(`window.lucium.activateExtension(${JSON.stringify(extensions[0]!.id)})`)
    check('while a loaded one is passed on', await waitFor(() => activated.includes(extensions[0]!.id), 3000), activated.join(','))
  } else check('while a loaded one is passed on', true, skippedBecause('no extension is loaded in this run'))
  browser.activateExtension = realActivate
  // Switch to Split View: one line for the whole split view, whichever of its tabs the text names.
  const splitA = await openTab('cbsplit alpha')
  const splitB = await openTab('cbsplit beta')
  browser.dispatch({ type: 'split/create', tabId: splitA, withTabId: splitB })
  const outside = await openTab('cb outside')
  await openBar('cbsplit')
  list = await rows()
  // Only the highlighted row tells what it will do: bring the highlight to the split view first.
  await keyPress('Down', list.findIndex((r) => r.label.startsWith('cbsplit ')) - list.findIndex((r) => r.selected))
  list = await rows()
  const splitRows = list.filter((r) => r.label.startsWith('cbsplit '))
  check('both tabs of a split view give one line, which says "Aller à la vue scindée"', splitRows.length === 1 && splitRows[0]?.hint === 'Aller à la vue scindée' && splitRows[0]?.selected === true, JSON.stringify(splitRows))
  const style = (await ui.executeJavaScript(
    `(() => { const li = document.querySelector('.results li.selected'); const c = (s) => getComputedStyle(li.querySelector(s)); return { hint: c('.hint').color, keycap: c('.keycap').backgroundColor, frame: c('.keycap').boxShadow } })()`
  )) as { hint: string; keycap: string; frame: string }
  // The line is a tint of the accent with a bar; its legend reads in the text colour of the dark card (--text) and its key is a bordered square (--surface-2), never white on the accent.
  check('on the active line the legend reads in the text colour and its key is a square of the card, not white on the accent', style.hint === 'rgb(241, 242, 246)' && style.keycap === 'rgb(38, 41, 50)' && style.frame === 'none', JSON.stringify(style))
  await keyPress('Return')
  check('Enter goes to the split view', await waitFor(() => [splitA, splitB].includes(state().activeTabBySpace[state().activeSpaceId] ?? '')), String(state().activeTabBySpace[state().activeSpaceId]))

  closeBar()

  // Tidy up: the spaces made here go with their tabs; the original space and the setting come back.
  browser.dispatch({ type: 'tab/select', id: outside })
  browser.dispatch({ type: 'space/select', id: home })
  for (const folder of state().folders.filter((f) => !folderIdsBefore.has(f.id))) browser.dispatch({ type: 'folder/delete', id: folder.id })
  for (const id of [smokeland.id, zephyr.id]) browser.dispatch({ type: 'space/delete', id })
  for (const id of [splitA, splitB, outside, moving, pinning, ...cleanup]) browser.dispatch({ type: 'tab/close', id })
  browser.dispatch({ type: 'settings/update', patch: { searchSuggestions: suggestionsBefore } })
  server.close()
}
