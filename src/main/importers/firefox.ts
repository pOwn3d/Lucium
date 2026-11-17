// Converts Firefox's bookmarks (table moz_bookmarks joined with moz_places in places.sqlite) into a space. The rows are read by
// sqlite.ts; this file only builds the tree. Firefox numbers its fixed roots: 2 menu, 3 toolbar, 4 tags, 5 other, 6 mobile. The tags root (4) is left out: it lists every tagged page again.

import { t } from '@shared/i18n'
import { importSource } from '@shared/import-sources'
import type { Ctx } from '@shared/sidebar'
import { MAX_BOOKMARK_DEPTH, buildBookmarkSpace, unrecognizedBookmarkImport, type BookmarkGroup, type BookmarkImport, type BookmarkNode } from './bookmark-tree'

/** One row of moz_bookmarks, with the address of its place when it is a bookmark. */
export interface FirefoxBookmarkRow {
  id: number
  /** 1 bookmark, 2 folder, 3 separator. */
  type: number
  parent: number
  position: number
  title: string | null
  url: string | null
}

const ROOT_MENU = 2
const ROOT_TOOLBAR = 3
const ROOT_OTHER = 5
const ROOT_MOBILE = 6
// A function, not a constant: the labels are read when the import runs, in the language the interface has then.
const labelled = (): Array<[number, string]> => [[ROOT_MENU, t('import.menu-des-favoris')], [ROOT_OTHER, t('import.autres-favoris')], [ROOT_MOBILE, t('import.favoris-mobiles')]]

/**
 * `name` is the space the bookmarks land in: the name the import sheet shows (the application's own, or the generic label);
 * `identity` makes the ids repeatable (see `buildBookmarkSpace`).
 */
export function convertFirefoxBookmarks(rows: readonly FirefoxBookmarkRow[], ctx: Ctx, name = importSource('firefox')?.name ?? '', identity?: string): BookmarkImport {
  // moz_bookmarks always holds the fixed roots: a table without a row is not one a browser wrote.
  if (rows.length === 0) return unrecognizedBookmarkImport()
  const children = new Map<number, FirefoxBookmarkRow[]>()
  for (const row of rows) {
    const siblings = children.get(row.parent)
    // Pushing, not copying the list: a folder of 60 000 bookmarks took seconds to read otherwise.
    if (siblings) siblings.push(row)
    else children.set(row.parent, [row])
  }
  for (const list of children.values()) list.sort((a, b) => a.position - b.position)

  let skipped = 0
  const seen = new Set<number>()
  const nodes = (parent: number, depth = 0): BookmarkNode[] => {
    const out: BookmarkNode[] = []
    const rows = children.get(parent) ?? []
    // The walk is recursive: a chain of folders as long as the file allows must not run the stack out.
    if (depth > MAX_BOOKMARK_DEPTH) {
      skipped += rows.length
      return out
    }
    for (const row of rows) {
      // A hand-edited or damaged file could point a folder at itself.
      if (seen.has(row.id)) continue
      seen.add(row.id)
      if (row.type === 2) out.push({ kind: 'folder', title: row.title ?? '', children: nodes(row.id, depth + 1) })
      else if (row.type === 1 && row.url) out.push({ kind: 'link', title: row.title ?? '', url: row.url })
      else if (row.type !== 3) skipped++
    }
    return out
  }

  const groups: BookmarkGroup[] = [
    { nodes: nodes(ROOT_TOOLBAR) },
    ...labelled().map(([id, label]): BookmarkGroup => ({ label, nodes: nodes(id) }))
  ]
  return buildBookmarkSpace(ctx, { name, emoji: '🦊', hue: 25 }, groups, skipped, identity)
}
