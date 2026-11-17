// The package an install or an update receives is the one that was asked for, on the REAL electron-chrome-web-store. The store's own scan
// (crx-scan.ts) checks that a package is signed by the key of the extension it declares: not that this extension is the one Lucium asked the
// store for. The library makes that comparison, and nothing else does: a new version of it that stops making it fails here.
// There is no Electron process: `electron` is a stub for the time the library is loaded, and `fetch` answers the package of the test.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newTestKey, packageOf } from './crx-test-support'

const require = createRequire(import.meta.url)
const nodeModule = require('node:module') as { _load: (this: unknown, request: string, ...rest: unknown[]) => unknown }

/** The package the store answers the next download with, and the addresses that were asked. */
let served: Buffer = Buffer.alloc(0)
const asked: string[] = []
let downloadExtension: (extensionId: string, extensionsDir: string) => Promise<string>
const folder = mkdtempSync(join(tmpdir(), 'lucium-package-id-'))

beforeAll(() => {
  const electronStub = new Proxy({} as Record<string, unknown>, { get: (target, name: string) => (name in target ? target[name] : class Unused {}) })
  const realLoad = nodeModule._load
  const realFetch = globalThis.fetch
  nodeModule._load = function (this: unknown, request: string, ...rest: unknown[]) {
    return request === 'electron' ? electronStub : realLoad.call(this, request, ...rest)
  }
  // The library keeps the `fetch` of the moment it is loaded.
  globalThis.fetch = async (input) => {
    asked.push(String(input))
    return new Response(new Uint8Array(served))
  }
  try {
    downloadExtension = (require('electron-chrome-web-store') as { downloadExtension: typeof downloadExtension }).downloadExtension
  } finally {
    nodeModule._load = realLoad
    globalThis.fetch = realFetch
  }
})

afterAll(() => rmSync(folder, { recursive: true, force: true }))

describe('the package electron-chrome-web-store receives for an extension', () => {
  const wanted = packageOf({ key: newTestKey(), manifest: { manifest_version: 3, name: 'Asked for', version: '1.0' } })
  const another = packageOf({ key: newTestKey(), manifest: { manifest_version: 3, name: 'Another', version: '1.0' } })

  it('is unpacked when it is the extension that was asked for', async () => {
    served = wanted.crx
    const path = await downloadExtension(wanted.id, folder)
    expect(path).toBe(join(folder, wanted.id, '1.0_0'))
    expect(JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'))).toMatchObject({ name: 'Asked for' })
    expect(asked.at(-1)).toContain(`id%3D${wanted.id}`)
  })

  it('is refused, and nothing of it is written, when it is a package of another extension, however well signed', async () => {
    served = another.crx
    const before = readdirSync(folder)
    await expect(downloadExtension(wanted.id, folder)).rejects.toThrow(`CRX mismatches expected extension ID: ${wanted.id} !== ${another.id}`)
    expect(readdirSync(folder)).toEqual(before)
    expect(existsSync(join(folder, another.id))).toBe(false)
  })
})
