import { execFileSync, spawnSync } from 'node:child_process'
import { globSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, matchesGlob } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { posix } from './windows.test-support'

// The workflows only run on GitHub, where a mistake is silent: an action that moved under its tag, a token with more rights than the job
// needs, a workflow that runs the code of a pull request with the rights of the repository. The rules are checked here as text on every
// file of .github/workflows, and the shell scripts that decide something (the sign-off, the title of a pull request, the range of the secret
// scan, the sums of a release, the names of the check builds) are taken out of the YAML and run, on a repository and on files made for the test.
const here = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url))
const read = (relative: string) => readFileSync(here(relative), 'utf8')

/** The lines that are not comments, so that a comment saying "never pull_request_target" cannot pass for code. */
const code = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')

const FILES = readdirSync(here('.github/workflows')).filter((file) => /\.ya?ml$/.test(file)).sort()
const workflows = FILES.map((file) => ({ file, text: code(read(`.github/workflows/${file}`)) }))
/** The local actions (.github/actions/<name>/action.yml): steps shared by the workflows, held to the same rules about what they use and hold. */
const ACTION_FILES = globSync('.github/actions/*/action.yml', { cwd: here('.') }).map((file) => posix(file)).sort()
const localActions = ACTION_FILES.map((file) => ({ file, text: code(read(file)) }))

/** A top-level block (`permissions:`, `concurrency:`, `on:`): its first line and the indented lines under it. */
const block = (text: string, key: string): string | undefined => new RegExp(`^${key}:.*\\n(?:(?: .*)?\\n)*`, 'm').exec(`${text}\n`)?.[0].trimEnd()

/** The jobs of a workflow: the keys two spaces deep under `jobs:`, each with its text. */
const jobsOf = (text: string): { id: string; text: string }[] => {
  const lines = text.split('\n')
  const start = lines.indexOf('jobs:')
  const jobs: { id: string; text: string }[] = []
  if (start < 0) return jobs
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const id = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(line)?.[1]
    const last = jobs.at(-1)
    if (id) jobs.push({ id, text: '' })
    else if (last) last.text += `${line}\n`
  }
  return jobs
}

describe('every workflow of .github/workflows', () => {
  it('is read, and its jobs are found (one `runs-on` per job)', () => {
    for (const expected of ['audit.yml', 'build.yml', 'ci.yml', 'codeql.yml', 'dependency-review.yml', 'e2e.yml', 'pr-conventions.yml', 'release.yml', 'sbom.yml', 'scorecard.yml', 'secret-scanning.yml', 'smoke-macos.yml']) {
      expect(FILES).toContain(expected)
    }
    for (const { file, text } of workflows) {
      const jobs = jobsOf(text)
      expect(jobs.length, file).toBeGreaterThan(0)
      expect(jobs.length, file).toBe(text.match(/^\s*runs-on:/gm)?.length)
      for (const job of jobs) expect(job.text, `${file} ${job.id}`).toMatch(/^ {4}runs-on: /m)
    }
  })

  it('pins every action by the SHA of a commit, with the version in a comment', () => {
    let found = 0
    expect(ACTION_FILES).toContain('.github/actions/setup/action.yml')
    for (const { file, text } of [...workflows, ...localActions]) {
      for (const line of text.split('\n').filter((candidate) => /\buses\s*:/.test(candidate))) {
        // A local action is called by its folder (which holds an action.yml, checked above); anything else is pinned by commit.
        const local = /^\s+(- )?uses: \.\/(\.github\/actions\/[a-z][a-z-]*)$/.exec(line)?.[2]
        if (local) {
          expect(ACTION_FILES, `${file}: ${line}`).toContain(`${local}/action.yml`)
          continue
        }
        expect(line, file).toMatch(/^\s+(- )?uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/)
        found += 1
      }
    }
    expect(found).toBeGreaterThan(20)
  })

  it('pins every container image it names by digest', () => {
    let found = 0
    for (const { file, text } of workflows) {
      expect(text, file).not.toMatch(/^\s*(container|services):/m)
      for (const image of text.match(/(?:docker:\/\/|ghcr\.io\/|docker\.io\/|quay\.io\/)[^\s"']+/g) ?? []) {
        expect(image, file).toMatch(/@sha256:[0-9a-f]{64}$/)
        found += 1
      }
    }
    expect(found).toBeGreaterThanOrEqual(1)
  })

  it('gives every job its own `permissions`, and never a write permission at the top of the file', () => {
    let jobs = 0
    for (const { file, text } of workflows) {
      const top = block(text, 'permissions')
      expect(top, file).toBeDefined()
      expect(top, file).not.toMatch(/write/)
      for (const job of jobsOf(text)) {
        expect(job.text, `${file}: the job ${job.id} has no permissions of its own`).toMatch(/^ {4}permissions:(?: \{\}|\n {6}[a-z-]+: (?:read|write))$/m)
        jobs += 1
      }
    }
    expect(jobs).toBeGreaterThan(15)
  })

  it('writes only where a job needs it: an issue, the code scanning results, a draft release', () => {
    const writes: Record<string, string[]> = {}
    for (const { file, text } of workflows) {
      const scopes = [...text.matchAll(/^\s+([a-z-]+): write$/gm)].map((match) => match[1] ?? '').sort()
      if (scopes.length > 0) writes[file] = scopes
    }
    expect(writes).toEqual({
      'chromium-watch.yml': ['issues'],
      'codeql.yml': ['security-events'],
      'release.yml': ['contents'],
      'scorecard.yml': ['id-token', 'security-events']
    })
  })

  it('never runs with the rights of the repository on the code of a pull request', () => {
    for (const { file, text } of workflows) expect(text, file).not.toMatch(/pull_request_target|workflow_run/)
  })

  it('bounds every job in time and says what happens to a run that is overtaken', () => {
    for (const { file, text } of workflows) {
      for (const job of jobsOf(text)) expect(job.text, `${file} ${job.id}`).toMatch(/^ {4}timeout-minutes: \d+$/m)
      expect(block(text, 'concurrency'), file).toMatch(/^concurrency:\n {2}group: \S.*\n {2}cancel-in-progress: \S/)
    }
  })

  it('holds no secret, and no signing or notarization', () => {
    for (const { file, text } of [...workflows, ...localActions]) expect(text, file).not.toMatch(/\bsecrets\.|notarytool|codesign --sign|CSC_LINK|CSC_KEY_PASSWORD|APPLE_API_|LUCIUM_SIGN_IDENTITY/)
  })

  // Storage is free on a public repository, but a private copy or a fork pays for it, and the project must never cost its maintainer
  // anything: what a workflow keeps is kept for days, and written once, not once per pull request or per commit.
  it('keeps no artifact longer than a week', () => {
    for (const { file, text } of workflows) {
      const lines = text.split('\n')
      lines.forEach((line, at) => {
        if (!/\buses:\s*actions\/upload-artifact@/.test(line)) return
        const start = lines.findLastIndex((candidate, index) => index <= at && /^ {6}- /.test(candidate))
        const end = lines.findIndex((candidate, index) => index > at && /^ {6}- /.test(candidate))
        const days = Number(/^\s+retention-days: (\d+)\s*$/m.exec(lines.slice(start, end < 0 ? undefined : end).join('\n'))?.[1])
        expect(days >= 1 && days <= 7, `${file} line ${at + 1}: retention-days is 1 to 7`).toBe(true)
      })
    }
  })

  it('writes the pnpm store to the cache from main only, and only for the quick checks of ci.yml', () => {
    const setup = localActions.find((action) => action.file === '.github/actions/setup/action.yml')?.text ?? ''
    expect(setup).toMatch(/^\s+cache: \$\{\{ inputs\.cache \}\}$/m)
    expect(setup).toMatch(/^\s+save-cache: \$\{\{ .*github\.ref == 'refs\/heads\/main'.* \}\}$/m)
    for (const { file, text } of workflows) {
      if (file === 'ci.yml') expect(text, file).toMatch(/^ {10}cache: 'true'$/m)
      else expect(text, file).not.toMatch(/\bcache:\s*'?true'?\s*$/m)
    }
  })

  it('keeps CodeQL from saving an overlay database (hundreds of megabytes, one per run) in the cache', () => {
    const codeql = workflows.find((workflow) => workflow.file === 'codeql.yml')?.text ?? ''
    expect(codeql).toMatch(/^ {6}CODEQL_OVERLAY_DATABASE_MODE: none$/m)
  })
})

/** The script of a step, as bash runs it: the lines under `run: |` of the step of that name, in that job. */
const script = (file: string, job: string, step: string): string => {
  const text = jobsOf(code(read(`.github/workflows/${file}`))).find((candidate) => candidate.id === job)?.text
  expect(text, `${file} ${job}`).toBeDefined()
  const lines = (text ?? '').split('\n')
  const at = lines.indexOf(`      - name: ${step}`)
  expect(at, `${file}: ${step}`).toBeGreaterThanOrEqual(0)
  const end = lines.findIndex((line, index) => index > at && /^ {6}- /.test(line))
  const body = lines.slice(at + 1, end < 0 ? undefined : end)
  const run = body.indexOf('        run: |')
  expect(run, `${file}: ${step} has a script`).toBeGreaterThanOrEqual(0)
  const out = body.slice(run + 1).map((line) => line.slice(10))
  // Nothing of GitHub's `${{ }}` in a script that is run here: what it needs comes through the environment. (The comments of a script are not
  // in it: `code` took them out, which changes nothing for bash.)
  expect(out.join('\n'), `${file}: ${step}`).not.toMatch(/\$\{\{/)
  return out.join('\n')
}

const folders: string[] = []
const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lucium-workflow-'))
  folders.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const bash = (source: string, cwd: string, env: Record<string, string> = {}) => {
  const result = spawnSync('bash', ['-c', source], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env } })
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

/** A repository made for a test: `commit` writes one empty commit with that author and message, and gives its SHA. */
const repository = () => {
  const dir = folder()
  const env = { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_COMMITTER_NAME: 'Committer', GIT_COMMITTER_EMAIL: 'committer@example.org' }
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env }).trim()
  git('init', '-q', '-b', 'main')
  const commit = (message: string, name = 'Ada Lovelace', email = 'ada@example.org'): string => {
    git('-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '--allow-empty', '--author', `${name} <${email}>`, '-m', message)
    return git('rev-parse', 'HEAD')
  }
  return { dir, git, commit }
}

// The scripts are bash, as on the runners. On Windows `bash` may be anything (or missing): these are run on macOS and Linux.
// Each test makes a repository and runs Git and bash a dozen times: more than a second on a quiet machine, several times that when every core is taken.
describe.skipIf(process.platform === 'win32')('the scripts of the workflows, run', { timeout: 30_000 }, () => {
  describe('pr-conventions.yml, DCO', () => {
    const dco = () => script('pr-conventions.yml', 'dco', 'Every commit is signed off by its author')
    const check = (make: (repo: ReturnType<typeof repository>) => void) => {
      const repo = repository()
      const base = repo.commit('chore: base')
      make(repo)
      return bash(dco(), repo.dir, { BASE: base, HEAD: repo.git('rev-parse', 'HEAD') })
    }

    it('accepts commits that their author signed off', () => {
      const result = check((repo) => {
        repo.commit('feat: one\n\nSigned-off-by: Ada Lovelace <ada@example.org>')
        repo.commit('fix: two\n\nWhy.\n\nCo-authored-by: Someone <someone@example.org>\nSigned-off-by: Ada Lovelace <ADA@example.org>')
      })
      expect(result.out).toContain('2 commit(s), all signed off by their author.')
      expect(result.status).toBe(0)
    })

    it('refuses a commit with no sign-off, and names it', () => {
      let unsigned = ''
      const result = check((repo) => {
        repo.commit('feat: one\n\nSigned-off-by: Ada Lovelace <ada@example.org>')
        unsigned = repo.commit('fix: two')
      })
      expect(result.status).toBe(1)
      expect(result.out).toContain(`::error title=DCO::Commit ${unsigned.slice(0, 12)} has no Signed-off-by line that names its author.`)
      expect(result.out).toContain('1 of 2 commit(s) lack the sign-off of their author.')
    })

    it('refuses the sign-off of somebody else, one that is not a trailer, and one without an address', () => {
      expect(check((repo) => repo.commit('feat: one\n\nSigned-off-by: Grace Hopper <grace@example.org>')).status).toBe(1)
      expect(check((repo) => repo.commit('feat: one\n\nSigned-off-by: Ada Lovelace <ada@example.org>\n\nA paragraph after it: the line above is not a trailer.')).status).toBe(1)
      expect(check((repo) => repo.commit('feat: one\n\nSigned-off-by: Ada Lovelace')).status).toBe(1)
      expect(check((repo) => repo.commit('feat: one\n\nSigned-off-by: <ada@example.org>')).status).toBe(1)
    })

    it('accepts a sign-off under the same name with another address (a noreply address, a bot)', () => {
      const result = check((repo) => repo.commit('chore(deps): bump vite\n\nSigned-off-by: dependabot[bot] <support@github.com>', 'dependabot[bot]', '49699333+dependabot[bot]@users.noreply.github.com'))
      expect(result.status).toBe(0)
    })

    it('skips the merge commits, and fails when the commits of the pull request are not there', () => {
      const merged = check((repo) => {
        repo.git('checkout', '-q', '-b', 'side')
        repo.commit('feat: side\n\nSigned-off-by: Ada Lovelace <ada@example.org>')
        repo.git('checkout', '-q', 'main')
        repo.commit('feat: main\n\nSigned-off-by: Ada Lovelace <ada@example.org>')
        repo.git('-c', 'user.name=Ada Lovelace', '-c', 'user.email=ada@example.org', 'merge', '-q', '--no-ff', '-m', 'Merge side', 'side')
      })
      expect(merged.out).toContain('2 commit(s), all signed off by their author.')
      expect(merged.status).toBe(0)

      const repo = repository()
      const head = repo.commit('chore: base')
      const missing = bash(dco(), repo.dir, { BASE: 'f'.repeat(40), HEAD: head })
      expect(missing.status).toBe(1)
      expect(missing.out).toContain('is not in the history that was fetched')
    })
  })

  describe('pr-conventions.yml, the title', () => {
    const title = (value: string, author = 'ada') => bash(script('pr-conventions.yml', 'title', 'The title follows Conventional Commits'), folder(), { TITLE: value, AUTHOR: author })

    it('accepts the titles of CONTRIBUTING.md and those Dependabot writes', () => {
      for (const value of [
        'fix(sidebar): keep the selection when a folder closes',
        'feat(blocker): add a per-site exception',
        'docs(community): describe the release process',
        'feat(state)!: drop the old format',
        'chore: tidy',
        'chore(deps): bump the build-tools group with 3 updates',
        'chore(deps-dev): bump vitest from 5.0.5 to 5.1.0',
        'ci(deps): bump the actions group with 2 updates',
        'revert: "feat(blocker): add a per-site exception"'
      ]) {
        expect(title(value).status, value).toBe(0)
      }
    })

    it('refuses the others, and says what is expected', () => {
      for (const value of [
        'Fix the sidebar',
        'fix: Keep the selection',
        'fix(sidebar): keep the selection.',
        'fix(sidebar):keep the selection',
        'fix(Sidebar): keep the selection',
        'feature(sidebar): keep the selection',
        'fix(): keep the selection',
        'fix:  two spaces',
        'wip',
        '',
        '$(touch pwned): `touch pwned`'
      ]) {
        const result = title(value)
        expect(result.status, value).toBe(1)
        expect(result.out, value).toContain('::error title=PR title::')
        expect(result.out, value).toContain('Types: feat, fix, perf, refactor, docs, test, build, ci, chore, revert.')
      }
    })

    it('accepts a capital after the colon from Dependabot only: it styles its titles after the history, and the first commit here has one', () => {
      // "Bump" with a capital is what Dependabot wrote on its first pull request here (chore(deps-dev): Bump electron from 45.2.1 to 45.2.3).
      for (const value of ['chore(deps-dev): Bump electron from 45.2.1 to 45.2.3', 'chore(deps): Bump the build-tools group with 3 updates']) {
        expect(title(value, 'dependabot[bot]').status, value).toBe(0)
        expect(title(value, 'ada').status, `${value} (a person)`).toBe(1)
        // The name is compared whole: nobody else is the bot, and a look-alike is not.
        for (const other of ['dependabot', 'dependabot[bot', 'not-dependabot[bot]', 'Dependabot[bot]', '']) expect(title(value, other).status, `${value} (${other})`).toBe(1)
      }
    })

    it('keeps every other rule for Dependabot: the type, the scope, the colon, the space and the final period', () => {
      for (const value of ['Bump electron from 45.2.1 to 45.2.3', 'chore(deps): Bump electron.', 'chore(deps):Bump electron', 'chore(Deps): Bump electron', 'bump(deps): Bump electron', 'chore(deps):  Bump electron', 'chore(deps): ', '']) {
        const result = title(value, 'dependabot[bot]')
        expect(result.status, value).toBe(1)
        expect(result.out, value).toContain('::error title=PR title::')
      }
    })

    it('has the types of CONTRIBUTING.md', () => {
      const types = /^- Types: (.+)\.$/m.exec(read('CONTRIBUTING.md'))?.[1]?.replaceAll('`', '').split(', ')
      expect(types?.length).toBeGreaterThan(5)
      expect(script('pr-conventions.yml', 'title', 'The title follows Conventional Commits')).toContain(`types='${types?.join('|')}'`)
    })
  })

  describe('secret-scanning.yml, the range', () => {
    const range = (env: Record<string, string>, make?: (repo: ReturnType<typeof repository>) => void) => {
      const repo = repository()
      const first = repo.commit('chore: first')
      repo.commit('chore: second')
      make?.(repo)
      const output = join(repo.dir, 'github-output')
      writeFileSync(output, '')
      const values = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value === 'FIRST' ? first : value]))
      const result = bash(script('secret-scanning.yml', 'secrets', 'Range to scan'), repo.dir, { PR_BASE: '', BEFORE: '', ...values, GITHUB_OUTPUT: output })
      return { ...result, first, base: /^base=(.*)$/m.exec(readFileSync(output, 'utf8'))?.[1] }
    }

    it('scans a push since the commit main was at, and a pull request since its base', () => {
      const push = range({ EVENT: 'push', BEFORE: 'FIRST' })
      expect(push.status).toBe(0)
      expect(push.base).toBe(push.first)
      const pull = range({ EVENT: 'pull_request', PR_BASE: 'FIRST', BEFORE: 'f'.repeat(40) })
      expect(pull.base).toBe(pull.first)
    })

    it('scans the whole history after a forced push, whose "before" is in no history any more, and says so', () => {
      const forced = range({ EVENT: 'push', BEFORE: 'a'.repeat(40) })
      expect(forced.status).toBe(0)
      expect(forced.base).toBe('')
      expect(forced.out).toContain('::notice title=Secret scan::The commit before this push (aaaaaaaaaaaa) is not in the history any more (a forced push): the whole history is scanned.')
    })

    it('scans the whole history for a new branch, a timer and a manual run', () => {
      expect(range({ EVENT: 'push', BEFORE: '0'.repeat(40) }).base).toBe('')
      expect(range({ EVENT: 'schedule', BEFORE: 'FIRST' }).base).toBe('')
      expect(range({ EVENT: 'workflow_dispatch' }).base).toBe('')
    })

    it('fails on a base that is not a commit id, instead of scanning something else', () => {
      const result = range({ EVENT: 'push', BEFORE: 'main' })
      expect(result.status).toBe(1)
      expect(result.base).toBeUndefined()
    })

    it('is the same step in the two passes', () => {
      expect(script('secret-scanning.yml', 'unverified', 'Range to scan')).toBe(script('secret-scanning.yml', 'secrets', 'Range to scan'))
    })
  })

  describe('release.yml, the sums', () => {
    const SUM_A = 'a'.repeat(64)
    const SUM_B = '0123456789abcdef'.repeat(4)
    const sums = (message: string, version = '0.3.0') => {
      const dir = folder()
      writeFileSync(join(dir, 'tag-message.txt'), message)
      const result = bash(script('release.yml', 'draft', 'Checksums from the annotation'), dir, { VERSION: version })
      return { ...result, written: readFileSync(join(dir, 'checksums.txt'), 'utf8') }
    }

    it('keeps the sums of the files of the version, as shasum wrote them, and nothing else of the annotation', () => {
      const result = sums(`v0.3.0\n\n${SUM_A}  Lucium-0.3.0-arm64.dmg\n${SUM_B}  Lucium-0.3.0-arm64.zip\n${SUM_B}  Lucium-0.2.15-arm64.zip\n${SUM_B}  evil.sh\nnot a sum\n`)
      expect(result.status).toBe(0)
      expect(result.written).toBe(`${SUM_B}  Lucium-0.3.0-arm64.zip\n${SUM_A}  Lucium-0.3.0-arm64.dmg\n`)
    })

    it('fails when the annotation names no file of the version, or gives no real sum', () => {
      for (const message of ['v0.3.0\n', `${SUM_A}  Lucium-0.2.15-arm64.dmg\n`, `${'a'.repeat(63)}  Lucium-0.3.0-arm64.dmg\n`, `${'G'.repeat(64)}  Lucium-0.3.0-arm64.dmg\n`, `${SUM_A}  Lucium-0.3.0-arm64.dmg extra\n`]) {
        const result = sums(message)
        expect(result.status, message).toBe(1)
        expect(result.out, message).toContain('holds no SHA-256 sum of Lucium-0.3.0-arm64.dmg or Lucium-0.3.0-arm64.zip')
      }
    })

    it('fails on two different sums for one file, and takes the dots of a version for dots', () => {
      const twice = sums(`${SUM_A}  Lucium-0.3.0-arm64.dmg\n${SUM_B}  Lucium-0.3.0-arm64.dmg\n`)
      expect(twice.status).toBe(1)
      expect(twice.out).toContain('two different SHA-256 sums for the same file')
      expect(sums(`${SUM_A}  Lucium-0x3y0-arm64.dmg\n`).status).toBe(1)
      expect(sums(`${SUM_A}  Lucium-1.0.0-rc.1-arm64.dmg\n`, '1.0.0-rc.1').status).toBe(0)
    })
  })

  describe('build.yml, the names of the check builds', () => {
    it('renames every package before it is uploaded, so that none has the name of a download', () => {
      const raw = read('.github/workflows/build.yml')
      const rename = /\n( {10}shopt -s nullglob\n {10}for file in [^\n]+\n(?: {10,}[^\n]+\n)+? {10}done\n)/.exec(raw)?.[1]
      expect(rename).toBeDefined()
      const dir = folder()
      const names = ['Lucium-0.3.0-mac-arm64.dmg', 'Lucium-0.3.0-mac-x64.zip', 'Lucium-Setup-0.3.0-x64.exe', 'Lucium-0.3.0-linux-x86_64.AppImage', 'Lucium-0.3.0-linux-amd64.deb', 'builder-debug.yml']
      bash(`mkdir dist && cd dist && touch ${names.join(' ')}`, dir)
      expect(bash(`set -euo pipefail\n${rename}`, dir).status).toBe(0)
      expect(readdirSync(join(dir, 'dist')).sort()).toEqual(
        ['Lucium-0.3.0-linux-amd64-UNSIGNED-check-build.deb', 'Lucium-0.3.0-linux-x86_64-UNSIGNED-check-build.AppImage', 'Lucium-0.3.0-mac-arm64-UNSIGNED-check-build.dmg', 'Lucium-0.3.0-mac-x64-UNSIGNED-check-build.zip', 'Lucium-Setup-0.3.0-x64-UNSIGNED-check-build.exe', 'builder-debug.yml'].sort()
      )
    })
  })
})

describe('.github/workflows/build.yml, what it keeps', () => {
  const workflow = code(read('.github/workflows/build.yml'))

  it('uploads the renamed packages only, under artifact names that say what they are', () => {
    expect(workflow).toMatch(/\n {10}path: dist\/\*-UNSIGNED-check-build\.\*\n/)
    expect(workflow.match(/^ {10}path:/gm)).toHaveLength(1)
    const artifacts = [...workflow.matchAll(/^ {12}artifact: (.+)$/gm)].map((match) => match[1])
    expect(artifacts).toEqual(['lucium-mac-UNSIGNED-check-build', 'lucium-win-UNSIGNED-check-build', 'lucium-linux-UNSIGNED-check-build'])
    expect(workflow).toMatch(/\n {10}name: \$\{\{ matrix\.artifact \}\}\n/)
  })
})

describe('.github/workflows/codeql.yml', () => {
  const workflow = code(read('.github/workflows/codeql.yml'))

  it('analyses the application, the workflows and the native pieces', () => {
    expect([...workflow.matchAll(/^ {10}- language: (.+)$/gm)].map((match) => match[1])).toEqual(['javascript-typescript', 'actions', 'c-cpp', 'swift'])
    // The native pieces are built by their own scripts, with nothing installed from npm.
    expect(workflow).not.toMatch(/pnpm|npm /)
    for (const build of ['native/vault-xpc/build.sh', 'native/vault-keychain/build.sh', 'native/system-translate/build.sh']) expect(workflow).toContain(`bash ${build} --arch arm64`)
  })
})

describe('.github/codeql/codeql-config.yml', () => {
  const config = code(read('.github/codeql/codeql-config.yml'))
  const ignored = [...config.matchAll(/^ {2}- '(.+)'$/gm)].map((match) => match[1]!)

  it('is the one every job of the analysis starts with', () => {
    expect(code(read('.github/workflows/codeql.yml')).match(/config-file: \.\/\.github\/codeql\/codeql-config\.yml/g) ?? []).toHaveLength(1)
  })

  it('leaves out the three kinds of test harness and nothing else, each of them a file the package does not carry', () => {
    // A path added here hides its alerts: it needs the same proof, that the application never carries the file.
    expect(ignored).toEqual(['**/*.test.*', 'src/main/smoke*.ts', '**/*test-support*.ts'])
    const builder = read('electron-builder.yml')
    expect(builder).toContain("- '!out/main/smoke*.js'")
    expect(builder).toContain("- '!out/main/*test-support*.js'")
  })

  it('hides nothing a file that is read depends on: no file CodeQL reads imports a file it leaves out, but the lazy load of the engine test', () => {
    const files = ['src', 'scripts', 'tests'].flatMap((dir) => readdirSync(here(dir), { recursive: true, encoding: 'utf8' }).map((file) => `${dir}/${posix(file)}`)).filter((file) => /\.(?:tsx?|mjs|cjs|js)$/.test(file))
    const known = new Set(files)
    const isIgnored = (file: string) => ignored.some((pattern) => matchesGlob(file, pattern))
    const offenders: string[] = []
    for (const file of files.filter((f) => !isIgnored(f))) {
      for (const [, specifier] of read(file).matchAll(/(?:\bfrom|\bimport\(|\brequire\(|^import)\s*['"]([^'"]+)['"]/gm)) {
        const target = specifier!.startsWith('@shared/') ? `src/shared/${specifier!.slice(8)}` : specifier!.startsWith('.') ? posix(join(dirname(file), specifier!)) : null
        if (target === null) continue
        const found = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx'].map((suffix) => `${target}${suffix}`).find((candidate) => known.has(candidate))
        if (found !== undefined && isIgnored(found)) offenders.push(`${file} -> ${found}`)
      }
    }
    // main/index.ts runs the engine test through import('./smoke-run'), only when --smoke is passed, which the built application refuses (runtime.ts).
    expect(offenders).toEqual(['src/main/index.ts -> src/main/smoke-run.ts'])
  })
})

describe('the scheduled watch on the dependencies', () => {
  it('audit.yml asks pnpm every day, about what is shipped then about the whole tree, with nothing installed', () => {
    const workflow = code(read('.github/workflows/audit.yml'))
    expect(block(workflow, 'on')).toMatch(/^on:\n {2}schedule:\n {4}- cron: '\d+ \d+ \* \* \*'\n {2}workflow_dispatch:$/)
    expect(workflow).toMatch(/run: pnpm audit --prod --audit-level moderate\n/)
    expect(workflow).toMatch(/run: pnpm audit --audit-level high\n/)
    expect(workflow).toMatch(/\n {10}install: false\n/)
    expect(workflow).not.toMatch(/continue-on-error|\|\| true/)
  })

  it('dependency-review.yml fails a pull request that brings in a version with an advisory', () => {
    const workflow = code(read('.github/workflows/dependency-review.yml'))
    expect(block(workflow, 'on')).toMatch(/^on:\n {2}pull_request:\n/)
    expect(workflow).toMatch(/uses: actions\/dependency-review-action@[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}fail-on-severity: moderate\n/)
    expect(workflow).not.toMatch(/warn-only: true|continue-on-error/)
  })

  it('sbom.yml writes CycloneDX from the lockfile and checks the files before keeping them', () => {
    const workflow = code(read('.github/workflows/sbom.yml'))
    expect(workflow.match(/pnpm sbom --sbom-format cyclonedx --sbom-type application --lockfile-only /g)).toHaveLength(2)
    expect(workflow).toMatch(/jq -e '\.bomFormat == "CycloneDX" and \(\.components \| length\) > 0' "\$file"/)
  })

  it('scorecard.yml publishes its results and has no step of its own (the Scorecard API refuses the results otherwise)', () => {
    const workflow = code(read('.github/workflows/scorecard.yml'))
    expect(workflow).toMatch(/\n {10}publish_results: true\n/)
    expect(workflow).not.toMatch(/^\s*(- )?run:/m)
    expect(workflow).not.toMatch(/^(env|defaults):/m)
  })
})

describe('.github/dependabot.yml', () => {
  const config = code(read('.github/dependabot.yml'))
  const entries = config.split(/\n {2}- package-ecosystem: /).slice(1)

  it('waits some days before it proposes a version, for npm and for the actions', () => {
    expect(entries.map((entry) => entry.split('\n')[0])).toEqual(['npm', 'github-actions'])
    for (const entry of entries) expect(entry).toMatch(/\n {4}cooldown:\n {6}default-days: [1-9]\d*\n/)
  })

  it('reads the workflows and the folder of each local action: Dependabot reads a local action only when its folder is named, and its pins would go stale', () => {
    const actions = entries.find((entry) => entry.startsWith('github-actions\n')) ?? ''
    expect(actions).toMatch(/\n {4}directories:\n {6}- \/\n/)
    expect(ACTION_FILES.length).toBeGreaterThan(0)
    for (const file of ACTION_FILES) expect(actions, file).toContain(`\n      - /${dirname(file)}\n`)
  })

  it('ignores Electron for every update: it moves by hand (pnpm electron:upgrade), and a pull request of Dependabot would fail on the missing castLabs checksums', () => {
    const npm = entries[0] ?? ''
    // The whole dependency is ignored: no `update-types` line may narrow the rule to a kind of version (a major only, say).
    expect(npm).toMatch(/\n {4}ignore:\n {6}- dependency-name: electron\n {4}groups:\n/)
    // No group may propose it either: no wildcard, and no pattern that names it or catches it by prefix.
    const patterns = [...npm.matchAll(/^ {8}patterns: \[(.+)\]$/gm)].flatMap((match) => (match[1] ?? '').split(', ').map((pattern) => pattern.replaceAll("'", '')))
    expect(patterns.filter((pattern) => pattern === 'electron' || pattern === '*' || pattern === 'electron*')).toEqual([])
    expect(npm).toMatch(/\n {6}prefix: 'chore\(deps\)'\n {6}prefix-development: 'chore\(deps-dev\)'\n/)
  })
})

// The checks every pull request must pass. They only run on GitHub, and the rules of main name them by the name of their job: a job that no
// longer runs its command, that may fail without failing the run, or whose name changed without the documents, is a check that is gone and
// that nothing reports.
describe('.github/workflows/ci.yml, the quality checks of a pull request', () => {
  const ci = code(read('.github/workflows/ci.yml'))
  const jobs = jobsOf(ci).map((job) => ({ ...job, name: /^ {4}name: (.+)$/m.exec(job.text)?.[1] }))
  const job = (name: string): string => {
    const found = jobs.filter((candidate) => candidate.name === name)
    expect(found, name).toHaveLength(1)
    return found[0]?.text ?? ''
  }
  const MACOS_ONLY_WHEN_PUBLIC = "    if: ${{ !github.event.repository.private || github.event_name == 'workflow_dispatch' }}\n"

  it('runs on every pull request and on every push to main', () => {
    expect(block(ci, 'on')).toBe('on:\n  push:\n    branches: [main]\n  pull_request:\n  workflow_dispatch:')
  })

  it('has five jobs, each under the name the rules of main require', () => {
    expect(jobs.map((candidate) => candidate.name)).toEqual(['Type check', 'Lint', 'Unit tests (Linux)', 'Unit tests (macOS)', 'Build (macOS, unsigned)'])
  })

  it('type-checks, lints and runs the unit tests on Linux, in jobs that nothing skips', () => {
    for (const [name, command] of [['Type check', 'pnpm typecheck'], ['Lint', 'pnpm lint'], ['Unit tests (Linux)', 'pnpm test']] as const) {
      const text = job(name)
      expect(text, name).toMatch(/^ {4}runs-on: ubuntu-latest$/m)
      expect(text, name).toContain(`\n      - run: ${command}\n`)
      expect(text, name).not.toMatch(/^\s+if:/m)
    }
  })

  it('runs the unit tests on macOS too', () => {
    const text = job('Unit tests (macOS)')
    expect(text).toMatch(/^ {4}runs-on: macos-latest$/m)
    expect(text).toContain('\n      - run: pnpm test\n')
  })

  it('builds the application on macOS and packages it as a folder, unsigned, keeping nothing', () => {
    const text = job('Build (macOS, unsigned)')
    expect(text).toMatch(/^ {4}runs-on: macos-latest$/m)
    expect(text).toContain('\n        run: pnpm build\n')
    const packaged = text.slice(text.indexOf('- name: Package the application as a folder'))
    expect(packaged).toContain("\n          CSC_IDENTITY_AUTO_DISCOVERY: 'false'\n")
    expect(packaged).toContain('\n          pnpm build:native\n          pnpm exec electron-builder --mac --dir --arm64 --publish never\n          test -d dist/mac-arm64/Lucium.app\n')
    expect(text.indexOf('run: pnpm build\n')).toBeLessThan(text.indexOf('electron-builder'))
    expect(ci).not.toMatch(/upload-artifact|--publish (?!never)|package:signed|build:drm/)
  })

  it('skips a macOS job only while the repository is private, and never lets a step fail without failing the job', () => {
    for (const name of ['Unit tests (macOS)', 'Build (macOS, unsigned)']) expect(job(name), name).toContain(MACOS_ONLY_WHEN_PUBLIC)
    expect(ci.match(/^\s+if:.*$/gm)).toEqual([MACOS_ONLY_WHEN_PUBLIC.trimEnd(), MACOS_ONLY_WHEN_PUBLIC.trimEnd()])
    expect(ci).not.toMatch(/continue-on-error|\|\| true|\|\| :|set \+e/)
  })

  it('is named, job by job, in the table of the required checks and in the two CONTRIBUTING', () => {
    const conventions = jobsOf(code(read('.github/workflows/pr-conventions.yml'))).map((candidate) => /^ {4}name: (.+)$/m.exec(candidate.text)?.[1])
    const required = [...jobs.map((candidate) => candidate.name), ...conventions]
    expect(required).toHaveLength(7)
    const guide = read('docs/community/maintainers.md')
    const table = guide.slice(guide.indexOf('| Required check | Workflow | What it checks |'))
    const rows = [...table.slice(0, table.indexOf('\n\n')).matchAll(/^ {4}\| `([^`]+)` \| /gm)].map((match) => match[1])
    expect(rows).toEqual(required)
    expect(guide).toContain('**require status checks**, seven of them')
    for (const file of ['CONTRIBUTING.md', 'CONTRIBUTING.fr.md']) {
      const step = read(file).split('\n').find((line) => line.startsWith('5. **'))
      for (const name of required) expect(step, `${file}: ${name}`).toContain(`\`${name}\``)
    }
  })
})

describe('what `pnpm typecheck` and `pnpm lint` cover', () => {
  const manifest = JSON.parse(read('package.json')) as { scripts: Record<string, string>; engines?: Record<string, string>; packageManager: string }
  const tsconfig = (file: string) => JSON.parse(read(file)) as { extends?: string; compilerOptions: Record<string, unknown>; include?: string[]; exclude?: string[] }
  const projects = readdirSync(here('.')).filter((file) => /^tsconfig\..+\.json$/.test(file) && file !== 'tsconfig.base.json').sort()

  it('type-checks every tsconfig of the repository, all with the strict options of the base', () => {
    expect(projects).toEqual(['tsconfig.e2e.json', 'tsconfig.node.json', 'tsconfig.scripts.json', 'tsconfig.web.json'])
    expect(manifest.scripts.typecheck?.split(' && ').sort()).toEqual(projects.map((file) => `tsc --noEmit -p ${file}`))
    expect(tsconfig('tsconfig.base.json').compilerOptions).toMatchObject({
      strict: true,
      noUncheckedIndexedAccess: true,
      noImplicitOverride: true,
      noFallthroughCasesInSwitch: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      allowUnreachableCode: false,
      allowUnusedLabels: false
    })
    for (const file of projects) {
      const project = tsconfig(file)
      expect(project.extends, file).toBe('./tsconfig.base.json')
      // Only the scripts written in JavaScript are checked with less: they have no type annotations to check against.
      const loosened = Object.entries(project.compilerOptions).filter(([key, value]) => /^(strict|no|allowUn|useUnknown)/.test(key) && value === false).map(([key]) => key)
      expect(loosened, file).toEqual(file === 'tsconfig.scripts.json' ? ['noImplicitAny', 'noUncheckedIndexedAccess', 'useUnknownInCatchVariables'] : [])
    }
  })

  it('reaches the end-to-end tests, the configuration files and the scripts, not only src/', () => {
    const included = projects.flatMap((file) => tsconfig(file).include ?? [])
    for (const pattern of ['tests/e2e/**/*', 'playwright.config.ts', 'electron.vite.config.ts', 'vitest*.config.mts', 'scripts/**/*.ts', 'scripts/**/*.mjs', 'scripts/**/*.cjs', 'src/main/**/*', 'src/preload/**/*', 'src/renderer/**/*', 'src/shared/**/*']) {
      expect(included, pattern).toContain(pattern)
    }
    // The scripts left out are named one by one: the measuring benches and the makers of the site's pictures and film.
    expect(tsconfig('tsconfig.scripts.json').exclude).toEqual(['scripts/compare-browsers.mjs', 'scripts/perf.mjs', 'scripts/readable-bench.mjs', 'scripts/site-captures.mjs', 'scripts/site-film/**/*'])
    for (const file of ['tsconfig.e2e.json', 'tsconfig.node.json', 'tsconfig.web.json']) expect(tsconfig(file).exclude, file).toBeUndefined()
  })

  /** The configuration of the linter: JSON with whole-line comments. */
  const lintConfig = () =>
    JSON.parse(
      read('.oxlintrc.jsonc')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n')
    ) as {
      plugins: string[]
      categories: Record<string, string>
      options: Record<string, unknown>
      rules: Record<string, unknown>
      overrides: { files: string[]; rules: Record<string, unknown> }[]
      ignorePatterns: string[]
    }
  /** What the linter leaves out: a folder named in `ignorePatterns` (some names hold a `*`), at the root of the repository. */
  const leftOut = (file: string, patterns: string[]) => patterns.some((pattern) => matchesGlob(file, `${pattern}**`))

  it('has a `lint` script, and the rules it applies are errors: hooks, floating promises, unused names, comments that switch nothing off', () => {
    expect(manifest.scripts.lint).toBe('oxlint .')
    const config = lintConfig()
    expect(config.plugins.sort()).toEqual(['react', 'typescript'])
    // The list is the whole list: no ready-made set of rules is on, so a rule is applied because it is named here, as an error.
    expect(Object.keys(config.categories).sort()).toEqual(['correctness', 'nursery', 'pedantic', 'perf', 'restriction', 'style', 'suspicious'])
    expect(new Set(Object.values(config.categories))).toEqual(new Set(['off']))
    expect(config.rules).toEqual({
      'typescript/no-floating-promises': 'error',
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }]
    })
    // The hooks rules, on the whole interface; no other part of the tree has rules of its own, so none can switch a rule off for a folder.
    expect(config.overrides).toEqual([{ files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'], rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' } }])
    // Read with the types; an exception that excuses nothing is an error, and it is written one way; a warning fails the lint too.
    expect(config.options).toEqual({ typeAware: true, reportUnusedDisableDirectives: 'error', respectEslintDisableDirectives: false, denyWarnings: true })
    // The type-aware half of the linter is installed with it: without that package, the promises rule cannot run.
    const tools = (JSON.parse(read('package.json')) as { devDependencies: Record<string, string> }).devDependencies
    for (const name of ['oxlint', 'oxlint-tsgolint']) expect(tools[name], name).toMatch(/^\d+\.\d+\.\d+$/)
    // Nothing of the application is left out of the lint: only what is built, downloaded or written by somebody else.
    expect(config.ignorePatterns).toEqual(['node_modules/', 'out/', 'out-*/', 'dist/', 'dist-*/', 'coverage/', 'release/', 'test-results/', '.dev-electron/', '.perf/', '.claude/', 'src/main/translate/vendor/', 'resources/', 'docs/', 'compat/', 'scripts/site-film/montage/'])
    for (const file of ['src/main/index.ts', 'src/renderer/App.tsx', 'src/preload/index.ts', 'src/shared/model.ts', 'tests/e2e/helpers.ts', 'scripts/publish-update.mjs', 'scripts/notices/third-party-notices.ts', 'playwright.config.ts', 'vitest.config.mts']) {
      expect(leftOut(file, config.ignorePatterns), file).toBe(false)
    }
    expect(leftOut('src/main/translate/vendor/worker.js', config.ignorePatterns)).toBe(true)
    expect(leftOut('out-engine/main/index.js', config.ignorePatterns)).toBe(true)
  })

  it('has one configuration of the linter, at the root: a folder cannot bring rules of its own', () => {
    const found = globSync('**/{.oxlintrc*,oxlint.config.*,eslint.config.*,.eslintrc*}', { cwd: here('.'), exclude: (name) => /(^|\/)(node_modules|\.git|\.claude)$/.test(name) })
    expect(found).toEqual(['.oxlintrc.jsonc'])
  })

  it('reads every TypeScript file with its types, through the tsconfig files of the type check', () => {
    // The linter finds the project of a file from tsconfig.json, which holds no file of its own and names the projects of `pnpm typecheck`.
    const root = JSON.parse(read('tsconfig.json')) as { files: string[]; references: { path: string }[]; compilerOptions?: unknown; include?: unknown }
    expect(root.files).toEqual([])
    expect(root.include).toBeUndefined()
    expect(root.compilerOptions).toBeUndefined()
    expect(root.references.map((reference) => reference.path).sort()).toEqual(projects.map((file) => `./${file}`))

    // A file that no project includes would be read without the options and the aliases of the project, where a dropped promise can go
    // unseen: every TypeScript file the linter reads belongs to a project.
    const patterns = lintConfig().ignorePatterns
    const inProject = new Set<string>()
    for (const file of projects) {
      const project = tsconfig(file)
      for (const found of globSync(project.include ?? [], { cwd: here('.') })) {
        if (!(project.exclude ?? []).some((pattern) => matchesGlob(found, pattern))) inProject.add(found)
      }
    }
    const linted = globSync('**/*.{ts,tsx,mts,cts}', { cwd: here('.'), exclude: (name) => /(^|\/)(node_modules|\.git)$/.test(name) }).filter((file) => !leftOut(file, patterns))
    expect(linted.length).toBeGreaterThan(500)
    expect(linted.filter((file) => !inProject.has(file))).toEqual([])
  })

  it('keeps, in each project, a witness the linter fails on when it no longer sees a dropped promise or a broken hook', () => {
    // The linter says nothing of a call whose type it could not resolve. Each witness drops a promise on purpose under a comment that excuses
    // it; a comment that excuses nothing is an error, so the lint fails when the types (or the hooks rules) no longer reach the folder.
    const excuses = (file: string, rule: string) => read(file).split(`// oxlint-disable-next-line ${rule} -- witness`).length - 1
    expect(excuses('src/main/lint-witness.ts', 'typescript/no-floating-promises')).toBe(2)
    expect(excuses('src/renderer/lint-witness.ts', 'typescript/no-floating-promises')).toBe(2)
    expect(excuses('tests/e2e/lint-witness.ts', 'typescript/no-floating-promises')).toBe(1)
    expect(excuses('src/renderer/lint-witness.ts', 'react-hooks/rules-of-hooks')).toBe(1)
    expect(excuses('src/renderer/lint-witness.ts', 'react-hooks/exhaustive-deps')).toBe(1)
    // The aliased import and the bridge are what a broken configuration loses first.
    for (const file of ['src/main/lint-witness.ts', 'src/renderer/lint-witness.ts']) expect(read(file), file).toContain("from '@shared/")
    expect(read('src/renderer/lint-witness.ts')).toContain('window.lucium.')
  })

  it('says which Node and which pnpm the project needs, the ones of .nvmrc and of `packageManager`', () => {
    const node = read('.nvmrc').trim()
    expect(node).toMatch(/^\d+$/)
    expect(manifest.engines?.node).toBe(`>=${node}`)
    const pnpm = /^pnpm@(\d+)\.(\d+\.\d+)$/.exec(manifest.packageManager)
    expect(pnpm).not.toBeNull()
    expect(manifest.engines?.pnpm).toBe(`>=${pnpm?.[1]}.${pnpm?.[2]} <${Number(pnpm?.[1]) + 1}`)
  })
})
