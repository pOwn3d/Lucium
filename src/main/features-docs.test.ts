import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FEATURES, featureDefault } from '@shared/features'
import { plainSpaces } from '@shared/french-typography'

// docs/fonctions.md is the reference that says what each feature costs on and what switching it off really frees. A feature nobody wrote up fails here.
describe('docs/fonctions.md', () => {
  const doc = readFileSync(fileURLToPath(new URL('../../docs/fonctions.md', import.meta.url)), 'utf8')

  it('describes every registered feature, by its id between backticks', () => {
    const missing = FEATURES.filter((feature) => !doc.includes(`\`${feature.id}\``)).map((feature) => feature.id)
    expect(missing, `docs/fonctions.md ne décrit pas : ${missing.join(', ')}`).toEqual([])
  })

  // The tables read: | `id` | label | default | cost | what happens when it is off |. Typographic apostrophes and straight ones count the same.
  const rows = new Map<string, string[]>()
  for (const line of doc.split('\n')) {
    const cells = /^\| `([a-z-]+)` \|(.*)\|\s*$/.exec(line)
    if (cells) rows.set(cells[1]!, cells[2]!.split('|').map((cell) => cell.trim()))
  }
  const plain = (text: string): string => plainSpaces(text.replace(/[’‘]/g, "'"))

  it('has one row of the tables for each registered feature, with its label as the pane shows it', () => {
    const wrong: string[] = []
    for (const feature of FEATURES) {
      const row = rows.get(feature.id)
      if (!row) wrong.push(`${feature.id}: no row`)
      else if (plain(row[0]!) !== plain(feature.label)) wrong.push(`${feature.id}: « ${row[0]} » in the document, « ${feature.label} » in the pane`)
    }
    expect(wrong).toEqual([])
  })

  it('gives each feature the default the registry gives it (the default state of its setting, not another one)', () => {
    const wrong: string[] = []
    for (const feature of FEATURES) {
      const cell = rows.get(feature.id)?.[1] ?? ''
      const says = /désactivée/.test(cell) ? false : /activée/.test(cell) ? true : null
      if (says !== featureDefault(feature.id)) wrong.push(`${feature.id}: « ${cell} » in the document, ${featureDefault(feature.id) ? 'on' : 'off'} in the registry`)
    }
    expect(wrong).toEqual([])
  })

  it('names the classes of cost of the registry for each feature (a row that says "idem" has none of its own)', () => {
    const wrong: string[] = []
    for (const feature of FEATURES) {
      const cell = rows.get(feature.id)?.[2] ?? ''
      const named = [...cell.matchAll(/`(none|timer|listeners|network|memory|process|disk)`/g)].map((m) => m[1]!)
      if (named.length === 0) continue
      if ([...named].sort().join() !== [...feature.cost].sort().join()) wrong.push(`${feature.id}: ${named.join(',')} in the document, ${feature.cost.join(',')} in the registry`)
    }
    expect(wrong).toEqual([])
  })
})
