// A sandboxed preload cannot require() another file: each one is built whole, with everything its imports reach. So what a preload imports is
// what every document it runs in reads and compiles, and none of them may reach the catalogues of the interface's texts (nearly a megabyte for
// the two languages). The imports are followed in the sources, the way the bundler follows them: relative paths and the `@shared` alias.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { posix } from '../main/windows.test-support'

const root = join(__dirname, '../..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

/** The file an import names: `./x`, `../x` or `@shared/x`, as a `.ts` file or the index of a folder. Null for a package. */
function resolved(from: string, name: string): string | null {
  const base = name.startsWith('@shared/') ? join(root, 'src/shared', name.slice('@shared/'.length)) : name.startsWith('.') ? join(dirname(from), name) : null
  if (base === null) return null
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) if (existsSync(candidate)) return candidate
  throw new Error(`${relative(root, from)} imports ${name}, which this test cannot find: teach it the form of that import`)
}

/** The modules a file imports at run time: `import type` and `export type` are erased by the compiler, and so is an import of types only. */
function runtimeImports(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const found: string[] = []
  // `import x from`, `import { a, b } from` (on several lines too), `import * as x from`, `export { a } from`, `export * from`: the clause holds names only.
  for (const match of source.matchAll(/^(?:import|export)\s+(type\s+)?([\w$*{}\s,]*?)\s*from\s+['"]([^'"]+)['"]/gm)) {
    const [, typeOnly, clause, name] = match
    if (typeOnly) continue
    const names = /^\{([^}]*)\}$/.exec(clause!.trim())?.[1]
    if (names !== undefined && names.split(',').every((part) => part.trim() === '' || part.trim().startsWith('type '))) continue
    const target = resolved(file, name!)
    if (target) found.push(target)
  }
  // `import './x'`: a module imported for what it does.
  for (const match of source.matchAll(/^import\s+['"]([^'"]+)['"]/gm)) {
    const target = resolved(file, match[1]!)
    if (target) found.push(target)
  }
  return found
}

/** Every source file a preload is built from, relative to `src`. */
function closure(entry: string): string[] {
  const seen = new Set<string>()
  const walk = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    for (const next of runtimeImports(file)) walk(next)
  }
  walk(entry)
  return [...seen].map((file) => posix(relative(join(root, 'src'), file))).sort()
}

/** The preloads the build makes, read from its configuration: a preload added there is checked here without a line to write. */
function preloadEntries(): string[] {
  const config = read('electron.vite.config.ts')
  const preload = config.slice(config.indexOf('preload: {'), config.indexOf('renderer: {'))
  return [...preload.matchAll(/resolve\(__dirname, '(src\/preload\/[^']+\.ts)'\)/g)].map((m) => m[1]!)
}

const reachesTexts = (files: readonly string[]): string[] => files.filter((file) => /^shared\/i18n/.test(file))

describe('the preload scripts', () => {
  it('are built one file each, with no chunk shared between them', () => {
    const config = read('electron.vite.config.ts')
    const preload = config.slice(config.indexOf('preload: {'), config.indexOf('renderer: {'))
    expect(preload).toMatch(/isolatedEntries:\s*true/)
  })

  it('do not carry the catalogues of i18n through the scriptlets of the page guard', () => {
    expect(read('src/shared/scriptlets.ts')).not.toMatch(/^import \{[^}]*\} from '\.\/i18n'/m)
  })

  it('are all known to this test', () => {
    expect(preloadEntries()).toContain('src/preload/extension-shims.ts')
    expect(preloadEntries().length).toBeGreaterThanOrEqual(10)
  })

  /**
   * The preloads whose sources reach the catalogues through a module they take one or two constants from (media-player.ts, passwords.ts, the
   * module of the dialog bridge). The bundler leaves the catalogues out today, because nothing these preloads use calls a text: measured on the
   * build (4 KB or less each, no text of the interface in them). That holds only as long as it does: the day one of them uses a function that
   * translates, the megabyte comes in. They are named here so that the list can only get shorter, and no other preload joins it unseen.
   */
  const REACH_THE_TEXTS_IN_SOURCE = ['src/preload/dialog-bridge.ts', 'src/preload/media-bridge.ts', 'src/preload/password-bridge.ts']

  it.each(preloadEntries().filter((entry) => !REACH_THE_TEXTS_IN_SOURCE.includes(entry)))('%s reaches no catalogue of the texts of the interface, whatever the form of its imports', (entry) => {
    const texts = reachesTexts(closure(join(root, entry)))
    expect(texts, `${entry} would be built with ${texts.join(', ')}`).toEqual([])
  })

  it('the preloads that reach the catalogues in their sources are the three known ones, and no other', () => {
    expect(preloadEntries().filter((entry) => reachesTexts(closure(join(root, entry))).length > 0).sort()).toEqual(REACH_THE_TEXTS_IN_SOURCE)
  })

  it('the one that runs in every worker and page of an extension is made of a few small files', () => {
    expect(closure(join(root, 'src/preload/extension-shims.ts'))).toEqual([
      'preload/extension-shims.ts',
      'preload/lent-tab-agent.ts',
      'preload/sender-tab.ts',
      'shared/chrome-compat.ts',
      'shared/clamp.ts',
      'shared/extension-access.ts',
      'shared/extension-data-api.ts',
      // Read for the address of the Extensions page that extensions are told (extension-access.ts); the bundler leaves out what the preload does not call.
      'shared/internal-page.ts',
      'shared/ipc-channels.ts',
      // The two messages a script of a lent tab is answered with when nothing listens or nothing answers (the worker says them); the bundler leaves out what the preload does not call.
      'shared/lent-tab-runtime.ts',
      'shared/record.ts'
    ])
  })

  it('the one that runs in every web page of a profile with an extension carries two small files and not the list of the channels of the application', () => {
    expect(closure(join(root, 'src/preload/lent-tab.ts'))).toEqual(['preload/lent-tab-runtime.ts', 'preload/lent-tab.ts', 'shared/lent-tab-runtime.ts'])
  })

  it('follows an import through the alias and skips the imports of types (the checks above are not empty)', () => {
    // extension-data.ts translates its refusals: it reaches the catalogues, through a relative import.
    expect(reachesTexts(closure(join(root, 'src/shared/extension-data.ts')))).not.toEqual([])
    // The preload reaches its tables through `@shared`, and the file of the tables imports nothing.
    expect(runtimeImports(join(root, 'src/preload/extension-shims.ts')).map((file) => posix(relative(root, file)))).toContain('src/shared/extension-data-api.ts')
    expect(runtimeImports(join(root, 'src/shared/extension-data-api.ts'))).toEqual([])
  })
})
