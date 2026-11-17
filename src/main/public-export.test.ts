// The export of the public tree (scripts/export-public.mjs) refuses to go on in each of the cases below. Every case is a small repository made
// in a temporary folder, with its own git configuration: nothing here reads the configuration or the keys of the machine. The texts that an
// exported file must not hold are built from parts, because this file is exported too and the rules read it.

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Env,
  MAX_EXPORT_BYTES,
  NOREPLY_ADDRESS,
  SECRET_FILE,
  commitProblems,
  committedEntries,
  destinationProblems,
  exportTree,
  exportedFiles,
  findTool,
  identityProblems,
  noticeProblems,
  outsideGpl,
  prepareCommit,
  publicTree,
  runExport,
  secretProblems,
  sourceProblems,
  treeHash,
  treeProblems,
  unreadFiles,
  unreadReport
} from './public-export'

const NOREPLY = '1234+someone@users.noreply.github.com'
const PERSONAL = 'someone@example.org'

let root = ''
let keyFile = ''
let made = 0

/** A new empty folder under the root of this run. */
function folder(name: string): string {
  const path = join(root, `${++made}-${name}`)
  mkdirSync(path, { recursive: true })
  return path
}

/** An environment whose git reads one configuration file and no other: the identity and the signature are what `settings` says. */
function environment(settings: { email?: string; sign?: boolean; key?: boolean } = {}, more: Record<string, string> = {}): Env {
  const home = folder('home')
  const lines = ['[user]', '\tname = Someone', `\temail = ${settings.email ?? NOREPLY}`]
  if (settings.key !== false) lines.push(`\tsigningkey = ${keyFile}.pub`)
  lines.push('[gpg]', '\tformat = ssh', '[commit]', `\tgpgsign = ${settings.sign === false ? 'false' : 'true'}`, '')
  writeFileSync(join(home, 'gitconfig'), lines.join('\n'))
  return { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', ...more }
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
}

function git(cwd: string, env: Env, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

const SOURCES = { 'package.json': '{ "version": "1.2.3" }\n', 'src/index.ts': 'export const one = 1\n', 'docs/guide.md': '# Guide\n' }

/** A source repository with one commit of these files (every one of them, the ones its .gitignore names too). */
function repository(files: Record<string, string> = SOURCES, env: Env = environment()): { repo: string; env: Env; head: string } {
  const repo = folder('source')
  git(repo, env, 'init', '--quiet', '--initial-branch=main')
  write(repo, files)
  git(repo, env, 'add', '--all', '--force', '.')
  git(repo, env, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'sources')
  return { repo, env, head: git(repo, env, 'rev-parse', 'HEAD') }
}

/** A folder that holds stand-ins of the scanners: each prints what it is told and leaves with the code it is told. */
function scanners(tools: Record<string, { code: number; output?: string }>): string {
  const bin = folder('bin')
  for (const [name, { code, output }] of Object.entries(tools)) {
    writeFileSync(join(bin, `${name}.out`), output ?? '')
    writeFileSync(join(bin, name), `#!/bin/sh\ncat "$(dirname "$0")/${name}.out"\necho "the scan broke" >&2\nexit ${code}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  return bin
}

const CLEAN = { gitleaks: { code: 0, output: '[]' } }

/** The files of a folder, exported from nowhere: what treeProblems reads. */
function tree(files: Record<string, string>): string {
  const dir = folder('tree')
  write(dir, files)
  return dir
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'public-export-test-'))
  keyFile = join(root, 'signing-key')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test', '-f', keyFile])
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the source repository', { timeout: 60_000 }, () => {
  it('is exported when it is clean and HEAD is the commit expected, by its whole hash or its first digits', () => {
    const { repo, env, head } = repository()
    expect(sourceProblems(repo, head, env)).toEqual([])
    expect(sourceProblems(repo, head.slice(0, 10), env)).toEqual([])
    expect(sourceProblems(repo, undefined, env)).toEqual([])
  })

  it('is refused with a file changed, and with a file that is not tracked', () => {
    const { repo, env, head } = repository()
    writeFileSync(join(repo, 'src/index.ts'), 'export const one = 2\n')
    expect(sourceProblems(repo, head, env)).toEqual([expect.stringMatching(/not clean: 1 path.*src\/index\.ts/)])
    git(repo, env, 'checkout', '--quiet', '--', 'src/index.ts')
    writeFileSync(join(repo, 'notes.txt'), 'not committed\n')
    expect(sourceProblems(repo, head, env)).toEqual([expect.stringMatching(/not clean: 1 path.*notes\.txt/)])
  })

  it('is refused when HEAD is another commit than the one expected, and when a branch name is given for it', () => {
    const { repo, env, head } = repository()
    writeFileSync(join(repo, 'src/more.ts'), 'export const two = 2\n')
    git(repo, env, 'add', '.')
    git(repo, env, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'more')
    expect(sourceProblems(repo, head, env)).toEqual([expect.stringMatching(/^HEAD is [0-9a-f]{12}, not the expected commit/)])
    expect(sourceProblems(repo, 'main', env)).toEqual([expect.stringMatching(/must be a hash/)])
    expect(sourceProblems(folder('not-a-repository'), undefined, env)).toEqual([expect.stringMatching(/cannot read the source repository/)])
  })

  it('is read by its folder, whatever repository the environment names', () => {
    const { repo, env, head } = repository()
    const other = repository({ 'other.txt': 'another repository\n' }, env)
    expect(sourceProblems(repo, head, { ...env, GIT_DIR: join(other.repo, '.git') })).toEqual([])
  })
})

describe('the folder of the export', { timeout: 60_000 }, () => {
  it('is a folder that is empty or does not exist yet, outside every repository', () => {
    const env = environment()
    expect(destinationProblems(folder('empty'), env)).toEqual([])
    expect(destinationProblems(join(folder('parent'), 'not', 'made', 'yet'), env)).toEqual([])
  })

  it('is refused when it holds something, when it is a file, and when it is inside a repository', () => {
    const { repo, env } = repository()
    const full = tree({ 'left-over.txt': 'x' })
    expect(destinationProblems(full, env)).toEqual([expect.stringMatching(/is not empty/)])
    expect(destinationProblems(join(full, 'left-over.txt'), env)).toEqual([expect.stringMatching(/is not a folder/)])
    expect(destinationProblems(join(repo, 'public'), env)).toEqual([expect.stringMatching(/is inside the repository/)])
  })
})

describe('what the exported files must not be or say', () => {
  const problems = (files: Record<string, string>, max?: number): string[] => {
    const dir = tree(files)
    return treeProblems(dir, exportedFiles(dir), max)
  }

  it('plain sources pass', () => {
    expect(problems(SOURCES)).toEqual([])
  })

  it('an internal path is refused', () => {
    expect(problems({ ...SOURCES, 'docs/plans/jour-j.md': '# Jour J\n', '.claude/TODOS.md': '# To do\n' })).toEqual([
      expect.stringMatching(/^\.claude\/TODOS\.md: an internal path/),
      expect.stringMatching(/^docs\/plans\/jour-j\.md: an internal path/)
    ])
  })

  it('a key, a certificate or an environment file is refused, and an example of one is not', () => {
    const refused = ['.env', '.env.production', 'build/cert.p12', 'keys/AuthKey.p8', 'server.pem', 'app.cer', 'deploy/id_ed25519', 'x.mobileprovision']
    for (const path of refused) expect(SECRET_FILE.test(path), path).toBe(true)
    for (const path of ['.env.example', 'src/env.d.ts', 'docs/keys.md', 'src/pem.ts', 'id_ed25519.pub']) expect(SECRET_FILE.test(path), path).toBe(false)
    expect(problems({ ...SOURCES, 'build/cert.p12': 'x' })).toEqual([expect.stringMatching(/^build\/cert\.p12: a key, a certificate or an environment file/)])
  })

  it('a home folder of a real person, and a tool of the maintainer, are refused where they are', () => {
    const home = ['/Users', 'christophe', 'Dev'].join('/')
    const tool = ['bug', 'pool'].join('')
    expect(problems({ ...SOURCES, 'docs/build.md': `Open ${home}.\n`, 'scripts/run.sh': `# ${tool}\n` })).toEqual([
      expect.stringMatching(/^docs\/build\.md: a home folder of a real person \(christophe\)/),
      expect.stringMatching(/^scripts\/run\.sh: a tool of the maintainer/)
    ])
  })

  it('a finding of an unpublished audit is refused', () => {
    const finding = ['REP', '708'].join('-')
    expect(problems({ ...SOURCES, 'src/guard.ts': `// ${finding}: refused here\n` })).toEqual([expect.stringMatching(/^src\/guard\.ts: a finding of an unpublished audit/)])
  })

  it('the former name of the project is refused, in a content and in a path', () => {
    const former = ['Arbal', 'ette'].join('')
    expect(problems({ ...SOURCES, 'README.md': `# ${former}\n`, [`docs/${former.toLowerCase()}.md`]: 'nothing inside\n' })).toEqual([
      expect.stringMatching(/^README\.md: the former name of the project/),
      expect.stringMatching(/^docs\/\w+\.md: the former name of the project/)
    ])
  })

  it('a binary file is weighed and not read', () => {
    const former = ['Arbal', 'ette'].join('')
    expect(problems({ ...SOURCES, 'docs/images/logo.png': former })).toEqual([])
  })

  it('an export heavier than the ceiling is refused, with its heaviest files', () => {
    const files = { ...SOURCES, 'resources/film.mp4': 'x'.repeat(5000), 'resources/small.mp4': 'x'.repeat(100) }
    const weight = Object.values(files).reduce((sum, content) => sum + content.length, 0)
    expect(problems(files, weight)).toEqual([])
    expect(problems(files, weight - 1)).toEqual([expect.stringMatching(/weighs 0\.0 MB, more than the ceiling.*resources\/film\.mp4 .*resources\/small\.mp4/)])
    expect(MAX_EXPORT_BYTES).toBe(60_000_000)
  })
})

describe('the tree of the export', { timeout: 60_000 }, () => {
  it('has the hash git gives it: folders, a file that runs, a link, and names that sort around a folder', () => {
    const { repo, env } = repository({ ...SOURCES, 'a/b.txt': 'b\n', 'a.b': 'dot\n', 'a-b': 'dash\n', 'a/c/d/e.txt': 'e\n', 'scripts/é.sh': '#!/bin/sh\n' })
    chmodSync(join(repo, 'scripts/é.sh'), 0o755)
    execFileSync('ln', ['-s', 'a/b.txt', join(repo, 'link')])
    git(repo, env, 'add', '--all')
    git(repo, env, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'more')
    expect(treeHash(committedEntries(repo, env))).toBe(git(repo, env, 'rev-parse', 'HEAD^{tree}'))
  })

  it('is the commit less the paths marked export-ignore, and the files are the ones of the commit', () => {
    const { repo, env } = repository({ ...SOURCES, '.gitattributes': '/notes export-ignore\n/notes/** export-ignore\n', 'notes/private.md': 'private\n' })
    const dir = folder('export')
    exportTree(repo, dir, env)
    const files = exportedFiles(dir)
    expect(files.map((file) => file.path)).toEqual(['.gitattributes', 'docs/guide.md', 'package.json', 'src/index.ts'])
    const committed = committedEntries(repo, env)
    const tree = publicTree(dir, files, committed)
    expect(tree.problems).toEqual([])
    expect(tree.hash).toBe(treeHash(committed.filter((entry) => !entry.path.startsWith('notes/'))))
    expect(tree.hash).not.toBe(git(repo, env, 'rev-parse', 'HEAD^{tree}'))
  })

  it('is refused when the export wrote another content than the commit holds, or a file the commit does not hold', () => {
    const { repo, env } = repository({ ...SOURCES, '.gitattributes': 'version.txt export-subst\n', 'version.txt': '$Format:%H$\n' })
    const dir = folder('export')
    exportTree(repo, dir, env)
    writeFileSync(join(dir, 'added.txt'), 'not from the commit\n')
    expect(publicTree(dir, exportedFiles(dir), committedEntries(repo, env)).problems).toEqual([
      expect.stringMatching(/^added\.txt: written by the export, and not a file of the commit/),
      expect.stringMatching(/^version\.txt: the export wrote another content/)
    ])
  })
})

describe('the complete secret scan', () => {
  const dir = (): string => tree(SOURCES)
  const env: Env = { PATH: process.env.PATH }

  it('passes when every scanner installed finds nothing', () => {
    expect(secretProblems(dir(), scanners(CLEAN), env)).toEqual([])
    expect(secretProblems(dir(), scanners({ ...CLEAN, trufflehog: { code: 0 } }), env)).toEqual([])
  })

  it('refuses the export when no scanner is installed, and says what to install', () => {
    expect(secretProblems(dir(), folder('no-tool'), env)).toEqual([expect.stringMatching(/no secret scanner is installed.*brew install gitleaks.*brew install trufflehog/)])
  })

  it('refuses what gitleaks finds, with the rule and the place and without the value', () => {
    const report = JSON.stringify([{ RuleID: 'generic-api-key', File: 'src/index.ts', StartLine: 3, Secret: 'the-value', Match: 'key = the-value' }])
    const problems = secretProblems(dir(), scanners({ gitleaks: { code: 3, output: report } }), env)
    expect(problems).toEqual([expect.stringMatching(/^gitleaks found 1 possible secret\(s\) in the export: src\/index\.ts:3 \(generic-api-key\)/)])
    expect(problems.join('\n')).not.toContain('the-value')
  })

  it('refuses what trufflehog finds, verified or not, even when gitleaks found nothing', () => {
    const line = JSON.stringify({ DetectorName: 'Github', Verified: false, Raw: 'the-value', SourceMetadata: { Data: { Filesystem: { file: 'docs/guide.md', line: 7 } } } })
    const problems = secretProblems(dir(), scanners({ ...CLEAN, trufflehog: { code: 183, output: `{"level":"info"}\n${line}\n` } }), env)
    expect(problems).toEqual([expect.stringMatching(/^trufflehog found 1 possible secret\(s\) in the export: docs\/guide\.md:7 \(Github\)/)])
    expect(problems.join('\n')).not.toContain('the-value')
    // A report with no line that can be read: the exit code alone refuses.
    expect(secretProblems(dir(), scanners({ trufflehog: { code: 183, output: '{ broken\n' } }), env)).toEqual([expect.stringMatching(/^trufflehog found at least one possible secret\(s\) in the export: see its own output/)])
  })

  it('refuses the export when a scanner stops on an error, or when its report cannot be read', () => {
    expect(secretProblems(dir(), scanners({ gitleaks: { code: 1 } }), env)).toEqual([expect.stringMatching(/^gitleaks did not finish its scan \(exit code 1: the scan broke\)/)])
    expect(secretProblems(dir(), scanners({ gitleaks: { code: 3, output: '[ not json' } }), env)).toEqual([expect.stringMatching(/^gitleaks found 1 possible secret\(s\) in the export: its report cannot be read/)])
  })

  it('finds a tool that can be run in the folders of a path, and not a file that cannot', () => {
    const bin = scanners(CLEAN)
    writeFileSync(join(bin, 'trufflehog'), 'not a program')
    expect(findTool('gitleaks', `${folder('other')}:${bin}`)).toBe(join(bin, 'gitleaks'))
    expect(findTool('trufflehog', bin)).toBeNull()
  })

  const installed = findTool('gitleaks', process.env.PATH ?? '')
  it.skipIf(installed === null)('the gitleaks of this machine, run as the export runs it, finds a key in a file and leaves plain sources alone', { timeout: 120_000 }, () => {
    const bin = dirname(installed ?? '')
    expect(secretProblems(dir(), bin, env).filter((problem) => problem.startsWith('gitleaks'))).toEqual([])
    // In parts: this file is scanned too.
    const planted = tree({ ...SOURCES, 'src/config.ts': ['const TOKEN = ', "'tok_9f8e", "7d6c5b4a'", '\n'].join('') })
    expect(secretProblems(planted, bin, env).filter((problem) => problem.startsWith('gitleaks'))).toEqual([expect.stringMatching(/src\/config\.ts:1 \(generic-api-key\)/)])
  })
})

describe('the identity of the commit', { timeout: 60_000 }, () => {
  it('passes with a noreply address for the author and the committer, a signing key and signed commits', () => {
    expect(identityProblems(folder('new'), environment())).toEqual([])
    for (const address of [NOREPLY, 'someone@users.noreply.github.com']) expect(NOREPLY_ADDRESS.test(address), address).toBe(true)
    for (const address of [PERSONAL, 'someone@users.noreply.github.com.example.org', 'someone@noreply.github.com', '']) expect(NOREPLY_ADDRESS.test(address), address).toBe(false)
  })

  it('is refused when the configured address is a personal one, and the refusal names its host only', () => {
    const problems = identityProblems(folder('new'), environment({ email: PERSONAL }))
    expect(problems).toEqual([expect.stringMatching(/^the author of the commit would be an address at example\.org/), expect.stringMatching(/^the committer of the commit would be an address at example\.org/)])
    expect(problems.join('\n')).not.toContain(PERSONAL)
  })

  it('is refused when the environment gives the committer alone, or the author alone, a personal address', () => {
    expect(identityProblems(folder('new'), environment({}, { GIT_COMMITTER_EMAIL: PERSONAL }))).toEqual([expect.stringMatching(/^the committer of the commit/)])
    expect(identityProblems(folder('new'), environment({}, { GIT_AUTHOR_EMAIL: PERSONAL }))).toEqual([expect.stringMatching(/^the author of the commit/)])
  })

  it('reads what a new repository takes, not the settings of the repository beside it', () => {
    const { repo, env } = repository(SOURCES, environment({ email: PERSONAL }))
    git(repo, env, 'config', 'user.email', NOREPLY)
    expect(identityProblems(repo, env)).toEqual([])
    expect(identityProblems(folder('new'), env)).toHaveLength(2)
  })

  it('is refused when commits are not signed, and when no signing key is named', () => {
    expect(identityProblems(folder('new'), environment({ sign: false }))).toEqual([expect.stringMatching(/^commits are not signed/)])
    expect(identityProblems(folder('new'), environment({ key: false }))).toEqual([expect.stringMatching(/^no signing key is named/)])
  })
})

describe('the commit that is prepared', { timeout: 60_000 }, () => {
  /** An export of plain sources with its repository made, and the tree it must have. */
  function prepared(env: Env = environment()): { dir: string; env: Env; tree: string } {
    const source = repository({ ...SOURCES, '.gitignore': 'kept/\n', 'kept/ignored.txt': 'tracked all the same\n' }, env)
    const dir = folder('public')
    exportTree(source.repo, dir, env)
    const tree = publicTree(dir, exportedFiles(dir), committedEntries(source.repo, env)).hash
    expect(prepareCommit(dir, 'chore: the first commit', env)).toEqual([])
    return { dir, env, tree }
  }

  it('is one signed commit of the whole export on main, files that .gitignore names included, with no remote and no hook', () => {
    const { dir, env, tree } = prepared()
    expect(commitProblems(dir, tree, env)).toEqual([])
    expect(git(dir, env, 'ls-files')).toContain('kept/ignored.txt')
    expect(git(dir, env, 'log', '--format=%ae %ce %s')).toBe(`${NOREPLY} ${NOREPLY} chore: the first commit`)
    expect(git(dir, env, 'cat-file', 'commit', 'HEAD')).toMatch(/^gpgsig -----BEGIN SSH SIGNATURE-----$/m)
    expect(git(dir, env, 'log', '--format=%b')).toContain(`Signed-off-by: Someone <${NOREPLY}>`)
    expect(git(dir, env, 'remote')).toBe('')
    expect(existsSync(join(dir, '.git', 'hooks'))).toBe(false)
  })

  it('is refused with a remote, a second branch, a second commit or another tree', () => {
    const { dir, env, tree } = prepared()
    git(dir, env, 'remote', 'add', 'archive', 'https://example.org/private.git')
    expect(commitProblems(dir, tree, env)).toEqual([expect.stringMatching(/has a remote \(archive\)/)])
    git(dir, env, 'remote', 'remove', 'archive')
    git(dir, env, 'branch', 'old')
    expect(commitProblems(dir, tree, env)).toEqual([expect.stringMatching(/the branch main and nothing else, and has: refs\/heads\/main, refs\/heads\/old/)])
    git(dir, env, 'branch', '--delete', 'old')
    writeFileSync(join(dir, 'late.txt'), 'added after the checks\n')
    git(dir, env, 'add', 'late.txt')
    git(dir, env, 'commit', '--quiet', '--message', 'late')
    expect(commitProblems(dir, tree, env)).toEqual([expect.stringMatching(/has 2 commit\(s\), not one/), expect.stringMatching(/^the tree of the commit is [0-9a-f]{40}, not the tree of the export/), 'the commit has a parent.'])
  })

  it('is refused when it borrows its objects from another repository', () => {
    const { dir, env, tree } = prepared()
    mkdirSync(join(dir, '.git', 'objects', 'info'), { recursive: true })
    writeFileSync(join(dir, '.git', 'objects', 'info', 'alternates'), `${join(folder('archive'), '.git', 'objects')}\n`)
    expect(commitProblems(dir, tree, env)).toEqual([expect.stringMatching(/borrows its objects/)])
  })

  it('is refused when the commit itself carries a personal address or no signature, whatever the configuration says now', () => {
    const { dir, env, tree } = prepared(environment({}, { GIT_COMMITTER_EMAIL: PERSONAL }))
    expect(commitProblems(dir, tree, env)).toEqual(['the committer of the commit is not a …@users.noreply.github.com address.'])
    git(dir, env, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--amend', '--no-edit', `--author=Someone <${PERSONAL}>`)
    expect(commitProblems(dir, tree, env)).toEqual([
      'the author of the commit is not a …@users.noreply.github.com address.',
      'the committer of the commit is not a …@users.noreply.github.com address.',
      'the commit is not signed.'
    ])
  })

  it('is signed even when the configuration does not ask for it, and no hook of the machine runs', () => {
    const env = environment({ sign: false })
    const hooks = folder('hooks')
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho "a hook of the machine ran" >&2\nexit 1\n')
    chmodSync(join(hooks, 'pre-commit'), 0o755)
    writeFileSync(env.GIT_CONFIG_GLOBAL ?? '', `${readFileSync(env.GIT_CONFIG_GLOBAL ?? '', 'utf8')}[core]\n\thooksPath = ${hooks}\n`)
    const dir = tree(SOURCES)
    expect(prepareCommit(dir, 'chore: the first commit', env)).toEqual([])
    expect(git(dir, env, 'cat-file', 'commit', 'HEAD')).toMatch(/^gpgsig /m)
  })

  it('says which step failed when the signature cannot be made', () => {
    const env = environment()
    writeFileSync(env.GIT_CONFIG_GLOBAL ?? '', readFileSync(env.GIT_CONFIG_GLOBAL ?? '', 'utf8').replace(`${keyFile}.pub`, join(root, 'no-such-key.pub')))
    const dir = tree(SOURCES)
    expect(prepareCommit(dir, 'chore: the first commit', env)).toEqual([expect.stringMatching(/^`git commit` failed in /)])
  })
})

describe('the files no rule reads', () => {
  const files = [
    { path: 'README.md', size: 120, link: false },
    { path: 'docs/guide.PDF', size: 2_500_000, link: false },
    { path: 'resources/icon.png', size: 40_000, link: false },
    { path: 'src/main/index.ts', size: 900, link: false },
    { path: 'tests/fixtures/sample.zip', size: 300, link: false }
  ]

  it('are the binary ones, and the run lists each with its size, for a person to look at', () => {
    const unread = unreadFiles(files)
    expect(unread.map((file) => file.path)).toEqual(['docs/guide.PDF', 'resources/icon.png', 'tests/fixtures/sample.zip'])
    expect(unreadReport(unread)).toEqual([
      expect.stringMatching(/^Not read {10}3 binary file\(s\), 2\.5 MB: no rule looks inside them .* Look at each before pushing:$/),
      '                    docs/guide.PDF (2500000 bytes)',
      '                    resources/icon.png (40000 bytes)',
      '                    tests/fixtures/sample.zip (300 bytes)'
    ])
    expect(unreadReport(unreadFiles([files[0]!, files[3]!]))).toEqual([])
  })

  it('are what `treeProblems` does not open: a mark inside one is not seen, which is why the run names the file', () => {
    const dir = folder('unread')
    const finding = ['SEC', '057'].join('-')
    write(dir, { 'notes.txt': `${finding}\n`, 'notes.pdf': `${finding}\n` })
    const exported = exportedFiles(dir)
    expect(treeProblems(dir, exported)).toEqual([expect.stringMatching(/^notes\.txt: a finding of an unpublished audit/)])
    expect(unreadFiles(exported).map((file) => file.path)).toEqual(['notes.pdf'])
  })
})

describe('the files that are not under the GPL', () => {
  const sized = (paths: readonly string[]) => paths.map((path) => ({ path, size: 10, link: false }))
  const LOGO = ['scripts/logo/fan-logo.ts', 'build/icon.icns', 'resources/app-icons/clair.png']
  const MEDIA = ['resources/backgrounds/lucium-foret.mp4', 'resources/backgrounds/lucium-foret.jpg']
  const NOTICE = 'The logo: see TRADEMARKS.md. The videos: see NOTICE-MEDIA.md.\n'

  it('are the logo, the icons made from it and the generated media, and nothing else', () => {
    for (const path of [...LOGO, ...MEDIA]) expect(outsideGpl(path), path).toBeDefined()
    expect(outsideGpl(LOGO[0]!)?.notice).toBe('TRADEMARKS.md')
    expect(outsideGpl(MEDIA[0]!)?.notice).toBe('NOTICE-MEDIA.md')
    for (const path of ['scripts/logo/make-icons.mjs', 'resources/backgrounds/README.md', 'resources/fonts/inter.woff2', 'src/main/index.ts', 'compat/probe/icon.png']) expect(outsideGpl(path), path).toBeUndefined()
  })

  it('leave with the notice that says their licence, named by NOTICE', () => {
    expect(noticeProblems(sized([...LOGO, ...MEDIA, 'NOTICE', 'TRADEMARKS.md', 'NOTICE-MEDIA.md']), NOTICE)).toEqual([])
    expect(noticeProblems(sized(['README.md', 'src/main/index.ts']), null)).toEqual([])
  })

  it('are refused without their notice, without NOTICE, and when NOTICE does not name the notice', () => {
    expect(noticeProblems(sized([...LOGO, ...MEDIA, 'NOTICE', 'TRADEMARKS.md']), NOTICE)).toEqual([
      '2 file(s) outside the GPL (generated by artificial intelligence, under no free licence; the first: resources/backgrounds/lucium-foret.mp4) are exported without NOTICE-MEDIA.md, which says their licence.'
    ])
    expect(noticeProblems(sized([...LOGO, 'TRADEMARKS.md']), null)).toEqual([expect.stringMatching(/^3 file\(s\) outside the GPL \(the logo, reserved for the official builds; the first: scripts\/logo\/fan-logo\.ts\) are exported without the NOTICE file, which must name TRADEMARKS\.md\.$/)])
    expect(noticeProblems(sized([...MEDIA, 'NOTICE', 'NOTICE-MEDIA.md']), 'The logo: see TRADEMARKS.md.\n')).toEqual([expect.stringMatching(/are exported, and NOTICE does not name NOTICE-MEDIA\.md\.$/)])
  })

  it('are refused by the controls of the tree, which read NOTICE in the export', () => {
    const dir = folder('outside-gpl')
    write(dir, { 'resources/backgrounds/lucium-foret.mp4': 'not really a video\n', NOTICE: 'Lucium\n', 'NOTICE-MEDIA.md': '# Media\n' })
    expect(treeProblems(dir, exportedFiles(dir))).toEqual([expect.stringMatching(/^1 file\(s\) outside the GPL .* are exported, and NOTICE does not name NOTICE-MEDIA\.md\.$/)])
    write(dir, { NOTICE: NOTICE })
    expect(treeProblems(dir, exportedFiles(dir))).toEqual([])
  })

  it('are marked in the list of the files no rule reads', () => {
    expect(unreadReport(unreadFiles(sized(['resources/app-icons/clair.png', 'resources/backgrounds/lucium-foret.mp4', 'resources/fonts/inter.woff2']))).slice(1)).toEqual([
      '                    resources/app-icons/clair.png (10 bytes; not under the GPL: TRADEMARKS.md)',
      '                    resources/backgrounds/lucium-foret.mp4 (10 bytes; not under the GPL: NOTICE-MEDIA.md)',
      '                    resources/fonts/inter.woff2 (10 bytes)'
    ])
  })
})

describe('the whole run', { timeout: 120_000 }, () => {
  it('reports the binary files it exported and did not read', () => {
    const { repo, env, head } = repository({ ...SOURCES, 'resources/icon.png': 'not really an image\n', 'docs/guide.pdf': '%PDF-1.4\n' })
    const result = runExport({ repo, check: true, expected: head, scannerPath: scanners(CLEAN), tmp: folder('tmp-unread'), env })
    expect(result.refusals).toEqual([])
    expect(result.unread).toEqual([
      { path: 'docs/guide.pdf', size: 9, link: false },
      { path: 'resources/icon.png', size: 20, link: false }
    ])
  })

  const INTERNAL = { ...SOURCES, '.gitattributes': '/docs/plans export-ignore\n/docs/plans/** export-ignore\n', 'docs/plans/jour-j.md': '# Jour J\n' }

  it('a check makes every control, reports the files, the weight and the tree, and leaves nothing behind', () => {
    const { repo, env, head } = repository(INTERNAL)
    const tmp = folder('tmp')
    const result = runExport({ repo, check: true, expected: head, scannerPath: scanners(CLEAN), tmp, env })
    expect(result.refusals).toEqual([])
    expect(result).toMatchObject({ head, files: 4, unread: [], commit: null })
    expect(result.bytes).toBe(Object.entries(INTERNAL).filter(([path]) => !path.startsWith('docs/plans/')).reduce((sum, [, content]) => sum + content.length, 0))
    expect(result.tree).toMatch(/^[0-9a-f]{40}$/)
    expect(readdirSync(tmp)).toEqual([])
    expect(git(repo, env, 'status', '--porcelain')).toBe('')
  })

  it('a check reports every refusal at once: the source, the tree, the scan and the identity', () => {
    const former = ['Arbal', 'ette'].join('')
    const { repo, env } = repository({ ...SOURCES, 'README.md': `# ${former}\n` }, environment({ email: PERSONAL, sign: false }))
    writeFileSync(join(repo, 'notes.txt'), 'not committed\n')
    const tmp = folder('tmp')
    const result = runExport({ repo, check: true, expected: '0000000', maxBytes: 10, scannerPath: folder('no-tool'), tmp, env })
    expect(result.refusals.map((refusal) => refusal.slice(0, 28))).toEqual([
      'the working tree is not clea',
      `HEAD is ${result.head.slice(0, 12)}, not th`,
      'README.md: the former name o',
      'the export weighs 0.0 MB, mo',
      'no secret scanner is install',
      'the author of the commit wou',
      'the committer of the commit ',
      'commits are not signed: `com'
    ])
    expect(readdirSync(tmp)).toEqual([])
  })

  it('an export makes the repository in the folder: one signed commit of the public tree, no remote, the internal paths left out', () => {
    const { repo, env, head } = repository(INTERNAL)
    const dest = join(folder('parent'), 'public')
    const result = runExport({ repo, dest, expected: head, check: false, scannerPath: scanners(CLEAN), env })
    expect(result.refusals).toEqual([])
    expect(result.commit).toBe(git(dest, env, 'rev-parse', 'HEAD'))
    expect(git(dest, env, 'rev-parse', 'HEAD^{tree}')).toBe(result.tree)
    expect(git(dest, env, 'ls-files').split('\n')).toEqual(['.gitattributes', 'docs/guide.md', 'package.json', 'src/index.ts'])
    expect(git(dest, env, 'log', '--format=%s')).toBe('chore: Lucium 1.2.3, the first commit of the public repository')
    expect(git(dest, env, 'remote')).toBe('')
    expect(git(dest, env, 'rev-list', '--count', '--all')).toBe('1')
    expect(commitProblems(dest, result.tree, env)).toEqual([])
    // The source repository was only read.
    expect(git(repo, env, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(repo, env, 'remote')).toBe('')
  })

  it('an export needs the commit expected, and stops before writing when the source or the folder is refused', () => {
    const { repo, env, head } = repository()
    const dest = folder('public')
    const bin = scanners(CLEAN)
    expect(runExport({ repo, dest, check: false, scannerPath: bin, env }).refusals).toEqual([expect.stringMatching(/the expected commit is not given/)])
    expect(readdirSync(dest)).toEqual([])
    writeFileSync(join(repo, 'notes.txt'), 'not committed\n')
    expect(runExport({ repo, dest, expected: head, check: false, scannerPath: bin, env }).refusals).toEqual([expect.stringMatching(/not clean/)])
    expect(readdirSync(dest)).toEqual([])
    rmSync(join(repo, 'notes.txt'))
    expect(runExport({ repo, dest: join(repo, 'public'), expected: head, check: false, scannerPath: bin, env }).refusals).toEqual([expect.stringMatching(/is inside the source repository/)])
    expect(existsSync(join(repo, 'public'))).toBe(false)
    writeFileSync(join(dest, 'left-over.txt'), 'x')
    expect(runExport({ repo, dest, expected: head, check: false, scannerPath: bin, env }).refusals).toEqual([expect.stringMatching(/is not empty/)])
    expect(readdirSync(dest)).toEqual(['left-over.txt'])
  })

  it('an export refused by a control makes no repository and leaves the folder empty', () => {
    const finding = ['SEC', '057'].join('-')
    const cases: { files?: Record<string, string>; env?: Env; bin?: Record<string, { code: number; output?: string }>; refusal: RegExp }[] = [
      { files: { ...SOURCES, 'src/guard.ts': `// ${finding}\n` }, refusal: /a finding of an unpublished audit/ },
      { files: { ...SOURCES, 'docs/plans/jour-j.md': '# Jour J\n' }, refusal: /an internal path/ },
      { files: { ...SOURCES, '.gitattributes': 'version.txt export-subst\n', 'version.txt': '$Format:%H$\n' }, refusal: /the export wrote another content/ },
      { bin: {}, refusal: /no secret scanner is installed/ },
      { bin: { gitleaks: { code: 3, output: '[{"RuleID":"private-key","File":"src/index.ts","StartLine":1}]' } }, refusal: /gitleaks found 1/ },
      { env: environment({ email: PERSONAL }), refusal: /the author of the commit would be/ },
      { env: environment({ sign: false }), refusal: /commits are not signed/ }
    ]
    // A stand-in of git that notes what it is asked, to see that no repository was ever started.
    const noted = folder('noted')
    const real = findTool('git', process.env.PATH ?? '') ?? 'git'
    writeFileSync(join(noted, 'git'), `#!/bin/sh\necho "$1" >> "${join(noted, 'asked')}"\nexec "${real}" "$@"\n`)
    chmodSync(join(noted, 'git'), 0o755)
    for (const { files, env, bin, refusal } of cases) {
      const source = repository(files ?? SOURCES, env ?? environment())
      const dest = folder('public')
      writeFileSync(join(noted, 'asked'), '')
      const result = runExport({ repo: source.repo, dest, expected: source.head, check: false, scannerPath: scanners(bin ?? CLEAN), env: { ...source.env, PATH: `${noted}:${source.env.PATH}` } })
      expect(result.refusals[0], String(refusal)).toMatch(refusal)
      expect(result.commit).toBeNull()
      expect(readdirSync(dest), String(refusal)).toEqual([])
      const asked = readFileSync(join(noted, 'asked'), 'utf8').split('\n')
      expect(asked, String(refusal)).toContain('archive')
      expect(asked, String(refusal)).not.toContain('init')
    }
  })

  it('an export whose commit is not what was checked removes the repository it made', () => {
    const { repo, env, head } = repository()
    const dest = folder('public')
    // The committer changes between the control and the commit: only the commit itself shows it.
    const flip = folder('flip')
    const real = findTool('git', process.env.PATH ?? '') ?? 'git'
    writeFileSync(join(flip, 'git'), `#!/bin/sh\nif [ "$1" = "-c" ]; then export GIT_COMMITTER_EMAIL=${PERSONAL}; fi\nexec "${real}" "$@"\n`)
    chmodSync(join(flip, 'git'), 0o755)
    const result = runExport({ repo, dest, expected: head, check: false, scannerPath: scanners(CLEAN), env: { ...env, PATH: `${flip}:${env.PATH}` } })
    expect(result.refusals).toEqual(['the committer of the commit is not a …@users.noreply.github.com address.'])
    expect(result.commit).toBeNull()
    expect(readdirSync(dest)).toEqual([])
  })
})

// The script itself, run as the maintainer runs it: its arguments, what it prints (the « Not read » lines among them) and its exit code. It exports
// the repository it is in, so it is copied, with the module it loads, into a repository made here; the scanners are the stand-ins above.
describe('scripts/export-public.mjs, run', { timeout: 120_000 }, () => {
  const real = (path: string): string => readFileSync(join(import.meta.dirname, '..', '..', path), 'utf8')
  const SCRIPT_FILES = { 'scripts/export-public.mjs': real('scripts/export-public.mjs'), 'src/main/public-export.ts': real('src/main/public-export.ts') }

  function run(repo: string, env: Env, ...args: string[]) {
    return spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(repo, 'scripts', 'export-public.mjs'), ...args], { cwd: repo, encoding: 'utf8', env: { ...env, PATH: `${scanners(CLEAN)}:${env.PATH}` }, timeout: 100_000 })
  }

  it('checks a clean repository, says what it read and names each binary file it did not, and leaves nothing behind', () => {
    const { repo, env, head } = repository({ ...SOURCES, ...SCRIPT_FILES, 'docs/diagram.png': 'not really a picture\n' })
    const result = run(repo, env, '--check', '--commit', head)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`Commit exported   ${head}\n`)
    expect(result.stdout).toMatch(/^Files {13}6$/m)
    expect(result.stdout).toMatch(/^Not read {10}1 binary file\(s\), [\d.]+ [kM]?B: no rule looks inside them .* Look at each before pushing:$/m)
    expect(result.stdout).toContain('\n                    docs/diagram.png (21 bytes)\n')
    expect(result.stdout).toMatch(/Every control passed\. Nothing was created\.\n$/)
    expect(git(repo, env, 'status', '--porcelain')).toBe('')
  })

  it('says when no commit was given to compare, and prints no « Not read » line when every file was read', () => {
    const { repo, env } = repository({ ...SOURCES, ...SCRIPT_FILES })
    const result = run(repo, env, '--check')
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^Commit exported {3}[0-9a-f]{40} \(not compared: no --commit given\)$/m)
    expect(result.stdout).not.toContain('Not read')
  })

  it('refuses with code 1 and each reason, and with code 2 when the arguments are wrong', () => {
    const { repo, env } = repository({ ...SOURCES, ...SCRIPT_FILES })
    const refused = run(repo, env, '--check', '--commit', '0000000')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toMatch(/\nRefused, 1 reason\(s\):\n {2}- HEAD is [0-9a-f]{12}/)
    expect(refused.stdout).not.toContain('Every control passed')
    expect(run(repo, env, '--check', 'a-folder').status).toBe(2)
    expect(run(repo, env, folder('dest')).status).toBe(2)
    expect(run(repo, env, '--check', '--unknown').status).toBe(2)
  })
})
