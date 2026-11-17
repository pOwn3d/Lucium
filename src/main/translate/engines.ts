// The engines of the translation. A pack engine turns texts from one language into another using the files of a pack, which have been checked against
// their fingerprints before the engine sees them; the system's engine uses no pack. The registry is injectable: the tests and the engine test give their own.
//
// The engines of this build, in the order they are tried for a pair (`defaultEngines`):
//  - `system` (system.ts), on macOS only: the system's own translation, when the person installed the pair in System Settings (macOS 26 and later).
//    Lucium never downloads its languages: a pair that is not installed goes to the next engine, and the panel says how to install it.
//  - `bergamot` (bergamot.ts): machine translation with Marian models, run locally in WebAssembly. It can translate once its binary has been downloaded (on the
//    user's click, with a first model): until then, and for a pair Mozilla publishes no model of, the glossary of the pair is used if there is one.
//  - `glossary`: a word-for-word substitution from a dictionary file in the pack. It is real and local, and it is not machine translation: the panel says so.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BatchPace, EngineId, PackEngine, PackManifest } from '@shared/translate-local'
import { bergamotEngine } from './bergamot'
import { createMacTranslation, systemHelperFor, type SystemEngine } from './system'

/** A model loaded by an engine. `translate` gets texts of the pack's source language and returns as many of its target language. */
export interface EngineModel {
  translate(texts: readonly string[], signal: AbortSignal): Promise<string[]>
  dispose(): void
  /** How the page is cut for it, and how many batches it is given at once (pass.ts); none: shared/translate-local.ts `DEFAULT_PACE`, one at a time. */
  readonly pace?: BatchPace
}

/** What an engine may need besides the pack: the folder of the engine's own files (the Bergamot binary), fixed by the main process. */
export interface EngineContext {
  runtimeDir: string
}

export interface TranslationEngine {
  readonly id: PackEngine
  /** Whether the engine can translate now (its own files are there). An engine without this is always ready. */
  ready?(context: EngineContext): Promise<boolean>
  /**
   * Loads the model of a pack whose files have been verified. Throws with a sentence for the panel when it cannot. `signal`: the stop of the
   * translation this load is for; an engine whose load takes time gives it up then, so that the translation does not hold its turn for nothing.
   */
  load(manifest: PackManifest, dir: string, context: EngineContext, signal?: AbortSignal): Promise<EngineModel>
}

export class EngineRegistry {
  private readonly engines = new Map<PackEngine, TranslationEngine>()

  /** `system`: the system's own translation, tried before any pack (null: this system or this build has none). */
  constructor(
    engines: readonly TranslationEngine[] = [],
    readonly system: SystemEngine | null = null
  ) {
    for (const engine of engines) this.register(engine)
  }

  /** Every engine, in the order they are tried: the system's first, then the packs' (shared/translate-local.ts `ENGINE_PREFERENCE`). */
  order(): EngineId[] {
    return [...(this.system ? (['system'] as const) : []), ...this.ids()]
  }

  register(engine: TranslationEngine): void {
    this.engines.set(engine.id, engine)
  }

  get(id: PackEngine): TranslationEngine | undefined {
    return this.engines.get(id)
  }

  ids(): PackEngine[] {
    return [...this.engines.keys()]
  }

  /** The engines that can translate now. An engine that cannot say is taken as not ready, and the failure is logged. */
  async ready(context: EngineContext): Promise<PackEngine[]> {
    const ready: PackEngine[] = []
    for (const [id, engine] of this.engines) {
      try {
        if (!engine.ready || (await engine.ready(context))) ready.push(id)
      } catch (error) {
        console.warn(`[translate] the engine ${id} cannot say whether it is ready:`, error instanceof Error ? error.message : String(error))
      }
    }
    return ready
  }
}

// ---------- the glossary ----------

export const GLOSSARY_LIMITS = { bytes: 5 * 1024 * 1024, entries: 100_000, wordChars: 100 } as const

/** A dictionary file: `{ "entries": { "bonjour": "hello" } }`. Anything else is refused. */
export function parseGlossary(raw: unknown): Map<string, string> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const entries = (raw as { entries?: unknown }).entries
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) return null
  const pairs = Object.entries(entries)
  if (pairs.length === 0 || pairs.length > GLOSSARY_LIMITS.entries) return null
  const map = new Map<string, string>()
  for (const [word, translation] of pairs) {
    if (word.length === 0 || word.length > GLOSSARY_LIMITS.wordChars || typeof translation !== 'string' || translation.length > GLOSSARY_LIMITS.wordChars || /\p{Cc}/u.test(translation)) return null
    map.set(word.toLowerCase(), translation)
  }
  return map
}

/** The case of a word kept on its replacement: "Bonjour" gives "Hello", "BONJOUR" gives "HELLO". */
function withCaseOf(original: string, replacement: string): string {
  if (original.length > 1 && original === original.toUpperCase() && original !== original.toLowerCase()) return replacement.toUpperCase()
  const first = original[0]!
  return first !== first.toLowerCase() && first === first.toUpperCase() ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement
}

export function translateWords(glossary: ReadonlyMap<string, string>, text: string): string {
  return text.replace(/\p{L}[\p{L}\p{M}'’-]*/gu, (word) => {
    const found = glossary.get(word.toLowerCase())
    return found === undefined ? word : withCaseOf(word, found)
  })
}

export const glossaryEngine: TranslationEngine = {
  id: 'glossary',
  async load(manifest, dir) {
    const file = manifest.files.find((entry) => entry.role === 'glossary')
    if (!file) throw new Error('glossary')
    const text = await readFile(join(dir, file.name), 'utf8')
    if (text.length > GLOSSARY_LIMITS.bytes) throw new Error('glossary-size')
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      throw new Error('glossary-json')
    }
    const glossary = parseGlossary(raw)
    if (!glossary) throw new Error('glossary-shape')
    return {
      translate: async (texts, signal) => {
        if (signal.aborted) throw new Error('stopped')
        return texts.map((text) => translateWords(glossary, text))
      },
      dispose: () => glossary.clear()
    }
  }
}

/** Where the system's engine finds its helper (null: none in this build), and the version of the system. Read at each request, never before one. */
export interface SystemEngineHost {
  locate: () => string | null
  systemVersion: () => string
}

/**
 * The system's own translation, by system: macOS has one (Apple's Translation framework, through the helper of Contents/Helpers/). Windows and Linux
 * have none in this build: a Windows engine of its own would be returned here; until then Bergamot is the first engine there.
 */
export function systemEngineFor(platform: NodeJS.Platform, host: SystemEngineHost): SystemEngine | null {
  if (platform === 'darwin') {
    return createMacTranslation({
      runner: () => {
        const helper = host.locate()
        return helper ? systemHelperFor(helper) : null
      },
      systemVersion: host.systemVersion
    })
  }
  return null
}

const NO_HOST: SystemEngineHost = { locate: () => null, systemVersion: () => '' }

/** The engines of this build: the system's translation first (macOS), then the machine translation, then the glossary (shared/translate-local.ts `usablePacks`). */
export const defaultEngines = (platform: NodeJS.Platform = process.platform, host: SystemEngineHost = NO_HOST): EngineRegistry =>
  new EngineRegistry([bergamotEngine, glossaryEngine], systemEngineFor(platform, host))

let active: EngineRegistry | null = null

/** The engines the panel uses, made at its first request with the host the main process gives (translate-ipc.ts); the engine test registers its own. */
export const translationEngines = (host: SystemEngineHost = NO_HOST): EngineRegistry => (active ??= defaultEngines(process.platform, host))
