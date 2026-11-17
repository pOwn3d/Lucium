import { afterEach, describe, expect, it, vi } from 'vitest'
import { PURGE_LIST_MAX, PURGE_REQUEST_MAX, confirmedPurge, finishPurge, parsePurgeRequest, purgePrompt, startPurge, unusedProfileIds } from './profile-purge'
import { setLanguage } from './i18n'
import { frenchSpaces } from './french-typography'

afterEach(() => setLanguage('fr'))

describe('unusedProfileIds', () => {
  it('lists the profiles that hold a session or a history and that no space uses, each once', () => {
    const ids = unusedProfileIds({ stored: ['work', 'old', 'both'], withHistory: ['both', 'history-only', 'work'], used: ['work', 'default'] })
    expect(ids).toEqual(['old', 'both', 'history-only'])
  })

  it('leaves out a profile a space uses, a space put aside included (the caller counts it in `used`)', () => {
    expect(unusedProfileIds({ stored: ['aside'], withHistory: [], used: ['aside'] })).toEqual([])
  })

  it('never touches an id that is not a plain profile name', () => {
    expect(unusedProfileIds({ stored: ['../x', '', 'a b', '__proto__', 'ok'], withHistory: ['a/b'], used: [] })).toEqual(['ok'])
  })
})

describe('parsePurgeRequest', () => {
  it('takes a plain list of profile names', () => {
    expect(parsePurgeRequest(['old', 'older'])).toEqual(['old', 'older'])
    expect(parsePurgeRequest([])).toEqual([])
  })

  it('refuses anything else, so that a request that is not what the interface sends erases nothing', () => {
    for (const raw of [undefined, null, 'old', 7, {}, { length: 1, 0: 'old' }, ['old', 7], ['../x'], ['a b'], ['__proto__'], [['old']]]) expect(parsePurgeRequest(raw), JSON.stringify(raw)).toBeNull()
  })

  it('refuses a list longer than the bound', () => {
    expect(parsePurgeRequest(Array.from({ length: PURGE_REQUEST_MAX }, (_, i) => `p${i}`))).toHaveLength(PURGE_REQUEST_MAX)
    expect(parsePurgeRequest(Array.from({ length: PURGE_REQUEST_MAX + 1 }, (_, i) => `p${i}`))).toBeNull()
  })
})

describe('confirmedPurge', () => {
  it('erases only what the user was shown and what is still unused', () => {
    expect(confirmedPurge(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['b', 'c'])
  })

  it('does not erase a profile that became unused after the list was shown, nor one a space started to use', () => {
    expect(confirmedPurge(['a'], ['a', 'late'])).toEqual(['a'])
    expect(confirmedPurge(['a', 'b'], ['a'])).toEqual(['a'])
    expect(confirmedPurge([], ['a'])).toEqual([])
  })

  it('counts a profile once', () => {
    expect(confirmedPurge(['a', 'a'], ['a'])).toEqual(['a'])
  })
})

describe('purgePrompt', () => {
  it('names every profile that will be erased, and says what goes with them', () => {
    const prompt = purgePrompt(['Travail', 'Clients'])
    expect(prompt.title).toBe(frenchSpaces('Effacer les données des profils inutilisés ?'))
    expect(prompt.items).toEqual(['Travail', 'Clients'])
    expect(prompt.message).toContain('2 profils')
    expect(prompt.message).toMatch(/cookies.*historique.*effacés.*irréversible/)
  })

  it('speaks of one profile in the singular', () => {
    expect(purgePrompt(['Travail']).message).toContain('1 profil seront')
  })

  it('sums up the profiles beyond the first few, so that the box stays readable', () => {
    const names = Array.from({ length: PURGE_LIST_MAX + 3 }, (_, i) => `Profil ${i + 1}`)
    const { items } = purgePrompt(names)
    expect(items.slice(0, PURGE_LIST_MAX)).toEqual(names.slice(0, PURGE_LIST_MAX))
    expect(items).toHaveLength(PURGE_LIST_MAX + 1)
    expect(items.at(-1)).toBe('et 3 autres profils')
    expect(purgePrompt([...names.slice(0, PURGE_LIST_MAX), 'Un de plus']).items.at(-1)).toBe('et 1 autre profil')
  })

  it('is in English when the interface is', () => {
    setLanguage('en')
    const prompt = purgePrompt(['Work'])
    expect(prompt.title).toBe('Clear the data of unused profiles?')
    expect(prompt.confirm).toBe('Clear Data')
    expect(prompt.message).toContain('cleared')
    expect(prompt.message).not.toMatch(/[éèêàç]/)
  })
})

describe('the click on "Nettoyer"', () => {
  const ui = () => ({ ask: vi.fn<(ids: string[]) => void>(), say: vi.fn<(text: string) => void>() })

  it('erases nothing: it hands the profiles that would be to the box that asks', async () => {
    const api = { unusedProfiles: vi.fn(async () => ['old', 'older']), purgeProfiles: vi.fn(async () => 2) }
    const screen = ui()
    await startPurge(api, screen)
    expect(screen.ask).toHaveBeenCalledWith(['old', 'older'])
    expect(api.purgeProfiles).not.toHaveBeenCalled()
    expect(screen.say).not.toHaveBeenCalled()
  })

  it('says there is nothing to clean, and asks nothing, when no profile is unused', async () => {
    const screen = ui()
    await startPurge({ unusedProfiles: async () => [] }, screen)
    expect(screen.ask).not.toHaveBeenCalled()
    expect(screen.say).toHaveBeenCalledWith('Aucun profil inutilisé.')
  })

  it('tells why when the list could not be read, instead of asking about nothing', async () => {
    const screen = ui()
    await startPurge({ unusedProfiles: async () => { throw new Error("Error invoking remote method 'lucium:unused-profiles': Error: Disque illisible.") } }, screen)
    expect(screen.ask).not.toHaveBeenCalled()
    expect(screen.say).toHaveBeenCalledWith('Disque illisible.')
  })
})

describe('the confirmation of the box', () => {
  it('erases the profiles that were listed, and says how many were cleaned, in the singular or the plural', async () => {
    const purgeProfiles = vi.fn(async (_ids: string[]) => 2)
    const say = vi.fn<(text: string) => void>()
    await finishPurge({ purgeProfiles }, ['old', 'older'], { say })
    expect(purgeProfiles).toHaveBeenCalledWith(['old', 'older'])
    expect(say).toHaveBeenCalledWith('Données de 2 profils inutilisés effacées.')
    await finishPurge({ purgeProfiles: async () => 1 }, ['old'], { say })
    expect(say).toHaveBeenLastCalledWith('Données de 1 profil inutilisé effacées.')
  })

  it('says so when nothing was left to clean by then', async () => {
    const say = vi.fn<(text: string) => void>()
    await finishPurge({ purgeProfiles: async () => 0 }, ['old'], { say })
    expect(say).toHaveBeenCalledWith('Aucun profil inutilisé.')
  })

  it('says what stayed when a profile could not be erased, never "cleaned"', async () => {
    const say = vi.fn<(text: string) => void>()
    await finishPurge({ purgeProfiles: async () => { throw new Error("Error invoking remote method 'lucium:purge-profiles': Error: Impossible de nettoyer le profil old.") } }, ['old'], { say })
    expect(say).toHaveBeenCalledTimes(1)
    expect(say).toHaveBeenCalledWith('Impossible de nettoyer le profil old.')
  })
})
