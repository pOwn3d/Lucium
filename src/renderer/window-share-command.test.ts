// The command window of the annotated share has no rendering test in the project (its script runs at load, against a DOM): this one checks what can break
// silently between its files. Every element the script reads by id must be in the page (a missing one throws at start), and every translation key the two
// windows use must be in the catalogue. Contract: the page and the scripts are read as data (the ids and the keys they name, the notice hidden in the page),
// not matched on the wording of a line: the script runs at load against the page, which no test here can give it.

import { describe, expect, it } from 'vitest'
import commandHtml from './window-share-command.html?raw'
import commandScript from './window-share-command.ts?raw'
import viewScript from './window-share-view.ts?raw'
import { fr } from '@shared/i18n-fr'

/** The ids the script reads: `$('id')` and `$<Type>('id')`. */
function idsRead(script: string): string[] {
  return [...script.matchAll(/\$(?:<[^>]+>)?\('([^']+)'\)/g)].map((match) => match[1]!)
}

describe('the command window', () => {
  it('has in its page every element its script reads by id', () => {
    const ids = new Set([...commandHtml.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!))
    const read = idsRead(commandScript)
    expect(read.length).toBeGreaterThan(20)
    expect(read.filter((id) => !ids.has(id))).toEqual([])
  })

  it('shows the notice of the source in its page, hidden until it is needed', () => {
    expect(commandHtml).toMatch(/id="window-share-notice"[^>]*\shidden/)
  })
})

describe('the translation keys of the two windows', () => {
  it('exist in the French catalogue', () => {
    const keys = new Set(Object.keys(fr))
    // Every literal key of the two scripts, including the ones picked by a condition (t(pass ? 'a' : 'b')).
    const used = [...new Set([commandScript, viewScript].join('\n').match(/'window-share\.[^']+'/g) ?? [])].map((key) => key.slice(1, -1))
    expect(used.length).toBeGreaterThan(30)
    expect(used.filter((key) => !keys.has(key))).toEqual([])
  })
})

// The field of a text is made by the script of the view at run time: what a key does in it is the shared rule's to say (it leaves Return and Escape to
// the input method while a text is composed), and the view must not decide on the key by itself again.
describe('the field of a text in the view', () => {
  it('asks the shared rule what a key does, and reads no key on its own', () => {
    const field = /function openText\([\s\S]*?\n}\n/.exec(viewScript)?.[0] ?? ''
    expect(field).toContain('textKeyOutcome(event)')
    expect(field).not.toMatch(/event\.key\b/)
  })
})
