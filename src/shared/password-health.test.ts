import { describe, expect, it } from 'vitest'
import { passwordHealth, passwordIsWeak } from './password-health'

describe('passwordIsWeak', () => {
  it.each(['abc', 'abcdefgh', '12345678', 'aaaaaaaaaaaa', 'abababababab', 'Password1', 'azerty123', 'motdepasse2', 'QWERTY!', '12341234123', 'abcdefghijklmnop', 'zyxwvutsrqponmlkjihg'])('judges %s weak', (password) => {
    expect(passwordIsWeak(password)).toBe(true)
  })

  it.each(['k7#Vq2!mZp9x', 'correct horse battery staple', 'tR4ub4dor&3xyz', 'bqfzjtdkwlpe'])('judges %s fine', (password) => {
    expect(passwordIsWeak(password)).toBe(false)
  })

  it('counts a letter once whatever its case when looking for a repeated pattern', () => {
    expect(passwordIsWeak('AaAaAaAaAaAa')).toBe(true)
  })
})

describe('passwordHealth', () => {
  const entry = (id: string, password: string) => ({ id, password })

  it('flags every entry that shares its password with another, whatever its site', () => {
    const health = passwordHealth([entry('a', 'k7#Vq2!mZp9x'), entry('b', 'tR4ub4dor&3xyz'), entry('c', 'k7#Vq2!mZp9x')])
    expect(health.get('a')).toEqual({ weak: false, reused: true })
    expect(health.get('b')).toEqual({ weak: false, reused: false })
    expect(health.get('c')).toEqual({ weak: false, reused: true })
  })

  it('does not call a password reused because of a different case', () => {
    const health = passwordHealth([entry('a', 'k7#Vq2!mZp9x'), entry('b', 'K7#VQ2!MZP9X')])
    expect(health.get('a')?.reused).toBe(false)
  })

  it('flags a weak password on its own', () => {
    expect(passwordHealth([entry('a', '12345678')]).get('a')).toEqual({ weak: true, reused: false })
  })

  it('says nothing for an empty vault', () => {
    expect(passwordHealth([]).size).toBe(0)
  })
})
