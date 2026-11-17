// The layout of a context menu in blocks (the same entries, set in blocks): a menu is a list of blocks, each with a discreet title,
// and this module turns the list into the rows a native menu shows. Pure and generic over the kind of entry, so it knows nothing of Electron:
// the shell hands it its own menu items and puts the rows back into a template (src/main/shell/context-menus.ts).
//
// What it guarantees, whatever the blocks a menu happens to have (an entry that depends on a setting leaves its block empty when the setting is off):
//  - a block without an entry disappears with its title, so no title ever stands alone;
//  - the destructive blocks (delete, remove, close) come last, in the order they were given, and the other blocks keep theirs;
//  - a menu with headers has no separator between its blocks (the header is the divider); a menu without them (macOS before 14, or another
//    system) puts one separator between two blocks, and none at the start, at the end or twice in a row.

export interface MenuBlock<T> {
  /** The discreet title of the block ("Personnaliser"). A block without one is set apart by a separator, even where headers are shown. */
  title?: string
  /** The block holds what erases or closes: it comes after every other block. */
  destructive?: boolean
  items: readonly T[]
}

export type MenuRow<T> = { kind: 'header'; title: string; destructive: boolean } | { kind: 'separator' } | { kind: 'item'; item: T }

export interface LayoutOptions {
  /** Whether the system can show a section header in a menu (see `menuHeadersSupported`). */
  headers: boolean
}

/** The rows of a menu, from its blocks. */
export function layoutBlocks<T>(blocks: readonly MenuBlock<T>[], { headers }: LayoutOptions): MenuRow<T>[] {
  const filled = blocks.filter((block) => block.items.length > 0)
  const ordered = [...filled.filter((block) => block.destructive !== true), ...filled.filter((block) => block.destructive === true)]
  const rows: MenuRow<T>[] = []
  ordered.forEach((block, index) => {
    const title = block.title?.trim() ?? ''
    if (headers && title !== '') rows.push({ kind: 'header', title, destructive: block.destructive === true })
    else if (index > 0) rows.push({ kind: 'separator' })
    for (const item of block.items) rows.push({ kind: 'item', item })
  })
  return rows
}

/**
 * Whether a native menu can show a section header: macOS 14 and later (Electron's `type: 'header'`). Anything that cannot be read as such a system
 * (another platform, a version that is not a number) gets the separators, which every system draws.
 */
export function menuHeadersSupported(platform: string, systemVersion: string | undefined): boolean {
  if (platform !== 'darwin') return false
  const major = Number.parseInt(String(systemVersion ?? ''), 10)
  return Number.isFinite(major) && major >= 14
}
