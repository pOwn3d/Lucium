// The names of the browsers installed on this Mac, as their own bundles give them (`CFBundleDisplayName` and `CFBundleName` of
// `Contents/Info.plist`). The import sheet shows the name the system knows each application by: Lucium writes no other browser's name
// itself, and a browser whose application cannot be found keeps the generic label of shared/import-sources.ts.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parsePlist } from '@shared/plist'
import { printable } from '@shared/state-clean'

/** Biggest `Info.plist` read: the real ones weigh a few kilobytes, and the folders are read each time the import sheet opens. */
export const MAX_INFO_PLIST_BYTES = 1024 * 1024

/** Longest name kept: the real ones are a word or three, and the sheet shows it as a title. */
export const APP_NAME_MAX = 80

/** Most entries read in one folder of applications: a folder with more is not a list of applications anyone installed by hand. */
const MAX_ENTRIES = 2000

const IDENTIFIER = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]{1,255})<\/string>/

/** How an application names itself: in full where it is shown (the Finder, the import sheet), and in short (a space of imported bookmarks). */
export interface AppName {
  /** `CFBundleDisplayName`, else `CFBundleName`. */
  display: string
  /** `CFBundleName`, else `CFBundleDisplayName`. */
  short: string
}

/** The names of the application whose `Info.plist` this is, when its identifier is one of `wanted`; null otherwise. */
function nameIn(plistPath: string, wanted: ReadonlySet<string>): ({ id: string } & AppName) | null {
  try {
    const info = statSync(plistPath)
    if (!info.isFile() || info.size > MAX_INFO_PLIST_BYTES) return null
    const text = readFileSync(plistPath, 'utf8')
    // A binary property list would need `plutil` (a process per application): its browser keeps the generic label.
    const id = IDENTIFIER.exec(text)?.[1]?.trim()
    if (!id || !wanted.has(id)) return null
    const dict = parsePlist(text)
    if (typeof dict !== 'object' || dict === null || Array.isArray(dict) || dict instanceof Date) return null
    // Written by another program: one line, bounded.
    const read = (key: string): string | undefined => printable(dict[key], APP_NAME_MAX)?.trim() || undefined
    const display = read('CFBundleDisplayName') ?? read('CFBundleName')
    if (display === undefined) return null
    return { id, display, short: read('CFBundleName') ?? display }
  } catch {
    // Unreadable or damaged: the browser keeps the generic label.
    return null
  }
}

/**
 * Bundle identifier → names, for the applications of these folders (`/Applications`, `~/Applications`) whose identifier is wanted. The
 * first folder wins when the same application is in two. Only the top level of each folder is read, as the Finder lists it.
 */
export function installedAppNames(folders: readonly string[], wanted: ReadonlySet<string>): Map<string, AppName> {
  const names = new Map<string, AppName>()
  if (wanted.size === 0) return names
  for (const folder of folders) {
    let entries: string[]
    try {
      entries = readdirSync(folder)
    } catch {
      // No such folder (no ~/Applications, another system): no name comes from it, and the browsers it would have named keep their label.
      continue
    }
    for (const entry of entries.slice(0, MAX_ENTRIES)) {
      if (!entry.endsWith('.app')) continue
      const found = nameIn(join(folder, entry, 'Contents', 'Info.plist'), wanted)
      if (found && !names.has(found.id)) names.set(found.id, { display: found.display, short: found.short })
    }
  }
  return names
}
