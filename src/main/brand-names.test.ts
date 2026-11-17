// Lucium speaks of browsers in general: no text of the interface (the two catalogues), no line of the changelogs (the « Nouveautés » sheet
// reads them) and no README names another browser or the company that makes one, nor calls a function of Lucium by the name another
// browser gives its own (end of this file). A name that has to stay is in an exception below, with its reason; any other fails here.
// The engine under Lucium is not named either: the interface says « le moteur » / « the engine » (see « the name of the engine » below).
// Here because it reads files (the shared tests also build for the renderer, which has no `node:fs`).

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { posix } from './windows.test-support'
import { en } from '@shared/i18n-en'
import { fr } from '@shared/i18n-fr'

// "Chromium" is not here: it is the engine Lucium is built on (through Electron), not a browser a person uses, and the README and the changelogs
// name it as such. The texts of the interface are held to « le moteur » by their own test below. "Apple" is not here either: the texts name it as
// the maker of macOS and of the Mac, never of a browser.
// Lower-case words are not names: `chrome://`, the `chrome.*` APIs and the domains (`clients2.google.com`) are technical.
const BROWSER_NAMES = /\b(?:Arc|The Browser Company|Chrome|Safari|Firefox|Brave|Edge|Vivaldi|Zen|Opera|Orion|Dia|Google|Mozilla|Microsoft|LibreWolf|Waterfox|Floorp|Yandex)\b/

/** A name that may stay, where, and why. `phrase` is taken out of the text before it is searched. */
interface Exception {
  phrase: string
  why: string
}

/** Everywhere: the real service where extensions are installed from. The settings, the menus and the review sheet must say which store it is. */
const EVERYWHERE: readonly Exception[] = [{ phrase: 'Chrome Web Store', why: 'the store extensions are installed from: the name of the service' }]

/** In one text of the catalogues (by key, in both languages). */
const IN_CATALOGUE: Readonly<Record<string, readonly Exception[]>> = {
  'guide.moteur-google': [{ phrase: 'Google', why: 'a search engine the user can choose: the name of the service' }],
  'guide.moteur-google-effet': [{ phrase: 'Google', why: 'says which service the searches go to' }],
  'guide.moteur-brave': [{ phrase: 'Brave Search', why: 'a search engine the user can choose: the name of the service' }],
  'guide.moteur-brave-effet': [{ phrase: 'Brave Search', why: 'says which service the searches go to' }],
  'engine-status.cette-variante-contacte-le-service-de-composants-de-google': [{ phrase: 'Google', why: 'says who the DRM build contacts at start-up (Widevine): honesty about the connections' }],
  'menu-actions.sans-action-de-votre-part-partent-du-reseau': [{ phrase: 'Google', why: 'the privacy policy says who the DRM build contacts at each launch (Widevine): honesty about the connections' }],
  'menu-actions.a-votre-demande-seulement-le-chrome-web-store': [{ phrase: 'Mozilla', why: 'the privacy policy says who hosts the translation models it downloads on request: honesty about the connections' }],
  // The guide for people who have just imported from Arc (shared/arc-guide.ts): it is about that browser, so it names it twice and nowhere else.
  'arc-guide.vous-venez-d-arc': [{ phrase: 'Arc', why: 'the title of the guide for people coming from that browser, and the Aide entry that opens it again' }],
  'arc-guide.ancien-little-arc': [{ phrase: 'Little Arc', why: 'the old name of the mini window, shown in the guide beside the name Lucium gives it (the text is that name and nothing else)' }]
}

/**
 * In the README, only in the table of the connections Lucium makes by itself: who receives what must be named for the list to be honest.
 * The domains are written in lower case and need no exception.
 */
const IN_CONNECTIONS: readonly Exception[] = [
  { phrase: 'Brave Search', why: 'a search engine the suggestions can go to' },
  { phrase: 'Google', why: 'a search engine, the component service of the DRM build, the CDN of the spelling dictionaries' },
  { phrase: 'Mozilla', why: 'the host of the translation models (Bergamot)' }
]

const without = (text: string, exceptions: readonly Exception[]): string => exceptions.reduce((rest, { phrase }) => rest.split(phrase).join(' '), text)

/** The names a text still holds once its exceptions are taken out. */
const namesIn = (text: string, exceptions: readonly Exception[] = []): string[] => {
  const rest = without(without(text, exceptions), EVERYWHERE)
  return [...rest.matchAll(new RegExp(BROWSER_NAMES.source, 'g'))].map((match) => match[0])
}

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')

/** The lines of the table of connections: from its header row to the first line that is not a row. */
function connectionRows(readme: string): Set<number> {
  const lines = readme.split('\n')
  const start = lines.findIndex((line) => /^\| Conn(?:ection|exion)\b/.test(line))
  const rows = new Set<number>()
  for (let at = start; start >= 0 && at < lines.length && lines[at]!.startsWith('|'); at++) rows.add(at)
  return rows
}

describe('the names of other browsers', () => {
  it('finds a name, and only a name: the search is not fooled by lower case, by a longer word or by an exception', () => {
    expect(namesIn('Importé depuis Arc : 3 onglets')).toEqual(['Arc'])
    expect(namesIn('comme Safari et Microsoft Edge')).toEqual(['Safari', 'Microsoft', 'Edge'])
    expect(namesIn('chrome://settings, chrome.tabs, clients2.google.com, archive, Arcade, Chromium, la puce Apple')).toEqual([])
    expect(namesIn('Ouvrir le Chrome Web Store')).toEqual([])
    expect(namesIn('Google et Chrome', [{ phrase: 'Google', why: 'test' }])).toEqual(['Chrome'])
  })

  it('are in no text of the interface, French or English, outside the exceptions', () => {
    for (const key of Object.keys(IN_CATALOGUE)) expect(fr, key).toHaveProperty([key])
    const offending = [
      ...Object.entries(fr).map(([key, text]) => ['fr', key, text] as const),
      ...Object.entries(en).map(([key, text]) => ['en', key, text] as const)
    ].flatMap(([language, key, text]) => namesIn(text, IN_CATALOGUE[key]).map((name) => `${language}:${key} « ${name} »`))
    expect(offending).toEqual([])
  })

  it('are in no line of the changelogs the « Nouveautés » sheet shows', () => {
    for (const file of ['CHANGELOG.md', 'CHANGELOG.fr.md']) {
      const offending = read(file).split('\n').flatMap((line, at) => namesIn(line).map((name) => `${file}:${at + 1} « ${name} »`))
      expect(offending, file).toEqual([])
    }
  })

  it('are in the READMEs only where the connections Lucium makes are listed', () => {
    for (const file of ['README.md', 'README.fr.md']) {
      const readme = read(file)
      const table = connectionRows(readme)
      expect(table.size, `${file}: the table of connections`).toBeGreaterThan(5)
      const offending = readme.split('\n').flatMap((line, at) => namesIn(line, table.has(at) ? IN_CONNECTIONS : []).map((name) => `${file}:${at + 1} « ${name} »`))
      expect(offending, file).toEqual([])
    }
  })
})

// The engine under Lucium (Chromium, through Electron) is « le moteur » / « the engine » in everything a person reads: what it refuses, what it decides
// on its own, what it does not allow. Its name stays only where it is data: the version a bug report quotes, and the family of the browsers a file
// to import comes from. Code comments and logs are for the developers and keep it.
const ENGINE_NAME = /\bChromium\b/

/** In one text of the catalogues (by key, in both languages): where the name of the engine is data, not wording. */
const ENGINE_IN_CATALOGUE: Readonly<Record<string, readonly Exception[]>> = {
  'engine-status.versions-line': [{ phrase: 'Chromium', why: 'the versions line of the engine status and of a bug report: "Electron 45 · Chromium 156", what whoever reads the report needs' }],
  'import-sources.navigateur-chromium': [{ phrase: 'Chromium', why: 'the neutral name of a browser one imports from: the family of its files, as « Navigateur basé sur Gecko » says another' }],
  'import-sources.autre-navigateur-blurb': [{ phrase: 'Chromium', why: 'says which file of a browser missing from the list belongs to which family of browsers (« Bookmarks » is the Chromium one)' }]
}

/** A line of code (not of a comment) that may name the engine: the file, the line, and why. */
interface InlineException {
  file: string
  line: RegExp
  why: string
}

const ENGINE_INLINE: readonly InlineException[] = [
  { file: 'src/shared/about.ts', line: /`Chromium \$\{engine\.chromium\}`/, why: 'the engine line of the About window and of a bug report ("Chromium 156 · Electron 45 · macOS"): a version' },
  { file: 'src/renderer/EngineStatus.tsx', line: /<Row label="Chromium">/, why: 'the row that gives the version of the engine in the engine status: a version' },
  { file: 'src/main/shell/app-menu-wiring.ts', line: /· Chromium \$\{info\.chromium\}/, why: 'the versions at the head of the diagnostic copied to the clipboard for a bug report' },
  { file: 'src/shared/import-sources.ts', line: /'org\.chromium\.Chromium'/, why: 'the application the import looks for on the disk, with its name: it is a browser one imports from' },
  { file: 'src/main/platform/paths.ts', line: /chromium: \{ win32: 'Chromium\\\\User Data'/, why: 'the folder of the profile of that browser on Windows' },
  { file: 'src/main/platform/paths.ts', line: /'\.var\/app\/org\.chromium\.Chromium\//, why: 'the flatpak folder of that browser on Linux: a Flathub identifier, the browser one imports from' },
  { file: 'src/main/electron-watch.ts', line: /Chromium/, why: 'the report of the maintenance script that watches Electron releases (pnpm electron:watch), read by the maintainer in a terminal' },
  { file: 'src/main/chromium-watch-issue.ts', line: /Chromium/, why: 'the GitHub issue the daily watch opens for the maintainer (scripts/chromium-watch-issue.mjs): it announces a version of the engine, and is not part of the application' }
]

/** The part of a line that is code: a trailing line comment and the short block comments are cut, and a line that only continues a block comment is nothing. */
function codeOf(line: string): string {
  const trimmed = line.trim()
  if (trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
  return line.replace(/\/\*.*?\*\//g, '').replace(/(^|\s)\/\/.*$/, '').trim()
}

/** What comes before a name in a log, which is for the developers: `console.warn('[downloads] …`, `log('[widevine] …`, a message that starts with the tag of its subsystem. */
const IS_LOG = /(?:console\.\w+|\blog)\(|['"`]\[[\w-]+\] /

/** The sources of the application that a person's screen can come from: no test, no smoke test (they run the application), no catalogue (tested by key). */
function* applicationSources(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('out-')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* applicationSources(path)
    else if (/\.tsx?$/.test(entry.name) && !/\.test(?:-support)?\.tsx?$|^smoke|^i18n-(?:fr|en)\.ts$/.test(entry.name)) yield path
  }
}

describe('the name of the engine', () => {
  it('finds the name and only the name: a word that holds it, a version or a comment is not it', () => {
    expect(ENGINE_NAME.test('Chromium décide seul')).toBe(true)
    expect(ENGINE_NAME.test('compareChromium, readChromiumHistory, engine.chromium, le moteur')).toBe(false)
    expect(codeOf('  // Chromium decides')).toBe('')
    expect(codeOf(' * Chromium decides')).toBe('')
    expect(codeOf('const a = 1 // Chromium')).not.toMatch(ENGINE_NAME)
    expect(codeOf("label('https://chromium.org')")).not.toMatch(ENGINE_NAME)
    expect(codeOf("<Row label=\"Chromium\">")).toMatch(ENGINE_NAME)
    const beforeName = (code: string): string => code.slice(0, code.search(ENGINE_NAME))
    expect(IS_LOG.test(beforeName("console.warn('[downloads] Chromium would not resume')"))).toBe(true)
    expect(IS_LOG.test(beforeName("this.ports.log('error', `[downloads] Chromium refused`)"))).toBe(true)
    expect(IS_LOG.test(beforeName("writeText(`${v} · Chromium`).catch(() => console.error('[menu] x'))"))).toBe(false)
    expect(IS_LOG.test(beforeName("{ label: 'Chromium' }"))).toBe(false)
  })

  it('is in no text of the interface, French or English, outside the few places where it is a version or a family of browsers', () => {
    for (const key of Object.keys(ENGINE_IN_CATALOGUE)) expect(fr, key).toHaveProperty([key])
    const offending = [
      ...Object.entries(fr).map(([key, text]) => ['fr', key, text] as const),
      ...Object.entries(en).map(([key, text]) => ['en', key, text] as const)
    ].flatMap(([language, key, text]) => (ENGINE_NAME.test(without(text, ENGINE_IN_CATALOGUE[key] ?? [])) ? [`${language}:${key} « ${text.slice(0, 80)} »`] : []))
    expect(offending).toEqual([])
    // Each exception is still needed, in both languages: one that no longer names the engine is removed.
    for (const key of Object.keys(ENGINE_IN_CATALOGUE)) for (const catalogue of [fr, en] as Array<Record<string, string>>) expect(catalogue[key], key).toMatch(ENGINE_NAME)
    expect(fr['privacy-extra-settings.desactive-le-moteur-decide-seul-mode']).toBe('Désactivé, le moteur décide seul (mode automatique) : c’est le réglage par défaut.')
    expect(en['privacy-extra-settings.desactive-le-moteur-decide-seul-mode']).toBe('When off, the engine decides on its own (automatic mode): this is the default setting.')
  })

  it('is in no text written in the code of the application either, but the versions and the browsers one imports from; its logs and its comments keep it', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const seen = new Set<InlineException>()
    const offending: string[] = []
    for (const path of applicationSources(join(root, 'src'))) {
      // The exceptions name their file with `/`: the path of a file is read the same way on Windows.
      const file = posix(path.slice(root.length))
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, at) => {
          const code = codeOf(line)
          if (!ENGINE_NAME.test(code) || IS_LOG.test(code.slice(0, code.search(ENGINE_NAME)))) return
          const allowed = ENGINE_INLINE.find((exception) => exception.file === file && exception.line.test(code))
          if (allowed) seen.add(allowed)
          else offending.push(`${file}:${at + 1} ${code.trim().slice(0, 100)}`)
        })
    }
    expect(offending).toEqual([])
    // Each exception still matches a line: one that no longer does is removed, so that the list cannot outlive what it excuses.
    expect(ENGINE_INLINE.filter((exception) => !seen.has(exception)).map((exception) => `${exception.file} ${exception.line}`)).toEqual([])
  })
})

// Lucium's functions have names of their own: a Tweak (« Retouche ») restyles a site with its CSS, its JavaScript, the elements it hides
// and its colours; the Eraser (« Gomme ») picks the elements a Tweak hides; a Glance (« Coup d’œil ») previews a link on ⇧-click.
// The names another browser gives the same functions (and their verbs: « Booster ce site », « zapper ») are in no text a person reads.
// Any word that starts with one of them counts, in any case. What is taken out first is not a word for a reader: the extension of the
// files a Tweak is shared in (people's files must keep opening), a {variable} of a text, and the identifiers a document quotes as code.
const OLD_FEATURE_NAMES = /\b(?:boost|peek|zap)\w*/gi

/**
 * In one text of the catalogues (by key, in both languages): an old name the guide for people coming from Arc shows beside the name Lucium gives the
 * function (shared/arc-guide.ts). The text of such a key is that name and nothing else; every sentence around it says the new name.
 */
const OLD_NAMES_IN_CATALOGUE: Readonly<Record<string, readonly Exception[]>> = {
  'arc-guide.ancien-boosts': [{ phrase: 'Boosts', why: 'the old name of the Tweaks, in the guide for people coming from that browser' }],
  'arc-guide.ancien-peek': [{ phrase: 'Peek', why: 'the old name of the Glance, in the guide for people coming from that browser' }]
}

/** Taken out before the search, everywhere, with why. */
const NOT_WORDS: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\.lucium-boost\b/g, why: 'the extension of a shared Tweak: the format of the files people already have' },
  { pattern: /\{\w+\}/g, why: 'a variable of a catalogue text ({boosts}, {BOOST_LINK_PREFIX}): replaced before anyone reads it' },
  { pattern: /`[^`\n]*`/g, why: 'code in a Markdown document: an identifier, a file, a setting or a format (`boost.ts`, `boost-sharing`)' },
  { pattern: /\]\([^)\s]*\)/g, why: 'the target of a Markdown link: the path of a file' }
]

/** The old names a text still holds once what is not a word, and its exceptions, are taken out. */
const oldNamesIn = (text: string, exceptions: readonly Exception[] = []): string[] => {
  const rest = NOT_WORDS.reduce((left, { pattern }) => left.replace(pattern, ' '), without(text, exceptions))
  return [...rest.matchAll(OLD_FEATURE_NAMES)].map((match) => match[0])
}

describe('the names of the functions', () => {
  it('finds an old name in any form and any case, and leaves alone what is not a word for a reader', () => {
    expect(oldNamesIn('Booster ce site · 3 Boosts · le mode Zap · les zapper · un Peek')).toEqual(['Booster', 'Boosts', 'Zap', 'zapper', 'Peek'])
    expect(oldNamesIn('Boost This Site · zapped · peeking')).toEqual(['Boost', 'zapped', 'peeking'])
    expect(oldNamesIn('Fichier .lucium-boost · {boosts} Retouches · « {BOOST_LINK_PREFIX} » · `boostsFor` · [code](src/shared/boost.ts)')).toEqual([])
    expect(oldNamesIn('une Retouche, la Gomme, le Coup d’œil · a Tweak, the Eraser, a Glance')).toEqual([])
  })

  it('lets a text keep the old name its exception names, and only that one', () => {
    expect(oldNamesIn('Boosts', OLD_NAMES_IN_CATALOGUE['arc-guide.ancien-boosts'])).toEqual([])
    expect(oldNamesIn('Boosts et Peek', OLD_NAMES_IN_CATALOGUE['arc-guide.ancien-boosts'])).toEqual(['Peek'])
    expect(oldNamesIn('Peek', OLD_NAMES_IN_CATALOGUE['arc-guide.ancien-boosts'])).toEqual(['Peek'])
  })

  it('are shown beside the new ones only by the keys that say so, and those texts are the old name alone', () => {
    for (const [key, exceptions] of Object.entries(OLD_NAMES_IN_CATALOGUE)) {
      for (const catalogue of [fr, en] as Array<Record<string, string>>) expect(exceptions.map((exception) => exception.phrase), key).toContain(catalogue[key])
    }
  })

  it('are the new ones in every text of the interface, French and English', () => {
    const offending = [
      ...Object.entries(fr).map(([key, text]) => ['fr', key, text] as const),
      ...Object.entries(en).map(([key, text]) => ['en', key, text] as const)
    ].flatMap(([language, key, text]) => oldNamesIn(text, OLD_NAMES_IN_CATALOGUE[key]).map((name) => `${language}:${key} « ${name} »`))
    expect(offending).toEqual([])
    expect(fr['site-panel.retouches']).toBe('Retouches')
    expect(en['site-panel.retouches']).toBe('Tweaks')
  })

  it('are the new ones in the changelogs and the READMEs', () => {
    for (const file of ['CHANGELOG.md', 'CHANGELOG.fr.md', 'README.md', 'README.fr.md']) {
      const offending = read(file).split('\n').flatMap((line, at) => oldNamesIn(line).map((name) => `${file}:${at + 1} « ${name} »`))
      expect(offending, file).toEqual([])
    }
  })
})
