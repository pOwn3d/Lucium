import { describe, expect, it } from 'vitest'
import { CSV_LIMITS, describeReport, exportText, mergeLogins, parseCsv, parseExportText, parseLoginCsv } from './password-csv'
import { PASSWORD_LIMITS, type PasswordEntry } from './passwords'
import { setLanguage } from './i18n'

const CHROME = 'name,url,username,password,note\nExample,https://example.com/login,ana,s3cret!,hello\n'
const BITWARDEN = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,0,login,Ex,,,0,https://example.com/a,ana,pw1,\n,0,note,A note,secret note,,0,,,,\n,0,card,A card,,,0,,,,\n'
const ONEPASSWORD = 'Title,Website,Username,Password,Notes,Type,Folder\nEx,https://example.com,ana,pw1,,Login,\nBank,https://bank.example,bob,pw2,,Login,\nCard,,,,,Credit Card,\n'

describe('the CSV reader', () => {
  it('reads quoted fields: commas, doubled quotes and line breaks inside', () => {
    const csv = parseCsv('a,b,c\r\n"x,1","he said ""hi""","line1\nline2"\r\n')
    expect(csv).toEqual({ ok: true, rows: [['a', 'b', 'c'], ['x,1', 'he said "hi"', 'line1\nline2']] })
  })

  it('skips blank lines, accepts every kind of line end and a byte-order mark, and reads a last line with no end', () => {
    expect(parseCsv('﻿a,b\n\n\r\nc,d\re,f')).toEqual({ ok: true, rows: [['a', 'b'], ['c', 'd'], ['e', 'f']] })
  })

  it('refuses a file with a null byte, an unclosed quote, too many rows or columns, a giant cell, or nothing', () => {
    expect(parseCsv('a,b\u0000\n')).toEqual({ ok: false, error: 'binary' })
    expect(parseCsv('a,"b\nc,d\n')).toEqual({ ok: false, error: 'quote' })
    expect(parseCsv('a\n'.repeat(CSV_LIMITS.rows + 5))).toEqual({ ok: false, error: 'too-many-rows' })
    expect(parseCsv(`${','.repeat(CSV_LIMITS.columns + 1)}\n`)).toEqual({ ok: false, error: 'too-many-columns' })
    expect(parseCsv(`a,${'x'.repeat(CSV_LIMITS.field + 1)}\n`)).toEqual({ ok: false, error: 'field-too-long' })
    expect(parseCsv(`a,"${'x'.repeat(CSV_LIMITS.field + 1)}"\n`)).toEqual({ ok: false, error: 'field-too-long' })
    expect(parseCsv('')).toEqual({ ok: false, error: 'empty' })
    expect(parseCsv('\n\n')).toEqual({ ok: false, error: 'empty' })
  })

  it('stops at the row limit instead of reading everything first', () => {
    const started = Date.now()
    const result = parseCsv('a,b,c,d\n'.repeat(5_000_000).slice(0, 12_000_000))
    expect(result).toEqual({ ok: false, error: 'too-many-rows' })
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('the formats', () => {
  it('reads the export of Chrome', () => {
    const result = parseLoginCsv(CHROME)
    expect(result).toEqual({ ok: true, parsed: { format: 'chrome', logins: [{ origin: 'https://example.com', username: 'ana', password: 's3cret!' }], counts: { read: 1, unsupported: 0, empty: 0, invalid: 0 } } })
  })

  it('reads the export of Bitwarden and leaves notes and cards out', () => {
    const result = parseLoginCsv(BITWARDEN)
    expect(result.ok && result.parsed.format).toBe('bitwarden')
    expect(result.ok && result.parsed.logins).toEqual([{ origin: 'https://example.com', username: 'ana', password: 'pw1' }])
    expect(result.ok && result.parsed.counts.read).toBe(1)
  })

  it('reads the export of 1Password and leaves the items with no site out', () => {
    const result = parseLoginCsv(ONEPASSWORD)
    expect(result.ok && result.parsed.format).toBe('1password')
    expect(result.ok && result.parsed.logins.map((l) => l.origin)).toEqual(['https://example.com', 'https://bank.example'])
  })

  it('finds the columns by name, whatever their order and case', () => {
    const result = parseLoginCsv('Password,USERNAME,Url\npw,ana,example.com\n')
    expect(result.ok && result.parsed.logins).toEqual([{ origin: 'https://example.com', username: 'ana', password: 'pw' }])
  })

  it('reads the addresses of a Bitwarden item that are joined by commas as several addresses, never as one site that does not exist', () => {
    const csv = 'type,login_uri,login_username,login_password\nlogin,"https://a.example,https://b.example/login",ana,pw\nlogin,"androidapp://com.example, https://c.example/x,y",bob,pw2\n'
    const parsed = parseLoginCsv(csv)
    expect(parsed.ok && parsed.parsed.logins).toEqual([
      { origin: 'https://a.example', username: 'ana', password: 'pw' },
      { origin: 'https://c.example', username: 'bob', password: 'pw2' }
    ])
  })

  it('takes the first address of a Bitwarden item that a password may be kept for', () => {
    const csv = 'type,login_uri,login_username,login_password\nlogin,"androidapp://com.example\nhttp://remote.test/\nhttps://example.com/x",ana,pw\n'
    const result = parseLoginCsv(csv)
    expect(result.ok && result.parsed.logins).toEqual([{ origin: 'https://example.com', username: 'ana', password: 'pw' }])
  })

  it('refuses a file with no address and password columns', () => {
    expect(parseLoginCsv('a,b\n1,2\n')).toEqual({ ok: false, error: 'unknown-format' })
    expect(parseLoginCsv('url,username\nhttps://example.com,ana\n')).toEqual({ ok: false, error: 'unknown-format' })
  })

  it('refuses a file larger than the limit before reading it', () => {
    expect(parseLoginCsv('x'.repeat(CSV_LIMITS.bytes + 1))).toEqual({ ok: false, error: 'field-too-long' })
  })
})

describe('a hostile file', () => {
  const rows = (...lines: string[]) => `url,username,password\n${lines.join('\n')}\n`

  it('counts what it leaves out, by reason, and adds only what a login typed by hand would be', () => {
    const csv = rows(
      'https://good.example,ana,pw',
      'http://remote.example,ana,pw',
      'javascript:alert(1),ana,pw',
      'file:///etc/passwd,ana,pw',
      'chrome://settings,ana,pw',
      ',ana,pw',
      'https://empty.example,ana,',
      'https://ctrl.example,"a\u0007b",pw',
      'https://ctrl2.example,ana,"p\u001bw"',
      `https://long.example,${'u'.repeat(PASSWORD_LIMITS.username + 1)},pw`,
      `https://long2.example,ana,${'p'.repeat(PASSWORD_LIMITS.password + 1)}`,
      'https://creds:inurl@cred.example,ana,pw'
    )
    const result = parseLoginCsv(csv)
    expect(result.ok && result.parsed.logins).toEqual([{ origin: 'https://good.example', username: 'ana', password: 'pw' }])
    expect(result.ok && result.parsed.counts).toEqual({ read: 12, unsupported: 4, empty: 2, invalid: 5 })
  })

  it('never lets a cell become anything but data: a formula or markup is kept as text, an address is only ever parsed', () => {
    const result = parseLoginCsv(rows('https://example.com,=HYPERLINK("http://evil.test"),<script>alert(1)</script>'))
    expect(result.ok && result.parsed.logins).toEqual([{ origin: 'https://example.com', username: '=HYPERLINK("http://evil.test")', password: '<script>alert(1)</script>' }])
  })

  it('does not read a prototype key from a column name', () => {
    const result = parseLoginCsv('url,password,__proto__,constructor\nhttps://example.com,pw,x,y\n')
    expect(result.ok && result.parsed.logins).toEqual([{ origin: 'https://example.com', username: '', password: 'pw' }])
    expect(({} as Record<string, unknown>)['x']).toBeUndefined()
  })
})

describe('what an import adds', () => {
  const parsed = (logins: Array<{ origin: string; username: string; password: string }>) => ({ format: 'chrome' as const, logins, counts: { read: logins.length, unsupported: 0, empty: 0, invalid: 0 } })
  const login = (origin: string, username: string, password = 'pw') => ({ origin, username, password })

  it('never replaces an entry: the same origin and username is left as it is, once or twice in the file', () => {
    const existing = [{ origin: 'https://example.com', username: 'ana' }]
    const { toAdd, report } = mergeLogins(existing, parsed([login('https://example.com', 'ana', 'NEW'), login('https://example.com', 'bob'), login('https://example.com', 'bob', 'again'), login('https://example.org', 'ana')]))
    expect(toAdd).toEqual([login('https://example.com', 'bob'), login('https://example.org', 'ana')])
    expect(report).toMatchObject({ added: 2, duplicates: 2, overCapacity: 0 })
  })

  it('stops at the capacity of the vault and counts the rest', () => {
    const existing: PasswordEntry[] = Array.from({ length: 3 }, (_, i) => ({ id: String(i), origin: `https://e${i}.test`, username: 'u', password: 'p', createdAt: 0, updatedAt: 0 }))
    const { toAdd, report } = mergeLogins(existing, parsed([login('https://a.test', 'u'), login('https://b.test', 'u'), login('https://c.test', 'u')]), 5)
    expect(toAdd).toHaveLength(2)
    expect(report).toMatchObject({ added: 2, overCapacity: 1 })
  })

  it('says it in counts, never in values', () => {
    const text = describeReport({ format: 'chrome', read: 9, added: 3, duplicates: 2, unsupported: 1, empty: 1, invalid: 1, overCapacity: 1 })
    expect(text).toMatch(/3 ajoutés/)
    expect(text).toMatch(/2 déjà présents/)
    expect(text).toMatch(/coffre plein/)
  })

  it('says it in English, one form for one and another for more', () => {
    setLanguage('en')
    try {
      expect(describeReport({ format: 'chrome', read: 9, added: 1, duplicates: 2, unsupported: 1, empty: 0, invalid: 2, overCapacity: 1 })).toBe('1 added, 2 already there (left as they are), 1 skipped (address not supported), 2 invalid, 1 not added (vault full).')
      expect(describeReport({ format: 'chrome', read: 1, added: 0, duplicates: 1, unsupported: 0, empty: 0, invalid: 0, overCapacity: 0 })).toBe('0 added, 1 already there (left as is).')
    } finally {
      setLanguage('fr')
    }
  })
})

describe("Lucium's own export", () => {
  const entries: PasswordEntry[] = [{ id: 'a'.repeat(32), origin: 'https://example.com', username: 'ana', password: 'pw1', createdAt: 1, updatedAt: 2 }]

  it('round-trips, and carries nothing but origin, username and password', () => {
    const text = exportText(entries)
    expect(JSON.parse(text).entries[0]).toEqual({ origin: 'https://example.com', username: 'ana', password: 'pw1' })
    const back = parseExportText(text)
    expect(back.ok && back.parsed.logins).toEqual([{ origin: 'https://example.com', username: 'ana', password: 'pw1' }])
  })

  it('carries the key of the one-time codes of an entry that has one, and only that key', () => {
    const key = { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', algorithm: 'SHA256', digits: 8, period: 60 } as const
    const text = exportText([{ ...entries[0]!, totp: key }, { ...entries[0]!, username: 'bob' }])
    expect(JSON.parse(text).entries).toEqual([{ origin: 'https://example.com', username: 'ana', password: 'pw1', totp: key }, { origin: 'https://example.com', username: 'bob', password: 'pw1' }])
    const back = parseExportText(text)
    expect(back.ok && back.parsed.logins.map((login) => login.totp)).toEqual([key, undefined])
  })

  it('refuses the entry whose key is not what this version writes, rather than adding the login without its second factor', () => {
    const entry = (totp: unknown) => ({ origin: 'https://ok.test', username: 'a', password: 'p', totp })
    const good = { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', algorithm: 'SHA1', digits: 6, period: 30 }
    const bad = [{ ...good, secret: 'nope!' }, { ...good, algorithm: 'MD5' }, { ...good, digits: 5 }, { ...good, extra: 1 }, 'text', null, 5]
    const result = parseExportText(JSON.stringify({ kind: 'lucium-passwords', version: 1, entries: [entry(good), ...bad.map(entry)] }))
    expect(result.ok && result.parsed.logins).toEqual([{ origin: 'https://ok.test', username: 'a', password: 'p', totp: good }])
    expect(result.ok && result.parsed.counts).toEqual({ read: 8, unsupported: 0, empty: 0, invalid: 7 })
  })

  it('checks every entry like a login typed by hand, and refuses anything else', () => {
    const hostile = JSON.stringify({ kind: 'lucium-passwords', version: 1, entries: [{ origin: 'http://remote.test', username: 'a', password: 'p' }, { origin: 'https://ok.test', username: 'a\n', password: 'p' }, 'string', null, { origin: 'https://ok.test', username: 'a', password: '' }, { origin: 'https://fine.test', username: 'a', password: 'p', extra: 1 }] })
    const result = parseExportText(hostile)
    expect(result.ok && result.parsed.logins).toEqual([{ origin: 'https://fine.test', username: 'a', password: 'p' }])
    expect(result.ok && result.parsed.counts).toEqual({ read: 6, unsupported: 1, empty: 1, invalid: 3 })
    expect(parseExportText('not json')).toEqual({ ok: false, error: 'unknown-format' })
    expect(parseExportText('{"kind":"other","version":1,"entries":[]}')).toEqual({ ok: false, error: 'unknown-format' })
    expect(parseExportText('{"kind":"lucium-passwords","version":2,"entries":[]}')).toEqual({ ok: false, error: 'unknown-format' })
    expect(parseExportText(JSON.stringify({ kind: 'lucium-passwords', version: 1, entries: new Array(PASSWORD_LIMITS.entries + 1).fill({}) }))).toEqual({ ok: false, error: 'too-many-rows' })
  })
})
