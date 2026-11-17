// @vitest-environment happy-dom
// What the Tweak editor sends to the store while it is open (BoostEditor.tsx), mounted in a document: its timer, and what it sends as it goes.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { NEUTRAL_TINT, type Boost } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { frenchSpaces } from '@shared/french-typography'
import { button, click, mount, settle, type, type Mounted } from './dom.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, dispatch: null as unknown, boostPreview: null as unknown }))
vi.mock('./api', () => ({ api: () => ({ dispatch: holder.dispatch, boostPreview: holder.boostPreview, closeOverlay: () => undefined }), useSnapshot: () => holder.snapshot }))

import { BoostEditor } from './BoostEditor'

const dispatch = vi.fn()
const boostPreview = vi.fn()
const boost = (over: Partial<Boost> = {}): Boost => ({ id: 'a', name: 'Lecture', host: 'exemple.fr', enabled: true, css: '', js: '', zoom: 1, zap: ['#ad'], tint: NEUTRAL_TINT, ...over })
let mounted: Mounted | null = null

function open(stored: Boost): HTMLInputElement {
  const state = createInitialState({ now: 1, newId: () => 'x' })
  holder.snapshot = { state: { ...state, boosts: [stored] } }
  mounted = mount(createElement(BoostEditor, { host: 'www.exemple.fr', id: stored.id }))
  return mounted.container.querySelector<HTMLInputElement>('input[role="switch"]')!
}
const close = (): void => {
  mounted!.unmount()
  mounted = null
}
const wait = (ms: number): void => act(() => void vi.advanceTimersByTime(ms))

beforeEach(() => {
  setLanguage('fr')
  vi.useFakeTimers()
  dispatch.mockReset()
  dispatch.mockResolvedValue(undefined)
  boostPreview.mockReset()
  holder.dispatch = dispatch
  holder.boostPreview = boostPreview
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.useRealTimers()
})

describe('the Tweak editor, while it is open', () => {
  it('stores a change of a Tweak that runs a script as a draft, without waiting to be closed, then sends the plain save as it closes', async () => {
    const active = open(boost({ js: 'window.x = 1' }))
    await click(active)
    wait(250)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'boost/save', draft: true, boost: expect.objectContaining({ id: 'a', host: 'exemple.fr', enabled: false, js: 'window.x = 1' }) })

    // Nothing changed since the draft: the editor still owes the pages their reload.
    close()
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[1]![0]).not.toHaveProperty('draft')
    expect(dispatch.mock.calls[1]![0]).toMatchObject({ type: 'boost/save', boost: { id: 'a', enabled: false } })
  })

  it('stores a change of a Tweak without a script as a plain save, and sends nothing more as it closes', async () => {
    const active = open(boost())
    await click(active)
    wait(250)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls[0]![0]).not.toHaveProperty('draft')
    close()
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('does not send an Eraser list it has not changed: the picks the Eraser stored meanwhile are not replaced by the older list', async () => {
    const active = open(boost())
    await click(active)
    wait(250)
    expect((dispatch.mock.calls[0]![0] as { boost: object }).boost).not.toHaveProperty('zap')
  })
})

describe('the script of a Tweak, while it is typed', () => {
  const UNSAVED = frenchSpaces('Brouillon non enregistré : les pages n’exécutent que le dernier script enregistré.')
  /** Opens the editor on the JS tab and answers its field. */
  async function openScript(stored: Boost): Promise<HTMLTextAreaElement> {
    open(stored)
    await click(button(mounted!.container, 'Code'))
    await click(button(mounted!.container, 'JS'))
    return mounted!.container.querySelector<HTMLTextAreaElement>('textarea')!
  }
  const saved = (): Array<{ type: string; draft?: boolean; boost: Partial<Boost> }> => dispatch.mock.calls.map((call) => call[0] as { type: string; draft?: boolean; boost: Partial<Boost> })
  const has = (label: string): boolean => [...mounted!.container.querySelectorAll('button')].some((one) => one.textContent?.trim() === label)

  it('stores what is typed as a draft apart: the script the pages run stays the saved one, whichever way the editor closes', async () => {
    const field = await openScript(boost({ js: 'window.x = 1' }))
    type(field as unknown as HTMLInputElement, 'window.x = 1; half(')
    wait(250)
    expect(saved()).toEqual([{ type: 'boost/save', draft: true, boost: expect.objectContaining({ js: 'window.x = 1', jsDraft: 'window.x = 1; half(' }) }])
    expect(mounted!.container.textContent).toContain(UNSAVED)
    close()
    expect(saved().every((action) => action.boost.js === 'window.x = 1' && action.boost.jsDraft === 'window.x = 1; half(')).toBe(true)
  })

  it('stores the first script of a Tweak as a draft too: a Tweak that never ran a script runs none while one is typed', async () => {
    const field = await openScript(boost())
    type(field as unknown as HTMLInputElement, 'steal(')
    wait(250)
    close()
    expect(saved().length).toBeGreaterThan(0)
    expect(saved().every((action) => action.boost.js === '' && action.boost.jsDraft === 'steal(')).toBe(true)
  })

  it('reloads no page at a pause in the typing while the saved script runs, even with the field emptied', async () => {
    const field = await openScript(boost({ js: 'window.x = 1' }))
    type(field as unknown as HTMLInputElement, '')
    wait(250)
    // A plain save would reload every page that runs the saved script: this one is a draft, the reload waits for the editor to close.
    expect(saved()).toEqual([{ type: 'boost/save', draft: true, boost: expect.objectContaining({ js: 'window.x = 1', jsDraft: '' }) }])
  })

  it('shows the draft again when the editor is opened later, with the saved script still the one that runs', async () => {
    const field = await openScript(boost({ js: 'saved()', jsDraft: 'typed(' }))
    expect(field.value).toBe('typed(')
    expect(mounted!.container.textContent).toContain(UNSAVED)
    // "Revenir au script enregistré" puts the saved script back in the field: there is no draft any more.
    await click(button(mounted!.container, 'Revenir au script enregistré'))
    expect(field.value).toBe('saved()')
    expect(mounted!.container.textContent).not.toContain(UNSAVED)
    wait(250)
    expect(saved().at(-1)!.boost).toMatchObject({ js: 'saved()', jsDraft: 'saved()' })
  })

  it('makes the draft the script of the Tweak only at "Enregistrer le script", by a plain save that reloads the pages', async () => {
    const field = await openScript(boost({ js: 'old()' }))
    expect(has('Enregistrer le script')).toBe(false)
    type(field as unknown as HTMLInputElement, 'fresh()')
    await click(button(mounted!.container, 'Enregistrer le script'))
    expect(saved().at(-1)).toEqual({ type: 'boost/save', boost: expect.objectContaining({ js: 'fresh()', jsDraft: 'fresh()' }) })
    expect(mounted!.container.textContent).not.toContain(UNSAVED)
  })

  it('does not save or preview a script that does not show what it runs, and says which line', async () => {
    const field = await openScript(boost({ js: 'old()' }))
    type(field as unknown as HTMLInputElement, 'a()\n// note\u2028steal()')
    expect(mounted!.container.querySelector('[role="alert"]')!.textContent).toBe(frenchSpaces('La ligne 2 contient une fin de ligne invisible : du code pourrait s’exécuter à la suite de ce qui se lit comme un commentaire.'))
    expect(button(mounted!.container, 'Enregistrer le script').disabled).toBe(true)
    expect(button(mounted!.container, 'Lancer l’aperçu').disabled).toBe(true)
    type(field as unknown as HTMLInputElement, 'a(\u202E)')
    expect(mounted!.container.querySelector('[role="alert"]')!.textContent).toMatch(/^La ligne 1 contient des caractères qui changent le sens de lecture/)
    expect(button(mounted!.container, 'Enregistrer le script').disabled).toBe(true)
    wait(250)
    close()
    expect(saved().every((action) => action.boost.js === 'old()')).toBe(true)
  })

  it('warns of another invisible character with its line, and lets the script be saved', async () => {
    const field = await openScript(boost())
    type(field as unknown as HTMLInputElement, 'a()\nb("x\u200By")')
    expect(mounted!.container.textContent).toContain(frenchSpaces('Le JavaScript contient des caractères invisibles (première ligne concernée : 2). Relisez-la avec attention.'))
    expect(mounted!.container.querySelector('[role="alert"]')).toBeNull()
    expect(button(mounted!.container, 'Enregistrer le script').disabled).toBe(false)
  })

  it('stores the draft, then asks the shell for the preview by the id of the Tweak, and shows its answer', async () => {
    boostPreview.mockResolvedValue({ ok: true, message: 'Aperçu lancé.' })
    const field = await openScript(boost({ js: 'old()' }))
    type(field as unknown as HTMLInputElement, 'fresh()')
    await click(button(mounted!.container, 'Lancer l’aperçu'))
    await settle()
    expect(saved().at(-1)).toEqual({ type: 'boost/save', draft: true, boost: expect.objectContaining({ js: 'old()', jsDraft: 'fresh()' }) })
    expect(boostPreview.mock.calls).toEqual([['a']])
    expect(dispatch.mock.invocationCallOrder.at(-1)!).toBeLessThan(boostPreview.mock.invocationCallOrder[0]!)
    expect(mounted!.container.querySelector('[role="status"]')!.textContent).toBe('Aperçu lancé.')
  })

  it('says that the preview could not be run when the request fails, and logs why', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    boostPreview.mockRejectedValue(new Error('the channel is closed'))
    const field = await openScript(boost())
    type(field as unknown as HTMLInputElement, 'fresh()')
    await click(button(mounted!.container, 'Lancer l’aperçu'))
    await settle()
    expect(mounted!.container.querySelector('[role="status"]')!.textContent).toMatch(/^L’aperçu ne peut pas être lancé ici/)
    expect(error).toHaveBeenCalledWith('[boost] the preview of the script could not be asked for:', expect.objectContaining({ message: 'the channel is closed' }))
    error.mockRestore()
  })

  it('takes the saved script away with the rest at "Réinitialiser toutes les modifications"', async () => {
    open(boost({ js: 'old()', css: 'p {}' }))
    await click(mounted!.container.querySelector('.bx-title')!)
    await click(button(mounted!.container, 'Réinitialiser toutes les modifications'))
    wait(250)
    expect(saved().at(-1)!.boost).toMatchObject({ js: '', jsDraft: '', css: '' })
  })

  it('offers no preview of a script that still waits to be switched on', async () => {
    await openScript(boost({ js: 'imported()', jsDraft: 'imported() // read', jsEnabled: false }))
    expect(button(mounted!.container, 'Lancer l’aperçu').disabled).toBe(true)
  })
})
