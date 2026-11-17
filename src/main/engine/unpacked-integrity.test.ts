// The scripts outside app.asar against the hashes its header holds, on a small archive written for the test (the header alone: nothing here reads
// the files packed inside), and the launch that is stopped when one of them was changed.

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { archiveOf, checkUnpackedScripts, refuseAlteredScripts, unpackedScripts } from './unpacked-integrity'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const sealed = (text: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ size: text.length, unpacked: true, integrity: { algorithm: 'SHA256', hash: sha(text), blockSize: 4194304, blocks: [sha(text)] }, ...over })

const BRIDGE = 'console.log("password bridge")'
const GUARD = 'console.log("page guard")'
const made: string[] = []

/** An archive whose header lists two unpacked preloads, a packed file, an unpacked library and an unpacked script without a hash; returns its path. */
function archive(onDisk: Record<string, string | null> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'lucium-unpacked-'))
  made.push(root)
  const header = JSON.stringify({
    files: {
      out: {
        files: {
          main: { files: { 'index.js': { size: 10, offset: '0', integrity: { algorithm: 'SHA256', hash: sha('packed') } } } },
          preload: { files: { 'password-bridge.js': sealed(BRIDGE), 'page-guard.js': sealed(GUARD) } }
        }
      },
      node_modules: { files: { lib: { files: { 'binding.node': sealed('signed after the archive was made'), 'loose.js': { size: 3, unpacked: true } } } } }
    }
  })
  const body = Buffer.from(header, 'utf8')
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(body.length + 8, 4)
  head.writeUInt32LE(body.length + 4, 8)
  head.writeUInt32LE(body.length, 12)
  const file = join(root, 'app.asar')
  writeFileSync(file, Buffer.concat([head, body]))
  const files: Record<string, string | null> = { 'out/preload/password-bridge.js': BRIDGE, 'out/preload/page-guard.js': GUARD, 'node_modules/lib/binding.node': 'another binary', 'node_modules/lib/loose.js': 'abc', ...onDisk }
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue
    const target = join(`${file}.unpacked`, ...path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return file
}

function launch(file: string) {
  const tell = vi.fn()
  const warn = vi.fn()
  const run = (): void => refuseAlteredScripts({ codePath: join(file, 'out', 'main'), fs: () => fs, tell, warn })
  return { tell, warn, run }
}

afterEach(() => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('the archive of the running code', () => {
  it('is found from a path inside app.asar or inside app.asar.unpacked', () => {
    expect(archiveOf('/Applications/Lucium.app/Contents/Resources/app.asar/out/main')).toBe('/Applications/Lucium.app/Contents/Resources/app.asar')
    expect(archiveOf('/Applications/Lucium.app/Contents/Resources/app.asar.unpacked/out/preload/page-guard.js')).toBe('/Applications/Lucium.app/Contents/Resources/app.asar')
  })

  it('is none for a development build', () => {
    expect(archiveOf('/Users/moi/lucium/out/main')).toBeNull()
  })
})

describe('the scripts outside the archive', () => {
  it('are the unpacked scripts of the header, with the hash it holds: not a packed file, not a compiled library', () => {
    expect(unpackedScripts(archive(), fs)).toEqual([
      { path: 'out/preload/password-bridge.js', sha256: sha(BRIDGE) },
      { path: 'out/preload/page-guard.js', sha256: sha(GUARD) },
      { path: 'node_modules/lib/loose.js', sha256: null }
    ])
  })

  it('are intact when each is the file the archive was sealed with', () => {
    expect(checkUnpackedScripts(archive(), fs).map((check) => check.verdict)).toEqual(['intact', 'intact', 'unsealed'])
  })

  it('are told apart when one was changed and another removed', () => {
    const checks = checkUnpackedScripts(archive({ 'out/preload/password-bridge.js': `${BRIDGE};fetch("https://ailleurs.example")`, 'out/preload/page-guard.js': null }), fs)
    expect(checks).toEqual([
      { path: 'out/preload/password-bridge.js', verdict: 'altered' },
      { path: 'out/preload/page-guard.js', verdict: 'missing' },
      { path: 'node_modules/lib/loose.js', verdict: 'unsealed' }
    ])
  })
})

describe('the launch', () => {
  it('goes on when every script is intact, and reports the script the header holds no hash for', () => {
    const { run, tell, warn } = launch(archive())
    expect(run).not.toThrow()
    expect(tell).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('node_modules/lib/loose.js'))
  })

  it('is stopped, and the user told which file, when a preload was changed', () => {
    const { run, tell } = launch(archive({ 'out/preload/password-bridge.js': 'console.log("another bridge")' }))
    expect(run).toThrow(/out\/preload\/password-bridge\.js \(altered\)/)
    expect(tell).toHaveBeenCalledExactlyOnceWith(['out/preload/password-bridge.js'])
  })

  it('is stopped when a preload is gone', () => {
    const { run, tell } = launch(archive({ 'out/preload/page-guard.js': null }))
    expect(run).toThrow(/out\/preload\/page-guard\.js \(missing\)/)
    expect(tell).toHaveBeenCalledExactlyOnceWith(['out/preload/page-guard.js'])
  })

  it('is stopped, and the user told, when the archive cannot be read', () => {
    const file = archive()
    writeFileSync(file, 'not an archive at all')
    const { run, tell } = launch(file)
    expect(run).toThrow(/cannot read what .*app\.asar was sealed with: .*is not an asar archive/)
    expect(tell).toHaveBeenCalledExactlyOnceWith([])
  })

  it('checks nothing when the code does not run from an archive', () => {
    const tell = vi.fn()
    const read = vi.fn()
    expect(() => refuseAlteredScripts({ codePath: '/Users/moi/lucium/out/main', fs: read as never, tell, warn: vi.fn() })).not.toThrow()
    expect(read).not.toHaveBeenCalled()
    expect(tell).not.toHaveBeenCalled()
  })
})

// Only the packaged application runs this line with an archive; the contract is read in the source, as for the rest of the wiring Electron alone runs.
describe('the engine', () => {
  it('checks the scripts before anything else of its constructor, on the archive it runs from, read as a plain file', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'electron-engine-base.ts'), 'utf8')
    const body = source.slice(source.indexOf('constructor(protected readonly getWindow'))
    const first = body.slice(body.indexOf('{') + 1).replace(/^\s*(\/\/[^\n]*\n\s*)*/, '')
    expect(first.startsWith('refuseAlteredScripts({')).toBe(true)
    const call = first.slice(0, first.indexOf('this.presentPagesAsChrome()'))
    expect(call).toContain('codePath: __dirname')
    expect(call).toContain("createRequire(__filename)('original-fs')")
    expect(call).toContain('dialog.showErrorBox(')
  })
})
