// The files the application writes (and the partial files it resumes) are never written through a link, on a system where `open` has no
// `O_NOFOLLOW` to refuse it: Windows. `constants.O_NOFOLLOW` is read-only there, so this file plays that system on any machine by handing the code a
// `node:fs` whose `constants` has no such flag. Without the look for a link in durable-write.ts (`refuseLinkSync`), every case below writes through the link.
// Creating a link needs the right to on Windows (Developer Mode or an administrator, which the runner of windows.yml is).

import * as nodeFs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refuseLink, refuseLinkSync, replaceFileDurably, writeDurableFile, writeDurableFileAsync } from './durable-write'
import { realResumeFs } from './engine/download-resume'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, constants: { ...actual.constants, O_NOFOLLOW: undefined } }
})

let dir: string
let target: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-no-follow-'))
  target = join(dir, 'target.txt')
  writeFileSync(target, 'precious')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const link = (name = 'a.json.tmp', to = target): string => {
  const path = join(dir, name)
  symlinkSync(to, path)
  return path
}

describe('where open has no O_NOFOLLOW', () => {
  it('is played for real: the flag is not there', () => {
    expect(nodeFs.constants.O_NOFOLLOW).toBeUndefined()
  })

  it('writeDurableFile does not write through a link, and leaves what it points at alone', () => {
    const path = link()
    expect(() => writeDurableFile(path, 'new')).toThrow(expect.objectContaining({ code: 'ELOOP' }))
    expect(readFileSync(target, 'utf8')).toBe('precious')
  })

  it('writeDurableFileAsync does not write through a link either', async () => {
    const path = link()
    await expect(writeDurableFileAsync(path, 'new')).rejects.toThrow(expect.objectContaining({ code: 'ELOOP' }))
    expect(readFileSync(target, 'utf8')).toBe('precious')
  })

  it('refuses a link to nothing too: opening it to create would make the file it names', () => {
    const missing = join(dir, 'not-yet.txt')
    const path = link('a.json.tmp', missing)
    expect(() => writeDurableFile(path, 'new')).toThrow(expect.objectContaining({ code: 'ELOOP' }))
    expect(existsSync(missing)).toBe(false)
  })

  it('replaceFileDurably does not write through a link under its temporary name, puts nothing in place, and leaves the link as it found it', () => {
    const path = join(dir, 'index.json')
    const temporary = link('index.json.tmp')
    expect(() => replaceFileDurably(path, 'new')).toThrow(/ELOOP/)
    expect(readFileSync(target, 'utf8')).toBe('precious')
    expect(existsSync(path)).toBe(false)
    expect(nodeFs.lstatSync(temporary).isSymbolicLink()).toBe(true)
  })

  it('the partial file of a download is not opened through a link, to read or to cut', () => {
    const path = link('a.zip')
    for (const write of [false, true]) expect(() => realResumeFs.open(path, write)).toThrow(expect.objectContaining({ code: 'ELOOP' }))
    expect(readFileSync(target, 'utf8')).toBe('precious')
  })

  it('still writes a file that is there, a file that is not, and reads what a download left', () => {
    const path = join(dir, 'a.json.tmp')
    writeDurableFile(path, 'first')
    writeDurableFile(path, 'second')
    expect(readFileSync(path, 'utf8')).toBe('second')
    const fd = realResumeFs.open(path, false)
    try {
      expect(realResumeFs.read(fd, 0, 6).toString('utf8')).toBe('second')
    } finally {
      realResumeFs.close(fd)
    }
    expect(() => realResumeFs.open(join(dir, 'missing.zip'), false)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })
})

describe('refuseLinkSync and refuseLink', () => {
  it('refuse a link only: a file, a folder and nothing at all pass', async () => {
    const folder = join(dir, 'folder')
    mkdirSync(folder)
    for (const path of [target, folder, join(dir, 'nothing'), join(target, 'under-a-file')]) {
      expect(() => refuseLinkSync(path)).not.toThrow()
      await expect(refuseLink(path)).resolves.toBeUndefined()
    }
    const path = link()
    expect(() => refuseLinkSync(path)).toThrow(expect.objectContaining({ code: 'ELOOP', syscall: 'open', path }))
    await expect(refuseLink(path)).rejects.toThrow(expect.objectContaining({ code: 'ELOOP', syscall: 'open', path }))
  })

  it('pass on any other error than "nothing there": it is not for them to hide', async () => {
    const invalid = join(dir, 'a\0b')
    expect(() => refuseLinkSync(invalid)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }))
    await expect(refuseLink(invalid)).rejects.toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }))
  })
})
