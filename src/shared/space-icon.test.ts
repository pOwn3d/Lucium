import { describe, expect, it, vi } from 'vitest'
import { AA_TEXT, contrastRatio } from './contrast'
import type { Space } from './model'
import { createInitialState, reduce, type Action } from './sidebar'
import { isSpaceEmoji } from './space-emoji'
import {
  ICON_LETTER_MAX,
  LETTER_COLORS,
  RECENT_EMOJIS_MAX,
  choiceOf,
  choicePatch,
  cleanIconColor,
  cleanIconLetter,
  initialsOf,
  letterStyle,
  pickerModeOfKey,
  readRecentEmojis,
  rememberEmoji,
  spaceGlyph,
  spaceIconKind
} from './space-icon'
import { defaultTheme } from './theme'

const PICTURE = '0123456789abcdef01234567.png'
const space = (over: Partial<Space> = {}): Space => ({ id: 'sp', name: 'Client ACME', emoji: '🚀', theme: defaultTheme(), profileId: 'default', ...over })
const ctx = { now: 1, newId: () => 'id' }

describe('the letters of an icon', () => {
  it('are the first two letters or digits, in capitals', () => {
    expect(cleanIconLetter('ac')).toBe('AC')
    expect(cleanIconLetter('a')).toBe('A')
    expect(cleanIconLetter('abc')).toBe('AB')
    expect(cleanIconLetter('4x')).toBe('4X')
    expect(cleanIconLetter('éa')).toBe('ÉA')
    expect(ICON_LETTER_MAX).toBe(2)
  })

  it('leave out spaces, punctuation, emoji and invisible characters, and are nothing when nothing is left', () => {
    expect(cleanIconLetter(' a c ')).toBe('AC')
    expect(cleanIconLetter('a-b')).toBe('AB')
    expect(cleanIconLetter('😀b')).toBe('B')
    expect(cleanIconLetter('‮a\u0000\n')).toBe('A')
    for (const nothing of ['', '   ', '😀', '<>', '\u0000', 7, null, undefined, {}, ['a']]) expect(cleanIconLetter(nothing), String(nothing)).toBeNull()
  })

  it('keep an accented letter whole, and do not cut a letter from its accent', () => {
    expect(cleanIconLetter('é')).toBe('É')
    expect(cleanIconLetter('éa')).toBe('ÉA')
  })

  it('do not spend time on an enormous text', () => {
    expect(cleanIconLetter('a'.repeat(1_000_000))).toBe('AA')
  })

  it('start from the first letters of the first two words of a name', () => {
    expect(initialsOf('Client ACME')).toBe('CA')
    expect(initialsOf('Travail')).toBe('T')
    expect(initialsOf('  vacances d’été ')).toBe('VD')
    expect(initialsOf('Études')).toBe('É')
    expect(initialsOf('😀 !!')).toBe('')
    expect(initialsOf('')).toBe('')
  })
})

describe('the colour behind the letters', () => {
  it('is a #rrggbb code, lower case, and nothing else', () => {
    expect(cleanIconColor('#4B6BD6')).toBe('#4b6bd6')
    for (const bad of ['red', '#fff', '#12345g', '#1234567', 'url(https://evil.example/x)', '#123456; background: url(x)', '', 7, null, {}]) expect(cleanIconColor(bad), String(bad)).toBeNull()
  })

  it('has eight choices, each holding 4.5:1 with the white letters drawn on it', () => {
    expect(LETTER_COLORS).toHaveLength(8)
    expect(new Set(LETTER_COLORS).size).toBe(8)
    for (const color of LETTER_COLORS) {
      expect(cleanIconColor(color), color).toBe(color)
      expect(contrastRatio('#ffffff', color), color).toBeGreaterThanOrEqual(AA_TEXT)
    }
  })

  it('falls back to the first choice, and to a square', () => {
    expect(letterStyle(space())).toEqual({ color: LETTER_COLORS[0], round: false })
    expect(letterStyle(space({ iconColor: '#2F9E63', iconRound: true }))).toEqual({ color: '#2f9e63', round: true })
    expect(letterStyle(space({ iconColor: 'red' as string }))).toEqual({ color: LETTER_COLORS[0], round: false })
  })
})

describe('which icon a space wears', () => {
  it('is its emoji unless it has chosen otherwise', () => {
    expect(spaceIconKind(space())).toBe('emoji')
    expect(spaceIconKind(space({ iconKind: 'emoji', iconLetter: 'AC', image: PICTURE }))).toBe('emoji')
  })

  it('is the letters or the picture when it has chosen them and has them', () => {
    expect(spaceIconKind(space({ iconKind: 'letter', iconLetter: 'AC' }))).toBe('letter')
    expect(spaceIconKind(space({ iconKind: 'image', image: PICTURE }))).toBe('image')
  })

  it('is the picture for a space saved before the choice existed, and falls back when a kind has nothing to show', () => {
    expect(spaceIconKind(space({ image: PICTURE }))).toBe('image')
    expect(spaceIconKind(space({ iconKind: 'letter' }))).toBe('emoji')
    expect(spaceIconKind(space({ iconKind: 'letter', iconLetter: '😀' }))).toBe('emoji')
    expect(spaceIconKind(space({ iconKind: 'image' }))).toBe('emoji')
    expect(spaceIconKind(space({ iconKind: 'letter', image: PICTURE }))).toBe('image')
    expect(spaceIconKind(space({ iconKind: 'image', image: '../x.png' }))).toBe('emoji')
  })

  it('has a glyph in plain text: the letters, or the emoji (a picture reads as the emoji)', () => {
    expect(spaceGlyph(space())).toBe('🚀')
    expect(spaceGlyph(space({ iconKind: 'letter', iconLetter: 'AC' }))).toBe('AC')
    expect(spaceGlyph(space({ iconKind: 'image', image: PICTURE }))).toBe('🚀')
  })
})

describe('the choice of the picker', () => {
  it('opens on what the space wears, with the letters starting from its name', () => {
    expect(choiceOf(space())).toEqual({ kind: 'emoji', emoji: '🚀', letter: 'CA', color: LETTER_COLORS[0], round: false })
    expect(choiceOf(space({ iconKind: 'letter', iconLetter: 'AC', iconColor: '#2f9e63', iconRound: true }))).toEqual({ kind: 'letter', emoji: '🚀', letter: 'AC', color: '#2f9e63', round: true })
  })

  it('becomes a patch of what the choice is about: the letters with their colour and shape, the emoji, or the kind of a picture', () => {
    const choice = { kind: 'letter' as const, emoji: '🎨', letter: 'ac', color: LETTER_COLORS[3]!, round: true }
    expect(choicePatch(choice)).toEqual({ iconKind: 'letter', iconLetter: 'AC', iconColor: LETTER_COLORS[3], iconRound: true })
    expect(choicePatch({ ...choice, kind: 'emoji' })).toEqual({ emoji: '🎨', iconKind: 'emoji' })
    expect(choicePatch({ ...choice, kind: 'image' })).toEqual({ iconKind: 'image' })
  })

  it('does not write over what the space kept for the other kinds: choosing an emoji leaves its letters, choosing letters leaves its emoji', () => {
    const lettered = space({ iconKind: 'letter', iconLetter: 'AC', iconColor: LETTER_COLORS[2]!, iconRound: true })
    const state = { ...createInitialState(ctx), spaces: [lettered], activeSpaceId: 'sp', activeTabBySpace: { sp: null } }
    const toEmoji = reduce(state, { type: 'space/update', id: 'sp', patch: choicePatch({ ...choiceOf(lettered), kind: 'emoji', emoji: '🎨' }) }, ctx).spaces[0]!
    expect(toEmoji).toMatchObject({ emoji: '🎨', iconKind: 'emoji', iconLetter: 'AC', iconColor: LETTER_COLORS[2], iconRound: true })
    const back = reduce({ ...state, spaces: [toEmoji] }, { type: 'space/update', id: 'sp', patch: choicePatch({ ...choiceOf(toEmoji), kind: 'letter' }) }, ctx).spaces[0]!
    expect(back).toMatchObject({ emoji: '🎨', iconKind: 'letter', iconLetter: 'AC' })
    // The letters the picker proposes from the name are written only when the letters are chosen.
    const plain = reduce({ ...state, spaces: [space()] }, { type: 'space/update', id: 'sp', patch: choicePatch({ ...choiceOf(space()), kind: 'emoji', emoji: '🏡' }) }, ctx).spaces[0]!
    expect(plain.iconLetter).toBeUndefined()
  })

  it('falls back to the emoji for letters that are not letters, instead of an empty icon', () => {
    expect(choicePatch({ kind: 'letter', emoji: '🎨', letter: '', color: 'red', round: false })).toEqual({ iconKind: 'emoji' })
  })

  it('takes a colour that is not one for the first colour of the picker', () => {
    expect(choicePatch({ kind: 'letter', emoji: '🎨', letter: 'a', color: 'red', round: false })).toMatchObject({ iconColor: LETTER_COLORS[0] })
  })
})

describe('space/create and space/update with an icon', () => {
  const start = () => createInitialState({ now: 0, newId: () => 'sp' })
  const run = (state: ReturnType<typeof start>, ...actions: Action[]) => actions.reduce((s, a) => reduce(s, a, ctx), state)
  const first = (state: ReturnType<typeof start>) => state.spaces[0]!

  it('creates a space with letters when asked, and with the first colour when none is given', () => {
    const made = run(start(), { type: 'space/create', name: 'Client ACME', emoji: '🚀', hue: 100, letterIcon: { letter: 'ac' } }).spaces[1]!
    expect(made).toMatchObject({ iconKind: 'letter', iconLetter: 'AC', iconColor: LETTER_COLORS[0] })
    expect(made.iconRound).toBeUndefined()
  })

  it('ignores letters that are not letters when it creates', () => {
    for (const letter of ['', '😀', '  ', 7 as unknown as string]) {
      const made = run(start(), { type: 'space/create', name: 'X', emoji: '🚀', hue: 100, letterIcon: { letter, color: 'red' } }).spaces[1]!
      expect(made.iconKind, String(letter)).toBeUndefined()
      expect(made.iconLetter, String(letter)).toBeUndefined()
    }
    const odd = run(start(), { type: 'space/create', name: 'X', emoji: '🚀', hue: 100, letterIcon: 'AC' as unknown as { letter: string } }).spaces[1]!
    expect(odd.iconKind).toBeUndefined()
  })

  it('makes a space wear its letters, its emoji or its picture with one update, each part checked', () => {
    let state = run(start(), { type: 'space/update', id: first(start()).id, patch: { iconLetter: 'ab', iconColor: '#2F9E63', iconRound: true, iconKind: 'letter' } })
    expect(first(state)).toMatchObject({ iconKind: 'letter', iconLetter: 'AB', iconColor: '#2f9e63', iconRound: true })
    state = run(state, { type: 'space/update', id: first(state).id, patch: { iconKind: 'emoji' } })
    // The letters are kept for later: only the kind changed.
    expect(first(state)).toMatchObject({ iconKind: 'emoji', iconLetter: 'AB' })
  })

  it('refuses a kind the space cannot show, and values it cannot keep', () => {
    const base = start()
    const id = first(base).id
    // Letters are needed for the letter kind, a picture for the picture kind.
    expect(first(run(base, { type: 'space/update', id, patch: { iconKind: 'letter' } })).iconKind).toBeUndefined()
    expect(first(run(base, { type: 'space/update', id, patch: { iconKind: 'image' } })).iconKind).toBeUndefined()
    expect(first(run(base, { type: 'space/update', id, patch: { iconKind: 'letter', iconLetter: '😀' } })).iconKind).toBeUndefined()
    // A bad kind, colour, letters or shape change nothing.
    const hostile = { iconKind: 'video', iconLetter: 7, iconColor: 'url(x)', iconRound: 'yes' } as unknown as Extract<Action, { type: 'space/update' }>['patch']
    const after = first(run(base, { type: 'space/update', id, patch: hostile }))
    expect(after.iconKind).toBeUndefined()
    expect(after.iconLetter).toBeUndefined()
    expect(after.iconColor).toBeUndefined()
    expect(after.iconRound).toBeUndefined()
  })

  it('takes the picture back to the emoji, but leaves a space that wears letters as it is', () => {
    let state = start()
    const id = first(state).id
    state = run(state, { type: 'space/image', id, image: PICTURE })
    expect(first(state)).toMatchObject({ image: PICTURE, iconKind: 'image' })
    state = run(state, { type: 'space/image', id, image: null })
    expect(first(state).iconKind).toBe('emoji')
    expect(first(state).image).toBeUndefined()
  })
})

describe('the recent emoji', () => {
  it('put the newest first, without repeats, and stop at eight', () => {
    expect(rememberEmoji([], '🚀')).toEqual(['🚀'])
    expect(rememberEmoji(['🚀', '🎨'], '🎨')).toEqual(['🎨', '🚀'])
    let list: string[] = []
    for (const emoji of ['🚀', '🎨', '📚', '🛠️', '🌱', '🎧', '💡', '🧪', '🏠', '💼']) list = rememberEmoji(list, emoji)
    expect(list).toHaveLength(RECENT_EMOJIS_MAX)
    expect(list[0]).toBe('💼')
    expect(list).not.toContain('🚀')
  })

  it('are read back from the storage, keeping only emoji, once each', () => {
    expect(readRecentEmojis(JSON.stringify(['🚀', '🎨', '🚀', 'abc', 7, null, '<img src=x>', '💼']), isSpaceEmoji)).toEqual(['🚀', '🎨', '💼'])
    expect(readRecentEmojis(null, isSpaceEmoji)).toEqual([])
    expect(readRecentEmojis('{"a":1}', isSpaceEmoji)).toEqual([])
    expect(readRecentEmojis(JSON.stringify(Array.from({ length: 30 }, () => '🚀')), isSpaceEmoji)).toEqual(['🚀'])
    const many = ['🚀', '🎨', '📚', '🛠️', '🌱', '🎧', '💡', '🧪', '🏠', '💼']
    expect(readRecentEmojis(JSON.stringify(many), isSpaceEmoji)).toHaveLength(RECENT_EMOJIS_MAX)
  })

  it('start again empty from a storage that cannot be read, and say so in the log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(readRecentEmojis('{not json', isSpaceEmoji)).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain('recent emoji')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('the keys of the picker', () => {
  const key = (k: string, over: Partial<KeyboardEvent> = {}) => ({ key: k, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, ...over })

  it('switch the type with ⌘1, ⌘2 and ⌘3 (and Ctrl elsewhere)', () => {
    expect(pickerModeOfKey(key('1'))).toBe('emoji')
    expect(pickerModeOfKey(key('2'))).toBe('letter')
    expect(pickerModeOfKey(key('3'))).toBe('image')
    expect(pickerModeOfKey(key('2', { metaKey: false, ctrlKey: true }))).toBe('letter')
  })

  it('leave the other keys alone: a digit typed in a field, ⌘4, Shift and Option combinations', () => {
    expect(pickerModeOfKey(key('1', { metaKey: false }))).toBeNull()
    expect(pickerModeOfKey(key('4'))).toBeNull()
    expect(pickerModeOfKey(key('1', { shiftKey: true }))).toBeNull()
    expect(pickerModeOfKey(key('1', { altKey: true }))).toBeNull()
  })
})
