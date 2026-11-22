// Remappable keyboard shortcuts. Accelerators use Electron's syntax ("CmdOrCtrl+Shift+J").

import { canonicalAccelerator as platformAccelerator, defaultAcceleratorFor, formatAcceleratorFor, type PlatformId } from './platform'
import { PAGE_SHORTCUT, PAGE_TOGGLE_SHORTCUT } from './page-annotate'
import { t } from './i18n'

export interface CommandDef {
  id: string
  label: string
  group: string
  /** Default accelerator; '' when nothing is bound by default (the user can still give it one). */
  accelerator: string
  /**
   * A second press that runs the same command, beside the first. For the defaults a French keyboard cannot type as they are written (« [ » is
   * ⌥⇧( and « / » is ⇧:), that macOS keeps for itself (⌃1 … ⌃9 with « Switch to Desktop n » on), or that pages use too (⇧⌘X): letters, arrows
   * and digits under ⌃⌘ or ⌥⌘, which every layout gives, no text field uses and macOS leaves alone. ⌘← and ⌘→ are not taken for
   * « Précédent » and « Suivant »: they move the cursor to the ends of a line in a text field, and the menus answer before the page.
   * The Settings do not move it; `secondAccelerator` says when it is in force.
   */
  second?: string
}

export const COMMANDS: readonly CommandDef[] = [
  // Fichier
  { id: 'newTab', get label() { return t('menu.nouvel-onglet') }, get group() { return t('menu.fichier') }, accelerator: 'CmdOrCtrl+T' },
  { id: 'newWindow', get label() { return t('menu.nouvelle-fenetre') }, get group() { return t('menu.fichier') }, accelerator: 'CmdOrCtrl+N' },
  { id: 'blankWindow', get label() { return t('menu.fenetre-vierge') }, get group() { return t('menu.fichier') }, accelerator: 'Ctrl+CmdOrCtrl+N' },
  { id: 'privateWindow', get label() { return t('menu.nouvelle-fenetre-privee') }, get group() { return t('menu.fichier') }, accelerator: 'CmdOrCtrl+Shift+N' },
  // No default key, the user can give one.
  { id: 'newPrivateTab', get label() { return t('menu.nouvel-onglet-prive') }, get group() { return t('menu.fichier') }, accelerator: '' },
  { id: 'guestWindow', get label() { return t('menu.nouvelle-fenetre-invite') }, get group() { return t('menu.fichier') }, accelerator: '' },
  { id: 'newLittleArc', get label() { return t('menu.nouvelle-mini-fenetre') }, get group() { return t('menu.fichier') }, accelerator: 'CmdOrCtrl+Alt+N' },
  { id: 'restoreClosed', get label() { return t('menu.rouvrir-le-dernier-onglet-ferme') }, get group() { return t('menu.fichier') }, accelerator: 'CmdOrCtrl+Shift+T' },
  { id: 'openLocation', get label() { return t('menu.ouvrir-la-barre-de-commandes') }, get group() { return t('menu.fichier') }, accelerator: 'CmdOrCtrl+L' },
  { id: 'newProfile', get label() { return t('menu.nouveau-profil') }, get group() { return t('menu.fichier') }, accelerator: '' },
  // Entries of the menu bar that show no shortcut: they can still be given one.
  { id: 'importData', get label() { return t('menu.importer-depuis-un-autre-navigateur') }, get group() { return t('menu.fichier') }, accelerator: '' },
  // Sessions of tabs (from Chrome Toolkit): no default key; the user can give one.
  { id: 'sessions', get label() { return t('menu.sessions') }, get group() { return t('menu.fichier') }, accelerator: '' },
  { id: 'saveSession', get label() { return t('menu.enregistrer-la-session') }, get group() { return t('menu.fichier') }, accelerator: '' },
  { id: 'closeWindow', get label() { return t('menu.fermer-la-fenetre') }, get group() { return t('menu.fichier') }, accelerator: 'CmdOrCtrl+Shift+W' },
  { id: 'closeTab', get label() { return t('menu.archiver-l-onglet') }, get group() { return t('menu.fichier') }, accelerator: 'CmdOrCtrl+W' },
  { id: 'savePage', get label() { return t('app.enregistrer-la-page-sous') }, get group() { return t('menu.fichier') }, accelerator: 'CmdOrCtrl+Shift+S' },
  { id: 'savePdfSource', get label() { return t('menu.enregistrer-en-pdf-avec-l-adresse') }, get group() { return t('menu.fichier') }, accelerator: '' },
  { id: 'saveMarkdown', get label() { return t('menu.enregistrer-la-page-en-markdown') }, get group() { return t('menu.fichier') }, accelerator: '' },
  { id: 'exportMarkdown', get label() { return t('menu.exporter-la-page-en-markdown') }, get group() { return t('menu.fichier') }, accelerator: '' },
  { id: 'print', get label() { return t('keybindings.imprimer') }, get group() { return t('menu.fichier') }, accelerator: 'CmdOrCtrl+P' },
  { id: 'captureRegion', get label() { return t('menu.capturer') }, get group() { return t('menu.fichier') }, accelerator: 'CmdOrCtrl+Shift+2' },
  { id: 'captureVisible', get label() { return t('menu.capturer-la-partie-visible') }, get group() { return t('menu.fichier') }, accelerator: 'CmdOrCtrl+Alt+S' },
  { id: 'captureFull', get label() { return t('menu.capturer-la-page-entiere') }, get group() { return t('menu.fichier') }, accelerator: 'CmdOrCtrl+Alt+Shift+S' },
  { id: 'capturePortrait', get label() { return t('menu.capturer-en-mode-portrait') }, get group() { return t('menu.fichier') }, accelerator: '' },
  { id: 'share', get label() { return t('keybindings.partager') }, get group() { return t('menu.fichier') }, accelerator: '' },
  // Web tools (off until switched on in Réglages): no default shortcut, the user can give one.
  { id: 'qrCode', get label() { return t('menu.code-qr-de-cette-page') }, get group() { return t('menu.fichier') }, accelerator: '' },
  { id: 'watchPage', get label() { return t('menu.surveiller-cette-page') }, get group() { return t('menu.fichier') }, accelerator: '' },
  { id: 'translatePage', get label() { return t('translate.title') }, get group() { return t('menu.fichier') }, accelerator: '' },
  // No default shortcut, the user can give one.
  { id: 'readLater', get label() { return t('menu.lire-plus-tard') }, get group() { return t('menu.fichier') }, accelerator: '' },
  { id: 'readLaterList', get label() { return t('menu.liste-de-lecture') }, get group() { return t('menu.fichier') }, accelerator: '' },
  // The password manager (off until switched on in Settings): no default shortcut, the user can give one. Filling happens only when asked.
  { id: 'passwords', get label() { return t('menu.mots-de-passe') }, get group() { return t('menu.fichier') }, accelerator: '' },
  { id: 'fillPassword', get label() { return t('menu.remplir-l-identifiant-et-le-mot-de-passe') }, get group() { return t('menu.fichier') }, accelerator: '' },
  // The library functions (off until switched on in Settings): no default shortcut, the user can give one. ⌘D stays "Épingler l’onglet".
  { id: 'bookmarkAdd', get label() { return t('menu.ajouter-aux-signets') }, get group() { return t('menu.fichier') }, accelerator: '' },
  { id: 'bookmarkList', get label() { return t('menu.signets') }, get group() { return t('menu.fichier') }, accelerator: '' },
  { id: 'openAsApp', get label() { return t('menu.ouvrir-comme-application') }, get group() { return t('menu.fichier') }, accelerator: '' },
  // The quick notes (Réglages › Fichiers et données). ⇧⌘E is free (no command, no menu entry, no system-wide shortcut of the application uses it); the entry is dead while the function is off.
  { id: 'notes', get label() { return t('menu.notes') }, get group() { return t('menu.fichier') }, accelerator: 'CmdOrCtrl+Shift+E' },
  // The panel opened on a new note tied to the page on screen. ⌥⌘E: the letter of the notes, one modifier apart from ⇧⌘E (as ⌥⌘A and ⇧⌘A); every ⌘N
  // is taken (⌘N, ⇧⌘N, ⌥⌘N, ⌃⌘N are windows), no command, menu entry or system-wide shortcut of the application uses it, and macOS gives it to nothing.
  // Elsewhere it would read Ctrl+Alt+E, the AltGr key that types € (platform.ts gives it no default there). Dead while the function is off.
  { id: 'newNote', get label() { return t('menu.nouvelle-note') }, get group() { return t('menu.fichier') }, accelerator: 'CmdOrCtrl+Alt+E' },
  // Édition
  { id: 'copyUrl', get label() { return t('toolbar.copier-l-adresse') }, get group() { return t('menu.edition') }, accelerator: 'CmdOrCtrl+Shift+C' },
  { id: 'copyUrlMarkdown', get label() { return t('menu.copier-l-adresse-en-markdown') }, get group() { return t('menu.edition') }, accelerator: 'CmdOrCtrl+Alt+Shift+C' },
  { id: 'copyUrlQuote', get label() { return t('menu.copier-l-adresse-en-citation') }, get group() { return t('menu.edition') }, accelerator: 'Ctrl+CmdOrCtrl+Shift+C' },
  { id: 'find', get label() { return t('cmd.rechercher-dans-la-page') }, get group() { return t('menu.edition') }, accelerator: 'CmdOrCtrl+F' },
  { id: 'findNext', get label() { return t('menu.occurrence-suivante') }, get group() { return t('menu.edition') }, accelerator: 'CmdOrCtrl+G' },
  { id: 'findPrevious', get label() { return t('menu.occurrence-precedente') }, get group() { return t('menu.edition') }, accelerator: 'CmdOrCtrl+Shift+G' },
  { id: 'findReplace', get label() { return t('menu.trouver-et-remplacer') }, get group() { return t('menu.edition') }, accelerator: 'CmdOrCtrl+Alt+F' },
  { id: 'useSelectionToFind', get label() { return t('menu.utiliser-la-selection-pour-rechercher') }, get group() { return t('menu.edition') }, accelerator: '' },
  { id: 'jumpToSelection', get label() { return t('menu.aller-a-la-selection') }, get group() { return t('menu.edition') }, accelerator: 'CmdOrCtrl+J' },
  // Affichage
  { id: 'toggleSidebar', get label() { return t('keybindings.masquer-afficher-la-barre-laterale') }, get group() { return t('menu.affichage') }, accelerator: 'CmdOrCtrl+S' },
  // The sidebar of this window docked to a column of icons, or the full one back (window-sidebar.ts). ⌃⌘S: ⌘S is the sidebar shown or hidden, ⇧⌘S
  // « Enregistrer la page sous… », ⌥⌘S a capture; ⌃⌘S no command, menu entry or system-wide shortcut of the application takes.
  { id: 'dockSidebar', get label() { return t('keybindings.replier-ou-deplier-la-barre-laterale') }, get group() { return t('menu.affichage') }, accelerator: 'Ctrl+CmdOrCtrl+S' },
  { id: 'toggleToolbar', get label() { return t('keybindings.masquer-afficher-la-barre-d-outils') }, get group() { return t('menu.affichage') }, accelerator: 'CmdOrCtrl+Shift+D' },
  // The setting « Mode compact »: no default shortcut, the user can give one.
  { id: 'toggleCompact', get label() { return t('keybindings.passer-en-mode-compact-le-quitter') }, get group() { return t('menu.affichage') }, accelerator: '' },
  { id: 'stop', get label() { return t('menu.arreter-le-chargement') }, get group() { return t('menu.affichage') }, accelerator: 'CmdOrCtrl+;' },
  { id: 'reload', get label() { return t('toolbar.actualiser-la-page') }, get group() { return t('menu.affichage') }, accelerator: 'CmdOrCtrl+R' },
  { id: 'hardReload', get label() { return t('menu.actualisation-forcee') }, get group() { return t('menu.affichage') }, accelerator: 'CmdOrCtrl+Shift+R' },
  // No default shortcut, the user can give one.
  { id: 'reloadAll', get label() { return t('sidebar.actualiser-tous-les-onglets') }, get group() { return t('menu.affichage') }, accelerator: '' },
  { id: 'zoomReset', get label() { return t('menu.taille-reelle') }, get group() { return t('menu.affichage') }, accelerator: 'CmdOrCtrl+0' },
  { id: 'zoomIn', get label() { return t('menu.zoom-avant') }, get group() { return t('menu.affichage') }, accelerator: 'CmdOrCtrl+Plus' },
  { id: 'zoomOut', get label() { return t('menu.zoom-arriere') }, get group() { return t('menu.affichage') }, accelerator: 'CmdOrCtrl+-' },
  { id: 'readerMode', get label() { return t('menu.mode-lecture') }, get group() { return t('menu.affichage') }, accelerator: '' },
  { id: 'collapsePinned', get label() { return t('menu.replier-les-dossiers-epingles') }, get group() { return t('menu.affichage') }, accelerator: '' },
  { id: 'clearCookies', get label() { return t('menu.effacer-les-cookies-et-actualiser') }, get group() { return t('menu.affichage') }, accelerator: '' },
  { id: 'clearCache', get label() { return t('menu.effacer-le-cache-et-actualiser') }, get group() { return t('menu.affichage') }, accelerator: '' },
  { id: 'addSplit', get label() { return t('toolbar.ajouter-une-vue-scindee') }, get group() { return t('menu.affichage') }, accelerator: 'Ctrl+Shift+=' },
  { id: 'closeSplitPane', get label() { return t('menu.fermer-ce-volet-scinde') }, get group() { return t('menu.affichage') }, accelerator: 'Ctrl+Shift+-' },
  { id: 'separateSplit', get label() { return t('menu.separer-la-page-de-la-vue-scindee') }, get group() { return t('menu.affichage') }, accelerator: '' },
  { id: 'expandSplit', get label() { return t('menu.agrandir-la-vue-scindee-actuelle') }, get group() { return t('menu.affichage') }, accelerator: '' },
  { id: 'scrollSync', get label() { return t('menu.defilement-synchronise-des-volets') }, get group() { return t('menu.affichage') }, accelerator: '' },
  { id: 'batterySaver', get label() { return t('menu.mode-economie-de-batterie') }, get group() { return t('menu.affichage') }, accelerator: '' },
  { id: 'viewSource', get label() { return t('menu.afficher-la-source') }, get group() { return t('menu.affichage') }, accelerator: 'CmdOrCtrl+Alt+U' },
  { id: 'devTools', get label() { return t('menu.outils-de-developpement') }, get group() { return t('menu.affichage') }, accelerator: 'CmdOrCtrl+Alt+I' },
  { id: 'inspectElement', get label() { return t('menu.inspecter-les-elements') }, get group() { return t('menu.affichage') }, accelerator: 'CmdOrCtrl+Alt+C' },
  { id: 'jsConsole', get label() { return t('menu.console-javascript') }, get group() { return t('menu.affichage') }, accelerator: 'CmdOrCtrl+Alt+J' },
  { id: 'networkInspector', get label() { return t('menu.inspecteur-reseau') }, get group() { return t('menu.affichage') }, accelerator: '' },
  { id: 'developerMode', get label() { return t('keybindings.mode-developpeur-pour-ce-site') }, get group() { return t('menu.affichage') }, accelerator: 'Ctrl+D' },
  { id: 'fullscreen', get label() { return t('menu.activer-le-mode-plein-ecran') }, get group() { return t('menu.affichage') }, accelerator: 'Ctrl+CmdOrCtrl+F' },
  // Espaces
  { id: 'nextSpace', get label() { return t('menu.espace-suivant') }, get group() { return t('menu.espaces') }, accelerator: 'CmdOrCtrl+Alt+Right' },
  { id: 'previousSpace', get label() { return t('menu.espace-precedent') }, get group() { return t('menu.espaces') }, accelerator: 'CmdOrCtrl+Alt+Left' },
  { id: 'newSpace', get label() { return t('cmd.nouvel-espace') }, get group() { return t('menu.espaces') }, accelerator: '' },
  { id: 'editTheme', get label() { return t('keybindings.modifier-le-theme') }, get group() { return t('menu.espaces') }, accelerator: '' },
  { id: 'renameSpace', get label() { return t('menu.renommer-l-espace') }, get group() { return t('menu.espaces') }, accelerator: '' },
  { id: 'manageSpaces', get label() { return t('manage-panels.gerer-les-espaces') }, get group() { return t('menu.espaces') }, accelerator: '' },
  // No default shortcut, the user can give one.
  { id: 'asideSpace', get label() { return t('menu.mettre-l-espace-de-cote') }, get group() { return t('menu.espaces') }, accelerator: '' },
  // No default shortcut, the user can give one. In the menu while the lock is on.
  { id: 'lockNow', get label() { return t('menu.verrouiller-maintenant') }, get group() { return t('menu.espaces') }, accelerator: '' },
  ...Array.from({ length: 9 }, (_, i): CommandDef => ({ id: `space${i + 1}`, get label() { return t('keybindings.aller-a-l-espace-n', { n: i + 1 }) }, get group() { return t('menu.espaces') }, accelerator: `Ctrl+${i + 1}`, second: `Ctrl+CmdOrCtrl+${i + 1}` })),
  // Onglets
  { id: 'pin', get label() { return t('keybindings.epingler-desepingler-l-onglet') }, get group() { return t('settings.onglets') }, accelerator: 'CmdOrCtrl+D' },
  // The command bar in "Onglets" mode, over the tabs of every space. ⇧⌘A is free (the archive is ⌥⌘A); the entry is dead while the function is off.
  { id: 'tabSearch', get label() { return t('menu.rechercher-un-onglet') }, get group() { return t('settings.onglets') }, accelerator: 'CmdOrCtrl+Shift+A' },
  // The overview of the open tabs as a grid of thumbnails (setting `tabGrid`, off by default). ⇧⌘O is free; the entry is dead while the function is off.
  { id: 'tabGrid', get label() { return t('menu.vue-d-ensemble-des-onglets') }, get group() { return t('settings.onglets') }, accelerator: 'CmdOrCtrl+Shift+O' },
  { id: 'nextTab', get label() { return t('menu.onglet-suivant') }, get group() { return t('settings.onglets') }, accelerator: 'CmdOrCtrl+Alt+Down' },
  { id: 'previousTab', get label() { return t('menu.onglet-precedent') }, get group() { return t('settings.onglets') }, accelerator: 'CmdOrCtrl+Alt+Up' },
  // ⌃Tab goes through the tabs in the order they were used, with a panel of pictures while ⌃ is held (Settings › Raccourcis can turn it off).
  { id: 'recentTab', get label() { return t('keybindings.onglet-suivant-utilisation-recente') }, get group() { return t('settings.onglets') }, accelerator: 'Ctrl+Tab' },
  { id: 'recentTabBack', get label() { return t('keybindings.onglet-precedent-utilisation-recente') }, get group() { return t('settings.onglets') }, accelerator: 'Ctrl+Shift+Tab' },
  { id: 'newFolder', get label() { return t('menu.nouveau-dossier-2') }, get group() { return t('settings.onglets') }, accelerator: '' },
  { id: 'newLiveFolder', get label() { return t('menu.nouveau-dossier-en-direct') }, get group() { return t('settings.onglets') }, accelerator: '' },
  { id: 'revealTab', get label() { return t('menu.reveler-l-onglet-dans-la-barre-laterale') }, get group() { return t('settings.onglets') }, accelerator: '' },
  { id: 'clearToday', get label() { return t('menu.vider-les-onglets-du-jour') }, get group() { return t('settings.onglets') }, accelerator: 'CmdOrCtrl+Shift+K' },
  { id: 'resetPinned', get label() { return t('keybindings.reinitialiser-les-onglets-epingles-de-cet-espace') }, get group() { return t('settings.onglets') }, accelerator: '' },
  // These are in the menu of a tab, not in the menu bar: no default shortcut, the user can give one.
  { id: 'duplicateTab', get label() { return t('menu.dupliquer-l-onglet') }, get group() { return t('settings.onglets') }, accelerator: '' },
  { id: 'muteTab', get label() { return t('keybindings.couper-retablir-le-son-de-l-onglet') }, get group() { return t('settings.onglets') }, accelerator: '' },
  { id: 'toggleFolder', get label() { return t('keybindings.replier-deplier-le-dossier-de-l-onglet') }, get group() { return t('settings.onglets') }, accelerator: '' },
  // The setting « Arbre d’onglets »: no default shortcut, the user can give one.
  { id: 'toggleTabBranch', get label() { return t('keybindings.replier-deplier-les-onglets-enfants') }, get group() { return t('settings.onglets') }, accelerator: '' },
  { id: 'detachTab', get label() { return t('menu.sortir-l-onglet-de-son-parent') }, get group() { return t('settings.onglets') }, accelerator: '' },
  { id: 'moveTabNextSpace', get label() { return t('menu.deplacer-l-onglet-vers-l-espace-suivant') }, get group() { return t('settings.onglets') }, accelerator: '' },
  { id: 'moveTabPreviousSpace', get label() { return t('menu.deplacer-l-onglet-vers-l-espace-precedent') }, get group() { return t('settings.onglets') }, accelerator: '' },
  // The tab on screen one place up or down its group, as "Déplacer vers le haut / le bas" in its menu (tab-step.ts). Not ⌥↑ / ⌥↓: a key of the
  // menu bar is taken before the page sees it (settings-window.ts), and those keys are the text's (a paragraph, a line in a web code editor) and the
  // list of Gérer les espaces' own. ⌥⌘↑ / ⌥⌘↓ go from tab to tab: with ⇧, the tab goes along. A focused row of the sidebar takes ⌥↑ / ⌥↓ (SidebarRows.tsx).
  { id: 'moveTabUp', get label() { return t('menu.deplacer-l-onglet-vers-le-haut') }, get group() { return t('settings.onglets') }, accelerator: 'CmdOrCtrl+Alt+Shift+Up' },
  { id: 'moveTabDown', get label() { return t('menu.deplacer-l-onglet-vers-le-bas') }, get group() { return t('settings.onglets') }, accelerator: 'CmdOrCtrl+Alt+Shift+Down' },
  ...Array.from({ length: 9 }, (_, i): CommandDef => ({ id: `item${i + 1}`, get label() { return t('menu.go-to-item', { n: i + 1 }) }, get group() { return t('settings.onglets') }, accelerator: `CmdOrCtrl+${i + 1}` })),
  // Archive
  { id: 'back', get label() { return t('toolbar.page-precedente') }, get group() { return t('menu.archive') }, accelerator: 'CmdOrCtrl+[', second: 'Ctrl+CmdOrCtrl+Left' },
  { id: 'forward', get label() { return t('toolbar.page-suivante') }, get group() { return t('menu.archive') }, accelerator: 'CmdOrCtrl+]', second: 'Ctrl+CmdOrCtrl+Right' },
  { id: 'history', get label() { return t('menu.afficher-l-historique') }, get group() { return t('menu.archive') }, accelerator: 'CmdOrCtrl+Y' },
  { id: 'archive', get label() { return t('keybindings.afficher-l-archive') }, get group() { return t('menu.archive') }, accelerator: 'CmdOrCtrl+Alt+A' },
  { id: 'clearArchive', get label() { return t('menu.vider-l-archive') }, get group() { return t('menu.archive') }, accelerator: '' },
  { id: 'clearHistory', get label() { return t('menu.effacer-l-historique-de-navigation') }, get group() { return t('menu.archive') }, accelerator: '' },
  // Fenêtre et site
  { id: 'settings', get label() { return t('settings.reglages') }, get group() { return t('menu.fenetre') }, accelerator: 'CmdOrCtrl+,' },
  { id: 'downloads', get label() { return t('sidebar.telechargements') }, get group() { return t('menu.fenetre') }, accelerator: 'CmdOrCtrl+Shift+J' },
  // No default shortcut, the user can give one.
  { id: 'nameWindow', get label() { return t('menu.nommer-la-fenetre') }, get group() { return t('menu.fenetre') }, accelerator: '' },
  { id: 'taskManager', get label() { return t('menu.ouvrir-le-gestionnaire-de-taches') }, get group() { return t('menu.fenetre') }, accelerator: '' },
  // The sheet of the shortcuts by context. ⌘/ is free; the entry is dead while the function is off.
  { id: 'shortcutHelp', get label() { return t('menu.aide-des-raccourcis') }, get group() { return t('menu.fenetre') }, accelerator: 'CmdOrCtrl+/', second: 'CmdOrCtrl+Alt+K' },
  { id: 'addExtension', get label() { return t('menu.ajouter-une-extension') }, get group() { return t('settings.extensions') }, accelerator: '' },
  { id: 'manageExtensions', get label() { return t('menu.gerer-les-extensions') }, get group() { return t('settings.extensions') }, accelerator: '' },
  // ⇧⌘I, not ⌘I: a registered ⌘I was taken before the page, so a web editor (Docs, Gmail, Notion) lost its
  // italics, and Édition › Format shows ⌘I for « Italique ».
  { id: 'siteInfo', get label() { return t('toolbar.infos-et-reglages-du-site') }, get group() { return t('settings.site') }, accelerator: 'CmdOrCtrl+Shift+I' },
  { id: 'boost', get label() { return t('keybindings.retoucher-ce-site') }, get group() { return t('settings.site') }, accelerator: 'CmdOrCtrl+Shift+B' },
  // The shortcut of the "Clear Domain Data" extension this comes from; nothing else uses it.
  { id: 'clearSiteData', get label() { return t('menu.effacer-les-donnees-du-site') }, get group() { return t('settings.site') }, accelerator: 'CmdOrCtrl+Shift+X', second: 'Ctrl+CmdOrCtrl+X' },
  // What that shortcut does in the extension itself: no panel, the site of the page is cleared with the remembered choices, then a notice.
  { id: 'clearSiteDataNow', get label() { return t('menu.effacer-les-donnees-du-site-maintenant') }, get group() { return t('settings.site') }, accelerator: 'CmdOrCtrl+Alt+Shift+X' },
  // No default key, the user can give one.
  { id: 'cookieManager', get label() { return t('menu.cookies-par-site') }, get group() { return t('settings.site') }, accelerator: '' }
]

/** Overrides by command id: an accelerator, or '' to disable the shortcut. */
export type KeyBindings = Record<string, string>

const MODIFIER = /^(CmdOrCtrl|Cmd|Ctrl|Alt|Shift)$/
const KEY = /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Up|Down|Left|Right|PageUp|PageDown|Space|Return|Tab|Backspace|Delete|Plus|[,./\[\]\\=\-;'`])$/

/** An accelerator Electron will accept, with at least one real modifier (Shift alone is not enough) unless it is a function key. */
export function isValidAccelerator(accelerator: string): boolean {
  const parts = accelerator.split('+')
  // "Cmd++" style (the key is "+") is not supported: refuse an empty part.
  if (parts.some((p) => p === '')) return false
  const key = parts.at(-1)!
  const modifiers = parts.slice(0, -1)
  if (!KEY.test(key) || !modifiers.every((m) => MODIFIER.test(m)) || new Set(modifiers).size !== modifiers.length) return false
  return /^F\d+$/.test(key) || modifiers.some((m) => m !== 'Shift')
}

/** Drops unknown commands and unusable accelerators from saved bindings. */
export function cleanBindings(bindings: KeyBindings | undefined): KeyBindings {
  const known = new Set(COMMANDS.map((c) => c.id))
  return Object.fromEntries(
    Object.entries(bindings ?? {}).filter(([id, accelerator]) => known.has(id) && typeof accelerator === 'string' && (accelerator === '' || isValidAccelerator(accelerator)))
  )
}

/** The accelerator in force for a command, or undefined when the user disabled it. Without a platform the defaults are those of macOS. */
export function effectiveAccelerator(id: string, bindings: KeyBindings | undefined, platform?: PlatformId): string | undefined {
  const override = bindings?.[id]
  if (override !== undefined) return override === '' ? undefined : override
  const standard = COMMANDS.find((c) => c.id === id)?.accelerator ?? ''
  return (platform ? defaultAcceleratorFor(platform, id, standard) : standard) || undefined
}

/**
 * The second press of a command (`CommandDef.second`), or undefined when it has none in force: the user switched the command off, another
 * command holds that press (a shortcut the user gives always wins, and a press never runs two commands), or the system is not macOS, whose
 * defaults the second presses were chosen against.
 */
export function secondAccelerator(id: string, bindings: KeyBindings | undefined, platform: PlatformId = 'darwin'): string | undefined {
  const second = COMMANDS.find((c) => c.id === id)?.second
  if (!second || platform !== 'darwin' || bindings?.[id] === '') return undefined
  const held = COMMANDS.some((c) => {
    const accelerator = effectiveAccelerator(c.id, bindings)
    return accelerator !== undefined && samePress(accelerator, second)
  })
  return held ? undefined : second
}

export interface KeyEventLike {
  code: string
  /** The character the press gives on the keyboard layout in use (`KeyboardEvent.key`). Absent, the press is read by the position of its key. */
  key?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** The character a key gives with no modifier held, on the layout in use (`KeyQ` gives « a » on a French keyboard). */
export type KeyLayout = (code: string) => string | undefined

/** The most keys a layout is read for, and the longest character of one: what the interface sends is not taken as it comes. */
const LAYOUT_KEYS_MAX = 160
const LAYOUT_CODE = /^[A-Za-z0-9]{1,24}$/
const LAYOUT_CHARACTER_MAX = 4

/**
 * The keyboard layout as the interface sends it to the shell (the shell cannot read it itself): the character of each key, by its `code`.
 * Null when it is not one; an entry that is not a key and a character is left out.
 */
export function parseKeyLayout(raw: unknown): Record<string, string> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length === 0 || entries.length > LAYOUT_KEYS_MAX) return null
  const kept = entries.filter((entry): entry is [string, string] => LAYOUT_CODE.test(entry[0]) && typeof entry[1] === 'string' && entry[1] !== '' && [...entry[1]].length <= LAYOUT_CHARACTER_MAX)
  return kept.length > 0 ? Object.fromEntries(kept) : null
}

/** A layout that was read, as `pressedKey` asks it. */
export function keyLayoutOf(characters: Readonly<Record<string, string>>): KeyLayout {
  return (code) => (Object.hasOwn(characters, code) ? characters[code] : undefined)
}

/** The keys that are the same on every layout. */
const FIXED_KEYS: Record<string, string> = {
  Space: 'Space', Enter: 'Return', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', PageUp: 'PageUp', PageDown: 'PageDown'
}

/** The punctuation of a key by its position, as a US keyboard has it: read only when nothing says what the key gives. */
const PUNCTUATION_BY_POSITION: Record<string, string> = {
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Semicolon: ';', Quote: "'", Backquote: '`'
}

/** The characters an accelerator can name. */
const CHARACTER = /^[A-Z0-9,./\[\]\\=\-;'`]$/

/**
 * The key of a press, as an accelerator names it. The menus pair a shortcut with the character typed, not with the place of the key: on a
 * French keyboard the key marked A sits where a US keyboard has Q (`code` is `KeyQ`), so the letter is the one the layout gives.
 *  - A letter typed is that letter.
 *  - Otherwise the character the key gives without a modifier: Option turns A into « æ » and Shift turns « ; » into « . », so the press itself
 *    only says it when neither is held; the layout says it in every case.
 *  - A digit key that gives no digit alone (« & », « é »… on a French keyboard) is its digit, and a letter key of another script is the letter
 *    of its place: the system pairs these the same way.
 *  - A punctuation key whose character no accelerator can name (« ù », « $ », a dead « ^ ») makes no shortcut, rather than the shortcut of
 *    another key.
 */
function pressedKey(e: KeyEventLike, layout?: KeyLayout): string | undefined {
  if (/^F\d+$/.test(e.code)) return e.code
  const fixed = FIXED_KEYS[e.code]
  if (fixed) return fixed
  const typed = (e.key ?? '').toUpperCase()
  if (/^[A-Z]$/.test(typed)) return typed
  const dead = e.key === 'Dead'
  const plain = layout?.(e.code) || (e.altKey || e.shiftKey || dead || [...(e.key ?? '')].length !== 1 ? undefined : e.key)
  const character = plain?.toUpperCase()
  if (character !== undefined && CHARACTER.test(character)) return character
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5)
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3)
  if (character !== undefined || dead) return undefined
  return PUNCTUATION_BY_POSITION[e.code]
}

/**
 * Turns a key press into an accelerator, or null when it is not a usable shortcut (a lone modifier, no modifier…). Where the Command key does
 * not exist, Ctrl is the command key (it reads `CmdOrCtrl`, as the defaults do) and the Windows key makes no shortcut. The key is the one the
 * keyboard layout gives (see `pressedKey`); `layout` says it when a modifier hides it.
 */
export function acceleratorFromKeyEvent(e: KeyEventLike, platform: PlatformId = 'darwin', layout?: KeyLayout): string | null {
  const key = pressedKey(e, layout)
  if (!key) return null
  if (platform !== 'darwin' && e.metaKey) return null
  const modifiers = (
    platform === 'darwin'
      ? [e.metaKey ? 'CmdOrCtrl' : '', e.ctrlKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '']
      : [e.ctrlKey ? 'CmdOrCtrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '']
  ).filter(Boolean)
  const accelerator = [...modifiers, key].join('+')
  return isValidAccelerator(accelerator) ? accelerator : null
}

/**
 * The physical key of a press, for the keys that are the same on every layout. Electron gives `code`; an event that was made rather than typed (the
 * engine test sends keys to the pages) may only carry the character, so the keys a switcher reads are recognised by it too.
 */
export function physicalKey(input: { code: string; key: string }): string {
  if (input.code) return input.code
  return input.key === 'Tab' || input.key === 'Escape' ? input.key : ''
}

/** The same accelerator, whatever the order its modifiers are written in. */
export function sameAccelerator(a: string, b: string): boolean {
  const parts = (accelerator: string) => accelerator.split('+').map((p) => p.toLowerCase()).sort().join('+')
  return parts(a) === parts(b)
}

/**
 * Whether a key press is exactly this accelerator (the modifiers pressed are the ones it names, no more). `layout` names the key when Option
 * hides its letter (⌥A gives « æ »): without it such a press is read by the place of its key.
 */
export function acceleratorMatches(accelerator: string | undefined, e: KeyEventLike, layout?: KeyLayout): boolean {
  if (!accelerator) return false
  const pressed = acceleratorFromKeyEvent(e, 'darwin', layout)
  return pressed !== null && sameAccelerator(pressed, accelerator)
}

/** The modifiers an accelerator needs held down besides Shift: a switcher that stays open lasts as long as these are held. */
export function heldModifiers(accelerator: string): Array<'control' | 'alt' | 'meta'> {
  const parts = accelerator.split('+')
  const held: Array<'control' | 'alt' | 'meta'> = []
  if (parts.includes('Ctrl')) held.push('control')
  if (parts.includes('Alt')) held.push('alt')
  if (parts.includes('CmdOrCtrl') || parts.includes('Cmd')) held.push('meta')
  return held
}

const MODIFIER_ORDER = ['cmdorctrl', 'cmd', 'ctrl', 'alt', 'shift']

/**
 * One spelling for the shortcuts that are the same press: the modifiers in the order of `acceleratorFromKeyEvent` (the order a recorded shortcut has), whatever
 * order they were written in. The defaults are not all written that way (`Ctrl+CmdOrCtrl+N`), and a shortcut recorded as ⌃⌘N is `CmdOrCtrl+Ctrl+N`.
 */
export function canonicalAccelerator(accelerator: string): string {
  const parts = accelerator.split('+')
  const key = parts.pop() ?? ''
  const rank = (modifier: string): number => MODIFIER_ORDER.indexOf(modifier.toLowerCase())
  const modifiers = parts.sort((a, b) => rank(a) - rank(b))
  // The spelling of the modifiers is the one the shortcut was written with (CmdOrCtrl, Ctrl, Alt, Shift), only their order is settled.
  return [...modifiers, key].join('+')
}

/** Accelerators bound to more than one command (after overrides), by `canonicalAccelerator`: two spellings of one press clash. */
export function findConflicts(bindings: KeyBindings | undefined): Record<string, string[]> {
  const byAccelerator = new Map<string, string[]>()
  for (const { id } of COMMANDS) {
    const accelerator = effectiveAccelerator(id, bindings)
    if (!accelerator) continue
    const canonical = canonicalAccelerator(accelerator)
    byAccelerator.set(canonical, [...(byAccelerator.get(canonical) ?? []), id])
  }
  return Object.fromEntries([...byAccelerator].filter(([, ids]) => ids.length > 1))
}

const MAC_MODIFIER: Record<string, string> = { cmdorctrl: 'cmd', commandorcontrol: 'cmd', cmd: 'cmd', command: 'cmd', meta: 'cmd', super: 'cmd', ctrl: 'ctrl', control: 'ctrl', macctrl: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift' }

/** One name for the press an accelerator stands for on macOS, however its modifiers are spelled and ordered ("Command+Shift+9" and "Shift+CmdOrCtrl+9" are one press). */
export function macPress(accelerator: string): string {
  const parts = accelerator.split('+').map((part) => part.trim().toLowerCase())
  const key = parts.pop() ?? ''
  return [...parts.map((modifier) => MAC_MODIFIER[modifier] ?? modifier).sort(), key].join('+')
}

/** A shortcut an extension suggests for one of its commands (chrome.commands). */
export interface SuggestedShortcut {
  extensionId: string
  name: string
  accelerator: string | null
}

/**
 * The shortcuts of extensions that are already taken, as `extensionId:name`: by a command of Lucium (after the overrides of the user), or by another
 * extension command that comes first (by extension id, then by name, so that the menu and the Extensions page agree whatever order they list them in).
 * Such a shortcut gets no key in the menu: on macOS the first menu item that holds a key receives it, so the extension would show a key it never hears.
 */
export function takenExtensionShortcuts(shortcuts: readonly SuggestedShortcut[], bindings: KeyBindings | undefined): Set<string> {
  const held = new Set<string>()
  for (const { id } of COMMANDS) {
    const accelerator = effectiveAccelerator(id, bindings)
    if (accelerator) held.add(macPress(accelerator))
    const second = secondAccelerator(id, bindings)
    if (second) held.add(macPress(second))
  }
  const keyOf = (shortcut: SuggestedShortcut): string => `${shortcut.extensionId}:${shortcut.name}`
  const taken = new Set<string>()
  for (const shortcut of [...shortcuts].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))) {
    // `_execute_action` and its kin are not commands of the menu: they hold no key and lose none.
    if (shortcut.accelerator === null || shortcut.name.startsWith('_execute_')) continue
    const press = macPress(shortcut.accelerator)
    if (held.has(press)) taken.add(keyOf(shortcut))
    else held.add(press)
  }
  return taken
}

/** A shortcut held by something that is not a command of the table: an entry of the menus that keeps its key, a shortcut of an extension. */
export interface TakenShortcut {
  accelerator: string
  /** Who holds it, as a sentence names it. */
  label: string
}

export interface FixedShortcut extends TakenShortcut {
  /** The role of the menu entry that carries it (the system gives the role its key); absent for an entry that names its own accelerator. */
  role?: string
}

/**
 * The shortcuts of the menus that the Settings do not move: the roles the system gives a key to, « Annuler », and the two keys of the
 * annotation. A command given one of them would share it with an entry that cannot let go of it, and which of the two answers is not
 * settled: the Settings refuse it. shell/menu-fixed-shortcuts.test.ts keeps this list in step with the menus.
 */
export const FIXED_SHORTCUTS: readonly FixedShortcut[] = [
  { role: 'quit', accelerator: 'CmdOrCtrl+Q', get label() { return t('menu.quitter-lucium') } },
  { role: 'hide', accelerator: 'CmdOrCtrl+H', get label() { return t('menu.masquer-lucium') } },
  { role: 'hideOthers', accelerator: 'CmdOrCtrl+Alt+H', get label() { return t('menu.masquer-les-autres') } },
  { role: 'minimize', accelerator: 'CmdOrCtrl+M', get label() { return t('menu.reduire') } },
  { accelerator: 'CmdOrCtrl+Z', get label() { return t('menu.annuler') } },
  { role: 'redo', accelerator: 'CmdOrCtrl+Shift+Z', get label() { return t('menu.retablir') } },
  { role: 'cut', accelerator: 'CmdOrCtrl+X', get label() { return t('menu.couper') } },
  { role: 'copy', accelerator: 'CmdOrCtrl+C', get label() { return t('menu.copier') } },
  { role: 'paste', accelerator: 'CmdOrCtrl+V', get label() { return t('menu.coller') } },
  { role: 'pasteAndMatchStyle', accelerator: 'CmdOrCtrl+Alt+Shift+V', get label() { return t('menu.coller-et-adapter-le-style') } },
  { role: 'selectAll', accelerator: 'CmdOrCtrl+A', get label() { return t('menu.tout-selectionner') } },
  { accelerator: PAGE_TOGGLE_SHORTCUT, get label() { return t('menu.annoter-cette-page') } },
  { accelerator: PAGE_SHORTCUT, get label() { return t('settings-shortcuts.dessin-ou-passage') } }
]

const MODIFIER_NAMES: Record<string, string> = {
  cmdorctrl: 'CmdOrCtrl', commandorcontrol: 'CmdOrCtrl', cmd: 'Cmd', command: 'Cmd', ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift'
}

/**
 * Whether two accelerators are the same press, whatever the order and the spelling of their modifiers (`Cmd+Shift+Y`, as an extension has
 * it, is `CmdOrCtrl+Shift+Y` on macOS).
 */
export function samePress(a: string, b: string, platform: PlatformId = 'darwin'): boolean {
  const press = (accelerator: string): string | null => {
    const parts = accelerator.split('+')
    const key = parts.pop() ?? ''
    const spelled = [...parts.map((part) => MODIFIER_NAMES[part.toLowerCase()] ?? part), key].join('+')
    return platformAccelerator(spelled, platform)?.toLowerCase() ?? null
  }
  const first = press(a)
  return first !== null && first === press(b)
}

/** Who else holds this press, among `taken`; undefined when no one does. */
export function takenBy(accelerator: string | undefined, taken: readonly TakenShortcut[], platform: PlatformId = 'darwin'): TakenShortcut | undefined {
  if (!accelerator) return undefined
  return taken.find((other) => samePress(other.accelerator, accelerator, platform))
}

/** An extension as its shortcuts are read: its name and the commands of its manifest (see `readCommands`). */
export interface ExtensionShortcuts {
  id: string
  name: string
  commands?: ReadonlyArray<{ name: string; description: string; accelerator: string | null }>
}

/** A command of an extension that the menu gives a key to. */
export interface ExtensionMenuCommand extends TakenShortcut {
  extensionId: string
  name: string
}

/**
 * The only shape of a key the menu takes from an extension: the modifiers and one key, as `parseSuggestedKey` writes them. The words come from a
 * manifest, and the menu of the application is built with them: anything else gets no entry, whatever the reader of the manifest let through.
 */
const EXTENSION_ACCELERATOR = /^(?:(?:Ctrl|Alt|Shift|Cmd)\+){0,4}(?:[A-Z0-9,.]|F(?:[1-9]|1[0-2])|Space|Home|End|PageUp|PageDown|Insert|Delete|Up|Down|Left|Right)$/

/**
 * The commands of an extension that get an entry and a key in the Extensions menu: the ones with a shortcut, except the ones that only open
 * its button (`_execute_action`…). The menu and the Settings read the same list, so that a key the menu holds is a key the Settings know.
 */
export function extensionMenuCommands(extension: ExtensionShortcuts): ExtensionMenuCommand[] {
  return (extension.commands ?? [])
    .filter((command) => command.accelerator !== null && EXTENSION_ACCELERATOR.test(command.accelerator) && !command.name.startsWith('_execute_'))
    .map((command) => ({ extensionId: extension.id, name: command.name, accelerator: command.accelerator!, label: `${command.description || command.name} (${extension.name})` }))
}

/**
 * Who else uses a press that a default shortcut takes:
 *  - `page`: editors and sites give it a meaning of their own (strike through, justify, comment a line, indent…), and the menus answer first;
 *  - `macos`: the system gives it to another command in every application (save, check the spelling, delete the next character);
 *  - `mission-control`: the system keeps it for itself when « Switch to Desktop n » is on, and the application never sees it.
 */
export type OtherUse = 'page' | 'macos' | 'mission-control'

const OTHER_USES: ReadonlyArray<{ use: OtherUse; accelerators: readonly string[] }> = [
  {
    use: 'page',
    accelerators: [
      'CmdOrCtrl+Shift+X', 'CmdOrCtrl+Shift+J', 'CmdOrCtrl+Shift+E', 'CmdOrCtrl+Shift+C', 'CmdOrCtrl+Alt+C', 'CmdOrCtrl+Shift+K',
      'CmdOrCtrl+/', 'CmdOrCtrl+[', 'CmdOrCtrl+]', 'CmdOrCtrl+J', 'CmdOrCtrl+D', 'CmdOrCtrl+Y', 'CmdOrCtrl+G'
    ]
  },
  { use: 'macos', accelerators: ['CmdOrCtrl+S', 'CmdOrCtrl+;', 'Ctrl+D'] },
  { use: 'mission-control', accelerators: Array.from({ length: 9 }, (_, i) => `Ctrl+${i + 1}`) }
]

/** Who else uses this press, when it is one of the known ones (see `OtherUse`); undefined for a press that is the application's alone. */
export function otherUseOf(accelerator: string | undefined): OtherUse | undefined {
  if (!accelerator) return undefined
  return OTHER_USES.find((entry) => entry.accelerators.some((other) => samePress(other, accelerator)))?.use
}

/** The punctuation an accelerator can name: on a keyboard that does not give it alone, the shortcut asks for more keys than it shows. */
const PUNCTUATION = /^[,./\[\]\\=\-;'`]$/

/**
 * The key of a shortcut that the keyboard in use does not give alone, or undefined when it does (or when the layout is not known). On a
 * French keyboard « [ » is ⌥⇧( and « / » is ⇧: , so ⌘[ and ⌘/ cannot be pressed as they are written. Digits are left out: the system pairs
 * a digit key with its digit whatever the key gives alone.
 */
export function keyOffLayout(accelerator: string | undefined, characters: Readonly<Record<string, string>> | undefined): string | undefined {
  if (!accelerator || !characters) return undefined
  const key = accelerator.split('+').at(-1) ?? ''
  if (!PUNCTUATION.test(key)) return undefined
  const given = Object.values(characters)
  // A layout read without its punctuation keys says nothing about them.
  if (given.length === 0) return undefined
  return given.includes(key) ? undefined : key
}

/** "CmdOrCtrl+Shift+J" → "⇧⌘J" (macOS order: control, option, shift, command); "Ctrl+Maj+J" on the other systems. */
export function formatAccelerator(accelerator: string, platform: PlatformId): string {
  return formatAcceleratorFor(accelerator, platform)
}

/** The most capsules a tooltip draws, and the longest text of one (shared/tooltip.ts refuses a tooltip that has more). */
const TIP_KEYS_MAX = 5
const TIP_KEY_LENGTH_MAX = 3

/**
 * The keys of a shortcut, one capsule each, as a tooltip draws them: "CmdOrCtrl+Alt+E" → ⌥ ⌘ E. Empty without a shortcut, or when one of its keys has
 * a name too long for a capsule (the tooltip then says its text alone rather than nothing).
 */
export function acceleratorKeys(accelerator: string | undefined, platform: PlatformId): string[] {
  if (!accelerator) return []
  const shown = formatAccelerator(accelerator, platform)
  const modifiers = /^[⌃⌥⇧⌘]*/.exec(shown)![0]
  const keys = (modifiers.length > 0 ? [...modifiers, shown.slice(modifiers.length)] : shown.split('+')).filter((key) => key !== '')
  return keys.length <= TIP_KEYS_MAX && keys.every((key) => key.length <= TIP_KEY_LENGTH_MAX) ? keys : []
}

/**
 * Whether the main modifier of the system is held: Command on macOS, Ctrl elsewhere (the Windows or Super key belongs to the system there). The keys
 * of the sheets that a hint writes « ⌘↵ » or « Ctrl+Entrée » read it, so that the key shown is the key that works.
 */
export function commandHeld(e: { metaKey: boolean; ctrlKey: boolean }, platform: PlatformId): boolean {
  return platform === 'darwin' ? e.metaKey : e.ctrlKey
}

/** The commands whose shortcut a tooltip of the toolbar shows. */
export const TOOLBAR_COMMANDS = ['toggleSidebar', 'back', 'forward', 'reload', 'copyUrl', 'siteInfo', 'closeSplitPane', 'addSplit', 'zoomReset'] as const

/**
 * The keys of each tooltip of the toolbar, one capsule each (see `acceleratorKeys`), empty for a command without a shortcut. `annotate` is
 * the button « Annoter », whose shortcut is a fixed one.
 */
export type ToolbarKeys = Readonly<Record<(typeof TOOLBAR_COMMANDS)[number] | 'annotate', readonly string[]>>

/** The keys the tooltips of the toolbar show, as the shortcuts are set now: a shortcut changed in the Settings changes its tooltip. */
export function toolbarKeys(bindings: KeyBindings | undefined, platform: PlatformId): ToolbarKeys {
  const keys = (id: (typeof TOOLBAR_COMMANDS)[number]): string[] => acceleratorKeys(effectiveAccelerator(id, bindings, platform), platform)
  return {
    toggleSidebar: keys('toggleSidebar'),
    back: keys('back'),
    forward: keys('forward'),
    reload: keys('reload'),
    copyUrl: keys('copyUrl'),
    siteInfo: keys('siteInfo'),
    closeSplitPane: keys('closeSplitPane'),
    addSplit: keys('addSplit'),
    zoomReset: keys('zoomReset'),
    annotate: acceleratorKeys(PAGE_TOGGLE_SHORTCUT, platform)
  }
}

/**
 * The shortcut of a command as a text carries it after a name, « (⌘R) » with the space before it; empty for a command the user left without
 * one. A text that names a key takes it from here (`{shortcut}` in the catalogues), so that it follows a shortcut changed in the Settings.
 */
export function shortcutSuffix(id: string, bindings: KeyBindings | undefined, platform: PlatformId): string {
  const accelerator = effectiveAccelerator(id, bindings, platform)
  return accelerator ? ` (${formatAccelerator(accelerator, platform)})` : ''
}

/** A name followed by the shortcut of its command as it is set now: « Recharger (⌘R) », or the name alone. */
export function labelWithShortcut(label: string, id: string, bindings: KeyBindings | undefined, platform: PlatformId): string {
  return `${label}${shortcutSuffix(id, bindings, platform)}`
}
