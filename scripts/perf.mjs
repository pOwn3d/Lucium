// `pnpm perf`: measures what Lucium costs in memory and processor and checks it against perf-budget.json (docs/performance.md).
//
// It builds the application, then for each scenario starts it from the sources in a throw-away data folder (the engine-test mode, offline, with
// the gates of the optional features started: src/main/smoke-perf.ts), waits until the scenario is prepared, leaves it alone, and reads the
// process tree with `ps` several times. The rules (reading `ps`, summing the tree, the budget, the comparison, the text of the report) are in
// src/shared/perf-core.ts, which Node loads as it is (type stripping): they have their tests, this file only starts processes and writes files.
// It touches nothing outside the folder of the repository (.perf/, out/, perf-budget.json with --write-budget) and the throw-away folders it
// makes in the system's temporary folder; it only ever stops processes of the tree it started.
//
// Exit code: 0 within the budget, 1 a limit passed or a regression, 2 something could not be measured or the command line is wrong.

import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { arch, cpus, release, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import * as core from '../src/shared/perf-core.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)

const PROFILE_PREFIX = 'lucium-perf-'
const SAMPLE_EVERY_MS = 5000
const STOP_GRACE_MS = 8000

const USAGE = `Usage : pnpm perf [options]

Mesure la mémoire et le processeur de Lucium (arbre de processus, lu avec ps) et les compare à perf-budget.json.

  --only a,b             seulement ces scénarios : ${core.SCENARIO_IDS.join(', ')}
  --repeat N             passages par scénario, médiane des mesures (1 par défaut)
  --cpu-seconds N        durée de la mesure du processeur (${core.DEFAULT_OPTIONS.cpuSeconds} s par défaut)
  --settle-seconds N     attente entre « scénario prêt » et la mesure (${core.DEFAULT_OPTIONS.settleSeconds} s par défaut)
  --startup-runs N       démarrages mesurés pour « startup-cold », médiane (${core.DEFAULT_OPTIONS.startupRuns} par défaut)
  --compare FICHIER      compare à un rapport JSON précédent (échoue au-delà de --max-regression)
  --max-regression P     régression tolérée en % (${core.DEFAULT_OPTIONS.maxRegressionPercent} par défaut ; l'écart doit aussi dépasser le bruit de la mesure)
  --budget FICHIER       autre fichier de seuils (perf-budget.json par défaut)
  --write-budget         écrit les mesures de ce passage comme seuils de référence dans le fichier de seuils
  --out DOSSIER          dossier des rapports (.perf par défaut)
  --electron-path FICHIER  lance ce programme à la place d'Electron (pour tester ce script avec une fausse application)
  --no-build             n'exécute pas « electron-vite build » avant (out/ doit être à jour)
  -h, --help             cette aide

Code de sortie : 0 dans le budget, 1 un seuil dépassé ou une régression, 2 mesure impossible ou ligne de commande invalide.
Ne touchez pas à la machine pendant la mesure, branchez-la sur le secteur et fermez les applications lourdes.`

const progress = (message) => console.error(`[perf] ${message}`)
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const round = (value) => Math.round(value)

function fail(message, code = 2) {
  console.error(`[perf] ${message}`)
  process.exit(code)
}

function readJson(path, what) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return fail(`${what} : lecture impossible (${path}) : ${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    return fail(`${what} : JSON invalide (${path}) : ${error.message}`)
  }
}

function parseCommandLine() {
  const argv = process.argv.slice(2)
  // `pnpm perf -- --only x` forwards the double dash.
  if (argv[0] === '--') argv.shift()
  try {
    return parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        only: { type: 'string' },
        repeat: { type: 'string' },
        'cpu-seconds': { type: 'string' },
        'settle-seconds': { type: 'string' },
        'startup-runs': { type: 'string' },
        'max-regression': { type: 'string' },
        compare: { type: 'string' },
        budget: { type: 'string' },
        out: { type: 'string' },
        'electron-path': { type: 'string' },
        'no-build': { type: 'boolean' },
        'write-budget': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' }
      }
    }).values
  } catch (error) {
    console.error(`[perf] option invalide : ${error.message}\n\n${USAGE}`)
    return process.exit(2)
  }
}

// ---------- the machine ----------

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8' }).trim()
  } catch (error) {
    progress(`${command} ${args.join(' ')} : ${error.message.split('\n')[0]} (valeur de repli utilisée)`)
    return ''
  }
}

function electronVersion() {
  return JSON.parse(readFileSync(join(dirname(require.resolve('electron/package.json')), 'package.json'), 'utf8')).version
}

function machineInfo() {
  const product = commandOutput('sw_vers', ['-productVersion'])
  return {
    os: product ? `macOS ${product}` : `Darwin ${release()}`,
    arch: arch(),
    cpu: cpus()[0]?.model ?? 'inconnu',
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    node: process.versions.node,
    electron: electronVersion()
  }
}

// ---------- the pages of the tabs ----------

function startPageServer() {
  return new Promise((resolveStart, rejectStart) => {
    const server = createServer((request, response) => {
      const index = core.parsePagePath(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
      if (index === null) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(core.pageHtml(index))
    })
    server.once('error', rejectStart)
    server.listen(0, '127.0.0.1', () => resolveStart({ server, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

// ---------- the application ----------

/** Every application started and not yet stopped: an interruption stops them. */
const running = new Set()

/** The program started for the application: Electron, unless --electron-path names another (the test of this script uses a stand-in). */
let executable = null

async function listProcesses() {
  const { stdout } = await execFileAsync('ps', core.PS_ARGS, { maxBuffer: 64 * 1024 * 1024 })
  return core.parsePsOutput(stdout)
}

function newProfile() {
  return mkdtempSync(join(tmpdir(), PROFILE_PREFIX))
}

/** Removes a folder made by `newProfile`, and only that kind. */
function removeProfile(profile) {
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
  } catch (error) {
    progress(`dossier jetable non supprimé : ${profile} (${error.message})`)
  }
}

/** Starts the application on a scenario and follows its standard output for the lines of src/shared/perf-core.ts. */
function launch(scenario, pagesBase, maxSeconds) {
  const profile = newProfile()
  const env = core.appEnvironment(process.env, {
    LUCIUM_SMOKE_ONLY: 'perf',
    LUCIUM_PERF_SCENARIO: scenario.id,
    LUCIUM_PERF_PAGES: pagesBase,
    LUCIUM_PERF_MAX_SECONDS: String(maxSeconds)
  })
  const startedAt = performance.now()
  const child = spawn(executable, ['.', '--smoke', `--user-data-dir=${profile}`], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const app = { child, profile, startedAt, markers: new Map(), tail: [], exited: null, waiters: [], exitPromise: null }
  const note = (line) => {
    app.tail.push(line.slice(0, 300))
    if (app.tail.length > 40) app.tail.shift()
  }
  const notify = () => {
    for (const waiter of [...app.waiters]) {
      const failure = app.markers.get('error')
      const found = app.markers.get(waiter.kind)
      if (failure) waiter.reject(new Error(`l’application a signalé : ${failure.marker.message}`))
      else if (found) waiter.resolve(found)
      else if (app.exited) waiter.reject(new Error(`l’application s’est arrêtée (${app.exited}) avant « ${waiter.kind} »`))
      else continue
      clearTimeout(waiter.timer)
      app.waiters.splice(app.waiters.indexOf(waiter), 1)
    }
  }
  createInterface({ input: child.stdout }).on('line', (line) => {
    note(line)
    const marker = core.parseMarkerLine(line)
    if (marker && !app.markers.has(marker.kind)) {
      app.markers.set(marker.kind, { marker, at: performance.now() })
      notify()
    }
  })
  createInterface({ input: child.stderr }).on('line', (line) => note(`err: ${line}`))
  app.exitPromise = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => {
      app.exited = signal ? `signal ${signal}` : `code ${code}`
      notify()
      resolveExit()
    })
    child.once('error', (error) => {
      app.exited = `erreur de lancement : ${error.message}`
      notify()
      resolveExit()
    })
  })
  app.waitFor = (kind, timeoutMs) =>
    new Promise((resolveWait, rejectWait) => {
      const waiter = { kind, resolve: resolveWait, reject: rejectWait, timer: setTimeout(() => {
        app.waiters.splice(app.waiters.indexOf(waiter), 1)
        rejectWait(new Error(`« ${kind} » n’est pas arrivé en ${round(timeoutMs / 1000)} s`))
      }, timeoutMs) }
      app.waiters.push(waiter)
      notify()
    })
  running.add(app)
  return app
}

/** Stops the application and its whole tree, and removes its data folder. Only processes of the tree that was started are signalled. */
async function stop(app) {
  let pids = []
  if (!app.exited) {
    try {
      pids = core.descendantsOf(await listProcesses(), app.child.pid).map((row) => row.pid)
    } catch (error) {
      progress(`arbre de processus illisible à l’arrêt : ${error.message}`)
    }
    app.child.kill('SIGTERM')
    await Promise.race([app.exitPromise, sleep(STOP_GRACE_MS)])
  }
  await sleep(300)
  for (const pid of pids) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') continue
      progress(`processus ${pid} : ${error.message}`)
      continue
    }
    progress(`processus ${pid} encore vivant après l’arrêt : arrêté de force`)
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') progress(`processus ${pid} : ${error.message}`)
    }
  }
  running.delete(app)
  removeProfile(app.profile)
}

const withTail = (error, app) => new Error(`${error.message}${app.tail.length > 0 ? `\n  dernières lignes de l’application :\n${app.tail.slice(-12).map((line) => `    ${line}`).join('\n')}` : ''}`)

// ---------- the scenarios ----------

async function runStartup(scenario, options, pagesBase) {
  const values = []
  for (let index = 1; index <= options.startupRuns; index++) {
    const app = launch(scenario, pagesBase, 300)
    try {
      const shown = await app.waitFor('shown', 120_000)
      values.push(shown.at - app.startedAt)
      await app.waitFor('ready', 120_000)
    } catch (error) {
      throw withTail(error, app)
    } finally {
      await stop(app)
    }
    progress(`  démarrage ${index}/${options.startupRuns} : ${round(values.at(-1))} ms`)
  }
  return { runs: values.length, measures: { readyMs: core.mergeRuns(values.map((readyMs) => ({ readyMs }))).readyMs }, details: { readyMsRuns: values.map(round) } }
}

async function runSteady(scenario, options, pagesBase) {
  const readyTimeoutMs = 60_000 + scenario.tabs * 4000
  const maxSeconds = Math.ceil(options.settleSeconds + options.cpuSeconds + readyTimeoutMs / 1000 + 120)
  const runs = []
  for (let index = 1; index <= options.repeat; index++) {
    const app = launch(scenario, pagesBase, maxSeconds)
    try {
      const ready = await app.waitFor('ready', readyTimeoutMs)
      progress(`  prêt (${ready.marker.info.liveTabs} onglet(s) vivant(s)) ; attente de ${options.settleSeconds} s`)
      await sleep(options.settleSeconds * 1000)
      const snapshots = []
      const take = async () => {
        const snapshot = core.takeSnapshot(await listProcesses(), app.child.pid, performance.now())
        if (!snapshot) throw new Error(`l’application s’est arrêtée pendant la mesure (${app.exited ?? 'processus introuvable'})`)
        snapshots.push(snapshot)
      }
      await take()
      const end = performance.now() + options.cpuSeconds * 1000
      for (let left = end - performance.now(); left > 0; left = end - performance.now()) {
        await sleep(Math.min(SAMPLE_EVERY_MS, left))
        await take()
      }
      const summary = core.summarizeSteady(snapshots)
      runs.push({ ...summary, info: ready.marker.info })
      progress(`  passage ${index}/${options.repeat} : ${summary.measures.rssTotalMb} Mo, ${summary.measures.processCount} processus, ${summary.measures.cpuMeanPct} % de processeur`)
    } catch (error) {
      throw withTail(error, app)
    } finally {
      await stop(app)
    }
  }
  return {
    runs: runs.length,
    measures: core.mergeRuns(runs.map((run) => run.measures)),
    details: { cpuIntervals: runs.map((run) => run.cpuIntervals), featuresOn: runs[0].info.featuresOn, featuresOff: runs[0].info.featuresOff }
  }
}

// ---------- main ----------

function build() {
  progress('construction (electron-vite build)…')
  const result = spawnSync(join(root, 'node_modules/.bin/electron-vite'), ['build'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) {
    const lines = `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n').filter(Boolean)
    console.error(lines.slice(-40).join('\n'))
    fail(`la construction a échoué (code ${result.status ?? result.signal})`)
  }
}

async function main() {
  const values = parseCommandLine()
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  const { options, errors } = core.resolveOptions({
    only: values.only,
    repeat: values.repeat,
    cpuSeconds: values['cpu-seconds'],
    settleSeconds: values['settle-seconds'],
    startupRuns: values['startup-runs'],
    maxRegression: values['max-regression']
  })
  if (!options) fail(`${errors.join('\n[perf] ')}\n\n${USAGE}`)

  const budgetPath = resolve(root, values.budget ?? 'perf-budget.json')
  const parsedBudget = core.parseBudget(readJson(budgetPath, 'fichier de seuils'))
  if (!parsedBudget.budget) fail(`${budgetPath} est invalide :\n  - ${parsedBudget.errors.join('\n  - ')}`)
  const budget = parsedBudget.budget
  const gaps = core.budgetGaps(budget)
  if (gaps.length > 0) fail(`${budgetPath} ne donne pas de seuil pour : ${gaps.join(', ')}`)

  let previous = null
  if (values.compare) {
    const parsedPrevious = core.parseReport(readJson(resolve(values.compare), 'rapport précédent'))
    if (!parsedPrevious.report) fail(`${values.compare} n’est pas un rapport de perf :\n  - ${parsedPrevious.errors.join('\n  - ')}`)
    previous = parsedPrevious.report
  }

  // Lucium is built for macOS only; a stand-in program (the tests of this script) can run wherever `ps` has these columns.
  if (process.platform === 'win32' || (process.platform !== 'darwin' && !values['electron-path'])) fail('perf ne sait lire que le ps de macOS (Lucium ne se construit que pour macOS).')

  executable = values['electron-path'] ? resolve(values['electron-path']) : require('electron')
  if (values['electron-path']) {
    if (!existsSync(executable)) fail(`--electron-path : ${executable} n’existe pas.`)
  } else if (!values['no-build']) build()
  else if (!existsSync(join(root, 'out/main/index.js'))) fail('out/main/index.js manque : lancez sans --no-build.')

  const machine = machineInfo()
  const { server, base } = await startPageServer()
  const interrupt = async (signal) => {
    progress(`${signal} : arrêt des applications lancées…`)
    await Promise.all([...running].map((app) => stop(app)))
    server.close()
    process.exit(130)
  }
  process.once('SIGINT', () => void interrupt('SIGINT'))
  process.once('SIGTERM', () => void interrupt('SIGTERM'))

  const results = {}
  const failures = {}
  try {
    for (const id of options.only) {
      const scenario = core.scenarioById(id)
      progress(`${scenario.id} — ${scenario.label}`)
      try {
        results[scenario.id] = scenario.kind === 'startup' ? await runStartup(scenario, options, base) : await runSteady(scenario, options, base)
      } catch (error) {
        failures[scenario.id] = error.message
        progress(`  ÉCHEC : ${error.message}`)
      }
    }
  } finally {
    server.closeAllConnections()
    server.close()
  }

  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    machine,
    options: { repeat: options.repeat, cpuSeconds: options.cpuSeconds, settleSeconds: options.settleSeconds, startupRuns: options.startupRuns },
    results,
    failures
  }
  const writeBudget = values['write-budget'] === true
  const verdicts = core.evaluateBudget(results, budget)
  const changes = previous ? core.compareReports(previous, report, options.maxRegressionPercent) : undefined
  const text = core.renderReport({ report, verdicts, changes, otherMachine: previous && !core.sameMachine(previous.machine, machine) ? previous.machine : undefined, budget })
  console.log(text)

  const outDir = resolve(root, values.out ?? '.perf')
  mkdirSync(outDir, { recursive: true })
  const stamp = report.generatedAt.replace(/[:.]/g, '-')
  const jsonPath = join(outDir, `perf-${stamp}.json`)
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(outDir, `perf-${stamp}.md`), text)
  copyFileSync(jsonPath, join(outDir, 'latest.json'))
  progress(`rapport : ${jsonPath} (copie : ${join(outDir, 'latest.json')})`)

  if (writeBudget) {
    if (Object.keys(failures).length > 0) progress('--write-budget ignoré : un scénario a échoué, les seuils ne sont pas écrits depuis une mesure incomplète.')
    else {
      const reference = { machine: commandOutput('sysctl', ['-n', 'hw.model']) || machine.arch, os: machine.os, cpu: machine.cpu, memoryGb: machine.memoryGb, electron: machine.electron }
      const proposed = core.proposeBudget(budget, report, reference)
      writeFileSync(budgetPath, `${JSON.stringify(proposed, null, 2)}\n`)
      progress(`${budgetPath} réécrit${proposed.provisional ? ' (encore provisoire : tous les scénarios n’ont pas été mesurés)' : ''}. Relisez le diff avant de le versionner.`)
    }
  }
  return core.exitCodeFor({ verdicts: writeBudget ? [] : verdicts, changes: changes ?? [], failures })
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error('[perf] erreur inattendue :', error)
    process.exit(2)
  }
)
