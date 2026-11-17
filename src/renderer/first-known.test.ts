// What a panel goes back to with "Réinitialiser" and Escape is how things were when it opened. For the background of a space, that can be « none »: the
// theme editor must then take away the one added since, not keep it as if it had always been there.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { useFirstKnown } from './first-known'
import { rendersOf } from './render.test-support'

/** What the hook holds at each render of one panel, given what the panel knows at that render. */
const held = <T>(renders: ReadonlyArray<{ known: boolean; value: T }>): Array<T | undefined> => rendersOf(renders.length, (pass) => useFirstKnown(renders[pass]!.known, renders[pass]!.value).current)

describe('useFirstKnown', () => {
  it('keeps the value of the first render where it is known, whatever comes after', () => {
    expect(held([{ known: true, value: 'plage.jpg' }, { known: true, value: 'foret.mp4' }, { known: true, value: undefined }])).toEqual(['plage.jpg', 'plage.jpg', 'plage.jpg'])
  })

  it('keeps « none » for a value that was absent when the panel opened: what is added later is not how things were', () => {
    expect(held<string | undefined>([{ known: true, value: undefined }, { known: true, value: 'plage.jpg' }, { known: true, value: 'foret.mp4' }])).toEqual([undefined, undefined, undefined])
  })

  it('waits for the first snapshot: nothing is taken before the value is known', () => {
    expect(held<string | undefined>([{ known: false, value: undefined }, { known: true, value: 'plage.jpg' }, { known: true, value: undefined }])).toEqual([undefined, 'plage.jpg', 'plage.jpg'])
  })

  it('is how the theme editor remembers the background its space had, and what Escape and "Réinitialiser" send back', () => {
    const source = readFileSync(new URL('./ThemeEditor.tsx', import.meta.url), 'utf8')
    expect(source).toContain('const originalBackground = useFirstKnown(space !== undefined, space?.background)')
    expect(source).toContain('patch: { background: originalBackground.current ? { ...originalBackground.current } : undefined }')
    expect(source).not.toMatch(/originalBackground\.current = /)
  })
})
