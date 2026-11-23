// The parts of the application menu that open a dialog or reach outside the window: updates, privacy policy, restoring data,
// recording a trace, the documentation. Each takes what it needs from the focused window, so the menu stays a description.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, contentTracing, dialog, net, shell, type BrowserWindow } from 'electron'
import { importSource } from '@shared/import-sources'
import { updatesByHand, type PlatformId } from '@shared/platform'
import { browserDataDir, type PathEnv } from '../platform/paths'
import { exportBookmarks } from './bookmarks-export'
import { restoredState } from '@shared/sidebar'
import { downloadPageUrl, feedAnswer, feedFetchInit, updateOutcome, withdrawnVersions, type FeedAnswer } from '@shared/update-check'
import { UPDATE_NOTICE_MS, droppedUpdateText } from '@shared/auto-update'
import { unreachableFeedReason } from '@shared/update-install'
import { feedSignatureCheck } from './update-signature'
import { withFeedFreshness } from './update-fresh'
import { currentUpdateSources } from './update-source'
import { currentFeedTarget } from './update-target'
import { currentLinuxInstall } from '../platform/linux-install'
import { debAdviser, offerDebUpdate, offerInstall, offerWithdrawn, updateInstaller } from './app-update'
import type { Settings } from '@shared/model'
import type { Browser } from './browser'
import { backUpBeforeRestore } from '../persist'
import type { StateStore } from '../store'
import { isBuiltApp } from '../runtime'
import { exportedNotes, finishRestore, openExportFile } from '../export-file'
import { notesFile } from '../notes-store'
import { getLockService } from '../lock-service'
import { restoreRefusal } from '@shared/lock'
import { getLanguage, t, tp, type Language } from '@shared/i18n'

const FEED_TIMEOUT_MS = 10_000

export interface FocusedWindow {
  win: BrowserWindow
  browser: Browser
  store: StateStore
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

export interface CheckOptions {
  /** Says « Recherche des mises à jour… » in the sidebar while the feed is read (the About window's button says it on itself). */
  searching?: boolean
}

/** Reads the feed: what it answered, or why it did not (no answer at all, or a body that is not a release file). */
async function fetchFeed(feed: string): Promise<FeedAnswer> {
  let response: Response
  try {
    response = await net.fetch(feed, feedFetchInit(AbortSignal.timeout(FEED_TIMEOUT_MS)))
  } catch (error) {
    return { ok: false, reason: unreachableFeedReason(String((error as Error).message ?? error)) }
  }
  try {
    return await feedAnswer(feed, response, feedSignatureCheck(feed))
  } catch (error) {
    // The server answered, with a body that is not JSON (an error page, a file cut short).
    console.warn('[update] the feed is not JSON:', error)
    return { ok: false, reason: t('update-install.le-flux-de-mises-a-jour-est-invalide') }
  }
}

/** The same, and only a feed that is not older than the last one accepted for this address (update-fresh.ts). */
const readFeed = withFeedFreshness(fetchFeed)

/**
 * A Linux copy that is neither an AppImage nor a .deb (`updatesByHand`: a run from the sources, an unpacked build): it reads no update address (update-source.ts) and has no installer, so there is nothing to read and nothing to configure. The box says so
 * in plain words, without the name of a setting nobody has, and offers the download page of the site, where the latest version is.
 */
async function offerManualUpdates(win: BrowserWindow, current: string): Promise<void> {
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    message: t('menu-actions.les-mises-a-jour-se-font-a-la-main'),
    detail: t('menu-actions.vous-utilisez-lucium-current-telechargez-la-derniere', { current }),
    buttons: [t('menu-actions.ouvrir-la-page-telecharger'), t('app-update.fermer')],
    defaultId: 0,
    cancelId: 1
  })
  if (response === 0) await shell.openExternal(downloadPageUrl(getLanguage()))
}

/**
 * Lucium → Check for Updates… (and the About window's button): reads the feed, if one is configured, and says what it found. A newer version
 * this run can install (update-source.ts: a built application with a built-in feed) is offered with "Télécharger et installer" (app-update.ts);
 * otherwise its download page opens in the browser. A running version the feed lists as withdrawn is told so, with the version to install. Only
 * ever on the user's demand: nothing here runs by itself.
 */
export async function checkForUpdates({ win, browser }: FocusedWindow, settings: Settings, options: CheckOptions = {}): Promise<void> {
  const current = app.getVersion()
  const sources = currentUpdateSources(settings)
  const feed = sources.check
  let answer: FeedAnswer | null = null
  if (/^https:\/\//i.test(feed)) {
    if (options.searching !== false) browser?.showToast(t('menu-actions.recherche-des-mises-a-jour'))
    answer = await readFeed(feed)
  }
  // The update downloaded in this run, when the feed now lists it as withdrawn, is dropped: the sidebar says so before the box of what the feed offers.
  if (answer?.ok) {
    const dropped = await updateInstaller()?.dropWithdrawn(withdrawnVersions(answer.json))
    if (dropped && dropped.kind !== 'kept') browser?.showToast(droppedUpdateText({ version: dropped.version, failed: dropped.kind === 'failed' }), undefined, UPDATE_NOTICE_MS)
  }
  const outcome = updateOutcome(current, feed, answer, currentFeedTarget())
  switch (outcome.kind) {
    case 'not-configured':
      if (updatesByHand(process.platform, currentLinuxInstall().packaging)) return offerManualUpdates(win, current)
      await dialog.showMessageBox(win, {
        type: 'info',
        message: t('menu-actions.la-verification-des-mises-a-jour-n-est-pas'),
        detail:
          t('menu-actions.vous-utilisez-lucium-current-cette-version-n', { current }) +
          t('menu-actions.pour-verifier-une-page-de-versions-indiquez-l')
      })
      return
    case 'up-to-date':
      await dialog.showMessageBox(win, { type: 'info', message: t('menu-actions.lucium-est-a-jour'), detail: t('menu-actions.lucium-current-est-la-version-la-plus-recente', { current: outcome.current }) })
      return
    case 'failed':
      await dialog.showMessageBox(win, { type: 'warning', message: t('menu-actions.la-verification-des-mises-a-jour-a-echoue'), detail: outcome.reason })
      return
    case 'withdrawn':
      // Installed from the built-in feed only, like any update (sources.install); offerWithdrawn keeps an older version for the download page.
      return offerWithdrawn({ win, browser }, outcome, sources.install !== null ? updateInstaller() : null)
    case 'available': {
      // A .deb is told, with the command, and never installed (app-update.ts, offerDebUpdate); the feed it reads is the feed of .deb, so its offer is one.
      const deb = debAdviser()
      if (deb && outcome.offer.kind === 'deb') return offerDebUpdate({ win, browser }, outcome.offer, outcome.current, deb)
      // Installed only from the built-in feed (sources.install), and only when the feed names the archive Squirrel downloads.
      const installer = sources.install !== null && outcome.offer.archive ? updateInstaller() : null
      if (installer?.canInstall()) return offerInstall({ win, browser }, outcome.offer, outcome.current, installer)
      const answerBox = await dialog.showMessageBox(win, {
        type: 'info',
        message: t('app-update.la-version-version-est-disponible', { version: outcome.offer.version }),
        detail: t('menu-actions.vous-utilisez-current-cette-version-n-installe-pas', { current: outcome.current }),
        buttons: [t('menu-actions.telecharger-manuellement'), t('menu-actions.plus-tard')],
        defaultId: 0,
        cancelId: 1
      })
      if (answerBox.response === 0) await shell.openExternal(outcome.offer.url)
    }
  }
}

/**
 * Lucium → Exporter les signets (HTML)… : asks whether the Today tabs go in too (no by default), then where the file goes. The sentence
 * that says what was written (or why nothing was) is a notice of the window; a failure to write is a dialog, because the file the user
 * wanted does not exist. `lockedSpaces` are the spaces a lock holds shut now: as from the Settings, nothing is exported while one is.
 */
export async function exportBookmarksFromMenu({ win, browser, store }: FocusedWindow, lockedSpaces: readonly string[]): Promise<void> {
  if (browser.isPrivate()) return
  const asked = await dialog.showMessageBox(win, {
    type: 'question',
    message: t('settings.exporter-les-signets-html'),
    detail: t('menu-actions.les-favoris-les-onglets-epingles-et-les'),
    buttons: [t('menu-actions.exporter'), t('menu-actions.annuler')],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: t('settings.inclure-aussi-les-onglets-du-jour'),
    checkboxChecked: false
  })
  if (asked.response !== 0) return
  try {
    // The state of every window: with windows of their own, this window's view lists its own Today tabs only.
    const outcome = await exportBookmarks({ win, state: store.root().get(), isPrivate: browser.isPrivate(), lockedSpaces }, { includeToday: asked.checkboxChecked === true })
    if (outcome.path !== null) browser.showToast(outcome.message)
    else if (outcome.message) dialog.showErrorBox(t('menu-actions.export-des-signets-impossible'), outcome.message)
  } catch (error) {
    // The save dialog itself failed: the menu has no caller to hand the error to, so the user is told here, and the log keeps it.
    console.error('[bookmarks] the export failed:', error)
    dialog.showErrorBox(t('menu-actions.export-des-signets-impossible'), String((error as Error).message ?? error))
  }
}

/**
 * Lucium → Privacy Policy: what leaves the computer, written from what the code does. A summary of every connection; the full list, with the
 * switch and the default of each, is the table "Connections Lucium makes by itself" of the README, which the second button opens (the copy
 * shipped in the resources, or the repository's in development). Keep the two in step.
 */
export function showPrivacyPolicy({ win }: FocusedWindow): void {
  void dialog
    .showMessageBox(win, {
      type: 'info',
      message: t('menu.politique-de-confidentialite'),
      detail: [
        t('menu-actions.lucium-n-a-ni-compte-ni-synchronisation-ni'),
        t('menu-actions.sans-action-de-votre-part-partent-du-reseau'),
        t('menu-actions.a-votre-demande-seulement-le-chrome-web-store'),
        t('menu-actions.la-liste-complete-avec-l-interrupteur-de-chaque')
      ].join('\n\n'),
      buttons: ['OK', t('menu-actions.ouvrir-le-readme')],
      defaultId: 0,
      cancelId: 0
    })
    .then(({ response }) => (response === 1 ? openDocumentation('start') : undefined))
    .catch((error: unknown) => console.error('[privacy] the policy or the README could not be shown:', error))
}

/**
 * Help → Restore Data…: replaces the whole state with a saved one (an export, plain or sealed with a passphrase, or a backup of the state file), and the
 * quick notes with the ones an export carries, after a copy of the current state and notes.
 */
export async function restoreData({ win, browser, store }: FocusedWindow): Promise<void> {
  // A private window keeps nothing and refuses the restoration: say so rather than let a passphrase be asked for nothing.
  if (browser.isPrivate()) {
    dialog.showErrorBox(t('menu-actions.restauration-impossible'), t('menu-actions.les-donnees-ne-se-restaurent-pas-depuis-une'))
    return
  }
  // A restore replaces every space, the locked ones too: it waits for them to be unlocked, as an export does. Said before a file is asked for.
  const refusal = (): string | null => restoreRefusal(getLockService()?.lockedSpaces() ?? [])
  const locked = refusal()
  if (locked !== null) {
    dialog.showErrorBox(t('menu-actions.restauration-impossible'), locked)
    return
  }
  const picked = await dialog.showOpenDialog(win, {
    title: t('menu-actions.restaurer-les-donnees'),
    message: t('menu-actions.choisissez-une-exportation-d-lucium-chiffree'),
    defaultPath: app.getPath('userData'),
    properties: ['openFile', 'showHiddenFiles']
  })
  const [path] = picked.filePaths
  if (picked.canceled || !path) return
  // A sealed export asks for its passphrase in a panel of the window; the phrase is checked against the file and kept nowhere.
  const opened = await openExportFile(path, (previous) => browser.askPassphrase(t('menu-actions.exportation-chiffree'), t('menu-actions.saisissez-la-phrase-secrete-choisie-pour-ce'), previous))
  if (!opened.ok) {
    if (!opened.cancelled) dialog.showErrorBox(t('menu-actions.restauration-impossible'), opened.message)
    return
  }
  const saved: unknown = opened.value
  const state = restoredState(saved)
  if (!state) {
    dialog.showErrorBox(t('menu-actions.restauration-impossible'), t('menu-actions.ce-fichier-n-est-pas-une-exportation-ou-une'))
    return
  }
  // The reducer holds every script back (`state/restore`): count the ones that will wait, so that the question says so.
  const scripts = state.boosts.filter((b) => b.js.trim() !== '').length
  // The quick notes the file carries (an export made while they were on) are put back too, in the same confirmation; a file without any leaves them alone.
  const notes = exportedNotes(saved)
  const answer = await dialog.showMessageBox(win, {
    type: 'warning',
    message: t('menu-actions.restaurer-spaces-et-tabs', { spaces: tp('arc-summary.spaces', state.spaces.length), tabs: tp('arc-summary.tabs', state.tabs.length) }),
    detail:
      t('menu-actions.vos-espaces-onglets-dossiers-favoris-retouches') +
      `\n\n${t('menu-actions.surveiller-des-pages-les-commandes-par-adresse-et-la-recherche-des-mises-a-jour-restent')}` +
      (notes ? `\n\n${tp('menu-actions.restaurer-notes', notes.length)}` : '') +
      (scripts > 0 ? `\n\n${scripts === 1 ? t('menu-actions.le-javascript-d-une-retouche-est-restaure') : t('menu-actions.le-javascript-de-count-retouches-est-restaure', { count: scripts })}` : ''),
    // Not `menu.annuler`: its English wording is the Edit menu's “Undo”.
    buttons: [t('menu-actions.restaurer'), t('menu-actions.annuler')],
    defaultId: 1,
    cancelId: 1
  })
  if (answer.response !== 0) return
  // The copies come first (state.json, then notes.json): if one cannot be made, the data about to be replaced would exist nowhere else, so nothing is restored.
  const done = finishRestore(
    {
      refusal,
      backUpState: () => backUpBeforeRestore(() => store.flush(), join(app.getPath('userData'), 'state.json')),
      notes: notesFile(),
      applyState: () => browser.dispatch({ type: 'state/restore', state })
    },
    notes
  )
  if (!done.ok) dialog.showErrorBox(t('menu-actions.restauration-impossible'), done.message)
}

let recording = false
export const isRecordingTrace = (): boolean => recording

/** Help → Troubleshooting → Record Trace: Chromium's tracing, saved as a Perfetto trace (ui.perfetto.dev opens it). */
export async function recordTrace({ win }: FocusedWindow, changed: () => void): Promise<void> {
  try {
    if (!recording) {
      // The trace covers every category and may hold what the pages and the machine showed it: the user is told before it starts, and Cancel is the default.
      const answer = await dialog.showMessageBox(win, {
        type: 'warning',
        message: t('menu-actions.enregistrer-une-trace-du-navigateur'),
        detail: t('menu-actions.la-trace-couvre-toutes-les-categories-d'),
        // Its own Cancel: the English wording of `menu.annuler` is the Edit menu's “Undo”.
        buttons: [t('menu-actions.demarrer-l-enregistrement'), t('menu-actions.annuler')],
        defaultId: 1,
        cancelId: 1
      })
      if (answer.response !== 0) return
      await contentTracing.startRecording({ included_categories: ['*'] })
      recording = true
      changed()
      await dialog.showMessageBox(win, {
        type: 'info',
        message: t('menu-actions.enregistrement-de-la-trace-en-cours'),
        detail: t('menu-actions.faites-ce-que-vous-voulez-examiner-puis')
      })
      return
    }
    // The panel itself says what the file holds and where it is suggested (macOS shows `message` above the name), so that the warning of the start is not the only one.
    const saved = await dialog.showSaveDialog(win, {
      title: t('menu-actions.enregistrer-la-trace'),
      message: t('menu-actions.la-trace-contient-les-adresses-des-pages-visitees'),
      defaultPath: join(app.getPath('desktop'), `lucium-trace-${stamp()}.json`)
    })
    // Cancelling leaves the recording running: stopping it without a place to put it would lose it.
    if (saved.canceled || !saved.filePath) return
    const path = await contentTracing.stopRecording(saved.filePath)
    recording = false
    changed()
    shell.showItemInFolder(path)
  } catch (error) {
    recording = false
    changed()
    dialog.showErrorBox(t('menu-actions.trace-impossible'), String((error as Error).message ?? error))
  }
}

/** The README « Premiers pas » opens: the French one in a French interface, the English one otherwise. Both ship in the resources. */
export function gettingStartedFile(language: Language): string {
  return language === 'fr' ? 'README.fr.md' : 'README.md'
}

/** Help → Getting Started (the README, in the language of the interface) and Help → Documentation (the folder). They ship in the application's resources. */
export async function openDocumentation(what: 'start' | 'folder'): Promise<void> {
  const root = isBuiltApp() ? process.resourcesPath : app.getAppPath()
  const docs = join(root, 'docs')
  const target = what === 'folder' ? docs : join(isBuiltApp() ? docs : root, gettingStartedFile(getLanguage()))
  const failure = await shell.openPath(target)
  if (failure) dialog.showErrorBox(t('menu-actions.documentation-introuvable'), `${target}\n\n${failure}`)
}

/** The folder where Lucium looks for another browser's data, for the file chooser of the import sheet. */
export function importFolderOf(sourceId: string, home: string, platform: PlatformId = 'darwin', paths: Omit<PathEnv, 'home'> = {}): string {
  const def = importSource(sourceId)
  if (def?.kind === 'html') return join(home, 'Downloads')
  if (def?.kind === 'safari') return join(home, 'Library/Safari')
  // A browser whose folder this system does not know: the file chooser opens in the home folder.
  return (def && browserDataDir(def, platform, { ...paths, home }, existsSync)) || home
}
