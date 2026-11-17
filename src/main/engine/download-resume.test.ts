// The resumption of downloads after a restart, against real files in a folder of the test: the records on disk, the checks made before a
// partial file is touched, and the order of a resumption. The engine's part (Electron's `createInterruptedDownload`) is a port, a stand-in here.

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  FINGERPRINT_BYTES,
  RESUME_FILE,
  RESUME_FILE_MAX_BYTES,
  RESUME_MAX_AGE_MS,
  RESUME_MAX_RECORDS,
  RESUME_CHECKPOINT_MS,
  judgeProbe,
  type ItemView,
  type ProbeAnswer,
  type ResumeRecord
} from '@shared/download-resume'
import { NOW, TOKEN, record } from '@shared/download-resume-support'
import type { DownloadInfo } from '@shared/model'
import {
  DownloadResume,
  ResumeStore,
  checkPlace,
  describeError,
  inspectPartial,
  lexicalPlace,
  realResumeFs,
  type CreateInterruptedOptions,
  type ProbeRequest,
  type ResumeFs,
  type ResumePorts,
  type Tracker
} from './download-resume'
import { frenchSpaces } from '@shared/french-typography'
import { expectMode } from '../windows.test-support'

const MIB = 1024 * 1024
let base = ''
let folder = ''
let dataDir = ''
let file = ''
const clock = { now: NOW }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lucium-resume-'))
  folder = join(base, 'Downloads')
  dataDir = join(base, 'data')
  mkdirSync(folder)
  mkdirSync(dataDir)
  file = join(dataDir, RESUME_FILE)
  clock.now = NOW
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

/** Deterministic bytes: the same size and seed give the same file, and two seeds differ everywhere. */
function bytes(size: number, seed = 1): Buffer {
  const out = Buffer.alloc(size)
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed * 17 + (i >> 8)) & 255
  return out
}
/** Changes one byte of a buffer. */
const flip = (data: Buffer, index: number): void => void (data[index] = data[index]! ^ 0xff)
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

/** A partial file of `size` bytes in the downloads folder, and the record that says `offset` of them were confirmed. */
function partial(name: string, size = 3 * MIB, offset = 2 * MIB, patch: Partial<ResumeRecord> = {}): { path: string; content: Buffer; rec: ResumeRecord } {
  const path = join(folder, name)
  const content = bytes(size)
  writeFileSync(path, content)
  const rec = record({
    id: `rs-${Buffer.from(name).toString('hex').padEnd(12, '0').slice(0, 12)}`,
    path,
    offset,
    length: 10 * MIB,
    head: sha(content.subarray(0, FINGERPRINT_BYTES)),
    tail: sha(content.subarray(offset - FINGERPRINT_BYTES, offset)),
    savedAt: clock.now - 1000,
    ...patch
  })
  return { path, content, rec }
}

const writeRecords = (...records: ResumeRecord[]): void => writeFileSync(file, `${JSON.stringify({ version: 1, records })}\n`, { mode: 0o600 })
const recordsOnDisk = (): ResumeRecord[] => (JSON.parse(readFileSync(file, 'utf8')) as { records: ResumeRecord[] }).records

interface Rig {
  service: DownloadResume
  ports: ResumePorts
  logs: string[]
  notices: string[]
  emitted: DownloadInfo[]
  timers: Array<{ run: () => void; ms: number; cleared: boolean }>
  probed: ProbeRequest[]
  created: CreateInterruptedOptions[]
}

function rig(over: Partial<ResumePorts> = {}): Rig {
  const logs: string[] = []
  const notices: string[] = []
  const emitted: DownloadInfo[] = []
  const timers: Rig['timers'] = []
  const probed: ProbeRequest[] = []
  const created: CreateInterruptedOptions[] = []
  let counter = 0
  const ports: ResumePorts = {
    fs: realResumeFs,
    file,
    now: () => clock.now,
    random: () => (++counter).toString(16).padStart(12, '0'),
    folderOf: () => folder,
    profileLive: () => true,
    probe: async (_profile, request) => {
      probed.push(request)
      throw new Error('no answer prepared')
    },
    createInterrupted: (_profile, options) => void created.push(options),
    emit: (info) => void emitted.push(info),
    notify: (message) => void notices.push(message),
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      ;(timer as { cleared: boolean }).cleared = true
    },
    log: (level, message) => void logs.push(`${level}: ${message}`),
    ...over
  }
  return { service: new DownloadResume(ports), ports, logs, notices, emitted, timers, probed, created }
}

/** The answer a server that still holds the same file gives. */
const same = (rec: ResumeRecord): ProbeAnswer => ({ status: 206, headers: { 'content-range': `bytes ${rec.offset}-${rec.offset}/${rec.length}`, etag: rec.etag, 'last-modified': rec.lastModified } })

/** A rig whose server answers with `answer`, recording what it was asked. */
function serving(answer: (rec: ResumeRecord) => ProbeAnswer | Promise<ProbeAnswer>, rec: ResumeRecord, over: Partial<ResumePorts> = {}): Rig {
  const r = rig({
    probe: async (_profile, request) => {
      r.probed.push(request)
      return answer(rec)
    },
    ...over
  })
  return r
}

// ---------------------------------------------------------------------------------------------------------------------------------------

describe('describeError', () => {
  it('tells the kind and the code of an error, never its text (which may repeat an address)', () => {
    const error = Object.assign(new TypeError(`Failed to fetch https://files.example.org/a?token=${TOKEN}`), { code: 'ECONNRESET' })
    expect(describeError(error)).toBe('TypeError (ECONNRESET)')
    expect(describeError(new Error(`net::ERR_NAME_NOT_RESOLVED https://x.test/?t=${TOKEN}`))).toBe('Error (net::ERR_NAME_NOT_RESOLVED)')
    expect(describeError(new Error(`bad https://x.test/?t=${TOKEN}`))).toBe('Error')
    expect(describeError('plain')).toBe('Error')
    expect(describeError(null)).toBe('Error')
  })
})

describe('the file of the records', () => {
  const logged = (): { logs: string[]; log: (level: 'error' | 'warn', message: string) => void } => {
    const logs: string[] = []
    return { logs, log: (level, message) => void logs.push(`${level}: ${message}`) }
  }
  const store = (log = logged()) => ({ store: new ResumeStore(file, realResumeFs, () => clock.now, log.log), ...log })

  it('does nothing when it is only made: no file is read or written', () => {
    const { store: s } = store()
    expect(existsSync(file)).toBe(false)
    expect(s.all()).toEqual([])
  })

  it('makes an empty file for the owner alone, and writes without leaving a neighbour behind', () => {
    const { store: s } = store()
    s.ensure()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, records: [] })
    expectMode(file, 0o600)
    s.put(record(), new Set())
    expectMode(file, 0o600)
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(recordsOnDisk()).toEqual([record()])
  })

  it('narrows a neighbour left wide open by an earlier run', () => {
    writeFileSync(`${file}.tmp`, 'old', { mode: 0o666 })
    chmodSync(`${file}.tmp`, 0o666)
    const { store: s } = store()
    s.put(record(), new Set())
    expectMode(file, 0o600)
  })

  it('reads back what it wrote, and keeps ensure() from touching a file that exists', () => {
    const { store: s } = store()
    s.put(record(), new Set())
    const other = new ResumeStore(file, realResumeFs, () => clock.now, () => undefined)
    other.ensure()
    expect(other.load()).toBe(0)
    expect(other.all()).toEqual([record()])
  })

  it('removes a file that is too large without reading it', () => {
    writeFileSync(file, 'x'.repeat(RESUME_FILE_MAX_BYTES + 1))
    const { store: s, logs } = store()
    expect(s.load()).toBe(0)
    expect(s.all()).toEqual([])
    expect(existsSync(file)).toBe(false)
    expect(logs.join('\n')).toContain('cannot be read')
    expect(logs.join('\n')).toContain(file)
  })

  it('removes a file that is not JSON, or not of this version, and says so', () => {
    for (const text of ['{not json', JSON.stringify({ version: 2, records: [] }), JSON.stringify({ version: 1 }), JSON.stringify([]), 'null']) {
      writeFileSync(file, text)
      const { store: s, logs } = store()
      expect(s.load()).toBe(0)
      expect(existsSync(file), text).toBe(false)
      expect(logs.join('\n'), text).toMatch(/removed/)
    }
  })

  it('removes a link put in place of the file, and leaves what it pointed to alone', () => {
    const target = join(base, 'precious.txt')
    writeFileSync(target, 'keep me')
    symlinkSync(target, file)
    const { store: s } = store()
    expect(s.load()).toBe(0)
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('keep me')
  })

  it('drops the records that are not valid, the duplicates and what is beyond the limit, and counts them', () => {
    const many = Array.from({ length: RESUME_MAX_RECORDS + 3 }, (_, i) => record({ id: `rs-${i.toString(16).padStart(12, '0')}` }))
    writeFileSync(file, JSON.stringify({ version: 1, records: [record({ id: 'rs-ffffffffffff' }), record({ id: 'rs-ffffffffffff' }), { id: 'nope' }, ...many] }))
    const { store: s, logs } = store()
    const dropped = s.load()
    expect(s.all()).toHaveLength(RESUME_MAX_RECORDS)
    // One duplicate, one that is not a record, and the four that do not fit after the valid one.
    expect(dropped).toBe(1 + 1 + 4)
    expect(logs.join('\n')).toContain('not valid')
    expect(logs.join('\n')).not.toContain(TOKEN)
  })

  it('makes room for a new record by dropping the oldest that no download in progress owns, and refuses when there is none', () => {
    const { store: s } = store()
    const ids = Array.from({ length: RESUME_MAX_RECORDS }, (_, i) => `rs-${i.toString(16).padStart(12, '0')}`)
    ids.forEach((id, i) => s.put(record({ id, savedAt: NOW - 1000 + i }), new Set()))
    expect(s.all()).toHaveLength(RESUME_MAX_RECORDS)
    expect(s.put(record({ id: 'rs-aaaaaaaaaaaa' }), new Set(ids.slice(1)))).toBe(true)
    expect(s.has(ids[0]!)).toBe(false)
    expect(s.has('rs-aaaaaaaaaaaa')).toBe(true)
    expect(s.all()).toHaveLength(RESUME_MAX_RECORDS)
    expect(s.put(record({ id: 'rs-bbbbbbbbbbbb' }), new Set(s.all().map((r) => r.id)))).toBe(false)
    expect(s.has('rs-bbbbbbbbbbbb')).toBe(false)
  })

  it('replaces a record of the same id without growing', () => {
    const { store: s } = store()
    s.put(record({ offset: 2 * MIB }), new Set())
    s.put(record({ offset: 3 * MIB }), new Set())
    expect(recordsOnDisk()).toHaveLength(1)
    expect(recordsOnDisk()[0]!.offset).toBe(3 * MIB)
  })

  it('removes a record and, with destroy, the file', () => {
    const { store: s } = store()
    s.put(record(), new Set())
    s.remove(record().id)
    expect(recordsOnDisk()).toEqual([])
    s.destroy()
    expect(existsSync(file)).toBe(false)
    expect(s.all()).toEqual([])
  })

  it('refuses to write a file larger than it would read back, and the record is not kept', () => {
    const small = new ResumeStore(file, realResumeFs, () => clock.now, () => undefined, 1000)
    small.put(record({ id: 'rs-000000000001' }), new Set())
    expect(() => small.put(record({ id: 'rs-000000000002', url: `https://files.example.org/${'a'.repeat(1500)}` }), new Set())).toThrow(/larger than allowed/)
    expect(small.has('rs-000000000002')).toBe(false)
    expect(recordsOnDisk().map((r) => r.id)).toEqual(['rs-000000000001'])
  })

  it('does not keep a record that could not be written, and gives the older one back when it was replacing it', () => {
    let failing = false
    const flaky: ResumeFs = {
      ...realResumeFs,
      writeText: (path, text) => {
        if (failing) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        realResumeFs.writeText(path, text)
      }
    }
    const s = new ResumeStore(file, flaky, () => clock.now, () => undefined)
    s.put(record({ offset: 2 * MIB }), new Set())
    failing = true
    expect(() => s.put(record({ offset: 3 * MIB }), new Set())).toThrow(/disk full/)
    expect(s.get(record().id)!.offset).toBe(2 * MIB)
    expect(() => s.put(record({ id: 'rs-000000000009' }), new Set())).toThrow(/disk full/)
    expect(s.has('rs-000000000009')).toBe(false)
  })
})

describe('where a recorded path leads', () => {
  it('accepts a file directly in the folder, and in a folder an extension named', () => {
    expect(lexicalPlace(join(folder, 'a.zip'), folder)).toBe(true)
    expect(lexicalPlace(join(folder, 'sub', 'a.zip'), folder)).toBe(true)
  })

  it('refuses the folder itself, a path outside it, a sibling that shares its prefix, `..` and a relative path', () => {
    expect(lexicalPlace(folder, folder)).toBe(false)
    expect(lexicalPlace(join(base, 'elsewhere', 'a.zip'), folder)).toBe(false)
    expect(lexicalPlace(`${folder}-evil/a.zip`, folder)).toBe(false)
    expect(lexicalPlace(`${folder}/../data/${RESUME_FILE}`, folder)).toBe(false)
    expect(lexicalPlace('a.zip', folder)).toBe(false)
    expect(lexicalPlace('/etc/passwd', folder)).toBe(false)
  })

  it('refuses a name the application would not have written', () => {
    expect(lexicalPlace(join(folder, 'fdp‮exe.txt'), folder)).toBe(false)
    expect(lexicalPlace(join(folder, '.hidden'), folder)).toBe(false)
    expect(lexicalPlace(join(folder, 'trailing. '), folder)).toBe(false)
  })

  it('refuses, on Windows only, a name Windows would not have kept (a colon, a device name)', () => {
    for (const name of ['a:b.txt', 'CON.txt', 'what?.pdf']) {
      expect(lexicalPlace(join(folder, name), folder, 'win32')).toBe(false)
      expect(lexicalPlace(join(folder, name), folder, 'darwin')).toBe(true)
    }
  })

  it('finds an ordinary file in place', () => {
    const { path } = partial('a.zip')
    expect(checkPlace(path, folder, realResumeFs).place).toBe('ok')
  })

  it('says a file or folder is missing, and a folder that is not a folder is not the folder', () => {
    expect(checkPlace(join(folder, 'gone.zip'), folder, realResumeFs)).toEqual({ place: 'missing' })
    expect(checkPlace(join(folder, 'sub', 'a.zip'), folder, realResumeFs)).toEqual({ place: 'missing' })
    expect(checkPlace(join(folder, 'a.zip'), join(base, 'no-such-folder'), realResumeFs)).toEqual({ place: 'place' })
    const plain = join(base, 'plain-file')
    writeFileSync(plain, 'x')
    expect(checkPlace(join(plain, 'a.zip'), plain, realResumeFs)).toEqual({ place: 'place' })
  })

  it('refuses a link where the file should be, and leaves what it points to alone', () => {
    const target = join(base, 'secret.txt')
    writeFileSync(target, 'secret')
    symlinkSync(target, join(folder, 'a.zip'))
    expect(checkPlace(join(folder, 'a.zip'), folder, realResumeFs)).toEqual({ place: 'unsafe' })
    expect(readFileSync(target, 'utf8')).toBe('secret')
  })

  it('refuses a link on the way (a folder replaced by a link to elsewhere)', () => {
    const elsewhere = join(base, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'a.zip'), 'x')
    symlinkSync(elsewhere, join(folder, 'sub'))
    expect(checkPlace(join(folder, 'sub', 'a.zip'), folder, realResumeFs)).toEqual({ place: 'unsafe' })
  })

  it('accepts a downloads folder that is itself a link (the user’s choice), not what is below it', () => {
    const real = join(base, 'real-downloads')
    mkdirSync(real)
    const linked = join(base, 'linked-downloads')
    symlinkSync(real, linked)
    writeFileSync(join(real, 'a.zip'), 'x')
    expect(checkPlace(join(linked, 'a.zip'), linked, realResumeFs).place).toBe('ok')
  })

  it('refuses a file with a second name (a hard link to a file elsewhere) and a folder where a file should be', () => {
    const target = join(base, 'other.bin')
    writeFileSync(target, 'x')
    linkSync(target, join(folder, 'a.zip'))
    expect(checkPlace(join(folder, 'a.zip'), folder, realResumeFs)).toEqual({ place: 'unsafe' })
    mkdirSync(join(folder, 'b.zip'))
    expect(checkPlace(join(folder, 'b.zip'), folder, realResumeFs)).toEqual({ place: 'unsafe' })
  })
})

describe('the partial file of a record', () => {
  it('is ours and intact when its first and its last megabyte are the ones that were fingerprinted', () => {
    const { rec, content } = partial('a.zip')
    expect(inspectPartial(rec, folder, realResumeFs)).toEqual({ place: 'ok', size: content.length, ours: true, intact: true, complete: false })
  })

  it('is not ours when its first megabyte is another’s', () => {
    const { rec, path, content } = partial('a.zip')
    const other = Buffer.from(content)
    flip(other, 10)
    writeFileSync(path, other)
    expect(inspectPartial(rec, folder, realResumeFs)).toMatchObject({ place: 'ok', ours: false, intact: false })
  })

  it('is ours but not intact when a byte below the offset changed', () => {
    const { rec, path, content } = partial('a.zip')
    const other = Buffer.from(content)
    flip(other, 2 * MIB - 5)
    writeFileSync(path, other)
    expect(inspectPartial(rec, folder, realResumeFs)).toMatchObject({ place: 'ok', ours: true, intact: false })
  })

  it('is ours but not intact when it is shorter than the offset', () => {
    const { rec, path, content } = partial('a.zip')
    writeFileSync(path, content.subarray(0, 2 * MIB - 100))
    expect(inspectPartial(rec, folder, realResumeFs)).toMatchObject({ place: 'ok', ours: true, intact: false })
  })

  it('is not ours when it is smaller than the fingerprint', () => {
    const { rec, path } = partial('a.zip')
    writeFileSync(path, 'tiny')
    expect(inspectPartial(rec, folder, realResumeFs)).toMatchObject({ place: 'ok', ours: false, intact: false })
  })

  it('is cut to the offset when it is intact and longer, only when asked', () => {
    const { rec, path } = partial('a.zip', 3 * MIB, 2 * MIB)
    inspectPartial(rec, folder, realResumeFs)
    expect(statSync(path).size).toBe(3 * MIB)
    inspectPartial(rec, folder, realResumeFs, { truncate: true })
    expect(statSync(path).size).toBe(2 * MIB)
  })

  it('is never cut when it is not intact', () => {
    const { rec, path, content } = partial('a.zip', 3 * MIB, 2 * MIB)
    const other = Buffer.from(content)
    flip(other, 2 * MIB - 1)
    writeFileSync(path, other)
    inspectPartial(rec, folder, realResumeFs, { truncate: true })
    expect(statSync(path).size).toBe(3 * MIB)
  })

  it('is refused when the file opened is not the file that was judged', () => {
    const { rec } = partial('a.zip')
    const swapped: ResumeFs = { ...realResumeFs, fstat: (fd) => ({ ...realResumeFs.fstat(fd), ino: realResumeFs.fstat(fd).ino + 1 }) }
    expect(inspectPartial(rec, folder, swapped)).toEqual({ place: 'unsafe' })
  })

  it('is refused when a link took the file’s place after the look (the open does not follow it)', () => {
    const { rec, path } = partial('a.zip')
    const target = join(base, 'target.bin')
    writeFileSync(target, bytes(3 * MIB))
    const racing: ResumeFs = {
      ...realResumeFs,
      lstat: (p) => {
        const facts = realResumeFs.lstat(p)
        if (p === path) {
          rmSync(path)
          symlinkSync(target, path)
        }
        return facts
      }
    }
    expect(inspectPartial(rec, folder, racing)).toEqual({ place: 'unsafe' })
    expect(statSync(target).size).toBe(3 * MIB)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------

describe('recording a download in progress', () => {
  const live = (name = 'a.zip', size = 3 * MIB): { path: string; view: () => ItemView; item: ItemView; content: Buffer } => {
    const { path, content } = partial(name, size)
    const item: ItemView = { url: record().url, received: size, total: 10 * MIB, etag: record().etag, lastModified: record().lastModified, startTime: NOW / 1000 - 600, mimeType: 'application/zip' }
    return { path, content, item, view: () => item }
  }
  const track = (r: Rig, l: ReturnType<typeof live>, over: Partial<Parameters<DownloadResume['track']>[0]> = {}): Tracker | null =>
    r.service.track({ profileId: 'default', path: l.path, folder, privateScope: false, view: l.view, ...over })

  it('writes the address and the path of the partial file, with fingerprints of the file, after the first progress', () => {
    const r = rig()
    r.service.start(true)
    const l = live()
    const tracker = track(r, l)!
    expect(tracker).not.toBeNull()
    tracker.progress()
    const [written] = recordsOnDisk()
    expect(written).toMatchObject({ profileId: 'default', url: l.item.url, path: l.path, offset: 3 * MIB, length: 10 * MIB, etag: l.item.etag, lastModified: l.item.lastModified, mimeType: 'application/zip', savedAt: NOW })
    expect(written!.head).toBe(sha(l.content.subarray(0, FINGERPRINT_BYTES)))
    expect(written!.tail).toBe(sha(l.content.subarray(3 * MIB - FINGERPRINT_BYTES, 3 * MIB)))
    expect(tracker.recorded()).toBe(true)
    expectMode(file, 0o600)
  })

  it('writes at most once every few seconds for one download, and at once when it is interrupted', () => {
    const r = rig()
    r.service.start(true)
    const l = live()
    const tracker = track(r, l)!
    tracker.progress()
    appendFileSync(l.path, bytes(MIB, 2))
    l.item.received += MIB
    clock.now += RESUME_CHECKPOINT_MS - 1
    tracker.progress()
    expect(recordsOnDisk()[0]!.offset).toBe(3 * MIB)
    clock.now += 1
    tracker.progress()
    expect(recordsOnDisk()[0]!.offset).toBe(4 * MIB)
    appendFileSync(l.path, bytes(MIB, 3))
    l.item.received += MIB
    tracker.interrupted()
    expect(recordsOnDisk()[0]!.offset).toBe(5 * MIB)
  })

  it('records what is on the disk when Chromium counts more than the file holds', () => {
    const r = rig()
    r.service.start(true)
    const l = live()
    l.item.received = 4 * MIB
    track(r, l)!.progress()
    expect(recordsOnDisk()[0]!.offset).toBe(3 * MIB)
  })

  it('never records a private window or tab, and nothing about it is written', () => {
    const r = rig()
    r.service.start(true)
    const before = readFileSync(file, 'utf8')
    const l = live()
    expect(track(r, l, { privateScope: true })).toBeNull()
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(readFileSync(file, 'utf8')).not.toContain(TOKEN)
  })

  it('records nothing for a place outside the downloads folder', () => {
    const r = rig()
    r.service.start(true)
    const outside = join(base, 'elsewhere.zip')
    writeFileSync(outside, bytes(3 * MIB))
    const l = live()
    expect(r.service.track({ profileId: 'default', path: outside, folder, privateScope: false, view: l.view })).toBeNull()
    expect(r.service.track({ profileId: 'default', path: join(folder, '..', 'elsewhere.zip'), folder, privateScope: false, view: l.view })).toBeNull()
  })

  it('records nothing before it is started, nor when this launch cannot record', () => {
    const l = live()
    expect(track(rig(), l)).toBeNull()
    const r = rig()
    r.service.start(false)
    expect(track(r, l)).toBeNull()
  })

  it('records nothing for a download that is too small, of unknown size, or without strong validators', () => {
    const r = rig()
    r.service.start(true)
    const small = live('small.zip', MIB / 2)
    small.item.received = MIB / 2
    track(r, small)!.progress()
    const unknown = live('unknown.zip')
    unknown.item.total = 0
    track(r, unknown)!.progress()
    const weak = live('weak.zip')
    weak.item.etag = 'W/"x"'
    track(r, weak)!.progress()
    expect(recordsOnDisk()).toEqual([])
  })

  it('drops the record of a download that completed or was cancelled', () => {
    for (const state of ['completed', 'cancelled'] as const) {
      const r = rig()
      r.service.start(true)
      const l = live(`${state}.zip`)
      const tracker = track(r, l)!
      tracker.progress()
      expect(tracker.recorded()).toBe(true)
      expect(tracker.finish(state, undefined)).toBe(false)
      expect(recordsOnDisk()).toEqual([])
    }
  })

  it('keeps the record of a download that was interrupted and can go on, with a last look at the file', () => {
    const r = rig()
    r.service.start(true)
    const l = live()
    const tracker = track(r, l)!
    tracker.progress()
    appendFileSync(l.path, bytes(MIB, 4))
    l.item.received += MIB
    expect(tracker.finish('interrupted', true)).toBe(true)
    expect(recordsOnDisk()[0]!.offset).toBe(4 * MIB)
    expect(r.service.isRecorded(tracker.recordId)).toBe(true)
  })

  it('drops the record of an interrupted download that Chromium says cannot go on', () => {
    const r = rig()
    r.service.start(true)
    const tracker = track(r, live())!
    tracker.progress()
    expect(tracker.finish('interrupted', false)).toBe(false)
    expect(recordsOnDisk()).toEqual([])
  })

  it('keeps the last answer of a download when Electron stops answering at its end', () => {
    const r = rig()
    r.service.start(true)
    const l = live()
    let over = false
    const tracker = r.service.track({
      profileId: 'default',
      path: l.path,
      folder,
      privateScope: false,
      view: () => {
        if (over) throw new Error('Object has been destroyed')
        return l.item
      }
    })!
    tracker.progress()
    over = true
    expect(tracker.finish('interrupted', true)).toBe(true)
    expect(recordsOnDisk()).toHaveLength(1)
  })

  it('goes on without a record and says so once when the file cannot be written', () => {
    const failing: ResumeFs = {
      ...realResumeFs,
      writeText: (path, text) => {
        if (JSON.parse(text).records.length > 0) throw Object.assign(new Error(`disk full ${record().url}`), { code: 'ENOSPC' })
        realResumeFs.writeText(path, text)
      }
    }
    const r = rig({ fs: failing })
    r.service.start(true)
    const l = live()
    const tracker = track(r, l)!
    tracker.progress()
    clock.now += RESUME_CHECKPOINT_MS
    tracker.progress()
    expect(tracker.recorded()).toBe(false)
    expect(r.notices.filter((n) => n.includes('Impossible d’enregistrer'))).toHaveLength(1)
    expect(r.logs.join('\n')).toContain('ENOSPC')
    expect(r.logs.join('\n')).not.toContain(TOKEN)
  })

  it('says it when it cannot look at the file, and the next checkpoint tries again', () => {
    const r = rig({
      fs: {
        ...realResumeFs,
        open: () => {
          throw Object.assign(new Error('boom'), { code: 'EIO' })
        }
      }
    })
    r.service.start(true)
    const tracker = track(r, live())!
    tracker.progress()
    expect(r.logs.join('\n')).toContain('cannot make a checkpoint')
    expect(r.logs.join('\n')).toContain('EIO')
    expect(tracker.recorded()).toBe(false)
  })

  it('refuses a twenty-first download in progress', () => {
    const r = rig()
    r.service.start(true)
    for (let i = 0; i < RESUME_MAX_RECORDS; i++) expect(track(r, live(`f${i}.zip`))).not.toBeNull()
    expect(track(r, live('one-more.zip'))).toBeNull()
  })

  it('removes a record that outlived its time, with its partial file, whenever the file is written anyway', () => {
    const old = partial('old.zip')
    writeRecords(old.rec)
    const r = rig()
    expect(r.service.start(true)).toHaveLength(1)
    clock.now += RESUME_MAX_AGE_MS + 1
    const l = live('new.zip')
    track(r, l)!.progress()
    expect(recordsOnDisk().map((x) => x.path)).toEqual([l.path])
    expect(existsSync(old.path)).toBe(false)
    expect(existsSync(l.path)).toBe(true)
  })
})

describe('turning the service on', () => {
  it('only makes the file when the launch cannot record, and reads nothing', () => {
    const { rec } = partial('a.zip')
    writeRecords(rec)
    let reads = 0
    const r = rig({ fs: { ...realResumeFs, readText: (...args) => (reads++, realResumeFs.readText(...args)) } })
    expect(r.service.start(false)).toEqual([])
    expect(reads).toBe(0)
    expect(r.service.isStarted).toBe(true)
    expect(r.service.isRecording).toBe(false)
  })

  it('makes the file, so that the next launch downloads in a single stream', () => {
    const r = rig()
    r.service.start(false)
    expect(existsSync(file)).toBe(true)
    expectMode(file, 0o600)
  })

  it('stays off, and says why, when the file cannot be made', () => {
    const r = rig({
      fs: {
        ...realResumeFs,
        writeText: () => {
          throw Object.assign(new Error('read-only'), { code: 'EROFS' })
        }
      }
    })
    expect(() => r.service.start(true)).toThrow(/read-only/)
    expect(r.service.isStarted).toBe(false)
    expect(r.service.track({ profileId: 'default', path: join(folder, 'a.zip'), folder, privateScope: false, view: () => ({}) as ItemView })).toBeNull()
  })

  it('brings back each valid record as an interrupted row that shows host and path only', () => {
    const { rec } = partial('a.zip')
    writeRecords(rec)
    const r = rig()
    const [row] = r.service.start(true)
    expect(row).toMatchObject({ id: rec.id, filename: 'a.zip', path: rec.path, state: 'interrupted', receivedBytes: rec.offset, totalBytes: rec.length, resumable: true, recorded: true, url: 'https://files.example.org/get/archive.zip' })
    expect(JSON.stringify(row)).not.toContain(TOKEN)
    expect(r.notices).toEqual([])
  })

  it('asks for nothing from the server and touches no file at launch', () => {
    const { rec, content, path } = partial('a.zip')
    writeRecords(rec)
    const r = rig()
    r.service.start(true)
    expect(r.probed).toEqual([])
    expect(r.created).toEqual([])
    expect(readFileSync(path).equals(content)).toBe(true)
  })

  it('drops a record that outlived its time, with its partial file, and tells the user how many', () => {
    const old = partial('old.zip', 3 * MIB, 2 * MIB, { savedAt: NOW - RESUME_MAX_AGE_MS - 1 })
    const fresh = partial('fresh.zip')
    writeRecords(old.rec, fresh.rec)
    const r = rig()
    const rows = r.service.start(true)
    expect(rows.map((row) => row.id)).toEqual([fresh.rec.id])
    expect(existsSync(old.path)).toBe(false)
    expect(existsSync(fresh.path)).toBe(true)
    expect(recordsOnDisk().map((x) => x.id)).toEqual([fresh.rec.id])
    expect(r.notices).toEqual([frenchSpaces('Un téléchargement interrompu ne peut plus être repris : il a été retiré de la liste de reprise.')])
  })

  it('does not remove an old file that is no longer the one recorded', () => {
    const old = partial('old.zip', 3 * MIB, 2 * MIB, { savedAt: NOW - RESUME_MAX_AGE_MS - 1 })
    writeFileSync(old.path, bytes(3 * MIB, 99))
    writeRecords(old.rec)
    const r = rig()
    expect(r.service.start(true)).toEqual([])
    expect(readFileSync(old.path).equals(bytes(3 * MIB, 99))).toBe(true)
    expect(recordsOnDisk()).toEqual([])
  })

  it('drops a record whose profile is gone and leaves its file alone', () => {
    const { rec, path } = partial('a.zip')
    writeRecords(rec)
    const r = rig({ profileLive: () => false })
    expect(r.service.start(true)).toEqual([])
    expect(existsSync(path)).toBe(true)
    expect(recordsOnDisk()).toEqual([])
  })

  it('drops a record whose file lies outside the downloads folder, and touches nothing there', () => {
    const outside = join(base, 'important.docx')
    writeFileSync(outside, bytes(3 * MIB))
    const { rec } = partial('a.zip', 3 * MIB, 2 * MIB, { path: outside, head: sha(bytes(3 * MIB).subarray(0, FINGERPRINT_BYTES)), tail: sha(bytes(3 * MIB).subarray(MIB, 2 * MIB)) })
    writeRecords(rec)
    const r = rig()
    expect(r.service.start(true)).toEqual([])
    expect(readFileSync(outside).equals(bytes(3 * MIB))).toBe(true)
    expect(recordsOnDisk()).toEqual([])
  })

  it('drops a record whose file became a link, and touches nothing it points to', () => {
    const { rec, path } = partial('a.zip')
    const target = join(base, 'target.bin')
    writeFileSync(target, bytes(3 * MIB))
    rmSync(path)
    symlinkSync(target, path)
    writeRecords(rec)
    const r = rig()
    expect(r.service.start(true)).toEqual([])
    expect(readFileSync(target).equals(bytes(3 * MIB))).toBe(true)
    expect(recordsOnDisk()).toEqual([])
  })

  it('drops a record whose file is gone, or was modified, and keeps a modified file', () => {
    const gone = partial('gone.zip')
    rmSync(gone.path)
    const changed = partial('changed.zip')
    const other = Buffer.from(changed.content)
    flip(other, 2 * MIB - 1)
    writeFileSync(changed.path, other)
    writeRecords(gone.rec, changed.rec)
    const r = rig()
    expect(r.service.start(true)).toEqual([])
    expect(readFileSync(changed.path).equals(other)).toBe(true)
    expect(r.notices).toEqual([frenchSpaces('2 téléchargements interrompus ne peuvent plus être repris : ils ont été retirés de la liste de reprise.')])
  })

  it('removes a partial file that is shorter than the offset (a file cut short is ours and cannot be completed)', () => {
    const { rec, path, content } = partial('a.zip')
    writeFileSync(path, content.subarray(0, 2 * MIB - 100))
    writeRecords(rec)
    const r = rig()
    expect(r.service.start(true)).toEqual([])
    expect(existsSync(path)).toBe(false)
  })
})

describe('resuming a download after a restart', () => {
  it('asks the server for the byte at the offset, then cuts the file to the offset and asks Chromium to go on from there', async () => {
    const { rec, path } = partial('a.zip', 3 * MIB, 2 * MIB)
    writeRecords(rec)
    const r = serving(same, rec)
    r.service.start(true)
    await r.service.resume(rec.id)
    expect(r.probed).toEqual([{ url: rec.url, headers: { Range: `bytes=${rec.offset}-${rec.offset}`, 'If-Range': rec.etag, 'Accept-Encoding': 'identity' } }])
    expect(statSync(path).size).toBe(2 * MIB)
    expect(r.created).toEqual([{ path, urlChain: [rec.url], offset: rec.offset, length: rec.length, lastModified: rec.lastModified, eTag: rec.etag, startTime: rec.startTime }])
    expect(r.notices).toEqual([])
    expect(r.service.takeExpected('default', rec.url)).toEqual(rec)
    expect(r.service.takeExpected('default', rec.url)).toBeNull()
    expect(r.timers.every((t) => t.cleared)).toBe(true)
  })

  it('recognises only the download of the address it asked for, in the profile it asked', async () => {
    const { rec } = partial('a.zip')
    writeRecords(rec)
    const r = serving(same, rec)
    r.service.start(true)
    await r.service.resume(rec.id)
    expect(r.service.takeExpected('work', rec.url)).toBeNull()
    expect(r.service.takeExpected('default', 'https://files.example.org/other.zip')).toBeNull()
    expect(r.service.takeExpected('default', rec.url)).not.toBeNull()
  })

  it('tells the user when Chromium never announces the download', async () => {
    const { rec } = partial('a.zip')
    writeRecords(rec)
    const r = serving(same, rec)
    r.service.start(true)
    await r.service.resume(rec.id)
    const timer = r.timers[0]!
    expect(timer.ms).toBe(15_000)
    timer.run()
    expect(r.notices).toEqual([frenchSpaces('La reprise de « a.zip » n’a pas démarré. Réessayez.')])
    expect(r.service.takeExpected('default', rec.url)).toBeNull()
  })

  const refusals: Array<[string, (rec: ResumeRecord) => ProbeAnswer, { drops: boolean; keepsFile: boolean; text: RegExp }]> = [
    ['the whole file instead of a part', () => ({ status: 200, headers: {} }), { drops: true, keepsFile: false, text: /a changé sur le serveur/ }],
    ['another ETag', (r) => ({ ...same(r), headers: { ...same(r).headers, etag: '"v2"' } }), { drops: true, keepsFile: false, text: /a changé sur le serveur/ }],
    ['another Last-Modified', (r) => ({ ...same(r), headers: { ...same(r).headers, 'last-modified': 'Fri, 23 Oct 2026 07:28:00 GMT' } }), { drops: true, keepsFile: false, text: /a changé/ }],
    ['another length', (r) => ({ ...same(r), headers: { ...same(r).headers, 'content-range': `bytes ${r.offset}-${r.offset}/${r.length + 1}` } }), { drops: true, keepsFile: false, text: /ne permet pas de continuer/ }],
    ['a redirection', () => ({ status: 302, headers: {} }), { drops: true, keepsFile: false, text: /n’existe plus/ }],
    ['a missing file', () => ({ status: 404, headers: {} }), { drops: true, keepsFile: false, text: /n’existe plus/ }],
    ['a refusal (an address that expired)', () => ({ status: 403, headers: {} }), { drops: false, keepsFile: true, text: /a peut-être expiré/ }],
    ['a busy server', () => ({ status: 503, headers: {} }), { drops: false, keepsFile: true, text: /ne répond pas/ }]
  ]
  for (const [name, answer, expected] of refusals) {
    it(`refuses on ${name}: nothing is asked of Chromium, the file is not cut${expected.drops ? ', the record goes' : ', the record stays'}`, async () => {
      const { rec, path } = partial('a.zip', 3 * MIB, 2 * MIB)
      writeRecords(rec)
      const r = serving(answer, rec)
      r.service.start(true)
      await r.service.resume(rec.id)
      expect(r.created).toEqual([])
      expect(r.service.takeExpected('default', rec.url)).toBeNull()
      expect(r.notices).toHaveLength(1)
      expect(r.notices[0]).toMatch(expected.text)
      expect(r.notices[0]).toContain(frenchSpaces('« a.zip »'))
      expect(r.notices[0]).not.toContain(TOKEN)
      expect(recordsOnDisk().length).toBe(expected.drops ? 0 : 1)
      expect(existsSync(path)).toBe(expected.keepsFile)
      if (expected.keepsFile) expect(statSync(path).size).toBe(3 * MIB)
      expect(r.emitted.length).toBe(expected.drops ? 1 : 0)
      if (expected.drops) expect(r.emitted[0]).toMatchObject({ id: rec.id, state: 'interrupted' })
      if (expected.drops) expect(r.emitted[0]).not.toHaveProperty('resumable')
    })
  }

  it('keeps the record when the server cannot be reached, and logs nothing of the address', async () => {
    const { rec, path } = partial('a.zip')
    writeRecords(rec)
    const r = rig({
      probe: async () => {
        throw Object.assign(new TypeError(`fetch failed for ${rec.url}`), { code: 'ECONNREFUSED' })
      }
    })
    r.service.start(true)
    await r.service.resume(rec.id)
    expect(r.notices).toEqual([frenchSpaces('Le serveur de « a.zip » ne répond pas. Réessayez plus tard.')])
    expect(recordsOnDisk()).toHaveLength(1)
    expect(existsSync(path)).toBe(true)
    expect(r.logs.join('\n')).toContain('ECONNREFUSED')
    expect(r.logs.join('\n') + r.notices.join('\n')).not.toContain(TOKEN)
    // The record is still there to try again.
    expect(r.service.isRecorded(rec.id)).toBe(true)
  })

  it('does not ask the server at all for a file that no longer passes the checks, and keeps that file', async () => {
    const { rec, path, content } = partial('a.zip')
    writeRecords(rec)
    const r = serving(same, rec)
    r.service.start(true)
    const other = Buffer.from(content)
    flip(other, 2 * MIB - 1)
    writeFileSync(path, other)
    await r.service.resume(rec.id)
    expect(r.probed).toEqual([])
    expect(r.created).toEqual([])
    expect(r.notices[0]).toContain('a été modifié')
    expect(readFileSync(path).equals(other)).toBe(true)
    expect(recordsOnDisk()).toEqual([])
  })

  it('judges the file again after the server answered, and refuses if it changed meanwhile', async () => {
    const { rec, path, content } = partial('a.zip', 3 * MIB, 2 * MIB)
    writeRecords(rec)
    const r = serving((record) => {
      const other = Buffer.from(content)
      flip(other, 2 * MIB - 10)
      writeFileSync(path, other)
      return same(record)
    }, rec)
    r.service.start(true)
    await r.service.resume(rec.id)
    expect(r.created).toEqual([])
    expect(r.notices[0]).toContain('a été modifié')
    // Not cut, not removed: it is no longer the file that was recorded.
    expect(existsSync(path)).toBe(true)
    expect(statSync(path).size).toBe(3 * MIB)
  })

  it('refuses a record that outlived its time at the moment of the click', async () => {
    const { rec, path } = partial('a.zip')
    writeRecords(rec)
    const r = serving(same, rec)
    r.service.start(true)
    clock.now += RESUME_MAX_AGE_MS + 1
    await r.service.resume(rec.id)
    expect(r.probed).toEqual([])
    expect(r.notices[0]).toContain('trop ancien')
    expect(existsSync(path)).toBe(false)
    expect(recordsOnDisk()).toEqual([])
  })

  it('refuses when the profile’s downloads folder is no longer the one the file is in', async () => {
    const { rec, path } = partial('a.zip')
    writeRecords(rec)
    let current = folder
    const elsewhere = join(base, 'Other')
    mkdirSync(elsewhere)
    const r = serving(same, rec, { folderOf: () => current })
    r.service.start(true)
    current = elsewhere
    await r.service.resume(rec.id)
    expect(r.probed).toEqual([])
    expect(r.notices[0]).toContain('n’est plus dans le dossier de téléchargement')
    expect(existsSync(path)).toBe(true)
    expect(recordsOnDisk()).toEqual([])
  })

  it('says so, keeps the record and takes back its expectation when Chromium refuses to recreate the download', async () => {
    const { rec } = partial('a.zip')
    writeRecords(rec)
    const r = serving(same, rec, {
      createInterrupted: () => {
        throw new Error(`Invalid argument ${rec.url}`)
      }
    })
    r.service.start(true)
    await r.service.resume(rec.id)
    expect(r.notices[0]).toContain('le moteur n’a pas pu relancer')
    expect(r.service.takeExpected('default', rec.url)).toBeNull()
    expect(recordsOnDisk()).toHaveLength(1)
    expect(r.logs.join('\n') + r.notices.join('\n')).not.toContain(TOKEN)
  })

  it('tells the user, and keeps the record, when something unforeseen goes wrong', async () => {
    const { rec } = partial('a.zip')
    writeRecords(rec)
    const r = serving(same, rec, {
      setTimer: () => {
        throw new Error(`boom ${rec.url}`)
      }
    })
    r.service.start(true)
    await r.service.resume(rec.id)
    expect(r.notices).toEqual([frenchSpaces('La reprise de « a.zip » a échoué.')])
    expect(r.logs.join('\n')).toContain('the resumption of')
    expect(r.logs.join('\n')).not.toContain(TOKEN)
    expect(recordsOnDisk()).toHaveLength(1)
  })

  it('does one resumption at a time for a record, and none for a download that is running or a record it does not know', async () => {
    const { rec } = partial('a.zip')
    writeRecords(rec)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const r = serving(async (record) => {
      await gate
      return same(record)
    }, rec)
    r.service.start(true)
    const first = r.service.resume(rec.id)
    await r.service.resume(rec.id)
    await r.service.resume('rs-000000000000')
    release()
    await first
    expect(r.probed).toHaveLength(1)
    expect(r.created).toHaveLength(1)
  })

  it('does nothing for a function that was switched off while the server was answering', async () => {
    const { rec, path } = partial('a.zip')
    writeRecords(rec)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const r = serving(async (record) => {
      await gate
      return same(record)
    }, rec)
    r.service.start(true)
    const pending = r.service.resume(rec.id)
    r.service.stop(true)
    release()
    await pending
    expect(r.created).toEqual([])
    expect(r.notices).toEqual([])
    expect(existsSync(file)).toBe(false)
    expect(existsSync(path)).toBe(false)
  })

  it('does nothing before it is started, once it is stopped, or when this launch cannot record', async () => {
    const { rec } = partial('a.zip')
    writeRecords(rec)
    const never = serving(same, rec)
    await never.service.resume(rec.id)
    const noRecord = serving(same, rec)
    noRecord.service.start(false)
    await noRecord.service.resume(rec.id)
    const stopped = serving(same, rec)
    stopped.service.start(true)
    stopped.service.stop(false)
    await stopped.service.resume(rec.id)
    for (const r of [never, noRecord, stopped]) {
      expect(r.probed).toEqual([])
      expect(r.created).toEqual([])
    }
  })

  it('asks the server with the same rules the judge applies (the request and its verdict agree)', () => {
    const { rec } = partial('a.zip')
    expect(judgeProbe(rec, same(rec))).toEqual({ ok: true })
  })
})

describe('forgetting, flushing and turning off', () => {
  it('forgets the row the user removed: the record and the partial file that is ours', () => {
    const { rec, path } = partial('a.zip')
    writeRecords(rec)
    const r = rig()
    r.service.start(true)
    r.service.forget(rec.id)
    expect(recordsOnDisk()).toEqual([])
    expect(existsSync(path)).toBe(false)
  })

  it('does not remove a file that is no longer the one recorded', () => {
    const { rec, path } = partial('a.zip')
    writeRecords(rec)
    const r = rig()
    r.service.start(true)
    writeFileSync(path, bytes(3 * MIB, 77))
    r.service.forget(rec.id)
    expect(recordsOnDisk()).toEqual([])
    expect(readFileSync(path).equals(bytes(3 * MIB, 77))).toBe(true)
    expect(r.logs.join('\n')).toContain('left in place')
  })

  it('never removes a file that is not where this application writes: the folder moved, or a link took the place', () => {
    const moved = partial('moved.zip')
    const linked = partial('linked.zip')
    writeRecords(moved.rec, linked.rec)
    let current = folder
    const r = rig({ folderOf: () => current })
    expect(r.service.start(true)).toHaveLength(2)
    const elsewhere = join(base, 'Other')
    mkdirSync(elsewhere)
    const target = join(base, 'precious.bin')
    writeFileSync(target, 'precious')
    rmSync(linked.path)
    symlinkSync(target, linked.path)
    r.service.forget(linked.rec.id)
    expect(readFileSync(target, 'utf8')).toBe('precious')
    // A link is not ours to remove either.
    expect(statSync(linked.path, { throwIfNoEntry: false })).not.toBeUndefined()
    current = elsewhere
    r.service.forget(moved.rec.id)
    expect(existsSync(moved.path)).toBe(true)
    expect(recordsOnDisk()).toEqual([])
  })

  it('forgets the records of a profile whose data was erased, and only that profile’s', () => {
    const mine = partial('mine.zip', 3 * MIB, 2 * MIB, { profileId: 'work' })
    const other = partial('other.zip', 3 * MIB, 2 * MIB, { profileId: 'default' })
    writeRecords(mine.rec, other.rec)
    const r = rig()
    r.service.start(true)
    r.service.forgetProfile('work')
    expect(recordsOnDisk().map((x) => x.id)).toEqual([other.rec.id])
    expect(existsSync(mine.path)).toBe(false)
    expect(existsSync(other.path)).toBe(true)
    r.service.stop(false)
    r.service.forgetProfile('default')
    expect(recordsOnDisk()).toHaveLength(1)
  })

  it('forgets nothing about a download in progress, a record it does not know, or when it is off', () => {
    const r = rig()
    r.service.start(true)
    const { path, content } = partial('live.zip')
    const tracker = r.service.track({ profileId: 'default', path, folder, privateScope: false, view: () => ({ url: record().url, received: 3 * MIB, total: 10 * MIB, etag: record().etag, lastModified: record().lastModified, startTime: NOW / 1000 - 600, mimeType: '' }) })!
    tracker.progress()
    r.service.forget(tracker.recordId)
    r.service.forget('rs-000000000000')
    expect(recordsOnDisk()).toHaveLength(1)
    expect(readFileSync(path).equals(content)).toBe(true)
    r.service.stop(false)
    r.service.forget(tracker.recordId)
    expect(recordsOnDisk()).toHaveLength(1)
  })

  it('brings the records of downloads in progress up to date when asked (the application quits)', () => {
    const r = rig()
    r.service.start(true)
    const { path } = partial('live.zip')
    const item: ItemView = { url: record().url, received: 3 * MIB, total: 10 * MIB, etag: record().etag, lastModified: record().lastModified, startTime: NOW / 1000 - 600, mimeType: '' }
    r.service.track({ profileId: 'default', path, folder, privateScope: false, view: () => item })!.progress()
    appendFileSync(path, bytes(MIB, 9))
    item.received += MIB
    clock.now += 1000
    r.service.flush()
    expect(recordsOnDisk()[0]!.offset).toBe(4 * MIB)
  })

  it('keeps the record of a download in progress through a quit: Chromium cancelling it as the application closes is not the user cancelling it', () => {
    const r = rig()
    r.service.start(true)
    const { path } = partial('live.zip')
    const item: ItemView = { url: record().url, received: 3 * MIB, total: 10 * MIB, etag: record().etag, lastModified: record().lastModified, startTime: NOW / 1000 - 600, mimeType: '' }
    const tracker = r.service.track({ profileId: 'default', path, folder, privateScope: false, view: () => item })!
    tracker.progress()
    // The order of a quit: `before-quit` brings the records up to date, the window closes (its gate stops the service), then the engine shuts down.
    r.service.flush()
    r.service.stop(false)
    expect(tracker.finish('cancelled', false)).toBe(false)
    expect(recordsOnDisk()).toHaveLength(1)
    expect(recordsOnDisk()[0]!.offset).toBe(3 * MIB)
    expect(existsSync(path)).toBe(true)
  })

  it('on a close of the window, leaves the file and the partial files for the next launch', () => {
    const { rec, path } = partial('a.zip')
    writeRecords(rec)
    const r = rig()
    r.service.start(true)
    r.service.stop(false)
    expect(existsSync(file)).toBe(true)
    expect(recordsOnDisk()).toEqual([rec])
    expect(existsSync(path)).toBe(true)
    expect(r.service.isStarted).toBe(false)
  })

  it('when the setting goes off, removes the file and the partial files that are ours, and nothing else', () => {
    const mine = partial('mine.zip')
    const replaced = partial('replaced.zip')
    writeRecords(mine.rec, replaced.rec)
    const r = rig()
    expect(r.service.start(true)).toHaveLength(2)
    writeFileSync(replaced.path, bytes(3 * MIB, 55))
    r.service.stop(true)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(mine.path)).toBe(false)
    expect(readFileSync(replaced.path).equals(bytes(3 * MIB, 55))).toBe(true)
    expect(r.service.isStarted).toBe(false)
  })

  it('on a purge, keeps the file of a download still in progress: it is being written', () => {
    const r = rig()
    r.service.start(true)
    const { path, content } = partial('live.zip')
    r.service.track({ profileId: 'default', path, folder, privateScope: false, view: () => ({ url: record().url, received: 3 * MIB, total: 10 * MIB, etag: record().etag, lastModified: record().lastModified, startTime: NOW / 1000 - 600, mimeType: '' }) })!.progress()
    r.service.stop(true)
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(path).equals(content)).toBe(true)
  })

  it('removes the file it only made, when the launch could not record and the setting goes off', () => {
    const r = rig()
    r.service.start(false)
    expect(existsSync(file)).toBe(true)
    r.service.stop(true)
    expect(existsSync(file)).toBe(false)
  })

  it('records nothing once stopped, even for a tracker it handed out', () => {
    const r = rig()
    r.service.start(true)
    const { path } = partial('live.zip')
    const tracker = r.service.track({ profileId: 'default', path, folder, privateScope: false, view: () => ({ url: record().url, received: 3 * MIB, total: 10 * MIB, etag: record().etag, lastModified: record().lastModified, startTime: NOW / 1000 - 600, mimeType: '' }) })!
    r.service.stop(true)
    tracker.progress()
    tracker.interrupted()
    expect(existsSync(file)).toBe(false)
  })
})

describe('the address never leaves the file of records', () => {
  it('is in no log, no notice and no row through a whole life of a download', async () => {
    const r = rig()
    r.service.start(true)
    const { path } = partial('life.zip')
    const item: ItemView = { url: record().url, received: 3 * MIB, total: 10 * MIB, etag: record().etag, lastModified: record().lastModified, startTime: NOW / 1000 - 600, mimeType: 'application/zip' }
    const tracker = r.service.track({ profileId: 'default', path, folder, privateScope: false, view: () => item })!
    tracker.progress()
    tracker.finish('interrupted', true)
    expect(readFileSync(file, 'utf8')).toContain(TOKEN)
    // Next launch: the row, a refused resumption, a probe that fails, a Chromium that refuses, a forgotten row.
    const next = rig({
      probe: async () => {
        throw new Error(`${item.url} unreachable`)
      }
    })
    const rows = next.service.start(true)
    await next.service.resume(rows[0]!.id)
    next.service.forget(rows[0]!.id)
    const everything = JSON.stringify([r.logs, r.notices, r.emitted, rows, next.logs, next.notices, next.emitted])
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain('token=')
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------

describe('a record that outlived its download (the file is whole)', () => {
  /** A record of 2 MiB confirmed, and beside it the file grown to the whole 10 MiB: the download ended and the record stayed. */
  const whole = (name = 'whole.zip'): { path: string; rec: ResumeRecord; content: Buffer } => {
    const made = partial(name, 3 * MIB, 2 * MIB)
    appendFileSync(made.path, bytes(7 * MIB, 5))
    return { path: made.path, rec: made.rec, content: readFileSync(made.path) }
  }
  const untouched = (w: ReturnType<typeof whole>): boolean => existsSync(w.path) && readFileSync(w.path).equals(w.content)
  const view = (): ItemView => ({ url: record().url, received: 3 * MIB, total: 10 * MIB, etag: record().etag, lastModified: record().lastModified, startTime: NOW / 1000 - 600, mimeType: '' })

  it('is seen as complete, and is not cut even when a cut is asked', () => {
    const w = whole()
    expect(inspectPartial(w.rec, folder, realResumeFs, { truncate: true })).toEqual({ place: 'ok', size: 10 * MIB, ours: true, intact: true, complete: true })
    expect(untouched(w)).toBe(true)
  })

  it('goes at launch without a row and without a notice, and the file stays', () => {
    const w = whole()
    writeRecords(w.rec)
    const r = rig()
    expect(r.service.start(true)).toEqual([])
    expect(r.notices).toEqual([])
    expect(recordsOnDisk()).toEqual([])
    expect(untouched(w)).toBe(true)
  })

  it('goes at launch when it is also too old, and the file stays', () => {
    const w = whole()
    writeRecords(w.rec)
    clock.now += RESUME_MAX_AGE_MS + 1
    const r = rig()
    expect(r.service.start(true)).toEqual([])
    expect(r.notices).toEqual([])
    expect(recordsOnDisk()).toEqual([])
    expect(untouched(w)).toBe(true)
  })

  it('keeps the file when the user removes the row', () => {
    const made = partial('row.zip')
    writeRecords(made.rec)
    const r = rig()
    expect(r.service.start(true)).toHaveLength(1)
    appendFileSync(made.path, bytes(7 * MIB, 5))
    r.service.forget(made.rec.id)
    expect(recordsOnDisk()).toEqual([])
    expect(statSync(made.path).size).toBe(10 * MIB)
  })

  it('keeps the file when the record outlives its time while the application runs', () => {
    const aged = partial('aged.zip')
    writeRecords(aged.rec)
    const r = rig()
    expect(r.service.start(true)).toHaveLength(1)
    appendFileSync(aged.path, bytes(7 * MIB, 5))
    clock.now += RESUME_MAX_AGE_MS + 1
    const fresh = partial('fresh.zip')
    r.service.track({ profileId: 'default', path: fresh.path, folder, privateScope: false, view })!.progress()
    expect(recordsOnDisk().map((x) => x.path)).toEqual([fresh.path])
    expect(statSync(aged.path).size).toBe(10 * MIB)
  })

  it('keeps the file when the setting goes off', () => {
    const made = partial('known.zip')
    writeRecords(made.rec)
    const r = rig()
    expect(r.service.start(true)).toHaveLength(1)
    appendFileSync(made.path, bytes(7 * MIB, 5))
    r.service.stop(true)
    expect(existsSync(file)).toBe(false)
    expect(statSync(made.path).size).toBe(10 * MIB)
  })

  it('is not resumed: the server is not asked, the file is not cut, and the row says the download is done', async () => {
    const made = partial('resume.zip')
    writeRecords(made.rec)
    const r = serving(same, made.rec)
    expect(r.service.start(true)).toHaveLength(1)
    appendFileSync(made.path, bytes(7 * MIB, 5))
    await r.service.resume(made.rec.id)
    expect(r.probed).toEqual([])
    expect(r.created).toEqual([])
    expect(statSync(made.path).size).toBe(10 * MIB)
    expect(recordsOnDisk()).toEqual([])
    expect(r.notices.map(frenchSpaces)).toEqual([frenchSpaces('« resume.zip » est déjà téléchargé en entier : il n’y a rien à reprendre.')])
    expect(r.emitted).toMatchObject([{ id: made.rec.id, state: 'completed', receivedBytes: 10 * MIB }])
    expect(r.emitted[0]!.resumable).toBeUndefined()
  })

  it('loses its record when the download completes after the service stopped (the window closed first)', () => {
    const r = rig()
    r.service.start(true)
    const { path } = partial('late.zip')
    const tracker = r.service.track({ profileId: 'default', path, folder, privateScope: false, view })!
    tracker.progress()
    r.service.flush()
    r.service.stop(false)
    expect(recordsOnDisk()).toHaveLength(1)
    expect(tracker.finish('completed', undefined)).toBe(false)
    expect(recordsOnDisk()).toEqual([])
  })

  it('keeps in the list a record whose removal could not be written, so that the list says what the file says', () => {
    let failing = false
    const flaky: ResumeFs = {
      ...realResumeFs,
      writeText: (path, text) => {
        if (failing) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        realResumeFs.writeText(path, text)
      }
    }
    const s = new ResumeStore(file, flaky, () => clock.now, () => undefined)
    s.put(record(), new Set())
    failing = true
    expect(() => s.remove(record().id)).toThrow(/disk full/)
    expect(s.has(record().id)).toBe(true)
    expect(recordsOnDisk()).toHaveLength(1)
    failing = false
    s.remove(record().id)
    expect(s.has(record().id)).toBe(false)
    expect(recordsOnDisk()).toEqual([])
  })
})

describe('the neighbour a write is made in', () => {
  it('is removed when the write fails, and the failure goes up', () => {
    // A folder where the file should be: the neighbour is written, the rename is refused.
    mkdirSync(file)
    expect(() => realResumeFs.writeText(file, '{"version":1,"records":[]}\n')).toThrow()
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('goes with the file when the setting goes off, whatever left it there', () => {
    const logs: string[] = []
    const s = new ResumeStore(file, realResumeFs, () => clock.now, (level, message) => void logs.push(`${level}: ${message}`))
    s.put(record(), new Set())
    writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, records: [record()] }))
    s.destroy()
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(logs).toEqual([])
  })

  it('says which of the two could not be removed', () => {
    const logs: string[] = []
    const stuck: ResumeFs = {
      ...realResumeFs,
      remove: (path) => {
        if (path.endsWith('.tmp')) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        realResumeFs.remove(path)
      }
    }
    const s = new ResumeStore(file, stuck, () => clock.now, (level, message) => void logs.push(`${level}: ${message}`))
    s.put(record(), new Set())
    s.destroy()
    expect(existsSync(file)).toBe(false)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(`${RESUME_FILE}.tmp`)
    expect(logs[0]).toContain('EBUSY')
  })
})
