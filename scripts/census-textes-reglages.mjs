// Census of the texts written in the code instead of the catalogues (French strings that do not go through t('…'), and the other browsers named in a text).
//
//   node scripts/census-textes-reglages.mjs              the Settings panes: the texts written in the code (not through t), with the count per file
//   node scripts/census-textes-reglages.mjs --all        every string of the panes, even those that do not read as a text (to read what the filter left out)
//   node scripts/census-textes-reglages.mjs --code       the main process, the shared code, the preload scripts and the folders of src/renderer
//   node scripts/census-textes-reglages.mjs --code --all the same, with the exceptions of src/main/code-text-scan.ts shown (marked « kept »)
//   node scripts/census-textes-reglages.mjs --json       the same as JSON
//
// It reads the same files, with the same scanner, as the tests that keep them clean (src/main/settings-text-source.test.ts for the panes,
// src/main/code-text-source.test.ts for --code). The scanner is TypeScript: this needs a Node that strips types (22.18 or later), no flag.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PENDING_PANE_FILES, isPaneFile, namesOtherBrowser, scanSource } from '../src/main/settings-text-scan.ts'
import { PENDING_CODE_FILES, codeFiles, counts, exceptionOf } from '../src/main/code-text-scan.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const renderer = join(root, 'src/renderer')

/** The files of the Settings window: its shell, its parts, every pane written in its own file, and the panes not converted yet (marked below). */
export function settingsFiles() {
  return readdirSync(renderer)
    .filter((name) => isPaneFile(name) || PENDING_PANE_FILES.includes(name))
    .sort()
    .map((name) => join(renderer, name))
}

const args = new Set(process.argv.slice(2))
const everything = args.has('--all')
const code = args.has('--code')
const all = []
if (code) {
  for (const file of codeFiles(root)) {
    for (const found of scanSource(file, readFileSync(join(root, file), 'utf8')).filter(counts)) {
      const kept = exceptionOf(found)
      if (kept && !everything) continue
      all.push(kept ? { ...found, kept: kept[2] } : found)
    }
  }
} else {
  for (const file of settingsFiles()) {
    const found = scanSource(relative(root, file), readFileSync(file, 'utf8'), { everything })
    all.push(...found)
  }
}

const pending = (file) => (code ? file in PENDING_CODE_FILES : PENDING_PANE_FILES.some((name) => file.endsWith(name)))

if (args.has('--json')) {
  console.log(JSON.stringify(all, null, 2))
} else {
  const perFile = new Map()
  for (const f of all) perFile.set(f.file, (perFile.get(f.file) ?? 0) + 1)
  for (const f of all) {
    const marks = [f.french ? '' : '\t(not French)', namesOtherBrowser(f.text) ? '\t(names another browser)' : '', f.kept ? `\t(kept: ${f.kept})` : ''].join('')
    console.log(`${f.file}:${f.line}:${f.column}\t${f.kind}${f.attribute ? `[${f.attribute}]` : ''}${f.declaration ? ` in ${f.declaration}` : ''}${marks}\t${f.text}`)
  }
  console.log(`\n${all.length} texts`)
  for (const [file, count] of [...perFile].sort()) console.log(`  ${String(count).padStart(3)}  ${file}${pending(file) ? '  (not converted yet, not checked by the test)' : ''}`)
}
