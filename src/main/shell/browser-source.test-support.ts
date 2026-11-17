// Test support (nothing of the application imports it): the source of the class Browser as one text. The class is cut into layers (browser.ts,
// browser-base.ts and the browser-*.ts between them); the tests that read the source of the shell look into all of them, in the order of
// the names of the files.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHELL = fileURLToPath(new URL('.', import.meta.url))
const PART = /^browser(?:-[a-z]+)?\.ts$/

export function browserSource(): string {
  return readdirSync(SHELL)
    .filter((name) => PART.test(name))
    .sort()
    .map((name) => readFileSync(join(SHELL, name), 'utf8'))
    .join('\n')
}
