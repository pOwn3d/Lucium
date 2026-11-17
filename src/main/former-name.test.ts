// The project was renamed Lucium on 10 November 2026, with no compatibility kept: no tracked file may name the former project again, in any
// spelling or case (identifiers, variables, texts, docs, scripts). The list of allowed files is empty on purpose; a file that truly has to keep
// the name goes in it with its reason. The pattern and the list are in public-export.ts, which refuses the name again in the files of the export. Here because it reads files (the shared tests also build for the renderer, which has no `node:fs`).

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BINARY, FORMER_NAME as FORMER, FORMER_NAME_ALLOWED as ALLOWED, filesNamingFormer } from './public-export'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    // A file deleted in the working tree and not yet committed is still listed: it is not there to read.
    .filter((path) => path !== '' && !BINARY.test(path) && existsSync(join(ROOT, path)))
}

describe('the former name of the project', () => {
  it('appears in no tracked file, neither in a path nor in a content', () => {
    const found = filesNamingFormer(trackedFiles(), (path) => readFileSync(join(ROOT, path), 'utf8'))
    expect(found).toEqual([])
  })

  it('is found in any spelling and case, and in a path', () => {
    const name = ['Arbal', 'ette'].join('')
    const accented = ['arbal', 'ète'].join('')
    const files: Record<string, string> = {
      'a.ts': `const x = '${name.toUpperCase()}_TEAM'`,
      'b.md': `Le projet ${accented}`,
      [`docs/${name.toLowerCase()}.md`]: 'nothing inside',
      'c.ts': 'Lucium only'
    }
    expect(filesNamingFormer(Object.keys(files), (path) => files[path] ?? '')).toEqual(['a.ts', 'b.md', `docs/${name.toLowerCase()}.md`])
  })

  it('has no allowed file left that no longer needs it', () => {
    const tracked = new Set(trackedFiles())
    const stale = Object.keys(ALLOWED).filter((path) => !tracked.has(path) || !FORMER.test(readFileSync(join(ROOT, path), 'utf8')))
    expect(stale).toEqual([])
  })
})
