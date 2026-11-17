// Keeps a link or a file dropped on the interface from making it navigate. A document that does not take a drop lets Chromium open
// whatever was dropped, and our pages share the preload: a remote page opened in place of the interface would inherit its API.
// The rule is in @shared/surface-guard; this is the DOM side, to call once from the entry of every page of the interface.

import type { LuciumApi } from '@shared/ipc'
import { LOCAL_FILES_MAX } from '@shared/local-documents'
import { carriesFiles, shouldBlockDrag } from '@shared/surface-guard'

const isEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type !== 'file') || (target instanceof HTMLElement && target.isContentEditable)

/** What marks a part of the interface that takes the files dropped on it by itself (the notes take a .md): no tab opens for a drop there. */
export const TAKES_FILES_ATTRIBUTE = 'data-takes-files'

/** The two calls of the bridge a drop of files needs. A seam for the tests. */
type DropBridge = Pick<LuciumApi, 'pathOfDroppedFile' | 'openLocalFiles'>

/**
 * Cancels the drags and drops that did not start in our own interface. Capture phase, so nothing in the page can let one through.
 *
 * A file of the disk is the exception that does something: it opens in a tab of the main window, by the main process, which checks the path. The page never
 * navigates (the drop is cancelled all the same); and not over a field of text, nor a part of the interface that takes files itself.
 */
export function lockDocumentDrops(target: Document = document, bridge: () => DropBridge | undefined = () => window.lucium): void {
  const refused = (event: DragEvent): boolean => shouldBlockDrag(Array.from(event.dataTransfer?.types ?? []), isEditable(event.target))
  const opensInTab = (event: DragEvent): boolean =>
    carriesFiles(Array.from(event.dataTransfer?.types ?? [])) && !isEditable(event.target) && !(event.target instanceof Element && event.target.closest(`[${TAKES_FILES_ATTRIBUTE}]`) !== null)
  target.addEventListener(
    'dragover',
    (event) => {
      if (!refused(event)) return
      event.preventDefault()
      // The sidebar sets its own effect afterwards for a drag of its own: only a foreign drag keeps this one.
      if (event.dataTransfer) event.dataTransfer.dropEffect = opensInTab(event) ? 'copy' : 'none'
    },
    true
  )
  target.addEventListener(
    'drop',
    (event) => {
      if (!refused(event)) return
      event.preventDefault()
      if (!opensInTab(event)) return
      const api = bridge()
      if (!api) return
      // One more than the ceiling: the main process counts what it leaves out, and says so.
      const paths = Array.from(event.dataTransfer?.files ?? [])
        .slice(0, LOCAL_FILES_MAX + 1)
        .map((file) => api.pathOfDroppedFile(file))
        .filter((path) => path !== '')
      if (paths.length > 0) api.openLocalFiles(paths)
    },
    true
  )
}
