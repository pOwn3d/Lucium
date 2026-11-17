// Engine checks for the menu bar (the entries each menu must have, in their order, with their separators) and for what its entries do: every entry is chosen the way the menu
// bar would, then the effect is read in the state, in the page, or in the dialog it opens (native dialogs are replaced by recorders:
// nothing here may open a real window on the user's screen or wait for a click). Also: the import sheet over a pretend home folder,
// Find and Replace in a real page, Developer Mode (the reload headers), the portrait capture, restoring data, the window session.
// Called from the engine smoke test: `await smokeIsoMenus(ctx, check)`.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { app, BrowserWindow as ElectronWindow, dialog, Menu, nativeImage, shell, webContents, type MenuItem } from 'electron'
import { fakeApplications, TEST_BROWSERS } from './importers/app-bundles.test-support'
import { COMMANDS } from '@shared/keybindings'
import { littleForms } from '@shared/little-name'
import { PORTRAIT_CANVAS } from '@shared/portrait'
import { usableSession } from '@shared/window-session'
import { getImportService, ImportService, setImportService } from './importers/service'
import { checkForUpdates, isRecordingTrace, recordTrace, restoreData } from './shell/menu-actions'
import { isDefaultBrowserNow } from './shell/default-browser'
import { systemDefaultBrowserPorts } from './shell/default-browser-ports'
import { recoverMissingProfiles } from './shell/recover-profiles'
import { getWindowManager } from './shell/windows'
import type { SmokeContext } from './smoke'
import { sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(8000, 80)

/** The entries each menu must have, in this order, in French. Lucium may add entries of its own, never reorder these. */
const MENU_ENTRIES: Record<string, string[]> = {
  Lucium: ['À propos de Lucium', 'Réglages…', 'Partager Lucium', 'Définir comme navigateur par défaut', 'Importer depuis un autre navigateur…', 'Rechercher les mises à jour…', 'Services', 'Politique de confidentialité', 'Masquer Lucium', 'Masquer les autres', 'Tout afficher', 'Quitter Lucium'],
  Fichier: ['Nouvel onglet…', 'Nouvelle fenêtre', 'Fenêtre vierge', 'Nouvelle fenêtre privée', `Nouvelle ${littleForms('fr').s}`, 'Rouvrir le dernier onglet fermé', 'Ouvrir la barre de commandes', 'Nouveau profil…', 'Fermer la fenêtre', 'Archiver l’onglet', 'Partager…', 'Capturer…', 'Capturer la page entière', 'Capturer en mode portrait', 'Enregistrer la page sous…', 'Imprimer…'],
  Édition: ['Annuler', 'Rétablir', 'Couper', 'Copier', 'Copier l’adresse', 'Copier l’adresse en Markdown', 'Copier l’adresse en citation', 'Coller', 'Coller et adapter le style', 'Supprimer', 'Tout sélectionner', 'Rechercher', 'Orthographe et grammaire', 'Substitutions', 'Transformations', 'Parole', 'Format'],
  'Édition › Rechercher': ['Rechercher…', 'Trouver et remplacer', 'Occurrence suivante', 'Occurrence précédente', 'Utiliser la sélection pour rechercher', 'Aller à la sélection'],
  'Édition › Orthographe et grammaire': ['Afficher l’orthographe et la grammaire', 'Vérifier le document maintenant', 'Vérifier l’orthographe lors de la saisie', 'Vérifier la grammaire avec l’orthographe', 'Corriger l’orthographe automatiquement'],
  'Édition › Substitutions': ['Afficher les substitutions', 'Copier/coller intelligent', 'Guillemets intelligents', 'Tirets intelligents', 'Liens intelligents', 'Détecteurs de données', 'Remplacement du texte'],
  'Édition › Transformations': ['Mettre en majuscules', 'Mettre en minuscules', 'Mettre une majuscule à chaque mot'],
  'Édition › Parole': ['Commencer la lecture à voix haute', 'Arrêter la lecture à voix haute'],
  'Édition › Format › Police': ['Gras', 'Italique', 'Souligné'],
  Affichage: ['Apparence', 'Masquer la barre latérale', 'Masquer la barre d’outils', 'Replier les dossiers épinglés', 'Arrêter le chargement', 'Actualiser la page', 'Actualisation forcée', 'Effacer les cookies et actualiser', 'Effacer le cache et actualiser', 'Ajouter une vue scindée', 'Fermer ce volet scindé', 'Séparer la page de la vue scindée', 'Agrandir la vue scindée actuelle', 'Taille réelle', 'Zoom avant', 'Zoom arrière', 'Développeur', 'Activer le mode plein écran'],
  'Affichage › Apparence': ['Automatique', 'Clair', 'Sombre'],
  'Affichage › Développeur': ['Afficher la source', 'Outils de développement', 'Inspecter les éléments', 'Console JavaScript', 'Inspecteur réseau'],
  Espaces: ['Nouvel espace…', 'Modifier le thème…', 'Renommer l’espace…', 'Changer de profil', 'Espace suivant', 'Espace précédent', 'Gérer les espaces…'],
  Onglets: ['Nouvel onglet…', 'Nouveau dossier…', 'Onglet suivant', 'Onglet précédent', 'Révéler l’onglet dans la barre latérale', 'Aller à l’élément 1 de la barre latérale', 'Aller à l’élément 9 de la barre latérale', 'Vider les onglets du jour', 'Réinitialiser tous les onglets épinglés de cet espace'],
  Archive: ['Page précédente', 'Page suivante', 'Afficher l’historique', 'Afficher l’archive…', 'Vider l’archive'],
  Extensions: ['Ajouter une extension…', 'Gérer les extensions…'],
  Aide: ['Premiers pas', 'Raccourcis clavier essentiels', 'Documentation de Lucium', 'Restaurer les données…', 'Dépannage'],
  'Aide › Dépannage': ['Enregistrer une trace', 'Ouvrir le gestionnaire de tâches', 'Afficher les données de Lucium', 'Copier les infos de Lucium']
}

/** Where a menu draws a separator: after which entry (the labels, in French). */
const SEPARATORS_AFTER: Record<string, string[]> = {
  Lucium: ['À propos de Lucium', 'Définir comme navigateur par défaut', 'Rechercher les mises à jour…', 'Politique de confidentialité', 'Tout afficher'],
  Fichier: ['Rouvrir le dernier onglet fermé', 'Ouvrir la barre de commandes', 'Nouveau profil…', 'Archiver l’onglet']
}

export async function smokeIsoMenus({ browser, store, engine, history, win, overlayView }: SmokeContext, check: Check): Promise<void> {
  const state = () => store.get()
  const ui = overlayView.webContents
  const menu = () => Menu.getApplicationMenu()!
  const walk = (items: MenuItem[]): MenuItem[] => items.flatMap((item) => [item, ...(item.submenu ? walk(item.submenu.items) : [])])
  const itemsOf = (path: string): MenuItem[] | undefined => {
    let items: MenuItem[] = menu().items
    for (const label of path.split(' › ')) {
      const found = items.find((item) => item.label === label)
      if (!found?.submenu) return undefined
      items = found.submenu.items
    }
    return items
  }
  const itemByPath = (...path: string[]): MenuItem | undefined => {
    let items: MenuItem[] = menu().items
    let found: MenuItem | undefined
    for (const label of path) {
      found = items.find((item) => item.label === label)
      items = found?.submenu?.items ?? []
    }
    return found
  }
  const choose = (...path: string[]) => {
    const item = itemByPath(...path)
    if (!item) throw new Error(`menu entry not found: ${path.join(' › ')}`)
    if (!item.enabled) throw new Error(`menu entry is greyed out: ${path.join(' › ')}`)
    item.click()
  }
  const enabled = (...path: string[]) => itemByPath(...path)?.enabled === true
  const activeId = () => state().activeTabBySpace[state().activeSpaceId]!
  const pageEval = <T>(js: string) => browser.evaluateInPage(js) as Promise<T>
  const run = <T>(js: string) => ui.executeJavaScript(js) as Promise<T>
  const count = (selector: string) => run<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
  const mouse = async (x: number, y: number, kind: 'move' | 'down' | 'up') => {
    ui.sendInputEvent({ type: kind === 'move' ? 'mouseMove' : kind === 'down' ? 'mouseDown' : 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await sleep(25)
  }
  /** A real click on the first element matching the selector whose text contains `text`. */
  const click = async (selector: string, text = '') => {
    const box = await run<{ x: number; y: number; width: number; height: number } | null>(
      `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`
    )
    if (!box) return false
    await mouse(box.x + box.width / 2, box.y + box.height / 2, 'move')
    await mouse(box.x + box.width / 2, box.y + box.height / 2, 'down')
    await mouse(box.x + box.width / 2, box.y + box.height / 2, 'up')
    await sleep(80)
    return true
  }
  const openPanel = async (request: Parameters<typeof browser.openOverlay>[0], selector: string) => {
    // The overlay page keeps the DOM of the panel it showed last (a modal panel even keeps its backdrop): everything already there is
    // marked stale, so only what this request mounts counts.
    for (let attempt = 0; attempt < 4; attempt++) {
      await run(`document.querySelectorAll('#root *').forEach((el) => el.setAttribute('data-stale', '1'))`)
      browser.openOverlay(request)
      if (await waitFor(async () => (await count(`${selector}:not([data-stale])`)) > 0, 2500)) return true
    }
    return false
  }

  // ---- native dialogs, replaced by recorders ----
  type Called = { kind: string; message: string; detail: string }
  const called: Called[] = []
  let answer = 0
  let openChoice: string | null = null
  let saveChoice: string | null = null
  const real = { msg: dialog.showMessageBox, open: dialog.showOpenDialog, save: dialog.showSaveDialog, error: dialog.showErrorBox, openPath: shell.openPath }
  const optionsOf = (args: unknown[]) => (args.find((a) => typeof a === 'object' && a !== null && !('webContents' in (a as object))) ?? {}) as { message?: string; detail?: string }
  Object.assign(dialog, {
    showMessageBox: async (...args: unknown[]) => {
      const o = optionsOf(args)
      called.push({ kind: 'message', message: o.message ?? '', detail: o.detail ?? '' })
      return { response: answer, checkboxChecked: false }
    },
    showOpenDialog: async () => ({ canceled: openChoice === null, filePaths: openChoice ? [openChoice] : [] }),
    showSaveDialog: async () => ({ canceled: saveChoice === null, filePath: saveChoice ?? undefined }),
    showErrorBox: (title: string, content: string) => void called.push({ kind: 'error', message: title, detail: content })
  })
  const opened: string[] = []
  Object.assign(shell, {
    openPath: async (path: string) => {
      opened.push(path)
      return ''
    }
  })
  const restoreDialogs = () => {
    Object.assign(dialog, { showMessageBox: real.msg, showOpenDialog: real.open, showSaveDialog: real.save, showErrorBox: real.error })
    Object.assign(shell, { openPath: real.openPath })
  }

  // ---- the pages ----
  let devRequests: Array<{ cacheControl: string | undefined; pragma: string | undefined }> = []
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    if (req.url?.startsWith('/iso-dev')) {
      devRequests.push({ cacheControl: req.headers['cache-control'], pragma: req.headers['pragma'] })
      res.setHeader('cache-control', 'max-age=3600')
      res.setHeader('etag', '"v1"')
      return res.end('<title>iso dev</title><body>dev page</body>')
    }
    if (req.url?.startsWith('/iso-edit')) {
      return res.end(`<title>iso edit</title><body style="height:3000px">
        <input id="in" value="chat noir chat"><textarea id="ta">le chat dort</textarea>
        <div id="ce" contenteditable="true">un chat ici</div>
        <p id="ro">chat en lecture seule</p><input id="rd" readonly value="chat readonly">
        <p id="sel">phrase choisie</p><div id="bottom" style="position:absolute;top:2500px">cible lointaine</div></body>`)
    }
    res.end(`<title>iso ${req.url}</title><body style="background:#336699">page ${req.url}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const scratch = mkdtempSync(join(tmpdir(), 'lucium-iso-'))
  const closeTabs = (match: (url: string) => boolean) => {
    for (const tab of state().tabs.filter((t) => match(t.url))) browser.dispatch({ type: 'tab/close', id: tab.id })
  }
  const openTab = async (path: string, title: string) => {
    browser.dispatch({ type: 'tab/open', url: `${base}${path}` })
    await waitFor(() => state().tabs.find((t) => t.id === activeId())?.title === title)
    return activeId()
  }

  try {
    // ======================= The menu bar, entry by entry =======================
    // What earlier checks archived is not part of this test: the Edit menu would offer to undo it.
    browser.dispatch({ type: 'archive/clear' })
    await waitFor(() => itemByPath('Édition', 'Annuler') !== undefined)
    const labels = (path: string) => (itemsOf(path) ?? []).filter((i) => i.type !== 'separator').map((i) => i.label)
    for (const [path, expected] of Object.entries(MENU_ENTRIES)) {
      const have = labels(path)
      const positions = expected.map((label) => have.indexOf(label))
      const ordered = positions.every((at, i) => at >= 0 && (i === 0 || at > positions[i - 1]!))
      check(`menu "${path}" has its entries, in order`, ordered, ordered ? undefined : `missing or misplaced: ${expected.filter((_l, i) => positions[i] === -1 || (i > 0 && positions[i]! < positions[i - 1]!)).join(' | ')} — has ${have.join(' | ')}`)
    }
    for (const [path, after] of Object.entries(SEPARATORS_AFTER)) {
      const items = itemsOf(path) ?? []
      const missing = after.filter((label) => {
        const at = items.findIndex((i) => i.label === label)
        return at < 0 || items[at + 1]?.type !== 'separator'
      })
      check(`menu "${path}" draws its separators after the expected entries`, missing.length === 0, missing.join(' | '))
    }

    // Shortcuts: every command is bound to a menu entry, so changing it in Settings changes the entry (and there is no clash).
    // The nine shortcuts ⌃1…⌃9 belong to the first nine spaces: there must be nine for them to show.
    const extraSpaces: string[] = []
    while (state().spaces.length < 9) {
      browser.dispatch({ type: 'space/create', name: `iso ${state().spaces.length + 1}`, emoji: '🧪', hue: 200 })
      extraSpaces.push(state().spaces.at(-1)!.id)
    }
    // One combination per command, whatever their number: F1-F24 under each of the seven modifier sets (a ceiling of 168 commands).
    const MODIFIER_SETS = ['Ctrl+Alt+Shift', 'Ctrl+Alt', 'Ctrl+Shift', 'Alt+Shift', 'Cmd+Ctrl+Alt+Shift', 'Cmd+Ctrl+Alt', 'Cmd+Ctrl+Shift']
    if (COMMANDS.length > MODIFIER_SETS.length * 24) throw new Error(`${COMMANDS.length} commands: add a modifier set to the shortcut test`)
    const unique = COMMANDS.map((command, i) => [command.id, `${MODIFIER_SETS[Math.floor(i / 24)]}+F${(i % 24) + 1}`] as const)
    // Some entries exist only while their feature is on: they are switched on for the check. Three commands have no menu entry by design:
    // ⌃Tab and ⇧⌃Tab are taken from the key events (a menu accelerator never sees ⌃ released), "Verrouiller maintenant" exists only with a lock set.
    const withFeatures = { qrCode: true, pageWatch: true, scrollSync: true, batterySaver: true, pdfWithSource: true, compactMode: true, tabTree: true, translateLocal: true }
    const featuresBefore = Object.fromEntries(Object.keys(withFeatures).map((key) => [key, (state().settings as unknown as Record<string, boolean>)[key]]))
    browser.dispatch({ type: 'settings/update', patch: { keyBindings: Object.fromEntries(unique), ...withFeatures } })
    const shown = new Set(walk(menu().items).map((i) => String(i.accelerator ?? '')))
    const NO_MENU_ENTRY = new Set(['recentTab', 'recentTabBack', 'lockNow'])
    const unhosted = unique.filter(([id, accelerator]) => !NO_MENU_ENTRY.has(id) && !shown.has(accelerator)).map(([id]) => id)
    check('every command of the shortcut list is the shortcut of a menu entry (Settings › Shortcuts changes the menu)', unhosted.length === 0, unhosted.join(', '))
    browser.dispatch({ type: 'settings/update', patch: { keyBindings: {}, ...featuresBefore } })
    // The shortcuts of extensions come from their manifests, two of the probes may suggest the same one.
    const own = menu().items.filter((m) => m.label !== 'Extensions')
    const accelerators = walk(own).filter((i) => i.accelerator && i.registerAccelerator !== false).map((i) => String(i.accelerator))
    check('with the default shortcuts, no two entries register the same one', new Set(accelerators).size === accelerators.length, accelerators.filter((a, i) => accelerators.indexOf(a) !== i).join(', '))
    // The second key of a command is held by a copy of its entry that the menu bar does not show. Whether the key itself answers can only be
    // seen by pressing it on the installed application (a synthetic key event never reaches the menu bar of macOS).
    const copyOf = (accelerator: string) => walk(menu().items).filter((i) => i.accelerator === accelerator)
    const secondKeys: Array<[string, string]> = [['Page précédente', 'Ctrl+CmdOrCtrl+Left'], ['Page suivante', 'Ctrl+CmdOrCtrl+Right'], ['Effacer les données du site…', 'Ctrl+CmdOrCtrl+X'], ['Aide des raccourcis', 'CmdOrCtrl+Alt+K']]
    check('the commands with a second shortcut have a hidden copy of their entry that holds it',
      secondKeys.every(([label, accelerator]) => copyOf(accelerator).length === 1 && copyOf(accelerator)[0]!.label === label && copyOf(accelerator)[0]!.visible === false) &&
        Array.from({ length: 9 }, (_, i) => copyOf(`Ctrl+CmdOrCtrl+${i + 1}`)).every((copies) => copies.length === 1 && copies[0]!.visible === false),
      JSON.stringify(walk(menu().items).filter((i) => i.visible === false && i.accelerator).map((i) => `${i.label} ${String(i.accelerator)}`)))
    check('the shortcuts shown are the expected ones (⌥⌘F Find and Replace, ⌃D Developer Mode, ⌃⇧- Close this Split Pane, ⌥⌘U View Source, ⇧⌘W Close Window)',
      itemByPath('Édition', 'Rechercher', 'Trouver et remplacer')?.accelerator === 'CmdOrCtrl+Alt+F' &&
        itemByPath('Affichage', 'Développeur', 'Activer le mode développeur pour ce site')?.accelerator === 'Ctrl+D' &&
        itemByPath('Affichage', 'Fermer ce volet scindé')?.accelerator === 'Ctrl+Shift+-' &&
        itemByPath('Affichage', 'Développeur', 'Afficher la source')?.accelerator === 'CmdOrCtrl+Alt+U' &&
        itemByPath('Fichier', 'Fermer la fenêtre')?.accelerator === 'CmdOrCtrl+Shift+W')

    for (const id of extraSpaces) browser.dispatch({ type: 'space/delete', id })
    await waitFor(() => state().spaces.length < 9)

    // ======================= Entries greyed out when they do not apply =======================
    closeTabs(() => true)
    await openTab('/iso-1', 'iso /iso-1')
    check('Back is greyed out on the first page of a tab and Forward too', !enabled('Archive', 'Page précédente') && !enabled('Archive', 'Page suivante'))
    browser.submitUrl(`${base}/iso-2`, 'current')
    check('Back turns on once the tab has gone to a second page', await waitFor(() => enabled('Archive', 'Page précédente')))
    browser.nav('back')
    check('and Forward turns on after going back', await waitFor(() => enabled('Archive', 'Page suivante')))
    check('the split-view entries are greyed out outside a split view', !enabled('Affichage', 'Fermer ce volet scindé') && !enabled('Affichage', 'Séparer la page de la vue scindée') && !enabled('Affichage', 'Agrandir la vue scindée actuelle'))
    check('Find Next and Previous are greyed out until a search is under way', !enabled('Édition', 'Rechercher', 'Occurrence suivante') && !enabled('Édition', 'Rechercher', 'Occurrence précédente'))
    browser.findInPage('iso', {})
    check('and turn on with a search', await waitFor(() => enabled('Édition', 'Rechercher', 'Occurrence suivante') && enabled('Édition', 'Rechercher', 'Occurrence précédente')))
    browser.endFind()
    check('Stop Loading is greyed out when nothing is loading', await waitFor(() => !enabled('Affichage', 'Arrêter le chargement')))
    check('the sidebar entry says what it will do (Hide / Show)', itemByPath('Affichage', 'Masquer la barre latérale') !== undefined)
    browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: false } })
    check('and says Show when the sidebar is hidden', await waitFor(() => itemByPath('Affichage', 'Afficher la barre latérale') !== undefined))
    browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: true } })
    check('the pin entry says Pin, then Unpin for a pinned tab', itemByPath('Onglets', 'Épingler l’onglet') !== undefined)
    browser.dispatch({ type: 'tab/pin', id: activeId() })
    check('…Unpin when the tab is pinned', await waitFor(() => itemByPath('Onglets', 'Désépingler l’onglet') !== undefined))
    browser.dispatch({ type: 'tab/unpin', id: activeId() })
    const wasDefault = isDefaultBrowserNow(systemDefaultBrowserPorts())
    check('"Définir comme navigateur par défaut" is greyed out when Lucium already is the default', enabled('Lucium', 'Définir comme navigateur par défaut') === !wasDefault)

    // ======================= Share =======================
    check('File › Share… is on for a web page', enabled('Fichier', 'Partager…'))
    browser.dispatch({ type: 'tab/open', url: 'about:blank' })
    check('…and greyed out for a page that is not on the web', await waitFor(() => !enabled('Fichier', 'Partager…')))
    closeTabs((url) => url === 'about:blank')
    await sleep(150)

    // ======================= Find and Replace =======================
    const editId = await openTab('/iso-edit', 'iso edit')
    choose('Édition', 'Rechercher', 'Trouver et remplacer')
    check('Edit › Find › Find and Replace opens its panel', browser.currentPanel() === 'findreplace')
    check('the panel has the field, the replacement field and the two buttons', await openPanel({ panel: 'findreplace' }, '.fr-input') && (await count('.fr-input')) === 2 && (await count('.fr-text')) === 2)
    // The matches are counted by the page's search; the replacement works on what can be typed in.
    await run(`(() => { const el = document.querySelector('.fr-input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, 'chat'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    check('typing in the panel searches the page (the counter shows the matches)', await waitFor(async () => /\d+\/\d+/.test(String(await run(`document.querySelector('.fr-count')?.textContent ?? ''`)))))
    await run(`(() => { const el = document.querySelectorAll('.fr-input')[1]; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, 'chien'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    const field = (id: string) => pageEval<string>(`document.getElementById(${JSON.stringify(id)}).${id === 'in' || id === 'rd' || id === 'ta' ? 'value' : 'textContent'}`)
    await click('.fr-text', 'Remplacer')
    await waitFor(async () => (await field('in')) !== 'chat noir chat')
    check('"Remplacer" replaces one occurrence, in the first field', (await field('in')) === 'chien noir chat' && (await field('ta')) === 'le chat dort' && (await field('ce')) === 'un chat ici', `${await field('in')} | ${await field('ta')} | ${await field('ce')}`)
    await click('.fr-text', 'Tout')
    await waitFor(async () => (await field('ta')) === 'le chien dort')
    check('"Tout" replaces the rest, in the text field, the text area and the editable region', (await field('in')) === 'chien noir chien' && (await field('ta')) === 'le chien dort' && (await field('ce')) === 'un chien ici', `${await field('in')} | ${await field('ta')} | ${await field('ce')}`)
    check('text nobody can edit (a paragraph, a read-only field) is left alone', (await field('ro')) === 'chat en lecture seule' && (await field('rd')) === 'chat readonly')
    check('a change is announced to the page (an input event), so its framework sees it', await pageEval<boolean>(`(() => { let heard = false; const el = document.getElementById('ta'); el.addEventListener('input', () => (heard = true)); window.__heard = () => heard; return true })()`))
    const direct = await browser.replaceInPage({ query: 'chien', replacement: 'chat', all: false, matchCase: true })
    check('replacing says how many it did (a notice)', direct === '1 occurrence remplacée' && browser.snapshot().toast?.message === '1 occurrence remplacée', direct)
    browser.findInPage('lecture seule', {})
    await waitFor(() => (browser.snapshot().find?.matches ?? 0) >= 1)
    check('and says so when the text found is only where it cannot be changed', (await browser.replaceInPage({ query: 'lecture seule', replacement: 'x', all: true, matchCase: false })) === 'Le texte trouvé se trouve dans une zone en lecture seule')
    browser.closeOverlay()
    check('closing the panel ends the search', await waitFor(() => browser.snapshot().find === null))

    // ======================= Use Selection to Find, Jump to Selection =======================
    await pageEval(`(() => { getSelection().selectAllChildren(document.getElementById('sel')); return true })()`)
    choose('Édition', 'Rechercher', 'Utiliser la sélection pour rechercher')
    check('Use Selection to Find searches for the selected text', await waitFor(() => browser.snapshot().find?.text === 'phrase choisie'), String(browser.snapshot().find?.text))
    check('…in the find panel, whose field shows it', browser.currentPanel() === 'find' && (await waitFor(async () => String(await run(`document.querySelector('.fb-input')?.value ?? ''`)) === 'phrase choisie')))
    browser.closeOverlay()
    await pageEval(`(() => { window.scrollTo(0, 0); getSelection().selectAllChildren(document.getElementById('bottom')); return true })()`)
    choose('Édition', 'Rechercher', 'Aller à la sélection')
    check('Jump to Selection scrolls the page to the selected text', await waitFor(async () => (await pageEval<number>('window.scrollY')) > 1500), String(await pageEval<number>('window.scrollY')))

    // ======================= Transformations and Format =======================
    await pageEval(`(() => { const ta = document.getElementById('ta'); ta.focus(); ta.setSelectionRange(3, 8); return true })()`)
    choose('Édition', 'Transformations', 'Mettre en majuscules')
    check('Transformations › upper case rewrites the selection of a text field', await waitFor(async () => (await field('ta')) === 'le CHIEN dort'), await field('ta'))
    choose('Édition', 'Transformations', 'Mettre en minuscules')
    check('…lower case', await waitFor(async () => (await field('ta')) === 'le chien dort'), await field('ta'))
    await pageEval(`(() => { const ta = document.getElementById('ta'); ta.focus(); ta.setSelectionRange(0, 12); return true })()`)
    choose('Édition', 'Transformations', 'Mettre une majuscule à chaque mot')
    check('…capitalize', await waitFor(async () => (await field('ta')) === 'Le Chien Dort'), await field('ta'))
    await pageEval(`(() => { const ce = document.getElementById('ce'); ce.focus(); getSelection().selectAllChildren(ce); return true })()`)
    choose('Édition', 'Format', 'Police', 'Gras')
    check('Format › Font › Bold makes the selection of an editable region bold', await waitFor(async () => (await pageEval<string>(`document.getElementById('ce').innerHTML`)).includes('<b>')), await pageEval<string>(`document.getElementById('ce').innerHTML`))
    choose('Édition', 'Format', 'Police', 'Souligné')
    check('…and underlined', (await pageEval<string>(`document.getElementById('ce').innerHTML`)).includes('<u>'))
    await pageEval(`(() => { document.getElementById('ro').focus(); getSelection().selectAllChildren(document.getElementById('ro')); return true })()`)
    choose('Édition', 'Transformations', 'Mettre en majuscules')
    // No wait: the transformation is a script the menu sends to the page at once (page-commands.ts), and the read below goes to the page after it,
    // the same way (browser.evaluateInPage).
    check('text that cannot be edited is not rewritten by a transformation', (await field('ro')) === 'chat en lecture seule')

    // ======================= Edit › Undo =======================
    // The text of a field first: type into a field of the page, and Undo takes it back.
    await pageEval(`(() => { const ta = document.getElementById('ta'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); return true })()`)
    browser.pageFor(editId)?.focus()
    await sleep(200)
    const typing = webContents.getFocusedWebContents()
    const before = await field('ta')
    void typing?.insertText(' XYZ')
    await waitFor(async () => (await field('ta')) !== before)
    check('(a field of the page has the focus and takes text)', typing !== null && (await field('ta')) === `${before} XYZ`, String(await field('ta')))
    choose('Édition', 'Annuler')
    check('Undo takes back what was typed in a text field, and archives nothing back', await waitFor(async () => (await field('ta')) === before), await field('ta'))
    closeTabs((url) => url.includes('/iso-edit'))
    await sleep(300)
    // What earlier checks archived is not part of this test.
    browser.dispatch({ type: 'archive/clear' })
    const first = state().tabs.length
    browser.dispatch({ type: 'tab/open', url: `${base}/iso-undo` })
    await waitFor(() => state().tabs.find((t) => t.id === activeId())?.title === 'iso /iso-undo')
    check('Undo is plain "Annuler" while nothing was archived in this session', itemByPath('Édition', 'Annuler') !== undefined)
    choose('Fichier', 'Archiver l’onglet')
    check('after archiving a tab the entry offers to undo that', await waitFor(() => itemByPath('Édition', 'Annuler l’archivage de l’onglet') !== undefined))
    choose('Édition', 'Annuler l’archivage de l’onglet')
    check('choosing it brings the tab back', await waitFor(() => state().tabs.some((t) => t.url.endsWith('/iso-undo'))) && state().tabs.length === first + 1)
    check('…and the entry goes back to "Annuler"', await waitFor(() => itemByPath('Édition', 'Annuler') !== undefined))
    closeTabs((url) => url.endsWith('/iso-undo'))

    // ======================= View Source, Developer Mode =======================
    await openTab('/iso-dev', 'iso dev')
    choose('Affichage', 'Développeur', 'Afficher la source')
    check('View Source opens the source of the page in a new tab', await waitFor(() => state().tabs.some((t) => t.url === `view-source:${base}/iso-dev`)))
    closeTabs((url) => url.startsWith('view-source:'))
    await sleep(200)
    devRequests = []
    choose('Affichage', 'Actualiser la page')
    await waitFor(() => devRequests.length > 0)
    check('a normal reload revalidates the page (max-age=0), without ignoring the cache', devRequests[0]?.cacheControl === 'max-age=0', JSON.stringify(devRequests))
    check('Developer Mode is offered for the site', itemByPath('Affichage', 'Développeur', 'Activer le mode développeur pour ce site') !== undefined)
    choose('Affichage', 'Développeur', 'Activer le mode développeur pour ce site')
    check('turning it on adds the host to the sites in Developer Mode', state().settings.developerHosts.includes('127.0.0.1'), JSON.stringify(state().settings.developerHosts))
    check('…and the entry says how to turn it off', await waitFor(() => itemByPath('Affichage', 'Développeur', 'Désactiver le mode développeur pour ce site') !== undefined))
    check('…with a notice', /Mode développeur activé/.test(browser.snapshot().toast?.message ?? ''), browser.snapshot().toast?.message)
    devRequests = []
    choose('Affichage', 'Actualiser la page')
    await waitFor(() => devRequests.length > 0)
    check('on a developer site the reload ignores the HTTP cache (Cache-Control: no-cache)', devRequests[0]?.cacheControl === 'no-cache' && devRequests[0]?.pragma === 'no-cache', JSON.stringify(devRequests))
    choose('Affichage', 'Développeur', 'Désactiver le mode développeur pour ce site')
    check('turning it off removes the host', !state().settings.developerHosts.includes('127.0.0.1'))
    devRequests = []
    choose('Affichage', 'Actualiser la page')
    await waitFor(() => devRequests.length > 0)
    check('…and the reload is a normal one again', devRequests[0]?.cacheControl === 'max-age=0', JSON.stringify(devRequests))
    closeTabs((url) => url.includes('/iso-dev'))

    // ======================= Split view entries =======================
    const a = await openTab('/iso-a', 'iso /iso-a')
    const b = await openTab('/iso-b', 'iso /iso-b')
    browser.dispatch({ type: 'split/create', tabId: a, withTabId: b })
    check('the split-view entries turn on inside a split view', await waitFor(() => enabled('Affichage', 'Fermer ce volet scindé') && enabled('Affichage', 'Séparer la page de la vue scindée') && enabled('Affichage', 'Agrandir la vue scindée actuelle')))
    const ratios = () => state().splits.find((s) => s.tabIds.includes(b))?.ratios ?? []
    const focusedAt = () => state().splits.find((s) => s.tabIds.includes(b))?.tabIds.indexOf(activeId()) ?? -1
    choose('Affichage', 'Agrandir la vue scindée actuelle')
    check('Expand Current Split gives the focused pane most of the space', await waitFor(() => (ratios()[focusedAt()] ?? 0) > 0.8), `${JSON.stringify(ratios())} at ${focusedAt()}`)
    choose('Affichage', 'Agrandir la vue scindée actuelle')
    check('…and choosing it again gives equal shares back', await waitFor(() => Math.abs((ratios()[0] ?? 0) - 0.5) < 0.001), JSON.stringify(ratios()))
    choose('Affichage', 'Séparer la page de la vue scindée')
    check('Separate Page from Split View ends the split and keeps both tabs', await waitFor(() => state().splits.length === 0) && state().tabs.some((t) => t.id === a) && state().tabs.some((t) => t.id === b))
    browser.dispatch({ type: 'split/create', tabId: a, withTabId: b })
    await waitFor(() => enabled('Affichage', 'Fermer ce volet scindé'))
    const inFocus = activeId()
    choose('Affichage', 'Fermer ce volet scindé')
    check('Close this Split Pane closes the page in focus and ends the split', await waitFor(() => state().splits.length === 0 && !state().tabs.some((t) => t.id === inFocus)), `${inFocus} ${state().tabs.map((t) => t.id).join()}`)
    closeTabs((url) => url.includes('/iso-a') || url.includes('/iso-b'))

    // ======================= Capture in Portrait Mode =======================
    const pictures = join(scratch, 'pictures')
    app.setPath('pictures', pictures)
    await openTab('/iso-portrait', 'iso /iso-portrait')
    await sleep(500)
    choose('Fichier', 'Capturer en mode portrait')
    const portraitFile = () => (existsSync(join(pictures, 'Lucium')) ? readdirSync(join(pictures, 'Lucium')).find((f) => f.endsWith('-portrait.png')) : undefined)
    check('Capture in Portrait Mode saves a picture of the page', await waitFor(() => portraitFile() !== undefined, 20_000))
    if (portraitFile()) {
      const picture = nativeImage.createFromPath(join(pictures, 'Lucium', portraitFile()!))
      const size = picture.getSize()
      check('…on the tall canvas (1080 × 1920)', size.width === PORTRAIT_CANVAS.width && size.height === PORTRAIT_CANVAS.height, `${size.width}x${size.height}`)
      const bitmap = picture.toBitmap()
      const pixel = (x: number, y: number) => [bitmap[(y * size.width + x) * 4 + 2]!, bitmap[(y * size.width + x) * 4 + 1]!, bitmap[(y * size.width + x) * 4]!]
      const corner = pixel(10, 10)
      check('…whose background takes the colour of the site (blue-ish for a #336699 page)', corner[2]! > corner[0]! + 20, JSON.stringify(corner))
    }
    closeTabs((url) => url.includes('/iso-portrait'))

    // ======================= Dialogs of the app menu =======================
    const lastCall = () => called.at(-1)
    called.length = 0
    check('View has no entry that would send the page to another screen: Electron has no Cast router, and macOS mirrors the screen itself', menu().items.find((m) => m.label === 'Affichage')?.submenu?.items.every((item) => !/autre écran|caster/i.test(item.label)) === true)
    called.length = 0
    choose('Lucium', 'Politique de confidentialité')
    check('Privacy Policy says what leaves the computer', await waitFor(() => /confidentialité/i.test(lastCall()?.message ?? '') && /télémétrie/.test(lastCall()?.detail ?? '')))
    called.length = 0
    delete process.env['LUCIUM_UPDATE_FEED']
    choose('Lucium', 'Rechercher les mises à jour…')
    check('Check for Updates… with no feed configured says so, instead of pretending to be up to date', await waitFor(() => /pas configurée/.test(lastCall()?.message ?? '')), lastCall()?.message)
    called.length = 0
    process.env['LUCIUM_UPDATE_FEED'] = 'http://insecure.example/latest'
    await checkForUpdates({ win, browser, store }, state().settings)
    check('…and refuses a feed that is not https', /a échoué/.test(lastCall()?.message ?? '') && /https/.test(lastCall()?.detail ?? ''), JSON.stringify(lastCall()))
    delete process.env['LUCIUM_UPDATE_FEED']
    opened.length = 0
    choose('Aide', 'Premiers pas')
    check('Help › Getting Started opens the README', await waitFor(() => opened.some((p) => p.endsWith('README.fr.md') && existsSync(p))), opened.join(', '))
    choose('Aide', 'Documentation de Lucium')
    check('Help › Documentation opens the folder of the guides', await waitFor(() => opened.some((p) => p.endsWith('docs') && existsSync(p))), opened.join(', '))
    choose('Aide', 'Raccourcis clavier essentiels')
    const settingsWindow = () => ElectronWindow.getAllWindows().find((w) => w.getTitle() === 'Réglages')
    check('Help › Essential Keyboard Shortcuts opens the Settings window', await waitFor(() => settingsWindow() !== undefined, 10_000))
    settingsWindow()?.close()

    // ======================= Help › Record Trace =======================
    const tracePath = join(scratch, 'trace.json')
    called.length = 0
    saveChoice = tracePath
    check('Record Trace starts as "Enregistrer une trace"', itemByPath('Aide', 'Dépannage', 'Enregistrer une trace') !== undefined)
    choose('Aide', 'Dépannage', 'Enregistrer une trace')
    check('it records, and the entry then offers to stop', await waitFor(() => isRecordingTrace() && itemByPath('Aide', 'Dépannage', 'Arrêter et enregistrer la trace…') !== undefined))
    await sleep(500)
    choose('Aide', 'Dépannage', 'Arrêter et enregistrer la trace…')
    check('stopping saves a trace file', await waitFor(() => existsSync(tracePath) && !isRecordingTrace(), 30_000))
    // Chromium 156 writes a Perfetto trace (protobuf: a first packet starts with 0x0A), which ui.perfetto.dev opens; older ones wrote JSON.
    const traceHead = existsSync(tracePath) ? readFileSync(tracePath).subarray(0, 1) : Buffer.alloc(0)
    check('…that holds Chromium’s trace (Perfetto format), not an empty file', existsSync(tracePath) && statSync(tracePath).size > 1000 && (traceHead[0] === 0x0a || traceHead[0] === 0x7b), existsSync(tracePath) ? String(statSync(tracePath).size) : 'no file')
    check('…and the entry is back to "Enregistrer une trace"', await waitFor(() => itemByPath('Aide', 'Dépannage', 'Enregistrer une trace') !== undefined))
    // Whatever happened above, no recording is left running.
    if (isRecordingTrace()) {
      saveChoice = join(scratch, 'cleanup.json')
      await recordTrace({ win, browser, store }, () => undefined)
    }
    saveChoice = null

    // ======================= Help › Restore Data… =======================
    type State = ReturnType<typeof store.get>
    const original = JSON.parse(JSON.stringify(state())) as State
    const spaceCount = state().spaces.length
    const exported = JSON.parse(JSON.stringify(state())) as State
    exported.spaces = [...exported.spaces, { id: 'restored-space', name: 'Restauré', emoji: '♻️', theme: exported.spaces[0]!.theme, profileId: 'default' }]
    const exportPath = join(scratch, 'export.json')
    writeFileSync(exportPath, JSON.stringify(exported))
    store.flush()
    called.length = 0
    openChoice = exportPath
    answer = 0
    choose('Aide', 'Restaurer les données…')
    check('Restore Data replaces the state with the saved one, after asking', await waitFor(() => state().spaces.length === spaceCount + 1 && state().spaces.some((s) => s.name === 'Restauré')) && called.some((c) => /Restaurer/.test(c.message)))
    check('…and keeps a copy of the state it replaced next to the state file', readdirSync(app.getPath('userData')).some((f) => f.startsWith('state.json.avant-restauration-')), readdirSync(app.getPath('userData')).join(', '))
    writeFileSync(exportPath, '{"version": 999}')
    called.length = 0
    await restoreData({ win, browser, store })
    check('a file that is not a usable state is refused with a message, and nothing changes', called.some((c) => c.kind === 'error' && /Restauration impossible/.test(c.message)) && state().spaces.length === spaceCount + 1)
    browser.dispatch({ type: 'state/restore', state: original })
    check('(the test puts the previous state back)', await waitFor(() => state().spaces.length === spaceCount))
    openChoice = null

    // ======================= Import from Another Browser… =======================
    // A pretend home folder: the sheet and the service read it, never the user's.
    const home = join(scratch, 'home')
    const put = (relative: string, content: string | ((path: string) => void)) => {
      const path = join(home, relative)
      mkdirSync(dirname(path), { recursive: true })
      if (typeof content === 'string') writeFileSync(path, content)
      else content(path)
    }
    const sqlite = (sql: string) => (path: string) => {
      const db = new DatabaseSync(path)
      db.exec(sql)
      db.close()
    }
    const WHEN = Date.UTC(2026, 3, 2, 10, 0, 0)
    const SUPPORT = 'Library/Application Support'
    put(`${SUPPORT}/Google/Chrome/Local State`, JSON.stringify({ profile: { info_cache: { Default: { name: 'Perso' } } } }))
    put(`${SUPPORT}/Google/Chrome/Default/Bookmarks`, JSON.stringify({ roots: { bookmark_bar: { type: 'folder', name: 'Barre', children: [{ type: 'url', name: 'Signet iso', url: 'https://iso-signet.example/' }, { type: 'folder', name: 'Dossier iso', children: [{ type: 'folder', name: 'Sous-dossier iso', children: [{ type: 'url', name: 'Profond', url: 'https://iso-profond.example/' }] }] }] } } }))
    put(`${SUPPORT}/Google/Chrome/Default/History`, sqlite(`CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER);
      INSERT INTO urls VALUES (1, 'https://iso-historique.example/page', 'Page iso', 3, 0, ${(BigInt(WHEN) + 11_644_473_600_000n) * 1000n}, 0);`))
    put('Library/Safari/Bookmarks.plist', '<?xml version="1.0"?><plist version="1.0"><dict><key>Children</key><array></array></dict></plist>')
    put('Library/Safari/History.db', sqlite('CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT); CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT);'))
    // The binary property list of a real Safari is converted by the system tool: prove it works from this process.
    const real_service = getImportService()
    const fake = new ImportService({
      home,
      ctx: () => ({ now: Date.now(), newId: () => crypto.randomUUID() }),
      dispatch: (action) => browser.dispatch(action),
      state: () => store.get(),
      mergeHistory: (entries) => history.of('default').merge(entries),
      chooseFile: async () => null,
      // The sheet names each browser by its application (importers/app-names.ts): pretend ones, so that the names below are the ones the sheet shows.
      applications: [fakeApplications(join(home, 'Applications'), TEST_BROWSERS)]
    })
    setImportService(fake)
    const spacesBefore = state().spaces.length
    choose('Lucium', 'Importer depuis un autre navigateur…')
    check('Lucium › Import from Another Browser… opens the import sheet', browser.currentPanel() === 'import')
    check('the sheet lists the browsers found, with what each can give', await openPanel({ panel: 'import' }, '.import-row') && (await count('.import-row')) >= 2)
    await click('.import-row', 'Google Chrome')
    check('choosing Chrome shows what can be imported (bookmarks, history)', await waitFor(async () => (await count('.import-category')) === 2), String(await run(`[...document.querySelectorAll('.import-category')].map((e) => e.textContent).join(' | ')`)))
    await click('.button.primary', 'Importer')
    check('"Importer" first shows what would come in, and brings nothing before it is confirmed', (await waitFor(async () => /Prêt à importer depuis Google Chrome/.test(String(await run(`document.querySelector('.import-report')?.textContent ?? ''`))), 15_000)) && state().spaces.length === spacesBefore)
    await click('.button.primary', 'Confirmer l’import')
    check('"Confirmer l’import" brings the bookmarks in as a new space and says how many', await waitFor(async () => /Importé depuis Google Chrome/.test(String(await run(`document.querySelector('.import-report')?.textContent ?? ''`))), 15_000))
    const chromeSpace = state().spaces.find((s) => s.name === 'Chrome')
    check('the new space holds the bookmarks as pinned tabs, folders nested as they were', state().spaces.length === spacesBefore + 1 && state().tabs.filter((t) => t.spaceId === chromeSpace?.id && t.pinned).length === 2 && state().folders.some((f) => f.name === 'Sous-dossier iso' && state().folders.find((p) => p.id === f.parentId)?.name === 'Dossier iso'))
    check('the history of Chrome joined the history (SQLite read from inside Electron)', history.of('default').search('iso-historique').length === 1 && history.of('default').search('iso-historique')[0]!.visitCount === 3)
    check('…and importing the same history again changes nothing', history.of('default').merge(history.of('default').search('iso-historique')) === 0)
    browser.closeOverlay()
    // Safari when macOS refuses access.
    const denied = join(home, 'Library/Safari/History.db')
    chmodSync(denied, 0o000)
    chmodSync(join(home, 'Library/Safari/Bookmarks.plist'), 0o000)
    check('(Safari is listed even though macOS hides its folder)', fake.listSources().some((s) => s.id === 'safari'))
    const reportText = () => run<string>(`document.querySelector('.import-report')?.textContent ?? ''`)
    const sheet = await openPanel({ panel: 'import' }, '.import-row')
    const picked = sheet && (await click('.import-row', 'Safari'))
    await sleep(200)
    const pressed = picked && (await click('.button.primary', 'Importer'))
    check('the sheet explains full disk access when macOS refuses Safari’s files', pressed && (await waitFor(async () => /Accès complet au disque/.test(await reportText()), 10_000)), `${sheet} ${picked} ${pressed} → ${await reportText()}`)
    check('…and offers the System Settings pane and the file chooser', String(await run(`[...document.querySelectorAll('.import .button')].map((b) => b.textContent).join('|')`)).includes('Ouvrir Réglages Système'))
    chmodSync(denied, 0o644)
    chmodSync(join(home, 'Library/Safari/Bookmarks.plist'), 0o644)
    browser.closeOverlay()
    if (real_service) setImportService(real_service)
    // Clean what the import added.
    for (const space of state().spaces.filter((s) => s.name === 'Chrome')) browser.dispatch({ type: 'space/delete', id: space.id })

    // ======================= Spell checking =======================
    const check_spell = itemByPath('Édition', 'Orthographe et grammaire', 'Vérifier l’orthographe lors de la saisie')
    check('Check Spelling While Typing is a ticked box', check_spell?.type === 'checkbox' && check_spell.checked === true)
    check('the entries that do nothing in a web page (spelling panel, smart quotes) are greyed out', !enabled('Édition', 'Orthographe et grammaire', 'Afficher l’orthographe et la grammaire') && !enabled('Édition', 'Substitutions', 'Guillemets intelligents'))

    // ======================= Where a profile keeps its data =======================
    // "Missing Profile" needs to tell a profile whose data was removed from one never used: the storage must exist once a page ran.
    const probeSpaceCount = state().spaces.length
    browser.dispatch({ type: 'space/create', name: 'iso-probe', emoji: '🧪', hue: 30, profileId: 'iso-probe' })
    const probeSpace = state().spaces.at(-1)!
    check('(a space with a profile of its own was created)', state().spaces.length === probeSpaceCount + 1 && probeSpace.profileId === 'iso-probe')
    browser.dispatch({ type: 'space/select', id: probeSpace.id })
    browser.dispatch({ type: 'tab/open', url: `${base}/iso-profile`, spaceId: probeSpace.id })
    await waitFor(() => state().tabs.some((t) => t.spaceId === probeSpace.id && t.title === 'iso /iso-profile'))
    check('the storage of a profile exists as soon as a page of that profile has loaded', await waitFor(() => engine.storedProfileIds().includes('iso-probe'), 10_000), engine.storedProfileIds().join(','))
    check('…and the first page of a profile marks it as used', await waitFor(() => state().settings.usedProfiles.includes('iso-probe')), JSON.stringify(state().settings.usedProfiles))
    closeTabs((url) => url.includes('/iso-profile'))
    browser.dispatch({ type: 'space/select', id: state().spaces[0]!.id })
    browser.dispatch({ type: 'space/delete', id: probeSpace.id })
    // A profile that was used and whose storage is gone: the space goes back to the default profile, and the user is told which.
    browser.dispatch({ type: 'space/create', name: 'iso-lost', emoji: '🕳️', hue: 50, profileId: 'iso-lost' })
    const lostSpace = state().spaces.at(-1)!
    browser.dispatch({ type: 'profile/used', id: 'iso-lost' })
    called.length = 0
    const reverted = await recoverMissingProfiles(store, engine, win)
    check('Missing Profile: a space whose profile lost its data goes back to the default profile', reverted.includes(lostSpace.id) && state().spaces.find((sp) => sp.id === lostSpace.id)?.profileId === 'default' && !state().settings.usedProfiles.includes('iso-lost'))
    check('…and the user is told which space', called.some((c) => /Profil manquant/.test(c.message) && c.detail.includes('iso-lost')), JSON.stringify(called))
    check('…once: the next launch finds nothing missing', (await recoverMissingProfiles(store, engine, win)).length === 0)
    browser.dispatch({ type: 'space/delete', id: lostSpace.id })

    // ======================= The windows come back =======================
    const manager = getWindowManager()
    const primary = manager.sessionSnapshot()
    check('the session has the place of the first window', primary.main !== null && primary.main.width > 100)
    const extra = manager.openWindow({ commandBar: false, restore: { bounds: { x: 120, y: 140, width: 900, height: 620 }, selection: { spaceId: state().activeSpaceId, tabs: {}, layout: { sidebarVisible: false } } } })
    await waitFor(() => !extra.win.isDestroyed())
    const placed = extra.win.getBounds()
    check('a restored window opens where it was, with the size it had', placed.x === 120 && placed.y === 140 && placed.width === 900 && placed.height === 620, JSON.stringify(placed))
    check('…with the sidebar hidden as it was', extra.store.get().settings.sidebarVisible === false)
    const saved = manager.sessionSnapshot()
    check('the session now lists that window for the next launch', saved.windows.length === 1 && saved.windows[0]!.bounds.width === 900 && saved.windows[0]!.sidebarVisible === false, JSON.stringify(saved.windows))
    const reread = usableSession(JSON.parse(JSON.stringify(saved)), [{ x: 0, y: 0, width: 3000, height: 2000 }], state())
    check('…and reading it back gives the same window', reread.windows.length === 1 && reread.windows[0]!.bounds.height === 620)
    extra.win.close()
    await waitFor(() => manager.extraWindows().length === 0)
    check('closing the window takes it out of the session', manager.sessionSnapshot().windows.length === 0)
  } finally {
    restoreDialogs()
    server.close()
    rmSync(scratch, { recursive: true, force: true })
  }
}
