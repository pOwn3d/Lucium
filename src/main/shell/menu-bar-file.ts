// The File menu of the bar (Fichier): new tabs and windows, sessions, closing, sharing, captures, the summary, saving and printing, the
// reading list, and the optional entries of the passwords, the bookmarks, the application windows and the notes. Built from what
// menu-bar-kit.ts reads once for the whole bar.

import type { MenuItemConstructorOptions } from 'electron'
import { activeTab } from '@shared/sidebar'
import { isReadLaterUrl } from '@shared/read-later'
import { isBookmarkUrl } from '@shared/bookmarks'
import { summaryAvailable, summaryGreyed } from '@shared/ollama'
import { PAGE_TOGGLE_SHORTCUT } from '@shared/page-annotate'
import { NEW_NOTE_REQUEST } from '@shared/notes'
import { t } from '@shared/i18n'
import { webToolsFileItems } from './web-tools-menu'
import { getPasswordService } from './password-service'
import { captureActivePage, captureActivePagePortrait } from './capture'
import { sharePage } from './page-commands'
import type { MenuBarKit } from './menu-bar-kit'

export function fileMenu({ browser, store, actions, options, state, acc, alone, kept, onTab, page, tabNow, report, dispatch, withTab, archiveTab, toggleOverlay, toolsMenu }: MenuBarKit): MenuItemConstructorOptions {
  const passwordsOn = options.private !== true && state().settings.passwordManager
  // The functions of the library are optional: their entries are hidden (and their shortcuts dead) while the function is off, and in a private window, which keeps nothing.
  const bookmarksOn = options.private !== true && state().settings.bookmarkManager
  const webAppsOn = options.private !== true && state().settings.webAppWindows
  // Optional: the quick notes. Their entry is hidden (and its key dead) while the function is off, and in a private window, which keeps none.
  const notesOn = options.private !== true && state().settings.notes
  // Optional: the page summary. Its entries are hidden while the model is not ready (shared/ollama.ts `summaryAvailable`). With Ollama on this
  // Mac the page text stays here, so a private or a guest window has them too; with Ollama on another computer it has none.
  const summaryOn = summaryAvailable(state().settings, options.private === true)
  // In a normal window the menu is one for all its tabs: for a private tab on screen whose text would leave the Mac, the entries are greyed out.
  const onSummary = { enabled: tabNow !== undefined && !summaryGreyed(state().settings, tabNow.private === true) }
  return {
    label: t('menu.fichier'),
    submenu: [
      { label: t('menu.nouvel-onglet'), accelerator: acc('newTab'), click: () => browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' }) },
      { label: t('menu.nouvelle-fenetre'), accelerator: acc('newWindow'), click: actions.newWindow },
      { label: t('menu.fenetre-vierge'), accelerator: acc('blankWindow'), click: actions.blankWindow },
      { label: t('menu.nouvelle-fenetre-privee'), accelerator: acc('privateWindow'), click: actions.privateWindow },
      // The annotated window share (docs/design/annotation-partage-fenetre.md): listed only when it is built, that is unless LUCIUM_ANNOTATE=0 (sources or smoke run only).
      ...(actions.shareWindow ? [{ label: t('menu.partager-une-fenetre-annotee'), click: actions.shareWindow }] : []),
      // ⌥⌘M: the shortcut of this entry, heard while Lucium is in front. With « ⌥⌘M depuis toute
      // application » on, PageAnnotate holds it system-wide instead: the entry only shows it, so that one press never starts the annotation twice.
      ...(actions.annotatePage
        ? [{ label: t('menu.annoter-cette-page'), accelerator: PAGE_TOGGLE_SHORTCUT, registerAccelerator: !state().settings.annotateGlobalShortcut, type: 'checkbox' as const, checked: actions.annotatingPage?.() === true, click: actions.annotatePage }]
        : []),
      // Optional. A private window needs none (all its tabs are private), and the setting can take the entry away.
      // Optional too: hidden until the setting is on, and in a private or guest window (the entry is for the owner's windows). Its shortcut does nothing while the setting is off (WindowManager.openGuest).
      { label: t('menu.nouvelle-fenetre-invite'), accelerator: acc('guestWindow'), visible: options.private !== true && state().settings.guestProfile, click: actions.guestWindow },
      { label: t('menu.nouvel-onglet-prive'), accelerator: acc('newPrivateTab'), visible: options.private !== true && state().settings.privateTabs, click: () => browser.openPrivateTab() },
      // Optional: one entry per container, only while tab containers are on and there is one. No shortcut: a container is picked from the list.
      {
        label: t('menu.nouvel-onglet-dans-un-conteneur'),
        visible: options.private !== true && state().settings.tabContainers && state().settings.containers.length > 0,
        submenu: state().settings.containers.map((container) => ({ label: container.name, click: () => browser.openContainerTab(container.id) }))
      },
      // A window of its own (the bar alone, Browser.openOverlay): a main window put away stays so.
      { label: t('menu.nouvelle-mini-fenetre'), accelerator: acc('newLittleArc'), ...kept, click: alone(() => browser.openOverlay({ panel: 'commandbar', mode: 'little', initial: '' })) },
      { label: t('menu.rouvrir-le-dernier-onglet-ferme'), accelerator: acc('restoreClosed'), enabled: state().archive.length > 0, click: dispatch({ type: 'archive/restore-last' }) },
      { type: 'separator' },
      {
        label: t('menu.ouvrir-la-barre-de-commandes'),
        accelerator: acc('openLocation'),
        click: () => browser.openOverlay({ panel: 'commandbar', mode: 'current', initial: activeTab(state())?.url ?? '' })
      },
      { type: 'separator' },
      { label: t('menu.nouveau-profil'), accelerator: acc('newProfile'), ...kept, click: () => browser.openOverlay({ panel: 'space', spaceId: state().activeSpaceId, focus: 'profile' }) },
      { type: 'separator' },
      // Sessions of tabs: data a private window does not keep.
      { label: t('menu.sessions'), accelerator: acc('sessions'), ...kept, click: () => browser.openOverlay({ panel: 'sessions' }) },
      { label: t('menu.enregistrer-la-session'), accelerator: acc('saveSession'), ...kept, click: () => browser.openOverlay({ panel: 'sessions', focus: 'save' }) },
      { type: 'separator' },
      { label: t('menu.fermer-la-fenetre'), accelerator: acc('closeWindow'), click: actions.closeWindow },
      // Optional: shown, and its shortcut live, only while windows can be named (a setting); the command is hosted here either way.
      { label: t('menu.nommer-la-fenetre'), accelerator: acc('nameWindow'), visible: state().settings.nameWindows, enabled: state().settings.nameWindows, click: () => browser.openOverlay({ panel: 'windowname' }) },
      { label: t('menu.archiver-l-onglet'), accelerator: acc('closeTab'), ...onTab, click: archiveTab },
      { type: 'separator' },
      { label: t('menu.partager'), accelerator: acc('share'), enabled: page !== null, click: () => sharePage(store, actions.window()) },
      ...webToolsFileItems(toolsMenu),
      { label: t('menu.capturer'), accelerator: acc('captureRegion'), ...onTab, click: () => browser.openOverlay({ panel: 'capture' }) },
      // The summary exists in the menu only once the model is ready (Ollama switched on, at an accepted address).
      { label: t('menu.resumer-la-page'), ...onSummary, visible: summaryOn, click: () => browser.openSummaryTab('normal') },
      { label: t('menu.resumer-court'), ...onSummary, visible: summaryOn, click: () => browser.openSummaryTab('short') },
      { label: t('menu.resumer-detaille'), ...onSummary, visible: summaryOn, click: () => browser.openSummaryTab('long') },
      {
        label: t('menu.capturer-la-page-entiere'),
        accelerator: acc('captureFull'), ...onTab,
        click: () => void captureActivePage(browser, true).catch(report('full-page capture'))
      },
      {
        label: t('menu.capturer-la-partie-visible'),
        accelerator: acc('captureVisible'), ...onTab,
        click: () => void captureActivePage(browser, false).catch(report('capture'))
      },
      {
        label: t('menu.capturer-en-mode-portrait'),
        accelerator: acc('capturePortrait'), ...onTab,
        click: () => void captureActivePagePortrait(browser).catch(report('portrait capture'))
      },
      { label: t('menu.enregistrer-la-page-sous'), accelerator: acc('savePage'), ...onTab, click: actions.savePage },
      { label: t('menu.exporter-la-page-en-markdown'), accelerator: acc('exportMarkdown'), enabled: page !== null, click: () => void browser.exportMarkdown().catch(report('Markdown export')) },
      { label: t('menu.imprimer'), accelerator: acc('print'), ...onTab, click: () => browser.printPage() },
      // Optional: only with the setting "Enregistrer en PDF avec l’adresse" on (among the settings of the downloads).
      ...(state().settings.pdfWithSource
        ? ([{ label: t('menu.enregistrer-en-pdf-avec-l-adresse'), accelerator: acc('savePdfSource'), enabled: tabNow !== undefined && /^https?:\/\//i.test(tabNow.url), click: () => void browser.savePdfWithSource().catch(report('PDF with source')) }] satisfies MenuItemConstructorOptions[])
        : []),
      { type: 'separator' },
      // Read later: the page is kept in the list and its tab closes; a private window keeps no list.
      { label: t('menu.lire-plus-tard'), accelerator: acc('readLater'), enabled: options.private !== true && tabNow !== undefined && isReadLaterUrl(tabNow.url), click: withTab((tab) => browser.dispatch({ type: 'readlater/add', tabId: tab.id })) },
      { label: t('menu.liste-de-lecture'), accelerator: acc('readLaterList'), ...kept, click: () => browser.openOverlay({ panel: 'readlater' }) },
      // Optional: the password manager. Both entries exist for their shortcuts, and are visible (and live) only while it is on and not in a private window.
      { label: t('menu.mots-de-passe'), accelerator: acc('passwords'), visible: passwordsOn, enabled: passwordsOn, click: () => browser.openOverlay({ panel: 'passwords' }) },
      { label: t('menu.remplir-l-identifiant-et-le-mot-de-passe'), accelerator: acc('fillPassword'), visible: passwordsOn, enabled: passwordsOn && tabNow !== undefined, click: () => void getPasswordService()?.fillActive(browser.passwordWindow()).catch(report('password fill')) },
      { label: t('menu.ajouter-aux-signets'), accelerator: acc('bookmarkAdd'), visible: bookmarksOn, enabled: bookmarksOn && tabNow !== undefined && isBookmarkUrl(tabNow.url), click: withTab((tab) => browser.dispatch({ type: 'bookmark/add', tabId: tab.id })) },
      { label: t('menu.signets'), accelerator: acc('bookmarkList'), visible: bookmarksOn, enabled: bookmarksOn, click: () => browser.openOverlay({ panel: 'bookmarks' }) },
      { label: t('menu.ouvrir-comme-application'), accelerator: acc('openAsApp'), visible: webAppsOn, enabled: webAppsOn && tabNow !== undefined && isBookmarkUrl(tabNow.url), click: () => browser.openAsApp() },
      // The key opens the panel, and closes it when it is the one on screen.
      { label: t('menu.notes'), accelerator: acc('notes'), visible: notesOn, enabled: notesOn, click: toggleOverlay({ panel: 'notes' }) },
      // The panel on a new note tied to the page on screen, the cursor in it. Asked again while the panel is open, it opens again on a new note (a
      // note being written there is not kept, as with ⇧⌘E closing it).
      { label: t('menu.nouvelle-note'), accelerator: acc('newNote'), visible: notesOn, enabled: notesOn, click: () => browser.openOverlay(NEW_NOTE_REQUEST) }
    ]
  }
}
