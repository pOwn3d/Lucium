// The cleaners of a saved state, read on their own: what they refuse at launch and what they keep when a file is too long.
// Each test names the guard it protects; state-robustness.test.ts covers the whole path (normalize), this file covers the rules themselves.
import { describe, expect, it } from 'vitest'
import { EXTENSION_PATHS_MAX, LINK_ROUTES_MAX, cleanCommandBarUsage, cleanExtensionPaths, cleanLinkRoutes, cleanSpaces, cleanSplits } from './state-clean'
import { PRIVATE_SPACE_EMOJI } from './private-window'
import { SPLIT_MAX_PANES } from './split'

describe('the folders of unpacked extensions loaded at launch', () => {
  it('keeps only absolute paths, without control characters, each once', () => {
    const kept = cleanExtensionPaths(['/bon/chemin', 'relatif/chemin', 'C:\\ext\\une', 42, '/avec\u0000nul', '/bon/chemin', '', '/ligne\nnouvelle'])
    expect(kept).toEqual(['/bon/chemin', 'C:\\ext\\une'])
  })

  it('refuses a path longer than 1024 characters', () => {
    expect(cleanExtensionPaths(['/' + 'a'.repeat(1024)])).toEqual([])
    expect(cleanExtensionPaths(['/' + 'a'.repeat(1023)])).toHaveLength(1)
  })

  it('keeps at most EXTENSION_PATHS_MAX paths, the first ones', () => {
    const many = Array.from({ length: EXTENSION_PATHS_MAX + 20 }, (_, i) => `/ext/${i}`)
    const kept = cleanExtensionPaths(many)
    expect(kept).toHaveLength(EXTENSION_PATHS_MAX)
    expect(kept[0]).toBe('/ext/0')
  })
})

describe('the rules sending links to a space', () => {
  it('refuses a host with a space, an empty host, a host over 253 characters, and a missing space', () => {
    const routes = cleanLinkRoutes([
      { host: 'github.com', spaceId: 'sp-work' },
      { host: 'a b.com', spaceId: 'sp-work' },
      { host: '', spaceId: 'sp-work' },
      { host: 'x'.repeat(254), spaceId: 'sp-work' },
      { host: 'sans-espace.org' },
      { host: 'ok.org', spaceId: '' },
    ])
    expect(routes).toEqual([{ host: 'github.com', spaceId: 'sp-work' }])
  })

  it('keeps a host of exactly 253 characters, and refuses one that holds a control character', () => {
    const longest = 'x'.repeat(253)
    expect(cleanLinkRoutes([{ host: longest, spaceId: 'sp-work' }, { host: 'git\u0000hub.com', spaceId: 'sp-work' }, { host: 'git\u007fhub.com', spaceId: 'sp-work' }])).toEqual([{ host: longest, spaceId: 'sp-work' }])
  })

  it('keeps at most LINK_ROUTES_MAX rules', () => {
    const many = Array.from({ length: LINK_ROUTES_MAX + 5 }, (_, i) => ({ host: `h${i}.example`, spaceId: 'sp' }))
    expect(cleanLinkRoutes(many)).toHaveLength(LINK_ROUTES_MAX)
  })
})

describe('the command bar usage', () => {
  it('drops a key of more than 400 characters and a count that is not a positive number', () => {
    const usage = cleanCommandBarUsage({ work: { ['url:' + 'a'.repeat(400)]: 3, ['url:' + 'a'.repeat(395)]: 2, 'url:zero': 0, 'url:neg': -1, 'url:nan': Number.NaN, 'url:ok': 4 } }, 300)
    expect(Object.keys(usage)).toEqual(['work'])
    expect(Object.keys(usage['work']!).sort()).toEqual(['url:' + 'a'.repeat(395), 'url:ok'].sort())
    // At the limit itself: 400 characters are kept, 401 are not.
    const atLimit = 'url:' + 'a'.repeat(396)
    expect(cleanCommandBarUsage({ work: { [atLimit]: 1, [atLimit + 'a']: 1 } }, 300)).toEqual({ work: { [atLimit]: 1 } })
  })

  it('keeps only the most used keys when there are more than the limit', () => {
    const usage = cleanCommandBarUsage({ work: { 'url:a': 1, 'url:b': 9, 'url:c': 5, 'url:d': 7 }, home: { 'url:e': 1, 'url:f': 2, 'url:g': 3 } }, 2)
    expect(usage).toEqual({ work: { 'url:b': 9, 'url:d': 7 }, home: { 'url:f': 2, 'url:g': 3 } })
  })
})

describe('the splits read from a file', () => {
  const split = (ratios: unknown, count = 2) => ({
    id: 'sv-1',
    spaceId: 'sp-1',
    tabIds: Array.from({ length: count }, (_, i) => `t-${i}`),
    orientation: 'horizontal',
    ratios,
  })

  it('replaces ratios that do not add up to 1, or that are under the minimum, by equal shares', () => {
    expect(cleanSplits([split([0.3, 0.3])])[0]?.ratios).toEqual([0.5, 0.5])
    expect(cleanSplits([split([0.05, 0.95])])[0]?.ratios).toEqual([0.5, 0.5])
    expect(cleanSplits([split([0.4])])[0]?.ratios).toEqual([0.5, 0.5])
    expect(cleanSplits([split([0.4, 0.6])])[0]?.ratios).toEqual([0.4, 0.6])
  })

  it('keeps at most SPLIT_MAX_PANES panes', () => {
    const [kept] = cleanSplits([split(undefined, SPLIT_MAX_PANES + 2)])
    expect(kept?.tabIds).toHaveLength(SPLIT_MAX_PANES)
    expect(kept?.ratios).toHaveLength(SPLIT_MAX_PANES)
  })
})

describe('the emoji of a space read from a file', () => {
  const emojiOf = (emoji: unknown): string => cleanSpaces([{ id: 's1', name: 'Travail', emoji }])[0]!.emoji

  it('is kept when it is one emoji: a pictograph, a flag, people joined, the one of a private window', () => {
    // With the ones the application gives by itself: a new space of the command bar, a folder made a space, the space of an import.
    for (const emoji of ['💼', '🇫🇷', '👨‍👩‍👧‍👦', '🚀', '🎨', '📚', '🛠️', '🌱', '🎧', '💡', '🧪', '📁', '🔖', '🌐', '🧭', '🦊', '✨', PRIVATE_SPACE_EMOJI]) expect(emojiOf(emoji), emoji).toBe(emoji)
  })

  it('is ✨ for anything else: a file edited by hand must not put text in a box drawn for one glyph', () => {
    for (const bad of ['x'.repeat(32), 'Travail', 'ab', '10', '!', '💼💼', ' 💼', '', 5, null, undefined]) expect(emojiOf(bad), String(bad)).toBe('✨')
    // One letter or one digit fits the box as one emoji does.
    for (const mark of ['a', 'Ω', '9']) expect(emojiOf(mark), mark).toBe(mark)
  })
})
