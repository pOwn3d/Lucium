// The panels, sheets and windows of the interface (every file of `src/renderer` that is not a Settings pane: those are settings-text-source.test.ts')
// say what they say through the catalogues. A text written in the code shows in French whatever the language
// chosen, and VoiceOver reads its French accessible name with the voice of the interface. Here because it reads files (see settings-text-source.test.ts).

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isPaneFile, scanSource } from './settings-text-scan'

const RENDERER = join(new URL('../', import.meta.url).pathname, 'renderer')

/** Every file of the interface that is not a pane of the Settings window, nor a test. */
const panelFiles = readdirSync(RENDERER)
  .filter((name) => /\.(tsx|ts)$/.test(name) && !name.endsWith('.test.ts') && !isPaneFile(name))
  .sort()

/** The files not converted yet, with the reason. A file leaves this list when the scan finds nothing in it. None since the vault and the lock were. */
const PENDING: Readonly<Record<string, string>> = {}

/** Texts written in the code on purpose, by file: names no language translates, keys, class names, samples of code. */
const KEPT: ReadonlyArray<readonly [file: string, text: string | RegExp, why: string]> = [
  ['BoostEditor.tsx', 'Aa', 'the glyph of the typeface button'],
  ['FindReplace.tsx', 'Aa', 'the glyph of the « match case » button'],
  ['EngineStatus.tsx', /^(Lucium|Electron|Chromium|Widevine)$/, 'names of the application, of the engine and of its parts'],
  ['LockScreen.tsx', 'Touch ID', 'the name of the function, the same in every language'],
  ['ExtensionsPage.tsx', 'Meta+F', 'a key'],
  ['FloatingVideoBar.tsx', /^(Meta\+W|Space|ArrowUp ArrowDown|ArrowLeft|ArrowRight)$/, 'the keys of the bar, as `aria-keyshortcuts` names them'],
  ['HoverCard.tsx', 'zz', 'the mark of a sleeping tab'],
  ['SidebarRows.tsx', 'zz', 'the mark of a sleeping tab'],
  ['SidebarRows.tsx', /^(has-aux|ArrowRight|ArrowLeft)$/, 'a class name and keys'],
  ['ThemeEditor.tsx', /^(ArrowDown|ArrowUp|Home|End)$/, 'keys'],
  ['NoteTextEditor.tsx', /^(ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/, 'the keys that move the caret, kept by the field'],
  ['NotesPanel.tsx', 'Files', 'the type of a drag that carries files'],
  ['ProxyEditor.tsx', 'socks5://127.0.0.1:1080', 'a sample address'],
  ['littlearc.tsx', /^la(-[a-z-]+)?( …| la-[a-z-]+)?$/, 'class names of the small window']
]

const kept = (file: string, text: string): boolean => KEPT.some(([name, match]) => name === file && (typeof match === 'string' ? match === text : match.test(text)))
const written = (name: string) => scanSource(`src/renderer/${name}`, readFileSync(join(RENDERER, name), 'utf8')).filter((found) => !kept(name, found.text))

describe('the panels of the interface', () => {
  it('are found (a panel renamed or moved would otherwise slip out of the check)', () => {
    for (const name of ['Bookmarks.tsx', 'ReadLater.tsx', 'Sessions.tsx', 'AutoReloadPanel.tsx', 'FirstLaunchSheet.tsx', 'SiteData.tsx', 'CookieManager.tsx']) expect(panelFiles, name).toContain(name)
    for (const name of Object.keys(PENDING)) expect(panelFiles, name).toContain(name)
  })

  it('hold no text written in the code: every text goes through t(…) or tp(…)', () => {
    const found = panelFiles
      .filter((name) => !(name in PENDING))
      .flatMap(written)
      .map((f) => `${f.file}:${f.line}:${f.column}  ${f.kind}${f.attribute ? `[${f.attribute}]` : ''}  ${f.text.slice(0, 90)}`)
    expect(found, `Textes écrits en dur (à passer par t('<zone>.<texte>') et à ajouter à i18n-fr.ts et i18n-en.ts) :\n${found.join('\n')}`).toEqual([])
  })

  it('keep the list of the files not converted honest: each still holds a text written in the code', () => {
    for (const name of Object.keys(PENDING)) expect(written(name).length, name).toBeGreaterThan(0)
  })

  it('keep no exception that no longer matches a text', () => {
    const all = panelFiles.flatMap((name) => scanSource(`src/renderer/${name}`, readFileSync(join(RENDERER, name), 'utf8')).map((found) => [name, found.text] as const))
    const unused = KEPT.filter(([file, match]) => !all.some(([name, text]) => name === file && (typeof match === 'string' ? match === text : match.test(text)))).map(([file, match]) => `${file} ${String(match)}`)
    expect(unused).toEqual([])
  })
})
