// What the archive step of the iOS application asks of the folders it embeds (docs/ios.md, sections 6.3 and 10.3).
//
// The filter lists are not committed: a checkout that never ran `node scripts/ios-filter-lists.mjs` builds, runs and passes its tests with the
// short built-in list, which is the right thing for development and the wrong thing to hand to a tester. So `scripts/ios-archive.sh` refuses to
// archive unless the folder is complete, and this file says what "complete" means: the registry reads, it is whole (the Mac's own check of it),
// it names every list the application embeds, and every file it names is there, untouched since it was written and with the number of rules it says.
//
// Pure: the folder comes in as a reader, sentences go out. Loaded by Node with type stripping (scripts/ios-archive/cli.mjs): no enum, no
// parameter property, and the only import is a type, which Node erases.
import { createHash } from 'node:crypto'
import type { Registry } from '../ios-filter-lists/embedded-lists'

/** A folder as the check sees it: the content of a file, or null when it is not there. A read that fails for another reason throws. */
export interface Folder {
  read: (name: string) => string | null
}

export interface ListsCheckOptions {
  /** The ids the application embeds (`EMBEDDED_LIST_IDS`): a folder written with `--only` holds fewer and is refused. */
  expectedIds: readonly string[]
  /** WebKit's limit of rules in one file. */
  ruleLimit: number
  /** The Mac's own check of a registry (`registryProblems` of embedded-lists.ts), handed in: a module Node loads alone cannot import a sibling. */
  registryProblems: (registry: Registry, ruleLimit: number) => string[]
}

/** The registry, in the application. */
export const REGISTRY_FILE = 'filter-lists-registry.json'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** What is wrong with the folder of embedded filter lists, in sentences; empty when an archive may carry it. */
export function filterListsProblems(folder: Folder, options: ListsCheckOptions): string[] {
  const raw = folder.read(REGISTRY_FILE)
  if (raw === null) return [`${REGISTRY_FILE} is missing: this folder holds no filter list`]
  let registry: Registry
  try {
    registry = JSON.parse(raw) as Registry
  } catch (error) {
    return [`${REGISTRY_FILE} is not JSON (${describe(error)})`]
  }
  if (registry === null || typeof registry !== 'object' || !Array.isArray(registry.lists)) return [`${REGISTRY_FILE} has no list of lists`]

  const problems: string[] = []
  try {
    problems.push(...options.registryProblems(registry, options.ruleLimit))
  } catch (error) {
    // A registry whose shape the Mac's check cannot even walk is refused with the reason, not skipped.
    return [`${REGISTRY_FILE} cannot be read as a registry (${describe(error)})`]
  }
  const present = new Set(registry.lists.map((list) => list.id))
  for (const id of options.expectedIds) {
    if (!present.has(id)) problems.push(`the list ${id} is not in the registry (a run with --only?)`)
  }
  for (const list of registry.lists) {
    for (const file of list.files ?? []) {
      const text = folder.read(file.name)
      if (text === null) {
        problems.push(`${file.name} is named by the registry and is not in the folder`)
        continue
      }
      if (sha256(text) !== file.sha256) {
        problems.push(`${file.name} is not the file the registry describes (its SHA-256 differs: cut, edited or from another run)`)
        continue
      }
      let content: unknown
      try {
        content = JSON.parse(text)
      } catch (error) {
        problems.push(`${file.name} is not JSON (${describe(error)})`)
        continue
      }
      if (file.kind === 'scriptlets') {
        const table = content as { schema?: unknown; domains?: unknown } | null
        if (table === null || typeof table !== 'object' || table.schema !== 1 || typeof table.domains !== 'object' || table.domains === null) problems.push(`${file.name} is not a table of scriptlet calls`)
      } else if (!Array.isArray(content)) {
        problems.push(`${file.name} is not a list of rules`)
      } else if (content.length !== file.rules) {
        problems.push(`${file.name} holds ${content.length} rules and the registry says ${file.rules}`)
      }
    }
  }
  return problems
}

/**
 * The files the application must carry beside its code once the folder is whole: the registry and every file it names. Throws when there is no registry
 * to read (an empty answer would make an archive without lists pass for one that has what is asked of it: nothing).
 */
export function embeddedListFileNames(folder: Folder): string[] {
  const raw = folder.read(REGISTRY_FILE)
  if (raw === null) throw new Error(`${REGISTRY_FILE} is missing: there is nothing to compare the archive with`)
  const registry = JSON.parse(raw) as Registry
  return [REGISTRY_FILE, ...registry.lists.flatMap((list) => list.files.map((file) => file.name))]
}

/** The page guard's two files (scripts/ios-guard.mjs, committed): without them the application has no scriptlets and no style sheet for a page. */
export const GUARD_FILES: readonly string[] = ['guard-runtime.js', 'guard-rules.json']

/** What is wrong with the folder of the page guard; empty when it is whole. */
export function guardProblems(folder: Folder): string[] {
  const problems: string[] = []
  for (const name of GUARD_FILES) {
    const text = folder.read(name)
    if (text === null || text.trim() === '') problems.push(`${name} is ${text === null ? 'missing' : 'empty'}: run node scripts/ios-guard.mjs`)
    else if (name.endsWith('.json')) {
      try {
        JSON.parse(text)
      } catch (error) {
        problems.push(`${name} is not JSON (${describe(error)})`)
      }
    }
  }
  return problems
}
