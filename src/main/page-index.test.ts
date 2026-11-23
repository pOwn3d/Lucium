import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DATA_FILE_MAX_BYTES } from './persist'
import { PageIndexBook, eraseIndexWhenSwitchedOff, pageIndexFileName } from './page-index'

const body = (s: string): string => `${s} ${'lorem ipsum dolor sit amet '.repeat(3)}`
const dir = (): string => mkdtempSync(join(tmpdir(), 'lucium-page-index-'))

describe('pageIndexFileName', () => {
  it('follows the names of the histories', () => {
    expect(pageIndexFileName('default')).toBe('page-index.json')
    expect(pageIndexFileName('travail')).toBe('page-index-travail.json')
    expect(pageIndexFileName('Travail')).toBe('page-index-~travail.json')
  })
})

describe('PageIndexBook', () => {
  it('keeps a page, finds it by its text, and gives it back after a restart', () => {
    const d = dir()
    const book = new PageIndexBook(d)
    book.of('default').add({ url: 'https://a.org/', title: 'A', text: body('la tarte Tatin'), at: 1 })
    expect(book.of('default').search('tatin').map((m) => m.url)).toEqual(['https://a.org/'])
    expect(book.flush()).toBe(true)
    expect(new PageIndexBook(d).of('default').search('tatin')).toHaveLength(1)
  })
  it('keeps the profiles apart', () => {
    const book = new PageIndexBook(dir())
    book.of('default').add({ url: 'https://a.org/', title: 'A', text: body('secret'), at: 1 })
    expect(book.of('travail').search('secret')).toEqual([])
  })
  it('forgets a page, and a whole profile with its file', () => {
    const d = dir()
    const book = new PageIndexBook(d)
    book.of('default').add({ url: 'https://a.org/', title: 'A', text: body('alpha'), at: 1 })
    book.of('default').add({ url: 'https://b.org/', title: 'B', text: body('beta'), at: 2 })
    expect(book.of('default').remove('https://a.org/')).toBe(true)
    expect(book.of('default').remove('https://a.org/')).toBe(false)
    book.flush()
    expect(existsSync(join(d, 'page-index.json'))).toBe(true)
    expect(book.erase('default')).toBe(true)
    expect(existsSync(join(d, 'page-index.json'))).toBe(false)
    expect(book.of('default').search('beta')).toEqual([])
  })
  it('eraseAll removes the files of every profile, those never opened in this run included', () => {
    const d = dir()
    const first = new PageIndexBook(d)
    first.of('default').add({ url: 'https://a.org/', title: 'A', text: body('alpha'), at: 1 })
    first.of('travail').add({ url: 'https://b.org/', title: 'B', text: body('beta'), at: 2 })
    first.flush()
    writeFileSync(join(d, 'history.json'), '[]')
    const second = new PageIndexBook(d)
    expect(second.eraseAll()).toBe(true)
    expect(existsSync(join(d, 'page-index.json'))).toBe(false)
    expect(existsSync(join(d, 'page-index-travail.json'))).toBe(false)
    expect(readFileSync(join(d, 'history.json'), 'utf8')).toBe('[]')
  })
  it('eraseAll and erase also remove the files set aside, left over or being written, and nothing else', () => {
    const d = dir()
    const leftovers = ['page-index.json.corrupt-1763000000000', 'page-index.json.corrupt-1763000000000-1', 'page-index.json.future-1763000000000', 'page-index.json.tmp', 'page-index-travail.json.tmp-async', 'page-index-travail.json.corrupt-1763000000001']
    const others = ['history.json', 'history.json.corrupt-1763000000000', 'page-index-notes.txt', 'page-index.json.bak']
    for (const name of [...leftovers, ...others]) writeFileSync(join(d, name), '"secret text of a page"')
    expect(new PageIndexBook(d).eraseAll()).toBe(true)
    expect(readdirSync(d).sort()).toEqual([...others].sort())
    for (const name of leftovers) writeFileSync(join(d, name), '"secret text of a page"')
    expect(new PageIndexBook(d).erase('travail')).toBe(true)
    expect(readdirSync(d).filter((name) => name.startsWith('page-index-travail'))).toEqual([])
    expect(readdirSync(d)).toContain('page-index.json.corrupt-1763000000000')
  })
  it('a file set aside because it could not be read is gone after eraseAll', () => {
    const d = dir()
    writeFileSync(join(d, 'page-index.json'), '{"secret text of a page"')
    const book = new PageIndexBook(d)
    expect(book.of('default').size()).toBe(0)
    expect(readdirSync(d).some((name) => name.startsWith('page-index.json.corrupt-'))).toBe(true)
    expect(book.eraseAll()).toBe(true)
    expect(readdirSync(d)).toEqual([])
  })
  it('does not read a file past the bound: it is set aside unread, and the index starts from none', () => {
    const d = dir()
    const path = join(d, 'page-index.json')
    // Valid JSON (an empty list and blanks): only the size can make it refused.
    writeFileSync(path, Buffer.concat([Buffer.from('[]'), Buffer.alloc(DATA_FILE_MAX_BYTES, 0x20)]))
    const book = new PageIndexBook(d)
    expect(book.of('default').size()).toBe(0)
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(d).filter((name) => name.startsWith('page-index.json.corrupt-'))).toHaveLength(1)
    // Writes a file of the size of the bound, which is slow on a loaded Windows runner (it timed out at the default 5 s there).
  }, 30_000)
  it('sets aside a file it cannot read and starts again from none', () => {
    const d = dir()
    writeFileSync(join(d, 'page-index.json'), '{not json')
    const book = new PageIndexBook(d)
    expect(book.of('default').search('x')).toEqual([])
    expect(existsSync(join(d, 'page-index.json'))).toBe(false)
  })
})

describe('eraseIndexWhenSwitchedOff', () => {
  function store(on: boolean) {
    let state = { settings: { pageContentIndex: on } }
    const listeners = new Set<(s: typeof state) => void>()
    return {
      get: () => state,
      subscribe: (l: (s: typeof state) => void) => (listeners.add(l), () => listeners.delete(l)),
      set(next: boolean) {
        state = { settings: { pageContentIndex: next } }
        for (const l of listeners) l(state)
      }
    }
  }
  it('erases when the setting goes off, not when it goes on, nor at the start, nor for a change of another setting', () => {
    const eraseAll = vi.fn(() => true)
    const s = store(false)
    eraseIndexWhenSwitchedOff(s, { eraseAll })
    expect(eraseAll).not.toHaveBeenCalled()
    s.set(false)
    s.set(true)
    expect(eraseAll).not.toHaveBeenCalled()
    s.set(true)
    expect(eraseAll).not.toHaveBeenCalled()
    s.set(false)
    expect(eraseAll).toHaveBeenCalledTimes(1)
    s.set(false)
    expect(eraseAll).toHaveBeenCalledTimes(1)
  })
})
