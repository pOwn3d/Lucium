import { describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import { authWindowTitle, AuthFlowLimiter, countsAsGesture, GESTURE_WINDOW_MS, recentGesture } from './web-auth'

describe('authWindowTitle', () => {
  it('says where the page is, with fixed words around the host', () => {
    expect(authWindowTitle('https://accounts.example.com/login?next=/')).toBe('Connexion — accounts.example.com')
    expect(authWindowTitle('http://127.0.0.1:8080/x')).toBe('Connexion — 127.0.0.1:8080')
  })

  it('shows a look-alike host as the network sees it, not as it reads', () => {
    expect(authWindowTitle('https://аpple.com/')).toBe('Connexion — xn--pple-43d.com')
  })

  it('does not take a title from anything but the address', () => {
    expect(authWindowTitle('not an address')).toBe('Connexion — adresse inconnue')
  })

  it('says it in the language of the interface, around the same host', () => {
    try {
      setLanguage('en')
      expect(authWindowTitle('https://аpple.com/')).toBe('Sign In — xn--pple-43d.com')
      expect(authWindowTitle('not an address')).toBe('Sign In — unknown address')
    } finally {
      setLanguage('fr')
    }
  })
})

describe('countsAsGesture', () => {
  it('counts a click, a key press and a touch of a page nobody debugs, and nothing else', () => {
    for (const type of ['mouseDown', 'keyDown', 'rawKeyDown', 'touchStart']) expect(countsAsGesture(type, () => false), type).toBe(true)
    for (const type of ['mouseMove', 'mouseUp', 'keyUp', 'char', 'mouseWheel', 'touchEnd', 'contextMenu', '']) expect(countsAsGesture(type, () => false), type).toBe(false)
  })

  it('ignores the input of a page a debugger is attached to, since the debugger can send it itself', () => {
    for (const type of ['mouseDown', 'keyDown', 'rawKeyDown', 'touchStart']) expect(countsAsGesture(type, () => true), type).toBe(false)
  })

  it('asks whether a debugger is attached only for an input that could count', () => {
    let asked = 0
    const attached = (): boolean => (asked++, false)
    countsAsGesture('mouseMove', attached)
    countsAsGesture('char', attached)
    expect(asked).toBe(0)
    countsAsGesture('keyDown', attached)
    expect(asked).toBe(1)
  })
})

describe('recentGesture', () => {
  it('is true for a click or a key press just before, and false for none, an old one, or one from the future', () => {
    const now = 1_000_000
    expect(recentGesture(now - 100, now)).toBe(true)
    expect(recentGesture(now - GESTURE_WINDOW_MS, now)).toBe(true)
    expect(recentGesture(now - GESTURE_WINDOW_MS - 1, now)).toBe(false)
    expect(recentGesture(0, now)).toBe(false)
    expect(recentGesture(now + 5000, now)).toBe(false)
  })
})

describe('AuthFlowLimiter', () => {
  it('lets an extension run one flow at a time, and takes it back when the flow ends', () => {
    const limiter = new AuthFlowLimiter(3)
    const first = limiter.acquire('a')
    expect(first).not.toBeNull()
    expect(limiter.acquire('a')).toBeNull()
    expect(limiter.acquire('b')).not.toBeNull()
    first!()
    expect(limiter.acquire('a')).not.toBeNull()
  })

  it('caps the flows of the whole application', () => {
    const limiter = new AuthFlowLimiter(2)
    expect(limiter.acquire('a')).not.toBeNull()
    expect(limiter.acquire('b')).not.toBeNull()
    expect(limiter.acquire('c')).toBeNull()
    expect(limiter.count()).toBe(2)
  })

  it('ends a flow once, whatever the number of times it is told', () => {
    const limiter = new AuthFlowLimiter(2)
    const release = limiter.acquire('a')!
    release()
    const again = limiter.acquire('a')!
    release()
    expect(limiter.acquire('a')).toBeNull()
    again()
    expect(limiter.count()).toBe(0)
  })
})
