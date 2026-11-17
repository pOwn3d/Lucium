// The Edit menu of the bar (Édition): undo (of the text being typed, else of the last tab archived), the clipboard and the copies of the address,
// the search in the page, spelling, substitutions, transformations, speech and the format of the selection. Built from what menu-bar-kit.ts
// reads once for the whole bar.

import { webContents, type MenuItemConstructorOptions } from 'electron'
import { undoableArchive } from '@shared/menu-state'
import { EDITING_SCRIPT } from '@shared/text-format'
import { t } from '@shared/i18n'
import { formatSelection, isSpellChecking, jumpToSelection, setSpellChecking, transformSelection, useSelectionToFind } from './page-commands'
import type { MenuBarKit } from './menu-bar-kit'

export function editMenu({ browser, actions, state, acc, onTab, facts, tabNow, report }: MenuBarKit): MenuItemConstructorOptions {
  const undoArchive = undoableArchive(state(), actions.sessionStart)
  const openFind = (replace: boolean) => browser.openOverlay({ panel: replace ? 'findreplace' : 'find' })
  const stepFind = (forward: boolean) => {
    const text = browser.snapshot().find?.text
    if (text) browser.findInPage(text, { next: true, forward })
  }

  // Edit › Undo: the text of the field being typed in, else the last tab archived.
  const undo = async () => {
    const focused = webContents.getFocusedWebContents()
    const editing = focused
      ? await focused.executeJavaScript(EDITING_SCRIPT).catch((error: unknown) => {
          console.warn('[menu] cannot tell whether a text field has the focus:', error)
          return false
        })
      : false
    if (focused && (editing === true || !undoArchive)) focused.undo()
    // Nothing archived in this session: an older archive is not an action to undo.
    else if (undoArchive) browser.dispatch({ type: 'archive/restore-last' })
  }

  const disabled = (label: string): MenuItemConstructorOptions => ({ label, enabled: false })
  return {
    label: t('menu.edition'),
    submenu: [
      { label: undoArchive ? t('menu.annuler-l-archivage-de-l-onglet') : t('menu.annuler'), accelerator: 'CmdOrCtrl+Z', click: () => void undo() },
      { role: 'redo', label: t('menu.retablir') },
      { type: 'separator' },
      { role: 'cut', label: t('menu.couper') },
      { role: 'copy', label: t('menu.copier') },
      { label: t('menu.copier-l-adresse'), accelerator: acc('copyUrl'), enabled: tabNow !== undefined, click: () => void browser.copyUrl('plain') },
      { label: t('menu.copier-l-adresse-en-markdown'), accelerator: acc('copyUrlMarkdown'), enabled: tabNow !== undefined, click: () => void browser.copyUrl('markdown') },
      { label: t('menu.copier-l-adresse-en-citation'), accelerator: acc('copyUrlQuote'), enabled: tabNow !== undefined, click: () => void browser.copyUrl('quote').catch(report('copy as quote')) },
      { role: 'paste', label: t('menu.coller') },
      { role: 'pasteAndMatchStyle', label: t('menu.coller-et-adapter-le-style') },
      { role: 'delete', label: t('menu.supprimer') },
      { role: 'selectAll', label: t('menu.tout-selectionner') },
      { type: 'separator' },
      {
        label: t('menu.rechercher'),
        submenu: [
          { label: t('menu.rechercher-2'), accelerator: acc('find'), ...onTab, click: () => openFind(false) },
          { label: t('menu.trouver-et-remplacer'), accelerator: acc('findReplace'), ...onTab, click: () => openFind(true) },
          { label: t('menu.occurrence-suivante'), accelerator: acc('findNext'), enabled: facts.finding, click: () => stepFind(true) },
          { label: t('menu.occurrence-precedente'), accelerator: acc('findPrevious'), enabled: facts.finding, click: () => stepFind(false) },
          { label: t('menu.utiliser-la-selection-pour-rechercher'), accelerator: acc('useSelectionToFind'), ...onTab, click: () => void useSelectionToFind(browser).catch(report('use selection to find')) },
          { label: t('menu.aller-a-la-selection'), accelerator: acc('jumpToSelection'), ...onTab, click: () => void jumpToSelection(browser).catch(report('jump to selection')) }
        ]
      },
      {
        label: t('menu.orthographe-et-grammaire'),
        submenu: [
          // The system's panel and its document check work on a native text view, which a web page is not.
          disabled(t('menu.afficher-l-orthographe-et-la-grammaire')),
          disabled(t('menu.verifier-le-document-maintenant')),
          { type: 'separator' },
          { label: t('menu.verifier-l-orthographe-lors-de-la-saisie'), type: 'checkbox', checked: isSpellChecking(), click: (item) => setSpellChecking(item.checked) },
          disabled(t('menu.verifier-la-grammaire-avec-l-orthographe')),
          disabled(t('menu.corriger-l-orthographe-automatiquement'))
        ]
      },
      {
        label: t('menu.substitutions'),
        submenu: [
          { role: 'showSubstitutions', label: t('menu.afficher-les-substitutions') },
          { type: 'separator' },
          disabled(t('menu.copier-coller-intelligent')),
          disabled(t('menu.guillemets-intelligents')),
          disabled(t('menu.tirets-intelligents')),
          disabled(t('menu.liens-intelligents')),
          disabled(t('menu.detecteurs-de-donnees')),
          disabled(t('menu.remplacement-du-texte'))
        ]
      },
      {
        label: t('menu.transformations'),
        submenu: [
          { label: t('menu.mettre-en-majuscules'), click: () => void transformSelection(browser, 'upper').catch(report('upper case')) },
          { label: t('menu.mettre-en-minuscules'), click: () => void transformSelection(browser, 'lower').catch(report('lower case')) },
          { label: t('menu.mettre-une-majuscule-a-chaque-mot'), click: () => void transformSelection(browser, 'capitalize').catch(report('capitalize')) }
        ]
      },
      {
        label: t('menu.parole'),
        submenu: [
          { role: 'startSpeaking', label: t('menu.commencer-la-lecture-a-voix-haute') },
          { role: 'stopSpeaking', label: t('menu.arreter-la-lecture-a-voix-haute') }
        ]
      },
      {
        label: t('menu.format'),
        submenu: [
          {
            label: t('menu.police'),
            submenu: [
              // The keys stay the page's own (a rich-text editor uses them); the menu shows them and does the same thing.
              { label: t('menu.gras'), accelerator: 'CmdOrCtrl+B', registerAccelerator: false, click: () => void formatSelection(browser, 'bold').catch(report('bold')) },
              { label: t('menu.italique'), accelerator: 'CmdOrCtrl+I', registerAccelerator: false, click: () => void formatSelection(browser, 'italic').catch(report('italic')) },
              { label: t('menu.souligne'), accelerator: 'CmdOrCtrl+U', registerAccelerator: false, click: () => void formatSelection(browser, 'underline').catch(report('underline')) }
            ]
          }
        ]
      }
    ]
  }
}
