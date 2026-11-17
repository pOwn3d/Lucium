import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The fonts Lucium carries were downloaded once, from an address that said « latest »: nothing but the files says which version they are. Their
// licence file pins each one (the version it declares, its size, its SHA-256), and this test ties the files to that table: a font replaced, updated
// or added without its line is refused, and so is a line whose file is gone.
const FONTS = fileURLToPath(new URL('../../resources/fonts', import.meta.url))

interface PinnedFont {
  file: string
  version: string
  size: number
  sha256: string
}

/** The rows of the table « Version et empreinte de chaque fichier » of a licence file of the fonts. */
export function pinnedFonts(licences: string): PinnedFont[] {
  return [...licences.matchAll(/^\| `([^`]+\.woff2)` \| (Version [^|]+?) \| (\d+) \| `([0-9a-f]{64})` \|$/gm)].map((row) => ({
    file: row[1]!,
    version: row[2]!,
    size: Number(row[3]),
    sha256: row[4]!
  }))
}

/** What is wrong between the files of a folder and the table that pins them; empty when each file is the one of its line. */
export function fontProblems(pinned: readonly PinnedFont[], files: readonly { file: string; size: number; sha256: string }[]): string[] {
  const problems: string[] = []
  for (const { file, size, sha256 } of files) {
    const row = pinned.find((entry) => entry.file === file)
    if (!row) problems.push(`${file}: no line in LICENSES.md`)
    else if (row.sha256 !== sha256 || row.size !== size) problems.push(`${file}: not the file its line pins (${size} bytes, ${sha256})`)
  }
  for (const { file } of pinned) if (!files.some((entry) => entry.file === file)) problems.push(`${file}: pinned in LICENSES.md, not in the folder`)
  return problems
}

describe('the fonts of resources/fonts', () => {
  const licences = readFileSync(join(FONTS, 'LICENSES.md'), 'utf8')
  const pinned = pinnedFonts(licences)
  const files = readdirSync(FONTS)
    .filter((file) => file.endsWith('.woff2'))
    .map((file) => ({ file, size: statSync(join(FONTS, file)).size, sha256: createHash('sha256').update(readFileSync(join(FONTS, file))).digest('hex') }))

  it('are each the file LICENSES.md pins: same size, same SHA-256, a version written', () => {
    expect(pinned).toHaveLength(10)
    expect(fontProblems(pinned, files)).toEqual([])
  })

  it('have each their copyright line in the table of the rights', () => {
    for (const { file } of files) expect(licences, file).toMatch(new RegExp(`^\\| \`${file.replaceAll('.', '\\.')}\` \\| [^|]+ \\| Copyright [^|]+ \\|$`, 'm'))
  })

  it('travel with the full text of their licence', () => {
    expect(licences).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007')
    expect(licences).toContain('5) The Font Software, modified or unmodified, in part or in whole,')
  })
})

describe('the check of the fonts', () => {
  const row = { file: 'a.woff2', version: 'Version 1.000', size: 3, sha256: 'a'.repeat(64) }

  it('reads the lines of the table, and nothing else', () => {
    expect(pinnedFonts(`| \`a.woff2\` | Version 1.000 | 3 | \`${'a'.repeat(64)}\` |\n| \`a.woff2\` | A | Copyright 2020 A |`)).toEqual([row])
  })

  it('refuses a file that changed, a file without a line and a line without a file', () => {
    expect(fontProblems([row], [{ file: 'a.woff2', size: 3, sha256: 'a'.repeat(64) }])).toEqual([])
    expect(fontProblems([row], [{ file: 'a.woff2', size: 3, sha256: 'b'.repeat(64) }])).toEqual([`a.woff2: not the file its line pins (3 bytes, ${'b'.repeat(64)})`])
    expect(fontProblems([row], [{ file: 'a.woff2', size: 4, sha256: 'a'.repeat(64) }])).toHaveLength(1)
    expect(fontProblems([row], [{ file: 'a.woff2', size: 3, sha256: 'a'.repeat(64) }, { file: 'b.woff2', size: 1, sha256: 'c'.repeat(64) }])).toEqual(['b.woff2: no line in LICENSES.md'])
    expect(fontProblems([row], [])).toEqual(['a.woff2: pinned in LICENSES.md, not in the folder'])
  })
})
