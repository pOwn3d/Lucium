import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import { createInitialState, reduce, type Ctx } from './sidebar'
import { SESSION_SPACE_EMOJI } from './sessions'
import { defaultSpaceEmoji } from './space-creation'
import {
  ALL_EMOJIS,
  EMOJI_SEARCH_LIMIT,
  SPACE_EMOJI_MAX_UNITS,
  emojiCategories,
  isSpaceEmoji,
  isSpaceLetter,
  isSpaceMark,
  normalizeWord,
  searchEmojis,
  spaceEmojiOr
} from './space-emoji'

// The invisible characters, written as escapes so that no source line hides them.
const ZWJ = '\u{200D}'
const ZWNJ = '\u{200C}'
const VS16 = '\u{FE0F}'
const VS15 = '\u{FE0E}'
const KEYCAP = '\u{20E3}'
const ZERO_WIDTH_SPACE = '\u{200B}'
const RTL_OVERRIDE = '\u{202E}'
const COMBINING_ACUTE = '\u{0301}'
const join = (...parts: string[]): string => parts.join(ZWJ)
const flag = (code: string): string => String.fromCodePoint(...[...code].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65))
const tagFlag = (code: string): string => `\u{1F3F4}${[...code].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('')}\u{E007F}`
const units = (text: string): string => [...text].map((c) => c.codePointAt(0)!.toString(16)).join(' ')

afterEach(() => setLanguage('fr'))

describe('the catalogue of emoji', () => {
  it('has a few hundred emoji in nine categories, in the order a picker shows them', () => {
    const categories = emojiCategories()
    expect(categories.map((c) => c.id)).toEqual(['faces', 'people', 'nature', 'food', 'activities', 'travel', 'objects', 'symbols', 'flags'])
    for (const category of categories) expect(category.emojis.length, category.id).toBeGreaterThanOrEqual(30)
    expect(ALL_EMOJIS.length).toBeGreaterThanOrEqual(300)
    expect(ALL_EMOJIS.length).toBeLessThanOrEqual(700)
    expect(ALL_EMOJIS).toEqual(categories.flatMap((c) => c.emojis))
  })

  it('names its categories in the language of the interface, and follows it when it changes', () => {
    const french = emojiCategories().map((c) => c.label)
    setLanguage('en')
    const english = emojiCategories().map((c) => c.label)
    expect(french[0]).toBe('Visages et émotions')
    expect(english[0]).toBe('Faces & Emotions')
    expect(new Set(french).size).toBe(9)
    expect(new Set(english).size).toBe(9)
    for (let i = 0; i < 9; i++) expect(french[i], String(i)).not.toBe(english[i])
  })

  it('holds only values the stored field accepts: each one is a single emoji, and none is there twice', () => {
    const invalid = ALL_EMOJIS.filter((e) => !isSpaceEmoji(e.emoji)).map((e) => `${e.emoji} (${units(e.emoji)})`)
    expect(invalid).toEqual([])
    const seen = new Set<string>()
    for (const { emoji } of ALL_EMOJIS) {
      expect(seen.has(emoji), emoji).toBe(false)
      seen.add(emoji)
    }
  })

  it('has French and English words for every emoji, lower case, without accents or spaces', () => {
    for (const entry of ALL_EMOJIS) {
      expect(entry.en.length, `${entry.emoji} english`).toBeGreaterThan(0)
      expect(entry.fr.length, `${entry.emoji} français`).toBeGreaterThan(0)
      expect(entry.keywords, entry.emoji).toEqual([...new Set([...entry.en, ...entry.fr])])
      for (const word of entry.keywords) expect(word, `${entry.emoji} ${word}`).toMatch(/^[a-z0-9]+$/)
    }
  })

  it('still offers everything the pickers offered before: the icons of the sheet, the starting icons, the icons of a tab and the defaults', () => {
    const sheet = ['🏠', '💼', '🎧', '💬', '🧪', '🚀', '🎨', '📚', '🛠️', '🌱', '💡', '🎮', '🏋️', '🍳', '✈️', '💰', '🧠', '📷', '🎬', '🔒', '🌍', '⚡', '🔥', '⭐']
    const tab = ['🏠', '💼', '📚', '🛠️', '🎧', '💬', '📧', '📅', '📝', '💡', '🎨', '🎬', '🎮', '🛒', '💰', '✈️', '🍳', '🏋️', '🧪', '🚀', '⭐', '🔥', '❤️', '🔒', '🌍', '🧠', '📷', '🔗', '⚡', '✅', '📌', '🐞']
    const starters = Array.from({ length: 8 }, (_, n) => defaultSpaceEmoji(n))
    const known = new Set(ALL_EMOJIS.map((e) => e.emoji))
    const missing = [...sheet, ...tab, ...starters, SESSION_SPACE_EMOJI, '📁', '✨'].filter((emoji) => !known.has(emoji))
    expect(missing).toEqual([])
  })

  it('is accepted by the store as it is: a space keeps the very string, whatever the emoji', () => {
    let n = 0
    const ctx: Ctx = { now: 1, newId: () => `id-${++n}` }
    const start = createInitialState(ctx)
    const id = start.spaces[0]!.id
    const refused = ALL_EMOJIS.filter(({ emoji }) => reduce(start, { type: 'space/update', id, patch: { emoji } }, ctx).spaces[0]!.emoji !== emoji).map((e) => e.emoji)
    expect(refused).toEqual([])
    expect(reduce(start, { type: 'space/create', name: 'Famille', emoji: join('👨', '👩', '👧', '👦'), hue: 10 }, ctx).spaces.at(-1)!.emoji).toBe(join('👨', '👩', '👧', '👦'))
  })
})

describe('searching the emoji', () => {
  const firstOf = (query: string): string | undefined => searchEmojis(query)[0]?.emoji
  const found = (query: string): string[] => searchEmojis(query).map((e) => e.emoji)

  it('finds an emoji by an English word or a French word, whatever the language of the interface', () => {
    for (const language of ['fr', 'en'] as const) {
      setLanguage(language)
      expect(found('cat'), language).toContain('🐱')
      expect(found('chat'), language).toContain('🐱')
      expect(firstOf('chien'), language).toBe('🐶')
      expect(firstOf('dog'), language).toBe('🐶')
      expect(firstOf('fusee'), language).toBe('🚀')
      expect(firstOf('rocket'), language).toBe('🚀')
    }
  })

  it('ignores case and accents, in the query as in the words', () => {
    expect(found('ÉCOLE')).toEqual(found('ecole'))
    expect(found('ecole')).toContain('🏫')
    expect(found('Étoile')).toContain('⭐')
    expect(found('  PIZZA ')).toEqual(['🍕'])
    expect(normalizeWord('Œuf à la crème')).toBe('oeuf a la creme')
    expect(found('oeuf')).toContain('🥚')
    expect(found('œuf')).toContain('🥚')
  })

  it('needs every word of the query, in any order', () => {
    expect(found('pomme terre')).toEqual(['🥔'])
    expect(found('terre pomme')).toEqual(['🥔'])
    expect(found('red apple')).toEqual(['🍎'])
    expect(found('coeur rouge')).toContain('❤️')
    expect(found('rouge coeur')).toEqual(found('coeur rouge'))
    expect(found('chat pomme')).toEqual([])
  })

  it('takes the start of a word, and the inside of a word only from three letters', () => {
    expect(found('footb')).toEqual(expect.arrayContaining(['⚽', '🏈']))
    expect(found('ball')).toEqual(expect.arrayContaining(['⚽', '🏀']))
    // "chart" holds "ar" but starts with no word that is "ar…": a short query is a start, not an inside.
    expect(searchEmojis('ar', 1000).map((e) => e.emoji)).not.toContain('📈')
    expect(found('art')).toContain('🎨')
  })

  it('puts the word itself first, then the words that start with it, then those that only contain it', () => {
    const hits = found('ice')
    const exact = ['🧊', '🍦', '⛸️'].map((emoji) => hits.indexOf(emoji))
    const starts = hits.indexOf(flag('IS'))
    const inside = hits.indexOf('🏢')
    expect(exact.every((index) => index >= 0)).toBe(true)
    expect(starts).toBeGreaterThan(Math.max(...exact))
    expect(inside).toBeGreaterThan(starts)
  })

  it('keeps the order of the catalogue between equals', () => {
    const order = ALL_EMOJIS.map((e) => e.emoji)
    // Those that have the very word "heart" are all equal: they come in the order of the catalogue.
    const itself = found('heart')
      .filter((emoji) => ALL_EMOJIS.find((e) => e.emoji === emoji)!.keywords.includes('heart'))
      .map((emoji) => order.indexOf(emoji))
    expect(itself.length).toBeGreaterThan(3)
    expect(itself).toEqual([...itself].sort((a, b) => a - b))
  })

  it('finds the emoji that is typed', () => {
    expect(found('🐱')).toEqual(['🐱'])
    expect(found('  🛠️ ')).toEqual(['🛠️'])
    expect(found(flag('FR'))).toEqual([flag('FR')])
  })

  it('finds a country by its name in both languages', () => {
    expect(firstOf('france')).toBe(flag('FR'))
    expect(found('japon')).toContain(flag('JP'))
    expect(found('germany')).toContain(flag('DE'))
    expect(found('suisse')).toContain(flag('CH'))
  })

  it('finds nothing for nothing: a blank query, punctuation, a word that is nowhere', () => {
    for (const query of ['', '   ', '\n', '?', '...', ',,;', 'zzzzqx', 'xyzzy plugh']) expect(searchEmojis(query), JSON.stringify(query)).toEqual([])
    for (const query of [undefined, null, 3, {}, [], ['chat']]) expect(searchEmojis(query as never)).toEqual([])
  })

  it('is not troubled by what a person might type: regular expression characters, the names of properties, a very long text', () => {
    for (const query of ['(', '[a-z]', '.*', '\\', '__proto__', 'constructor', 'toString', '${x}', '<script>']) expect(() => searchEmojis(query), query).not.toThrow()
    expect(searchEmojis('__proto__')).toEqual([])
    expect(searchEmojis('constructor')).toEqual([])
    const started = Date.now()
    expect(searchEmojis('chat '.repeat(2000)).length).toBeLessThanOrEqual(EMOJI_SEARCH_LIMIT)
    expect(searchEmojis('x'.repeat(100_000))).toEqual([])
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('answers at most as many as asked, 80 by default, and one at least', () => {
    expect(searchEmojis('e').length).toBe(EMOJI_SEARCH_LIMIT)
    expect(searchEmojis('e', 3)).toHaveLength(3)
    expect(searchEmojis('e', 0)).toHaveLength(1)
    expect(searchEmojis('e', -5)).toHaveLength(1)
    expect(searchEmojis('e', Number.NaN)).toHaveLength(EMOJI_SEARCH_LIMIT)
    expect(searchEmojis('e', 1e9).length).toBeLessThanOrEqual(1000)
    expect(searchEmojis('e', 1e9).length).toBeGreaterThan(EMOJI_SEARCH_LIMIT)
  })

  it('answers with the entries of the catalogue themselves, and leaves the catalogue as it was', () => {
    const before = JSON.stringify(ALL_EMOJIS)
    const hit = searchEmojis('chat')[0]!
    expect(ALL_EMOJIS).toContain(hit)
    searchEmojis('pizza')
    expect(JSON.stringify(ALL_EMOJIS)).toBe(before)
  })
})

describe('the emoji a space may keep', () => {
  it('accepts one emoji, in every form it comes in', () => {
    const valid: Array<[string, string]> = [
      ['a face', '😀'],
      ['a pictograph that needs its variation selector', '🛠️'],
      ['one that shows as an emoji without it', '⭐'],
      ['the same with a selector typed after it', `⭐${VS16}`],
      ['a heart', '❤️'],
      ['an aeroplane', '✈️'],
      ['a skin tone', '👍🏽'],
      ['a flag of a country', flag('FR')],
      ['another', flag('US')],
      ['the flag of the European Union', flag('EU')],
      ['the flag of England', tagFlag('gbeng')],
      ['the flag of Scotland', tagFlag('gbsct')],
      ['the flag of Wales', tagFlag('gbwls')],
      ['a keycap', `1${VS16}${KEYCAP}`],
      ['a keycap without the selector', `7${KEYCAP}`],
      ['another keycap', `#${VS16}${KEYCAP}`],
      ['a person at a computer', join('🧑', '💻')],
      ['a woman technologist', join('👩', '💻')],
      ['a family of four', join('👨', '👩', '👧', '👦')],
      ['the rainbow flag', join(`🏳${VS16}`, '🌈')],
      ['the same without its selector', join('🏳', '🌈')],
      ['the pirate flag', join('🏴', `☠${VS16}`)],
      ['a runner, a sign of the sex', join('🏃', `♂${VS16}`)],
      ['a skin tone inside a sequence', join('🧑🏽', '💻')],
      ['the longest sequence there is, kiss with two skin tones', join('👩🏽', `❤${VS16}`, '💋', '👨🏼')]
    ]
    for (const [what, value] of valid) expect(isSpaceEmoji(value), `${what} ${units(value)}`).toBe(true)
  })

  it('keeps the longest emoji inside the length the state already allows', () => {
    const longest = join('👩🏽', `❤${VS16}`, '💋', '👨🏼')
    expect(longest.length).toBe(15)
    expect(SPACE_EMOJI_MAX_UNITS).toBe(32)
    expect(longest.length).toBeLessThanOrEqual(SPACE_EMOJI_MAX_UNITS)
    expect(Math.max(...ALL_EMOJIS.map((e) => e.emoji.length))).toBeLessThanOrEqual(SPACE_EMOJI_MAX_UNITS)
  })

  it('refuses text: a word, a letter, a digit, a symbol that shows as text', () => {
    for (const value of ['', ' ', 'a', 'A', 'ab', 'Perso', 'Travail 💼', '💼 Travail', '1', '42', '#', '*', '©', '®', '™', '→', '✓', '♥', '❤', '☺', '✈', '☀', 'é', 'あ', '字', '٣', '$', '€']) {
      expect(isSpaceEmoji(value), `${JSON.stringify(value)} ${units(value)}`).toBe(false)
    }
  })

  it('refuses the text-style selector, which asks for the glyph and not the picture', () => {
    expect(isSpaceEmoji(`❤${VS15}`)).toBe(false)
    expect(isSpaceEmoji(`☺${VS15}`)).toBe(false)
    expect(isSpaceEmoji(`😀${VS15}`)).toBe(false)
    expect(isSpaceEmoji(VS16)).toBe(false)
    expect(isSpaceEmoji(`a${VS16}`)).toBe(false)
  })

  it('refuses several emoji, and anything around one: spaces, line breaks, text', () => {
    for (const value of ['😀😀', '😀 😀', '🚀🎨', ' 😀', '😀 ', '😀\n', '\t😀', '😀a', 'a😀', '😀.', `${flag('FR')}${flag('FR')}`, `😀${ZERO_WIDTH_SPACE}`, `${RTL_OVERRIDE}😀`, '\u0000😀']) {
      expect(isSpaceEmoji(value), `${JSON.stringify(value)} ${units(value)}`).toBe(false)
    }
  })

  it('refuses a joiner that joins nothing: at either end, doubled, or with something that is not a picture', () => {
    for (const value of [ZWJ, `😀${ZWJ}`, `${ZWJ}😀`, `👩${ZWJ}${ZWJ}💻`, `${ZWJ}${ZWJ}`, `a${ZWJ}😀`, `1${ZWJ}😀`, `😀${ZWJ}a`, `😀${ZWNJ}😀`, `©${ZWJ}©`, `☺${ZWJ}☺`, `${ZWJ}${VS16}`]) {
      expect(isSpaceEmoji(value), `${JSON.stringify(value)} ${units(value)}`).toBe(false)
    }
  })

  it('refuses a chain that is too long to be one picture', () => {
    expect(isSpaceEmoji(join('👩', '👩', '👩', '👩', '👩'))).toBe(true)
    expect(isSpaceEmoji(join('👩', '👩', '👩', '👩', '👩', '👩'))).toBe(false)
    expect(isSpaceEmoji('😀'.repeat(20))).toBe(false)
    expect(isSpaceEmoji(`😀${'x'.repeat(40)}`)).toBe(false)
    expect(isSpaceEmoji(`😀${VS16.repeat(40)}`)).toBe(false)
    expect(isSpaceEmoji(join(...Array.from({ length: 16 }, () => '👩')))).toBe(false)
  })

  it('refuses a flag that is no flag: one letter, three, a pair that is no region, a made-up tagged flag, an unfinished one', () => {
    expect(isSpaceEmoji('\u{1F1EB}')).toBe(false)
    expect(isSpaceEmoji(`${flag('FR')}\u{1F1EB}`)).toBe(false)
    expect(isSpaceEmoji(flag('AA'))).toBe(false)
    expect(isSpaceEmoji(flag('QQ'))).toBe(false)
    expect(isSpaceEmoji(flag('XX'))).toBe(false)
    expect(isSpaceEmoji(tagFlag('gbxxx'))).toBe(false)
    expect(isSpaceEmoji(tagFlag('fr'))).toBe(false)
    expect(isSpaceEmoji(tagFlag('gbeng').slice(0, -2))).toBe(false)
    expect(isSpaceEmoji(`${tagFlag('gbeng')}${tagFlag('gbwls')}`)).toBe(false)
  })

  it('refuses a skin tone where there is nothing to colour, and a bare one', () => {
    expect(isSpaceEmoji('\u{1F3FD}')).toBe(false)
    expect(isSpaceEmoji('😀🏽')).toBe(false)
    expect(isSpaceEmoji('👍🏽🏽')).toBe(false)
    expect(isSpaceEmoji(`🏽👍`)).toBe(false)
  })

  it('refuses a mark that combines, which would dress the emoji with a letter\'s accent', () => {
    expect(isSpaceEmoji(`😀${COMBINING_ACUTE}`)).toBe(false)
    expect(isSpaceEmoji(`e${COMBINING_ACUTE}`)).toBe(false)
    expect(isSpaceEmoji(`❤${VS16}${COMBINING_ACUTE}`)).toBe(false)
  })

  it('refuses what is not a string, without throwing', () => {
    for (const value of [undefined, null, 0, 1, true, {}, [], ['😀'], { emoji: '😀' }, () => '😀', Symbol('x'), 10n]) expect(isSpaceEmoji(value), String(typeof value)).toBe(false)
  })
})

describe('the letter or the digit a space may keep instead of an emoji', () => {
  it('accepts one letter of any alphabet, or one digit', () => {
    for (const value of ['a', 'Z', 'é', 'ß', 'Ω', 'я', 'あ', '字', '0', '7', '٣']) expect(isSpaceLetter(value), JSON.stringify(value)).toBe(true)
    for (const value of ['a', '7', '😀', '🇫🇷']) expect(isSpaceMark(value), value).toBe(true)
  })

  it('refuses two characters, a symbol, a space, and a letter that draws nothing', () => {
    for (const value of ['', ' ', 'ab', '42', 'a1', 'a ', ' a', '#', '-', '.', '€', '©', '→', `a${VS16}`, `a${ZERO_WIDTH_SPACE}`, `${RTL_OVERRIDE}a`, ZERO_WIDTH_SPACE, '\u{115F}', '\u{3164}', 'a\u0301\u0301\u0301\u0301', 7, null, undefined, ['a']]) {
      expect(isSpaceLetter(value), JSON.stringify(value)).toBe(false)
      expect(isSpaceMark(value), JSON.stringify(value)).toBe(false)
    }
  })

  it('keeps a letter written with its accent apart as the one letter it draws, and gives the fallback for the rest', () => {
    expect(isSpaceLetter('e\u0301')).toBe(true)
    expect(spaceEmojiOr('e\u0301', '✨')).toBe('\u00E9')
    expect(spaceEmojiOr('B', '✨')).toBe('B')
    expect(spaceEmojiOr('5', '✨')).toBe('5')
    expect(spaceEmojiOr('😀', '✨')).toBe('😀')
    for (const bad of ['Bo', '55', '😀😀', 'a😀', '', 5, null]) expect(spaceEmojiOr(bad, '✨'), String(bad)).toBe('✨')
  })
})
