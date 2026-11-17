// windows.ts registers the IPC of each window it makes (it imports ipc.ts). Nothing ipc.ts loads may import windows.ts back: the loop only
// holds while no module reads the other at load time, and nothing would say so the day one does (the import would be `undefined`).
// The handlers that need the window manager read it from window-manager-holder.ts. Imports of types are left out: they are gone at run time.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MAIN = fileURLToPath(new URL('..', import.meta.url))

/** The modules of src/main a file loads at run time: its relative imports and re-exports, those of types left out. */
function loadedBy(file: string): string[] {
  const code = readFileSync(file, 'utf8')
  const found: string[] = []
  for (const match of code.matchAll(/^(?:import|export)\s+(?!type\s)(?:[^'"]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    const base = join(dirname(file), match[1]!)
    const path = [`${base}.ts`, join(base, 'index.ts')].find((candidate) => existsSync(candidate))
    if (path) found.push(path)
  }
  return found
}

/** Every module reached from `start`, with the module that led to it. */
function reachedFrom(start: string): Map<string, string> {
  const from = new Map<string, string>()
  const queue = [start]
  while (queue.length > 0) {
    const file = queue.shift()!
    for (const next of loadedBy(file)) {
      if (next === start || from.has(next)) continue
      from.set(next, file)
      queue.push(next)
    }
  }
  return from
}

describe('the modules ipc.ts loads', () => {
  const ipc = join(MAIN, 'shell/ipc.ts')
  const windows = join(MAIN, 'shell/windows.ts')

  it('are read as the code writes them: an import of values is seen, an import of types is not', () => {
    expect(loadedBy(windows)).toContain(ipc)
    expect(loadedBy(join(MAIN, 'shell/window-manager-holder.ts'))).toEqual([])
  })

  it('never lead back to windows.ts, which loads ipc.ts', () => {
    const from = reachedFrom(ipc)
    const path: string[] = []
    for (let at: string | undefined = from.has(windows) ? windows : undefined; at !== undefined; at = from.get(at)) path.unshift(relative(MAIN, at))
    expect(path, 'A handler of ipc.ts loads windows.ts again. Read the window manager from shell/window-manager-holder.ts instead.').toEqual([])
  })
})
