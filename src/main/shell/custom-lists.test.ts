import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CUSTOM_FILE_MAX_BYTES, CUSTOM_LISTS_MAX, CUSTOM_PASTE_MAX_CHARS, reviewCustomList, type CustomFilterList } from '@shared/custom-filter-lists'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { addCustomListFromFile, addCustomListFromText, removeCustomListById, type CustomListsEnvironment } from './custom-lists'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-custom-lists-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** A stand-in for the blocker and the store: the real reducer decides what the settings keep, the "disk" is a map. */
function setup(patch: { private?: boolean; failInstall?: boolean; refuseAdd?: boolean; disabled?: boolean } = {}) {
  let state = createInitialState({ now: 1, newId: () => 'space' })
  const disk = new Map<string, string>()
  const removed: string[] = []
  let counter = 0
  const env: CustomListsEnvironment = {
    service: {
      reviewCustomText: async (text, maxChars) => reviewCustomList(text, () => true, maxChars),
      installCustomList: async (list, review) => {
        if (patch.failInstall) throw new Error('disque plein')
        disk.set(list.id, review.text)
      },
      removeCustomList: async (id) => {
        removed.push(id)
        disk.delete(id)
      }
    },
    lists: () => state.settings.customFilterLists,
    enabled: () => patch.disabled !== true,
    dispatch: (action: Action) => {
      if (patch.refuseAdd && action.type === 'filterlist/add') return
      state = reduce(state, action, { now: 1, newId: () => 'x' })
    },
    now: () => 42,
    newId: () => `custom-${String(++counter).padStart(8, '0')}`,
    private: patch.private === true
  }
  return { env, disk, removed, lists: () => state.settings.customFilterLists }
}

describe('rules pasted into the settings', () => {
  it('keeps the safe rules on disk, records the list in the settings and tells what was left out', async () => {
    const { env, disk, lists } = setup()
    const result = await addCustomListFromText(env, '  Ma liste ', '||perso.example^\nexemple.org##+js(abort)\nn\'importe quoi ici\n')
    expect(result).toMatchObject({ ok: true, rules: 1, ignored: 1, invalid: 1, list: { id: 'custom-00000001', title: 'Ma liste', source: 'paste', sourceName: 'Règles collées', enabled: true, addedAt: 42 } })
    expect(disk.get('custom-00000001')).toBe('||perso.example^\n')
    expect(lists().map((l) => l.id)).toEqual(['custom-00000001'])
  })

  it('names the list after its own title when the user gave none', async () => {
    const { env, lists } = setup()
    await addCustomListFromText(env, '', '! Title: Liste de Camille\n||perso.example^\n')
    expect(lists()[0]!.title).toBe('Liste de Camille')
  })

  it('refuses a text that is not a string, a text with no rule, and a text that is too long, with a sentence and nothing on disk', async () => {
    const { env, disk, lists } = setup()
    expect(await addCustomListFromText(env, 'x', 42)).toEqual({ ok: false, reason: 'Texte invalide.' })
    expect(await addCustomListFromText(env, 'x', '! rien\n')).toEqual({ ok: false, reason: 'Aucune règle utilisable.' })
    expect(await addCustomListFromText(env, 'x', 'a'.repeat(CUSTOM_PASTE_MAX_CHARS + 1))).toEqual({ ok: false, reason: 'La liste est trop volumineuse.' })
    expect(disk.size).toBe(0)
    expect(lists()).toEqual([])
  })

  it('adds nothing in a private window: the rules would stay on disk after it closes', async () => {
    const { env, disk, lists } = setup({ private: true })
    const result = await addCustomListFromText(env, 'x', '||perso.example^\n')
    expect(result).toMatchObject({ ok: false })
    expect(disk.size + lists().length).toBe(0)
  })

  it('adds nothing while the function is switched off, and says where to switch it on', async () => {
    const { env, disk, lists } = setup({ disabled: true })
    const result = await addCustomListFromText(env, 'x', '||perso.example^\n')
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('désactivées') })
    expect(disk.size + lists().length).toBe(0)
  })

  it(`stops at ${CUSTOM_LISTS_MAX} lists`, async () => {
    const { env, lists } = setup()
    for (let i = 0; i < CUSTOM_LISTS_MAX; i++) expect((await addCustomListFromText(env, `l${i}`, `||s${i}.example^\n`)).ok).toBe(true)
    const result = await addCustomListFromText(env, 'trop', '||trop.example^\n')
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining(String(CUSTOM_LISTS_MAX)) })
    expect(lists()).toHaveLength(CUSTOM_LISTS_MAX)
  })

  it('tells a disk failure, logs it, and records nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { env, lists } = setup({ failInstall: true })
    expect(await addCustomListFromText(env, 'x', '||perso.example^\n')).toEqual({ ok: false, reason: 'Les règles n’ont pas pu être enregistrées sur le disque.' })
    expect(lists()).toEqual([])
    expect(errors).toHaveBeenCalledWith('[blocking] cannot keep a custom list on disk:', expect.any(Error))
  })

  it('takes the rules off the disk again when the settings refuse the list', async () => {
    const { env, disk, removed } = setup({ refuseAdd: true })
    expect(await addCustomListFromText(env, 'x', '||perso.example^\n')).toEqual({ ok: false, reason: 'La liste a été refusée.' })
    expect(removed).toEqual(['custom-00000001'])
    expect(disk.size).toBe(0)
  })

  it('does not reuse the id of a list already there', async () => {
    const { env, lists } = setup()
    await addCustomListFromText(env, 'a', '||a.example^\n')
    let calls = 0
    env.newId = () => (++calls === 1 ? 'custom-00000001' : 'custom-0000000f')
    await addCustomListFromText(env, 'b', '||b.example^\n')
    expect(lists().map((l) => l.id)).toEqual(['custom-00000001', 'custom-0000000f'])
  })

  it('refuses an id that is not one of a custom list\'s', async () => {
    const { env, disk } = setup()
    env.newId = () => '../../index'
    expect(await addCustomListFromText(env, 'a', '||a.example^\n')).toEqual({ ok: false, reason: 'Impossible de nommer la liste.' })
    expect(disk.size).toBe(0)
  })
})

describe('a file the user picked', () => {
  it('reads it, names the list after the file and records the file name as the source', async () => {
    const { env, disk, lists } = setup()
    const path = join(dir, 'mes-regles.txt')
    writeFileSync(path, '[Adblock Plus 2.0]\n||perso.example^\n')
    expect(await addCustomListFromFile(env, path)).toMatchObject({ ok: true, rules: 1, list: { title: 'mes-regles', source: 'file', sourceName: 'mes-regles.txt' } })
    expect(disk.size).toBe(1)
    expect(lists()[0]).toMatchObject({ sourceName: 'mes-regles.txt' })
  })

  it('refuses a folder and a file that does not exist, and says so in the log', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { env, disk } = setup()
    mkdirSync(join(dir, 'dossier'))
    expect(await addCustomListFromFile(env, join(dir, 'dossier'))).toEqual({ ok: false, reason: 'Ce n’est pas un fichier.' })
    expect(await addCustomListFromFile(env, join(dir, 'absent.txt'))).toEqual({ ok: false, reason: 'Le fichier n’a pas pu être lu.' })
    expect(errors).toHaveBeenCalledWith('[blocking] cannot read the filter list file:', expect.stringContaining('ENOENT'))
    expect(disk.size).toBe(0)
  })

  it('refuses a file larger than any list, before reading it', async () => {
    const { env, disk } = setup()
    const path = join(dir, 'enorme.txt')
    writeFileSync(path, Buffer.alloc(CUSTOM_FILE_MAX_BYTES + 1, 0x61))
    expect(await addCustomListFromFile(env, path)).toMatchObject({ ok: false, reason: expect.stringContaining('dépasse') })
    expect(disk.size).toBe(0)
  })

  it('refuses a binary file and a web page saved as a list', async () => {
    const { env } = setup()
    const binary = join(dir, 'image.txt')
    writeFileSync(binary, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]))
    expect(await addCustomListFromFile(env, binary)).toEqual({ ok: false, reason: 'Le contenu est binaire.' })
    const page = join(dir, 'page.txt')
    writeFileSync(page, '<html><body>404</body></html>')
    expect(await addCustomListFromFile(env, page)).toEqual({ ok: false, reason: 'Ce texte est une page web, pas une liste de règles.' })
  })
})

describe('taking a list out', () => {
  const list: CustomFilterList = { id: 'custom-00000001', title: 'x', source: 'paste', sourceName: 'Règles collées', enabled: true, addedAt: 1 }

  it('forgets it in the settings, then deletes its rules', async () => {
    const { env, disk, removed, lists } = setup()
    await addCustomListFromText(env, 'x', '||a.example^\n')
    await removeCustomListById(env, list.id)
    expect(lists()).toEqual([])
    expect(removed).toEqual([list.id])
    expect(disk.size).toBe(0)
  })

  it('changes nothing for an id that is not a custom list\'s or not in the settings, and nothing in a private window', async () => {
    const { env, removed, lists } = setup()
    await addCustomListFromText(env, 'x', '||a.example^\n')
    for (const id of ['../index', 'easylist', 42, null, 'custom-ffffffff']) await removeCustomListById(env, id)
    expect(removed).toEqual([])
    expect(lists()).toHaveLength(1)
    await removeCustomListById({ ...env, private: true }, list.id)
    expect(removed).toEqual([])
  })
})
