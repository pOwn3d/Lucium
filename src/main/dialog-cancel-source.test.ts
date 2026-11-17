// The button that gives up in a native box reads “Cancel”. `menu.annuler` is the Edit menu's item: “Annuler” in French, but “Undo” in
// English, and a box that offers “Clear” and “Undo” lets the reader believe the thing is already done. The boxes use `confirm-box.annuler`.
// Here because it reads files (the shared tests also build for the renderer, which has no `node:fs`).

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en } from '@shared/i18n-en'
import { fr } from '@shared/i18n-fr'

const SRC = fileURLToPath(new URL('../', import.meta.url))

/** Every source file of the application, tests left out, as a path from `src/`. */
const sources = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
  .sort()

/** The lines that hand `menu.annuler` to the buttons of a box. */
const undoAsCancel = (text: string): string[] => text.split('\n').filter((line) => /\bbuttons\s*:/.test(line) && line.includes("t('menu.annuler')"))

describe('the button that gives up in a native box', () => {
  it('is recognised by the check (a line that hands the Edit menu item to the buttons is found)', () => {
    expect(undoAsCancel("  buttons: [ok, t('menu.annuler')],\n  label: t('menu.annuler')")).toHaveLength(1)
    expect(sources.length).toBeGreaterThan(200)
  })

  it('is never the "Undo" of the Edit menu', () => {
    const found = sources.flatMap((name) => undoAsCancel(readFileSync(join(SRC, name), 'utf8')).map((line) => `src/${name}: ${line.trim()}`))
    expect(found).toEqual([])
  })

  it('reads "Cancel" in English and "Annuler" in French, while the Edit menu keeps "Undo"', () => {
    expect([en['confirm-box.annuler'], fr['confirm-box.annuler']]).toEqual(['Cancel', 'Annuler'])
    expect([en['menu.annuler'], fr['menu.annuler']]).toEqual(['Undo', 'Annuler'])
  })
})
