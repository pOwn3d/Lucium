// The background media nothing refers to is deleted at startup; a file a copy still refers to is kept. Against real folders.
import { mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { referencedBackgroundFiles } from '@shared/background-media-refs'
import { containersNamedBeforeRestore, mayDeleteBackgroundMedia, readSessionCopies, sweepBackgroundMedia } from './background-media-sweep'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lucium-sweep-'))
  mkdirSync(join(root, 'media'))
  for (const name of ['kept-by-space.png', 'kept-by-copy.mp4', 'orphan.gif']) writeFileSync(join(root, 'media', name), 'x')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const spaceWith = (value: string) => ({ background: { type: 'image', value } })
const copyWith = (value: string) => ({ spaces: [{ background: { type: 'video', value } }] } as never)

describe('when the sweep may delete', () => {
  it('may delete when the state was read and no set-aside file is beside it', () => {
    const statePath = join(root, 'state.json')
    expect(mayDeleteBackgroundMedia(statePath, true)).toBe(true)
  })

  it('may not delete when the state was not read at this launch', () => {
    expect(mayDeleteBackgroundMedia(join(root, 'state.json'), false)).toBe(false)
  })

  it('may not delete while a set-aside state of a newer or damaged version is kept beside it', () => {
    const statePath = join(root, 'state.json')
    writeFileSync(`${statePath}.future-1700000000000`, '{}')
    expect(mayDeleteBackgroundMedia(statePath, true)).toBe(false)
    expect(existsSync(join(root, 'media', 'orphan.gif'))).toBe(true)
  })
})

describe('a folder of backgrounds that cannot be listed', () => {
  it('lets the launch go on: nothing is deleted, nothing is thrown, the log says why', () => {
    rmSync(join(root, 'media'), { recursive: true, force: true })
    // `media` is a file: listing it fails with ENOTDIR, before any window and outside any try of main().
    writeFileSync(join(root, 'media'), 'not a folder')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(() => sweepBackgroundMedia(root, [], [])).not.toThrow()
    expect(sweepBackgroundMedia(root, [], [])).toBe(0)
    expect(String(warn.mock.calls[0]![0])).toContain('cannot be listed')
  })
})

describe('the sweep of the background media', () => {
  it('deletes the files nothing refers to and keeps those of the spaces and of the copies', () => {
    const deleted = sweepBackgroundMedia(root, [spaceWith('kept-by-space.png')], [copyWith('kept-by-copy.mp4')])
    expect(deleted).toBe(1)
    expect(readdirSync(join(root, 'media')).sort()).toEqual(['kept-by-copy.mp4', 'kept-by-space.png'])
  })

  it('keeps the files that the copy of the state made before a restoration names, and deletes the rest', () => {
    writeFileSync(join(root, 'state.json.avant-restauration-2026-11-03T10-00-00'), JSON.stringify({ version: 1, spaces: [{ id: 's', background: { type: 'video', value: 'kept-by-copy.mp4' } }] }))
    const deleted = sweepBackgroundMedia(root, [spaceWith('kept-by-space.png')], [])
    expect(deleted).toBe(1)
    expect(readdirSync(join(root, 'media')).sort()).toEqual(['kept-by-copy.mp4', 'kept-by-space.png'])
  })

  it('deletes nothing when a copy made before a restoration cannot be read: it could name any of them', () => {
    mkdirSync(join(root, 'state.json.avant-restauration-2026-11-03T10-00-00'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(sweepBackgroundMedia(root, [spaceWith('kept-by-space.png')], [])).toBe(0)
    expect(readdirSync(join(root, 'media')).sort()).toEqual(['kept-by-copy.mp4', 'kept-by-space.png', 'orphan.gif'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('does not count a colour background as a file to keep', () => {
    expect(referencedBackgroundFiles([{ background: { type: 'color', value: '#123456' } }]).size).toBe(0)
  })

  it('does nothing when there is no media folder', () => {
    rmSync(join(root, 'media'), { recursive: true, force: true })
    expect(sweepBackgroundMedia(root, [], [])).toBe(0)
    expect(existsSync(join(root, 'media'))).toBe(false)
  })

  it('reports a copy it cannot read, and still keeps the rest', () => {
    const copies = join(root, 'session-backups')
    mkdirSync(copies, { recursive: true })
    writeFileSync(join(copies, 'copie-0000000000001.json'), '{ not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    readSessionCopies(root)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('the containers the copies made before a restoration name', () => {
  it('are read from every copy kept beside the state', () => {
    writeFileSync(join(root, 'state.json.avant-restauration-2026-11-03T10-00-00'), JSON.stringify({ version: 1, settings: { containers: [{ id: 'travail-3fa9c' }] } }))
    writeFileSync(join(root, 'state.json.avant-restauration-2026-11-05T10-00-00'), JSON.stringify({ version: 1, settings: { containers: [{ id: 'banque-11111' }] } }))
    expect([...containersNamedBeforeRestore(root)!].sort()).toEqual(['banque-11111', 'travail-3fa9c'])
  })

  it('are none when no restoration was ever made', () => {
    expect(containersNamedBeforeRestore(root)).toEqual(new Set())
  })

  it('are unknown, and the log says that no folder of a container goes, when a copy cannot be read or is not a state', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    writeFileSync(join(root, 'state.json.avant-restauration-2026-11-03T10-00-00'), '{ cut short')
    expect(containersNamedBeforeRestore(root)).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[containers] a copy of the state made before a restoration cannot be read as a state'))
    warn.mockClear()
    rmSync(join(root, 'state.json.avant-restauration-2026-11-03T10-00-00'))
    mkdirSync(join(root, 'state.json.avant-restauration-2026-11-03T10-00-00'))
    expect(containersNamedBeforeRestore(root)).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[containers] the copy'), expect.anything())
    warn.mockRestore()
  })

  // That main() gives the sweep of the launch the state read and the folders named before the restore: main-wiring.test.ts, where main() is run.
})
