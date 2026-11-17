// Which exports of a folder no product code reads: the ones only tests import (a helper or a guard that looks protected and protects nothing),
// and the ones nobody imports at all. Read from the text of the files, by whole word: an export counts as used as soon as its name appears
// in another product file, or a second time in its own file. So a name shared with something else hides an unused export; it never invents one.

/** A file that checks the product instead of being it: unit tests, their supports, the engine suites, the end-to-end tests. */
export const isTestFile = (path: string): boolean => /\.test\.tsx?$|test-support\.ts$|(^|\/)smoke[^/]*\.ts$|^tests\//.test(path)

/** The text without its comments. A comment starts at the start of a line or after a space: not inside `https://`, a regular expression or the pattern `'/*'`. */
export const withoutComments = (source: string): string => source.replace(/(?<![^\s])\/\*[\s\S]*?\*\//g, '').replace(/(?<![^\s])\/\/.*$/gm, '')

export interface ExportWithoutUser {
  file: string
  name: string
  /** `tests`: only tests name it. `nobody`: nothing does. */
  readBy: 'tests' | 'nobody'
}

const DECLARATION = /^export (?:declare )?(?:async )?(?:function\*?|const|let|class|type|interface|enum) ([A-Za-z_$][\w$]*)/gm

/** How many times each name is written in a text: whole words only, as the compiler reads an identifier. */
function names(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const [name] of text.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*/g)) counts.set(name, (counts.get(name) ?? 0) + 1)
  return counts
}

/** The exports declared in the product files under `folder` (a path prefix such as `src/shared/`) that no product file reads. `files` maps a path to its text. */
export function exportsWithoutProductUser(files: Readonly<Record<string, string>>, folder: string): ExportWithoutUser[] {
  const texts = Object.entries(files).map(([path, source]) => {
    const text = withoutComments(source)
    return { path, test: isTestFile(path), text, names: names(text) }
  })
  const found: ExportWithoutUser[] = []
  for (const own of texts) {
    if (own.test || !own.path.startsWith(folder)) continue
    for (const match of own.text.matchAll(DECLARATION)) {
      const name = match[1]!
      if ((own.names.get(name) ?? 0) > 1) continue
      const readers = texts.filter((other) => other !== own && other.names.has(name))
      if (!readers.some((other) => !other.test)) found.push({ file: own.path, name, readBy: readers.length > 0 ? 'tests' : 'nobody' })
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name))
}
