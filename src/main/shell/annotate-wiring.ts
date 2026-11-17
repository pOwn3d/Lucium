// A part of main() (index.ts), moved out as it was: the annotated window share and the annotation directly on the page, and what follows
// their settings. Called once, where its lines were (after the windows of their own, before the window manager): its listener of the state
// comes in the same place among the others. The window manager and the menu do not exist yet when it is called: they are read when needed.

import { join } from 'node:path'
import type { WebContents } from 'electron'
import { getLanguage } from '@shared/i18n'
import { windowNumber } from '@shared/page-annotate'
import { autoClearOf, autoClearPatch } from '@shared/annotate-auto-clear'
import { annotateShareEnabled } from '@shared/window-share'
import type { StateStore } from '../store'
import { PageAnnotate } from './page-annotate'
import type { Surface } from './surface-load'
import { WindowShare } from './window-share'
import { loadNativeAccess } from './window-share-native'
import type { WindowManager } from './windows'

export interface AnnotationDeps {
  sharedStore: StateStore
  /** Loads a surface of the interface, locked to our own pages (index.ts, `load`). */
  load: (target: WebContents, surface: Surface) => void
  /** The folder of the built preload scripts. */
  preloadDir: string
  /** The window manager, made after this is called. */
  windowManager: () => WindowManager
  /** Rebuilds the menu bar, whose wiring comes after this is called. */
  refreshMenu: () => void
}

export interface Annotation {
  annotateShare: WindowShare | null
  pageAnnotate: PageAnnotate | null
}

export function installAnnotation({ sharedStore, load, preloadDir, windowManager, refreshMenu }: AnnotationDeps): Annotation {
  // The annotated window share (docs/design/annotation-partage-fenetre.md, « Fenêtre annotée »): on by default; LUCIUM_ANNOTATE=0 turns it off, from
  // the sources or in a smoke run only (dropDevelopmentEnv). Off, nothing of it is made: no handler, no window, no menu entry.
  const annotateShare = annotateShareEnabled(process.env)
    ? new WindowShare({
        load: (target, page, query) => load(target, { page, query }),
        privateWindows: () => windowManager().privateWindows().map((record) => record.win),
        preload: join(preloadDir, 'window-share.js'),
        viewPreload: join(preloadDir, 'window-share-view.js'),
        language: () => getLanguage(),
        native: loadNativeAccess
      })
    : null

  // The annotation directly on the page (docs/design/annotation-partage-fenetre.md, « Annotation directe dans la page »): the same
  // flag, nothing built without it. The layer is put on the page on screen; its command window is a window of its own.
  // The window with this media source id (the focused one for null): the annotation belongs to one window, the one that is shared.
  const annotatedBrowser = (window: string | null) => (window === null ? windowManager().focused().browser : windowManager().list().find((record) => windowNumber(record.browser.annotationSource()) === windowNumber(window))?.browser)
  const pageAnnotate = annotateShareEnabled(process.env)
    ? new PageAnnotate({
        target: (window) => annotatedBrowser(window)?.annotationTarget() ?? null,
        placement: (window) => annotatedBrowser(window)?.annotationPlacement() ?? null,
        hue: (window) => annotatedBrowser(window)?.annotationHue() ?? null,
        // Where the bar stands is a setting (annotateBar): the settings clean it and keep it across restarts, and this module keeps no copy.
        position: () => sharedStore.get().settings.annotateBar,
        setPosition: (position) => sharedStore.dispatch({ type: 'settings/update', patch: { annotateBar: position } }),
        // The hint above the grip is shown the first time the bar opens, until it is dismissed (a memory in the settings, like the other notes read once).
        hintSeen: () => sharedStore.get().settings.annotateBarHintSeen,
        setHintSeen: () => sharedStore.dispatch({ type: 'settings/update', patch: { annotateBarHintSeen: true } }),
        focusedSource: () => windowManager().focused().browser.annotationSource(),
        notice: (message) => windowManager().focused().browser.annotationNotice(message),
        watch: (listener) => windowManager().onChange(listener),
        load: (target, query) => load(target, { page: 'page-annotate-command', query }),
        preload: join(preloadDir, 'page-annotate-command.js'),
        language: () => getLanguage(),
        changed: () => refreshMenu(),
        // ⌥⌘M system-wide only when the user asks for it; a closed shared window frees the annotation.
        globalToggle: () => sharedStore.get().settings.annotateGlobalShortcut,
        windowOpen: (window) => annotatedBrowser(window) !== undefined,
        // The automatic clearing is a setting (Réglages › Fonctions en option, and the timer button of the bar): read each time, kept nowhere else.
        autoClear: () => autoClearOf(sharedStore.get().settings),
        setAutoClear: (value) => sharedStore.dispatch({ type: 'settings/update', patch: autoClearPatch(value) }),
        reduceMotion: () => sharedStore.get().settings.forceReduceMotion,
        // The keys of one letter (the tools, E and X) act unless the setting says otherwise (Réglages › Fonctions en option): read at each key.
        letterKeys: () => sharedStore.get().settings.annotateLetterKeys
      })
    : null
  sharedStore.subscribe(() => {
    pageAnnotate?.syncToggleShortcut()
    pageAnnotate?.refreshPosition()
    pageAnnotate?.refreshAutoClear()
    pageAnnotate?.refreshLetterKeys()
  })
  return { annotateShare, pageAnnotate }
}
