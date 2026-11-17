import { describe, expect, it } from 'vitest'
import type { DownloadInfo } from './model'
import { DISK_MIN_FREE_BYTES, canPauseDownload, canResumeDownload, downloadProgress, downloadStatus, fileExtension, finishedDownloads, formatBytes, interruptedBecause, missingFileNotice, offersResume, partialRemovalNotice, resumeAllowed, shownDownload, sortDownloads, unmarkedNotice, withDownload } from './downloads-view'
import { frenchSpaces } from './french-typography'
import { setLanguage } from './i18n'

const download = (patch: Partial<DownloadInfo> = {}): DownloadInfo => ({ id: 'd', filename: 'a.pdf', url: 'https://x.test/a.pdf', path: '/tmp/a.pdf', state: 'progressing', receivedBytes: 0, totalBytes: 0, startedAt: 0, ...patch })

describe('formatBytes', () => {
  it('picks the unit and writes a decimal comma', () => {
    expect(formatBytes(0)).toBe(frenchSpaces('0 o'))
    expect(formatBytes(850)).toBe(frenchSpaces('850 o'))
    expect(formatBytes(1024)).toBe(frenchSpaces('1 Ko'))
    expect(formatBytes(1024 ** 2 * 3.44)).toBe(frenchSpaces('3,4 Mo'))
    expect(formatBytes(1024 ** 3 * 1.25)).toBe(frenchSpaces('1,25 Go'))
  })

  it('shows nothing odd for a size that is missing or negative', () => {
    expect(formatBytes(Number.NaN)).toBe(frenchSpaces('0 o'))
    expect(formatBytes(-5)).toBe(frenchSpaces('0 o'))
  })

  it('writes the units and the decimal point of English in an English interface, in the list as in the line of a download', () => {
    setLanguage('en')
    try {
      expect([0, 850, 1024, 1024 ** 2 * 3.44, 1024 ** 3 * 1.25].map(formatBytes)).toEqual(['0 B', '850 B', '1 KB', '3.4 MB', '1.25 GB'])
      expect(downloadStatus(download({ receivedBytes: 1024 ** 2 * 1.5, totalBytes: 1024 ** 2 * 3 }))).toBe('1.5 MB of 3.0 MB')
    } finally {
      setLanguage('fr')
    }
  })
})

describe('fileExtension', () => {
  it('upper-cases the extension for the file icon', () => {
    expect(fileExtension('Rapport final.pdf')).toBe('PDF')
    expect(fileExtension('archive.tar.gz')).toBe('GZ')
    expect(fileExtension('photo.jpeg')).toBe('JPEG')
  })

  it('has nothing for a name without a usable extension', () => {
    for (const name of ['README', '.gitignore', '.env', 'fichier.', 'x.tooLong', 'a.b c']) expect(fileExtension(name)).toBe('')
  })
})

describe('downloadProgress', () => {
  it('is the share received while the size is known', () => {
    expect(downloadProgress(download({ receivedBytes: 25, totalBytes: 100 }))).toBe(0.25)
  })

  it('has no value without a size, once finished, or beyond the total', () => {
    expect(downloadProgress(download({ receivedBytes: 25, totalBytes: 0 }))).toBeNull()
    expect(downloadProgress(download({ state: 'completed', receivedBytes: 100, totalBytes: 100 }))).toBeNull()
    expect(downloadProgress(download({ receivedBytes: 150, totalBytes: 100 }))).toBe(1)
  })
})

describe('downloadStatus', () => {
  it('tells how far a running download is, with or without a total', () => {
    expect(downloadStatus(download({ receivedBytes: 1024, totalBytes: 2048 }))).toBe(frenchSpaces('1 Ko sur 2 Ko'))
    expect(downloadStatus(download({ receivedBytes: 2048 }))).toBe(frenchSpaces('2 Ko reçus'))
  })

  it('gives the size of a finished file and the reason a stopped one stopped', () => {
    expect(downloadStatus(download({ state: 'completed', receivedBytes: 2048, totalBytes: 2048 }))).toBe(frenchSpaces('2 Ko'))
    expect(downloadStatus(download({ state: 'completed', receivedBytes: 512, totalBytes: 0 }))).toBe(frenchSpaces('512 o'))
    expect(downloadStatus(download({ state: 'cancelled' }))).toBe('Annulé')
    expect(downloadStatus(download({ state: 'interrupted' }))).toBe('Interrompu')
  })
})

describe('the list', () => {
  const list = [download({ id: 'old', startedAt: 1 }), download({ id: 'new', startedAt: 3, state: 'completed' }), download({ id: 'mid', startedAt: 2, state: 'cancelled' })]

  it('is newest first and does not reorder what it is given', () => {
    expect(sortDownloads(list).map((d) => d.id)).toEqual(['new', 'mid', 'old'])
    expect(list.map((d) => d.id)).toEqual(['old', 'new', 'mid'])
  })

  it('keeps running downloads out of what "clear" removes', () => {
    expect(finishedDownloads(list).map((d) => d.id)).toEqual(['new', 'mid'])
  })
})

describe('pause and resume', () => {
  it('says a download is paused, with how far it got', () => {
    expect(downloadStatus(download({ receivedBytes: 1024, totalBytes: 2048, paused: true }))).toBe(frenchSpaces('En pause · 1 Ko sur 2 Ko'))
    expect(downloadStatus(download({ receivedBytes: 2048, paused: true }))).toBe(frenchSpaces('En pause · 2 Ko reçus'))
  })

  it('says an interrupted download can go on only when the engine says so', () => {
    expect(downloadStatus(download({ state: 'interrupted', resumable: true }))).toBe('Interrompu · peut reprendre')
    expect(downloadStatus(download({ state: 'interrupted' }))).toBe('Interrompu')
  })

  it('says a file opened without being kept is not kept', () => {
    expect(downloadStatus(download({ state: 'completed', receivedBytes: 2048, totalBytes: 2048, temporary: true }))).toBe(frenchSpaces('2 Ko · ouvert sans être gardé'))
  })

  it('offers pause to a running download and resume to a paused or resumable one, never both', () => {
    const cases: Array<[Parameters<typeof download>[0], boolean, boolean]> = [
      [{}, true, false],
      [{ paused: true }, false, true],
      [{ state: 'interrupted', resumable: true }, false, true],
      [{ state: 'interrupted' }, false, false],
      [{ state: 'completed' }, false, false],
      [{ state: 'cancelled', paused: true }, false, false]
    ]
    for (const [over, pause, resume] of cases) expect([canPauseDownload(download(over)), canResumeDownload(download(over))], JSON.stringify(over)).toEqual([pause, resume])
  })
})

describe('the buttons of the resumption after a restart', () => {
  const recorded = (patch: Partial<DownloadInfo> = {}) => download({ state: 'interrupted', resumable: true, recorded: true, ...patch })
  const off = { pause: false, resumeRecorded: false }

  it('shows a row that stands for a record as resumable only while the setting that keeps records is on', () => {
    expect(shownDownload(recorded(), { pause: false, resumeRecorded: true })).toMatchObject({ resumable: true, recorded: true })
    expect(shownDownload(recorded(), off)).toMatchObject({ resumable: false })
  })

  it('leaves the row as it is when the pause setting is on', () => {
    const row = recorded({ paused: true })
    expect(shownDownload(row, { pause: true, resumeRecorded: false })).toBe(row)
  })

  it('does not make a plain interrupted row resumable because the record setting is on', () => {
    expect(shownDownload(download({ state: 'interrupted', resumable: true }), { pause: false, resumeRecorded: true })).toMatchObject({ resumable: false })
  })

  it('offers the resume button for a recorded row with the record setting, any resumable row with the pause setting, and no other', () => {
    expect(offersResume(recorded(), { pause: false, resumeRecorded: true })).toBe(true)
    expect(offersResume(recorded(), off)).toBe(false)
    expect(offersResume(download({ state: 'interrupted', resumable: true }), { pause: false, resumeRecorded: true })).toBe(false)
    expect(offersResume(download({ state: 'interrupted', resumable: true }), { pause: true, resumeRecorded: false })).toBe(true)
    expect(offersResume(recorded({ resumable: false }), { pause: true, resumeRecorded: true })).toBe(false)
    expect(offersResume(download({ state: 'completed', recorded: true }), { pause: true, resumeRecorded: true })).toBe(false)
  })

  it('does not clear in bulk a download a record can still carry on', () => {
    const list = [download({ id: 'done', state: 'completed' }), recorded({ id: 'resumable' }), download({ id: 'running' }), download({ id: 'gone', state: 'interrupted', recorded: true })]
    expect(finishedDownloads(list).map((d) => d.id)).toEqual(['done', 'gone'])
  })
})

describe('resumeAllowed', () => {
  const recordedRow = { recorded: true }
  it('lets the pause setting resume what runs, whatever the row', () => {
    expect(resumeAllowed({ downloadPause: true, downloadResume: false }, undefined, false)).toBe(true)
    expect(resumeAllowed({ downloadPause: true, downloadResume: false }, recordedRow, true)).toBe(true)
  })

  it('lets the record setting resume a row that stands for a record, and nothing else', () => {
    expect(resumeAllowed({ downloadPause: false, downloadResume: true }, recordedRow, false)).toBe(true)
    expect(resumeAllowed({ downloadPause: false, downloadResume: true }, {}, false)).toBe(false)
    expect(resumeAllowed({ downloadPause: false, downloadResume: true }, undefined, false)).toBe(false)
  })

  it('never resumes a record from a private window', () => {
    expect(resumeAllowed({ downloadPause: false, downloadResume: true }, recordedRow, true)).toBe(false)
  })

  it('does nothing with both settings off', () => {
    expect(resumeAllowed({ downloadPause: false, downloadResume: false }, recordedRow, false)).toBe(false)
  })
})

describe('interruptedBecause', () => {
  const MB = 1024 ** 2

  it('says the disk is full when what is left of the file does not fit', () => {
    expect(interruptedBecause({ freeBytes: 3 * MB, receivedBytes: 2 * MB, totalBytes: 20 * MB })).toBe('disk-full')
    expect(interruptedBecause({ freeBytes: 0, receivedBytes: 2 * MB, totalBytes: 20 * MB })).toBe('disk-full')
  })

  it('says nothing when the room is there (a dropped connection is only "interrupted"), or when the disk cannot be asked', () => {
    expect(interruptedBecause({ freeBytes: 50 * MB, receivedBytes: 2 * MB, totalBytes: 20 * MB })).toBeUndefined()
    expect(interruptedBecause({ freeBytes: null, receivedBytes: 2 * MB, totalBytes: 20 * MB })).toBeUndefined()
    expect(interruptedBecause({ freeBytes: Number.NaN, receivedBytes: 2 * MB, totalBytes: 20 * MB })).toBeUndefined()
  })

  it('judges by a minimum of room when the size is not known', () => {
    expect(interruptedBecause({ freeBytes: DISK_MIN_FREE_BYTES - 1, receivedBytes: 5, totalBytes: 0 })).toBe('disk-full')
    expect(interruptedBecause({ freeBytes: DISK_MIN_FREE_BYTES, receivedBytes: 5, totalBytes: 0 })).toBeUndefined()
  })
})

describe('what an interrupted row says', () => {
  it('names a full disk, with or without the way to carry on', () => {
    expect(downloadStatus(download({ state: 'interrupted', reason: 'disk-full' }))).toBe('Interrompu · disque plein')
    expect(downloadStatus(download({ state: 'interrupted', reason: 'disk-full', resumable: true }))).toBe('Interrompu · disque plein · peut reprendre')
    expect(downloadStatus(download({ state: 'interrupted' }))).toBe('Interrompu')
  })
})

describe('the notices of a file', () => {
  it('name the file', () => {
    for (const text of [unmarkedNotice('a.dmg'), missingFileNotice('a.dmg'), partialRemovalNotice('a.dmg', 'EACCES')]) expect(text).toContain('a.dmg')
    expect(partialRemovalNotice('a.dmg', 'EACCES')).toContain('EACCES')
  })
})

describe('withDownload', () => {
  it('puts the reported download in front, in the place of its own row', () => {
    const rows = [download({ id: 'a' }), download({ id: 'b' })]
    expect(withDownload(rows, download({ id: 'b', receivedBytes: 5 }), new Set(), 10).map((d) => [d.id, d.receivedBytes])).toEqual([['b', 5], ['a', 0]])
    expect(withDownload(rows, download({ id: 'c' }), new Set(), 10).map((d) => d.id)).toEqual(['c', 'a', 'b'])
  })

  it('keeps no more rows than it is told to', () => {
    expect(withDownload([download({ id: 'a' }), download({ id: 'b' })], download({ id: 'c' }), new Set(), 2).map((d) => d.id)).toEqual(['c', 'a'])
  })

  it('does not bring back a row the user removed when its download reports its last word (cancelled for the removal)', () => {
    const rows = [download({ id: 'a' })]
    expect(withDownload(rows, download({ id: 'gone', state: 'cancelled' }), new Set(['gone']), 10).map((d) => d.id)).toEqual(['a'])
    expect(withDownload([download({ id: 'gone' }), ...rows], download({ id: 'gone', state: 'cancelled' }), new Set(['gone']), 10).map((d) => d.id)).toEqual(['a'])
  })
})
