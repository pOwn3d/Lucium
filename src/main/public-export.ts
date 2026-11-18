// The public repository starts from one commit: an export of the tree (`git archive HEAD`, which leaves out every path that .gitattributes marks
// `export-ignore`), with no earlier history. This file holds the rules of what that tree may contain, and the steps of
// `node scripts/export-public.mjs`, which makes the export, checks it and prepares that commit without pushing anything. Not part of the
// application (nothing in it imports this file); the script reads it with Node's own TypeScript, so it imports nothing but Node's modules.
//
// Why a fresh history: the private one holds notes, reports and files that were removed from the tree but not from the commits, and it weighs
// far more than the sources. The private repository stays the archive and is never a remote of the public one.

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve, sep } from 'node:path'

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The rules: what an exported file must not be, and must not say. src/main/public-tree.test.ts applies them to the tracked files at every run
// of the tests; the export applies them to the files it wrote.

/** Never exported: a folder (it ends with a slash) and all it holds, or one file. Each has its `export-ignore` line in .gitattributes. */
export const INTERNAL_PATHS = ['.claude/', 'docs/plans/', 'docs/audit-360/', 'docs/design/barre-collee/', 'docs/design/fonds-a-la-demande.md'] as const

/**
 * The internal paths that no commit holds, on purpose: their files live on the maintainer's machine only (the folder of the assistant's own settings and to-do).
 * They stay in the list as a guard, with their `export-ignore` lines: a file forced in under one is still refused. The test that wants every other line to
 * name a tracked path does not ask it of these.
 */
export const UNTRACKED_INTERNAL_PATHS: readonly (typeof INTERNAL_PATHS)[number][] = ['.claude/']

/**
 * Binary files are not read: the rules below read text, and an image, a font, a video or an archive is not one. So nothing here says what such
 * a file holds (the text of a PDF, the files of a zip, a capture of a screen): the run lists every one of them (`unreadFiles`) for a person
 * to look at before the export is pushed.
 */
export const BINARY = /\.(?:png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|mp4|webm|mov|mp3|wav|zip|gz|dmg|pdf|car|tiff?)$/i

/** Files that hold a key, a certificate or an environment: .gitignore already refuses them, the export refuses one that was forced in. */
export const SECRET_FILE = /(?:^|\/)(?:\.env(?:\.(?!example$)[^/]*)?|[^/]*\.(?:p12|p8|pem|cer|key|keychain|mobileprovision|provisionprofile)|id_(?:rsa|ed25519|ecdsa))$/i

/** The home folders the tests and the examples invent. Any other name after /Users/ or /home/ is taken for a real one. */
const INVENTED_HOMES = new Set(['me', 'moi', 'jane', 'x', 'u', 'someone', 'ana', 'janedoe', 'jdupont', 'jane.doe', 'autre', 'web_user', '..'])

/** The axes of the reports. A later reading of the same axis adds its number to the name, and a hypothesis is numbered apart, after an H. */
const AXIS = '(?:SEC|PERF|PRF|PUB|REP|COD|CMP|DAT|PRV|TXT|ACC)'
const FINDING = `(?:[FIMEH]\\d+|${AXIS}\\d?-H?\\d+)`

/**
 * What an exported file must not say, each with the reason. The words that name the maintainer's own tools are built from parts, so that this
 * file does not say them itself. The server that receives the updates is not here: its name is in no tracked file (it is read from a file outside
 * the repository), and writing it in a rule would publish it.
 */
export const INTERNAL_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  // A finding of an audit whose report is not published: the comment must say the reason itself, not point at it.
  { name: 'a finding of an unpublished audit', pattern: new RegExp(`\\baudits? ${FINDING}\\b|\\b${FINDING} of the audit\\b`, 'i') },
  { name: 'a finding of an unpublished audit', pattern: new RegExp(`\\b${AXIS}\\d?-(?:H\\d+|\\d{2,})\\b`) },
  // The same for an axis this list does not know yet. Three capitals alone would refuse the names of hashes, encodings and licences (three
  // capitals, a hyphen, a number), so the mark is the number of the reading or the H of a hypothesis, which those names do not carry; the
  // SHA-2 and SHA-3 families do, and are left alone.
  { name: 'a finding of an unpublished audit', pattern: /\b(?!SHA\d)[A-Z]{3}(?:\d-\d{2,}|\d?-H\d+)\b/ },
  // And for the first reading of such an axis, which carries neither mark: three capitals, a hyphen, two or three digits and nothing after them.
  // The names of that shape that are not findings are named here (hashes, encodings, ciphers, checksums, standards); a year or a longer number
  // (a vulnerability, a ticket of another project) has four digits or more and is not of that shape. The axes the list knows are the rule above's.
  { name: 'a finding of an unpublished audit', pattern: new RegExp(`\\b(?!(?:SHA|UTF|AES|CRC|ISO|RFC|BCP)-|${AXIS}-)[A-Z]{3}-\\d{2,3}(?![\\w-])`) },
  { name: 'an audit document that is not in the tree', pattern: new RegExp(['audit-corr', 'ections\\.md|audit-secu', 'rite'].join('')) },
  // The key of the maintainer and the tool that hosts the site: a default of the tooling is a neutral name or a variable.
  { name: 'the hosting tool of the maintainer', pattern: new RegExp(['coo', 'lify'].join(''), 'i') },
  { name: 'a private key that is not an example', pattern: /\.ssh\/(?!id_(?:rsa|ed25519|ecdsa)\b)[\w-]/ },
  { name: 'a host of the infrastructure', pattern: new RegExp(['pb-', 'test\\.'].join(''), 'i') },
  // The maintainer's own task board and its bridge file.
  { name: 'a tool of the maintainer', pattern: new RegExp(['he', 'rdr|bug', 'pool|todos-', 'bridge'].join(''), 'i') }
]

const HOME = /(?<![\w.-])\/(?:Users|home)\/([A-Za-z0-9._-]+)/g

/** The home folders a text names that no test invented. */
export function realHomes(text: string): string[] {
  return [...text.matchAll(HOME)].map((match) => match[1] ?? '').filter((name) => !INVENTED_HOMES.has(name.replace(/\.+$/, '') || name))
}

/** What a text says that an exported file must not: one line per rule that matched. */
export function internalMarks(text: string): string[] {
  const marks = INTERNAL_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name, pattern }) => `${name} (${pattern.exec(text)?.[0]})`)
  const homes = realHomes(text)
  return homes.length > 0 ? [...marks, `a home folder of a real person (${[...new Set(homes)].join(', ')})`] : marks
}

/** The paths of a list that are internal: under a folder of INTERNAL_PATHS, or one of its files. */
export function internalPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => INTERNAL_PATHS.some((internal) => (internal.endsWith('/') ? path.startsWith(internal) : path === internal)))
}

/**
 * The lines of INTERNAL_PATHS that name nothing in a list of tracked files, when the list is the private repository's own. The private repository
 * tracks every internal path (but UNTRACKED_INTERNAL_PATHS); the public one, made by the export, tracks none of them, so a list without any is
 * the public one and has no stale line to find. A list with some and not all has a line that names nothing: it goes with its export-ignore line.
 */
export function staleInternalPaths(tracked: readonly string[]): string[] {
  const kept = INTERNAL_PATHS.filter((internal) => !UNTRACKED_INTERNAL_PATHS.includes(internal))
  const missing = kept.filter((internal) => !tracked.some((path) => path.startsWith(internal)))
  return missing.length === kept.length ? [] : missing
}

/** The former name of the project, in any spelling and case. Built from parts so that this file does not name it itself. */
export const FORMER_NAME = new RegExp(['arbal', '[eè]', 't'].join(''), 'i')

/** Tracked files that may keep the former name, with the reason. Empty: nothing has to. */
export const FORMER_NAME_ALLOWED: Readonly<Record<string, string>> = {}

/** The paths that name the former project, in their path or in their content. */
export function filesNamingFormer(paths: readonly string[], read: (path: string) => string): string[] {
  return paths.filter((path) => {
    if (Object.hasOwn(FORMER_NAME_ALLOWED, path)) return false
    return FORMER_NAME.test(path) || FORMER_NAME.test(read(path))
  })
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The export and its checks. Every check returns the list of its refusals, each a sentence that says what is wrong and where; an empty list
// lets the export go on. No refusal prints a secret or a personal address: a scanner's finding is its rule and its place, an address is its host.

/**
 * The most the exported files may weigh together, in bytes. The tree weighed 36.8 MB on 10 November 2026 (2,061 files) and 50.06 MB on 17 November
 * (v1.1.2, 2,654 files): the ceiling leaves about a fifth of room above the last measure. A tree past it has taken in a build, a capture folder
 * or a video that was not meant to be there.
 */
export const MAX_EXPORT_BYTES = 60_000_000

/** The addresses GitHub gives an account to keep its own out of the commits: `<id>+<login>@users.noreply.github.com`, or the older form without the id. */
export const NOREPLY_ADDRESS = /^(?:\d+\+)?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?@users\.noreply\.github\.com$/

export type Env = Readonly<Record<string, string | undefined>>

export interface ExportedFile {
  /** Relative to the export, with forward slashes. */
  path: string
  /** Its size in bytes (the length of its target, for a link). */
  size: number
  link: boolean
}

export interface TreeEntry {
  mode: string
  /** The hash of the blob, hexadecimal. */
  hash: string
  path: string
}

/** What a run of git answered. `status` is null when git could not be started. */
interface GitAnswer {
  status: number | null
  stdout: string
  stderr: string
}

/**
 * The variables that send git to another repository than the folder it is run in. A hook or a wrapper may have set them: the export reads the
 * source repository and writes the new one, each by its folder, and nothing else.
 */
const REDIRECTING = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE']

function gitEnv(env: Env): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = { ...env }
  for (const name of REDIRECTING) delete kept[name]
  return kept
}

function git(cwd: string, args: readonly string[], env: Env, input?: string): GitAnswer {
  const run = spawnSync('git', [...args], { cwd, env: gitEnv(env), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, input })
  return { status: run.error ? null : run.status, stdout: run.stdout ?? '', stderr: run.error ? run.error.message : (run.stderr ?? '') }
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1) ?? ''
}

/** Why the source repository cannot be exported now: changes not committed, or a HEAD that is not the commit that was read and approved. */
export function sourceProblems(repo: string, expected: string | undefined, env: Env = process.env): string[] {
  const status = git(repo, ['status', '--porcelain', '--untracked-files=all'], env)
  if (status.status !== 0) return [`git cannot read the source repository ${repo}: ${lastLine(status.stderr)}`]
  const problems: string[] = []
  const changed = status.stdout.split('\n').filter((line) => line !== '')
  if (changed.length > 0) {
    const shown = changed.slice(0, 5).map((line) => line.slice(3)).join(', ')
    problems.push(`the working tree is not clean: ${changed.length} path(s) changed or untracked (${shown}${changed.length > 5 ? ', …' : ''}). The export is the commit, and what is not committed was not checked.`)
  }
  if (expected !== undefined) {
    const head = git(repo, ['rev-parse', 'HEAD'], env).stdout.trim()
    if (!/^[0-9a-f]{7,64}$/.test(expected)) problems.push(`the expected commit must be a hash of at least 7 hexadecimal digits, not "${expected}": a branch name moves.`)
    else if (!head.startsWith(expected)) problems.push(`HEAD is ${head.slice(0, 12)}, not the expected commit ${expected.slice(0, 12)}.`)
  }
  return problems
}

/** Why a folder cannot receive the export: it holds something, or it sits inside a repository (whose history the new one must never see). */
export function destinationProblems(dest: string, env: Env = process.env): string[] {
  if (existsSync(dest)) {
    if (!lstatSync(dest).isDirectory()) return [`${dest} is not a folder.`]
    if (readdirSync(dest).length > 0) return [`${dest} is not empty: the export goes in an empty folder, so that nothing else joins the commit.`]
  }
  let parent = dest
  while (!existsSync(parent)) parent = dirname(parent)
  const inside = git(parent, ['rev-parse', '--show-toplevel'], env)
  if (inside.status === 0) return [`${dest} is inside the repository ${inside.stdout.trim()}: the public repository is made outside every other one.`]
  return []
}

/** Writes the files of `git archive HEAD` in a folder: the tracked files of the commit, less the ones marked `export-ignore`. */
export function exportTree(repo: string, dir: string, env: Env = process.env): void {
  const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: repo, env: gitEnv(env), maxBuffer: 1024 * 1024 * 1024 })
  mkdirSync(dir, { recursive: true })
  execFileSync('tar', ['-xf', '-', '-C', dir], { input: archive, env: gitEnv(env), stdio: ['pipe', 'ignore', 'pipe'] })
}

/** The files and links under a folder, sorted. */
export function exportedFiles(dir: string): ExportedFile[] {
  const files: ExportedFile[] = []
  const walk = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`
      if (entry.isDirectory()) walk(join(folder, entry.name), `${path}/`)
      else files.push({ path, size: lstatSync(join(folder, entry.name)).size, link: entry.isSymbolicLink() })
    }
  }
  walk(dir, '')
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * What the exported files must not be or say: an internal path, a key file, the maintainer's machine or tools, an audit finding, the former name,
 * a file outside the GPL without its notice, too much weight.
 */
export function treeProblems(dir: string, files: readonly ExportedFile[], maxBytes: number = MAX_EXPORT_BYTES): string[] {
  const paths = files.map((file) => file.path)
  const problems = internalPaths(paths).map((path) => `${path}: an internal path, which must have its export-ignore line in .gitattributes.`)
  for (const path of paths) if (SECRET_FILE.test(path)) problems.push(`${path}: a key, a certificate or an environment file.`)
  const read = (file: ExportedFile): string => (file.link ? readlinkSync(join(dir, file.path)) : readFileSync(join(dir, file.path), 'utf8'))
  for (const file of files) {
    const text = BINARY.test(file.path) ? '' : read(file)
    for (const mark of internalMarks(text)) problems.push(`${file.path}: ${mark}.`)
    if (filesNamingFormer([file.path], () => text).length > 0) problems.push(`${file.path}: the former name of the project.`)
  }
  problems.push(...noticeProblems(files, paths.includes('NOTICE') ? readFileSync(join(dir, 'NOTICE'), 'utf8') : null))
  const bytes = files.reduce((sum, file) => sum + file.size, 0)
  if (bytes > maxBytes) {
    const heaviest = [...files].sort((a, b) => b.size - a.size).slice(0, 3).map((file) => `${file.path} (${megabytes(file.size)})`).join(', ')
    problems.push(`the export weighs ${megabytes(bytes)}, more than the ceiling of ${megabytes(maxBytes)}. The heaviest: ${heaviest}.`)
  }
  return problems
}

/**
 * The files that are handed out without being under the GPL of the code, and the document that says so for each group. A reader of the public
 * tree takes every file for free software unless a notice beside it says otherwise: such a file leaves only with its notice.
 */
export const OUTSIDE_GPL: readonly { files: RegExp; notice: string; why: string }[] = [
  { files: /^(?:scripts\/logo\/fan-logo\.ts|build\/icon\.icns|resources\/app-icons\/[^/]+\.png|ios\/Lucium\/Assets\.xcassets\/AppIcon\.appiconset\/[^/]+\.png)$/, notice: 'TRADEMARKS.md', why: 'the logo, reserved for the official builds' },
  { files: /^resources\/backgrounds\/[^/]+\.(?:mp4|jpe?g)$/i, notice: 'NOTICE-MEDIA.md', why: 'generated by artificial intelligence, under no free licence' }
]

/** The group of `OUTSIDE_GPL` a path belongs to, or undefined for a file under the licence of the code or of its own author. */
export function outsideGpl(path: string): (typeof OUTSIDE_GPL)[number] | undefined {
  return OUTSIDE_GPL.find((group) => group.files.test(path))
}

/**
 * Why the files outside the GPL cannot leave as they are: their notice is not exported, or the NOTICE file of the root, the one a built
 * application carries, does not name it. Empty when each of them leaves with what says its licence.
 */
export function noticeProblems(files: readonly ExportedFile[], rootNotice: string | null): string[] {
  const paths = new Set(files.map((file) => file.path))
  return OUTSIDE_GPL.flatMap((group) => {
    const concerned = files.filter((file) => group.files.test(file.path))
    if (concerned.length === 0) return []
    const what = `${concerned.length} file(s) outside the GPL (${group.why}; the first: ${concerned[0]?.path ?? ''})`
    if (!paths.has(group.notice)) return [`${what} are exported without ${group.notice}, which says their licence.`]
    if (rootNotice === null) return [`${what} are exported without the NOTICE file, which must name ${group.notice}.`]
    return rootNotice.includes(group.notice) ? [] : [`${what} are exported, and NOTICE does not name ${group.notice}.`]
  })
}

/** The exported files that no rule read (`BINARY`), in the order of the export: what the run lists for a person to look at. */
export function unreadFiles(files: readonly ExportedFile[]): ExportedFile[] {
  return files.filter((file) => BINARY.test(file.path))
}

/** The lines of the run that list the files no rule read. Nothing when every file was read. */
export function unreadReport(unread: readonly ExportedFile[]): string[] {
  if (unread.length === 0) return []
  const bytes = unread.reduce((sum, file) => sum + file.size, 0)
  return [
    `Not read          ${unread.length} binary file(s), ${megabytes(bytes)}: no rule looks inside them (an image, a video, a font, an archive, a PDF). Look at each before pushing:`,
    ...unread.map((file) => {
      const group = outsideGpl(file.path)
      return `                    ${file.path} (${file.size} bytes${group ? `; not under the GPL: ${group.notice}` : ''})`
    })
  ]
}

export function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

/** The files of the commit, as git names them: mode, hash of the blob, path. */
export function committedEntries(repo: string, env: Env = process.env): TreeEntry[] {
  const listed = git(repo, ['ls-tree', '-r', '-z', 'HEAD'], env)
  if (listed.status !== 0) throw new Error(`git cannot list the commit of ${repo}: ${lastLine(listed.stderr)}`)
  return listed.stdout.split('\0').filter((line) => line !== '').map((line) => {
    const [facts = '', path = ''] = line.split('\t')
    const [mode = '', , hash = ''] = facts.split(' ')
    return { mode, hash, path }
  })
}

function objectHash(type: string, body: Buffer, algorithm: string): Buffer {
  return createHash(algorithm).update(`${type} ${body.length}\0`).update(body).digest()
}

/**
 * The hash git gives the tree made of these entries: the one `git rev-parse HEAD^{tree}` answers in a repository that holds exactly them.
 * It is computed here, without a repository, so that the check can say it before anything is created and the commit can be compared with it.
 */
export function treeHash(entries: readonly TreeEntry[]): string {
  const algorithm = (entries[0]?.hash.length ?? 40) === 64 ? 'sha256' : 'sha1'
  interface Folder { files: Map<string, TreeEntry>; folders: Map<string, Folder> }
  const root: Folder = { files: new Map(), folders: new Map() }
  for (const entry of entries) {
    const names = entry.path.split('/')
    const name = names.pop() ?? ''
    let folder = root
    for (const part of names) {
      let next = folder.folders.get(part)
      if (!next) folder.folders.set(part, (next = { files: new Map(), folders: new Map() }))
      folder = next
    }
    folder.files.set(name, entry)
  }
  const hashOf = (folder: Folder): Buffer => {
    const rows = [
      ...[...folder.files].map(([name, entry]) => ({ sort: Buffer.from(name), name, mode: entry.mode.replace(/^0+/, ''), hash: Buffer.from(entry.hash, 'hex') })),
      // Git sorts a folder as if its name ended with a slash.
      ...[...folder.folders].map(([name, sub]) => ({ sort: Buffer.from(`${name}/`), name, mode: '40000', hash: hashOf(sub) }))
    ].sort((a, b) => Buffer.compare(a.sort, b.sort))
    return objectHash('tree', Buffer.concat(rows.flatMap((row) => [Buffer.from(`${row.mode} ${row.name}\0`), row.hash])), algorithm)
  }
  return hashOf(root).toString('hex')
}

/**
 * The tree the commit of the public repository must have: the entries of the source commit for the files that were exported. A file the export
 * wrote that the commit does not hold, or wrote with another content (an attribute that rewrites files on export), is a refusal: the hash
 * printed would not be the one of what is published.
 */
export function publicTree(dir: string, files: readonly ExportedFile[], committed: readonly TreeEntry[]): { hash: string; problems: string[] } {
  const byPath = new Map(committed.map((entry) => [entry.path, entry]))
  const problems: string[] = []
  const entries: TreeEntry[] = []
  for (const file of files) {
    const entry = byPath.get(file.path)
    if (!entry) {
      problems.push(`${file.path}: written by the export, and not a file of the commit.`)
      continue
    }
    const content = file.link ? Buffer.from(readlinkSync(join(dir, file.path))) : readFileSync(join(dir, file.path))
    const hash = objectHash('blob', content, entry.hash.length === 64 ? 'sha256' : 'sha1').toString('hex')
    if (hash !== entry.hash) problems.push(`${file.path}: the export wrote another content than the commit holds (an attribute rewrites it on export).`)
    entries.push(entry)
  }
  return { hash: treeHash(entries), problems }
}

/** The first file of that name that can be run, in the folders of a PATH. */
export function findTool(name: string, path: string): string | null {
  for (const folder of path.split(delimiter).filter((part) => part !== '')) {
    const file = join(folder, name)
    try {
      accessSync(file, constants.X_OK)
      if (lstatSync(file).isDirectory()) continue
      return file
    } catch {
      // Not in this folder, or not runnable: the next folder of the PATH is tried, and a tool found nowhere is a refusal of secretProblems.
    }
  }
  return null
}

interface Scanner {
  name: string
  args: readonly string[]
  /** The exit code that says "found something". */
  found: number
  /** The findings of its output: the rule and the place, never the value. */
  findings: (stdout: string) => string[]
}

function parsedLines(stdout: string): unknown[] {
  return stdout.split('\n').filter((line) => line.trim().startsWith('{')).flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown]
    } catch {
      // A line that is not a finding (a log line that starts with a brace): the exit code still says that something was found.
      return []
    }
  })
}

/** The complete scans: every finding counts, verified against a service or not. */
const SCANNERS: readonly Scanner[] = [
  {
    name: 'gitleaks',
    args: ['dir', '.', '--no-banner', '--redact', '--exit-code', '3', '--report-format', 'json', '--report-path', '-', '--log-level', 'error'],
    found: 3,
    findings: (stdout) => {
      const start = stdout.indexOf('[')
      const report = JSON.parse(start < 0 ? '[]' : stdout.slice(start)) as { RuleID?: string; File?: string; StartLine?: number }[]
      return report.map((finding) => `${finding.File ?? '?'}:${finding.StartLine ?? '?'} (${finding.RuleID ?? 'no rule'})`)
    }
  },
  {
    name: 'trufflehog',
    // No `--only-verified` and no `--results`: an unverified finding stops the export too.
    args: ['filesystem', '.', '--json', '--no-update', '--fail'],
    found: 183,
    findings: (stdout) =>
      parsedLines(stdout).flatMap((line) => {
        const finding = line as { DetectorName?: string; SourceMetadata?: { Data?: { Filesystem?: { file?: string; line?: number } } } }
        const place = finding.SourceMetadata?.Data?.Filesystem
        return finding.DetectorName ? [`${place?.file ?? '?'}:${place?.line ?? '?'} (${finding.DetectorName})`] : []
      })
  }
]

/**
 * What the complete secret scan of a folder found. Every scanner installed is run; with none, the export is refused, and so it is when a
 * scanner stops on an error: a scan that did not finish found nothing and proves nothing.
 */
export function secretProblems(dir: string, path: string, env: Env = process.env): string[] {
  const installed = SCANNERS.flatMap((scanner) => {
    const file = findTool(scanner.name, path)
    return file ? [{ scanner, file }] : []
  })
  if (installed.length === 0) {
    return ['no secret scanner is installed: the export is not made without a complete scan. Install gitleaks (`brew install gitleaks`) or trufflehog (`brew install trufflehog`), then run this again.']
  }
  const problems: string[] = []
  for (const { scanner, file } of installed) {
    const run = spawnSync(file, [...scanner.args], { cwd: dir, env: { ...env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    if (run.error || (run.status !== 0 && run.status !== scanner.found)) {
      problems.push(`${scanner.name} did not finish its scan (${run.error ? run.error.message : `exit code ${run.status}: ${lastLine(run.stderr ?? '')}`}): nothing is exported on a scan that failed.`)
      continue
    }
    if (run.status === 0) continue
    let findings: string[]
    try {
      findings = scanner.findings(run.stdout ?? '')
    } catch (error) {
      findings = [`its report cannot be read: ${(error as Error).message}`]
    }
    problems.push(`${scanner.name} found ${findings.length || 'at least one'} possible secret(s) in the export: ${findings.slice(0, 20).join(', ') || 'see its own output'}${findings.length > 20 ? ', …' : ''}. Remove it, or mark a false alarm where it is with its reason, commit, and run this again.`)
  }
  return problems
}

function identityProblem(role: string, ident: GitAnswer): string[] {
  if (ident.status !== 0) return [`git has no ${role} identity here: ${lastLine(ident.stderr)}`]
  const address = /<([^>]*)>/.exec(ident.stdout)?.[1] ?? ''
  if (NOREPLY_ADDRESS.test(address)) return []
  // The host only: the address itself may be a personal one, and this text ends in a terminal or a log.
  const host = address.includes('@') ? address.slice(address.lastIndexOf('@') + 1) : 'no host'
  return [`the ${role} of the commit would be an address at ${host}, not a …@users.noreply.github.com address. Set it for a new repository: user.email of the global configuration, or GIT_${role.toUpperCase()}_EMAIL for this run.`]
}

/**
 * Why a commit made in this folder would not carry the identity of the public repository: the author or the committer git would write is not
 * a GitHub noreply address, or commits are not signed. Outside a repository, git answers what a new repository takes: the global configuration
 * and the environment, not the settings of the private repository.
 */
export function identityProblems(cwd: string, env: Env = process.env): string[] {
  const problems = [...identityProblem('author', git(cwd, ['var', 'GIT_AUTHOR_IDENT'], env)), ...identityProblem('committer', git(cwd, ['var', 'GIT_COMMITTER_IDENT'], env))]
  const signs = git(cwd, ['config', '--type=bool', '--get', 'commit.gpgsign'], env).stdout.trim() === 'true'
  const key = git(cwd, ['config', '--get', 'user.signingkey'], env).stdout.trim()
  if (!signs) problems.push('commits are not signed: `commit.gpgsign` is not true. Set it (`git config --global commit.gpgsign true`), with `gpg.format` and `user.signingkey`.')
  if (key === '') problems.push('no signing key is named: `user.signingkey` is empty. Name the key that GitHub knows as a signing key of the account.')
  return problems
}

/**
 * Makes the repository and its one commit in the folder of the export: `git init` without a template (no hook of the machine comes in), every
 * file added (the ones .gitignore names too: the tree is the export, whole), one signed commit. No remote is added and nothing is pushed.
 */
export function prepareCommit(dir: string, message: string, env: Env = process.env): string[] {
  const steps: (readonly string[])[] = [
    ['init', '--quiet', '--initial-branch=main', '--template='],
    ['add', '--all', '--force', '.'],
    ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--gpg-sign', '--signoff', '--message', message]
  ]
  for (const args of steps) {
    const run = git(dir, args, env)
    if (run.status !== 0) return [`\`git ${args.find((arg) => !arg.startsWith('-') && !arg.includes('=')) ?? args[0]}\` failed in ${dir}: ${lastLine(run.stderr) || `exit code ${run.status}`}`]
  }
  return []
}

/**
 * What is wrong with the repository that was prepared, read from the repository itself: more than one commit or one branch, a remote, objects
 * borrowed from another repository, a tree that is not the export, an address that is not noreply, no signature.
 */
export function commitProblems(dir: string, expectedTree: string, env: Env = process.env): string[] {
  const problems: string[] = []
  const answer = (args: readonly string[]): string => git(dir, args, env).stdout.trim()
  const remotes = answer(['remote'])
  if (remotes !== '') problems.push(`the new repository has a remote (${remotes.split('\n').join(', ')}): it must have none until the maintainer adds the public one by hand.`)
  if (existsSync(join(dir, '.git', 'objects', 'info', 'alternates'))) problems.push('the new repository borrows its objects from another repository (objects/info/alternates).')
  const refs = answer(['for-each-ref', '--format=%(refname)'])
  if (refs !== 'refs/heads/main') problems.push(`the new repository must have the branch main and nothing else, and has: ${refs.split('\n').join(', ') || 'no branch'}.`)
  const commits = answer(['rev-list', '--count', '--all'])
  if (commits !== '1') problems.push(`the new repository has ${commits || 'no'} commit(s), not one.`)
  const tree = answer(['rev-parse', 'HEAD^{tree}'])
  if (tree !== expectedTree) problems.push(`the tree of the commit is ${tree || 'unreadable'}, not the tree of the export ${expectedTree}: a file was left out, added or rewritten.`)
  const [header = ''] = git(dir, ['cat-file', 'commit', 'HEAD'], env).stdout.split('\n\n')
  if (/^parent /m.test(header)) problems.push('the commit has a parent.')
  for (const role of ['author', 'committer']) {
    const address = new RegExp(`^${role} .*<([^>]*)>`, 'm').exec(header)?.[1] ?? ''
    if (!NOREPLY_ADDRESS.test(address)) problems.push(`the ${role} of the commit is not a …@users.noreply.github.com address.`)
  }
  if (!/^gpgsig(?:-sha256)? /m.test(header)) problems.push('the commit is not signed.')
  return problems
}

export interface ExportOptions {
  /** The source repository (the private one). */
  repo: string
  /** The empty folder that receives the export and the new repository. Not read with `check`. */
  dest?: string
  /** The commit that was read and approved: HEAD must be it. Required without `check`. */
  expected?: string
  /** Every check, and nothing created: the export goes in a temporary folder that is removed. */
  check: boolean
  /** The message of the commit. */
  message?: string
  maxBytes?: number
  /** Where the secret scanners are looked for (by default the PATH of `env`). */
  scannerPath?: string
  /** Where the temporary folder of `check` is made (by default the system's). */
  tmp?: string
  env?: Env
}

export interface ExportResult {
  /** Why the export was refused. Empty: every check passed. */
  refusals: string[]
  /** The commit that was exported. */
  head: string
  files: number
  bytes: number
  /** The exported files that were not read for internal marks, because they are not text (`unreadFiles`). */
  unread: ExportedFile[]
  /** The hash of the public tree, the one `git rev-parse HEAD^{tree}` answers in the new repository. Empty when nothing was exported. */
  tree: string
  /** The hash of the commit that was prepared, or null (a check, or a refusal). */
  commit: string | null
}

/**
 * The whole run. A check makes every control and reports them all. An export stops at the first group that refuses, before the next step:
 * the source, then the destination, then the exported tree (which is removed again), then the commit that was made (whose repository is removed).
 */
export function runExport(options: ExportOptions): ExportResult {
  const env = options.env ?? process.env
  const repo = resolve(options.repo)
  const result: ExportResult = { refusals: [], head: git(repo, ['rev-parse', 'HEAD'], env).stdout.trim(), files: 0, bytes: 0, unread: [], tree: '', commit: null }
  if (!options.check && options.expected === undefined) result.refusals.push('the expected commit is not given: an export names the commit that was read and approved.')
  result.refusals.push(...sourceProblems(repo, options.expected, env))
  if (result.head === '') return result
  const dest = options.check ? null : resolve(options.dest ?? '')
  if (dest !== null) {
    if (options.dest === undefined || options.dest === '') result.refusals.push('the folder of the export is not given.')
    else if (dest === repo || dest.startsWith(repo + sep)) result.refusals.push(`${dest} is inside the source repository.`)
    else result.refusals.push(...destinationProblems(dest, env))
    if (result.refusals.length > 0) return result
  }
  const dir = dest ?? mkdtempSync(join(options.tmp ?? tmpdir(), 'lucium-export-check-'))
  const empty = (): void => {
    if (dest === null) rmSync(dir, { recursive: true, force: true })
    else for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true })
  }
  try {
    exportTree(repo, dir, env)
    const files = exportedFiles(dir)
    const tree = publicTree(dir, files, committedEntries(repo, env))
    result.files = files.length
    result.bytes = files.reduce((sum, file) => sum + file.size, 0)
    result.unread = unreadFiles(files)
    result.tree = tree.hash
    result.refusals.push(
      ...treeProblems(dir, files, options.maxBytes),
      ...tree.problems,
      ...secretProblems(dir, options.scannerPath ?? env.PATH ?? '', env),
      ...identityProblems(dir, env)
    )
    if (dest === null || result.refusals.length > 0) return result
    const version = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version?: string }).version
    result.refusals.push(...prepareCommit(dir, options.message ?? `chore: Lucium ${version ?? ''}, the first commit of the public repository`.replace(' ,', ','), env))
    if (result.refusals.length === 0) result.refusals.push(...commitProblems(dir, tree.hash, env))
    if (result.refusals.length === 0) result.commit = git(dir, ['rev-parse', 'HEAD'], env).stdout.trim()
    return result
  } finally {
    // A check leaves nothing; a refused export leaves the folder as empty as it found it, so that no half-made repository can be pushed.
    if (dest === null || result.commit === null) empty()
  }
}
