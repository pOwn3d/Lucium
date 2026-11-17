// The typefaces Lucium carries for Tweaks (resources/fonts, licences in resources/fonts/LICENSES.md): the script that gives a page one of them.
// The bytes go into the page as a FontFace, not as a URL: many sites forbid fonts from anywhere but their own origin (content security
// policy), which refuses a data: URL and a custom scheme alike, but not a font made from bytes.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { bundledFaceName, fontFaceScript, type BoostFont } from '@shared/boost'
import { isBuiltApp } from '../runtime'

/** Where the files are: next to the other resources of a packaged application, in the repository while developing. */
export function fontsFolder(): string {
  return join(isBuiltApp() ? process.resourcesPath : app.getAppPath(), isBuiltApp() ? 'fonts' : 'resources/fonts')
}

/** What a font file is called: the ids of the grid, never anything typed. */
const FILE_NAME = /^[a-z0-9-]+$/

/** The script of each font, made once (reading and encoding a file of some 50 KB is not done for every page). */
const scripts = new Map<string, Promise<string>>()

/** The script that adds the font to a page; rejects when the font is not a bundled one or its file cannot be read. */
export function fontScript(font: BoostFont): Promise<string> {
  const face = bundledFaceName(font)
  if (!font.file || !face || !FILE_NAME.test(font.file)) return Promise.reject(new Error(`${font.id} is not a bundled font`))
  const known = scripts.get(font.file)
  if (known) return known
  const made = readFile(join(fontsFolder(), `${font.file}.woff2`)).then((bytes) => fontFaceScript(face, bytes.toString('base64')))
  // A file that cannot be read is tried again the next time (it may be a passing error), not remembered as a failure.
  made.catch(() => scripts.delete(font.file as string))
  scripts.set(font.file, made)
  return made
}
