// `sync-marks.json` (marks.ts): kept beside the state, read as hostile input, never silently discarded.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from '../temp-dir'
import { MarkBook } from './marks'
import { MarkStore } from './mark-store'

const book = (): MarkBook => {
  const marks = new MarkBook('mac')
  marks.update({ entities: { space: { s1: { name: 'A' } } }, order: { spaces: ['s1'] } }, 1_790_000_000_000)
  return marks
}

describe('MarkStore', () => {
  it('starts with an empty book when there is no file, and writes nothing until asked', () => {
    const dir = tempDir('lucium-sync-marks-')
    const store = new MarkStore(join(dir, 'sync-marks.json'))
    expect(store.load('mac').toJSON().entities).toEqual({})
    expect(readdirSync(dir)).toEqual([])
  })

  it('keeps a book and gives it back with its clock, so that a mark made after a restart is later than before it', () => {
    const dir = tempDir('lucium-sync-marks-')
    const store = new MarkStore(join(dir, 'sync-marks.json'))
    const first = book()
    store.save(first)
    const again = store.load('mac')
    expect(again.toJSON()).toEqual(first.toJSON())
    expect(again.clock.next(1_790_000_000_000) > (again.stampsOf('space', 's1')['name'] as string)).toBe(true)
  })

  it('writes the format 2 (the Today tabs the book holds, §27.3), and still reads a book of the format 1, which held none', () => {
    const dir = tempDir('lucium-sync-marks-')
    const path = join(dir, 'sync-marks.json')
    new MarkStore(path).save(book())
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(2)
    const old = { ...JSON.parse(readFileSync(path, 'utf8')), version: 1 }
    writeFileSync(path, JSON.stringify(old))
    expect(new MarkStore(path).load('mac').stampsOf('space', 's1')['name']).toBe(book().stampsOf('space', 's1')['name'])
    expect(readdirSync(dir)).toEqual(['sync-marks.json'])
  })

  it('writes a file only its owner reads', () => {
    const dir = tempDir('lucium-sync-marks-')
    const path = join(dir, 'sync-marks.json')
    new MarkStore(path).save(book())
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o077).toBe(0)
  })

  it.each([
    ['not JSON', 'nope'],
    ['a list', '[]'],
    ['another version', JSON.stringify({ version: 3 })],
    ['another version of an otherwise good file', JSON.stringify({ version: 3, clock: { ms: 1, counter: 0 }, entities: {}, tombstones: {}, orders: {} })],
    ['no clock', JSON.stringify({ version: 1, entities: {}, tombstones: {}, orders: {} })],
    ['a clock that is not numbers', JSON.stringify({ version: 1, clock: { ms: 'x', counter: 0 }, entities: {}, tombstones: {}, orders: {} })],
    ['no entities', JSON.stringify({ version: 1, clock: { ms: 1, counter: 0 }, tombstones: {}, orders: {} })]
  ])('moves a file with %s aside, and starts again with an empty book', (_name, text) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const dir = tempDir('lucium-sync-marks-')
    const path = join(dir, 'sync-marks.json')
    writeFileSync(path, text)
    expect(new MarkStore(path).load('mac').toJSON().entities).toEqual({})
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(dir).some((name) => name.startsWith('sync-marks.json'))).toBe(true)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[sync]'))
    log.mockRestore()
  })

  it('throws when it cannot write, so that the caller says so', () => {
    const dir = tempDir('lucium-sync-marks-')
    expect(() => new MarkStore(join(dir, 'missing', 'sync-marks.json')).save(book())).toThrow()
  })
})
