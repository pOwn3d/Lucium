// The translations of this session, kept in memory so that a text met again is not translated again: the menus and footers a site repeats on every
// page, and a page shown in its original then translated again (« Afficher l'original », then « Traduire »), which then comes back at once.
//
// Rules it keeps (memory.test.ts, pass.test.ts):
//  - memory only: nothing of it is ever written to disk, and it is gone when Lucium quits;
//  - bounded: at most `entries` translations and `chars` characters (the texts and their translations), the least recently used ones forgotten first;
//  - a translation is kept for the way it was made (the route: the engine and the pair, or the packs, their versions and their files): another
//    engine, another version of a model, or other files under the same version (a pack placed by hand is always version 1), translates again;
//  - nothing of a private page: a private window, or a private tab, neither reads it nor adds to it (controller.ts `memoryFor`);
//  - site by site: the route a page is given carries its origin (`memoryFor`), so a site never meets what was translated on another one;
//  - emptied with what was browsed: the data of a profile or of a site, the history (shell/translation-traces.ts).

import { createHash } from 'node:crypto'

/** A pack as a route names it: its engine, its folder, its version, and the fingerprints its manifest gives for its files. */
export interface RoutePack {
  engine: string
  folder: string
  version: string
  files: ReadonlyArray<{ sha256: string }>
}

/**
 * The route of a translation made by these packs, in order. The fingerprints of the files are part of it: a model replaced under the same
 * version must not be answered with what the previous one translated.
 */
export function packRoute(packs: readonly RoutePack[]): string {
  return packs.map((pack) => `${pack.engine}:${pack.folder}@${pack.version}#${createHash('sha256').update(pack.files.map((file) => file.sha256).sort().join(',')).digest('hex').slice(0, 16)}`).join('|')
}

/** About 20 000 translations, and 2 000 000 characters (some 4 MB of text at most). */
export const TRANSLATION_MEMORY_LIMITS = { entries: 20_000, chars: 2_000_000 } as const

/** The memory of one route, as a translation of a page uses it. */
export interface RouteMemory {
  get(text: string): string | undefined
  set(text: string, translation: string): void
}

export class TranslationMemory {
  private readonly entries = new Map<string, string>()
  private chars = 0

  constructor(private readonly limits: { entries: number; chars: number } = TRANSLATION_MEMORY_LIMITS) {}

  private static key(route: string, text: string): string {
    return `${route}\u0000${text}`
  }

  /** The translation of `text` by `route`, if it is kept; it is then the most recently used. */
  get(route: string, text: string): string | undefined {
    const key = TranslationMemory.key(route, text)
    const found = this.entries.get(key)
    if (found !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, found)
    }
    return found
  }

  /** Keeps a translation, and forgets the least recently used ones beyond the bounds (THE BOUND of the memory). */
  set(route: string, text: string, translation: string): void {
    const key = TranslationMemory.key(route, text)
    const cost = key.length + translation.length
    if (cost > this.limits.chars) return
    const before = this.entries.get(key)
    if (before !== undefined) {
      this.entries.delete(key)
      this.chars -= key.length + before.length
    }
    this.entries.set(key, translation)
    this.chars += cost
    while (this.entries.size > this.limits.entries || this.chars > this.limits.chars) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.chars -= oldest.value.length + (this.entries.get(oldest.value)?.length ?? 0)
      this.entries.delete(oldest.value)
    }
  }

  /** The memory of one route. */
  of(route: string): RouteMemory {
    return { get: (text) => this.get(route, text), set: (text, translation) => this.set(route, text, translation) }
  }

  clear(): void {
    this.entries.clear()
    this.chars = 0
  }

  get size(): number {
    return this.entries.size
  }

  /** The characters kept (texts, translations and routes). */
  get weight(): number {
    return this.chars
  }
}

/** The memory of this session, shared by the windows that are not private (shell/translate-ipc.ts) and kept apart for each site by the controller. */
export const sessionTranslations = new TranslationMemory()
