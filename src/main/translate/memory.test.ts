import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TRANSLATION_MEMORY_LIMITS, TranslationMemory, packRoute, sessionTranslations } from './memory'

// The translations of the session, in memory: bounded, the least recently used forgotten first, kept by route, never on disk.

describe('the memory of the translations', () => {
  it('gives back a translation by its route and its text, and nothing for another route', () => {
    const memory = new TranslationMemory()
    memory.set('system:fr>en', 'Accueil', 'Home')
    expect(memory.get('system:fr>en', 'Accueil')).toBe('Home')
    expect(memory.get('system:fr>de', 'Accueil')).toBeUndefined()
    expect(memory.get('system:fr>en', 'accueil')).toBeUndefined()
    // The route and the text cannot be confused by a text that holds the separator.
    memory.set('a', 'b\u0000c', 'x')
    expect(memory.get('a\u0000b', 'c')).toBe('x')
    expect(memory.of('system:fr>en').get('Accueil')).toBe('Home')
  })

  it('keeps at most its number of entries, forgetting the least recently used first', () => {
    const memory = new TranslationMemory({ entries: 3, chars: 1_000_000 })
    memory.set('r', 'un', '1')
    memory.set('r', 'deux', '2')
    memory.set('r', 'trois', '3')
    // Reading one makes it the most recently used.
    expect(memory.get('r', 'un')).toBe('1')
    memory.set('r', 'quatre', '4')
    expect(memory.size).toBe(3)
    expect(memory.get('r', 'deux')).toBeUndefined()
    expect(['un', 'trois', 'quatre'].map((text) => memory.get('r', text))).toEqual(['1', '3', '4'])
  })

  it('keeps at most its number of characters, and never one translation bigger than all of it', () => {
    const memory = new TranslationMemory({ entries: 1000, chars: 100 })
    for (let i = 0; i < 10; i++) memory.set('r', `texte ${i}`, 'x'.repeat(20))
    expect(memory.weight).toBeLessThanOrEqual(100)
    expect(memory.get('r', 'texte 9')).toBe('x'.repeat(20))
    expect(memory.get('r', 'texte 0')).toBeUndefined()
    memory.set('r', 'énorme', 'x'.repeat(200))
    expect(memory.get('r', 'énorme')).toBeUndefined()
    expect(memory.weight).toBeLessThanOrEqual(100)
    // It did not push the others out on its way.
    expect(memory.get('r', 'texte 9')).toBe('x'.repeat(20))
    // A text translated again replaces its translation, counted once.
    const one = new TranslationMemory({ entries: 10, chars: 1000 })
    one.set('r', 'a', 'xx')
    one.set('r', 'a', 'yyyy')
    expect(one.size).toBe(1)
    expect(one.weight).toBe('r\u0000a'.length + 4)
    one.clear()
    expect([one.size, one.weight]).toEqual([0, 0])
  })

  it('is bounded to some 20 000 translations and a few megabytes for the session', () => {
    expect(TRANSLATION_MEMORY_LIMITS).toEqual({ entries: 20_000, chars: 2_000_000 })
    const memory = new TranslationMemory()
    for (let i = 0; i < 25_000; i++) memory.set('system:fr>en', `Texte numéro ${i}`, `Text number ${i}`)
    expect(memory.size).toBe(20_000)
    expect(memory.weight).toBeLessThanOrEqual(TRANSLATION_MEMORY_LIMITS.chars)
    expect(sessionTranslations).toBeInstanceOf(TranslationMemory)
  })

  it('writes nothing anywhere: no file, no storage', () => {
    const source = readFileSync(fileURLToPath(new URL('./memory.ts', import.meta.url)), 'utf8')
    expect(source).not.toMatch(/from 'node:fs|from 'electron'|writeFile|localStorage|indexedDB/)
  })
})

describe('packRoute', () => {
  const pack = (model: string, version = '1') => ({ engine: 'bergamot', folder: 'fr-en', version, files: [{ sha256: model }, { sha256: 'vocab' }] })

  it('is the same for the same packs, whatever the order their files are listed in', () => {
    expect(packRoute([pack('a')])).toBe(packRoute([{ ...pack('a'), files: [{ sha256: 'vocab' }, { sha256: 'a' }] }]))
    expect(packRoute([pack('a')])).toMatch(/^bergamot:fr-en@1#[0-9a-f]{16}$/)
  })

  it('changes with the version, with the files under the same version, and with the order of the steps', () => {
    expect(packRoute([pack('a')])).not.toBe(packRoute([pack('a', '2')]))
    expect(packRoute([pack('a')])).not.toBe(packRoute([pack('b')]))
    const pivot = { engine: 'bergamot', folder: 'en-de', version: '1', files: [{ sha256: 'c' }] }
    expect(packRoute([pack('a'), pivot])).not.toBe(packRoute([pivot, pack('a')]))
  })
})
