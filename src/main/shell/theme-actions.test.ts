import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action, type Ctx } from '@shared/sidebar'
import { defaultTheme, harmonize, type SpaceTheme } from '@shared/theme'
import { encodeThemeCode } from '@shared/theme-code'
import { READY_THEMES } from '@shared/theme-presets'
import { frenchSpaces } from '@shared/french-typography'
import { applyThemeToAll, copySpaceTheme, copyThemeText, pasteTheme, runThemeRequest, type ThemeEnvironment } from './theme-actions'

const DRACULA = READY_THEMES[0]!.theme
const DRACULA_CODE = encodeThemeCode(DRACULA)

function fakeState(spaces = 3): SidebarState {
  let n = 0
  const ctx: Ctx = { now: 1, newId: () => `id${++n}` }
  let s = createInitialState(ctx)
  for (let i = 1; i < spaces; i++) s = reduce(s, { type: 'space/create', name: `Espace ${i}`, emoji: '📁', hue: i * 70 }, ctx)
  return s
}

/** A window made of plain values: the state goes through the real reducer, the clipboard and the toast are recorded. */
function environment(over: { spaces?: number; clipboard?: string | Error; writeFails?: boolean; isPrivate?: boolean } = {}) {
  let state = fakeState(over.spaces)
  const ctx: Ctx = { now: 2, newId: () => 'unused' }
  const toasts: Array<{ message: string; action?: { label: string; run: () => void } }> = []
  const written: string[] = []
  const dispatched: Action[] = []
  const env: ThemeEnvironment = {
    state: () => state,
    dispatch: (action) => {
      dispatched.push(action)
      state = reduce(state, action, ctx)
    },
    toast: (message, action) => void toasts.push({ message, action }),
    readClipboard: async () => {
      if (over.clipboard instanceof Error) throw over.clipboard
      return over.clipboard ?? ''
    },
    writeClipboard: async (text) => {
      if (over.writeFails) throw new Error('denied')
      written.push(text)
    },
    isPrivate: () => over.isPrivate === true
  }
  return { env, get state() { return state }, toasts, written, dispatched }
}

const themeOf = (w: { state: SidebarState }, index: number): SpaceTheme => w.state.spaces[index]!.theme

afterEach(() => vi.restoreAllMocks())

describe('copying', () => {
  it('puts the code of the theme of a space on the clipboard and says so', async () => {
    const w = environment()
    expect(await copySpaceTheme(w.env, w.state.spaces[0]!.id)).toEqual({ ok: true, message: 'Thème copié' })
    expect(w.written).toEqual([encodeThemeCode(defaultTheme())])
    expect(w.toasts.map((t) => t.message)).toEqual(['Thème copié'])
  })

  it('copies a code or a colour from the editor in its canonical form, and nothing else', async () => {
    const w = environment()
    expect(await copyThemeText(w.env, `  "${DRACULA_CODE.toUpperCase()}" `)).toMatchObject({ ok: true, message: 'Code du thème copié' })
    expect(await copyThemeText(w.env, 'BD93F9')).toMatchObject({ ok: true, message: 'Couleur copiée' })
    expect(w.written).toEqual([DRACULA_CODE, '#bd93f9'])
    const refused = await copyThemeText(w.env, 'rm -rf /; https://evil.example/?token=1')
    expect(refused.ok).toBe(false)
    expect(w.written).toHaveLength(2)
  })

  it('tells the person when the clipboard refuses, instead of announcing a copy that did not happen', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = environment({ writeFails: true })
    const reply = await copySpaceTheme(w.env, w.state.spaces[0]!.id)
    expect(reply).toEqual({ ok: false, message: 'Le presse-papiers n’est pas accessible.' })
    expect(w.toasts.map((t) => t.message)).toEqual(['Le presse-papiers n’est pas accessible.'])
    expect(console.error).toHaveBeenCalled()
  })

  it('is not available in a private window, or for a space that is gone', async () => {
    const priv = environment({ isPrivate: true })
    expect((await copySpaceTheme(priv.env, priv.state.spaces[0]!.id)).ok).toBe(false)
    expect(priv.written).toEqual([])
    const w = environment()
    expect(await copySpaceTheme(w.env, 'gone')).toEqual({ ok: false, message: 'Cet espace n’existe plus.' })
  })
})

describe('pasting', () => {
  it('applies a theme code from the clipboard to the space, and only to it', async () => {
    const w = environment({ clipboard: DRACULA_CODE })
    const before = w.state.spaces.map((s) => s.theme)
    expect(await pasteTheme(w.env, w.state.spaces[1]!.id)).toEqual({ ok: true, message: 'Thème collé' })
    expect(themeOf(w, 1)).toEqual(DRACULA)
    expect(themeOf(w, 0)).toEqual(before[0])
    expect(themeOf(w, 2)).toEqual(before[2])
    expect(w.toasts.map((t) => t.message)).toEqual(['Thème collé'])
  })

  it('applies the text of the editor field in place of the clipboard when there is one', async () => {
    const w = environment({ clipboard: new Error('never read') })
    expect((await pasteTheme(w.env, w.state.spaces[0]!.id, DRACULA_CODE)).ok).toBe(true)
    expect(themeOf(w, 0)).toEqual(DRACULA)
  })

  it('takes a colour as the base colour, the harmony deriving the others', async () => {
    const w = environment({ clipboard: '#FF0000' })
    expect(await pasteTheme(w.env, w.state.spaces[0]!.id)).toEqual({ ok: true, message: 'Couleur collée comme couleur de base' })
    expect(themeOf(w, 0).baseColors).toEqual(harmonize('#ff0000', 'complementary', 2))
    expect(themeOf(w, 0).intensity).toBe(defaultTheme().intensity)
  })

  it('refuses text that is not a theme, says why, and changes nothing', async () => {
    for (const [text, expected] of [['', /Rien à coller/], ['bonjour', /ni un code de thème ni une couleur/], ['luc2_x', /autre version/], ['luc1_zzzzzz_custom', /incomplet ou abîmé/], ['x'.repeat(5000), /trop long/]] as const) {
      const w = environment({ clipboard: text })
      const before = w.state
      const reply = await pasteTheme(w.env, w.state.spaces[0]!.id)
      expect(reply.ok, text).toBe(false)
      expect(reply.message).toMatch(expected)
      expect(w.state).toBe(before)
      expect(w.dispatched).toEqual([])
    }
  })

  it('reports a clipboard that cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = environment({ clipboard: new Error('denied') })
    expect(await pasteTheme(w.env, w.state.spaces[0]!.id)).toEqual({ ok: false, message: 'Le presse-papiers n’est pas accessible.' })
    expect(console.error).toHaveBeenCalled()
    expect(w.dispatched).toEqual([])
  })

  it('does nothing in a private window or for a space that is gone, even with a valid code', async () => {
    const priv = environment({ isPrivate: true, clipboard: DRACULA_CODE })
    expect((await pasteTheme(priv.env, priv.state.spaces[0]!.id)).ok).toBe(false)
    expect(priv.dispatched).toEqual([])
    const w = environment({ clipboard: DRACULA_CODE })
    expect(await pasteTheme(w.env, 'gone')).toEqual({ ok: false, message: 'Cet espace n’existe plus.' })
    expect(w.dispatched).toEqual([])
  })
})

describe('applying to every space', () => {
  it('gives the theme of the space to all of them in one step and offers to undo it in a toast', async () => {
    const w = environment({ spaces: 4 })
    const source = w.state.spaces[0]!
    const own = [...w.state.spaces.map((s) => s.theme)]
    w.env.dispatch({ type: 'space/update', id: source.id, patch: { theme: DRACULA } })
    w.dispatched.length = 0
    expect(await applyThemeToAll(w.env, source.id)).toEqual({ ok: true, message: 'Thème appliqué aux 4 espaces' })
    expect(w.state.spaces.every((s) => JSON.stringify(s.theme) === JSON.stringify(DRACULA))).toBe(true)
    expect(w.dispatched).toHaveLength(1)
    expect(w.toasts.at(-1)).toMatchObject({ message: 'Thème appliqué aux 4 espaces', action: { label: 'Annuler' } })
    w.toasts.at(-1)!.action!.run()
    expect(w.state.spaces[0]!.theme).toEqual(DRACULA)
    expect(w.state.spaces.slice(1).map((s) => s.theme)).toEqual(own.slice(1))
  })

  it('applies the theme the editor sends (its draft), repaired, rather than the one saved', async () => {
    const w = environment()
    const draft = { ...DRACULA, intensity: 7, baseColors: ['#112233'] } as SpaceTheme
    await applyThemeToAll(w.env, w.state.spaces[1]!.id, draft)
    for (const space of w.state.spaces) expect(space.theme).toMatchObject({ baseColors: ['#112233'], intensity: 1 })
  })

  it('has nothing to apply with a single space, and does not announce it', async () => {
    const w = environment({ spaces: 1 })
    expect((await applyThemeToAll(w.env, w.state.spaces[0]!.id)).ok).toBe(false)
    expect(w.toasts).toEqual([])
    expect(w.dispatched).toEqual([])
  })

  it('does nothing in a private window or for a space that is gone', async () => {
    const priv = environment({ isPrivate: true })
    expect((await applyThemeToAll(priv.env, priv.state.spaces[0]!.id)).ok).toBe(false)
    expect(priv.dispatched).toEqual([])
    const w = environment()
    expect(await applyThemeToAll(w.env, 'gone')).toEqual({ ok: false, message: 'Cet espace n’existe plus.' })
    expect(w.dispatched).toEqual([])
  })
})

describe('runThemeRequest', () => {
  it('sends each kind of request to its action', async () => {
    const w = environment({ clipboard: DRACULA_CODE })
    const id = w.state.spaces[0]!.id
    expect((await runThemeRequest(w.env, { kind: 'copy', text: '#bd93f9' })).message).toBe('Couleur copiée')
    expect((await runThemeRequest(w.env, { kind: 'paste', spaceId: id })).message).toBe('Thème collé')
    expect((await runThemeRequest(w.env, { kind: 'apply-all', spaceId: id })).message).toBe('Thème appliqué aux 3 espaces')
  })
})

describe('the theme of a locked space', () => {
  const LOCKED = 'Cet espace est verrouillé : déverrouillez-le d’abord.'

  it('is not replaced by a pasted one: nothing is sent, and the reply says why', async () => {
    const w = environment({ clipboard: DRACULA_CODE })
    const [first, second] = w.state.spaces
    w.env.lockedSpaces = () => [second!.id]
    const before = w.state
    expect(await pasteTheme(w.env, second!.id)).toEqual({ ok: false, message: frenchSpaces(LOCKED) })
    expect(w.dispatched).toEqual([])
    expect(w.toasts).toEqual([])
    expect(w.state).toBe(before)
    // The control: the space beside it is not locked.
    expect((await pasteTheme(w.env, first!.id)).ok).toBe(true)
  })

  it('is kept when a theme is applied to every space: the others get it, the notice counts them, and undoing leaves it alone too', async () => {
    const w = environment({ spaces: 4 })
    const source = w.state.spaces[0]!
    const lockedSpace = w.state.spaces[2]!
    w.env.dispatch({ type: 'space/update', id: source.id, patch: { theme: DRACULA } })
    w.env.lockedSpaces = () => [lockedSpace.id]
    w.dispatched.length = 0
    expect(await applyThemeToAll(w.env, source.id)).toEqual({ ok: true, message: 'Thème appliqué aux 3 espaces' })
    expect(w.state.spaces[2]!.theme).toEqual(lockedSpace.theme)
    expect([0, 1, 3].every((i) => JSON.stringify(themeOf(w, i)) === JSON.stringify(DRACULA))).toBe(true)
    expect(w.dispatched).toEqual([expect.objectContaining({ type: 'space/apply-themes', entries: [0, 1, 3].map((i) => expect.objectContaining({ id: w.state.spaces[i]!.id })) })])
    w.toasts.at(-1)!.action!.run()
    expect((w.dispatched[1] as { entries: Array<{ id: string }> }).entries.map((e) => e.id)).toEqual([0, 1, 3].map((i) => w.state.spaces[i]!.id))
  })

  it('leaves nothing to apply when every other space is locked, and says so', async () => {
    const w = environment({ spaces: 2 })
    w.env.lockedSpaces = () => [w.state.spaces[1]!.id]
    expect(await applyThemeToAll(w.env, w.state.spaces[0]!.id)).toEqual({ ok: false, message: frenchSpaces('Les autres espaces sont verrouillés : leur thème ne change pas.') })
    expect(w.dispatched).toEqual([])
    expect(w.toasts).toEqual([])
  })
})
