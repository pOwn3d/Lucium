import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, clipboard, dialog, type BrowserWindow } from 'electron'
import type { ImportPreview } from '@shared/boost-share'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { getLockService } from '../lock-service'
import { isWideHost } from './boost-host'
import { readBoundedText } from './bounded-file'
import { BOOST_EXTENSION, THEME_EXTENSION, type ExportChoice, type ImportChoice, type ShareEnvironment } from './boost-share'
import { t, tp } from '@shared/i18n'

/**
 * The share buttons' view of a window: its state and toasts, the system clipboard and dialogs (as sheets of the window, so that a Tweak is
 * read and answered for in the window it was asked from), and the files. Every choice is the person's: nothing is installed by default.
 */
export function shareEnvironment(browser: Browser, store: StateStore, win: BrowserWindow): ShareEnvironment {
  const json = (name: string, extensions: string[]) => [{ name, extensions }]
  return {
    window: browser,
    state: () => store.get(),
    dispatch: (action) => browser.dispatch(action),
    toast: (message) => browser.showToast(message),
    readClipboard: () => clipboard.readText(),
    writeClipboard: (text) => clipboard.writeText(text),
    isPrivate: () => browser.isPrivate(),
    lockedSpaces: () => getLockService()?.lockedSpaces() ?? [],
    newId: () => randomUUID(),
    isWideHost,
    async chooseOpenFile(title) {
      const picked = await dialog.showOpenDialog(win, { title, defaultPath: app.getPath('downloads'), properties: ['openFile'], filters: [...json(t('share-environment.retouche-ou-theme-lucium'), [BOOST_EXTENSION, THEME_EXTENSION, 'json']), { name: t('feature.tous-les-fichiers'), extensions: ['*'] }] })
      return picked.canceled ? null : (picked.filePaths[0] ?? null)
    },
    async chooseSaveFile(title, defaultName, extension) {
      const saved = await dialog.showSaveDialog(win, { title, defaultPath: join(app.getPath('downloads'), defaultName), filters: json(t('share-environment.fichier-lucium'), [extension]) })
      return saved.canceled || !saved.filePath ? null : saved.filePath
    },
    readFile: readBoundedText,
    writeFile: (path, text) => writeFile(path, text, 'utf8'),
    async confirmImport(preview: ImportPreview): Promise<ImportChoice> {
      // The way out is the default button: Enter on a sheet nobody read installs nothing. (Cancel is `confirm-box.annuler`: the English of
      // `menu.annuler` is the Edit menu's “Undo”.)
      const cancel = t('confirm-box.annuler')
      const buttons = preview.hasScript ? [t('share-environment.installer-javascript-desactive'), t('share-environment.installer-sans-le-javascript'), cancel] : preview.scriptDropped ? [t('share-environment.installer-sans-le-javascript'), cancel] : [t('share-environment.installer'), cancel]
      const answer = await dialog.showMessageBox(win, { type: preview.hasScript ? 'warning' : 'question', message: preview.message, detail: preview.detail, buttons, defaultId: buttons.length - 1, cancelId: buttons.length - 1, noLink: true })
      if (answer.response === buttons.length - 1) return 'cancel'
      return preview.hasScript && answer.response === 1 ? 'install-without-script' : preview.scriptDropped ? 'install-without-script' : 'install'
    },
    async confirmExportScript(boostName, warning, scripted): Promise<ExportChoice> {
      // For a file of all the Tweaks: one sheet that names the ones with a script (the first few, then how many more).
      const named = scripted ? [...scripted.slice(0, 8), ...(scripted.length > 8 ? [tp('share-environment.et-count-autres', scripted.length - 8)] : [])].join(t('boostshare.point-virgule')) : ''
      const answer = await dialog.showMessageBox(win, {
        type: 'warning',
        message: scripted ? tp('share-environment.count-retouches-contiennent-du-javascript', scripted.length, { names: named }) : t('share-environment.le-boost-boostname-contient-du-javascript', { boostName }),
        detail: warning,
        buttons: [t('share-environment.exporter-sans-le-javascript'), t('share-environment.exporter-avec-le-javascript'), t('confirm-box.annuler')],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      })
      return answer.response === 0 ? 'without-script' : answer.response === 1 ? 'with-script' : 'cancel'
    },
    async confirmThemeImport(message, detail) {
      const answer = await dialog.showMessageBox(win, { type: 'question', message, detail, buttons: [t('share-environment.appliquer'), t('confirm-box.annuler')], defaultId: 1, cancelId: 1, noLink: true })
      return answer.response === 0
    },
    async showProblem(title, sentence) {
      await dialog.showMessageBox(win, { type: 'warning', message: title, detail: sentence, buttons: ['OK'], noLink: true })
    }
  }
}
