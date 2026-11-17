import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from './i18n'
import type { Space } from './model'
import { createInitialState, reduce } from './sidebar'
import { appearanceLabel, changedSince, colorSummary, iconSummary, pictureNote, revertPatch, snapshotOf } from './space-customize'
import { LETTER_COLORS } from './space-icon'
import { NAMED_COLORS } from './theme-colors'
import { cleanTheme, defaultTheme, themeFromHue, withColorAt } from './theme'

afterEach(() => setLanguage('fr'))

const ctx = { now: 1, newId: () => 'id' }
const start = (): Space => ({ id: 'sp', name: 'Travail', emoji: '💼', theme: themeFromHue(220), profileId: 'default' })
const update = (space: Space, patch: Extract<Parameters<typeof reduce>[1], { type: 'space/update' }>['patch']): Space => {
  const state = createInitialState(ctx)
  const withSpace = { ...state, spaces: [space], activeSpaceId: space.id, activeTabBySpace: { [space.id]: null } }
  return reduce(withSpace, { type: 'space/update', id: space.id, patch }, ctx).spaces[0]!
}

describe('"Rétablir"', () => {
  it('is not offered before anything changes', () => {
    const space = start()
    expect(changedSince(snapshotOf(space), space)).toBe(false)
  })

  it('is offered as soon as the name, the emoji, the icon kind, the letters, the profile or the theme changes', () => {
    const original = snapshotOf(start())
    for (const patch of [
      { name: 'Perso' },
      { emoji: '🏡' },
      { iconLetter: 'TR', iconKind: 'letter' as const },
      { profileId: 'work' },
      { theme: { appearance: 'dark' as const } },
      { theme: { intensity: 0.4 } },
      { theme: withColorAt(start().theme, 0, NAMED_COLORS[3]!.hex)! }
    ]) {
      expect(changedSince(original, update(start(), patch)), JSON.stringify(patch)).toBe(true)
    }
  })

  it('is not offered when a change is undone by hand', () => {
    const original = snapshotOf(start())
    const there = update(start(), { name: 'Perso', emoji: '🏡' })
    const back = update(there, { name: 'Travail', emoji: '💼' })
    expect(changedSince(original, back)).toBe(false)
  })

  it('does not count letters put aside for the emoji: they do not show, and a person did not change what they see', () => {
    const original = snapshotOf(start())
    const aside = update(start(), { iconLetter: 'TR', iconColor: LETTER_COLORS[2]!, iconRound: true, iconKind: 'emoji' })
    expect(aside.iconLetter).toBe('TR')
    expect(changedSince(original, aside)).toBe(false)
    // …but the same letters worn are a change, and so is any part of them.
    const worn = update(aside, { iconKind: 'letter' })
    expect(changedSince(original, worn)).toBe(true)
    expect(changedSince(snapshotOf(worn), update(worn, { iconColor: LETTER_COLORS[3]! }))).toBe(true)
    expect(changedSince(snapshotOf(worn), update(worn, { iconRound: false }))).toBe(true)
  })

  it('puts back everything it covers: name, icon, profile and theme', () => {
    const original = start()
    const changed = update(original, { name: 'Perso', emoji: '🏡', iconLetter: 'PE', iconColor: LETTER_COLORS[2]!, iconRound: true, iconKind: 'letter', profileId: 'work', theme: { appearance: 'dark', intensity: 0.2, overlay: 'fine', noise: 0.5 } })
    const reverted = update(changed, revertPatch(snapshotOf(original)))
    expect(reverted.name).toBe('Travail')
    expect(reverted.emoji).toBe('💼')
    expect(reverted.profileId).toBe('default')
    expect(reverted.theme).toEqual(original.theme)
    expect(changedSince(snapshotOf(original), reverted)).toBe(false)
  })

  it('takes away a background added to a space that had none, and is offered for it', () => {
    const original = start()
    const dressed = update(original, { background: { type: 'image', value: 'a'.repeat(32) + '.jpg' } })
    expect(dressed.background).toBeDefined()
    expect(changedSince(snapshotOf(original), dressed)).toBe(true)
    const reverted = update(dressed, revertPatch(snapshotOf(original)))
    expect(reverted.background).toBeUndefined()
    expect(changedSince(snapshotOf(original), reverted)).toBe(false)
  })

  it('puts back the background the space had, with its veil, when it was changed or removed', () => {
    const original = update(start(), { background: { type: 'image', value: 'a'.repeat(32) + '.jpg', veilColor: '#102030', veil: 40 } })
    expect(original.background).toBeDefined()
    for (const patch of [{ background: undefined }, { background: { ...original.background!, veil: 90 } }, { background: { type: 'image' as const, value: 'b'.repeat(32) + '.png' } }]) {
      const changed = update(original, patch)
      expect(changedSince(snapshotOf(original), changed), JSON.stringify(patch)).toBe(true)
      expect(update(changed, revertPatch(snapshotOf(original))).background).toEqual(original.background)
    }
  })

  // The panel changes the background too (a picture or a video, its veil, the colour of the text): it is part of what "Rétablir" covers.
  it('is offered when the background changes, and puts it back: the one the space had, or none for a space that had none', () => {
    const bare = start()
    const opened = snapshotOf(bare)
    const dressed = update(bare, { background: { type: 'image', value: 'plage.jpg' } })
    expect(dressed.background).toMatchObject({ type: 'image', value: 'plage.jpg' })
    expect(changedSince(opened, dressed)).toBe(true)
    const back = update(dressed, revertPatch(opened))
    expect(back.background).toBeUndefined()
    expect(changedSince(opened, back)).toBe(false)

    const openedDressed = snapshotOf(dressed)
    const veiled = update(dressed, { background: { ...dressed.background!, veilColor: '#000000', veil: 40 } })
    expect(changedSince(openedDressed, veiled)).toBe(true)
    expect(update(veiled, revertPatch(openedDressed)).background).toEqual(dressed.background)
    const removed = update(dressed, { background: undefined })
    expect(changedSince(openedDressed, removed)).toBe(true)
    expect(update(removed, revertPatch(openedDressed)).background).toEqual(dressed.background)
  })

  it('brings back the kind of icon the space wore, even when the letters it had picked are kept for later', () => {
    const original = start()
    const lettered = update(original, { iconLetter: 'TR', iconKind: 'letter' })
    expect(snapshotOf(lettered).kind).toBe('letter')
    const reverted = update(lettered, revertPatch(snapshotOf(original)))
    expect(snapshotOf(reverted).kind).toBe('emoji')
    // …and the other way round: reverting to letters.
    const toEmoji = update(lettered, { iconKind: 'emoji' })
    expect(snapshotOf(update(toEmoji, revertPatch(snapshotOf(lettered)))).kind).toBe('letter')
  })

  it('carries a theme that is whole, so that the revert cannot leave a half-restored theme', () => {
    const patch = revertPatch(snapshotOf({ ...start(), theme: { ...defaultTheme(), intensity: 0.3 } }))
    expect(patch.theme).toEqual(cleanTheme(patch.theme))
  })
})

describe('the line a section shows before it is opened', () => {
  it('says the colour and the appearance: "Bleu · automatique"', () => {
    expect(colorSummary(cleanTheme({ ...themeFromHue(220), baseColors: ['#4b6bd6'], harmony: 'custom', appearance: 'auto' }))).toBe('Bleu · automatique')
    expect(colorSummary(cleanTheme({ ...themeFromHue(220), baseColors: ['#e05d5d'], harmony: 'custom', appearance: 'dark' }))).toBe('Corail · sombre')
    expect(colorSummary(cleanTheme({ ...themeFromHue(220), baseColors: ['#123456'], harmony: 'custom', appearance: 'light' }))).toBe('Personnalisée · clair')
  })

  it('says which icon the space wears', () => {
    expect(iconSummary('emoji')).toBe('Émoji')
    expect(iconSummary('letter')).toBe('Lettre')
    expect(iconSummary('image')).toBe('Image')
  })

  it('reads in English when the interface does', () => {
    setLanguage('en')
    expect(colorSummary(cleanTheme({ ...themeFromHue(220), baseColors: ['#4b6bd6'], harmony: 'custom', appearance: 'auto' }))).toBe('Blue · automatic')
    expect(appearanceLabel('dark')).toBe('Dark')
    expect(iconSummary('emoji')).toBe('Emoji')
  })
})

describe('what a request for a picture tells the person', () => {
  const FAILURE = 'L’image n’a pas pu être importée.'

  it('says nothing when it worked, and nothing when the person closed the dialog', async () => {
    expect(await pictureNote(Promise.resolve({ ok: true }), FAILURE)).toBe('')
    expect(await pictureNote(Promise.resolve({ ok: false, message: '' }), FAILURE)).toBe('')
  })

  it('gives the sentence of the main process when it refused (a file that is not a picture, one that is too big)', async () => {
    expect(await pictureNote(Promise.resolve({ ok: false, message: 'Cette image est trop lourde (5 Mo au plus).' }), FAILURE)).toBe('Cette image est trop lourde (5 Mo au plus).')
  })

  it('says the request failed when it did not get through, and writes the error in the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await pictureNote(Promise.reject(new Error('forced: the channel is closed')), FAILURE)).toBe(FAILURE)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain('[space image]')
      expect(String(warn.mock.calls[0]![1])).toContain('forced: the channel is closed')
    } finally {
      warn.mockRestore()
    }
  })
})
