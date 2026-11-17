import { describe, expect, it } from 'vitest'
import type { PageWatch } from './model'
import { setLanguage } from './i18n'
import {
  pageWatchChoices,
  PAGE_WATCH_DEFAULT_MINUTES,
  PAGE_WATCH_MAX,
  PAGE_WATCH_MAX_MINUTES,
  PAGE_WATCH_MIN_MINUTES,
  PAGE_WATCH_TEXT_MAX,
  addWatch,
  afterFailure,
  afterLook,
  changeNotice,
  cleanPageWatches,
  cleanWatchMinutes,
  dueAt,
  fingerprint,
  isWatchableUrl,
  judgeLook,
  nextDue,
  nextWakeAt,
  normalizeWatchText,
  watchIntervalLabel,
  watchStatus
} from './page-watch'
import { frenchSpaces } from './french-typography'

const MIN = 60_000
const watch = (id: string, over: Partial<PageWatch> = {}): PageWatch => ({ id, url: `https://example.org/${id}`, title: `Page ${id}`, profileId: 'default', minutes: 60, ...over })

describe('which pages can be watched', () => {
  it('are web pages: http and https, and nothing else (a file or an extension page would be read on a timer)', () => {
    expect(isWatchableUrl('https://example.org/prix')).toBe(true)
    expect(isWatchableUrl('http://localhost:3000/')).toBe(true)
    for (const url of ['file:///etc/passwd', 'chrome-extension://abc/page.html', 'javascript:alert(1)', 'data:text/html,hi', 'about:blank', 'view-source:https://example.org/', 'ftp://example.org/', 'example.org', '', 'https://', `https://example.org/${'a'.repeat(2100)}`, 'https://example.org/\u0000', 42, null, undefined]) {
      expect(isWatchableUrl(url), String(url)).toBe(false)
    }
  })
})

describe('the interval', () => {
  it('is at least 5 minutes, at most a week, and whole', () => {
    expect(PAGE_WATCH_MIN_MINUTES).toBe(5)
    expect(cleanWatchMinutes(1)).toBe(5)
    expect(cleanWatchMinutes(0)).toBe(5)
    expect(cleanWatchMinutes(-30)).toBe(5)
    expect(cleanWatchMinutes(5)).toBe(5)
    expect(cleanWatchMinutes(7.6)).toBe(8)
    expect(cleanWatchMinutes(60)).toBe(60)
    expect(cleanWatchMinutes(PAGE_WATCH_MAX_MINUTES + 1)).toBe(PAGE_WATCH_MAX_MINUTES)
    expect(cleanWatchMinutes(Number.POSITIVE_INFINITY)).toBe(PAGE_WATCH_DEFAULT_MINUTES)
  })

  it('is the default for something that is not a number', () => {
    for (const value of [undefined, null, 'soixante', Number.NaN, {}, [], true]) expect(cleanWatchMinutes(value)).toBe(PAGE_WATCH_DEFAULT_MINUTES)
  })

  it('is offered in choices that all respect the minimum', () => {
    expect(pageWatchChoices().every(([minutes]) => minutes >= PAGE_WATCH_MIN_MINUTES)).toBe(true)
    expect(pageWatchChoices().some(([minutes]) => minutes === PAGE_WATCH_DEFAULT_MINUTES)).toBe(true)
  })

  it('is said in minutes, hours or days', () => {
    expect(watchIntervalLabel(5)).toBe(frenchSpaces('5 min'))
    expect(watchIntervalLabel(90)).toBe(frenchSpaces('90 min'))
    expect(watchIntervalLabel(120)).toBe(frenchSpaces('2 h'))
    expect(watchIntervalLabel(1440)).toBe(frenchSpaces('1 j'))
    expect(watchIntervalLabel(2880)).toBe(frenchSpaces('2 j'))
  })
})

describe('the watches of a saved file', () => {
  it('keep what is well formed', () => {
    const good = watch('a', { selector: '#price', hash: '0123456789abcdef', checkedAt: 5, changedAt: 4, failure: 'La page a planté.' })
    expect(cleanPageWatches([good])).toEqual([good])
  })

  it('lose one bad entry and not the others', () => {
    const list = cleanPageWatches([watch('a'), null, 3, 'x', [], { id: 'b' }, { ...watch('c'), url: 'file:///etc/hosts' }, { ...watch('d'), profileId: '../x' }, { ...watch('e'), id: '' }, { ...watch('f'), id: '__proto__' }, watch('g')])
    expect(list.map((w) => w.id)).toEqual(['a', 'g'])
  })

  it('keep an id once', () => {
    expect(cleanPageWatches([watch('a'), { ...watch('a'), title: 'Autre' }]).map((w) => w.title)).toEqual(['Page a'])
  })

  it('stop at the most that can be watched (the cost of the looks is bounded by this)', () => {
    const many = Array.from({ length: PAGE_WATCH_MAX + 7 }, (_, i) => watch(`w${i}`))
    expect(cleanPageWatches(many)).toHaveLength(PAGE_WATCH_MAX)
  })

  it('repair the interval, drop a fingerprint that is not one, a selector that is not text, and a date that is not a date', () => {
    const [cleaned] = cleanPageWatches([{ ...watch('a'), minutes: 1, hash: 'not-a-hash', selector: 42, checkedAt: -3, changedAt: Number.NaN, failure: 7 }])
    expect(cleaned).toEqual(watch('a', { minutes: PAGE_WATCH_MIN_MINUTES }))
    expect(Object.keys(cleaned!).sort()).toEqual(['id', 'minutes', 'profileId', 'title', 'url'])
  })

  it('name a page by its host when it has no title, and cut a long title', () => {
    expect(cleanPageWatches([{ ...watch('a'), title: '   ' }])[0]!.title).toBe('example.org')
    expect(cleanPageWatches([{ ...watch('a'), title: 'x'.repeat(500) }])[0]!.title).toHaveLength(200)
    expect(cleanPageWatches([{ ...watch('a'), title: 'a\nb\u0000c' }])[0]!.title).toBe('a b c')
  })

  it('are no list at all when the file holds anything else', () => {
    for (const raw of [undefined, null, 'x', 3, {}, { length: 2 }]) expect(cleanPageWatches(raw)).toEqual([])
  })

  it('drop a selector that is empty, too long or has control characters', () => {
    for (const selector of ['', '   ', 'a'.repeat(201), 'a\nb']) expect(cleanPageWatches([{ ...watch('a'), selector }])[0]!.selector).toBeUndefined()
    expect(cleanPageWatches([{ ...watch('a'), selector: '  .prix > span  ' }])[0]!.selector).toBe('.prix > span')
  })
})

describe('adding a watch', () => {
  const request = { url: 'https://example.org/prix', title: 'Prix', profileId: 'default', minutes: 30 }

  it('adds a page with the interval asked, at least five minutes', () => {
    const result = addWatch([], request, 'id-1')
    expect(result).toEqual({ watches: [{ id: 'id-1', url: request.url, title: 'Prix', profileId: 'default', minutes: 30 }] })
    expect(addWatch([], { ...request, minutes: 1 }, 'id-2')).toMatchObject({ watches: [{ minutes: 5 }] })
  })

  it('adds a zone of a page', () => {
    expect(addWatch([], { ...request, selector: '#stock' }, 'id-1')).toMatchObject({ watches: [{ selector: '#stock' }] })
  })

  it('refuses what is not a web page, with the sentence that says so', () => {
    expect(addWatch([], { ...request, url: 'file:///etc/passwd' }, 'x')).toEqual({ error: 'Seules les pages web (http ou https) peuvent être surveillées.' })
  })

  it('refuses a profile that is not one, and a selector that is not usable', () => {
    expect(addWatch([], { ...request, profileId: '../escape' }, 'x')).toEqual({ error: 'Le profil de cette page est inconnu.' })
    expect(addWatch([], { ...request, selector: 'a\nb' }, 'x')).toEqual({ error: 'Cette zone n’est pas un sélecteur valide.' })
  })

  it('does not watch the same page and zone twice, but the same page with another zone, yes', () => {
    const first = addWatch([], request, 'a') as { watches: PageWatch[] }
    expect(addWatch(first.watches, request, 'b')).toEqual({ error: 'Cette page est déjà surveillée.' })
    expect(addWatch(first.watches, { ...request, selector: '#x' }, 'b')).toMatchObject({ watches: [{ id: 'a' }, { id: 'b' }] })
  })

  it('refuses the page that would pass the limit, and says how many are watched', () => {
    const full = Array.from({ length: PAGE_WATCH_MAX }, (_, i) => watch(`w${i}`))
    expect(addWatch(full, { ...request, url: 'https://example.org/new' }, 'x')).toEqual({ error: frenchSpaces(`Vous surveillez déjà ${PAGE_WATCH_MAX} pages : retirez-en une d’abord.`) })
  })
})

describe('when a look is due', () => {
  it('is never before the watch has been looked at once, then a whole interval after the last look', () => {
    expect(dueAt(watch('a'))).toBe(0)
    expect(dueAt(watch('a', { checkedAt: 1000, minutes: 10 }))).toBe(1000 + 10 * MIN)
  })

  it('names the watch most overdue, and only one', () => {
    const a = watch('a', { checkedAt: 0, minutes: 10 })
    const b = watch('b', { checkedAt: 0, minutes: 5 })
    const c = watch('c', { checkedAt: 10 * MIN, minutes: 60 })
    expect(nextDue([a, b, c], 20 * MIN)).toBe(b)
    expect(nextDue([a, c], 20 * MIN)).toBe(a)
    expect(nextDue([c], 20 * MIN)).toBeNull()
    expect(nextDue([], 20 * MIN)).toBeNull()
  })

  it('is due at the very moment, not a moment before', () => {
    const a = watch('a', { checkedAt: 0, minutes: 5 })
    expect(nextDue([a], 5 * MIN - 1)).toBeNull()
    expect(nextDue([a], 5 * MIN)).toBe(a)
  })

  it('says when to wake: the earliest due time of any watch, and never when nothing is watched', () => {
    expect(nextWakeAt([])).toBeNull()
    expect(nextWakeAt([watch('a', { checkedAt: 0, minutes: 30 }), watch('b', { checkedAt: 0, minutes: 5 })])).toBe(5 * MIN)
    expect(nextWakeAt([watch('a')])).toBe(0)
  })
})

describe('what a look concludes', () => {
  it('is the same text, however it is laid out: whitespace is folded', () => {
    expect(normalizeWatchText('  Prix :\n\n  12,50 €\t TTC ')).toBe('Prix : 12,50 € TTC')
    expect(judgeLook(watch('a', { hash: fingerprint('Prix : 12,50 €') }), 'Prix :   12,50 €\n').outcome).toBe('same')
  })

  it('is a first look when nothing was seen before: it records, and does not call it a change', () => {
    const look = judgeLook(watch('a'), 'Prix : 12,50 €')
    expect(look.outcome).toBe('first')
    expect(look.hash).toBe(fingerprint('Prix : 12,50 €'))
  })

  it('is a change when the text is not the one seen last, a single character included', () => {
    const seen = watch('a', { hash: fingerprint('Prix : 12,50 €') })
    expect(judgeLook(seen, 'Prix : 12,50 €').outcome).toBe('same')
    expect(judgeLook(seen, 'Prix : 12,51 €').outcome).toBe('changed')
    expect(judgeLook(seen, '').outcome).toBe('changed')
  })

  it('looks at no more than the bound of the text (a page that long changes by itself)', () => {
    const long = 'x'.repeat(PAGE_WATCH_TEXT_MAX + 5000)
    expect(judgeLook(watch('a', { hash: fingerprint(long.slice(0, PAGE_WATCH_TEXT_MAX)) }), long).outcome).toBe('same')
  })

  it('has a fingerprint of 16 hex digits that tells two texts apart', () => {
    expect(fingerprint('a')).toMatch(/^[0-9a-f]{16}$/)
    expect(fingerprint('a')).not.toBe(fingerprint('b'))
    expect(fingerprint('ab')).not.toBe(fingerprint('ba'))
    expect(fingerprint('')).toMatch(/^[0-9a-f]{16}$/)
    expect(new Set(Array.from({ length: 500 }, (_, i) => fingerprint(`texte ${i}`))).size).toBe(500)
  })

  it('moves the dates after a look: checked always, changed only on a change, and the old failure forgotten', () => {
    const base = watch('a', { hash: 'aaaaaaaaaaaaaaaa', checkedAt: 1, changedAt: 2, failure: 'La page a planté.' })
    expect(afterLook(base, { outcome: 'same', hash: 'aaaaaaaaaaaaaaaa' }, 100)).toEqual(watch('a', { hash: 'aaaaaaaaaaaaaaaa', checkedAt: 100, changedAt: 2 }))
    expect(afterLook(base, { outcome: 'changed', hash: 'bbbbbbbbbbbbbbbb' }, 100)).toEqual(watch('a', { hash: 'bbbbbbbbbbbbbbbb', checkedAt: 100, changedAt: 100 }))
    expect(afterLook(watch('a'), { outcome: 'first', hash: 'cccccccccccccccc' }, 100)).toEqual(watch('a', { hash: 'cccccccccccccccc', checkedAt: 100 }))
  })

  it('moves the date after a failure too (the next look is a full interval away), keeps what was seen, and says why', () => {
    const base = watch('a', { hash: 'aaaaaaaaaaaaaaaa', checkedAt: 1, changedAt: 2 })
    const failed = afterFailure(base, 'La page n’a pas répondu à temps.', 100)
    expect(failed).toEqual({ ...base, checkedAt: 100, failure: 'La page n’a pas répondu à temps.' })
    expect(dueAt(failed)).toBe(100 + 60 * MIN)
    expect(afterFailure(base, '', 100).failure).toBe('La page n’a pas pu être lue.')
    expect(afterFailure(base, 'x\ny', 100).failure).toBe('x y')
  })

  it('tells a change by the name of the page, never by its text', () => {
    expect(changeNotice(watch('a', { title: 'Prix du vol' }))).toEqual({ title: 'Page modifiée', body: 'Prix du vol' })
  })
})

describe('the line of the list', () => {
  const now = 10 * 3_600_000
  it('says it was never looked at, then that it did not change, then when it did', () => {
    expect(watchStatus(watch('a'), now)).toBe('Pas encore vérifiée')
    expect(watchStatus(watch('a', { checkedAt: now - 5 * MIN }), now)).toBe(frenchSpaces('Inchangée · vérifiée il y a 5 min'))
    expect(watchStatus(watch('a', { checkedAt: now - 30_000 }), now)).toBe('Inchangée · vérifiée à l’instant')
    expect(watchStatus(watch('a', { checkedAt: now - 2 * 3_600_000, changedAt: now - 26 * 3_600_000 }), now)).toBe(frenchSpaces('Modifiée il y a 1 j · vérifiée il y a 2 h'))
  })

  it('says it in English with the English order of words, and names the choices of the list', () => {
    try {
      setLanguage('en')
      expect(watchStatus(watch('a', { checkedAt: now - 30_000 }), now)).toBe('Unchanged · checked just now')
      expect(watchStatus(watch('a', { checkedAt: now - 2 * 3_600_000, changedAt: now - 26 * 3_600_000 }), now)).toBe('Changed 1 d ago · checked 2 h ago')
      expect(watchIntervalLabel(2880)).toBe('2 d')
      expect(pageWatchChoices().map(([, label]) => label)).toEqual(['Every 5 minutes', 'Every 15 minutes', 'Every 30 minutes', 'Every hour', 'Every 6 hours', 'Every day'])
    } finally {
      setLanguage('fr')
    }
  })

  it('says what went wrong before anything else', () => {
    expect(watchStatus(watch('a', { checkedAt: now, failure: 'La page a planté.' }), now)).toBe(frenchSpaces('Échec : La page a planté.'))
  })
})
