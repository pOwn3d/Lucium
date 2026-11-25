// IPC of the resource panel of the sidebar (shared/resources.ts, the function `resource-gauge`): a panel that opens or closes, and its buttons.
// Registered for each window with the window's own scoped IPC and guard (see registerIpc). The figures are measured once for the whole group by
// the watch of the main window (shell/resource-watch.ts) and drawn for each open panel from its own window (where its tabs are said from).

import type { WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import type { RawProcess } from '@shared/processes'
import { parseResourceAction, resourceReport, type ReleaseOutcome, type ReleasePreview, type ResourceActionReply, type ResourceTab } from '@shared/resources'
import type { ReleaseLevel } from '@shared/sleep'
import type { ScopedIpc } from './ipc-scope'
import type { ResourceWatch } from './resource-watch'

/** What the panel needs of the browser of its window (Browser has it all; a test gives a fake). */
export interface ResourceHost {
  /** The watch of the group, while the function is on (null when it is off, and in a private window). */
  resources(): ResourceWatch | null
  /** The awake tabs of every window of the group with the figures of their page's process (and the process of each), said from this window, and what each strength of « Libérer maintenant » would free. */
  resourceTabs(raw: readonly RawProcess[]): { tabs: ResourceTab[]; levels: ReleasePreview[]; pids: ReadonlyMap<string, number> }
  sleepTabAnywhere(tabId: string): Promise<boolean>
  closeTabAnywhere(tabId: string): boolean
  showTabAnywhere(tabId: string): boolean
  /** « Libérer maintenant » at this strength, over every window of the group. */
  releaseLevel(level: ReleaseLevel): Promise<ReleaseOutcome>
  /** « Annuler »: wakes the tabs of the last run that are still asleep; resolves how many. */
  undoRelease(): Promise<number>
}

/** The part of a web contents an open panel holds on to. */
type Viewer = Pick<WebContents, 'id' | 'isDestroyed' | 'send' | 'once' | 'removeListener'>

let taskManagerOpener: (() => void) | null = null

/** How « Gestionnaire complet… » opens the task manager: set once by the application (index.ts), which owns its window. */
export function setTaskManagerOpener(open: (() => void) | null): void {
  taskManagerOpener = open
}

/** Registers the two channels of the panel for a window; returns what lets go of the panels this window still has open (it is closing). */
export function registerResourceIpc(ipcMain: ScopedIpc, guard: (sender: WebContents, channel: string) => boolean, browser: ResourceHost): () => void {
  /** The panels open in this window, by web contents: what closes each one (its listeners off, its place in the watch freed). */
  const open = new Map<number, () => void>()
  const closeViewer = (id: number): void => {
    const undo = open.get(id)
    open.delete(id)
    undo?.()
  }

  ipcMain.on(Channel.resourcePanel, (e, wanted: unknown) => {
    // Closing is never refused (a panel that goes must not leave the refresh running); opening is the guard's, and the function's.
    if (wanted !== true) return closeViewer(e.sender.id)
    if (!guard(e.sender, Channel.resourcePanel)) return
    const watch = browser.resources()
    if (!watch) return console.warn('[resources] a panel was refused: the gauge is off (Réglages › Apparence)')
    const sender = e.sender as Viewer
    if (open.has(sender.id)) return watch.refresh()
    // The page of the interface that goes (closed, reloaded) takes its panel with it.
    const drop = (): void => closeViewer(sender.id)
    sender.once('destroyed', drop)
    sender.once('did-start-loading', drop)
    open.set(sender.id, () => {
      if (!sender.isDestroyed()) {
        sender.removeListener('destroyed', drop)
        sender.removeListener('did-start-loading', drop)
      }
      watch.close(sender.id)
    })
    watch.open(sender.id, {
      show: (raw, gauge) => {
        if (sender.isDestroyed()) return false
        const { tabs, levels, pids } = browser.resourceTabs(raw)
        sender.send(Channel.resources, resourceReport(raw, tabs, levels, gauge, pids))
        return true
      }
    })
  })

  ipcMain.handle(Channel.resourceAction, async (e, raw: unknown): Promise<ResourceActionReply> => {
    if (!guard(e.sender, Channel.resourceAction)) return null
    const watch = browser.resources()
    if (!watch) return null
    const action = parseResourceAction(raw)
    if (!action) {
      console.warn('[resources] an action of the panel that is not one was refused')
      return null
    }
    switch (action.kind) {
      case 'sleep': {
        const done = await browser.sleepTabAnywhere(action.tabId)
        watch.refresh()
        return { done }
      }
      case 'close': {
        const done = browser.closeTabAnywhere(action.tabId)
        watch.refresh()
        return { done }
      }
      case 'show':
        browser.showTabAnywhere(action.tabId)
        return null
      case 'sleep-level': {
        // An error is said with its context (never a title or an address) and the panel answers that it could not be done.
        const released = await browser.releaseLevel(action.level).catch((error: unknown) => {
          console.warn(`[resources] « Libérer maintenant » at the level ${action.level} failed:`, error instanceof Error ? error.message : String(error))
          return null
        })
        watch.refresh()
        return released ? { released } : null
      }
      case 'undo-level': {
        const woken = await browser.undoRelease().catch((error: unknown) => {
          console.warn('[resources] « Annuler » after « Libérer maintenant » failed:', error instanceof Error ? error.message : String(error))
          return null
        })
        watch.refresh()
        return woken === null ? null : { woken }
      }
      case 'task-manager':
        if (taskManagerOpener) taskManagerOpener()
        else console.warn('[resources] the task manager cannot be opened from this window')
        return null
    }
  })

  return () => {
    for (const id of [...open.keys()]) closeViewer(id)
  }
}
