// « Sur l'iPhone » in the command bar: the tabs an iPhone announced answer what is typed, under their own title, with the host and the age of the list. Nothing for no text, in a
// private window, or without a list (no iPhone paired, the category not ticked on both sides: the main process gives none). Choosing a line is the renderer's: it names the line.

import { describe, expect, it } from 'vitest'
import { candidateGroup, candidateHint, candidatePreview, groupCandidates, groupStarts, groupTitle, rankCandidates, type Candidate } from './command-bar'
import { createInitialState } from './sidebar'
import { setLanguage } from './i18n'
import type { ResumeAvailability, ResumeLine } from './sync-resume'

const state = createInitialState({ now: 1_000, newId: () => 'id' })
const NOW = 10_000_000
const line = (id: string, title: string, host: string): ResumeLine => ({ id, title, host, lastActiveAt: 1 })
const LINES = [line('p:1', 'Pasta recipes', 'cooking.example'), line('p:2', 'Weather', 'meteo.example'), line('p:3', 'Pasta history', 'history.example')]
const list = (announcedAt: number | null = NOW - 5 * 60_000) => ({ lines: LINES, announcedAt, availability: 'list' as const, now: NOW })
const rows = (found: Candidate[]) => found.filter((c): c is Extract<Candidate, { kind: 'iphone' }> => c.kind === 'iphone')

describe('« Sur l\'iPhone » in the command bar', () => {
  it('lists the tabs that answer the text, with the host and the age of the list, and names the line', () => {
    setLanguage('fr')
    const found = rows(rankCandidates('pasta', state, [], [], [], { iphone: list() }))
    expect(found.map((c) => [c.label, c.resumeId])).toEqual([['Pasta recipes', 'p:1'], ['Pasta history', 'p:3']])
    expect(found[0]!.detail).toBe('cooking.example · annoncé il y a 5 minutes')
    expect(groupTitle(candidateGroup(found[0]!), 'pasta')).toBe("Sur l'iPhone")
    expect(candidateHint(found[0]!)).not.toBe('')
    expect(candidatePreview(found[0]!, { state, now: NOW, mode: 'new', platform: 'darwin' })).toMatchObject({ title: 'Pasta recipes', chips: ["Sur l'iPhone"] })
  })

  it('says it in English, with the plural of the age', () => {
    setLanguage('en')
    expect(rows(rankCandidates('weather', state, [], [], [], { iphone: { ...list(), announcedAt: NOW - 60_000 } }))[0]!.detail).toBe('meteo.example · announced 1 minute ago')
    expect(rows(rankCandidates('weather', state, [], [], [], { iphone: { ...list(), announcedAt: NOW - 3 * 3_600_000 } }))[0]!.detail).toBe('meteo.example · announced 3 hours ago')
    expect(rows(rankCandidates('weather', state, [], [], [], { iphone: { ...list(), announcedAt: NOW - 30_000 } }))[0]!.detail).toBe('meteo.example · announced just now')
    expect(groupTitle('iphone', 'x')).toBe('On the iPhone')
    setLanguage('fr')
  })

  it('lists nothing for no text', () => {
    expect(rows(rankCandidates('', state, [], [], [], { iphone: list() }))).toEqual([])
    expect(rows(rankCandidates('   ', state, [], [], [], { iphone: list() }))).toEqual([])
  })

  it('lists nothing without a list, in a private window, or for a text that matches nothing', () => {
    expect(rows(rankCandidates('pasta', state))).toEqual([])
    expect(rows(rankCandidates('pasta', state, [], [], [], { iphone: { lines: [], announcedAt: null, availability: 'waiting' as const, now: NOW } }))).toEqual([])
    expect(rows(rankCandidates('pasta', state, [], [], [], { iphone: list(), private: true }))).toEqual([])
    expect(rows(rankCandidates('zzzzqq', state, [], [], [], { iphone: list() }))).toEqual([])
  })

  it('says how to get the list when it is absent, one sentence per reason, only for a text that names the section', () => {
    const hints = (query: string, availability: ResumeAvailability) => rankCandidates(query, state, [], [], [], { iphone: { lines: [], announcedAt: null, availability, now: NOW } }).filter((c) => c.kind === 'iphone-hint')
    setLanguage('fr')
    const sentences = (['not-paired', 'disabled-here', 'waiting', 'disabled-on-iphone', 'empty'] as const).map((reason) => hints('iphone', reason).map((c) => c.label))
    expect(new Set(sentences.map((one) => one.join())).size).toBe(5)
    expect(sentences.every((one) => one.length === 1 && one[0] !== '')).toBe(true)
    // The French typography puts non-breaking spaces before « : » and inside the guillemets.
    expect(hints('iphone', 'disabled-here')[0]!.label.replace(/\s/g, ' ')).toBe("Pour voir ici les onglets de l'iPhone : cochez « Onglets ouverts » dans Réglages › Téléchargements et fichiers › Synchronisation.")
    setLanguage('en')
    expect(hints('iphone', 'disabled-here')[0]!.label).toBe('To see the iPhone’s tabs here: tick “Open tabs” in Settings › Downloads and files › Synchronization.')
    setLanguage('fr')
    expect(groupTitle(candidateGroup(hints('iphone', 'waiting')[0]!), 'iphone')).toBe("Sur l'iPhone")
    // Another text, or a list that is there, or a private window: no sentence.
    expect(hints('pasta', 'waiting')).toEqual([])
    expect(hints('', 'waiting')).toEqual([])
    expect(hints('iphone', 'list')).toEqual([])
    expect(rankCandidates('iphone', state, [], [], [], { iphone: { lines: [], announcedAt: null, availability: 'waiting', now: NOW }, private: true }).filter((c) => c.kind === 'iphone-hint')).toEqual([])
  })

  it('lists five lines at most', () => {
    const many = Array.from({ length: 12 }, (_, i) => line(`p:${i}`, `Pasta ${i}`, 'cooking.example'))
    expect(rows(rankCandidates('pasta', state, [], [], [], { iphone: { lines: many, announcedAt: NOW, availability: 'list' as const, now: NOW } }))).toHaveLength(5)
  })

  it('keeps the lines together under one title', () => {
    const found = groupCandidates(rankCandidates('pasta', state, [], [], [], { iphone: list() }))
    const starts = groupStarts(found).filter((g) => g === 'iphone')
    expect(starts).toHaveLength(1)
  })
})
