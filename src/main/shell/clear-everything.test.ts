import { afterEach, describe, expect, it, vi } from 'vitest'
import { askAndClear, type ClearEverythingDeps } from './clear-everything'
import { createInitialState, reduce } from '@shared/sidebar'

afterEach(() => vi.restoreAllMocks())

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const single = createInitialState(ctx)
const several = reduce(single, { type: 'space/create', name: 'Pro', emoji: '💼', hue: 10, profileName: 'Travail' }, ctx)

function setup(answer: number, over: Partial<ClearEverythingDeps> = {}, state = single) {
  const log: string[] = []
  const asked: Array<{ buttons: string[]; defaultId: number; cancelId: number; message: string }> = []
  const deps: ClearEverythingDeps = {
    state: () => state,
    isPrivate: () => false,
    ask: async (options) => (asked.push(options), answer),
    run: async (kind, scope) => void log.push(`run:${kind}:${scope}`),
    openWindow: () => void log.push('window'),
    notify: (message) => void log.push(`notice:${message}`),
    ...over
  }
  return { deps, log, asked }
}

describe('« Tout effacer » and « Nouvelle identité »', () => {
  it('asks first, with Cancel as the default button, and erases nothing when the answer is no', async () => {
    const { deps, log, asked } = setup(1)
    expect(await askAndClear('everything', deps)).toBe('cancelled')
    expect(log).toEqual([])
    expect(asked[0]!.buttons).toEqual(['Tout effacer', 'Annuler'])
    expect([asked[0]!.defaultId, asked[0]!.cancelId]).toEqual([1, 1])
  })

  it('erases the profile in front on the first button, and tells it', async () => {
    const { deps, log } = setup(0)
    expect(await askAndClear('everything', deps)).toBe('done')
    expect(log).toEqual(['run:everything:profile', 'notice:Données effacées.'])
  })

  it('erases every profile when the confirmation offers it and the user takes it', async () => {
    const { deps, log, asked } = setup(1, {}, several)
    expect(asked).toEqual([])
    expect(await askAndClear('everything', deps)).toBe('done')
    expect(log[0]).toBe('run:everything:all')
    expect(asked[0]!.buttons).toEqual(['Tout effacer', 'Effacer tous les profils', 'Annuler'])
  })

  it('opens a new window after a new identity, and not after a plain erasure', async () => {
    const identity = setup(0)
    await askAndClear('identity', identity.deps)
    expect(identity.log).toEqual(['run:identity:profile', 'window', 'notice:Nouvelle identité prête.'])
    const plain = setup(0)
    await askAndClear('everything', plain.deps)
    expect(plain.log).not.toContain('window')
  })

  it('tells the error and opens no window when the erasure failed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { deps, log } = setup(0, { run: async () => Promise.reject(new Error('Impossible de nettoyer le profil default.')) })
    expect(await askAndClear('identity', deps)).toBe('failed')
    expect(log).toEqual(['notice:Impossible de nettoyer le profil default.'])
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('does nothing in a private window and says why, without asking', async () => {
    const { deps, log, asked } = setup(0, { isPrivate: () => true })
    expect(await askAndClear('everything', deps)).toBe('refused')
    expect(asked).toEqual([])
    expect(log).toHaveLength(1)
    expect(log[0]).toContain('fenêtre privée')
  })
})
