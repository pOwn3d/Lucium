import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { USER_SCRIPTS_MAX, USER_SCRIPT_MAX_BYTES } from '@shared/userscript'
import { takePersistenceNotices } from './persistence-notices'
import { USER_SCRIPTS_FILE_MAX_BYTES, UserScripts, configureUserScripts, readScriptFile, userScripts } from './userscripts'
import { tempDir } from './temp-dir'

const dir = () => tempDir('lucium-userscripts-')
const header = (name: string, extra = '') => `// ==UserScript==\n// @name ${name}\n// @match https://*.example.com/*\n// @grant none\n${extra}// ==/UserScript==\ndocument.title = ${JSON.stringify(name)}\n`

afterEach(() => {
  vi.restoreAllMocks()
  takePersistenceNotices()
})

describe('adding a script', () => {
  it('keeps it switched off, with the choices of a script nobody has read: no private window', () => {
    const scripts = new UserScripts(join(dir(), 'userscripts.json'))
    const outcome = scripts.add(header('Un'))
    expect(outcome).toMatchObject({ ok: true, replaced: false })
    const [one] = scripts.list()
    expect(one).toMatchObject({ name: 'Un', enabled: false, allowPrivate: false, matches: ['https://*.example.com/*'] })
    // Switched off, it runs nowhere.
    expect(scripts.matching('https://docs.example.com/', false)).toEqual([])
    expect(scripts.matching('https://docs.example.com/', true)).toEqual([])
  })

  it('refuses what is not an acceptable script, with the reason', () => {
    const scripts = new UserScripts(join(dir(), 'userscripts.json'))
    expect(scripts.add('console.log(1)')).toMatchObject({ ok: false, error: expect.stringContaining('En-tête') })
    expect(scripts.add(header('Privé', '// @grant GM_setValue\n'))).toMatchObject({ ok: false, error: expect.stringContaining('@grant') })
    expect(scripts.add(`${header('Gros')}// ${'x'.repeat(USER_SCRIPT_MAX_BYTES)}\n`)).toMatchObject({ ok: false, error: expect.stringContaining('trop gros') })
    expect(scripts.add(42)).toMatchObject({ ok: false })
    expect(scripts.list()).toEqual([])
  })

  it('replaces the same script imported again, keeps its id, and switches it off: the code is another code', () => {
    const scripts = new UserScripts(join(dir(), 'userscripts.json'))
    const first = scripts.add(header('Même'))
    if (!first.ok) throw new Error(first.error)
    expect(scripts.setEnabled(first.id, true)).toBeNull()
    expect(scripts.setAllowPrivate(first.id, true)).toBeNull()
    const second = scripts.add(header('Même', '// @description Version 2\n'))
    expect(second).toMatchObject({ ok: true, replaced: true, id: first.id })
    expect(scripts.list()).toHaveLength(1)
    expect(scripts.list()[0]).toMatchObject({ description: 'Version 2', enabled: false, allowPrivate: false })
    expect(scripts.matching('https://docs.example.com/', false)).toEqual([])
  })

  it('stops at the limit, and still replaces', () => {
    const scripts = new UserScripts(join(dir(), 'userscripts.json'))
    for (let i = 0; i < USER_SCRIPTS_MAX; i++) expect(scripts.add(header(`Script ${i}`)).ok).toBe(true)
    expect(scripts.add(header('Un de trop'))).toMatchObject({ ok: false, error: expect.stringContaining(String(USER_SCRIPTS_MAX)) })
    expect(scripts.add(header('Script 3', '// @description autre\n'))).toMatchObject({ ok: true, replaced: true })
    expect(scripts.list()).toHaveLength(USER_SCRIPTS_MAX)
  })

  it('does not take a script into memory that it could not write: the list is what the file holds', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const scripts = new UserScripts(join(dir(), 'missing-folder', 'userscripts.json'))
    const outcome = scripts.add(header('Perdu'))
    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining('n’ont pas pu être enregistrés') })
    expect(scripts.list()).toEqual([])
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('[userscripts] cannot write'), expect.anything())
  })
})

describe('switching on, and the rest of the choices', () => {
  const setup = () => {
    const path = join(dir(), 'userscripts.json')
    const scripts = new UserScripts(path)
    const added = scripts.add(header('Cible'))
    if (!added.ok) throw new Error(added.error)
    return { path, scripts, id: added.id }
  }

  it('runs a script on the pages it names once it is switched on, and no more once it is off or removed', () => {
    const { scripts, id } = setup()
    expect(scripts.setEnabled(id, true)).toBeNull()
    expect(scripts.matching('https://docs.example.com/page', false).map((s) => s.name)).toEqual(['Cible'])
    expect(scripts.matching('https://other.org/', false)).toEqual([])
    expect(scripts.setEnabled(id, false)).toBeNull()
    expect(scripts.matching('https://docs.example.com/page', false)).toEqual([])
    expect(scripts.setEnabled(id, true)).toBeNull()
    expect(scripts.remove(id)).toBeNull()
    expect(scripts.matching('https://docs.example.com/page', false)).toEqual([])
  })

  it('keeps a script out of a private window until it is allowed there', () => {
    const { scripts, id } = setup()
    scripts.setEnabled(id, true)
    expect(scripts.matching('https://docs.example.com/', true)).toEqual([])
    scripts.setAllowPrivate(id, true)
    expect(scripts.matching('https://docs.example.com/', true)).toHaveLength(1)
  })

  it('answers a sentence for a script that is gone', () => {
    const { scripts } = setup()
    expect(scripts.setEnabled('us-000000000000', true)).toMatch(/n’existe plus/)
    expect(scripts.setAllowPrivate('us-000000000000', true)).toMatch(/n’existe plus/)
    expect(scripts.remove('us-000000000000')).toMatch(/n’existe plus/)
    expect(scripts.sourceOf('us-000000000000')).toBeUndefined()
  })

  it('keeps its choices when the application is started again', () => {
    const { path, scripts, id } = setup()
    scripts.setEnabled(id, true)
    scripts.setAllowPrivate(id, true)
    const again = new UserScripts(path)
    expect(again.list()[0]).toMatchObject({ id, name: 'Cible', enabled: true, allowPrivate: true })
    expect(again.sourceOf(id)).toBe(header('Cible'))
  })

  it('tells the user when it could not save a choice, logs it, and leaves the choice as it was', () => {
    const { path, scripts, id } = setup()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    // A folder sits where the temporary file is written: the disk refuses.
    mkdirSync(`${path}.tmp`)
    expect(scripts.setEnabled(id, true)).toMatch(/n’ont pas pu être enregistrés/)
    expect(scripts.setAllowPrivate(id, true)).toMatch(/n’ont pas pu être enregistrés/)
    expect(scripts.remove(id)).toMatch(/n’ont pas pu être enregistrés/)
    expect(scripts.list()[0]).toMatchObject({ enabled: false, allowPrivate: false })
    expect(scripts.matching('https://docs.example.com/', false)).toEqual([])
    expect(logged).toHaveBeenCalledTimes(3)
  })

  it('records a failure in a page and shows it in the list', () => {
    const { scripts, id } = setup()
    scripts.recordFailure(id, 'x'.repeat(1000))
    expect(scripts.list()[0]!.lastError?.message).toHaveLength(300)
    // A script imported again starts afresh.
    scripts.add(header('Cible', '// @description neuf\n'))
    expect(scripts.list()[0]!.lastError).toBeUndefined()
  })
})

describe('reading the file', () => {
  it('reads nothing until a script is asked for', () => {
    const path = join(dir(), 'userscripts.json')
    writeFileSync(path, 'not json at all')
    const scripts = new UserScripts(path)
    expect(readFileSync(path, 'utf8')).toBe('not json at all')
    expect(readdirSync(join(path, '..'))).toEqual(['userscripts.json'])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    scripts.list()
    // Now it was read, found unreadable, and put aside rather than lost.
    expect(readdirSync(join(path, '..')).some((name) => name.startsWith('userscripts.json.corrupt-'))).toBe(true)
    expect(takePersistenceNotices().some((notice) => notice.kind === 'set-aside')).toBe(true)
  })

  it('does not open what is not a regular file under the name of the file: it is put aside, and the reason says so', () => {
    const path = join(dir(), 'userscripts.json')
    // A folder stands in for a pipe, which would hold a test that opened it for ever.
    mkdirSync(path)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(new UserScripts(path).list()).toEqual([])
    const notice = takePersistenceNotices().find((entry) => entry.kind === 'set-aside')
    expect(notice && 'reason' in notice ? notice.reason : '').toContain('is not a regular file')
  })

  it('does not read a file far larger than any set of scripts: it is put aside like an unreadable one', () => {
    const path = join(dir(), 'userscripts.json')
    // Valid JSON, padded: only its size is wrong.
    writeFileSync(path, `{"version":1,"scripts":[]}${' '.repeat(USER_SCRIPTS_FILE_MAX_BYTES)}`)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(new UserScripts(path).list()).toEqual([])
    expect(readdirSync(join(path, '..')).some((name) => name.startsWith('userscripts.json.corrupt-'))).toBe(true)
    expect(takePersistenceNotices().some((notice) => notice.kind === 'set-aside')).toBe(true)
  })

  it('starts again from nothing after a file it cannot read, and writes a new one beside the copy', () => {
    const path = join(dir(), 'userscripts.json')
    writeFileSync(path, '{"scripts": [')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const scripts = new UserScripts(path)
    expect(scripts.list()).toEqual([])
    expect(scripts.add(header('Neuf')).ok).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).scripts).toHaveLength(1)
  })

  it('leaves out an entry that is no longer a script it accepts, says so, and keeps a copy of the file as it was', () => {
    const path = join(dir(), 'userscripts.json')
    const entries = [
      { id: 'us-aaaaaaaaaaaa', source: header('Bon'), enabled: true, allowPrivate: false, importedAt: 1 },
      { id: 'us-bbbbbbbbbbbb', source: '// ==UserScript==\n// @name Mauvais\n// @match https://a.example/*\n// @grant GM_setValue\n// ==/UserScript==\n', enabled: true, allowPrivate: true, importedAt: 2 }
    ]
    const original = JSON.stringify({ version: 1, scripts: entries })
    writeFileSync(path, original)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const scripts = new UserScripts(path, () => 1234)
    expect(scripts.list().map((s) => s.name)).toEqual(['Bon'])
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('1 script(s)'))
    expect(readFileSync(`${path}.dropped-1234`, 'utf8')).toBe(original)
  })

  it('keeps one copy of the same file however many times it is read, and only the three most recent copies', () => {
    const folder = dir()
    const path = join(folder, 'userscripts.json')
    const bad = (n: number) => JSON.stringify({ scripts: [{ id: 'us-aaaaaaaaaaaa', source: `nope ${n}`, enabled: true }] })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(path, bad(0))
    for (let launch = 1; launch <= 5; launch++) new UserScripts(path, () => launch * 1000).list()
    expect(readdirSync(folder).filter((n) => n.includes('.dropped-'))).toEqual(['userscripts.json.dropped-1000'])
    // The file changes (and drops something else): a new copy, and the oldest ones go beyond three.
    for (let n = 1; n <= 5; n++) {
      writeFileSync(path, bad(n))
      new UserScripts(path, () => 10_000 + n).list()
    }
    expect(readdirSync(folder).filter((name) => name.includes('.dropped-')).sort()).toEqual(['userscripts.json.dropped-10003', 'userscripts.json.dropped-10004', 'userscripts.json.dropped-10005'])
    expect(readFileSync(`${path}.dropped-10005`, 'utf8')).toBe(bad(5))
  })

  it('says so when it cannot even keep that copy', () => {
    const path = join(dir(), 'userscripts.json')
    writeFileSync(path, JSON.stringify({ scripts: [{ id: 'us-aaaaaaaaaaaa', source: 'nope', enabled: true }] }))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    // A folder sits where the copy would go.
    mkdirSync(`${path}.dropped-99`)
    expect(new UserScripts(path, () => 99).list()).toEqual([])
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('could not be copied first'))
  })

  it('does not trust the file about what runs: an entry is enabled only by a true', () => {
    const path = join(dir(), 'userscripts.json')
    writeFileSync(path, JSON.stringify({ version: 1, scripts: [{ id: 'us-aaaaaaaaaaaa', source: header('Bon'), enabled: 'true', allowPrivate: 'true' }] }))
    expect(new UserScripts(path).list()[0]).toMatchObject({ enabled: false, allowPrivate: false })
  })
})

describe('the file a user picks', () => {
  it('is read when it is a script that size, and refused when it is bigger', () => {
    const path = join(dir(), 'a.user.js')
    writeFileSync(path, header('Petit'))
    expect(readScriptFile(path)).toBe(header('Petit'))
    writeFileSync(path, 'x'.repeat(USER_SCRIPT_MAX_BYTES))
    expect(readScriptFile(path)).toHaveLength(USER_SCRIPT_MAX_BYTES)
    writeFileSync(path, 'x'.repeat(USER_SCRIPT_MAX_BYTES + 1))
    expect(readScriptFile(path)).toBeNull()
    writeFileSync(path, 'x'.repeat(USER_SCRIPT_MAX_BYTES * 20))
    expect(readScriptFile(path)).toBeNull()
  })

  it('throws for a file that is not there, for the caller to report', () => {
    expect(() => readScriptFile(join(dir(), 'nope.user.js'))).toThrow()
  })
})

describe('the application\'s scripts', () => {
  it('know their file from the start but touch it only when asked', () => {
    const path = join(dir(), 'userscripts.json')
    configureUserScripts(path)
    expect(existsSync(path)).toBe(false)
    const scripts = userScripts()
    expect(userScripts()).toBe(scripts)
    expect(scripts.add(header('App')).ok).toBe(true)
    expect(existsSync(path)).toBe(true)
  })
})
