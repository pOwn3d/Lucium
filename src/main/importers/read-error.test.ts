import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { parsePlist } from '@shared/plist'
import { ImportReadError, readFailureMessage } from './read-error'
import { readChromiumHistory } from './sqlite'
import { frenchSpaces } from '@shared/french-typography'

const dir = mkdtempSync(join(tmpdir(), 'lucium-read-error-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const errno = (code: string, message: string) => Object.assign(new Error(message), { code })

describe('the sentence for a file that cannot be read', () => {
  it('names a damaged or half-written JSON file, whatever the engine says about it', () => {
    for (const text of ['{"roots":{"bookmark_bar', '', '<html>', '﻿{}']) {
      let thrown: unknown
      try {
        JSON.parse(text)
      } catch (error) {
        thrown = error
      }
      const message = readFailureMessage(thrown, 'Bookmarks')
      expect(message, text).toMatch(/^Bookmarks est tronqué ou abîmé/)
      // Nothing of the engine's own wording (English, with a piece of the file in it) reaches the person.
      expect(message, text).not.toMatch(/JSON|token|position/i)
    }
  })

  it('names a file that is not a SQLite database, using SQLite’s own result code and not its wording', () => {
    const path = join(dir, 'History')
    writeFileSync(path, 'this is not a database, '.repeat(100))
    let thrown: unknown
    try {
      readChromiumHistory(path)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(readFailureMessage(thrown, 'History')).toMatch(/^History n’est pas une base de données lisible/)
    expect(readFailureMessage(thrown, 'History')).not.toMatch(/not a database/i)
  })

  it('names a property list that is not one', () => {
    let thrown: unknown
    try {
      parsePlist('<plist><dict><key>Children</key>')
    } catch (error) {
      thrown = error
    }
    expect(readFailureMessage(thrown, 'Bookmarks.plist')).toMatch(/^Bookmarks\.plist n’est pas une liste de propriétés lisible/)
    expect(readFailureMessage(new Error('plutil exited with 1'), 'Bookmarks.plist')).toMatch(/liste de propriétés/)
  })

  it('says what the person can do when the disk is full, the file is in use or the system is out of file handles', () => {
    expect(readFailureMessage(errno('ENOSPC', "ENOSPC: no space left on device, copyfile '/Users/x/Library/History' -> '/var/t/History'"), 'History')).toMatch(/plus de place sur le disque.*Libérez de l’espace/)
    expect(readFailureMessage(errno('EBUSY', 'resource busy'), 'History')).toMatch(/utilisé par un autre programme/)
    expect(readFailureMessage(errno('EMFILE', 'too many open files'), 'History')).toMatch(/trop de fichiers ouverts/)
    expect(readFailureMessage(errno('EIO', 'i/o error'), 'History')).toMatch(/erreur de lecture du disque/)
  })

  it('gives the sentence of our own refusals as it is, after the name', () => {
    expect(readFailureMessage(new ImportReadError(frenchSpaces('le fichier est trop volumineux (200 Mo, au plus 100 Mo).')), 'Bookmarks')).toBe(frenchSpaces('Bookmarks : le fichier est trop volumineux (200 Mo, au plus 100 Mo).'))
  })

  it('keeps a failure it does not know to one short line with no path in it', () => {
    const message = readFailureMessage(new Error("weird failure at '/Users/someone/Library/Application Support/Arc/StorableSidebar.json'\n    at stack line"), 'StorableSidebar.json')
    expect(message).toMatch(/^StorableSidebar\.json n’a pas pu être lu \(weird failure at …\)\.$/)
    expect(message).not.toContain('/Users')
    expect(readFailureMessage('plain text thrown', 'x')).toBe('x n’a pas pu être lu (plain text thrown).')
  })

  it('does not take a file that is only locked by its browser for a damaged one: SQLite’s busy and locked codes', () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
    expect(readFailureMessage(busy, 'History')).toMatch(/utilisé par un autre programme/)
    // An extended result code (the low byte is the primary one) is read as its primary code.
    const corrupt = Object.assign(new Error('malformed'), { code: 'ERR_SQLITE_ERROR', errcode: 11 | (1 << 8) })
    expect(readFailureMessage(corrupt, 'History')).toMatch(/pas une base de données lisible/)
    expect(new DatabaseSync(':memory:')).toBeTruthy()
  })
})
