import { describe, expect, it } from 'vitest'
import { filterSpaces, moveHighlight, openInCommand, openInTarget } from './little-picker'

const spaces = [{ name: 'Perso' }, { name: 'Pro' }, { name: 'Éléments' }, { name: 'Labo' }]

describe('filterSpaces', () => {
  it('keeps every space for an empty or blank query', () => {
    expect(filterSpaces(spaces, '')).toHaveLength(4)
    expect(filterSpaces(spaces, '   ')).toHaveLength(4)
  })

  it('matches a part of the name, ignoring case and accents, in both directions', () => {
    expect(filterSpaces(spaces, 'PRO').map((s) => s.name)).toEqual(['Pro'])
    expect(filterSpaces(spaces, 'ele').map((s) => s.name)).toEqual(['Éléments'])
    expect(filterSpaces(spaces, 'élé').map((s) => s.name)).toEqual(['Éléments'])
    expect(filterSpaces(spaces, 'er').map((s) => s.name)).toEqual(['Perso'])
  })

  it('gives nothing when no name contains the text', () => {
    expect(filterSpaces(spaces, 'zzz')).toEqual([])
  })
})

describe('moveHighlight', () => {
  it('stays inside the list, without wrapping', () => {
    expect(moveHighlight(0, -1, 4)).toBe(0)
    expect(moveHighlight(3, 1, 4)).toBe(3)
    expect(moveHighlight(1, 1, 4)).toBe(2)
    expect(moveHighlight(2, -1, 4)).toBe(1)
  })

  it('is 0 for an empty list', () => {
    expect(moveHighlight(5, 1, 0)).toBe(0)
  })
})

describe('open-in commands', () => {
  it('round-trips the space id', () => {
    expect(openInTarget(openInCommand('s2'))).toBe('s2')
  })

  it('refuses any other command and an empty id', () => {
    for (const command of ['open-in-main', 'move-menu', 'open-in:', 'open-in', '']) expect(openInTarget(command), command).toBeNull()
  })
})
