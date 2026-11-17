import { spawnSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// scripts/compare-browsers.mjs, run for real against a stand-in for a browser (--chromium): a small program that takes the command line of a
// Chromium browser (--user-data-dir=<folder> and addresses), starts three processes of its own that hold memory, fetches each address from
// the server of the script and says hello to it as a page would. Nothing here starts a browser. What the stand-in cannot tell is what a real
// browser does with a profile or a window; what it does tell is that the script serves, follows the tree, measures with the real `ps` and
// `top`, counts the pages that loaded, reports, writes its files, exits with the right code, and leaves no process and no folder behind.
// The tools it reads (ps, top, ioreg, pmset) are those of macOS.

const script = fileURLToPath(new URL('../../scripts/compare-browsers.mjs', import.meta.url))
const onMac = process.platform === 'darwin'

let dir = ''
let app = ''
const logFiles: string[] = []

/**
 * `FAKE_LOG` names a file where the stand-in writes the pids of its processes (and, beside it, the answer of the server to a request that names another host);
 * `FAKE_MODE` is `nohello` (pages after the second never report) or `crash` (it ends after 5 s).
 */
const standIn = `#!${process.execPath}
const { spawn } = require('node:child_process')
const http = require('node:http')
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
const dir = (args.find((a) => a.startsWith('--user-data-dir=')) || '').split('=')[1]
const urls = args.filter((a) => /^https?:\\/\\//.test(a))
const note = (pid) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, pid + '\\n')
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const pidFile = join(dir, 'pid')
const queue = join(dir, 'queue')
if (existsSync(pidFile) && alive(Number(readFileSync(pidFile, 'utf8')))) {
  appendFileSync(queue, urls.join('\\n') + '\\n')
  process.exit(0)
}
writeFileSync(pidFile, String(process.pid))
writeFileSync(queue, '')
note(process.pid)
const helpers = [1, 2, 3].map(() => {
  const child = spawn(process.execPath, ['-e', 'const b=Buffer.alloc(30e6,1);setInterval(()=>{b[0]++},1000)'], { stdio: 'ignore' })
  note(child.pid)
  return child
})
const held = []
const done = new Set()
async function load(url) {
  if (done.has(url)) return
  done.add(url)
  const m = /^(http:\\/\\/127\\.0\\.0\\.1:\\d+)\\/r\\/([a-z0-9]+)\\/p\\/(\\d+)$/.exec(url)
  if (!m) return
  // A request that names another host must be refused by the server of the script.
  if (m[3] === '1' && process.env.FAKE_LOG) {
    const port = Number(new URL(url).port)
    http.get({ host: '127.0.0.1', port, path: '/r/' + m[2] + '/p/1', headers: { Host: 'evil.example:' + port } }, (res) => { appendFileSync(process.env.FAKE_LOG + '.host', res.statusCode + '\\n'); res.resume() })
  }
  const html = await (await fetch(url)).text()
  held.push(Buffer.alloc(4e6, html.length % 255))
  if (process.env.FAKE_MODE === 'nohello' && Number(m[3]) > 2) return
  await fetch(m[1] + '/r/' + m[2] + '/hello?p=' + m[3] + '&v=' + (m[3] === '1' ? 'visible' : 'hidden'))
}
let seen = 0
async function main() {
  for (const u of urls) await load(u)
  setInterval(async () => {
    const lines = readFileSync(queue, 'utf8').split('\\n').filter(Boolean)
    for (const u of lines.slice(seen)) await load(u)
    seen = lines.length
  }, 300)
}
main()
if (process.env.FAKE_MODE === 'crash') setTimeout(() => process.exit(3), 5000)
process.on('SIGTERM', () => { for (const h of helpers) h.kill(); process.exit(0) })
setTimeout(() => process.exit(0), 120000)
`

interface Outcome {
  status: number | null
  stdout: string
  stderr: string
}

/** The script is given the stand-in and only the stand-in: whatever a test does, no browser of the machine is named. */
const plan = (args: string[], env: Record<string, string> = {}): Outcome => {
  const result = spawnSync(process.execPath, [script, '--chromium', `fake=Fake=${app}`, '--browsers', 'fake', '--no-caffeinate', ...args], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const quick = ['--run', '--tabs', '2,3', '--passes', '1', '--settle', '1', '--window', '4', '--sample', '2', '--cooldown', '0', '--load-timeout', '6']

/** An actual run, asynchronous so that several can go at once. */
function run(name: string, extra: string[], env: Record<string, string> = {}): Promise<Outcome & { out: string; pids: number[]; profiles: string[] }> {
  const out = join(dir, `out-${name}`)
  const log = join(dir, `pids-${name}`)
  // Its own temporary folder: the throw-away profiles of the run are made there, so that what is left of them is told for this run alone.
  const temp = join(dir, `tmp-${name}`)
  mkdirSync(temp)
  logFiles.push(log)
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [script, '--chromium', `fake=Fake=${app}`, '--browsers', 'fake', '--no-caffeinate', ...quick, '--out', out, ...extra], { env: { ...process.env, ...env, FAKE_LOG: log, TMPDIR: temp } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (status) => {
      const pids = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(Number) : []
      resolveRun({ status, stdout, stderr, out, pids, profiles: readdirSync(temp).filter((name) => name.startsWith('lucium-bench-fake-')) })
    })
  })
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-bench-test-'))
  app = join(dir, 'Fake.app')
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
  writeFileSync(
    join(app, 'Contents/Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>9.8.7-standin</string></dict></plist>\n'
  )
  writeFileSync(join(app, 'Contents/MacOS/Fake'), standIn)
  chmodSync(join(app, 'Contents/MacOS/Fake'), 0o755)
})

afterAll(() => {
  // Whatever a failing test left running is the test's own: the stand-ins it started.
  for (const file of logFiles.filter((path) => existsSync(path))) {
    for (const pid of readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number)) if (alive(pid)) process.kill(pid, 'SIGKILL')
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('scripts/compare-browsers.mjs: the command line', () => {
  it('prints its usage and exits 0', () => {
    const outcome = plan(['--help'])
    expect(outcome.status).toBe(0)
    for (const flag of ['--run', '--list', '--browsers', '--tabs', '--passes', '--settle', '--window', '--fresh']) expect(outcome.stdout).toContain(flag)
  })

  it('exits 2 with the reason for an option that does not exist, a list of tabs that does not grow and a number out of range', () => {
    expect(plan(['--bogus', '1'])).toMatchObject({ status: 2, stderr: expect.stringContaining('option inconnue : --bogus') })
    expect(plan(['--tabs', '30,10'])).toMatchObject({ status: 2, stderr: expect.stringContaining('--tabs') })
    expect(plan(['--tabs', '10,500'])).toMatchObject({ status: 2, stderr: expect.stringContaining('--tabs') })
    expect(plan(['--passes', '0'])).toMatchObject({ status: 2, stderr: expect.stringContaining('--passes') })
    expect(plan(['--window', '1'])).toMatchObject({ status: 2, stderr: expect.stringContaining('--window') })
  })

  it.skipIf(!onMac)('starts nothing without --run: it prints what it found and the plan', () => {
    const log = join(dir, 'pids-plan')
    logFiles.push(log)
    const outcome = plan([], { FAKE_LOG: log })
    expect(outcome.status).toBe(0)
    expect(outcome.stdout).toContain('Fake')
    expect(outcome.stdout).toContain('9.8.7-standin')
    expect(outcome.stdout).toContain('Aucun navigateur n’a été lancé')
    expect(existsSync(log)).toBe(false)
  })

  it.skipIf(!onMac)('refuses a browser it does not know', () => {
    expect(plan(['--browsers', 'netscape'])).toMatchObject({ status: 1, stderr: expect.stringContaining('navigateur inconnu : netscape') })
  })

  it.skipIf(!onMac)('says what it found with --list, and what it did not (an application that is not there)', () => {
    const outcome = plan(['--list', '--app', 'safari=/nonexistent/Safari.app', '--browsers', 'fake,safari'])
    expect(outcome.status).toBe(0)
    expect(outcome.stdout).toContain('9.8.7-standin')
    expect(outcome.stdout).toMatch(/Safari\s+introuvable/)
  })
})

describe.skipIf(!onMac)('scripts/compare-browsers.mjs: a run against the stand-in', () => {
  // The runs go at the same time: each has its own server, its own profile and its own stand-in.
  let runs: Record<'normal' | 'missing' | 'crash' | 'crashAtRest', ReturnType<typeof run>>
  beforeAll(() => {
    runs = {
      normal: run('normal', []),
      missing: run('missing', [], { FAKE_MODE: 'nohello' }),
      crash: run('crash', [], { FAKE_MODE: 'crash' }),
      crashAtRest: run('crash-rest', ['--settle', '8'], { FAKE_MODE: 'crash' })
    }
  })

  it('measures the tree of the stand-in at each number of tabs, counts the pages, reports in JSON and Markdown, and leaves nothing behind', { timeout: 120_000 }, async () => {
    const r = await runs.normal
    expect(r.status).toBe(0)
    const report = JSON.parse(readFileSync(join(r.out, 'comparatif.json'), 'utf8'))
    expect(report.schema).toBe('lucium-compare-browsers/1')
    expect(report.browsers).toMatchObject([{ id: 'fake', name: 'Fake', version: '9.8.7-standin', mode: 'launched' }])
    expect(report.method).toMatchObject({ passes: 1, tabSteps: [2, 3], windowS: 4 })
    expect(report.baseline.windows.map((w: { label: string }) => w.label)).toEqual(['avant', 'après'])
    expect(report.runs).toHaveLength(2)
    for (const [index, tabs] of [2, 3].entries()) {
      const result = report.runs[index]
      expect(result).toMatchObject({ browserId: 'fake', tabs, pagesExpected: tabs, pagesLoaded: tabs, pagesVisible: 1 })
      // The main process and its three helpers; each holds tens of MiB.
      expect(result.window.processesMean).toBe(4)
      expect(result.window.rssMiBMean).toBeGreaterThan(100)
      expect(result.window.durationS).toBeGreaterThan(3)
    }
    expect(report.perTab).toHaveLength(1)
    const markdown = readFileSync(join(r.out, 'comparatif.md'), 'utf8')
    expect(markdown).toContain('## 2 onglets')
    expect(markdown).toContain('## 3 onglets')
    expect(markdown).toContain('| Fake | 9.8.7-standin |')
    expect(r.stdout).toContain('# Comparatif de navigateurs')
    const home = process.env['HOME'] ?? ''
    if (home.length > 1) expect(JSON.stringify(report)).not.toContain(home)
    // Four processes were started, and none is left; the profile folder is gone.
    expect(r.pids.length).toBeGreaterThanOrEqual(4)
    expect(r.pids.filter(alive)).toEqual([])
    expect(r.profiles).toEqual([])
  })

  it('serves its own address only: a request that names another host is refused', { timeout: 120_000 }, async () => {
    const r = await runs.normal
    expect(readFileSync(join(dir, 'pids-normal.host'), 'utf8').trim().split('\n')).toEqual(['421'])
    expect(r.stderr).toMatch(/pages servies sur http:\/\/127\.0\.0\.1:\d+/)
  })

  it('says that pages did not load, and does not count that pass', { timeout: 120_000 }, async () => {
    const r = await runs.missing
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('page(s) manquent, une nouvelle tentative')
    const report = JSON.parse(readFileSync(join(r.out, 'comparatif.json'), 'utf8'))
    expect(report.runs.map((x: { pagesLoaded: number }) => x.pagesLoaded)).toEqual([2, 2])
    // The warnings about the machine (mains power, a key touched) depend on whoever runs the test: only the one about the pages is asked.
    expect(report.runs[0].warnings.join(' ')).not.toContain('ne se sont pas chargées')
    expect(report.runs[1].warnings.join(' ')).toContain('1 page(s) sur 3 ne se sont pas chargées')
    const bySize = (tabs: number) => report.summary.find((s: { tabs: number }) => s.tabs === tabs)
    expect(bySize(2)).toMatchObject({ validPasses: 1 })
    expect(bySize(3)).toMatchObject({ validPasses: 0, allInvalid: true, pagesLoadedMin: 2 })
    expect(readFileSync(join(r.out, 'comparatif.md'), 'utf8')).toContain('(aucune valide)')
    expect(r.pids.filter(alive)).toEqual([])
    expect(r.profiles).toEqual([])
  })

  it('reports a browser that stops during the measure as a failure (exit 1), and ends what it had left', { timeout: 120_000 }, async () => {
    const r = await runs.crash
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('ÉCHEC (le navigateur s’est arrêté pendant la fenêtre de mesure)')
    const report = JSON.parse(readFileSync(join(r.out, 'comparatif.json'), 'utf8'))
    expect(report.notes.join(' ')).toContain('Fake, passe 1 : le navigateur s’est arrêté pendant la fenêtre de mesure')
    // The stand-in died on its own; its three helpers were handed to launchd and the script ended them.
    expect(r.pids.length).toBeGreaterThanOrEqual(4)
    expect(r.pids.filter(alive)).toEqual([])
    expect(r.profiles).toEqual([])
  })

  it('reports a browser that stops while it rests as a failure too', { timeout: 120_000 }, async () => {
    const r = await runs.crashAtRest
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('ÉCHEC (le navigateur a cessé de fonctionner pendant le repos)')
    expect(r.pids.filter(alive)).toEqual([])
    expect(r.profiles).toEqual([])
  })
})
