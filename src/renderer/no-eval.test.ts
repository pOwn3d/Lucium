// The pages of the interface have a policy without 'unsafe-eval': a module that builds a function from text (shared/find-replace.ts and
// shared/text-format.ts do, at import, so that the same source runs in a page and in the main process) would stop the whole bundle of a page
// with an EvalError the day the interface imports it, directly or through another module. This test follows the imports and says which one.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '..')
const EVALUATES = /\bnew Function\(|\beval\(/

const isSource = (file: string): boolean => /\.tsx?$/.test(file) && !/\.test\.|test-support|\.d\.ts$/.test(file)

function sourcesOf(folder: string): string[] {
  return (readdirSync(folder, { recursive: true }) as string[]).filter(isSource).map((file) => join(folder, file))
}

/** The file an import names, or null for a package, a style sheet or a picture. */
function fileOf(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@shared/') ? join(SRC, 'shared', specifier.slice('@shared/'.length)) : specifier.startsWith('.') ? resolve(dirname(from), specifier) : null
  if (base === null) return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return /\.tsx?$/.test(candidate) ? candidate : null
  }
  return null
}

/** What a module imports for its values: `import type` and `export type` are gone once compiled. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const found: string[] = []
  for (const match of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
    if (match[1] === undefined) found.push(match[2]!)
  }
  for (const match of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(match[1]!)
  return found
}

/** Every module reached from `entries`, with the module that first imported it. */
function reachable(entries: string[]): Map<string, string | null> {
  const seen = new Map<string, string | null>(entries.map((entry) => [entry, null]))
  const queue = [...entries]
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const specifier of importsOf(file)) {
      const target = fileOf(file, specifier)
      if (target !== null && !seen.has(target)) {
        seen.set(target, file)
        queue.push(target)
      }
    }
  }
  return seen
}

const short = (file: string): string => file.slice(SRC.length + 1)

describe('the code the interface loads', () => {
  const graph = reachable(sourcesOf(join(SRC, 'renderer')))

  it('follows the imports into the shared modules', () => {
    expect(graph.size).toBeGreaterThan(200)
    expect(graph.has(join(SRC, 'shared', 'i18n.ts'))).toBe(true)
  })

  it('builds no function from text: the policy of the pages has no unsafe-eval', () => {
    const offenders = [...graph.keys()].filter((file) => EVALUATES.test(readFileSync(file, 'utf8'))).map((file) => `${short(file)} (imported by ${short(graph.get(file) ?? file)})`)
    expect(offenders).toEqual([])
  })

  it('would see the two shared modules that do, were one of them imported', () => {
    for (const name of ['find-replace.ts', 'text-format.ts']) expect(EVALUATES.test(readFileSync(join(SRC, 'shared', name), 'utf8')), name).toBe(true)
    const pages = readdirSync(__dirname).filter((file) => file.endsWith('.html'))
    expect(pages.length).toBeGreaterThan(8)
    for (const page of pages) expect(readFileSync(join(__dirname, page), 'utf8'), page).not.toContain('unsafe-eval')
  })
})
