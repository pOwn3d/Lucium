// Espaces › Exporter cet espace… / Importer un espace… (the menu bar and the space's menu come here): one space with its tabs, folders and archive passes to
// another Mac as a file, sealed with a passphrase if the user wants. Nothing leaves the machine by itself: the user picks where the file is written and
// which file is read. What the file holds and leaves out is shared/space-transfer.ts; the file itself is main/space-transfer-file.ts.

import { writeFileSync } from 'node:fs'
import { app, dialog, type BrowserWindow } from 'electron'
import { persistableState } from '@shared/sidebar'
import { spaceTransferRefusal } from '@shared/space-transfer'
import { t } from '@shared/i18n'
import { ExportCryptoError, PASSPHRASE_MIN, exportErrorMessage } from '../export-crypto'
import { getLockService } from '../lock-service'
import { readSpaceTransfer, spaceTransferText } from '../space-transfer-file'
import type { StateStore } from '../store'
import type { Browser } from './browser'

/** The phrase that seals the file: asked twice in the window's panel, null when the user gives up. */
async function chooseSealPhrase(browser: Browser): Promise<string | null> {
  let problem: string | null = null
  for (;;) {
    const first = await browser.askPassphrase(t('space-transfer.phrase-secrete'), t('space-transfer.choisissez-la-phrase-qui-chiffrera-le-fichier'), problem)
    if (first === null) return null
    if ([...first.normalize('NFKC')].length < PASSPHRASE_MIN) {
      problem = t('export-crypto.la-phrase-secrete-doit-faire-au-moins', { PASSPHRASE_MIN })
      continue
    }
    const again = await browser.askPassphrase(t('space-transfer.phrase-secrete'), t('space-transfer.saisissez-la-une-seconde-fois-pour-la-confirmer'), null)
    if (again === null) return null
    if (again === first) return first
    problem = t('passwords-panel.les-deux-phrases-ne-sont-pas-identiques')
  }
}

export async function exportSpace(browser: Browser, store: StateStore, win: BrowserWindow, spaceId: string): Promise<void> {
  if (browser.isPrivate()) return browser.showToast(t('space-transfer.un-espace-ne-se-transfere-pas-depuis-une-fenetre-privee'))
  // The state of every window, as « Exporter les données » reads it: this window's view may list its own tabs only.
  const state = persistableState(store.root().get())
  const space = state.spaces.find((s) => s.id === spaceId)
  if (!space) return
  // Asked before any box: a locked space, or a too large one, is refused at once instead of after the passphrase and the file name.
  const refusal = spaceTransferRefusal(state, spaceId, getLockService()?.lockedSpaces() ?? [])
  if (refusal !== null) return void dialog.showErrorBox(t('space-transfer.exportation-impossible'), refusal)
  const seal = await dialog.showMessageBox(win, {
    type: 'question',
    message: t('space-transfer.chiffrer-le-fichier-de-l-espace'),
    detail: t('space-transfer.le-fichier-garde-les-onglets-et-les-dossiers'),
    buttons: [t('space-transfer.chiffrer'), t('space-transfer.sans-chiffrement'), t('confirm-box.annuler')],
    defaultId: 0,
    cancelId: 2
  })
  if (seal.response === 2) return
  let passphrase: string | null = null
  if (seal.response === 0) {
    passphrase = await chooseSealPhrase(browser)
    if (passphrase === null) return
  }
  const saved = await dialog.showSaveDialog(win, {
    title: t('space-transfer.exporter-l-espace-name', { name: space.name }),
    defaultPath: `${space.name.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'espace'}.lucium-space.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (saved.canceled || !saved.filePath) return
  try {
    const made = await spaceTransferText(state, spaceId, passphrase, getLockService()?.lockedSpaces() ?? [])
    if (!made.ok) return void dialog.showErrorBox(t('space-transfer.exportation-impossible'), made.message)
    // The file holds the pages of the space: only the user reads it.
    writeFileSync(saved.filePath, made.text, { mode: 0o600 })
    browser.showToast(t(made.encrypted ? 'space-transfer.espace-name-exporte-dans-path-chiffre' : 'space-transfer.espace-name-exporte-dans-path', { name: made.name, path: saved.filePath }))
  } catch (error) {
    // The cause only, never the request: the phrase is in no line this logs.
    console.error('[space-transfer] the space could not be exported:', error instanceof ExportCryptoError ? error.kind : error instanceof Error ? error.name : typeof error)
    dialog.showErrorBox(t('space-transfer.exportation-impossible'), error instanceof ExportCryptoError ? exportErrorMessage(error) : t('ipc.exportation-echouee', { detail: String((error as Error).message ?? error) }))
  }
}

export async function importSpace(browser: Browser, store: StateStore, win: BrowserWindow): Promise<void> {
  if (browser.isPrivate()) return browser.showToast(t('space-transfer.un-espace-ne-se-transfere-pas-depuis-une-fenetre-privee'))
  const picked = await dialog.showOpenDialog(win, {
    title: t('space-transfer.importer-un-espace-titre'),
    message: t('space-transfer.choisissez-un-espace-exporte-par-lucium'),
    defaultPath: app.getPath('downloads'),
    properties: ['openFile']
  })
  const [path] = picked.filePaths
  if (picked.canceled || !path) return
  const read = await readSpaceTransfer(path, (previous) => browser.askPassphrase(t('menu-actions.exportation-chiffree'), t('menu-actions.saisissez-la-phrase-secrete-choisie-pour-ce'), previous))
  if (!read.ok) {
    if (!('cancelled' in read && read.cancelled)) dialog.showErrorBox(t('space-transfer.importation-impossible'), read.message)
    return
  }
  const before = store.root().get().spaces.length
  browser.dispatch({ type: 'space/import', aside: read.aside })
  if (store.root().get().spaces.length > before) browser.showToast(t('space-transfer.espace-name-importe', { name: read.aside.space.name }))
}
