// What every browser's bookmarks become in Lucium: one new space, the bookmarks as pinned tabs, the folders as folders (nested
// ones stay nested, as in the sidebar). Each importer only has to describe its tree; the limits and the clean-up are here.

import { createHash } from 'node:crypto'
import { MAX_IMPORTED_FOLDERS, MAX_IMPORTED_LINKS } from '@shared/import-sources'
import type { Folder, Space, TabItem } from '@shared/model'
import { themeFromHue } from '@shared/theme'
import type { Ctx } from '@shared/sidebar'
import { folderName, isWebUrl, linkTitle } from './limits'

/** A link may carry what a Netscape file says beyond its address and name: the tags (`TAGS="a,b"`), the date it was added (seconds) and the note under it (`<DD>`). The sidebar import ignores them. */
export type BookmarkNode =
  | { kind: 'link'; title: string; url: string; tags?: string; addedAt?: number; note?: string }
  /** `key` is the folder's own identifier in the browser (Chrome's `guid`, Safari's `WebBookmarkUUID`): it keeps its identity when it is renamed. */
  | { kind: 'folder'; title: string; children: BookmarkNode[]; key?: string }

/** A set of bookmarks that goes at the root of the space, or into a folder of its own when it has a `label`. */
export interface BookmarkGroup {
  label?: string
  nodes: BookmarkNode[]
}

export interface BookmarkImport {
  spaces: Space[]
  tabs: TabItem[]
  folders: Folder[]
  /** Valid entries left out because of the limit (the sheet says so, apart from what is not a web page). `duplicates` is present when some link appeared twice in a folder. */
  report: { tabs: number; folders: number; skipped: number; overLimit: number; duplicates?: number }
  /** The file is readable but is not a bookmarks file of the browser it came from (another JSON, a page of text): not the same as "no web page in it". */
  unrecognized?: true
}

/**
 * Levels of folders the importers read. A real bookmarks tree is a handful deep; a file nested beyond this is damaged or hostile, and
 * walking it recursively would run the stack out. Each importer cuts its walk here (what is deeper counts as ignored); the folders that
 * are kept are then limited in number, not in depth, by `MAX_IMPORTED_FOLDERS`.
 */
export const MAX_BOOKMARK_DEPTH = 32

/** A bookmark list can hold tens of thousands of entries: more than this is not a sidebar anyone can use. */
export const MAX_BOOKMARKS = MAX_IMPORTED_LINKS

export const emptyBookmarkImport = (skipped = 0, overLimit = 0, duplicates = 0): BookmarkImport => ({
  spaces: [],
  tabs: [],
  folders: [],
  report: { tabs: 0, folders: 0, skipped, overLimit, ...(duplicates > 0 ? { duplicates } : {}) }
})

/** What a file gives that parsed but is not the tree the importer reads: nothing comes in, and the sheet says the file is not one of the browser's. */
export const unrecognizedBookmarkImport = (): BookmarkImport => ({ ...emptyBookmarkImport(), unrecognized: true })

/**
 * `skipped` is what the importer already left out (entries that are neither links nor folders). With an `identity` (what the bookmarks
 * are: the browser and its profile, or the file), the ids are made from it and from where each entry sits, not drawn: importing the same
 * bookmarks again names the same space, folders and tabs the same way, and `import/merge` leaves alone what it already holds. The place is part of the
 * identity: one address in two folders is two bookmarks, so a bookmark that moved to another folder in the browser is a new one on the next import, and the
 * copy already imported stays where it was (import-r22.test.ts). Taking the address alone would merge those two, and bring every bookmark already imported back a second time (their ids carry the folder).
 */
export function buildBookmarkSpace(ctx: Ctx, look: { name: string; emoji: string; hue: number }, groups: BookmarkGroup[], skipped = 0, identity?: string): BookmarkImport {
  const taken = new Set<string>()
  const idOf = (kind: 'space' | 'folder' | 'tab', ...parts: string[]): string => {
    if (identity === undefined) return ctx.newId()
    const base = `bm-${createHash('sha256').update([identity, kind, ...parts].join('\0')).digest('hex').slice(0, 24)}`
    let id = base
    // Two entries that name themselves alike (two folders of one name, a damaged file repeating a guid) stay two entries, told apart by their order.
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    taken.add(id)
    return id
  }
  const space: Space = { id: idOf('space'), name: look.name, emoji: look.emoji, theme: themeFromHue(look.hue), profileId: 'default' }
  const tabs: TabItem[] = []
  const folders: Folder[] = []
  let left = skipped
  let over = 0
  let twice = 0
  // The same address twice in one folder is one bookmark (a browser's own bookmarks bar rarely holds the same link twice, a merged export often does).
  const seen = new Set<string>()

  /** Adds the nodes under `parent`; answers how many links ended up in them. */
  const add = (nodes: BookmarkNode[], parent: string | undefined): number => {
    let links = 0
    for (const node of nodes) {
      if (node.kind === 'link') {
        if (!isWebUrl(node.url)) {
          left++
          continue
        }
        const key = `${parent ?? ''}\n${URL.canParse(node.url) ? new URL(node.url).href : node.url}`
        if (seen.has(key)) {
          twice++
          continue
        }
        // A valid link the limit keeps out is not "ignored": the sheet counts it apart.
        if (tabs.length >= MAX_IMPORTED_LINKS) {
          over++
          continue
        }
        seen.add(key)
        tabs.push({
          id: idOf('tab', parent ?? '', URL.canParse(node.url) ? new URL(node.url).href : node.url),
          spaceId: space.id,
          url: node.url,
          title: linkTitle(node.title, node.url),
          pinned: true,
          anchorUrl: node.url,
          ...(parent ? { folderId: parent } : {}),
          createdAt: ctx.now,
          lastActiveAt: ctx.now
        })
        links++
      } else if (folders.length >= MAX_IMPORTED_FOLDERS) {
        // Too many folders for a sidebar: the links of this one stay where its parent is rather than being lost.
        links += add(node.children, parent)
      } else {
        // Two folders called "Misc" side by side name themselves alike: `idOf` tells them apart by their order.
        const folder: Folder = { id: idOf('folder', ...(node.key ? [node.key] : [parent ?? '', node.title])), spaceId: space.id, name: folderName(node.title), collapsed: true, ...(parent ? { parentId: parent } : {}) }
        const index = folders.push(folder) - 1
        const inside = add(node.children, folder.id)
        // A folder that holds no link, directly or below, leaves nothing behind.
        if (inside === 0) folders.splice(index, 1)
        links += inside
      }
    }
    return links
  }

  for (const group of groups) {
    if (group.label === undefined) {
      add(group.nodes, undefined)
      continue
    }
    add([{ kind: 'folder', title: group.label, children: group.nodes }], undefined)
  }

  if (tabs.length === 0) return emptyBookmarkImport(left, over, twice)
  return { spaces: [space], tabs, folders, report: { tabs: tabs.length, folders: folders.length, skipped: left, overLimit: over, ...(twice > 0 ? { duplicates: twice } : {}) } }
}
