// The Settings panes say everything they say through the catalogues: no text is written in the code of `*Settings.tsx` (and SettingsWindow.tsx,
// settings-parts.tsx). A French text written in the code is shown in French whatever the language chosen, and the pane, which says it is in
// English (`lang`), is then read by a screen reader with the wrong voice. `node scripts/census-textes-reglages.mjs` lists them, file by file.
// Here because it reads files (the shared tests also build for the renderer, which has no `node:fs`).

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en } from '@shared/i18n-en'
import { fr } from '@shared/i18n-fr'
import { PENDING_PANE_FILES, isPaneFile, looksFrench, namesOtherBrowser, scanSource } from './settings-text-scan'

const RENDERER = join(fileURLToPath(new URL('../', import.meta.url)), 'renderer')

const paneFiles = readdirSync(RENDERER).filter(isPaneFile).sort()

/** Texts that are written in the code on purpose: a sample of code, which no language translates. */
const CODE_SAMPLES: ReadonlySet<string> = new Set(['// ==UserScript=='])

/**
 * Texts of the catalogues that name another browser on purpose, with the reason: comparisons kept on purpose (src/shared/little-name.test.ts
 * pins them too). A text that does not need the comparison is written without the name.
 */
const COMPARISONS: ReadonlySet<string> = new Set([
  // No comparison with another browser remains in the settings: they were replaced by neutral wording.
])

const read = (name: string): string => readFileSync(join(RENDERER, name), 'utf8')

/** The texts of a file that are written in the code and are not a sample of code. */
const written = (name: string) => scanSource(`src/renderer/${name}`, read(name)).filter((found) => !CODE_SAMPLES.has(found.text))

describe('the files of the Settings panes', () => {
  it('are found (a pane renamed or moved would otherwise slip out of the check)', () => {
    for (const name of ['SettingsWindow.tsx', 'settings-parts.tsx', 'AppearanceSettings.tsx', 'BlockingSettings.tsx', 'WebToolsSettings.tsx', 'FeaturesSettings.tsx']) expect(paneFiles, name).toContain(name)
    expect(paneFiles.length).toBeGreaterThanOrEqual(25)
    // The panes not converted yet are named here and nowhere else: they are checked when they leave the list.
    for (const name of PENDING_PANE_FILES) expect(paneFiles, name).not.toContain(name)
  })

  it('hold no text written in the code: every text goes through t(…)', () => {
    const found = paneFiles.flatMap(written).map((f) => `${f.file}:${f.line}:${f.column}  ${f.kind}${f.attribute ? `[${f.attribute}]` : ''}  ${f.text.slice(0, 90)}`)
    expect(found, `Textes écrits en dur (à passer par t('<volet>.<texte>') et à ajouter à i18n-fr.ts et i18n-en.ts) :\n${found.join('\n')}`).toEqual([])
  })

  it('name no other browser in a text they show, but the comparisons that are kept on purpose', () => {
    const named: string[] = []
    for (const name of paneFiles) {
      for (const match of read(name).matchAll(/\bt[pn]?\(\s*'([a-z0-9.-]+)'/g)) {
        const key = match[1]!
        if (COMPARISONS.has(key)) continue
        // A count (`key.one`, `key.other`) is asked for by its base.
        const texts = [fr, en].flatMap((catalogue) => [key, `${key}.one`, `${key}.other`].map((k) => (catalogue as Record<string, string>)[k] ?? ''))
        if (texts.some(namesOtherBrowser)) named.push(`${name}  ${key}`)
      }
    }
    expect(named, `Textes qui citent Arc ou Brave :\n${named.join('\n')}`).toEqual([])
  })

  it('keep the comparisons that are kept on purpose (the list above does not outlive them)', () => {
    for (const key of COMPARISONS) expect(namesOtherBrowser((fr as Record<string, string>)[key] ?? ''), key).toBe(true)
  })
})

describe('the scan that checks them', () => {
  const scan = (source: string, everything = false) => scanSource('x.tsx', source, { everything })
  const texts = (source: string) => scan(source).map((found) => found.text)

  it('sees a text between tags, whatever the language, and a French accent or word in a string', () => {
    expect(texts(`const A = () => <p>Bonjour</p>`)).toEqual(['Bonjour'])
    expect(texts(`const A = () => <button>Remove</button>`)).toEqual(['Remove'])
    expect(texts(`const label = 'Désactivé : rien ne tourne'`)).toEqual(['Désactivé : rien ne tourne'])
    expect(texts('const label = `Retirer ${host}`')).toEqual(['Retirer …'])
    expect(texts(`const A = () => <p>{ok ? 'Oui' : 'Non'}</p>`)).toEqual(['Oui', 'Non'])
  })

  it('sees a string given to an attribute that someone reads, in quotes or in braces', () => {
    expect(texts(`const A = () => <input placeholder="exemple.org" aria-label="Site" title={'Fermer'} />`)).toEqual(['exemple.org', 'Site', 'Fermer'])
    expect(scan(`const A = () => <Row hint="Une aide." />`)[0]).toMatchObject({ kind: 'attribute', attribute: 'hint', direct: true })
  })

  it('sees the text inside a cast, a table or a getter', () => {
    expect(texts(`const rows = [[1, \`Toutes les \${n}\`] as [number, string]]`)).toEqual(['Toutes les …'])
    expect(texts(`const NAMES = { standard: 'Standard', strict: 'Strict' }`)).toEqual(['Standard', 'Strict'])
    expect(scan(`const NAMES = { get a() { return 'Un texte' } }`)[0]).toMatchObject({ atModuleLevel: false })
    expect(scan(`const NAMES = { a: 'Un texte' }`)[0]).toMatchObject({ atModuleLevel: true })
  })

  it('does not take for a text what is not one', () => {
    // The key of a catalogue, a class, an identifier, a key name compared with, a type, an import, code between tags, a comment.
    expect(texts(`const A = () => <p className="pref-row" role="status">{t('settings.ajouter')}</p>`)).toEqual([])
    expect(texts(`const a = tp('cmd.session-tabs', n)`)).toEqual([])
    expect(texts(`const a = e.key === 'Enter' || e.key === 'Escape'`)).toEqual([])
    expect(texts(`const COST: Record<Badge, number> = { léger: 1, 'réseau': 2 }`)).toEqual([])
    expect(texts(`import { x } from './énorme'\ntype T = 'Bonjour à tous'`)).toEqual([])
    expect(texts(`const A = () => <code>##+js(…)</code>`)).toEqual([])
    expect(texts(`// Bonjour à tous\n/* Désactivé */ const a = 1`)).toEqual([])
    // The variables handed to t(…) are read: they may hold a text.
    expect(texts(`const a = t('k', { name: 'Ajouter' })`)).toEqual(['Ajouter'])
  })

  it('sees a text in the spacing of JSX the way React shows it', () => {
    expect(scan(`const A = () => (\n  <p>\n    Une phrase\n    sur deux lignes\n  </p>\n)`)[0]?.value).toBe('Une phrase sur deux lignes')
    // A no-break space stays one (the text is the catalogue's to the character).
    expect(scan(`const a = 'Fichier : ici'`)[0]?.value).toBe('Fichier : ici')
  })

  it('leaves the journal, the identifiers and the names of fonts alone, and reads a .ts file without JSX', () => {
    expect(texts(`console.error('[x] la page n’a pas répondu', error); console.warn(\`[y] échec \${n}\`)`)).toEqual([])
    expect(texts(`const KEY = 'guide.mises-a-jour'; const row = 'le-soir'`)).toEqual([])
    expect(texts(`const FONT = '-apple-system, system-ui, sans-serif'`)).toEqual([])
    // A word with an accent is not an identifier: a person reads « mini-fenêtre ».
    expect(texts(`const NAME = 'mini-fenêtre'`)).toEqual(['mini-fenêtre'])
    expect(scanSource('x.ts', `const id = <T>(x: T): T => x\nconst label = 'Fermer la fenêtre'`).map((found) => found.text)).toEqual(['Fermer la fenêtre'])
  })

  it('names the top-level declaration a text is in', () => {
    const found = scan(`export const LABELS = { a: 'Un texte' }\nfunction notice() { return 'Une phrase' }\nexport class Box { label = 'Une boîte' }`)
    expect(found.map((f) => f.declaration)).toEqual(['LABELS', 'notice', 'Box'])
  })

  it('tells French from English by an accent or by a word only French has', () => {
    for (const french of ['Retirer', 'Ajouter un fichier…', 'Aucun site.', 'dans le profil', 'Tous les jours', 'Désactivé', 'Transformer « … » en espace']) expect(looksFrench(french), french).toBe(true)
    for (const english of ['Remove', 'Add a File…', 'No sites.', 'in profile', 'Every day', 'Off', 'Standard', 'Strict', 'page', 'extension', 'Turn “…” into a Space', '»']) expect(looksFrench(english), english).toBe(false)
    expect(namesOtherBrowser('Comme Arc, on ouvre')).toBe(true)
    expect(namesOtherBrowser('Archive, ARC4, Arcade')).toBe(false)
  })
})
