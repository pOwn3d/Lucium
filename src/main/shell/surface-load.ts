// How a page of our own interface is loaded in a web contents: the one way every surface goes through (main() in index.ts gives the folder of
// the built pages and whether the application is packaged). The surfaces share the preload (`window.lucium`), so each one is locked to our own
// pages before its first load (surface-guard.ts), has its errors relayed to the log and is loaded again when its renderer dies.

import { join } from 'node:path'
import type { WebContents } from 'electron'
import { appRoots, lockSurface } from './surface-guard'
import { relayUiErrors } from './ui-error-relay'
import { CRASH_RELOAD_DEFAULTS, reloadUiAfterCrash } from './ui-crash-reload'
import { showSystemNotice } from './system-notice'
import { t } from '@shared/i18n'

export type Surface = { page: 'index' | 'overlay' | 'littlearc' | 'floating-video' | 'settings' | 'taskmanager' | 'about' | 'window-share-view' | 'window-share-command' | 'page-annotate-command'; hash?: string; query?: Record<string, string> }

/** Where the pages are, and what tells the dev server may be followed. */
export interface SurfaceHome {
  /** The folder of the built pages (`out/renderer`). */
  rendererDir: string
  /** Whether the application is packaged: only one that is not follows the dev server. */
  built: boolean
}

/**
 * A page of the interface that keeps dying is no longer loaded again: the window stays blank, and nothing in it can say why. The system says it
 * instead, and that nothing is lost; when the system takes no notice either, the log keeps the line.
 */
export function tellInterfaceStopped(page: string): void {
  const notice = { title: t('ui.l-interface-ne-repond-plus'), body: t('ui.l-interface-ne-repond-plus-relancez') }
  if (!showSystemNotice(notice)) console.error(`[ui] could not tell the user that the ${page} page is no longer loaded again: ${notice.body}`)
}

export function loadSurface(target: WebContents, { page, hash, query }: Surface, home: SurfaceHome): void {
  // Every surface of our interface goes through here, and shares the preload: it may only ever show our own pages (see surface-guard.ts).
  const roots = appRoots(home.rendererDir, home.built)
  lockSurface(target, roots)
  // What fails in the page of the interface (its root boundary, an error nothing caught) is written to the log of État de Lucium.
  relayUiErrors(target, page)
  // A page of the interface whose renderer dies is loaded again rather than left blank (a few times a minute at most, see ui-crash-reload.ts).
  reloadUiAfterCrash(target, page, { ...CRASH_RELOAD_DEFAULTS, giveUp: tellInterfaceStopped })
  // Only an application that is not packaged follows the dev server (rendererDevUrl): an environment variable must not replace the interface.
  const dev = roots.devUrl?.replace(/\/$/, '')
  const search = query ? `?${new URLSearchParams(query)}` : ''
  const done = dev
    ? target.loadURL(`${dev}/${page}.html${search}${hash ? `#${hash}` : ''}`)
    : target.loadFile(join(home.rendererDir, `${page}.html`), { hash, query })
  void done.catch((error: unknown) => console.error(`[shell] cannot load the ${page}${hash ? `#${hash}` : ''} UI:`, error))
}
