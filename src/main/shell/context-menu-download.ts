// The context menu of a row of the downloads (context-menus.ts, kind `download`): open, open with, copy the link, show in the Finder, pause or
// resume, remove, put in the trash, cancel.

import { clipboard, shell, type MenuItemConstructorOptions } from 'electron'
import type { MenuTarget } from '@shared/ipc'
import { canPauseDownload, offersResume } from '@shared/downloads-view'
import { applicationName, fileTypeOf, isExecutableDownload } from '@shared/open-with'
import { t } from '@shared/i18n'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { currentPlatform } from '../platform'

export function downloadMenuItems(target: Extract<MenuTarget, { kind: 'download' }>, browser: Browser, store: StateStore): MenuItemConstructorOptions[] {
  const state = store.get()
  const download = browser.snapshot().downloads.find((d) => d.id === target.id)
  if (!download) return []
  const done = download.state === 'completed'
  const { downloadPause, downloadResume, openWithMemory, openWithApps } = state.settings
  const buttons = { pause: downloadPause, resumeRecorded: downloadResume }
  const fail = (what: string) => (error: unknown) => console.error(`[menu] ${what} failed:`, error)
  const type = fileTypeOf(download.filename)
  const remembered = type !== null && Object.hasOwn(openWithApps, type) ? openWithApps[type] : undefined
  return [
    { label: t('ctx.ouvrir-filename', { filename: download.filename }), enabled: done, click: () => void browser.openDownload(download.id).catch(fail('open the download')) },
    // Setting "Mémoriser l’application d’ouverture": the choice is kept for the type of file, except for a type that can run.
    ...(openWithMemory
      ? ([
          { label: t('ctx.ouvrir-avec'), enabled: done && !isExecutableDownload(download.filename, download.mimeType), click: () => void browser.openDownloadWith(download.id).catch(fail('open the download with an application')) },
          ...(remembered && type !== null && !browser.isPrivate()
            ? ([{ label: t('ctx.ne-plus-ouvrir-les-fichiers-type-avec-app', { type, app: applicationName(remembered) }), click: () => browser.dispatch({ type: 'settings/update', patch: { openWithApps: Object.fromEntries(Object.entries(openWithApps).filter(([key]) => key !== type)) } }) }] satisfies MenuItemConstructorOptions[])
            : [])
        ] satisfies MenuItemConstructorOptions[])
      : []),
    // A row that stands for a record on disk shows host and path only: the link it could copy is not the address.
    { label: t('ctx.copier-le-lien-de-telechargement'), enabled: !(download.recorded === true && download.state === 'interrupted'), click: () => void clipboard.writeText(download.url).catch(fail('copy the download link')) },
    { label: currentPlatform().revealLabel, enabled: done, click: () => shell.showItemInFolder(download.path) },
    { type: 'separator' },
    // Setting "Pause et reprise des téléchargements": the entry is there only while it is on.
    ...(downloadPause && canPauseDownload(download)
      ? ([{ label: t('ctx.mettre-en-pause'), click: () => browser.pauseDownload(download.id) }] satisfies MenuItemConstructorOptions[])
      : offersResume(download, buttons)
        ? ([{ label: t('ctx.reprendre-le-telechargement'), click: () => browser.resumeDownload(download.id) }] satisfies MenuItemConstructorOptions[])
        : []),
    { label: t('ctx.retirer-de-la-liste'), enabled: download.state !== 'progressing', click: () => browser.clearDownload(download.id) },
    { label: t('ctx.mettre-a-la-corbeille'), enabled: done, click: () => void shell.trashItem(download.path).then(() => browser.clearDownload(download.id)).catch(fail('move to the trash')) },
    { label: t('ctx.annuler-le-telechargement'), enabled: download.state === 'progressing', click: () => browser.cancelDownload(download.id) }
  ]
}
