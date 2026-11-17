// Keeps a link or a file dropped on the interface from making it navigate. A document that does not take a drop lets Chromium open
// whatever was dropped, and our pages share the preload: a remote page opened in place of the interface would inherit its API.
// The rule is in @shared/surface-guard; this is the DOM side, to call once from the entry of every page of the interface.

import type { LuciumApi } from '@shared/ipc'
import { DROPPED_LINKS_TEXT_MAX } from '@shared/dropped-links'
import { LOCAL_FILES_MAX } from '@shared/local-documents'
import { carriesFiles, shouldBlockDrag } from '@shared/surface-guard'

const isEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type !== 'file') || (target instanceof HTMLElement && target.isContentEditable)

/** What marks a part of the interface that takes the files dropped on it by itself (the notes take a .md): no tab opens for a drop there. */
export const TAKES_FILES_ATTRIBUTE = 'data-takes-files'

/**
 * The calls of the bridge a drop needs. A seam for the tests. The link is optional: the Extensions page, when it is a tab, is given a few calls of the bridge and
 * not that one, and a link dropped there is cancelled and goes no further.
 */
type DropBridge = Pick<LuciumApi, 'pathOfDroppedFile' | 'openLocalFiles'> & Partial<Pick<LuciumApi, 'openDroppedLinks'>>

/** The data types a link comes in when another application drags it (a browser, a mail, a terminal): the list of addresses, else the text. */
const LINK_TYPES = ['text/uri-list', 'text/plain'] as const

/** What a drag from outside does besides being refused: files open in tabs, a link opens in a tab, anything else does nothing. */
type DropUse = 'files' | 'link' | 'nothing'

/** The text of a dropped link, as it came (the main process reads it again), or '' when the drop carries none. Cut one character past the ceiling: it is what tells the main process the text was too long. */
function droppedLinkText(data: DataTransfer | null): string {
  for (const type of LINK_TYPES) {
    const text = data?.getData(type) ?? ''
    if (text.trim() !== '') return text.slice(0, DROPPED_LINKS_TEXT_MAX + 1)
  }
  return ''
}

/**
 * Cancels the drags and drops that did not start in our own interface. Capture phase, so nothing in the page can let one through.
 *
 * What comes from outside does something in two cases, both by the main process, which checks what it is sent: a file of the disk opens in a tab, and so does a
 * link another application drops (its text is sent, and read again there: the interface does not look at it). The page never navigates (the drop is cancelled
 * first and all the same); and nothing opens over a field of text, nor a part of the interface that takes the drop itself. Any other text is only refused.
 */
export function lockDocumentDrops(target: Document = document, bridge: () => DropBridge | undefined = () => window.lucium): void {
  const refused = (event: DragEvent): boolean => shouldBlockDrag(Array.from(event.dataTransfer?.types ?? []), isEditable(event.target))
  const useOf = (event: DragEvent): DropUse => {
    const types = Array.from(event.dataTransfer?.types ?? [])
    if (isEditable(event.target) || (event.target instanceof Element && event.target.closest(`[${TAKES_FILES_ATTRIBUTE}]`) !== null)) return 'nothing'
    // A drag that carries files is the files': some applications put the address of the file beside it.
    if (carriesFiles(types)) return 'files'
    return LINK_TYPES.some((type) => types.includes(type)) ? 'link' : 'nothing'
  }
  target.addEventListener(
    'dragover',
    (event) => {
      if (!refused(event)) return
      event.preventDefault()
      // The sidebar sets its own effect afterwards for a drag of its own: only a foreign drag keeps this one.
      if (event.dataTransfer) event.dataTransfer.dropEffect = useOf(event) === 'nothing' ? 'none' : 'copy'
    },
    true
  )
  target.addEventListener(
    'drop',
    (event) => {
      if (!refused(event)) return
      event.preventDefault()
      const use = useOf(event)
      if (use === 'nothing') return
      const api = bridge()
      if (!api) return
      if (use === 'link') {
        const text = droppedLinkText(event.dataTransfer)
        if (text !== '') api.openDroppedLinks?.(text)
        return
      }
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
