// Converts Safari's Bookmarks.plist (already parsed, see shared/plist.ts) into a space. Safari keeps a tree under `Children`:
// "BookmarksBar" (Favorites bar), "BookmarksMenu", the reading list, and proxies for History and Top Sites.

import { t } from '@shared/i18n'
import { importSource } from '@shared/import-sources'
import type { Ctx } from '@shared/sidebar'
import type { PlistValue } from '@shared/plist'
import { MAX_BOOKMARK_DEPTH, buildBookmarkSpace, unrecognizedBookmarkImport, type BookmarkGroup, type BookmarkImport, type BookmarkNode } from './bookmark-tree'

type Dict = { [key: string]: PlistValue }
// Not shared/record.ts: a property list holds dates, which are objects but not dictionaries.
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)
const text = (v: PlistValue | undefined): string => (typeof v === 'string' ? v.trim() : '')

/** `identity` makes the ids repeatable (see `buildBookmarkSpace`); `name` is the space the bookmarks land in, the name the import sheet shows. */
export function convertSafariBookmarks(raw: unknown, ctx: Ctx, identity?: string, name = importSource('safari')?.name ?? ''): BookmarkImport {
  if (!isDict(raw) || !Array.isArray(raw['Children'])) return unrecognizedBookmarkImport()

  let skipped = 0
  const nodes = (children: PlistValue | undefined, depth = 0): BookmarkNode[] => {
    if (!Array.isArray(children)) return []
    // The walk is recursive: a property list nested as deep as it likes must not run the stack out.
    if (depth > MAX_BOOKMARK_DEPTH) {
      skipped += children.length
      return []
    }
    const out: BookmarkNode[] = []
    for (const child of children) {
      if (!isDict(child)) skipped++
      else if (child['WebBookmarkType'] === 'WebBookmarkTypeList') out.push({ kind: 'folder', title: text(child['Title']), children: nodes(child['Children'], depth + 1), ...(text(child['WebBookmarkUUID']) && text(child['WebBookmarkUUID']).length <= 100 ? { key: text(child['WebBookmarkUUID']) } : {}) })
      else if (child['WebBookmarkType'] === 'WebBookmarkTypeLeaf') {
        const title = isDict(child['URIDictionary']) ? text(child['URIDictionary']['title']) : ''
        out.push({ kind: 'link', title, url: text(child['URLString']) })
      } else skipped++
    }
    return out
  }

  const groups: BookmarkGroup[] = []
  for (const root of raw['Children']) {
    if (!isDict(root)) continue
    const title = text(root['Title'])
    // The proxies (History, Top Sites) hold no bookmark of their own.
    if (root['WebBookmarkType'] !== 'WebBookmarkTypeList') continue
    if (title === 'BookmarksBar') groups.push({ nodes: nodes(root['Children']) })
    else if (title === 'BookmarksMenu') groups.push({ label: t('import.safari-favoris'), nodes: nodes(root['Children']) })
    else if (title === 'com.apple.ReadingList') groups.push({ label: t('import.safari-liste-de-lecture'), nodes: nodes(root['Children']) })
    else groups.push({ label: title || t('import.dossier-sans-nom'), nodes: nodes(root['Children']) })
  }
  return buildBookmarkSpace(ctx, { name, emoji: '🧭', hue: 205 }, groups, skipped, identity)
}
