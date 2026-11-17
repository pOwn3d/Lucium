// Converts the `Bookmarks` file of a Chromium-based browser (they share one format) into a space of pinned tabs and folders.
// The file keeps bookmarks as a tree under `roots`: the bookmarks bar, "other" and mobile bookmarks.

import { t } from '@shared/i18n'
import { importSource } from '@shared/import-sources'
import type { Ctx } from '@shared/sidebar'
import { MAX_BOOKMARK_DEPTH, buildBookmarkSpace, unrecognizedBookmarkImport, type BookmarkGroup, type BookmarkImport, type BookmarkNode } from './bookmark-tree'

export type ChromeImport = BookmarkImport

interface Node {
  type?: unknown
  name?: unknown
  url?: unknown
  children?: unknown
  guid?: unknown
}

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v)
const nameOf = (n: Node, fallback: string): string => (typeof n.name === 'string' && n.name.trim() ? n.name.trim() : fallback)

/** A folder's own identifier, when the file has one fit to be used as an identity. */
const keyOf = (n: Node): string | undefined => (typeof n.guid === 'string' && n.guid !== '' && n.guid.length <= 100 ? n.guid : undefined)

/**
 * `browser` names the space the bookmarks land in: the name the import sheet shows (the application's own, or the generic label);
 * `identity` makes the ids repeatable (see `buildBookmarkSpace`).
 */
export function convertChromeBookmarks(raw: unknown, ctx: Ctx, browser = importSource('chromium')?.name ?? '', identity?: string): ChromeImport {
  const roots = isNode(raw) && isNode((raw as { roots?: unknown }).roots) ? ((raw as { roots: Record<string, unknown> }).roots) : null
  if (!roots) return unrecognizedBookmarkImport()

  let skipped = 0
  const nodes = (children: unknown, depth = 0): BookmarkNode[] => {
    if (!Array.isArray(children)) return []
    // Past the bound the rest of the branch is left out: the walk is recursive, and a hostile file nests as deep as it likes.
    if (depth > MAX_BOOKMARK_DEPTH) {
      skipped += children.length
      return []
    }
    const out: BookmarkNode[] = []
    for (const child of children) {
      if (!isNode(child)) skipped++
      else if (child.type === 'folder') out.push({ kind: 'folder', title: nameOf(child, t('import.dossier-sans-nom')), children: nodes(child.children, depth + 1), ...(keyOf(child) ? { key: keyOf(child)! } : {}) })
      else if (child.type === 'url') out.push({ kind: 'link', title: nameOf(child, String(child.url)), url: String(child.url) })
      else skipped++
    }
    return out
  }

  const groups: BookmarkGroup[] = []
  const bar = roots['bookmark_bar']
  if (isNode(bar)) groups.push({ nodes: nodes(bar.children) })
  for (const [key, label] of [['other', t('import.autres-favoris')], ['synced', t('import.favoris-mobiles')]] as const) {
    const root = roots[key]
    if (isNode(root) && Array.isArray(root.children) && root.children.length > 0) groups.push({ label, nodes: nodes(root.children) })
  }
  return buildBookmarkSpace(ctx, { name: browser, emoji: '🌐', hue: 210 }, groups, skipped, identity)
}
