// A space as a file: plain, sealed, and every way a chosen file can be wrong, against real files and the real cipher.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { createInitialState, reduce } from '@shared/sidebar'
import { exportableState } from '@shared/lock'
import type { ScryptParams } from './export-crypto'
import { exportText } from './export-file'
import { readSpaceTransfer, spaceTransferText } from './space-transfer-file'
import { tempDir } from './temp-dir'

setLanguage('en')
const CHEAP: ScryptParams = { N: 2 ** 14, r: 8, p: 1 }
const PHRASE = 'une phrase secrète assez longue'

const ctx = (() => {
  let n = 0
  return { now: 1, newId: () => `i${++n}` }
})()
const base = createInitialState(ctx)
const state = reduce(base, { type: 'tab/open', url: 'https://confidentiel.example/compte', spaceId: base.activeSpaceId, background: true }, ctx)
const spaceId = state.activeSpaceId

let dir = ''
let logged: string[] = []
beforeEach(() => {
  dir = tempDir('lucium-space-')
  logged = []
  for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
})
afterEach(() => vi.restoreAllMocks())
const write = (name: string, text: string): string => {
  const path = join(dir, name)
  writeFileSync(path, text)
  return path
}
const never = async (): Promise<string | null> => {
  throw new Error('no passphrase should be asked')
}

describe('spaceTransferText and readSpaceTransfer', () => {
  it('writes plain JSON that reads back to the same space and tabs', async () => {
    const made = await spaceTransferText(state, spaceId, null, [])
    if (!made.ok) throw new Error(made.message)
    expect(made.encrypted).toBe(false)
    const read = await readSpaceTransfer(write('plain.json', made.text), never)
    if (!read.ok) throw new Error(read.message)
    expect(read.aside.tabs.map((t) => t.url)).toEqual(['https://confidentiel.example/compte'])
  })

  it('seals with the passphrase: the pages are not readable in the file, and the right phrase opens it', async () => {
    const made = await spaceTransferText(state, spaceId, PHRASE, [], { params: CHEAP })
    if (!made.ok) throw new Error(made.message)
    expect(made.encrypted).toBe(true)
    expect(made.text).not.toContain('confidentiel')
    const path = write('sealed.json', made.text)
    const asked: Array<string | null> = []
    const read = await readSpaceTransfer(path, async (previous) => (asked.push(previous), PHRASE))
    if (!read.ok) throw new Error(read.message)
    expect(read.aside.tabs).toHaveLength(1)
    expect(asked).toEqual([null])
    expect(logged.join('\n')).not.toContain(PHRASE)
  })

  it('gives up cleanly when the passphrase is refused', async () => {
    const made = await spaceTransferText(state, spaceId, PHRASE, [], { params: CHEAP })
    if (!made.ok) throw new Error(made.message)
    expect(await readSpaceTransfer(write('sealed.json', made.text), async () => null)).toMatchObject({ ok: false, cancelled: true })
  })

  it('refuses a weak passphrase and writes nothing', async () => {
    await expect(spaceTransferText(state, spaceId, 'court', [], { params: CHEAP })).rejects.toMatchObject({ kind: 'weak-passphrase' })
  })

  it('refuses a locked space: its tabs would leave in the clear', async () => {
    expect(await spaceTransferText(state, spaceId, null, [spaceId])).toMatchObject({ ok: false })
  })

  it('does not take a full export, nor a file that is not JSON, for a space', async () => {
    const full = await exportText(exportableState(state), null, undefined, null)
    expect(await readSpaceTransfer(write('full.json', full.text), never)).toMatchObject({ ok: false, message: expect.stringMatching(/not a Space/) })
    expect(await readSpaceTransfer(write('junk.json', 'pas du json'), never)).toMatchObject({ ok: false })
  })
})
