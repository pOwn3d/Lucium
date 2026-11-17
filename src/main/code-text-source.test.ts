// The code outside the panels says what a person reads through the catalogues too: the menus, dialogs and notifications of the main process, the
// messages and default names of the shared code, the folders of `src/renderer` and the pages (`src/renderer/*.html`). A text written in the code
// shows in French whatever the language chosen. What is left alone is in src/main/code-text-scan.ts, each with its reason;
// `pnpm census:textes --code` lists what this test would fail on. Here because it reads files (see settings-text-source.test.ts).

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CODE_ROOTS, KEPT_DECLARATIONS, KEPT_TEXTS, PENDING_CODE_FILES, SKIPPED_FILES, codeFiles, counts, exceptionOf } from './code-text-scan'
import { looksFrench, scanSource, type Finding } from './settings-text-scan'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const RENDERER = join(ROOT, 'src/renderer')

const files = codeFiles(ROOT)
const findingsOf = (file: string): Finding[] => scanSource(file, readFileSync(join(ROOT, file), 'utf8')).filter(counts)
const all = new Map(files.map((file) => [file, findingsOf(file)] as const))
const left = (file: string): Finding[] => (all.get(file) ?? []).filter((found) => !exceptionOf(found))
const line = (f: Finding): string => `${f.file}:${f.line}:${f.column}  ${f.kind}${f.attribute ? `[${f.attribute}]` : ''}${f.declaration ? ` (${f.declaration})` : ''}  ${f.text.slice(0, 90)}`

describe('the code outside the panels', () => {
  it('is found: the folders, and a file of each (a file moved out of them would otherwise slip out of the check)', () => {
    for (const file of ['src/main/shell/menu-actions.ts', 'src/main/persistence-notices.ts', 'src/shared/theme-presets.ts', 'src/shared/boost-share.ts', 'src/preload/index.ts', 'src/renderer/templates/Sheet.tsx']) {
      expect(files, file).toContain(file)
    }
    expect(files.some((file) => file.endsWith('.test.ts'))).toBe(false)
    for (const folder of CODE_ROOTS) expect(files.some((file) => file.startsWith(`${folder}/`)), folder).toBe(true)
  })

  it('reads every folder of src/renderer: a new one that is not in CODE_ROOTS would be read by no test of the texts', () => {
    const folders = readdirSync(RENDERER, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => `src/renderer/${entry.name}`)
    expect(folders.length).toBeGreaterThan(0)
    expect(folders.filter((folder) => !CODE_ROOTS.includes(folder))).toEqual([])
  })

  it('sees a French label of one word with no accent, in a file of the main process or of the shared code', () => {
    // « Taille » stood in shared/boost.ts for months: no accent, and not a word of the list then.
    const found = (text: string): boolean => scanSource('src/shared/sample.ts', `export const label = (): string => '${text}'\n`).filter(counts).length > 0
    for (const label of ['Taille', 'Imprimer', 'Quitter', 'Partager', 'adresse inconnue']) expect(found(label), label).toBe(true)
    // What is not French still passes in a `.ts` file: an identifier, an English word, a word both languages write alike.
    for (const text of ['size', 'Cancel', 'toggle-dock', 'page']) expect(found(text), text).toBe(false)
  })

  it('holds no text written in the code: every text goes through t(…) or tp(…)', () => {
    const found = files.filter((file) => !(file in PENDING_CODE_FILES)).flatMap(left).map(line)
    expect(found, `Textes écrits en dur (à passer par t('<zone>.<texte>') et à ajouter à i18n-fr.ts et i18n-en.ts, ou à justifier dans src/main/code-text-scan.ts) :\n${found.join('\n')}`).toEqual([])
  })

  it('keeps the list of the files not converted honest: each is scanned and still holds a text written in the code', () => {
    for (const file of Object.keys(PENDING_CODE_FILES)) {
      expect(files, file).toContain(file)
      expect(left(file).length, file).toBeGreaterThan(0)
    }
  })

  it('keeps no exception that no longer leaves anything alone', () => {
    const scanned = [...all.values()].flat()
    const unusedDeclarations = KEPT_DECLARATIONS.filter(([file, declaration]) => !scanned.some((f) => f.file === file && f.declaration === declaration)).map(([file, declaration]) => `${file} ${declaration}`)
    const unusedTexts = KEPT_TEXTS.filter(([file, text]) => !scanned.some((f) => f.file === file && (typeof text === 'string' ? text === f.text : text.test(f.text)))).map(([file, text]) => `${file} ${String(text)}`)
    expect([...unusedDeclarations, ...unusedTexts]).toEqual([])
    for (const [, , why] of [...KEPT_DECLARATIONS, ...KEPT_TEXTS]) expect(why.length, 'every exception says why').toBeGreaterThan(10)
  })

  it('skips only files that exist, each with its reason', () => {
    const everyFile: string[] = []
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`)
        else everyFile.push(`${prefix}${entry.name}`)
      }
    }
    for (const folder of CODE_ROOTS) walk(join(ROOT, folder), `${folder}/`)
    for (const [match, why] of SKIPPED_FILES) {
      expect(everyFile.some((file) => (typeof match === 'string' ? match === file : match.test(file))), String(match)).toBe(true)
      expect(why.length, String(match)).toBeGreaterThan(10)
    }
  })
})

/** The texts of a page of `src/renderer` a person reads before its script runs: the text between tags (the title among them) and the read attributes. */
function pageTexts(html: string): string[] {
  const markup = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '')
  const between = [...markup.matchAll(/>([^<]+)</g)].map((match) => match[1]!.trim()).filter((text) => /\p{L}{2}/u.test(text))
  const attributes = [...markup.matchAll(/\b(?:title|aria-label|aria-description|placeholder|alt)="([^"]*)"/g)].map((match) => match[1]!)
  return [...between, ...attributes]
}

describe('the pages of the interface', () => {
  const pages = readdirSync(RENDERER).filter((name) => name.endsWith('.html')).sort()

  it('are found', () => {
    for (const name of ['index.html', 'settings.html', 'about.html', 'taskmanager.html', 'overlay.html']) expect(pages, name).toContain(name)
  })

  it('hold no French: a window’s title and the names of its parts are set by its script, through t(…)', () => {
    const found = pages.flatMap((name) => pageTexts(readFileSync(join(RENDERER, name), 'utf8')).filter(looksFrench).map((text) => `${name}  ${text}`))
    expect(found, `Textes en français dans les pages (le script de la page pose document.title = t('…')) :\n${found.join('\n')}`).toEqual([])
  })

  it('are read the way a person reads them', () => {
    expect(pageTexts('<title>Réglages</title><style>p{content:"Non"}</style><nav aria-label="Outils">x</nav><!-- Commentaire -->')).toEqual(['Réglages', 'Outils'])
  })
})
