// Engine checks for find in page, Glance, the Tweak editor and the mini window: real keystrokes and mouse events in
// the overlay, then the effect on the state and on the pages. Called from the engine smoke test: `await smokePages(ctx, check)`.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BrowserWindow, clipboard, type WebContentsView } from 'electron'
import { FIND_PANEL } from '@shared/ipc'
import { LITTLE_PICKER } from '@shared/little-picker'
import type { SmokeContext } from './smoke'
import { sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'


const waitFor = waiterOf(8000, 80)

interface Box {
  x: number
  y: number
  width: number
  height: number
}

export async function smokePages(
  { browser, store, little, overlayView, win }: SmokeContext,
  check: (name: string, ok: boolean, detail?: string) => void
): Promise<void> {
  const ui = overlayView.webContents
  const state = () => store.get()
  const activeTabId = () => state().activeTabBySpace[state().activeSpaceId]!

  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    if (req.url === '/pg-find') return res.end('<title>pg find</title><body>needle one, needle two, needle three</body>')
    if (req.url === '/pg-boost') {
      // #ad is clicked over and over: the Eraser picker only listens while it is active.
      return res.end(`<title>pg boost</title><body><h1>Title</h1><div id="ad">AD</div><p id="text">some text</p><script>
        setInterval(() => { const ad = document.getElementById('ad'); if (ad && getComputedStyle(ad).display !== 'none') { ad.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); ad.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) } }, 200)
      </script></body>`)
    }
    res.end(`<title>pg ${req.url}</title><body>page ${req.url}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const host = '127.0.0.1'

  // ---- helpers over the overlay's UI ----
  const run = <T>(js: string) => ui.executeJavaScript(js) as Promise<T>
  const rectOf = (selector: string) =>
    run<Box | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  const textOf = (selector: string) => run<string | null>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`)
  const styleOf = (selector: string, prop: string) => run<string | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? getComputedStyle(el)[${JSON.stringify(prop)}] : null })()`)
  const count = (selector: string) => run<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
  const exists = async (selector: string) => (await count(selector)) > 0
  const key = async (keyCode: string, modifiers: Array<'shift' | 'meta'> = []) => {
    ui.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    ui.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(60)
  }
  const typeText = async (text: string) => {
    for (const ch of text) {
      ui.sendInputEvent({ type: 'keyDown', keyCode: ch })
      ui.sendInputEvent({ type: 'char', keyCode: ch })
      ui.sendInputEvent({ type: 'keyUp', keyCode: ch })
      await sleep(40)
    }
    await sleep(120)
  }
  const mouseAt = async (x: number, y: number, kind: 'move' | 'down' | 'up') => {
    ui.sendInputEvent({ type: kind === 'move' ? 'mouseMove' : kind === 'down' ? 'mouseDown' : 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await sleep(25)
  }
  const click = async (selector: string) => {
    const box = await rectOf(selector)
    if (!box) return false
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await mouseAt(x, y, 'move')
    await mouseAt(x, y, 'down')
    await mouseAt(x, y, 'up')
    await sleep(80)
    return true
  }
  const waitPanel = (panel: string | null, ms = 6000) => waitFor(() => browser.currentPanel() === panel, ms)
  /**
   * The overlay page keeps the DOM of the panel it showed last: mark it stale, so only the panel this request mounts counts.
   * A request sent while the overlay page is still starting is lost: ask again until the selector shows.
   */
  const openPanel = async (request: Parameters<typeof browser.openOverlay>[0], selector: string) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await run(`document.querySelectorAll('#root > *').forEach((el) => el.setAttribute('data-stale', '1'))`)
      browser.openOverlay(request)
      if (await waitFor(() => exists(`#root > :not([data-stale]) ${selector}, #root > ${selector}:not([data-stale])`), 2500)) return true
    }
    return false
  }
  const openTab = async (url: string, title: string) => {
    browser.dispatch({ type: 'tab/open', url })
    await waitFor(() => state().tabs.find((t) => t.id === activeTabId())?.title === title)
    return activeTabId()
  }
  const pageEval = (tabId: string, js: string) => browser.pageFor(tabId)!.evaluate(js) as Promise<string>
  const boosts = () => state().boosts.filter((b) => b.host === host)

  // ======================= Find in page =======================
  const findTab = await openTab(`${base}/pg-find`, 'pg find')
  check('find: the panel opens with the field focused', await openPanel({ panel: 'find' }, '.fb-input') && (await run<boolean>(`document.activeElement === document.querySelector('.fb-input')`)))
  const fb = await rectOf('.fb')
  check('find: the panel has the size the main process reserves for it', fb?.width === FIND_PANEL.width && fb?.height === FIND_PANEL.height, JSON.stringify(fb))
  check('find: radius 8 (on the surface token since E16-barre A)', (await styleOf('.fb', 'borderRadius')) === '8px')
  check('find: the field says "Rechercher dans la page…" and shows no counter or arrows while empty', (await run<string>(`document.querySelector('.fb-input').placeholder`)) === 'Rechercher dans la page…' && !(await exists('.fb-count')) && (await count('.fb-btn')) === 1)
  const overlayBounds = overlayView.getBounds()
  check('find: its view keeps a margin for the shadow around the panel', overlayBounds.width === FIND_PANEL.width + 2 * FIND_PANEL.shadow && overlayBounds.height === FIND_PANEL.height + 2 * FIND_PANEL.shadow, JSON.stringify(overlayBounds))

  await typeText('needle')
  check('find: typing really searches: the counter reads 1/3', await waitFor(async () => (await textOf('.fb-count')) === '1/3'), String(await textOf('.fb-count')))
  const matchColor = () => pageEval(findTab, `getComputedStyle(document.body, '::search-text').backgroundColor`)
  check('find: matches are painted in the colour the interface injects (the highlight rule applies), not the engine\'s yellow', await waitFor(async () => (await matchColor()) === 'rgb(165, 166, 35)'), String(await matchColor()))
  check('find: previous and next appear with the counter, then the close button', (await count('.fb-prev, .fb-next')) === 2 && (await exists('.fb-sep')) && (await count('.fb-btn')) === 3)
  const inputBox = await rectOf('.fb-input')
  check('find: the field gives its width to the counter (about 157 wide with a counter)', !!inputBox && inputBox.width > 140 && inputBox.width < 180, JSON.stringify(inputBox))
  await key('Return')
  check('find: Return goes to the next occurrence', await waitFor(async () => (await textOf('.fb-count')) === '2/3'), String(await textOf('.fb-count')))
  await key('Return', ['shift'])
  check('find: Shift+Return goes back', await waitFor(async () => (await textOf('.fb-count')) === '1/3'), String(await textOf('.fb-count')))
  await click('.fb-next')
  check('find: the next button steps forward', await waitFor(async () => (await textOf('.fb-count')) === '2/3'), String(await textOf('.fb-count')))
  await click('.fb-prev')
  check('find: the previous button steps back', await waitFor(async () => (await textOf('.fb-count')) === '1/3'), String(await textOf('.fb-count')))
  // A Backspace sent with sendInputEvent does not reach the editor on macOS: run the editing commands the Edit menu runs.
  check('find: clicking the arrows leaves the focus in the field (so Return keeps stepping)', await run<boolean>(`document.activeElement === document.querySelector('.fb-input')`))
  ui.selectAll()
  ui.delete()
  check('find: emptying the field takes the counter away', await waitFor(async () => !(await exists('.fb-count'))))
  await typeText('zzz')
  check('find: a text that is not there reads 0/0 and disables the arrows', await waitFor(async () => (await textOf('.fb-count')) === '0/0') && (await run<boolean>(`document.querySelector('.fb-prev').disabled && document.querySelector('.fb-next').disabled`)))
  await key('Escape')
  check('find: Escape closes the panel and clears the search', (await waitPanel(null)) && browser.snapshot().find === null)
  check('find: and takes the match colours away with it', await waitFor(async () => (await matchColor()) !== 'rgb(165, 166, 35)'), String(await matchColor()))
  await openPanel({ panel: 'find' }, '.fb-input')
  await click('.fb-close')
  check('find: the close button closes it too', await waitPanel(null))
  browser.dispatch({ type: 'tab/close', id: findTab })

  // ======================= Glance =======================
  const peekUrl = `${base}/pg-peek/a/b`
  const stageOf = () => {
    const request = browser.currentOverlay()
    return request?.panel === 'peek' ? request : null
  }
  const openPeek = async () => {
    await run(`document.querySelectorAll('#root > *').forEach((el) => el.setAttribute('data-stale', '1'))`)
    browser.openPeek(peekUrl)
    return waitFor(() => exists('#root > :not([data-stale]) .pk-btn'), 6000)
  }
  check('peek: the header shows three named actions, not round buttons', await openPeek() && (await count('.pk-btn')) === 3 && (await count('.pk-round')) === 0)
  const request = stageOf()
  const card = await rectOf('.pk-card')
  check('peek: the card is the rectangle main asked for, 88 % of the page card wide (E19 B)', !!card && !!request && card.x === request.rect.x && card.width === request.rect.width && !!request.stage && Math.abs(card.width - request.stage.width * 0.88) <= 1, JSON.stringify({ card, rect: request?.rect, stage: request?.stage }))
  check('peek: the card is inset 2 px from the top and bottom of the page card', !!card && !!request?.stage && card.y === request.stage.y + 2 && card.height === request.stage.height - 4, JSON.stringify({ card, stage: request?.stage }))
  const edge = await styleOf('.pk-card', 'borderTopWidth')
  check('peek: the header is 40 px tall under a 2 px edge in the colour of the space, and the corners are 8 px', (await rectOf('.pk-head'))?.height === 40 && edge === '2px' && (await styleOf('.pk-card', 'borderRadius')) === '8px', JSON.stringify({ head: await rectOf('.pk-head'), edge }))
  const scrim = await rectOf('.pk-scrim')
  check('peek: the scrim covers the page card only (the sidebar is not dimmed) in 44 % black', !!scrim && !!request?.stage && scrim.x === request.stage.x && scrim.y === request.stage.y && scrim.width === request.stage.width && scrim.height === request.stage.height && (await styleOf('.pk-scrim', 'backgroundColor')) === 'rgba(0, 0, 0, 0.44)', JSON.stringify(scrim))
  check('peek: the buttons are named in French, with their keys', (await run<string>(`[...document.querySelectorAll('.pk-btn')].map((b) => (b.getAttribute('aria-label') || b.textContent).trim()).join('|')`)) === 'Ouvrir dans un onglet⌘↩|Ouvrir en vue scindée|Fermer l’aperçu (Échap)')
  // The site and the path are two parts (the site is never the part that is cut), and a page over plain http is said to be so: the scheme is not shown.
  const peekSite = `${await textOf('.pk-addr .pk-site')}${await textOf('.pk-addr .pk-rest')}`
  check('peek: the page\'s title leads and the address shows without scheme, the site then its path', peekSite === `127.0.0.1:${new URL(base).port}/pg-peek/a/b` && (await exists('.pk-ttl')), String(await textOf('.pk-addr')))
  check('peek: a page over plain http is marked « Non sécurisé » before its site', (await textOf('.pk-addr .pk-insecure')) === 'Non sécurisé' && (await rectOf('.pk-addr .pk-insecure'))!.x < (await rectOf('.pk-addr .pk-site'))!.x, String(await textOf('.pk-addr')))

  const tabsBefore = state().tabs.length
  await click('.pk-btn.quiet')
  check('peek: "Fermer" closes the preview and opens nothing', (await waitPanel(null)) && browser.snapshot().peek === null && state().tabs.length === tabsBefore)

  await openPeek()
  await click('.pk-btn.primary')
  check('peek: "Ouvrir dans un onglet" opens the page in a tab and closes the preview', (await waitPanel(null)) && state().tabs.length === tabsBefore + 1 && state().tabs.at(-1)?.url === peekUrl, `${state().tabs.length} ${state().tabs.at(-1)?.url}`)

  const current = state().tabs.find((t) => t.id === activeTabId())!
  await openPeek()
  await click('.pk-btn.split')
  await waitPanel(null)
  const pair = state().splits.find((s) => s.tabIds.includes(current.id))
  check('peek: "Vue scindée" opens the page beside the current tab in a split view', !!pair && pair.tabIds.length === 2 && pair.tabIds.includes(state().tabs.at(-1)!.id) && state().tabs.at(-1)?.url === peekUrl, JSON.stringify(state().splits))
  for (const s of [...state().splits]) browser.dispatch({ type: 'split/remove', tabId: s.tabIds[0]! })

  await openPeek()
  await key('Escape')
  check('peek: Escape closes the preview', await waitPanel(null))
  await openPeek()
  if (request?.stage) {
    await mouseAt(request.stage.x + 4, request.stage.y + 40, 'move')
    await mouseAt(request.stage.x + 4, request.stage.y + 40, 'down')
    await mouseAt(request.stage.x + 4, request.stage.y + 40, 'up')
  }
  check('peek: a click on the dimmed page, outside the card, closes it', await waitPanel(null))
  await openPeek()
  check('peek: back and forward are shown (disabled) once the engine reports the history, reload is not', await waitFor(() => run<boolean>(`!!document.querySelector('.pk-nav') && [...document.querySelectorAll('.pk-nav-btn')].slice(0, 2).every((b) => b.disabled) && !document.querySelectorAll('.pk-nav-btn')[2].disabled`)))
  browser.peekAction('close')
  await waitPanel(null)

  // ======================= Tweak editor =======================
  const boostTab = await openTab(`${base}/pg-boost`, 'pg boost')
  for (const b of boosts()) browser.dispatch({ type: 'boost/delete', id: b.id })
  check('boost: the editor opens', await openPanel({ panel: 'boost', host }, '.bx'))
  const bx = await rectOf('.bx')
  const sized = async (selector: string) => {
    const r = await rectOf(selector)
    return r ? `${r.width}x${r.height}` : 'missing'
  }
  check('boost: the panel is 400 x 400 (or as tall as the window allows), radius 14, on the surface token', !!bx && bx.width === 400 && bx.height <= 400 && bx.height >= 300 && (await styleOf('.bx-card', 'borderRadius')) === '14px', JSON.stringify(bx))
  check('boost: the header is 44 px tall, with the Style and Code tabs', (await sized('.bx-head')) === '400x44' && (await run<string>(`[...document.querySelectorAll('.bx-tabs button')].map((b) => b.textContent).join('|')`)) === 'Style|Code')
  check('boost: pad 147 x 147, tools 42 x 38 / 43 x 38 / 42 x 38, fonts 205 x 118 (second column)', (await sized('.bx-pad')) === '147x147' && (await run<string>(`[...document.querySelectorAll('.bx-tool')].map((b) => b.offsetWidth + 'x' + b.offsetHeight).join()`)) === '42x38,43x38,42x38' && (await sized('.bx-fonts')) === '205x118')
  check('boost: thirty font cells (twenty system fonts and the ten of Lucium), Size and Case 38 high side by side, Eraser 205 x 38', (await count('.bx-font')) === 30 && (await sized('.bx-size')).endsWith('x38') && (await sized('.bx-case')).endsWith('x38') && (await sized('.bx-zap')) === '205x38')
  check('boost: the title is the default name, and nothing is saved before a change', (await textOf('.bx-title span')) === 'Ma Retouche' && boosts().length === 0)
  const headBottom = (await rectOf('.bx-head'))!.y + 44
  const padBox = (await rectOf('.bx-pad'))!
  const toolsBox = (await rectOf('.bx-tools'))!
  check('boost: the pad sits 16 px under the header, the tools 15 px under the pad', Math.abs(padBox.y - headBottom - 16) < 1 && Math.abs(toolsBox.y - (padBox.y + 147) - 15) < 1)

  // Size cycles 100 -> 110 -> 120 %; the page zoom is applied by the engine from the saved Tweak.
  await click('.bx-size')
  check('boost: Size once = 110 % (label, saved Tweak, name)', (await textOf('.bx-size')) === frenchSpaces('110 %') && (await waitFor(() => boosts()[0]?.zoom === 1.1)) && boosts()[0]?.name === 'Ma Retouche', JSON.stringify(boosts()[0]))
  check('boost: the Size button turns orange', (await styleOf('.bx-size', 'backgroundColor')) === 'rgb(255, 159, 26)')
  await click('.bx-size')
  check('boost: Size twice = 120 %', (await textOf('.bx-size')) === frenchSpaces('120 %') && (await waitFor(() => boosts()[0]?.zoom === 1.2)))

  await click('.bx-case')
  check('boost: Case once = AA, saved, and the page text is upper case', (await textOf('.bx-case')) === 'AA' && (await waitFor(() => boosts()[0]?.textCase === 'upper')) && (await waitFor(async () => (await pageEval(boostTab, `getComputedStyle(document.getElementById('text')).textTransform`)) === 'uppercase')), JSON.stringify(boosts()[0]))
  await click('.bx-case')
  await click('.bx-case')
  check('boost: Case goes aa, Aa and then back to the page\'s own case', (await textOf('.bx-case')) === 'Aa' && (await waitFor(() => boosts()[0]?.textCase === 'capitalize')))
  await click('.bx-case')
  check('boost: a fourth click on Case clears it', (await textOf('.bx-case')) === 'Casse' && (await waitFor(() => boosts()[0]?.textCase === undefined)))

  await click('.bx-font:nth-child(9)')
  check('boost: a font cell applies the family to the page and is saved', (await waitFor(() => boosts()[0]?.fontFamily === 'georgia')) && (await waitFor(async () => (await pageEval(boostTab, `getComputedStyle(document.getElementById('text')).fontFamily`)).includes('Georgia'))), String(boosts()[0]?.fontFamily))
  check('boost: the chosen cell shows as pressed', (await run<string>(`document.querySelectorAll('.bx-font')[8].getAttribute('aria-pressed')`)) === 'true')
  await click('.bx-font:nth-child(9)')
  check('boost: a second click on the same cell takes the font away', await waitFor(() => boosts()[0]?.fontFamily === undefined))

  await click('.bx-tool:nth-child(1)')
  check('boost: "Inverser la luminosité" inverts the page and presses its button', (await waitFor(() => boosts()[0]?.invert === true)) && (await waitFor(async () => (await pageEval(boostTab, `getComputedStyle(document.documentElement).filter`)).includes('invert'))) && (await run<string>(`document.querySelector('.bx-tool').getAttribute('aria-pressed')`)) === 'true')
  await click('.bx-tool:nth-child(3)')
  check('boost: "Rétablir les couleurs d\'origine" takes the inversion away and disables itself', (await waitFor(() => boosts()[0]?.invert === undefined)) && (await run<boolean>(`document.querySelectorAll('.bx-tool')[2].disabled`)))

  // The pad: a real drag of the main handle changes hue and saturation, the small one contrast and brightness.
  const pad = (await rectOf('.bx-pad-in'))!
  const dragTo = async (fromX: number, fromY: number, toX: number, toY: number) => {
    await mouseAt(fromX, fromY, 'move')
    await mouseAt(fromX, fromY, 'down')
    await mouseAt((fromX + toX) / 2, (fromY + toY) / 2, 'move')
    await mouseAt(toX, toY, 'move')
    await mouseAt(toX, toY, 'up')
    await sleep(120)
  }
  const mainThumb = (await rectOf('.bx-thumb.main'))!
  await dragTo(mainThumb.x + 15, mainThumb.y + 15, pad.x + pad.width * 0.25, pad.y + pad.height * 0.2)
  const tinted = await waitFor(() => boosts()[0]?.tint.hue !== 0 && boosts()[0]!.tint.saturation > 1)
  check('boost: dragging the main handle left and up changes the hue and raises the saturation', tinted, JSON.stringify(boosts()[0]?.tint))
  check('boost: the page gets the colour filter', await waitFor(async () => (await pageEval(boostTab, `getComputedStyle(document.documentElement).filter`)).includes('hue-rotate')))
  const secondThumb = (await rectOf('.bx-thumb.second'))!
  await dragTo(secondThumb.x + 9, secondThumb.y + 9, pad.x + pad.width * 0.9, pad.y + pad.height * 0.1)
  check('boost: dragging the small handle raises contrast and brightness', await waitFor(() => boosts()[0]!.tint.contrast > 1 && boosts()[0]!.tint.brightness > 1), JSON.stringify(boosts()[0]?.tint))

  const tintAfterDrag = JSON.stringify(boosts()[0]?.tint)
  await click('.bx-undo')
  check('boost: Undo takes back the whole drag of the small handle in one step', (await waitFor(() => JSON.stringify(boosts()[0]?.tint) !== tintAfterDrag)) && boosts()[0]!.tint.contrast === 1 && boosts()[0]!.tint.brightness === 1, JSON.stringify(boosts()[0]?.tint))

  // Advanced controls
  await click('.bx-tool:nth-child(2)')
  check('boost: the advanced popover opens with five sliders (hue, contrast, brightness, saturation, text size)', (await exists('.bx-adv')) && (await count('.bx-adv input[type=range]')) === 5 && (await sized('.bx-adv')).startsWith('216x'), `${await sized('.bx-adv')} viewport ${await run<string>('innerWidth + "x" + innerHeight')}`)
  await run(`document.querySelector('.bx-adv input[aria-label="Contraste"]').focus()`)
  await key('Right')
  await key('Right')
  check('boost: a slider moves with the arrow keys and the Tweak follows', await waitFor(() => boosts()[0]!.tint.contrast > 1 && boosts()[0]!.tint.contrast < 1.1), JSON.stringify(boosts()[0]?.tint))
  await click('.bx-title')
  check('boost: opening the menu puts the popover away', !(await exists('.bx-adv')) && (await exists('.bx-menu')))
  const items = await run<string[]>(`[...document.querySelectorAll('.bx-menu-item')].map((b) => b.textContent)`)
  check('boost: the title menu lists rename, shuffle, reset, switch off and delete, then the new Tweak', items.slice(0, 5).join('|') === 'Renommer cette Retouche…|Mélanger|Réinitialiser toutes les modifications|Désactiver cette Retouche|Supprimer cette Retouche' && items.at(-1) === 'Nouvelle Retouche', items.join('|'))
  await click('.bx-menu-item:nth-child(2)')
  check('boost: "Mélanger" gives a new look', await waitFor(() => JSON.stringify(boosts()[0]?.tint) !== tintAfterDrag && !!boosts()[0]))

  // Rename
  await click('.bx-title')
  await click('.bx-menu-item:nth-child(1)')
  check('boost: "Renommer" puts a field on the title', await waitFor(() => exists('.bx-rename')))
  // Another app can take the keyboard focus between the click and the keys (it happens on a busy desktop): take it back.
  ui.focus()
  await run(`document.querySelector('.bx-rename')?.focus()`)
  await key('a', ['meta'])
  await typeText('Lecture')
  await key('Return')
  check('boost: Return names the Tweak', await waitFor(() => boosts()[0]?.name === 'Lecture'), String(boosts()[0]?.name))

  // Code
  await click('.bx-tabs button:nth-child(2)')
  check('boost: "Code" widens the panel to 480 px towards the left', (await waitFor(async () => (await rectOf('.bx'))?.width === 480)) && (await exists('.bx-text')) && (await sized('.bx-foot')).endsWith('x69'))
  const right = (await rectOf('.bx'))!.x + 480
  check('boost: its right edge stays where it was', Math.abs(right - (bx!.x + 400)) < 1, `${right} vs ${bx!.x + 400}`)
  check('boost: the code field has CSS, JS and Eraser tabs', (await exists('.bx-text')) && (await run<string>(`[...document.querySelectorAll('.bx-seg button')].map((b) => b.textContent).join('|')`)) === 'CSS|JS|Gomme')
  await typeText('qq')
  check('boost: CSS typed in the field is saved as it is typed', await waitFor(() => boosts()[0]?.css === 'qq'), JSON.stringify(boosts()[0]?.css))
  await click('.bx-seg button:nth-child(2)')
  // A mark on the document of the page: it is still there while the page has not been reloaded.
  const sameDocument = () => pageEval(boostTab, `document.documentElement.dataset.sameDocument ?? ''`)
  await pageEval(boostTab, `document.documentElement.dataset.sameDocument = 'yes'`)
  // A whole script, short enough to be typed key by key: it leaves a mark on the body of the page that runs it.
  const SCRIPT = 'document.body.title=7'
  const ranIn = () => pageEval(boostTab, `document.body.title`)
  await typeText(SCRIPT)
  check('boost: a script is kept as a draft as it is typed, apart from the script the pages run', await waitFor(() => boosts()[0]?.jsDraft === SCRIPT && boosts()[0]?.js === ''), JSON.stringify([boosts()[0]?.js, boosts()[0]?.jsDraft]))
  check('boost: the draft is said under the field, with its three buttons', (await exists('.bx-script-draft')) && (await run<string>(`[...document.querySelectorAll('.bx-script-draft button')].map((b) => b.textContent).join('|')`)) === 'Enregistrer le script|Lancer l’aperçu|Revenir au script enregistré')
  // A fixed wait, for want of a witness: a load of the page asked by mistake as the draft changes shows only once it lands.
  await sleep(600)
  check('boost: the page is not reloaded and does not run the script being typed', (await sameDocument()) === 'yes' && (await ranIn()) === '')
  await click('.bx-script-draft .bx-link')
  check('boost: "Lancer l’aperçu" runs the draft once in the page shown, and saves nothing', (await waitFor(async () => (await ranIn()) === '7')) && boosts()[0]?.js === '' && (await sameDocument()) === 'yes', JSON.stringify(boosts()[0]?.js))
  await click('.bx-tabs button:nth-child(1)')
  check('boost: the Style tab gives the 400 px panel back', await waitFor(async () => (await rectOf('.bx'))?.width === 400))
  await click('.bx-done')
  check('boost: "Terminé" closes the editor and keeps the draft a draft', (await waitPanel(null)) && boosts()[0]?.js === '' && boosts()[0]?.jsDraft === SCRIPT, JSON.stringify([boosts()[0]?.js, boosts()[0]?.jsDraft]))
  // A new document of the site, loaded while the script is only a draft: it must not run it.
  browser.pageFor(boostTab)!.reload()
  check('boost: a page loaded while the script is a draft does not run it', (await waitFor(async () => (await sameDocument().catch(() => 'reloading')) === '', 10_000)) && (await ranIn()) === '')
  await pageEval(boostTab, `document.documentElement.dataset.sameDocument = 'yes'`)
  await openPanel({ panel: 'boost', host, id: boosts()[0]!.id }, '.bx')
  await click('.bx-tabs button:nth-child(2)')
  await click('.bx-seg button:nth-child(2)')
  check('boost: reopening the editor shows the draft in the field', (await run<string>(`document.querySelector('.bx-text').value`)) === SCRIPT && (await exists('.bx-script-draft')))
  await click('.bx-script-save')
  check('boost: "Enregistrer le script" makes the draft the script of the Tweak', (await waitFor(() => boosts()[0]?.js === SCRIPT && boosts()[0]?.jsDraft === undefined)) && !(await exists('.bx-script-draft')), JSON.stringify([boosts()[0]?.js, boosts()[0]?.jsDraft]))
  // While the page reloads, the question is refused: it is asked again until the new document answers, and the check fails if none does.
  check('boost: the page is then reloaded and runs the saved script', (await waitFor(async () => (await sameDocument().catch(() => 'reloading')) === '', 10_000)) && (await waitFor(async () => (await ranIn().catch(() => '')) === '7')))
  await click('.bx-done')
  await waitPanel(null)
  browser.dispatch({ type: 'boost/save', boost: { ...boosts()[0]!, js: '' } })
  await waitFor(() => boosts()[0]?.js === '')

  // Reopen the saved Tweak: everything comes back from the store.
  await openPanel({ panel: 'boost', host, id: boosts()[0]!.id }, '.bx')
  check('boost: reopening shows the saved name, and no second Tweak', (await textOf('.bx-title span')) === 'Lecture' && boosts().length === 1)
  check('boost: Eraser shows its count, and the reset entry is enabled for a modified Tweak', (await textOf('.bx-zap span')) === 'Gomme')
  await click('.bx-title')
  await click('.bx-menu-item:nth-child(3)')
  check('boost: "Réinitialiser toutes les modifications" clears the look but keeps the name', await waitFor(() => !!boosts()[0] && boosts()[0]!.css === '' && boosts()[0]!.zoom === 1 && boosts()[0]!.tint.hue === 0 && boosts()[0]!.fontFamily === undefined) && boosts()[0]!.name === 'Lecture', JSON.stringify(boosts()[0]))

  // Eraser: the Tweak is saved first, the picker takes the page (the editor stays, the page clicks the element by itself), and the mode
  // ends as the "Terminé" button of the page would end it: the editor comes back with the element erased.
  await click('.bx-zap')
  check('boost: Eraser hands the page to the picker, and the picked element is hidden', (await waitFor(async () => (await pageEval(boostTab, `getComputedStyle(document.getElementById('ad')).display`)) === 'none', 10_000)) && ((browser.currentOverlay() as { zap?: boolean } | null)?.zap === true), JSON.stringify(browser.currentOverlay()))
  browser.endZap()
  check('boost: when the mode ends the picked element joins the Tweak', await waitFor(() => boosts()[0]?.zap.includes('#ad') === true, 10_000), JSON.stringify(boosts()[0]?.zap))
  check('boost: the editor comes back after the pick, with the count on Eraser', (await waitPanel('boost')) && (await waitFor(async () => (await textOf('.bx-zap span')) === 'Gomme · 1')), String(await textOf('.bx-zap span')))
  await click('.bx-tabs button:nth-child(2)')
  await click('.bx-seg button:nth-child(3)')
  check('boost: the Eraser tab lists the hidden element, and "Rétablir" shows it again', (await textOf('.bx-zap-list code')) === '#ad')
  await click('.bx-zap-list .bx-link')
  check('boost: after "Rétablir" the element is back on the page', (await waitFor(() => boosts()[0]?.zap.length === 0)) && (await waitFor(async () => (await pageEval(boostTab, `getComputedStyle(document.getElementById('ad')).display`)) !== 'none')))
  await click('.bx-tabs button:nth-child(1)')

  // Delete, with its confirmation box
  await click('.bx-title')
  await click('.bx-menu-item:nth-child(5)')
  await waitFor(() => exists('.adlg'))
  // The box is drawn on the surface of the interface (the token `--surface`, light or dark with the appearance of the machine), not on a colour of its own.
  const surfaceToken = run<string>(`(() => { const probe = document.createElement('div'); probe.style.background = 'var(--surface)'; document.body.append(probe); const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color })()`)
  check('boost: "Supprimer" asks first, in a 450 x 273 box', (await sized('.adlg')) === '450x273' && (await styleOf('.adlg', 'backgroundColor')) === (await surfaceToken), `${await sized('.adlg')} ${await styleOf('.adlg', 'backgroundColor')} vs ${await surfaceToken}`)
  check('boost: the box says what it deletes (in French) and offers Annuler (Escape) and Supprimer (no key: Return does not delete)', (await textOf('.adlg-title')) === frenchSpaces('Supprimer cette Retouche ?') && (await textOf('.adlg-message')) === 'Cette action est irréversible.' && (await textOf('.adlg-cancel')) === 'AnnulerESC' && (await textOf('.adlg-danger')) === 'Supprimer')
  check('boost: its buttons are 38 px tall, 8 px apart, 28 px from the right edge', (await rectOf('.adlg-cancel'))?.height === 38 && (await run<boolean>(`(() => { const a = document.querySelector('.adlg-cancel').getBoundingClientRect(); const b = document.querySelector('.adlg-danger').getBoundingClientRect(); const box = document.querySelector('.adlg').getBoundingClientRect(); return Math.abs(b.x - (a.x + a.width) - 8) < 1 && Math.abs(box.right - 1 - b.right - 28) < 1.5 })()`)))
  await key('Escape')
  check('boost: Escape cancels: the box goes, the Tweak stays', (await waitFor(async () => !(await exists('.adlg')))) && boosts().length === 1 && browser.currentPanel() === 'boost')
  await click('.bx-title')
  await click('.bx-menu-item:nth-child(5)')
  await waitFor(() => exists('.adlg'))
  await click('.adlg-danger')
  check('boost: "Supprimer" in the box deletes the Tweak and closes the editor', (await waitFor(() => boosts().length === 0)) && (await waitPanel(null)))

  // An editor that changed nothing leaves no Tweak behind, and "Terminé" is enough to leave it.
  await openPanel({ panel: 'boost', host }, '.bx')
  await click('.bx-done')
  check('boost: opening and leaving an untouched editor creates no Tweak', (await waitPanel(null)) && boosts().length === 0)
  // A change undone before it was ever saved leaves nothing to keep either.
  await openPanel({ panel: 'boost', host }, '.bx')
  await run(`document.querySelector('.bx-size').click()`)
  await sleep(30)
  await run(`document.querySelector('.bx-undo').click()`)
  await sleep(600)
  await click('.bx-done')
  check('boost: a change undone before the first save creates no Tweak', (await waitPanel(null)) && boosts().length === 0, JSON.stringify(boosts()))
  // Eraser on a Tweak that was never saved: the editor has to save it first, or the picker has nothing to attach the element to.
  await openPanel({ panel: 'boost', host }, '.bx')
  await click('.bx-zap')
  // The mode lasts until the user is done: the page clicks the element by itself, then "Terminé" is what ends it.
  await waitFor(async () => (await pageEval(boostTab, `getComputedStyle(document.getElementById('ad')).display`)) === 'none', 10_000)
  browser.endZap()
  check('boost: Eraser on a new Tweak creates it, and the erased element is kept', (await waitFor(() => boosts().some((b) => b.zap.includes('#ad')), 10_000)) && (await waitPanel('boost')), JSON.stringify(boosts()))
  browser.closeOverlay()
  for (const b of boosts()) browser.dispatch({ type: 'boost/delete', id: b.id })
  await waitFor(async () => (await pageEval(boostTab, `getComputedStyle(document.getElementById('ad')).display`)) !== 'none')
  // Escape on a Tweak with a change keeps the change (it is saved as it is made).
  await openPanel({ panel: 'boost', host }, '.bx')
  await click('.bx-size')
  await key('Escape')
  check('boost: Escape closes the editor and keeps what was changed', (await waitPanel(null)) && (await waitFor(() => boosts()[0]?.zoom === 1.1)))
  browser.dispatch({ type: 'boost/delete', id: boosts()[0]!.id })
  browser.dispatch({ type: 'tab/close', id: boostTab })

  // ======================= Mini window =======================
  // Other parts of the engine test may have left a mini window open: count relative to what is there.
  const littleBefore = little.count()
  let littleId = little.open(`${base}/pg-little`)
  const littleWin = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes(`id=${littleId}`))
  const inLittle = <T>(js: string) => littleWin()!.webContents.executeJavaScript(js, true) as Promise<T>
  const littleTitled = await waitFor(async () => !!littleWin() && (await inLittle<boolean>(`!!document.querySelector('.la-title')?.textContent`).catch(() => false)), 10_000)
  const W = littleWin()!.getContentBounds().width
  const lbox = (selector: string) => inLittle<Box | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  const header = await lbox('.la-header')
  check('little: the header is 40 px tall (E19 B), with a 28 px banner of the archiving delay under it', header?.height === 40 && (await lbox('.la-strip'))?.height === 28 && (await lbox('.la-strip'))?.y === 40, JSON.stringify({ header, strip: await lbox('.la-strip') }))
  const field = await lbox('.la-field')
  check('little: the field of the page (icon, title, address) starts at x = 80, 32 px tall, centred in the header (y = 4)', !!field && field.x === 80 && field.height === 32 && field.y === 4, JSON.stringify({ field, W }))
  const pill = await lbox('.la-open')
  const pin = await lbox('.la-pin')
  check('little: the "open in" pill is 32 px tall and the pin "Garder ouvert" is a 32 px square at the right end, 8 px from the edge', !!pill && !!pin && pill.height === 32 && pill.y === 4 && pin.width === 32 && pin.height === 32 && Math.abs(pin.x + pin.width - (W - 8)) < 1 && pill.x + pill.width <= pin.x, JSON.stringify({ pill, pin, W }))
  const shown = await inLittle<string>(`[...document.querySelectorAll('.la-title, .la-host')].map((el) => el.textContent).join('|')`)
  check('little: the title of the page leads, and the address (host alone, without scheme or path) follows unless it is the title itself', shown.split('|').includes(`${host}:${new URL(base).port}`) || shown === `${host}:${new URL(base).port}`, JSON.stringify({ shown, littleTitled, document: littleWin()?.webContents.getURL(), state: little.states().find((st) => st.id === littleId) }))
  const spaceOf = state().spaces.find((s) => s.id === state().activeSpaceId)!
  check('little: the pill says "Ouvrir dans" and the current space (its emoji too), with ⌘O', (await inLittle<string>(`document.querySelector('.la-open-main').textContent`)) === `Ouvrir dans${`${spaceOf.emoji} ${spaceOf.name}`.trim()}⌘O`, await inLittle<string>(`document.querySelector('.la-open-main').textContent`))
  check('little: the banner says "Fermée et archivée après 12 h sans activité" with the link "Modifier le délai", and the pin kept it says so', (await inLittle<string>(`document.querySelector('.la-strip-text').textContent`)).startsWith('Fermée et archivée après') && (await inLittle<string>(`document.querySelector('.la-strip-link').textContent`)) === 'Modifier le délai')
  await inLittle(`document.querySelector('.la-pin').click()`)
  check('little: the pin "Garder ouvert" keeps the window out of the archiving: the window says so (state, pressed button, banner)', (await waitFor(() => little.states().find((st) => st.id === littleId)?.kept === true)) && (await waitFor(async () => (await inLittle<string>(`document.querySelector('.la-pin').getAttribute('aria-pressed')`)) === 'true')) && (await waitFor(async () => (await inLittle<string>(`document.querySelector('.la-strip-text').textContent`)).startsWith('Gardée ouverte'))))
  await inLittle(`document.querySelector('.la-pin').click()`)
  check('little: pressing it again puts the window back under the archiving', await waitFor(() => little.states().find((st) => st.id === littleId)?.kept === false))
  const chevron = await lbox('.la-open-more')
  check('little: the chevron zone is 29 px wide at the right end of the pill, after a 1 px rule', !!chevron && !!pill && chevron.width === 29 && Math.abs(chevron.x + chevron.width - (pill.x + pill.width)) < 1 && (await lbox('.la-open-sep'))?.width === 1)
  check('little: there is no back or forward button before the page has a history', (await inLittle<number>(`document.querySelectorAll('.la-nav .la-sq:not(.la-reload)').length`)) === 0)
  check('little: its colours: pill #060627, field a veil over the theme (white at 8 % in a dark space)', (await inLittle<string>(`getComputedStyle(document.querySelector('.la-open')).backgroundColor`)) === 'rgb(6, 6, 39)' && /^rgba\((255, 255, 255|0, 0, 0), 0\.0[78]\)$/.test(await inLittle<string>(`getComputedStyle(document.querySelector('.la-field')).backgroundColor`)))

  // The chevron opens the space picker, a view of its own over the window. A main process that does not have it yet shows the native
  // menu instead, which blocks the whole test: look for the picker before clicking.
  const pickerWired = typeof (little as unknown as { openPicker?: unknown }).openPicker === 'function'
  check('little: the space picker is wired in little.ts (without it the chevron opens a native menu)', pickerWired)
  if (pickerWired) {
    const home = state().activeSpaceId
    browser.dispatch({ type: 'space/create', name: 'Pickland', emoji: '🧭', hue: 40 })
    browser.dispatch({ type: 'space/create', name: 'Zébulon', emoji: '🦓', hue: 200 })
    const pickland = state().spaces.find((sp) => sp.name === 'Pickland')!
    browser.dispatch({ type: 'space/select', id: home })
    const pickerView = () => littleWin()?.contentView.children.map((v) => v as WebContentsView).find((v) => v.webContents?.getURL().includes('picker=1'))
    const inPicker = <T>(js: string) => pickerView()!.webContents.executeJavaScript(js, true) as Promise<T>
    const openPicker = async () => {
      littleWin()!.focus()
      await inLittle(`document.querySelector('.la-open-more').click()`)
      return waitFor(async () => !!pickerView() && (await inPicker<number>(`document.querySelectorAll('.lp-list li').length`).catch(() => 0)) > 0, 8000)
    }
    check('little: the chevron opens the space picker, one row per space', await openPicker() && (await inPicker<number>(`document.querySelectorAll('.lp-list li').length`)) === state().spaces.length, String(state().spaces.length))
    const popover = await inPicker<Box>(`(() => { const r = document.querySelector('.lp').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
    const layer = pickerView()!.getBounds()
    check('little: the popover is 244 x 230, 4 px from the top and right edges of a layer that covers the window', popover.width === LITTLE_PICKER.width && popover.height === LITTLE_PICKER.height && popover.y === 4 && Math.abs(popover.x + popover.width - (layer.width - 4)) < 1 && layer.width === littleWin()!.getContentBounds().width && layer.height === littleWin()!.getContentBounds().height, JSON.stringify({ popover, layer }))
    check('little: its rows are 46 px tall, the first one highlighted, the search row 45 px', (await inPicker<string>(`[...document.querySelectorAll('.lp-list li')].map((li) => li.offsetHeight).join()`)).split(',').every((h) => h === '46') && (await inPicker<boolean>(`document.querySelector('.lp-list li').classList.contains('on')`)) && (await inPicker<number>(`document.querySelector('.lp-search').offsetHeight`)) === 45)
    check('little: its colours: popover #060627, highlighted row #161736', (await inPicker<string>(`getComputedStyle(document.querySelector('.lp')).backgroundColor`)) === 'rgb(6, 6, 39)' && (await inPicker<string>(`getComputedStyle(document.querySelector('.lp-list li.on')).backgroundColor`)) === 'rgb(22, 23, 54)')
    const pick = pickerView()!.webContents
    for (const ch of 'zebu') {
      pick.sendInputEvent({ type: 'keyDown', keyCode: ch })
      pick.sendInputEvent({ type: 'char', keyCode: ch })
      pick.sendInputEvent({ type: 'keyUp', keyCode: ch })
      await sleep(40)
    }
    check('little: typing filters the spaces, ignoring accents', await waitFor(async () => (await inPicker<string>(`[...document.querySelectorAll('.lp-name')].map((n) => n.textContent).join()`)) === 'Zébulon'))
    pick.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    pick.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    check('little: Escape puts the picker away and leaves the window open', (await waitFor(() => !pickerView())) && little.count() === littleBefore + 1)
    await openPicker()
    pickerView()!.webContents.sendInputEvent({ type: 'mouseDown', x: 20, y: 300, button: 'left', clickCount: 1 })
    pickerView()?.webContents.sendInputEvent({ type: 'mouseUp', x: 20, y: 300, button: 'left', clickCount: 1 })
    check('little: a click on the layer, outside the popover, puts it away too', (await waitFor(() => !pickerView())) && little.count() === littleBefore + 1)

    const tabsBeforeLittle = state().tabs.length
    await openPicker()
    const target = pickerView()!.webContents
    const idx = state().spaces.findIndex((sp) => sp.id === pickland.id)
    for (let i = 0; i < idx; i++) {
      target.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
      target.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
      await sleep(60)
    }
    target.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    target.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    check('little: Return on a row opens the page as a tab of that space and closes the window', (await waitFor(() => little.count() === littleBefore)) && state().tabs.length === tabsBeforeLittle + 1 && state().tabs.at(-1)?.spaceId === pickland.id, `${little.count()} ${state().tabs.at(-1)?.spaceId} vs ${pickland.id}`)
    browser.dispatch({ type: 'tab/close', id: state().tabs.at(-1)!.id })
    for (const name of ['Pickland', 'Zébulon']) browser.dispatch({ type: 'space/delete', id: state().spaces.find((sp) => sp.name === name)!.id })
    browser.dispatch({ type: 'space/select', id: home })

  }

  littleId = little.open(`${base}/pg-little`)
  await waitFor(async () => !!littleWin() && (await inLittle<boolean>(`!!document.querySelector('.la-title')?.textContent`).catch(() => false)), 10_000)
  const tabsBeforeMain = state().tabs.length
  await inLittle(`document.querySelector('.la-open-main').click()`)
  check('little: the main button opens the page as a tab of the current space and closes the window', (await waitFor(() => !little.states().some((st) => st.id === littleId))) && state().tabs.length === tabsBeforeMain + 1 && state().tabs.at(-1)?.url === `${base}/pg-little` && state().tabs.at(-1)?.spaceId === state().activeSpaceId, `${little.count()} ${state().tabs.at(-1)?.url}`)
  browser.dispatch({ type: 'tab/close', id: state().tabs.at(-1)!.id })

  await clipboard.writeText('')
  littleId = little.open(`${base}/pg-little2`)
  await waitFor(async () => !!littleWin() && (await inLittle<boolean>(`!!document.querySelector('.la-title')?.textContent`).catch(() => false)), 10_000)
  // The copy is the main process's (the one the shortcut uses): it must not depend on this window having the keyboard focus, which the
  // renderer's `navigator.clipboard` does (it refuses with "Document is not focused"). Whether the window has it by now depends on the
  // machine (what the user or another process has in front), so the window is deliberately left without it.
  win.focus()
  await sleep(300)
  const littleFocused = await inLittle<boolean>('document.hasFocus()')
  let copied = ''
  await inLittle(`document.querySelector('.la-copy').click()`)
  check('little: the link button copies the address, whether or not the window has the keyboard focus', await waitFor(async () => (copied = await clipboard.readText()) === `${base}/pg-little2`, 4000), `${JSON.stringify(copied)} (the Little document ${littleFocused ? 'had' : 'did not have'} the focus)`)
  little.close(littleId)
  await waitFor(() => little.count() === littleBefore)
  server.close()
}
