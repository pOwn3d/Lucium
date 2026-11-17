import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseUserScriptRequest } from '@shared/userscript'
import { UserScripts } from '../userscripts'
import { handleUserScriptRequest, type UserScriptDeps } from './userscripts-service'
import { tempDir } from '../temp-dir'

const SCRIPT = '// ==UserScript==\n// @name Service\n// @match https://a.example/*\n// @grant none\n// ==/UserScript==\nconsole.log(1)\n'

function rig(over: Partial<UserScriptDeps> = {}) {
  const scripts = new UserScripts(join(tempDir('lucium-us-service-'), 'userscripts.json'))
  const pickFile = vi.fn(async () => ({ fileName: 'a.user.js', text: SCRIPT }) as { fileName: string; text: string } | { error: string } | null)
  const run = (raw: unknown, deps: Partial<UserScriptDeps> = {}) => handleUserScriptRequest(parseUserScriptRequest(raw)!, { scripts, isPrivate: false, pickFile, ...over, ...deps })
  return { scripts, pickFile, run }
}

describe('the user-script requests of Settings', () => {
  it('adds a script switched off, tells so, and lists it without its code', async () => {
    const { run } = rig()
    const added = await run({ kind: 'add', text: SCRIPT })
    expect(added.ok).toBe(true)
    expect(added.message).toMatch(/désactivé/)
    expect(added.scripts).toHaveLength(1)
    expect(added.scripts[0]).toMatchObject({ name: 'Service', enabled: false })
    expect(JSON.stringify(added.scripts)).not.toContain('console.log')
    expect(added.id).toBe(added.scripts[0]!.id)
  })

  it('gives the code of a script on its own request', async () => {
    const { run } = rig()
    const { id } = await run({ kind: 'add', text: SCRIPT })
    expect((await run({ kind: 'source', id })).text).toBe(SCRIPT)
    expect(await run({ kind: 'source', id: 'us-000000000000' })).toMatchObject({ ok: false, message: expect.stringMatching(/n’existe plus/) })
  })

  it('says why a script is refused', async () => {
    const { run } = rig()
    const refused = await run({ kind: 'add', text: SCRIPT.replace('@grant none', '@grant GM_xmlhttpRequest') })
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining('@grant') })
    expect(refused.scripts).toEqual([])
  })

  it('switches a script on, allows it in private windows, and removes it', async () => {
    const { run, scripts } = rig()
    const { id } = await run({ kind: 'add', text: SCRIPT })
    expect((await run({ kind: 'set-enabled', id: id!, enabled: true })).scripts[0]).toMatchObject({ enabled: true })
    expect((await run({ kind: 'set-private', id: id!, allow: true })).scripts[0]).toMatchObject({ allowPrivate: true })
    expect(scripts.matching('https://a.example/x', true)).toHaveLength(1)
    expect((await run({ kind: 'remove', id: id! })).scripts).toEqual([])
    expect(await run({ kind: 'set-enabled', id: id!, enabled: true })).toMatchObject({ ok: false })
  })

  it('reads the list from a private window and changes nothing there: no add, no choice, no removal, no file', async () => {
    const { run, scripts, pickFile } = rig()
    const { id } = await run({ kind: 'add', text: SCRIPT })
    const inPrivate = { isPrivate: true }
    expect((await run({ kind: 'list' }, inPrivate)).scripts).toHaveLength(1)
    expect((await run({ kind: 'source', id: id! }, inPrivate)).text).toBe(SCRIPT)
    for (const raw of [{ kind: 'add', text: SCRIPT.replace('Service', 'Autre') }, { kind: 'set-enabled', id, enabled: true }, { kind: 'set-private', id, allow: true }, { kind: 'remove', id }, { kind: 'pick-file' }]) {
      const reply = await run(raw, inPrivate)
      expect(reply, JSON.stringify(raw)).toMatchObject({ ok: false, message: expect.stringContaining('fenêtre privée') })
    }
    expect(scripts.list()).toHaveLength(1)
    expect(scripts.list()[0]).toMatchObject({ enabled: false, allowPrivate: false })
    expect(pickFile).not.toHaveBeenCalled()
  })

  it('hands the text of the file the user picks back for them to read, without adding anything', async () => {
    const { run, scripts } = rig()
    const picked = await run({ kind: 'pick-file' })
    expect(picked).toMatchObject({ ok: true, text: SCRIPT, fileName: 'a.user.js' })
    expect(scripts.list()).toEqual([])
  })

  it('answers quietly when the dialog is cancelled and with a sentence when the file cannot be read', async () => {
    const { run } = rig()
    const cancelled = await run({ kind: 'pick-file' }, { pickFile: async () => null })
    expect(cancelled.ok).toBe(false)
    expect(cancelled.message).toBeUndefined()
    expect(await run({ kind: 'pick-file' }, { pickFile: async () => ({ error: 'Le fichier n’a pas pu être lu (EACCES).' }) })).toMatchObject({ ok: false, message: expect.stringContaining('EACCES') })
  })
})
