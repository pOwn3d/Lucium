import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { diskMarkerIo, noteCleanExit, noteLaunch, RUNNING_MARKER, type MarkerIo } from './clean-exit'

/** An in-memory folder, with the failures a test asks for; the warnings are kept. */
function memory(fail: Partial<Record<'exists' | 'write' | 'remove', true>> = {}) {
  const files = new Set<string>()
  const warnings: string[] = []
  const io: MarkerIo = {
    exists: (path) => {
      if (fail.exists) throw new Error('denied')
      return files.has(path)
    },
    write: (path) => {
      if (fail.write) throw new Error('read-only')
      files.add(path)
    },
    remove: (path) => {
      if (fail.remove) throw new Error('busy')
      files.delete(path)
    },
    warn: (line) => void warnings.push(line)
  }
  return { io, files, warnings }
}

describe('the sign of a clean exit', () => {
  it('sees no abnormal exit at the first launch, and makes the marker', () => {
    const { io, files } = memory()
    expect(noteLaunch('/data', io)).toEqual({ abnormal: false })
    expect(files.has(join('/data', RUNNING_MARKER))).toBe(true)
  })

  it('sees an abnormal exit when the marker of the last run is still there', () => {
    const { io } = memory()
    noteLaunch('/data', io)
    expect(noteLaunch('/data', io)).toEqual({ abnormal: true })
  })

  it('sees a clean exit once the marker was removed by the end of the run, and by nothing earlier', () => {
    const { io, files } = memory()
    noteLaunch('/data', io)
    expect(files.size).toBe(1)
    noteCleanExit('/data', io)
    expect(files.size).toBe(0)
    expect(noteLaunch('/data', io)).toEqual({ abnormal: false })
  })

  it('removing a marker that is not there is nothing', () => {
    const { io, warnings } = memory()
    noteCleanExit('/data', io)
    expect(warnings).toEqual([])
  })

  it('says it when the marker cannot be made, and when it cannot be removed', () => {
    const cannotWrite = memory({ write: true })
    expect(noteLaunch('/data', cannotWrite.io)).toEqual({ abnormal: false })
    expect(cannotWrite.warnings).toEqual([expect.stringContaining('cannot write')])
    const stuck = memory()
    noteLaunch('/data', stuck.io)
    const cannotRemove = { ...stuck.io, remove: () => { throw new Error('busy') } }
    noteCleanExit('/data', cannotRemove)
    expect(stuck.warnings).toEqual([expect.stringContaining('cannot remove')])
  })

  it('counts a marker that cannot be looked for as a clean exit, and says so', () => {
    const { io, warnings } = memory({ exists: true })
    expect(noteLaunch('/data', io)).toEqual({ abnormal: false })
    expect(warnings.some((line) => line.includes('cannot look for'))).toBe(true)
  })

  it('works on a real folder: the marker is a file that holds only the time of the start', () => {
    const folder = mkdtempSync(join(tmpdir(), 'lucium-exit-'))
    expect(noteLaunch(folder, diskMarkerIo, () => 1234)).toEqual({ abnormal: false })
    expect(existsSync(join(folder, RUNNING_MARKER))).toBe(true)
    expect(noteLaunch(folder, diskMarkerIo)).toEqual({ abnormal: true })
    noteCleanExit(folder, diskMarkerIo)
    expect(existsSync(join(folder, RUNNING_MARKER))).toBe(false)
  })
})
