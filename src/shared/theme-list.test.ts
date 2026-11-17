import { describe, expect, it } from 'vitest'
import { READY_THEMES } from './theme-presets'
import { encodeThemeCode } from './theme-code'
import { currentChoice, flatChoices, previewedTheme, themeGroups } from './theme-list'
import { cleanTheme, defaultTheme, themeFromHue } from './theme'

const space = (id: string, name: string, theme = defaultTheme()) => ({ id, name, theme })

describe('the list of themes of the theme panel', () => {
  it('holds every ready theme exactly once, dark ones first: no page, no empty place', () => {
    const groups = themeGroups([space('a', 'Travail')], 'a')
    expect(groups.map((group) => group.id)).toEqual(['dark', 'light'])
    const listed = flatChoices(groups).map((choice) => choice.id)
    expect(listed).toEqual([...READY_THEMES.filter((t) => t.theme.appearance === 'dark'), ...READY_THEMES.filter((t) => t.theme.appearance === 'light')].map((t) => `ready:${t.id}`))
    expect(new Set(listed).size).toBe(READY_THEMES.length)
    expect(listed).toHaveLength(20)
  })

  it('puts each theme in the group of its appearance', () => {
    const groups = themeGroups([], '')
    for (const group of groups) for (const choice of group.choices) expect(choice.theme.appearance, choice.name).toBe(group.id)
  })

  it('names every theme and gives it a pastille', () => {
    for (const choice of flatChoices(themeGroups([], ''))) {
      expect(choice.name.trim(), choice.id).not.toBe('')
      expect(choice.swatch, choice.id).toMatch(/^linear-gradient\(135deg, #[0-9a-f]{6} 0 58%, #[0-9a-f]{6} 58% 100%\)$/i)
    }
  })

  it('adds "Mes thèmes": the themes of the other spaces, named after them, once each, and not a ready one', () => {
    const blue = themeFromHue(220)
    const groups = themeGroups(
      [space('a', 'Courant', themeFromHue(10)), space('b', 'Perso', blue), space('c', 'Doublon', blue), space('d', 'Nord', READY_THEMES.find((t) => t.id === 'nord')!.theme), space('e', 'Vert', themeFromHue(140))],
      'a'
    )
    expect(groups.map((group) => group.id)).toEqual(['dark', 'light', 'mine'])
    const mine = groups.find((group) => group.id === 'mine')!.choices
    // The space being edited is not offered its own theme; a copy of another is not offered twice; a ready theme is already in its list.
    expect(mine.map((choice) => choice.name)).toEqual(['Perso', 'Vert'])
    expect(mine[0]).toMatchObject({ id: 'space:b', theme: blue })
  })

  it('leaves "Mes thèmes" out when there is nothing to put in it', () => {
    expect(themeGroups([space('a', 'Seul')], 'a').some((group) => group.id === 'mine')).toBe(false)
    expect(themeGroups([space('a', 'Seul'), space('b', 'Nord', READY_THEMES[2]!.theme)], 'a').some((group) => group.id === 'mine')).toBe(false)
  })
})

describe('the preview', () => {
  it('shows the theme under the pointer, else the theme the space has', () => {
    const groups = themeGroups([], '')
    const choice = flatChoices(groups)[0]!
    const mine = themeFromHue(30)
    expect(previewedTheme(choice, mine)).toBe(choice.theme)
    expect(previewedTheme(null, mine)).toBe(mine)
  })

  it('goes back to the theme of the space when the pointer leaves, without having changed it', () => {
    const groups = themeGroups([], '')
    const dracula = READY_THEMES[0]!.theme
    const choices = flatChoices(groups)
    let hovered = choices[3]!
    expect(previewedTheme(hovered, dracula)).not.toEqual(dracula)
    hovered = null as never
    expect(previewedTheme(hovered, dracula)).toBe(dracula)
  })
})

describe('which theme the space has now', () => {
  it('is the choice with the same colours, texture and appearance', () => {
    const groups = themeGroups([], '')
    const nord = READY_THEMES.find((t) => t.id === 'nord')!
    expect(currentChoice(groups, nord.theme)?.id).toBe('ready:nord')
    // Through the code, so that the rounding the code applies counts as the same.
    expect(currentChoice(groups, cleanTheme(JSON.parse(JSON.stringify(nord.theme))))?.id).toBe('ready:nord')
  })

  it('is none when the space has a theme of its own', () => {
    expect(currentChoice(themeGroups([], ''), themeFromHue(77))).toBeNull()
    expect(encodeThemeCode(themeFromHue(77))).not.toBe(encodeThemeCode(READY_THEMES[0]!.theme))
  })

  it('is none once the appearance of a ready theme is changed (it is no longer that theme)', () => {
    const nord = READY_THEMES.find((t) => t.id === 'nord')!
    expect(currentChoice(themeGroups([], ''), { ...nord.theme, appearance: 'light' })).toBeNull()
  })
})
