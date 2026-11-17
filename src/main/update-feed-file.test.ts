// The release file `node scripts/make-update-feed.mjs` writes (update-feed-file.ts), read back by Lucium's check: one file for Squirrel and for Lucium.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SQUIRREL_VERSION, parseFeed, updateOutcome } from '@shared/update-check'
import { setLanguage } from '@shared/i18n'
import { NOTES_MAX, RELEASE_VERSION, notesFromChangelog, releaseFile, releaseProblems, shortNotes, squirrelDate, type ReleaseFacts } from './update-feed-file'

const facts = (over: Partial<ReleaseFacts> = {}): ReleaseFacts => ({
  version: '0.2.1',
  base: 'https://test.lucium.app/updates/darwin-arm64/',
  fileName: 'Lucium-0.2.1-arm64.zip',
  sha256: 'ab'.repeat(32),
  size: 128172732,
  date: new Date('2026-11-06T09:00:00.123Z'),
  notes: 'Essai du parcours de mise à jour.',
  ...over
})

describe('releaseFile', () => {
  it('writes Squirrel.Mac’s release file: the current release, its archive, its digest and size, the date as Squirrel parses it', () => {
    expect(releaseFile(facts())).toEqual({
      currentRelease: '0.2.1',
      page: 'https://test.lucium.app/telecharger/',
      en: { page: 'https://test.lucium.app/en/download/', notes: 'Lucium 0.2.1.' },
      releases: [
        {
          version: '0.2.1',
          updateTo: {
            version: '0.2.1',
            name: 'Lucium 0.2.1',
            notes: 'Essai du parcours de mise à jour.',
            pub_date: '2026-11-06T09:00:00Z',
            url: 'https://test.lucium.app/updates/darwin-arm64/Lucium-0.2.1-arm64.zip',
            sha256: 'ab'.repeat(32),
            size: 128172732
          }
        }
      ]
    })
  })

  it('is read by Lucium’s check as the offer Squirrel would install, newer than the running 0.2.0', () => {
    const file = JSON.parse(JSON.stringify(releaseFile(facts())))
    expect(parseFeed(file)).toEqual({
      version: '0.2.1',
      url: 'https://test.lucium.app/telecharger/',
      notes: 'Essai du parcours de mise à jour.',
      archive: 'https://test.lucium.app/updates/darwin-arm64/Lucium-0.2.1-arm64.zip',
      size: 128172732
    })
    expect(updateOutcome('0.2.0', 'https://test.lucium.app/updates/darwin-arm64/feed.json', { ok: true, json: file })).toMatchObject({ kind: 'available' })
    expect(updateOutcome('0.2.1', 'https://test.lucium.app/updates/darwin-arm64/feed.json', { ok: true, json: file })).toMatchObject({ kind: 'up-to-date' })
  })

  it('keeps the notes short, on one line, and never empty; takes the page it is given', () => {
    const long = releaseFile(facts({ notes: `${'Une phrase.\n'.repeat(60)}` })).releases[0]!.updateTo.notes
    expect(long.length).toBe(NOTES_MAX)
    expect(long).not.toContain('\n')
    expect(long.endsWith('…')).toBe(true)
    expect(releaseFile(facts({ notes: '  ' })).releases[0]!.updateTo.notes).toBe('Lucium 0.2.1.')
    expect(releaseFile(facts({ page: 'https://lucium.app/telecharger/' })).page).toBe('https://lucium.app/telecharger/')
  })

  it('never cuts the notes in the middle of a word: after the last whole title of a list, else after the last whole word', () => {
    const titles = ['Barre latérale fenêtre par fenêtre', 'Traduction en un clic', 'Traduction de page plus rapide', 'Barre latérale et extensions']
    const list = titles.join(' ; ')
    expect(shortNotes(list, 200)).toBe(list)
    // 100 characters end inside « Barre latérale et extensions »: the three whole titles stay, the fourth goes.
    expect(list.slice(0, 99)).toMatch(/ ; Barre$/)
    expect(shortNotes(list, 100)).toBe(`${titles.slice(0, 3).join(' ; ')}…`)
    expect(shortNotes('First thing; Second thing; Third thing', 30)).toBe('First thing; Second thing…')
    // A sentence: the last whole word, and a word that ends exactly at the limit is whole.
    expect(shortNotes('Une phrase plutôt longue sans liste', 20)).toBe('Une phrase plutôt…')
    expect(shortNotes('Une phrase plutôt longue sans liste', 25)).toBe('Une phrase plutôt longue…')
    // One word longer than the room has no better place to be cut.
    expect(shortNotes('a'.repeat(50), 10)).toBe(`${'a'.repeat(9)}…`)
    for (const max of [10, 17, 33, 64]) expect(shortNotes(list, max).length, String(max)).toBeLessThanOrEqual(max)
    const written = releaseFile(facts({ notes: `${titles.join(' ; ')} ; `.repeat(6) })).releases[0]!.updateTo.notes
    expect(written.length).toBeLessThanOrEqual(NOTES_MAX)
    expect(titles.some((title) => written.endsWith(`${title}…`))).toBe(true)
  })

  it('carries the notes and the page of an interface in English, which Lucium shows in English and only then', () => {
    const file = JSON.parse(JSON.stringify(releaseFile(facts({ notesEn: 'A trial of the\nupdate path.' }))))
    expect(file.en).toEqual({ page: 'https://test.lucium.app/en/download/', notes: 'A trial of the update path.' })
    expect(releaseFile(facts({ pageEn: 'https://lucium.app/en/download/' })).en.page).toBe('https://lucium.app/en/download/')
    expect(releaseProblems(facts({ pageEn: 'http://lucium.app/en/download/' }))).toEqual([expect.stringMatching(/page in English must be https/)])
    try {
      setLanguage('en')
      expect(parseFeed(file)).toMatchObject({ url: 'https://test.lucium.app/en/download/', notes: 'A trial of the update path.' })
      setLanguage('fr')
      expect(parseFeed(file)).toMatchObject({ url: 'https://test.lucium.app/telecharger/', notes: 'Essai du parcours de mise à jour.' })
    } finally {
      setLanguage('fr')
    }
  })

  it('refuses, all at once, what Squirrel or Lucium would read wrong', () => {
    expect(releaseProblems(facts())).toEqual([])
    const problems = releaseProblems(facts({ version: 'v0.2.1', base: 'http://test.lucium.app/updates', fileName: 'Lucium 0.2.1.zip', sha256: 'xyz', size: 0, date: new Date('nope'), page: 'http://x' }))
    expect(problems).toHaveLength(7)
    expect(() => releaseFile(facts({ version: '0.2.1-beta' }))).toThrow(/digits and dots/)
    expect(releaseProblems(facts({ fileName: 'Lucium-0.2.0-arm64.zip' }))).toEqual([expect.stringMatching(/does not carry its version 0\.2\.1/)])
    expect(releaseProblems(facts({ base: 'https://user:secret@test.lucium.app/updates/' }))).toHaveLength(1)
    expect(releaseProblems(facts({ base: 'https://test.lucium.app/updates/?x=1' }))).toHaveLength(1)
  })

  it('accepts the versions the check accepts, and only those: one rule for both readers', () => {
    expect(RELEASE_VERSION.source).toBe(SQUIRREL_VERSION.source)
  })

  it('writes the date without the fraction of a second Squirrel would not read', () => {
    expect(squirrelDate(new Date('2026-11-06T09:00:00.999Z'))).toBe('2026-11-06T09:00:00Z')
  })
})

describe('notesFromChangelog', () => {
  const changelog = ['# Journal', '', '## [0.2.1] - 2026-11-06', '', 'Un correctif.', 'Sur deux lignes.', '', '### Corrections', '', '- **Titre** : texte.', '', '## [0.2.0] - Unreleased', '', '- **Autre** : x.'].join('\n')

  it('takes the first paragraph of the version’s section', () => {
    expect(notesFromChangelog(changelog, '0.2.1')).toBe('Un correctif. Sur deux lignes.')
  })

  it('falls back on the bold titles of its entries, and gives nothing for a version it does not have', () => {
    expect(notesFromChangelog(changelog, '0.2.0')).toBe('Autre')
    expect(notesFromChangelog(changelog, '9.9.9')).toBe('')
  })

  it('joins the titles as the language of the changelog writes a list: « ; » with a space in French, without in English', () => {
    const titles = ['## [1.0.0] - 2026-12-01', '', '- **First** text.', '- **Second** text.'].join('\n')
    expect(notesFromChangelog(titles, '1.0.0')).toBe('First ; Second')
    expect(notesFromChangelog(titles, '1.0.0', '; ')).toBe('First; Second')
  })

  it('reads the real changelog of the project', () => {
    const real = readFileSync(fileURLToPath(new URL('../../CHANGELOG.fr.md', import.meta.url)), 'utf8')
    expect(notesFromChangelog(real, '0.2.0')).toMatch(/^La première version publique de Lucium/)
  })
})

describe('scripts/make-update-feed.mjs', () => {
  const script = readFileSync(fileURLToPath(new URL('../../scripts/make-update-feed.mjs', import.meta.url)), 'utf8')

  it('writes the file of update-feed-file.ts, from the version of the app inside the archive checked against package.json', () => {
    expect(script).toMatch(/await import\('\.\.\/src\/main\/update-feed-file\.ts'\)/)
    expect(script).toMatch(/'-extract', 'CFBundleShortVersionString'/)
    expect(script).toMatch(/if \(version !== packageVersion\) throw/)
    expect(script).toMatch(/createHash\('sha256'\)/)
  })
})
