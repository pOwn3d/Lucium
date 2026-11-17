// The Chromium switches the main process sets (`app.commandLine.appendSwitch`). Chromium takes any name without a word: a switch it no longer
// reads changes nothing, and whatever the code and the docs say it does is then false. `disable-ipv6` was one, set for the DRM build long after
// Chromium had dropped it. A switch Chromium reads has its name in the engine's binary: each name set in the sources is looked for there.
// The binary is the one of the installed `electron` package (or `ELECTRON_OVERRIDE_DIST_PATH`, the variable Electron itself reads); a checkout
// whose package was installed without its binary skips the second check, and says so.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MAIN = fileURLToPath(new URL('.', import.meta.url))

/** Every source file of the main process, tests and their support left out. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.ts$/.test(entry.name) && !/\.test(-support)?\.ts$/.test(entry.name) ? [path] : []
  })
}

/** The calls of `appendSwitch` in the sources: the name when it is written there, null when it is computed. */
function switchesSet(): Array<{ file: string; name: string | null }> {
  const found: Array<{ file: string; name: string | null }> = []
  for (const file of sources(MAIN)) {
    const text = readFileSync(file, 'utf8')
    for (const call of text.matchAll(/\.appendSwitch\(\s*([^,)\s]*)/g)) {
      const literal = /^(['"`])([a-z0-9-]+)\1$/.exec(call[1] ?? '')
      found.push({ file: file.slice(MAIN.length), name: literal ? literal[2]! : null })
    }
  }
  return found
}

/** The framework of the engine, where Chromium keeps the names of its switches; null when the package was installed without its binary. */
function engineBinary(): string | null {
  const dist = process.env['ELECTRON_OVERRIDE_DIST_PATH'] ?? join(dirname(createRequire(import.meta.url).resolve('electron/package.json')), 'dist')
  const binary = join(dist, 'Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework')
  return existsSync(binary) ? binary : null
}

describe('the Chromium switches of the main process', () => {
  const set = switchesSet()

  it('are written in the sources by their name, so that each one can be looked up', () => {
    expect(set.length).toBeGreaterThan(0)
    expect(set.filter((found) => found.name === null).map((found) => found.file)).toEqual([])
    expect(set.map((found) => found.name)).not.toContain('disable-ipv6')
  })

  const binary = engineBinary()
  it.skipIf(binary === null)('are all names the engine reads: its binary holds each of them', () => {
    const engine = readFileSync(binary!)
    // What the check can tell apart: a switch of this engine is found, and the one that was dropped is not.
    expect(engine.includes('host-resolver-rules')).toBe(true)
    expect(engine.includes('disable-ipv6')).toBe(false)
    const unread = set.filter((found) => found.name !== null && !engine.includes(found.name)).map((found) => `${found.name} (${found.file})`)
    expect(unread).toEqual([])
  })
  if (binary === null) console.warn('[chromium-switches] the electron package has no binary here: the names of the switches were not looked up in it')
})
