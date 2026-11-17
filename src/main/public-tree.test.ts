// The public repository is made from one export of this tree: `git archive HEAD`, which leaves out every path that .gitattributes marks
// `export-ignore`. The maintainer's notes (the to-do, the working plans, the audit framing, the design notes written for them alone) stay
// tracked in the private repository and must never be in that export; and no exported file may carry what belongs to the maintainer's
// machine or to a report nobody else can read. The rules are in public-export.ts, which applies them again to the files of the export
// (scripts/export-public.mjs). Here because it reads files (the shared tests also build for the renderer, which has no `node:fs`).

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BINARY, INTERNAL_PATHS, OUTSIDE_GPL, UNTRACKED_INTERNAL_PATHS, internalMarks, internalPaths, noticeProblems, realHomes, staleInternalPaths } from './public-export'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const GIT = { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 } as const

/** The paths of a list that .gitattributes marks `export-ignore`, as the working tree has it. */
function exportIgnored(paths: readonly string[]): Set<string> {
  const answer = execFileSync('git', ['check-attr', '-z', '--stdin', 'export-ignore'], { ...GIT, input: paths.join('\0') }).split('\0')
  const ignored = new Set<string>()
  // The answer is a flat list: path, attribute, value, and again.
  for (let i = 0; i + 2 < answer.length; i += 3) if (answer[i + 2] === 'set') ignored.add(answer[i] ?? '')
  return ignored
}

function listed(args: readonly string[]): string[] {
  return execFileSync('git', [...args], GIT).split('\0').filter((path) => path !== '')
}

/** The files of the public tree: the tracked files, less the ones marked `export-ignore`. */
function publicFiles(): string[] {
  const tracked = listed(['ls-files', '-z'])
  const ignored = exportIgnored(tracked)
  return tracked.filter((path) => !ignored.has(path))
}

describe('the tree exported to the public repository', () => {
  const exported = publicFiles()

  it('holds the sources, and none of the internal folders or notes', () => {
    expect(exported).toContain('package.json')
    expect(exported).toContain('docs/design/annotation-partage-fenetre.md')
    expect(internalPaths(exported)).toEqual([])
  })

  it('has no file that names a home folder, a key, a host or a tool of the maintainer, or a finding of an unpublished audit', () => {
    const found = exported
      // A file deleted in the working tree and not yet committed is still listed: it is not there to read.
      .filter((path) => !BINARY.test(path) && existsSync(join(ROOT, path)))
      .flatMap((path) => internalMarks(readFileSync(join(ROOT, path), 'utf8')).map((mark) => `${path}: ${mark}`))
    expect(found).toEqual([])
  })

  it('carries, for each file that is not under the GPL, the notice that says its licence, and NOTICE names it', () => {
    const files = exported.map((path) => ({ path, size: 0, link: false }))
    // The logo and the generated videos are in the tree: the rule is not passing on an empty list.
    for (const group of OUTSIDE_GPL) expect(exported.some((path) => group.files.test(path)), group.notice).toBe(true)
    expect(noticeProblems(files, readFileSync(join(ROOT, 'NOTICE'), 'utf8'))).toEqual([])
  })

  it('is what `git archive` writes: the same files as the list this test reads', () => {
    // Both read the commit, with the attributes of the working tree, so that a change not yet committed does not make them differ.
    const committed = listed(['ls-tree', '-r', '-z', '--name-only', 'HEAD'])
    const ignored = exportIgnored(committed)
    const archive = execFileSync('git', ['archive', '--worktree-attributes', '--format=tar', 'HEAD'], { cwd: ROOT, maxBuffer: 1024 * 1024 * 1024 })
    expect(tarFiles(archive)).toEqual(committed.filter((path) => !ignored.has(path)).sort())
  })

  it('every internal path is still tracked: a line of this list that names nothing is removed with its export-ignore line', () => {
    // The paths that no commit holds on purpose are kept as a guard, and answer in the next test. In the public repository, which is made by the
    // export and holds none of them, there is nothing to find: the same test runs there.
    expect(staleInternalPaths(listed(['ls-files', '-z']))).toEqual([])
  })

  it('tells a stale line in the private repository, and finds none in the public one that holds no internal path', () => {
    const kept = INTERNAL_PATHS.filter((internal) => !UNTRACKED_INTERNAL_PATHS.includes(internal))
    const files = (paths: readonly string[]) => paths.map((path) => (path.endsWith('/') ? `${path}note.md` : path))
    const sources = ['package.json', 'src/main/index.ts', 'docs/design/annotation-partage-fenetre.md']
    // The private repository: every line names something.
    expect(staleInternalPaths([...sources, ...files(kept)])).toEqual([])
    // The public repository: no internal path at all.
    expect(staleInternalPaths(sources)).toEqual([])
    // A line that names nothing in the private repository is told, whichever it is.
    for (const stale of kept) expect(staleInternalPaths([...sources, ...files(kept.filter((internal) => internal !== stale))])).toEqual([stale])
  })

  // A folder that lives on the maintainer's machine only is in no clone, so a clone cannot be asked to track it. What it can be asked: that the line
  // is still a guard, a file of that folder is refused by the rules, and the export leaves it out.
  it('an internal path kept without tracking still refuses a file forced in under it, and has its export-ignore line', () => {
    expect(UNTRACKED_INTERNAL_PATHS.length).toBeGreaterThan(0)
    for (const kept of UNTRACKED_INTERNAL_PATHS) {
      const forced = `${kept}forced-in.md`
      expect(internalPaths([forced]), forced).toEqual([forced])
      expect(exportIgnored([forced]).has(forced), `${forced} has no export-ignore line in .gitattributes`).toBe(true)
    }
  })
})

describe('what marks a file as internal', () => {
  it('a path under an internal folder, or an internal note, and nothing beside them', () => {
    const paths = ['.claude/TODOS.md', 'docs/plans/build.md', 'docs/audit-360/cadrage.md', 'docs/design/barre-collee/ecran-1.png', 'docs/design/fonds-a-la-demande.md']
    expect(internalPaths([...paths, 'docs/design/annotation-partage-fenetre.md', 'docs/planning.md', 'src/.claude-like.ts'])).toEqual(paths)
  })

  it('a home folder that no test invented, whatever follows it', () => {
    // Built from parts, as every example below: this file is exported too, and reads itself.
    const real = ['/Users', 'christophe'].join('/')
    const server = ['/home', 'deploy'].join('/')
    expect(realHomes(`open ${real}/Dev/app and ${server}/site.`)).toEqual(['christophe', 'deploy'])
    expect(realHomes('file:///Users/me/.ssh/id_ed25519, /Users/moi/Downloads/a.zip, /home/u, /Users/../etc/passwd, /Users/x.')).toEqual([])
    // Not a home folder: a folder of the sources named Users, and a pattern.
    expect(realHomes('src/Users/shared.ts and /Users/<name> and /Users/[^/]+')).toEqual([])
  })

  it('a finding of the audit, a document of it, a key, a host and a tool of the maintainer', () => {
    const marked = [
      ['// Refused before the handler (audit', 'F12): no answer.'].join(' '),
      ['// M4 of', 'the audit: these passed.'].join(' '),
      ['(audits', 'M11, F27)'].join(' '),
      ['see SEC', '057'].join('-'),
      // A later reading of an axis, a hypothesis, and an axis the list does not name.
      ['see SEC2', '001'].join('-'),
      ['PUB3', '002: refused'].join('-'),
      ['(SEC3', 'H01)'].join('-'),
      ['DAT', 'H2'].join('-'),
      ['XYZ4', '017'].join('-'),
      ['XYZ', 'H03'].join('-'),
      // The first reading of an axis the list does not name: no number of a reading, no H.
      ['see XYZ', '017'].join('-'),
      ['(QRS', '04)'].join('-'),
      ['MNT', '01, moved'].join('-'),
      ['audit COD2', '7'].join('-'),
      ['docs/audit', 'corrections.md'].join('-'),
      ['~/.ssh', 'coo', 'lify_rsa'].join('/').replace('coo/', 'coo'),
      ['~/.ssh', 'deploy_key'].join('/'),
      ['set in Coo', 'lify'].join(''),
      ['pb-', 'test.lucium.app'].join(''),
      ['Carte he', 'rdr-board n° 8'].join('')
    ]
    for (const text of marked) expect(internalMarks(text), text).not.toEqual([])
    const plain = ['an accessibility audit of the interface', 'the audit token of the sender', 'auditAxTree(nodes)', '~/.ssh/id_ed25519', 'F12 opens the tools', 'UTF-8, ISO-8859-1', 'test.lucium.app', 'SHA-256, SHA2-256 and SHA3-512', 'AES-256-GCM', 'GPL-3.0-or-later', 'CRC-32', '%PDF-1.4', 'CVE-2026-12345', 'JDK-8360708', 'HTTP2-200', 'MP3-128', 'UTF-16', 'AES-256', 'SHA-512', 'ISO-639', 'RFC-822', 'BCP-47', 'CVE-2024-45489', 'ABC-1234', 'ABC-12-x', 'ABCD-123', 'abc-123', 'S3CRET-VALUE-77']
    for (const text of plain) expect(internalMarks(text), text).toEqual([])
  })
})

/** The names of the files and links of a tar archive (ustar, with the long names git writes in pax headers), sorted. */
function tarFiles(archive: Buffer): string[] {
  const files: string[] = []
  let longName: string | null = null
  for (let at = 0; at + 512 <= archive.length; ) {
    const header = archive.subarray(at, at + 512)
    if (header.every((byte) => byte === 0)) break
    const text = (from: number, length: number) => header.subarray(from, from + length).toString('utf8').replace(/\0.*$/s, '')
    const size = parseInt(text(124, 12).trim() || '0', 8)
    const type = text(156, 1)
    const body = archive.subarray(at + 512, at + 512 + size)
    if (type === 'x') {
      // A pax header for the next entry: `<length> path=<name>\n`.
      longName = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? null
    } else {
      if (type === '0' || type === '' || type === '2') files.push(longName ?? (text(345, 155) ? `${text(345, 155)}/${text(0, 100)}` : text(0, 100)))
      if (type !== 'g') longName = null
    }
    at += 512 + Math.ceil(size / 512) * 512
  }
  return files.sort()
}
