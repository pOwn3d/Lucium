import { describe, expect, it } from 'vitest'
import {
  RESUME_MAX_AGE_MS,
  RESUME_MIN_BYTES,
  cleanRecord,
  displayAddress,
  dropsRecord,
  hasStrongValidators,
  isRecordablePath,
  isResumableAddress,
  isStale,
  judgeProbe,
  probeHeaders,
  refusalMessage,
  removesPartial,
  worthRecording,
  type ItemView,
  type ProbeAnswer,
  type Refusal,
  type ResumeRecord
} from './download-resume'
import { NOW, TOKEN, record } from './download-resume-support'
import { frenchSpaces } from './french-typography'

describe('displayAddress', () => {
  it('keeps the host and the path and drops everything that can be a secret', () => {
    expect(displayAddress(`https://files.example.org:8443/get/archive.zip?token=${TOKEN}&sig=zz#frag`)).toBe('https://files.example.org:8443/get/archive.zip')
    expect(displayAddress(`https://user:${TOKEN}@files.example.org/a.zip`)).toBe('https://files.example.org/a.zip')
    expect(displayAddress(`http://files.example.org/a.zip?X-Amz-Signature=${TOKEN}`)).not.toContain(TOKEN)
  })

  it('shows nothing for what is not a web address', () => {
    for (const value of ['', 'not an address', 'blob:https://x.test/uuid', 'data:text/plain,abc', 'file:///etc/passwd', 'javascript:alert(1)']) expect(displayAddress(value)).toBe('')
  })
})

describe('isResumableAddress', () => {
  it('accepts a web address as Chromium writes it, token and all', () => {
    expect(isResumableAddress(`https://files.example.org/get/a.zip?token=${TOKEN}`)).toBe(true)
    expect(isResumableAddress('http://127.0.0.1:8080/big.bin')).toBe(true)
  })

  it('refuses an identifier and password (they would be written to the disk), other schemes, spaces and control characters', () => {
    for (const value of [
      'https://user:pw@files.example.org/a.zip',
      'https://user@files.example.org/a.zip',
      'ftp://files.example.org/a.zip',
      'blob:https://files.example.org/1',
      'file:///Users/moi/a.zip',
      'https://files.example.org/a b.zip',
      'https://files.example.org/a\n.zip',
      'https://files.example.org/a\u0000.zip',
      'not an address',
      '',
      `https://files.example.org/${'a'.repeat(5000)}`
    ]) {
      expect(isResumableAddress(value), value.slice(0, 40)).toBe(false)
    }
    expect(isResumableAddress(42)).toBe(false)
    expect(isResumableAddress(undefined)).toBe(false)
  })

  it('refuses a form the address would not keep when read again', () => {
    expect(isResumableAddress('https://FILES.example.org')).toBe(false)
  })
})

describe('hasStrongValidators', () => {
  const started = NOW
  it('needs a strong ETag and a Last-Modified older than the download by a minute', () => {
    expect(hasStrongValidators('"abc"', 'Wed, 21 Oct 2026 07:28:00 GMT', started)).toBe(true)
    expect(hasStrongValidators('W/"abc"', 'Wed, 21 Oct 2026 07:28:00 GMT', started)).toBe(false)
    expect(hasStrongValidators('abc', 'Wed, 21 Oct 2026 07:28:00 GMT', started)).toBe(false)
    expect(hasStrongValidators('', 'Wed, 21 Oct 2026 07:28:00 GMT', started)).toBe(false)
    expect(hasStrongValidators('"abc"', '', started)).toBe(false)
    expect(hasStrongValidators('"abc"', 'not a date', started)).toBe(false)
    // Changed in the same minute as the download began: it may change again without a new date.
    expect(hasStrongValidators('"abc"', new Date(started - 30_000).toUTCString(), started)).toBe(false)
    expect(hasStrongValidators('"abc"', new Date(started - 61_000).toUTCString(), started)).toBe(true)
  })

  it('refuses a value that could not go into a header', () => {
    expect(hasStrongValidators('"a\r\nX-Evil: 1"', 'Wed, 21 Oct 2026 07:28:00 GMT', started)).toBe(false)
    expect(hasStrongValidators(`"${'a'.repeat(300)}"`, 'Wed, 21 Oct 2026 07:28:00 GMT', started)).toBe(false)
    expect(hasStrongValidators('"abc"', 'Wed, 21 Oct 2026 07:28:00 GMT\r\nX: 1', started)).toBe(false)
  })
})

describe('isRecordablePath', () => {
  it('accepts a plain absolute path and refuses the rest', () => {
    expect(isRecordablePath('/Users/moi/Downloads/a.zip')).toBe(true)
    for (const value of ['', 'a.zip', 'Downloads/a.zip', '/Users/../etc/passwd', '/Users/moi/./a.zip', '//Users/moi/a.zip', '/Users/moi//a.zip', '/Users/moi/', '/Users/moi/a\n.zip', `/${'a/'.repeat(600)}x`]) {
      expect(isRecordablePath(value), value.slice(0, 30)).toBe(false)
    }
  })
})

describe('cleanRecord', () => {
  it('gives back a valid record unchanged', () => {
    expect(cleanRecord(record(), NOW)).toEqual(record())
    expect(cleanRecord(record({ mimeType: 'application/zip' }), NOW)).toEqual(record({ mimeType: 'application/zip' }))
  })

  it('drops the fields it does not know, whatever they hold', () => {
    const clean = cleanRecord({ ...record(), extra: '/etc/passwd', __proto__: { polluted: true } }, NOW)
    expect(clean).toEqual(record())
    expect(clean).not.toHaveProperty('extra')
  })

  it('refuses a record with any field that is wrong', () => {
    const bad: Array<[string, unknown]> = [
      ['id', 'dl-1'],
      ['id', 'rs-XYZ'],
      ['profileId', '../x'],
      ['profileId', ''],
      ['url', 'https://u:p@x.test/a'],
      ['url', 'file:///etc/passwd'],
      ['path', '../../etc/passwd'],
      ['path', 'relative/a.zip'],
      ['offset', RESUME_MIN_BYTES - 1],
      ['offset', 1.5 * RESUME_MIN_BYTES + 0.5],
      ['offset', -5],
      ['offset', '5242880'],
      ['length', 5 * RESUME_MIN_BYTES],
      ['length', Number.MAX_SAFE_INTEGER + 2],
      ['etag', 'W/"x"'],
      ['etag', '"a\r\nb"'],
      ['lastModified', 'yesterday'],
      ['startTime', Number.NaN],
      ['startTime', -1],
      ['savedAt', NOW + 2 * 60 * 60 * 1000],
      ['savedAt', -1],
      ['head', 'xyz'],
      ['tail', 'A'.repeat(64)],
      ['mimeType', 'text/plain\r\nX: 1'],
      ['mimeType', 'x'.repeat(101)],
      ['mimeType', 12]
    ]
    for (const [key, value] of bad) expect(cleanRecord({ ...record(), [key]: value }, NOW), `${key}=${String(value).slice(0, 20)}`).toBeNull()
  })

  it('refuses what is not an object', () => {
    for (const value of [null, undefined, 'record', 42, [], [record()]]) expect(cleanRecord(value, NOW)).toBeNull()
  })

  it('refuses a record that lacks a field', () => {
    for (const key of Object.keys(record()) as Array<keyof ResumeRecord>) {
      const { [key]: _removed, ...rest } = record({ mimeType: 'application/zip' })
      if (key !== 'mimeType') expect(cleanRecord(rest, NOW), key).toBeNull()
    }
  })
})

describe('isStale', () => {
  it('is true once the lifetime has passed, from the last checkpoint', () => {
    expect(isStale({ savedAt: NOW - RESUME_MAX_AGE_MS }, NOW)).toBe(false)
    expect(isStale({ savedAt: NOW - RESUME_MAX_AGE_MS - 1 }, NOW)).toBe(true)
    expect(isStale({ savedAt: NOW }, NOW)).toBe(false)
  })

  it('is true for a record from the future: a clock set back does not keep an address alive', () => {
    expect(isStale({ savedAt: NOW + 2 * 60 * 60 * 1000 }, NOW)).toBe(true)
    expect(isStale({ savedAt: NOW + 10 * 60 * 1000 }, NOW)).toBe(false)
  })
})

describe('worthRecording', () => {
  const view = (patch: Partial<ItemView> = {}): ItemView => ({
    url: 'https://files.example.org/a.zip?t=1',
    received: 3 * RESUME_MIN_BYTES,
    total: 30 * RESUME_MIN_BYTES,
    etag: '"abc"',
    lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
    startTime: NOW / 1000,
    mimeType: 'application/zip',
    ...patch
  })

  it('records a download with a known size, enough already, and validators that allow a resumption', () => {
    expect(worthRecording(view())).toBe(true)
  })

  it('records nothing for a small partial file, an unknown or reached size, an unusable address or weak validators', () => {
    expect(worthRecording(view({ received: RESUME_MIN_BYTES - 1 }))).toBe(false)
    expect(worthRecording(view({ total: 0 }))).toBe(false)
    expect(worthRecording(view({ total: 3 * RESUME_MIN_BYTES }))).toBe(false)
    expect(worthRecording(view({ url: 'blob:https://files.example.org/1' }))).toBe(false)
    expect(worthRecording(view({ url: 'https://user:pw@files.example.org/a.zip' }))).toBe(false)
    expect(worthRecording(view({ etag: 'W/"abc"' }))).toBe(false)
    expect(worthRecording(view({ etag: '' }))).toBe(false)
    expect(worthRecording(view({ lastModified: '' }))).toBe(false)
    expect(worthRecording(view({ received: Number.NaN }))).toBe(false)
  })
})

describe('judgeProbe', () => {
  const r = record()
  const good = (): ProbeAnswer => ({
    status: 206,
    headers: { 'content-range': `bytes ${r.offset}-${r.offset}/${r.length}`, etag: r.etag, 'last-modified': r.lastModified }
  })
  const answer = (status: number, headers: ProbeAnswer['headers'] = good().headers): ProbeAnswer => ({ status, headers })
  const refused = (a: ProbeAnswer): Refusal | null => {
    const verdict = judgeProbe(r, a)
    return verdict.ok ? null : verdict.refusal
  }

  it('asks for the byte at the offset, on the condition that the ETag has not changed, and without compression', () => {
    expect(probeHeaders(r)).toEqual({ Range: `bytes=${r.offset}-${r.offset}`, 'If-Range': r.etag, 'Accept-Encoding': 'identity' })
  })

  it('accepts a partial answer for that byte of that file, with the same validators', () => {
    expect(judgeProbe(r, good())).toEqual({ ok: true })
    expect(judgeProbe(r, answer(206, { ...good().headers, 'content-encoding': 'identity' }))).toEqual({ ok: true })
  })

  it('refuses the whole file (the server ignores ranges, or the file changed)', () => {
    expect(refused(answer(200))).toBe('not-partial')
  })

  it('refuses another byte, another length, or no range', () => {
    expect(refused(answer(206, { ...good().headers, 'content-range': `bytes 0-0/${r.length}` }))).toBe('range')
    expect(refused(answer(206, { ...good().headers, 'content-range': `bytes ${r.offset}-${r.offset}/${r.length + 1}` }))).toBe('range')
    expect(refused(answer(206, { ...good().headers, 'content-range': `bytes ${r.offset}-${r.offset + 10}/${r.length}` }))).toBe('range')
    expect(refused(answer(206, { ...good().headers, 'content-range': null }))).toBe('range')
    expect(refused(answer(206, { ...good().headers, 'content-range': 'bytes */100' }))).toBe('range')
  })

  it('refuses another ETag or another Last-Modified, or none', () => {
    expect(refused(answer(206, { ...good().headers, etag: '"v2"' }))).toBe('etag')
    expect(refused(answer(206, { ...good().headers, etag: null }))).toBe('etag')
    expect(refused(answer(206, { ...good().headers, 'last-modified': 'Thu, 22 Oct 2026 07:28:00 GMT' }))).toBe('last-modified')
    expect(refused(answer(206, { ...good().headers, 'last-modified': undefined }))).toBe('last-modified')
  })

  it('refuses a compressed answer: its offsets are not the file’s', () => {
    expect(refused(answer(206, { ...good().headers, 'content-encoding': 'gzip' }))).toBe('encoding')
  })

  it('tells a redirection, a missing file, a file that shrank, a refusal and a busy server apart', () => {
    expect(refused(answer(302))).toBe('redirect')
    expect(refused(answer(301))).toBe('redirect')
    expect(refused(answer(404))).toBe('gone')
    expect(refused(answer(410))).toBe('gone')
    expect(refused(answer(416))).toBe('unsatisfiable')
    expect(refused(answer(401))).toBe('denied')
    expect(refused(answer(403))).toBe('denied')
    expect(refused(answer(429))).toBe('busy')
    expect(refused(answer(503))).toBe('busy')
    expect(refused(answer(408))).toBe('busy')
    expect(refused(answer(204))).toBe('status')
    expect(refused(answer(0))).toBe('status')
  })
})

describe('what a refusal does to the record and to the partial file', () => {
  const all: Refusal[] = ['not-partial', 'range', 'etag', 'last-modified', 'encoding', 'redirect', 'gone', 'unsatisfiable', 'denied', 'busy', 'unreachable', 'status', 'failed', 'stale', 'profile', 'place', 'unsafe', 'missing', 'short', 'changed']

  it('keeps the record when the server may answer better later', () => {
    for (const refusal of ['denied', 'busy', 'unreachable', 'failed'] as const) {
      expect(dropsRecord(refusal), refusal).toBe(false)
      expect(removesPartial(refusal), refusal).toBe(false)
    }
  })

  it('drops the record, and the partial file that is ours, when the file can never be completed', () => {
    for (const refusal of ['not-partial', 'range', 'etag', 'last-modified', 'encoding', 'redirect', 'gone', 'unsatisfiable', 'status', 'stale', 'short'] as const) {
      expect(dropsRecord(refusal), refusal).toBe(true)
      expect(removesPartial(refusal), refusal).toBe(true)
    }
  })

  it('drops the record but never removes a file it cannot vouch for', () => {
    for (const refusal of ['profile', 'place', 'unsafe', 'missing', 'changed'] as const) {
      expect(dropsRecord(refusal), refusal).toBe(true)
      expect(removesPartial(refusal), refusal).toBe(false)
    }
  })

  it('has a French sentence for each, that names the file and never repeats an address', () => {
    for (const refusal of all) {
      const text = refusalMessage('archive.zip', refusal)
      expect(text, refusal).toContain(frenchSpaces('« archive.zip »'))
      // The catalogue holds the quotation marks: the name arrives bare, or it is quoted twice.
      expect(text.split('«'), refusal).toHaveLength(2)
      expect(text, refusal).toMatch(/[a-zé]/)
      expect(text, refusal).not.toMatch(/https?:/)
    }
    expect(refusalMessage('x'.repeat(500), 'busy').length).toBeLessThan(200)
  })
})
