import { describe, expect, it, vi } from 'vitest'
import type { ExtensionInfo } from '@shared/ipc'
import { createInitialState, reduce } from '@shared/sidebar'
import { ExtensionActions, type ExtensionActionsEnv } from './extension-actions'
import { frenchSpaces } from '@shared/french-typography'

const A = 'a'.repeat(32)
const store = (profileId = 'work'): ExtensionInfo => ({ id: A, name: 'Vimium', version: '1.0', profileId, source: 'store', enabled: true })
const folder: ExtensionInfo = { id: 'b'.repeat(32), name: 'Dossier', version: '1', profileId: 'work', source: 'unpacked', enabled: true }

function setup(infos: ExtensionInfo[], answer = true) {
  const toasts: Array<{ message: string; action?: { label: string; run: () => void } }> = []
  let state = createInitialState({ now: 1, newId: () => 'x' })
  state = { ...state, settings: { ...state.settings, profileNames: { work: 'Travail' } } }
  const engine = {
    listAllExtensions: vi.fn(() => infos),
    uninstallExtension: vi.fn(async (_profileId: string, _id: string) => undefined),
    checkExtensionUpdates: vi.fn(async () => ({ checked: 1, updated: ['Vimium'], waiting: [], failed: null })),
    reviewExtensionUpdate: vi.fn(async (_profileId: string, _id: string): Promise<'updated' | 'declined' | 'none'> => 'updated')
  }
  const env: ExtensionActionsEnv = {
    engine,
    state: () => state,
    dispatch: (action) => void (state = reduce(state, action, { now: 1, newId: () => 'x' })),
    toast: (message, action) => void toasts.push({ message, ...(action ? { action } : {}) }),
    confirm: vi.fn(async () => answer),
    openExtensions: vi.fn()
  }
  return { actions: new ExtensionActions(env), env, engine, toasts, state: () => state }
}

describe('ExtensionActions', () => {
  it('switches an extension off in one profile, says so, and offers to undo it', () => {
    const { actions, toasts, state } = setup([store()])
    actions.menu('disable', 'work', A)
    expect(state().settings.profiles['work']?.disabledExtensions).toEqual([A])
    expect(toasts[0]?.message).toBe(frenchSpaces('« Vimium » est désactivée dans le profil « Travail ».'))
    toasts[0]!.action!.run()
    expect(state().settings.profiles['work']).toBeUndefined()
    expect(toasts[1]?.message).toBe(frenchSpaces('« Vimium » est réactivée dans le profil « Travail ».'))
    expect(toasts[1]?.action).toBeUndefined()
  })

  it('opens the Extensions page, on the extension, for "Gérer les extensions…"', () => {
    const { actions, env } = setup([store()])
    actions.menu('manage', 'work', A)
    expect(env.openExtensions).toHaveBeenCalledWith('work', A)
  })

  it('asks before it uninstalls, naming the extension and the profile, and does nothing if the user says no', async () => {
    const { actions, engine, env, toasts } = setup([store()], false)
    expect(await actions.uninstall('work', A)).toBe('cancelled')
    expect(env.confirm).toHaveBeenCalledWith({ message: frenchSpaces('Désinstaller « Vimium » ?'), detail: expect.stringContaining(frenchSpaces('profil « Travail »')), ok: 'Désinstaller' })
    expect(engine.uninstallExtension).not.toHaveBeenCalled()
    expect(toasts).toEqual([])
  })

  it('uninstalls from that profile only once confirmed, and says so', async () => {
    const { actions, engine, toasts } = setup([store()])
    expect(await actions.uninstall('work', A)).toBe('uninstalled')
    expect(engine.uninstallExtension).toHaveBeenCalledWith('work', A)
    expect(toasts.map((t) => t.message)).toEqual([frenchSpaces('« Vimium » est désinstallée.')])
  })

  it('does not uninstall a folder\'s extension or an unknown one, and says where to remove it', async () => {
    const { actions, engine, env, toasts } = setup([folder])
    expect(await actions.uninstall('work', folder.id)).toBe('failed')
    expect(await actions.uninstall('work', A)).toBe('failed')
    expect(await actions.uninstall('home', folder.id)).toBe('failed')
    expect(engine.uninstallExtension).not.toHaveBeenCalled()
    expect(env.confirm).not.toHaveBeenCalled()
    expect(toasts[0]?.message).toContain('Réglages › Extensions et outils')
    expect(toasts[1]?.message).toBe('Cette extension n’est pas installée dans ce profil.')
  })

  it('reports a failed uninstall with the reason, in a notice and in the log', async () => {
    const { actions, engine, toasts } = setup([store()])
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    engine.uninstallExtension.mockRejectedValueOnce(new Error('disque plein'))
    expect(await actions.uninstall('work', A)).toBe('failed')
    expect(toasts.map((t) => t.message)).toEqual([frenchSpaces('La désinstallation de « Vimium » a échoué : disque plein')])
    expect(log).toHaveBeenCalledWith(expect.stringContaining(A), expect.any(Error))
    log.mockRestore()
  })

  it('tells how an update check went, and what failed when it did', async () => {
    const { actions, engine, toasts } = setup([store()])
    await actions.checkUpdates()
    expect(toasts.map((t) => t.message)).toEqual(['Recherche des mises à jour des extensions…', '1 extension mise à jour (Vimium).'])
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    engine.checkExtensionUpdates.mockRejectedValueOnce(new Error('réseau coupé'))
    expect((await actions.checkUpdates()).failed).toBe('réseau coupé')
    expect(toasts.at(-1)?.message).toBe(frenchSpaces('Mise à jour des extensions impossible : réseau coupé'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('update check'), expect.any(Error))
    log.mockRestore()
  })

  it('tells what became of an update that was waiting for the user', async () => {
    const { actions, engine, toasts } = setup([store()])
    expect(await actions.reviewUpdate('work', A)).toBe('updated')
    engine.reviewExtensionUpdate.mockResolvedValueOnce('declined').mockResolvedValueOnce('none')
    await actions.reviewUpdate('work', A)
    await actions.reviewUpdate('work', A)
    expect(toasts.map((t) => t.message)).toEqual([frenchSpaces('« Vimium » est mise à jour.'), frenchSpaces('La mise à jour de « Vimium » n’est pas appliquée.'), frenchSpaces('Aucune mise à jour n’attend « Vimium ».')])
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    engine.reviewExtensionUpdate.mockRejectedValueOnce(new Error('hors ligne'))
    expect(await actions.reviewUpdate('work', A)).toBe('declined')
    expect(toasts.at(-1)?.message).toBe(frenchSpaces('La mise à jour de « Vimium » a échoué : hors ligne'))
    log.mockRestore()
  })
})
