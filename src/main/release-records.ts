// Writes the two records a publication reads (release-gate.ts): which commit an archive was built from (scripts/build-record.mjs, called by
// scripts/build-drm-release.sh), and whether the engine suites passed on a commit (scripts/engine-release-run.mjs, `pnpm test:engine:release`).
// Not part of the application (nothing in it imports this file); the scripts read it with Node's own TypeScript, so it imports nothing but Node's
// modules, and takes the conditions (release-gate.ts) and its effects from the script: the tests give fake ones.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
// Types only: Node erases this line.
import type * as ReleaseGate from './release-gate'

export interface GitState {
  commit: string
  /**
   * The working tree is not the commit: a tracked file differs from it, or a file Git does not track (and does not ignore) lies in a folder the
   * build reads (`BUILT_FOLDERS`). An untracked file elsewhere does not count: nothing of it goes into what is built.
   */
  modified: boolean
}

/**
 * The folders the build reads whole, whatever Git tracks in them: `src/` is compiled into `out/` (a file there is in the application as soon as
 * another one imports it), electron-builder copies folders of `resources/` and reads `build/`, and the helpers are compiled from `native/`. A file
 * Git does not track there can be in the archive, and the record would call the archive the build of a commit that does not hold it.
 */
export const BUILT_FOLDERS: readonly string[] = ['src/', 'resources/', 'native/', 'build/']

/** The untracked files (or folders) of `git status --porcelain` that lie in a folder the build reads. Git quotes a path that has unusual characters. */
export function untrackedInBuild(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3))
    .filter((path) => BUILT_FOLDERS.some((folder) => path.replace(/^"/, '').startsWith(folder)))
}

export interface RecordDeps {
  say: (line: string) => void
  /** Runs git in the repository, without a shell. */
  git: (args: string[]) => { status: number | null; stdout: string; stderr: string }
  /** Runs a script of package.json to its end, its output shown as it comes; its exit code, null when it did not end by itself. */
  runScript: (script: string) => number | null
  exists: (path: string) => boolean
  remove: (path: string) => void
  /** The SHA-256 and the size of a file. */
  weigh: (path: string) => { sha256: string; size: number }
  /** Writes a file, and makes its folder when it does not exist. */
  writeText: (path: string, text: string) => void
  now: () => Date
  gate: typeof ReleaseGate
}

/**
 * The commit the working tree is at, and whether the tree is that commit (`GitState.modified`); or why Git cannot say. `untracked`: the files of
 * the folders the build reads that Git does not track, for the message. Ignored files are not listed: `out/` is emptied by each build.
 */
export function gitState(deps: Pick<RecordDeps, 'git'>): { state: GitState; untracked: string[] } | { problem: string } {
  const head = deps.git(['rev-parse', 'HEAD'])
  const commit = head.stdout.trim()
  if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(commit)) return { problem: `git rev-parse HEAD did not name a commit: ${head.stderr.trim() || `exit code ${head.status}`}` }
  const status = deps.git(['status', '--porcelain', '--untracked-files=normal'])
  if (status.status !== 0) return { problem: `git status failed: ${status.stderr.trim() || `exit code ${status.status}`}` }
  const untracked = untrackedInBuild(status.stdout)
  const tracked = status.stdout.split('\n').some((line) => line.trim() !== '' && !line.startsWith('?? '))
  return { state: { commit, modified: tracked || untracked.length > 0 }, untracked }
}

/** `<commit> <0|1>`: what scripts/build-drm-release.sh keeps from before the build and hands back after it. */
export const stateWord = (state: GitState): string => `${state.commit} ${state.modified ? 1 : 0}`

export function readStateWord(commit: string | undefined, modified: string | undefined): GitState | null {
  return commit !== undefined && /^[0-9a-f]{40}$/.test(commit) && (modified === '0' || modified === '1') ? { commit, modified: modified === '1' } : null
}

export type RecordResult = { ok: true; file: string; clean: boolean } | { ok: false; problem: string }

/**
 * Writes the build record beside `archive`. `start` is what Git said before the build; what it says now is read here. A tree that was modified, or
 * a commit that moved, is written down as such (the publication then refuses the archive): the record never claims a commit the build is not of.
 */
export function writeBuildRecord(input: { version: string; archive: string; start: GitState }, deps: RecordDeps): RecordResult {
  if (!deps.exists(input.archive)) return { ok: false, problem: `${input.archive} does not exist: the record is written once the archive is` }
  const end = gitState(deps)
  if ('problem' in end) return { ok: false, problem: end.problem }
  const record = deps.gate.buildRecordOf({ version: input.version, archive: { name: basename(input.archive), ...deps.weigh(input.archive) }, start: input.start, end: end.state, now: deps.now() })
  const file = join(dirname(input.archive), deps.gate.buildRecordNameOf(input.version))
  deps.writeText(file, `${JSON.stringify(record, null, 2)}\n`)
  deps.say(`Build record: ${file}`)
  deps.say(`  commit ${record.commit}, archive SHA-256 ${record.archive.sha256}`)
  if (!record.clean) {
    deps.say(
      input.start.commit !== end.state.commit
        ? `  ⚠️  the commit moved during the build (${input.start.commit.slice(0, 12)} → ${end.state.commit.slice(0, 12)}): scripts/publish-update.mjs will refuse this archive`
        : end.untracked.length > 0
          ? `  ⚠️  files that Git does not track lie in a folder the build reads (${end.untracked.slice(0, 5).join(', ')}${end.untracked.length > 5 ? `, and ${end.untracked.length - 5} more` : ''}): they may be in the archive, which is then the build of no commit, and scripts/publish-update.mjs will refuse it. Commit or remove them, then build again`
          : '  ⚠️  tracked files were modified when this was built, or untracked files lay in a folder the build reads: it is the build of no commit, and scripts/publish-update.mjs will refuse this archive. Commit, then build again'
    )
  }
  return { ok: true, file, clean: record.clean }
}

export type EngineRunResult = { ok: true; file: string } | { ok: false; file: string | null; problems: string[] }

/**
 * Runs the engine suites a release needs, in the order of ENGINE_RUN_STEPS, and writes what happened in out-engine/release-run.json. Every step is
 * run, whatever the one before did: the record says which failed. It opens real windows for a long while: on a Mac that is not in use.
 * Nothing is started when a tracked file is modified: the run would be of no commit, and no publication could use it.
 */
export function runEngineRelease(input: { root: string }, deps: RecordDeps): EngineRunResult {
  const start = gitState(deps)
  if ('problem' in start) return { ok: false, file: null, problems: [start.problem] }
  if (start.state.modified) {
    const what = start.untracked.length > 0 ? `files that Git does not track lie in a folder the build reads (${start.untracked.slice(0, 5).join(', ')})` : 'tracked files are modified'
    return { ok: false, file: null, problems: [`${what}: the suites would run on no commit, and no publication could use their record. Commit, then run again (nothing was started)`] }
  }
  const file = join(input.root, ...deps.gate.ENGINE_RUN_FILE.split('/'))
  const report = join(input.root, 'out-engine', 'report.json')
  // The report of an earlier run must not pass for the one of this run: the chain writes a new one, or there is none.
  deps.remove(report)
  deps.remove(file)
  const startedAt = deps.now().toISOString()
  const steps: Record<string, number | null> = {}
  for (const step of deps.gate.ENGINE_RUN_STEPS) {
    deps.say(`\n── pnpm ${step.script}`)
    steps[step.name] = deps.runScript(step.script)
    deps.say(`── pnpm ${step.script}: ${steps[step.name] === null ? 'no exit code' : `exit code ${steps[step.name]}`}`)
  }
  const end = gitState(deps)
  const record: ReleaseGate.EngineRunRecord = {
    commit: start.state.commit,
    clean: !('problem' in end) && !end.state.modified && end.state.commit === start.state.commit,
    startedAt,
    endedAt: deps.now().toISOString(),
    steps,
    reportSha256: deps.exists(report) ? deps.weigh(report).sha256 : null
  }
  deps.writeText(file, `${JSON.stringify(record, null, 2)}\n`)
  const problems = [...('problem' in end ? [end.problem] : []), ...deps.gate.engineRunProblems(record, record.commit)]
  deps.say(`\nRecord of the engine run: ${file} (commit ${record.commit})`)
  return problems.length === 0 ? { ok: true, file } : { ok: false, file, problems }
}

/** The real effects: git and pnpm in `root`, without a shell. */
export function realRecordDeps(root: string, say: (line: string) => void, gate: typeof ReleaseGate): RecordDeps {
  return {
    say,
    gate,
    git: (args) => {
      const done = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { status: done.status, stdout: done.stdout ?? '', stderr: `${done.stderr ?? ''}${done.error ? `\n${done.error.message}` : ''}` }
    },
    runScript: (script) => spawnSync('pnpm', [script], { cwd: root, stdio: 'inherit' }).status,
    exists: existsSync,
    remove: (path) => rmSync(path, { force: true }),
    weigh: (path) => ({ sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), size: statSync(path).size }),
    writeText: (path, text) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    },
    now: () => new Date()
  }
}
