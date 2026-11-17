import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import * as gate from './release-gate'
import { BUILT_FOLDERS, gitState, readStateWord, realRecordDeps, runEngineRelease, stateWord, untrackedInBuild, writeBuildRecord, type RecordDeps } from './release-records'

// The two records a publication reads, written against fake effects: no engine suite is started here and no window is opened.
const COMMIT = '1234567890abcdef1234567890abcdef12345678'
const OTHER_COMMIT = 'fedcba0987654321fedcba0987654321fedcba09'
const HASH = 'a'.repeat(64)
const REPORT_HASH = 'd'.repeat(64)
const REPORT = '/repo/out-engine/report.json'
const RECORD = '/repo/out-engine/release-run.json'

interface World {
  /** What `git rev-parse HEAD` answers, call after call (the last one is repeated). */
  commits?: string[]
  /** What `git status` answers, call after call. */
  statuses?: string[]
  gitFails?: 'rev-parse' | 'status'
  /** The exit code of each script; 0 by default, but the chain (1: the reference holds checks that are known to fail). */
  codes?: Record<string, number | null>
  /** The chain writes its report (true by default). */
  writesReport?: boolean
  missing?: string[]
}

function world(change: World = {}) {
  const said: string[] = []
  const written: Record<string, string> = {}
  const removed: string[] = []
  const scripts: string[] = []
  const files = new Set<string>(['/repo/dist-drm/Lucium-0.3.0-arm64.zip', REPORT].filter((path) => !change.missing?.includes(path)))
  let revParse = 0
  let status = 0
  const next = (values: string[] | undefined, at: number, fallback: string): string => values?.[Math.min(at, values.length - 1)] ?? fallback
  let clock = Date.parse('2026-11-20T06:00:00Z')
  const deps: RecordDeps = {
    say: (line) => said.push(line),
    gate,
    git: (args) => {
      if (args[0] === 'rev-parse') {
        if (change.gitFails === 'rev-parse') return { status: 128, stdout: '', stderr: 'fatal: not a git repository\n' }
        return { status: 0, stdout: `${next(change.commits, revParse++, COMMIT)}\n`, stderr: '' }
      }
      if (change.gitFails === 'status') return { status: 128, stdout: '', stderr: 'fatal: index file corrupt\n' }
      return { status: 0, stdout: next(change.statuses, status++, ''), stderr: '' }
    },
    runScript: (script) => {
      scripts.push(script)
      if (script === 'test:engine' && change.writesReport !== false) files.add(REPORT)
      const code = change.codes && script in change.codes ? change.codes[script] : script === 'test:engine' ? 1 : 0
      return code ?? null
    },
    exists: (path) => files.has(path),
    remove: (path) => {
      removed.push(path)
      files.delete(path)
    },
    weigh: (path) => ({ sha256: path === REPORT ? REPORT_HASH : HASH, size: 140_000_000 }),
    writeText: (path, text) => {
      written[path] = text
    },
    now: () => new Date((clock += 60_000))
  }
  return { deps, said, written, removed, scripts }
}

describe('what Git says of the working tree', () => {
  it('is the commit, and whether a tracked file is modified', () => {
    const asked: string[][] = []
    const clean = world()
    expect(gitState({ git: (args) => (asked.push(args), clean.deps.git(args)) })).toEqual({ state: { commit: COMMIT, modified: false }, untracked: [] })
    expect(asked).toEqual([['rev-parse', 'HEAD'], ['status', '--porcelain', '--untracked-files=normal']])
    expect(gitState(world({ statuses: [' M package.json\n'] }).deps)).toEqual({ state: { commit: COMMIT, modified: true }, untracked: [] })
  })

  it('counts a file Git does not track as a change when it lies in a folder the build reads, and only there', () => {
    // The build compiles src/, copies folders of resources/, reads build/ and compiles native/: what is there can be in the archive.
    for (const path of ['src/main/left-over.ts', 'resources/fonts/', 'native/system-translate/patch.swift', 'build/icon-2.icns', '"src/renderer/a file.css"']) {
      expect(gitState(world({ statuses: [`?? ${path}\n`] }).deps), path).toEqual({ state: { commit: COMMIT, modified: true }, untracked: [path] })
    }
    // Elsewhere it is in nothing that is built: notes at the root, a script nobody calls, a folder whose name only begins like one of them.
    for (const path of ['notes.md', 'scripts/try.mjs', 'srcs/x.ts', 'docs/src/x.md', 'resources.txt']) {
      expect(gitState(world({ statuses: [`?? ${path}\n`] }).deps), path).toEqual({ state: { commit: COMMIT, modified: false }, untracked: [] })
    }
    expect(gitState(world({ statuses: ['?? notes.md\n M package.json\n?? src/x.ts\n'] }).deps)).toEqual({ state: { commit: COMMIT, modified: true }, untracked: ['src/x.ts'] })
    expect(untrackedInBuild(' M src/main/index.ts\nA  src/new.ts\n')).toEqual([])
    // The folders named are folders of the repository: a name that changes there is changed here.
    for (const folder of BUILT_FOLDERS) expect(existsSync(fileURLToPath(new URL(`../../${folder}`, import.meta.url))), folder).toBe(true)
  })

  it('is a problem, said with what Git answered, when Git names no commit or cannot read the tree', () => {
    expect(gitState(world({ gitFails: 'rev-parse' }).deps)).toEqual({ problem: 'git rev-parse HEAD did not name a commit: fatal: not a git repository' })
    expect(gitState(world({ commits: ['HEAD'] }).deps)).toEqual({ problem: 'git rev-parse HEAD did not name a commit: exit code 0' })
    expect(gitState(world({ gitFails: 'status' }).deps)).toEqual({ problem: 'git status failed: fatal: index file corrupt' })
  })

  it('goes through the build as two words, and comes back as it went', () => {
    expect(stateWord({ commit: COMMIT, modified: false })).toBe(`${COMMIT} 0`)
    expect(stateWord({ commit: COMMIT, modified: true })).toBe(`${COMMIT} 1`)
    expect(readStateWord(COMMIT, '1')).toEqual({ commit: COMMIT, modified: true })
    expect(readStateWord(COMMIT, '0')).toEqual({ commit: COMMIT, modified: false })
    for (const [commit, modified] of [[undefined, '0'], [COMMIT, undefined], [COMMIT, 'yes'], ['main', '0'], [COMMIT.slice(1), '0']] as const) expect(readStateWord(commit, modified)).toBeNull()
  })
})

describe('the build record that is written', () => {
  const input = { version: '0.3.0', archive: '/repo/dist-drm/Lucium-0.3.0-arm64.zip', start: { commit: COMMIT, modified: false } }
  const FILE = '/repo/dist-drm/Lucium-0.3.0-arm64.build.json'

  it('is beside the archive, names it with its sum and the commit, and is one the publication reads', () => {
    const w = world()
    expect(writeBuildRecord(input, w.deps)).toEqual({ ok: true, file: FILE, clean: true })
    const read = gate.readBuildRecord(w.written[FILE] ?? '')
    expect(read).toEqual({ record: { version: '0.3.0', commit: COMMIT, clean: true, builtAt: '2026-11-20T06:01:00.000Z', archive: { name: 'Lucium-0.3.0-arm64.zip', sha256: HASH, size: 140_000_000 } } })
    expect('record' in read ? gate.buildRecordProblems(read.record, { version: '0.3.0', archive: read.record.archive }) : ['unread']).toEqual([])
    expect(w.said.join('\n')).not.toContain('⚠️')
  })

  it('says, in the record and aloud, that a tracked file was modified before or after the build', () => {
    for (const change of [{ start: { commit: COMMIT, modified: true } }, { statuses: [' M src/main/index.ts\n'] }] as Array<{ start?: typeof input.start; statuses?: string[] }>) {
      const w = world(change.statuses ? { statuses: change.statuses } : {})
      expect(writeBuildRecord({ ...input, ...(change.start ? { start: change.start } : {}) }, w.deps)).toEqual({ ok: true, file: FILE, clean: false })
      expect(JSON.parse(w.written[FILE] ?? '{}')).toMatchObject({ commit: COMMIT, clean: false })
      expect(w.said.join('\n')).toMatch(/⚠️ {2}tracked files were modified when this was built, or untracked files lay in a folder the build reads: it is the build of no commit, and scripts\/publish-update\.mjs will refuse this archive/)
    }
  })

  it('says which files Git does not track in a folder the build reads, and writes that the archive is the build of no commit', () => {
    const w = world({ statuses: ['?? src/main/left-over.ts\n?? notes.md\n'] })
    expect(writeBuildRecord(input, w.deps)).toEqual({ ok: true, file: FILE, clean: false })
    const read = gate.readBuildRecord(w.written[FILE] ?? '')
    expect('record' in read ? gate.buildRecordProblems(read.record, { version: '0.3.0', archive: read.record.archive }) : []).toEqual([expect.stringMatching(/the archive is the build of no commit/)])
    expect(w.said.join('\n')).toMatch(/⚠️ {2}files that Git does not track lie in a folder the build reads \(src\/main\/left-over\.ts\): they may be in the archive/)
    // A file that is in nothing the build reads does not make the build the build of no commit.
    const notes = world({ statuses: ['?? notes.md\n'] })
    expect(writeBuildRecord(input, notes.deps)).toEqual({ ok: true, file: FILE, clean: true })
  })

  it('says that the commit moved during the build, and keeps the one the build started from', () => {
    const w = world({ commits: [OTHER_COMMIT] })
    expect(writeBuildRecord(input, w.deps)).toEqual({ ok: true, file: FILE, clean: false })
    expect(JSON.parse(w.written[FILE] ?? '{}')).toMatchObject({ commit: COMMIT, clean: false })
    expect(w.said.join('\n')).toMatch(/the commit moved during the build \(1234567890ab → fedcba098765\)/)
  })

  it('is not written without the archive, nor when Git cannot say where the tree is', () => {
    const noArchive = world({ missing: [input.archive] })
    expect(writeBuildRecord(input, noArchive.deps)).toEqual({ ok: false, problem: `${input.archive} does not exist: the record is written once the archive is` })
    expect(noArchive.written).toEqual({})
    const noGit = world({ gitFails: 'rev-parse' })
    expect(writeBuildRecord(input, noGit.deps)).toEqual({ ok: false, problem: 'git rev-parse HEAD did not name a commit: fatal: not a git repository' })
    expect(noGit.written).toEqual({})
  })
})

describe('the engine run of a release', () => {
  const run = (change: World = {}) => {
    const w = world(change)
    return { ...w, result: runEngineRelease({ root: '/repo' }, w.deps) }
  }
  const recordOf = (w: { written: Record<string, string> }): gate.EngineRunRecord => {
    const read = gate.readEngineRun(w.written[RECORD] ?? '')
    if (!('record' in read)) throw new Error(read.problem)
    return read.record
  }

  it('runs the four steps in their order and writes a record the publication accepts for that commit', () => {
    const w = run()
    expect(w.result).toEqual({ ok: true, file: RECORD })
    expect(w.scripts).toEqual(['test:engine', 'compat:compare', 'test:engine:webstore', 'test:engine:extwindows'])
    expect(recordOf(w)).toEqual({ commit: COMMIT, clean: true, startedAt: '2026-11-20T06:01:00.000Z', endedAt: '2026-11-20T06:02:00.000Z', steps: { engine: 1, compare: 0, webstore: 0, extwindows: 0 }, reportSha256: REPORT_HASH })
    expect(gate.engineRunProblems(recordOf(w), COMMIT)).toEqual([])
  })

  it('removes the report and the record of an earlier run before it starts: they must not pass for this one’s', () => {
    const w = run({ writesReport: false })
    expect(w.removed).toEqual([REPORT, RECORD])
    expect(recordOf(w).reportSha256).toBeNull()
    expect(w.result).toMatchObject({ ok: false, file: RECORD, problems: [expect.stringMatching(/the chain wrote no report/)] })
  })

  it('starts nothing when a tracked file is modified, or when Git cannot say where the tree is', () => {
    const modified = run({ statuses: [' M package.json\n'] })
    expect(modified.result).toEqual({ ok: false, file: null, problems: [expect.stringMatching(/tracked files are modified: the suites would run on no commit.*nothing was started/)] })
    expect(modified.scripts).toEqual([])
    expect(modified.written).toEqual({})
    expect(modified.removed).toEqual([])
    const noGit = run({ gitFails: 'rev-parse' })
    expect(noGit.result).toEqual({ ok: false, file: null, problems: ['git rev-parse HEAD did not name a commit: fatal: not a git repository'] })
    expect(noGit.scripts).toEqual([])
  })

  it('runs every step whatever the one before did, and names each step that failed', () => {
    const w = run({ codes: { 'compat:compare': 1, 'test:engine:extwindows': null } })
    expect(w.scripts).toEqual(['test:engine', 'compat:compare', 'test:engine:webstore', 'test:engine:extwindows'])
    expect(w.result).toEqual({ ok: false, file: RECORD, problems: ['pnpm compat:compare ended with code 1', 'pnpm test:engine:extwindows ended with no exit code'] })
    expect(recordOf(w).steps).toEqual({ engine: 1, compare: 1, webstore: 0, extwindows: null })
  })

  it('does not pass when the tree was modified or the commit moved while the suites ran, and writes it down', () => {
    const modified = run({ statuses: ['', ' M package.json\n'] })
    expect(recordOf(modified).clean).toBe(false)
    expect(modified.result).toMatchObject({ ok: false, problems: [expect.stringMatching(/the working tree was modified while the suites ran/)] })
    const moved = run({ commits: [COMMIT, OTHER_COMMIT] })
    expect(recordOf(moved)).toMatchObject({ commit: COMMIT, clean: false })
    expect(moved.result.ok).toBe(false)
  })
})

describe('the real effects of the records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-records-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const root = fileURLToPath(new URL('../..', import.meta.url))

  it('weigh a file, write one in a folder that does not exist yet, remove one that may not exist, and ask git in the repository', () => {
    const deps = realRecordDeps(root, () => {}, gate)
    const file = join(dir, 'made', 'here', 'record.json')
    deps.writeText(file, 'abc')
    expect(readFileSync(file, 'utf8')).toBe('abc')
    expect(deps.weigh(file)).toEqual({ sha256: createHash('sha256').update('abc').digest('hex'), size: 3 })
    expect(deps.exists(file)).toBe(true)
    deps.remove(file)
    deps.remove(file)
    expect(deps.exists(file)).toBe(false)
    expect(deps.git(['rev-parse', '--is-inside-work-tree'])).toMatchObject({ status: 0, stdout: 'true\n' })
    expect(deps.git(['no-such-command']).status).not.toBe(0)
  })
})

// Each test starts the script, a Node of its own that asks Git, two to four times: more than a second on a quiet machine, several times that when every core is taken.
describe('scripts/build-record.mjs', { timeout: 30_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-record-script-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const script = fileURLToPath(new URL('../../scripts/build-record.mjs', import.meta.url))
  const version = (JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version: string }).version
  const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, ...args], { encoding: 'utf8', timeout: 30_000 })

  it('prints the commit of the repository and a 0 or a 1, then writes the record of an archive from them', () => {
    const start = run('start')
    expect(start.status, start.stderr).toBe(0)
    expect(start.stdout).toMatch(/^[0-9a-f]{40} [01]\n$/)
    const [commit, modified] = start.stdout.trim().split(' ') as [string, string]
    const archive = join(dir, `Lucium-${version}-arm64.zip`)
    writeFileSync(archive, 'not a real archive')
    const written = run('write', archive, commit, modified)
    expect(written.status, written.stderr).toBe(0)
    const read = gate.readBuildRecord(readFileSync(join(dir, gate.buildRecordNameOf(version)), 'utf8'))
    expect(read).toMatchObject({ record: { version, commit, archive: { name: `Lucium-${version}-arm64.zip`, sha256: createHash('sha256').update('not a real archive').digest('hex'), size: 18 } } })
    // A tree that was modified before the build is never written down as clean, whatever it is now.
    expect(JSON.parse(readFileSync(join(dir, gate.buildRecordNameOf(version)), 'utf8'))).toMatchObject(modified === '1' ? { clean: false } : {})
  })

  it('refuses arguments that are not what start printed (2), and an archive that does not exist (1)', () => {
    expect(run('write', join(dir, 'x.zip'), 'main', '0').status).toBe(2)
    expect(run('write', join(dir, 'x.zip')).status).toBe(2)
    expect(run().status).toBe(2)
    expect(run('start', 'more').status).toBe(2)
    const missing = run('write', join(dir, 'missing.zip'), '1234567890abcdef1234567890abcdef12345678', '0')
    expect(missing.status).toBe(1)
    expect(missing.stderr).toMatch(/build-record: .*missing\.zip does not exist/)
  })
})

describe('the scripts that write the records', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')

  it('scripts/build-drm-release.sh asks for the commit before the build and writes the record once the archive is, with --notarize', () => {
    const script = read('scripts/build-drm-release.sh')
    const asked = script.indexOf('BUILD_START="$(node scripts/build-record.mjs start)"')
    const built = script.indexOf('node scripts/package-drm.mjs "${FLAGS[@]}"')
    const archived = script.indexOf('ditto -c -k --sequesterRsrc --keepParent "$APP" "$ARCHIVE"')
    const recorded = script.indexOf('node scripts/build-record.mjs write "$ARCHIVE" $BUILD_START')
    for (const at of [asked, built, archived, recorded]) expect(at).toBeGreaterThan(-1)
    expect(asked).toBeLessThan(built)
    expect(built).toBeLessThan(archived)
    expect(archived).toBeLessThan(recorded)
    // A build that cannot name its commit does not go on to write an archive to hand out.
    expect(script).toMatch(/if ! BUILD_START="\$\(node scripts\/build-record\.mjs start\)"; then\n {4}echo "❌ [^\n]+\n {4}exit 1/)
    // `set -e` is what stops the script when the record cannot be written.
    expect(script).toMatch(/^set -e$/m)
  })

  it('scripts/build-drm-release.sh writes the SHA-256 of the archive beside it, as `shasum` prints it for a file named without its folder', () => {
    const script = read('scripts/build-drm-release.sh')
    const archived = script.indexOf('ditto -c -k --sequesterRsrc --keepParent "$APP" "$ARCHIVE"')
    const summed = script.indexOf('(cd "$(dirname "$ARCHIVE")" && shasum -a 256 "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")')
    expect(archived).toBeGreaterThan(-1)
    // After the archive is written, and from inside its folder: the release workflow keeps only a line that names the file alone.
    expect(summed).toBeGreaterThan(archived)
    expect(read('.github/workflows/release.yml')).toContain('$2 == "Lucium-" version "-arm64.zip"')
    // The guide no longer asks for that sum by hand.
    expect(read('docs/community/release-process.md')).not.toMatch(/shasum -a 256 Lucium-X\.Y\.Z-arm64\.zip >/)
  })

  it('package.json runs the engine run of a release by its script, which takes its steps from the conditions', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
    expect(scripts['test:engine:release']).toBe('node scripts/engine-release-run.mjs')
    const script = read('scripts/engine-release-run.mjs')
    expect(script).toContain("const gate = await import('../src/main/release-gate.ts')")
    expect(script).toContain('runEngineRelease({ root }, realRecordDeps(root, (line) => console.log(line), gate))')
    // It opens windows: it starts nothing when it is given an argument it does not know, and says so before anything else.
    expect(script).toMatch(/IT OPENS REAL WINDOWS/)
  })
})
