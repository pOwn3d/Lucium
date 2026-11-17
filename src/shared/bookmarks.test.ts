import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { frenchSpaces } from './french-typography'
import { parseBookmarksTransferRequest, bookmarkAddressProblem, bookmarkImportSummary, bookmarkKey, bookmarkNotice, bookmarkOutcome, bookmarkOf, cleanBookmarks, cleanTag, cleanTags, filterBookmarks, mergeBookmarks, parseTagInput, removeTag, renameTag, tagCounts, BOOKMARK_IMPORT_SCAN_MAX } from './bookmarks'
import { BOOKMARKS_LIMIT, BOOKMARK_NOTE_MAX, BOOKMARK_TAGS_MAX, BOOKMARK_TAG_MAX, BOOKMARK_TITLE_MAX, BOOKMARK_URL_MAX, type Bookmark, type TabItem } from './model'
import type { Ctx } from './sidebar'
import { setLanguage } from './i18n'

const ctx = (now = 1_700_000_000_000): Ctx => {
  let n = 0
  return { now, newId: () => `n${++n}` }
}
const bm = (n: number, over: Partial<Bookmark> = {}): Bookmark => ({ id: `b${n}`, url: `https://site${n}.example/page`, title: `Page ${n}`, tags: [], addedAt: n, ...over })
const tab = (url: string, over: Partial<TabItem> = {}): TabItem => ({ id: 't1', spaceId: 's1', url, title: 'Titre', pinned: false, createdAt: 1, lastActiveAt: 1, ...over })

describe('tags', () => {
  it('keeps a tag as a short printable word: no comma, no leading #, no control character, spaces collapsed', () => {
    expect(cleanTag('  #Lecture  ')).toBe('Lecture')
    expect(cleanTag('à  voir\n\tplus tard')).toBe('à voir plus tard')
    expect(cleanTag('a,b;c')).toBe('a b c')
    expect(cleanTag('x\u0000y\u001b[31m')).toBe('x y [31m')
    expect(cleanTag('a'.repeat(BOOKMARK_TAG_MAX + 30))).toHaveLength(BOOKMARK_TAG_MAX)
  })

  it('refuses what is no tag: blank, only "#", not a text', () => {
    for (const bad of ['', '   ', '#', '###', ',;,', 7, null, undefined, {}, ['a']]) expect(cleanTag(bad), String(bad)).toBeNull()
  })

  it('cuts a tag on characters, never in the middle of an emoji', () => {
    const tag = cleanTag('🚀'.repeat(BOOKMARK_TAG_MAX + 5))!
    expect(Array.from(tag)).toHaveLength(BOOKMARK_TAG_MAX)
    expect(tag).not.toMatch(/\ud83d$/)
  })

  it('keeps each tag once whatever its case or accents, the first spelling winning, and at most BOOKMARK_TAGS_MAX', () => {
    expect(cleanTags(['Été', 'ete', 'ÉTÉ', 'Autre'])).toEqual(['Été', 'Autre'])
    const many = Array.from({ length: BOOKMARK_TAGS_MAX + 20 }, (_, i) => `t${i}`)
    expect(cleanTags(many)).toHaveLength(BOOKMARK_TAGS_MAX)
  })

  it('reads a list that is not one as no tags, and skips the entries that are not tags', () => {
    for (const raw of [undefined, null, 'a,b', 5, { 0: 'a' }]) expect(cleanTags(raw), String(raw)).toEqual([])
    expect(cleanTags([1, null, 'ok', '', {}, 'ok2'])).toEqual(['ok', 'ok2'])
  })

  it('splits what a person typed on commas only, so that a tag may hold spaces', () => {
    expect(parseTagInput('à lire, #recettes de cuisine ,, outils')).toEqual(['à lire', 'recettes de cuisine', 'outils'])
    expect(parseTagInput('')).toEqual([])
  })
})

describe('the library of a file', () => {
  it('keeps good bookmarks as they are, with their tags, note and icon', () => {
    const entry: Bookmark = { id: 'a', url: 'https://a.example/p', title: 'A', tags: ['x', 'y z'], note: 'Une note', faviconUrl: 'https://a.example/i.png', addedAt: 3 }
    expect(cleanBookmarks([entry])).toEqual([entry])
  })

  it('is empty when the file has no list or something else than a list', () => {
    for (const raw of [undefined, null, 'texte', 7, {}, true, [], [null, 3, 'x', []]]) expect(cleanBookmarks(raw), String(raw)).toEqual([])
  })

  it('drops what is not a web page, and an address too long to be kept whole', () => {
    const bad = ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'about:blank', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/p.html', 'ftp://a.example/', 'not a url', '', 7, null, `https://long.example/${'a'.repeat(BOOKMARK_URL_MAX)}`]
    const out = cleanBookmarks([...bad.map((url, i) => ({ id: `bad${i}`, url, title: 'x', addedAt: 1 })), bm(9)])
    expect(out.map((b) => b.id)).toEqual(['b9'])
  })

  it('keeps the first of several entries sharing an id or a page (the same page spelled two ways is one)', () => {
    const out = cleanBookmarks([bm(1), bm(2, { id: 'b1' }), bm(3, { url: 'HTTPS://SITE1.EXAMPLE/page' }), bm(4)])
    expect(out.map((b) => b.id)).toEqual(['b1', 'b4'])
  })

  it('repairs the fields instead of losing the bookmark: a title from the address, bounded texts, clean tags, an icon only if it is one', () => {
    const [out] = cleanBookmarks([{ id: 'a', url: 'https://www.exemple.fr/x', title: '\u0000  ', tags: ['A', 'a', 3], note: 'n'.repeat(BOOKMARK_NOTE_MAX + 50), faviconUrl: 'javascript:alert(1)', addedAt: 'hier' }])
    expect(out).toEqual({ id: 'a', url: 'https://www.exemple.fr/x', title: 'exemple.fr', tags: ['A'], note: 'n'.repeat(BOOKMARK_NOTE_MAX), addedAt: 0 })
    const [long] = cleanBookmarks([{ id: 'b', url: 'https://a.example/', title: 't'.repeat(BOOKMARK_TITLE_MAX + 10) }])
    expect(long!.title).toHaveLength(BOOKMARK_TITLE_MAX)
  })

  it('keeps at most BOOKMARKS_LIMIT', () => {
    const many = Array.from({ length: BOOKMARKS_LIMIT + 25 }, (_, i) => bm(i + 1))
    expect(cleanBookmarks(many)).toHaveLength(BOOKMARKS_LIMIT)
  })
})

describe('saving a tab', () => {
  it('says what saving does: saved, already there (in any spelling), full, or not a web page', () => {
    expect(bookmarkOutcome([], tab('https://a.example/'))).toBe('saved')
    expect(bookmarkOutcome([bm(1, { url: 'https://a.example/' })], tab('https://A.example'))).toBe('already')
    expect(bookmarkOutcome(Array.from({ length: BOOKMARKS_LIMIT }, (_, i) => bm(i)), tab('https://new.example/'))).toBe('full')
    for (const url of ['about:blank', 'file:///x', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/a.html', 'javascript:1']) expect(bookmarkOutcome([], tab(url)), url).toBe('unsupported')
  })

  it('makes the bookmark of a tab with the name the user gave it, its icon and the time, and none for what is not a page', () => {
    const made = bookmarkOf(tab('https://a.example/', { title: 'Page', customTitle: 'Mon nom', faviconUrl: 'https://a.example/i.png' }), ctx(42))
    expect(made).toEqual({ id: 'n1', url: 'https://a.example/', title: 'Mon nom', tags: [], faviconUrl: 'https://a.example/i.png', addedAt: 42 })
    expect(bookmarkOf(tab('about:blank'), ctx())).toBeNull()
  })

  it('has a sentence for every outcome', () => {
    // Each outcome its own sentence: a notice that says "already there" after a page was saved would mislead.
    expect((['saved', 'already', 'unsupported'] as const).map(bookmarkNotice)).toEqual(['Ajouté aux signets', 'Déjà dans les signets', 'Seules les pages web peuvent devenir des signets'])
    expect(bookmarkNotice('full')).toContain('5')
  })
})

describe('searching', () => {
  const list = [
    bm(1, { title: 'Recette de tarte', tags: ['cuisine', 'Été'], url: 'https://cuisine.example/tarte' }),
    bm(2, { title: 'Documentation Electron', tags: ['dev'], note: 'à relire' }),
    bm(3, { title: 'Autre', tags: ['cuisine', 'dev'] })
  ]

  it('finds every word, in the title, address, note or tags, without case or accents', () => {
    expect(filterBookmarks(list, 'tarte').map((b) => b.id)).toEqual(['b1'])
    expect(filterBookmarks(list, 'TARTE cuisine').map((b) => b.id)).toEqual(['b1'])
    expect(filterBookmarks(list, 'releire')).toEqual([])
    expect(filterBookmarks(list, 'a relire').map((b) => b.id)).toEqual(['b2'])
    expect(filterBookmarks(list, 'ete').map((b) => b.id)).toEqual(['b1'])
  })

  it('treats a word that starts with # as a tag, its beginning being enough', () => {
    expect(filterBookmarks(list, '#cui').map((b) => b.id)).toEqual(['b1', 'b3'])
    expect(filterBookmarks(list, '#cuisine #dev').map((b) => b.id)).toEqual(['b3'])
    expect(filterBookmarks(list, '#').length).toBe(3)
    expect(filterBookmarks(list, '#tarte')).toEqual([])
  })

  it('keeps the bookmarks that carry all the tags chosen in the panel', () => {
    expect(filterBookmarks(list, '', ['dev']).map((b) => b.id)).toEqual(['b2', 'b3'])
    expect(filterBookmarks(list, '', ['DEV', 'cuisine']).map((b) => b.id)).toEqual(['b3'])
    expect(filterBookmarks(list, 'electron', ['cuisine'])).toEqual([])
  })

  it('gives everything for an empty search and a copy, not the same array', () => {
    const all = filterBookmarks(list, '  ')
    expect(all).toEqual(list)
    expect(all).not.toBe(list)
  })
})

describe('tags of the library', () => {
  const list = [bm(1, { tags: ['Cuisine', 'dev'] }), bm(2, { tags: ['dev'] }), bm(3, { tags: ['cuisine'] }), bm(4, { tags: ['Zèbre'] })]

  it('counts the tags in use, the most used first, spelled as the first bookmark spells them', () => {
    expect(tagCounts(list)).toEqual([
      { tag: 'Cuisine', count: 2 },
      { tag: 'dev', count: 2 },
      { tag: 'Zèbre', count: 1 }
    ])
  })

  it('renames a tag on every bookmark, merging it into the target where a bookmark has both, and changes nothing for an unknown tag or a bad name', () => {
    const renamed = renameTag(list, 'cuisine', 'Recettes')
    expect(renamed.map((b) => b.tags)).toEqual([['Recettes', 'dev'], ['dev'], ['Recettes'], ['Zèbre']])
    expect(renameTag(list, 'dev', 'cuisine')[0]!.tags).toEqual(['Cuisine'])
    expect(renameTag(list, 'inconnu', 'x')).toBe(list)
    expect(renameTag(list, 'dev', '   ')).toBe(list)
    // The same spelling changes nothing; another case is a change of spelling, which is allowed.
    expect(renameTag(list, 'dev', 'dev')).toBe(list)
    expect(renameTag(list, 'dev', 'DEV')[1]!.tags).toEqual(['DEV'])
  })

  it('takes a tag off every bookmark and keeps the bookmarks', () => {
    const stripped = removeTag(list, 'DEV')
    expect(stripped.map((b) => b.tags)).toEqual([['Cuisine'], [], ['cuisine'], ['Zèbre']])
    expect(removeTag(list, 'inconnu')).toBe(list)
  })
})

describe('importing entries', () => {
  it('adds each valid entry after the existing ones, in the order of the file, with its tags and the date of the file', () => {
    const existing = [bm(1)]
    const merge = mergeBookmarks(existing, [{ url: 'https://a.example/', title: 'A', tags: ['x'], addedAt: 1_600_000_000 }, { url: 'https://b.example/' }], ctx())
    expect(merge.list.map((b) => b.url)).toEqual(['https://site1.example/page', 'https://a.example/', 'https://b.example/'])
    expect(merge.list[1]).toMatchObject({ title: 'A', tags: ['x'], addedAt: 1_600_000_000_000 })
    expect(merge.list[2]).toMatchObject({ title: 'b.example', addedAt: 1_700_000_000_000 })
    expect(merge).toMatchObject({ added: 2, merged: 0, already: 0, skipped: 0, overLimit: 0 })
    expect(existing).toHaveLength(1)
  })

  it('only gives a page already there the tags it lacked, and counts the others as already there', () => {
    const merge = mergeBookmarks([bm(1, { tags: ['a'] })], [{ url: 'HTTPS://SITE1.example/page', tags: ['A', 'b'] }, { url: 'https://site1.example/page', tags: ['a'] }], ctx())
    expect(merge.list).toHaveLength(1)
    expect(merge.list[0]!.tags).toEqual(['a', 'b'])
    expect(merge).toMatchObject({ added: 0, merged: 1, already: 1 })
  })

  it('leaves aside what is not a web page, whatever the file says, and what is not an entry at all', () => {
    const merge = mergeBookmarks([], [{ url: 'javascript:alert(1)' }, { url: 'data:text/html,x' }, { url: 'file:///etc/passwd' }, { url: 7 }, null as never, 'texte' as never, { url: `https://a.example/${'x'.repeat(BOOKMARK_URL_MAX)}` }, { url: 'https://ok.example/' }], ctx())
    expect(merge.list.map((b) => b.url)).toEqual(['https://ok.example/'])
    expect(merge.skipped).toBe(7)
  })

  it('stops at the limit of the library without losing or reordering what is there, and counts what it refused', () => {
    const full = Array.from({ length: BOOKMARKS_LIMIT - 2 }, (_, i) => bm(i + 1))
    const merge = mergeBookmarks(full, Array.from({ length: 5 }, (_, i) => ({ url: `https://new${i}.example/` })), ctx())
    expect(merge.list).toHaveLength(BOOKMARKS_LIMIT)
    expect(merge.list.slice(0, full.length)).toEqual(full)
    expect(merge).toMatchObject({ added: 2, overLimit: 3 })
  })

  it('reads no more than BOOKMARK_IMPORT_SCAN_MAX entries of a file, however many it holds', () => {
    const entries = Array.from({ length: BOOKMARK_IMPORT_SCAN_MAX + 1000 }, (_, i) => ({ url: i % 2 === 0 ? 'javascript:void(0)' : `https://x${i}.example/` }))
    const merge = mergeBookmarks([], entries, ctx())
    expect(merge.added + merge.skipped + merge.overLimit).toBe(BOOKMARK_IMPORT_SCAN_MAX)
  })

  it('takes a date from the file only if it is a date in the past, else the moment of the import', () => {
    const now = 1_700_000_000_000
    const dates = [NaN, Infinity, -5, 0, '1600000000', 4_000_000_000, 1_600_000_000]
    const merge = mergeBookmarks([], dates.map((addedAt, i) => ({ url: `https://d${i}.example/`, addedAt })), ctx(now))
    expect(merge.list.map((b) => b.addedAt)).toEqual([now, now, now, now, now, now, 1_600_000_000_000])
  })

  it('gives ids of its own: the file never names one', () => {
    const merge = mergeBookmarks([], [{ url: 'https://a.example/', id: '__proto__' } as never], ctx())
    expect(merge.list[0]!.id).toBe('n1')
  })
})

describe('the address a bookmark is given when it is edited', () => {
  const library = [bm(1), bm(2)]

  it('is accepted when it is a web page no other bookmark has, its own address included', () => {
    expect(bookmarkAddressProblem(library, 'b1', 'https://nouveau.example/')).toBeNull()
    expect(bookmarkAddressProblem(library, 'b1', library[0]!.url)).toBeNull()
  })

  it('is refused with the reason when it is not a web page', () => {
    for (const url of ['', 'pas une adresse', 'javascript:alert(1)', 'file:///etc/passwd', `https://long.example/${'a'.repeat(BOOKMARK_URL_MAX)}`, 5, undefined]) {
      expect(bookmarkAddressProblem(library, 'b1', url), String(url).slice(0, 40)).toBe(frenchSpaces('Cette adresse n’est pas celle d’une page web : le signet n’a pas été modifié.'))
    }
  })

  it('is refused with the reason when another bookmark has it, however it is written', () => {
    expect(bookmarkAddressProblem(library, 'b1', library[1]!.url)).toBe(frenchSpaces('Un autre signet a déjà cette adresse : le signet n’a pas été modifié.'))
    expect(bookmarkAddressProblem(library, 'b1', 'HTTPS://SITE2.example/page')).not.toBeNull()
  })

  it('is asked by the form before it closes: a refused address keeps the form open with the reason, instead of dropping what was typed', () => {
    const source = readFileSync(fileURLToPath(new URL('../renderer/Bookmarks.tsx', import.meta.url)), 'utf8')
    const save = source.slice(source.indexOf('const saveDraft = () => {'), source.indexOf('const transfer ='))
    // Each line is looked for first: a line that is gone answers -1, which every place is after.
    const asked = save.indexOf('const problem = bookmarkAddressProblem(list, draft.id, draft.url.trim())')
    const kept = save.indexOf('if (problem !== null) return setDraft({ ...draft, problem })')
    const sent = save.indexOf("type: 'bookmark/edit'")
    expect([asked, kept, sent].every((at) => at >= 0)).toBe(true)
    expect(kept).toBeGreaterThan(asked)
    expect(sent).toBeGreaterThan(kept)
  })
})

describe('the sentences', () => {
  it('says what an import did, and what it left out', () => {
    expect(bookmarkImportSummary({ added: 3, merged: 1, already: 2, skipped: 4, overLimit: 5 }, true)).toMatch(/3 signets ajoutés.*1 signet déjà présent a reçu.*2 déjà présents.*4 éléments laissés de côté.*5 signets refusés.*fin n’a pas été lue/)
    expect(bookmarkImportSummary({ added: 1, merged: 0, already: 0, skipped: 0, overLimit: 0 })).toBe('1 signet ajouté.')
  })

  it('says it in English with the plurals, the separators and the digits of English', () => {
    setLanguage('en')
    try {
      expect(bookmarkImportSummary({ added: 1200, merged: 1, already: 2, skipped: 1, overLimit: 0 }, true)).toBe(
        '1,200 bookmarks added; 1 bookmark already there received new tags; 2 already there; 1 item left out (neither a web page nor an acceptable address); the file is longer than the reading limit: its end was not read.'
      )
      expect(bookmarkImportSummary({ added: 0, merged: 0, already: 0, skipped: 0, overLimit: 3 })).toBe(`0 bookmarks added; 3 bookmarks rejected: the library is limited to ${BOOKMARKS_LIMIT.toLocaleString('en-US')}.`)
      expect(bookmarkNotice('full')).toBe(`The bookmark library is full (${BOOKMARKS_LIMIT.toLocaleString('en-US')} bookmarks)`)
    } finally {
      setLanguage('fr')
    }
    // French counts zero as one, as the code it replaced did.
    expect(bookmarkImportSummary({ added: 0, merged: 0, already: 0, skipped: 0, overLimit: 0 })).toBe('0 signet ajouté.')
  })

  it('compares addresses as the URL parser prints them', () => {
    expect(bookmarkKey('https://Exemple.fr')).toBe('https://exemple.fr/')
    expect(bookmarkKey('pas une adresse')).toBe('pas une adresse')
  })
})

describe('the request of the panel for the file of bookmarks', () => {
  it('is exactly "import" or "export", and carries no path', () => {
    expect(parseBookmarksTransferRequest({ op: 'import' })).toEqual({ op: 'import' })
    expect(parseBookmarksTransferRequest({ op: 'export', path: '/etc/passwd', text: 'x' })).toEqual({ op: 'export' })
    for (const bad of [null, undefined, 'import', 7, [], ['import'], {}, { op: 'IMPORT' }, { op: '/etc/passwd' }, { op: ['import'] }, { op: 7 }]) expect(parseBookmarksTransferRequest(bad), JSON.stringify(bad)).toBeNull()
  })
})
