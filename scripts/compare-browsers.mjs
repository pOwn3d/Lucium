#!/usr/bin/env node
// Memory, CPU and energy of Lucium and of the other installed browsers (a passive one is read but never driven) with the same pages open.
// Protocol, limits and how to publish: docs/comparatif-navigateurs.md. Needs Node 22.18 or newer (it loads the TypeScript of
// src/shared/bench-core.ts and bench-pages.ts with Node's type stripping, as scripts/perf.mjs does).
//
//   node scripts/compare-browsers.mjs                      the plan and what was found, nothing is started
//   node scripts/compare-browsers.mjs --list               the installed browsers and their versions
//   node scripts/compare-browsers.mjs --run                the measure (about 1 h 15 for 5 browsers and 3 passes)
//
// Options (all with --run unless said): --browsers safari,chrome,brave,firefox,lucium,arc   --tabs 10,30   --passes 3
//   --settle 60 (rest after the pages loaded)   --window 60 (measured window)   --sample 5   --cooldown 15   --out <folder>
//   --load-timeout 90 (seconds given to the pages to load; a third of it, twice, per number of tabs)   --start-wait 12 (Lucium only)
//   --app <id>=<path to the .app>   --chromium <id>=<Name>=<path to the .app> (another Chromium-based browser)   --passive <id>=<Name>=<path> (a browser
//   that is already open and that you drive yourself; `arc` is declared so by default)   --fresh (one new session per
//   number of tabs, instead of adding tabs to the open session)   --no-caffeinate
//
// What it does to the machine: it starts each browser with a throw-away profile in a temporary folder (never yours), opens pages served on
// 127.0.0.1 only, and stops what it started (only that), with a home folder (HOME) of the run, not yours. Safari has no throw-away profile: it
// opens in yours, so it is measured only when --browsers names it. A passive browser is never
// started, driven, closed or asked anything: when it is already open, `ps` is read and you open its pages yourself.

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

// Node warns that the TypeScript files it loads sit in a package without "type": "module". The package is the application's and stays as
// it is; only this warning is held back, and only while the two files load.
const emitWarning = process.emitWarning
process.emitWarning = (warning, ...rest) => {
  const code = typeof rest[0] === 'object' && rest[0] !== null ? rest[0].code : rest[1]
  if (code !== 'MODULE_TYPELESS_PACKAGE_JSON') emitWarning.call(process, warning, ...rest)
}
let core
let site
try {
  core = await import('../src/shared/bench-core.ts')
  site = await import('../src/shared/bench-pages.ts')
} catch (error) {
  console.error(`Impossible de charger le coeur du banc (${error?.message ?? error}). Node 22.18 ou plus récent est nécessaire.`)
  process.exit(2)
} finally {
  process.emitWarning = emitWarning
}

// ---------- command line ----------

function parseArgs(argv) {
  const opts = { app: new Map(), chromium: [], passive: [] }
  const flags = new Set(['run', 'list', 'help', 'fresh', 'no-caffeinate'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`argument inattendu : ${arg}`)
    const key = arg.slice(2)
    if (flags.has(key)) {
      opts[key] = true
      continue
    }
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} attend une valeur`)
    if (key === 'app') {
      const at = value.indexOf('=')
      if (at < 1) throw new Error('--app attend id=chemin')
      opts.app.set(value.slice(0, at), value.slice(at + 1))
    } else if (key === 'chromium' || key === 'passive') {
      const parts = value.split('=')
      if (parts.length < 3 || !parts[0] || !parts[1]) throw new Error(`--${key} attend id=Nom=chemin`)
      opts[key].push({ id: parts[0], name: parts[1], path: parts.slice(2).join('=') })
    } else if (['browsers', 'tabs', 'passes', 'settle', 'window', 'sample', 'cooldown', 'out', 'arc-version', 'start-wait', 'load-timeout'].includes(key)) {
      opts[key] = value
    } else {
      throw new Error(`option inconnue : --${key}`)
    }
  }
  return opts
}

const positive = (name, text, fallback, { integer = true, min = 1 } = {}) => {
  if (text === undefined) return fallback
  const n = Number(text)
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) throw new Error(`--${name} : ${text} n'est pas un nombre valide (minimum ${min})`)
  return n
}

let opts
try {
  opts = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(error.message)
  process.exit(2)
}
if (opts.help) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))
  process.exit(0)
}

let tabSteps
let PASSES
let SETTLE_S
let WINDOW_S
let SAMPLE_S
let COOLDOWN_S
let START_WAIT_S
let LOAD_TIMEOUT_MS
try {
  tabSteps = (opts.tabs ?? '10,30').split(',').map((t) => positive('tabs', t.trim(), 0))
  if (tabSteps.length === 0 || tabSteps.some((t) => t > site.MAX_PAGES) || tabSteps.some((t, i) => i > 0 && t <= (tabSteps[i - 1] ?? 0))) throw new Error(`--tabs : une liste croissante de nombres de 1 à ${site.MAX_PAGES}`)
  PASSES = positive('passes', opts.passes, 3)
  SETTLE_S = positive('settle', opts.settle, 60, { min: 0 })
  WINDOW_S = positive('window', opts.window, 60, { min: 4 })
  SAMPLE_S = positive('sample', opts.sample, 5, { min: 1 })
  COOLDOWN_S = positive('cooldown', opts.cooldown, 15, { min: 0 })
  START_WAIT_S = positive('start-wait', opts['start-wait'], 12, { min: 1 })
  LOAD_TIMEOUT_MS = positive('load-timeout', opts['load-timeout'], 90, { min: 3 }) * 1000
} catch (error) {
  console.error(error.message)
  process.exit(2)
}

// ---------- small helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toISOString().slice(11, 19)
const log = (message) => console.error(`[${stamp()}] ${message}`)
const ENV_C = { ...process.env, LC_ALL: 'C' }

function sh(cmd, args, { timeout = 20_000 } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: ENV_C, timeout, maxBuffer: 128 * 1024 * 1024 })
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

/** The home folder of the browsers this run starts (src/shared/bench-core.ts, benchBrowserEnv): empty, made at the first launch, removed with the profiles. */
let browserHome = null
/** The environment of a browser we start: not the one of a tool that runs this script as an Electron "node", and not the person's home folder. */
function browserEnv() {
  browserHome ??= makeProfile('home')
  return core.benchBrowserEnv(process.env, browserHome)
}

let skippedWarned = false
function psRows() {
  const r = sh('ps', ['-axo', core.PS_COLUMNS])
  if (!r.ok) throw new Error(`ps a échoué : ${r.error?.message ?? r.stderr.trim()}`)
  const { rows, skipped } = core.parsePs(r.stdout)
  if (skipped > 0 && !skippedWarned) {
    skippedWarned = true
    log(`ps : ${skipped} ligne(s) illisible(s) ignorée(s) (les suivantes ne seront plus signalées)`)
  }
  if (rows.length === 0) throw new Error('ps ne donne aucun processus')
  return rows
}

const readBattery = () => core.parseIoregBattery(sh('ioreg', ['-rn', 'AppleSmartBattery', '-w0']).stdout)
const readIdleNs = () => core.parseHidIdleNs(sh('ioreg', ['-c', 'IOHIDSystem']).stdout)
const readPmset = () => core.parsePmsetBatt(sh('pmset', ['-g', 'batt']).stdout)

function plistValue(app, file, key) {
  const r = sh('plutil', ['-extract', key, 'raw', '-o', '-', join(app, file)])
  return r.ok ? r.stdout.trim() || null : null
}

function machineInfo() {
  const sysctl = (key) => sh('sysctl', ['-n', key]).stdout.trim()
  return {
    model: sysctl('hw.model') || 'inconnu',
    chip: sysctl('machdep.cpu.brand_string') || 'inconnu',
    memoryGiB: Math.round(Number(sysctl('hw.memsize')) / 2 ** 30),
    cores: Number(sysctl('hw.ncpu')) || 0,
    os: `macOS ${sh('sw_vers', ['-productVersion']).stdout.trim()} (${sh('sw_vers', ['-buildVersion']).stdout.trim()})`
  }
}

// ---------- the browsers ----------

const stateVersion = (() => {
  try {
    return core.readStateVersion(readFileSync(join(repoRoot, 'src/shared/model.ts'), 'utf8'))
  } catch {
    return null
  }
})()

/** mode: how the browser is started and given its pages. main: the end of the path of its main executable. */
const KNOWN = [
  { id: 'safari', name: 'Safari', mode: 'safari', apps: ['/Applications/Safari.app'], exe: 'Safari' },
  { id: 'chrome', name: 'Google Chrome', mode: 'chromium', apps: ['/Applications/Google Chrome.app'], exe: 'Google Chrome' },
  { id: 'brave', name: 'Brave', mode: 'chromium', apps: ['/Applications/Brave Browser.app'], exe: 'Brave Browser' },
  { id: 'firefox', name: 'Firefox', mode: 'firefox', apps: ['/Applications/Firefox.app', '/Applications/Firefox Developer Edition.app'], exe: 'firefox' },
  { id: 'lucium', name: 'Lucium', mode: 'lucium', apps: ['/Applications/Lucium.app', join(repoRoot, 'dist/mac-arm64/Lucium.app'), join(repoRoot, 'dist/mac/Lucium.app')], exe: 'Lucium' },
  { id: 'arc', name: 'Arc', mode: 'passive', apps: ['/Applications/Arc.app'], exe: 'Arc' }
]

function specs() {
  const all = KNOWN.map((s) => ({ ...s }))
  for (const extra of opts.chromium) {
    all.push({ id: extra.id, name: extra.name, mode: 'chromium', apps: [extra.path], exe: basename(extra.path, '.app') })
  }
  for (const extra of opts.passive) {
    all.push({ id: extra.id, name: extra.name, mode: 'passive', apps: [extra.path], exe: basename(extra.path, '.app') })
  }
  for (const spec of all) if (opts.app.has(spec.id)) spec.apps = [opts.app.get(spec.id)]
  return all
}

function findApp(spec) {
  const app = spec.apps.find((a) => existsSync(join(a, 'Contents/MacOS', spec.exe)))
  if (!app) return null
  const info = {
    app,
    exePath: join(app, 'Contents/MacOS', spec.exe),
    mainSuffix: `${basename(app)}/Contents/MacOS/${spec.exe}`,
    version: plistValue(app, 'Contents/Info.plist', 'CFBundleShortVersionString'),
    name: spec.name,
    engine: null,
    notes: []
  }
  if (spec.mode === 'lucium') {
    const electron = plistValue(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist', 'CFBundleVersion')
    info.engine = electron ? `Electron ${electron}` : null
    info.notes.push("réglage du profil jetable : les liens venus de l'extérieur s'ouvrent en onglets de la fenêtre (comme avec les autres navigateurs), au lieu d'une mini-fenêtre")
  } else if (spec.mode === 'safari') {
    info.notes.push("pas de profil jetable : Safari s'ouvre avec le profil de l'utilisateur (ses extensions, ses réglages) ; ses processus WebKit sont rattachés à lui par leur chemin")
  } else if (spec.mode === 'passive') {
    info.notes.push("jamais lancé ni piloté par le banc : lu par ps ; l'utilisateur a ouvert les pages lui-même, dans un navigateur déjà ouvert avec ses propres onglets (seul le coût par onglet de plus est comparable)")
    if (spec.id === 'arc' && opts['arc-version']) info.version = opts['arc-version']
  } else if (spec.mode === 'firefox' && /Developer Edition/i.test(app)) {
    info.notes.push("édition développeur (seule installée) : ses réglages d'usine ne sont pas ceux de la version publique")
  }
  return info
}

// ---------- the server of the pages ----------

const beacons = new site.BeaconLog()
let server = null
let origin = ''
let serverPort = 0

async function startServer() {
  server = createServer((req, res) => {
    // A page of another site must not be able to reach this server through a name it controls.
    if (!site.hostAllowed(req.headers.host, serverPort)) {
      res.writeHead(421).end()
      return
    }
    req.resume()
    const reply = site.routeRequest(req.method ?? 'GET', req.url ?? '/', beacons, Date.now())
    res.writeHead(reply.status, { 'Content-Type': reply.type, ...site.PAGE_HEADERS })
    res.end(reply.body)
  })
  server.on('clientError', (error, socket) => {
    log(`serveur : requête refusée (${error.message})`)
    socket.destroy()
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  serverPort = server.address().port
  origin = `http://127.0.0.1:${serverPort}`
}

// ---------- what was started is stopped, and nothing else ----------

const profileRoot = join(tmpdir(), 'lucium-bench-')
const startedRoots = new Set() // pids of the processes this script started
const profiles = new Set() // folders this script made
let caffeinate = null

function removeProfile(dir) {
  // Never remove anything but a folder this script made.
  if (!profiles.has(dir) || !dir.startsWith(profileRoot)) return
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      profiles.delete(dir)
      return
    } catch (error) {
      if (attempt === 2) log(`le dossier jetable ${dir} n'a pas pu être supprimé : ${error.message}`)
    }
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH: no such process. (EPERM cannot happen for a process of ours.)
    return false
  }
}

/** Signals a process; "no such process" is the expected end, anything else is said. */
function killPid(pid, signal, label) {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') log(`${label} : ${signal} sur ${pid} impossible (${error?.message ?? error})`)
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Stops a process we started and what it started: asks the main process to end (it closes the others), waits, asks the ones left, waits,
 * and only then insists, each time after checking that the pid is still the same program (a pid can be handed to another one).
 */
async function terminateTree(rootPid, label, remembered = new Map()) {
  if (rootPid === null || rootPid === undefined || rootPid <= 1) return
  try {
    let rows = psRows()
    // The processes of the tree seen during the run too: when the main process dies, the others are handed to launchd and the tree no longer shows them.
    const known = new Map([...remembered, ...core.descendantsOf(rows, [rootPid]).map((r) => [r.pid, r.command])])
    const survivors = () => {
      rows = psRows()
      const current = new Map(rows.map((r) => [r.pid, r.command]))
      return [...known].filter(([pid, command]) => current.get(pid) === command).map(([pid]) => pid)
    }
    const stages = [
      { signal: 'SIGTERM', mainOnly: true, waitMs: 12_000 },
      { signal: 'SIGTERM', mainOnly: false, waitMs: 4_000 },
      { signal: 'SIGKILL', mainOnly: false, waitMs: 2_000 }
    ]
    for (const { signal, mainOnly, waitMs } of stages) {
      const left = survivors()
      if (left.length === 0) return
      if (mainOnly && !alive(rootPid)) continue
      if (signal === 'SIGKILL') log(`${label} : ${left.length} processus ne s'arrêtent pas, ils sont arrêtés de force`)
      for (const pid of mainOnly ? left.filter((p) => p === rootPid) : left) killPid(pid, signal, label)
      const deadline = Date.now() + waitMs
      while (Date.now() < deadline && survivors().length > 0) await pause(300)
    }
    const last = survivors()
    if (last.length > 0) log(`${label} : ${last.length} processus restent en vie (${last.join(', ')}) : à arrêter à la main`)
  } catch (error) {
    log(`${label} : l'arrêt n'a pas pu être vérifié (${error.message})`)
  } finally {
    startedRoots.delete(rootPid)
  }
}

/** Set by main(): writes what has been measured so far. */
let writePartial = null

let cleaning = false
async function cleanupAll(reason) {
  if (cleaning) return
  cleaning = true
  if (reason) log(`arrêt (${reason}) : ce que le banc a lancé est arrêté`)
  if (reason && writePartial) {
    try {
      writePartial()
    } catch (error) {
      log(`résultat partiel non écrit (${error.message})`)
    }
  }
  for (const pid of [...startedRoots]) await terminateTree(pid, 'nettoyage')
  for (const dir of [...profiles]) removeProfile(dir)
  // caffeinate ends with this process anyway (-w); asking it to stop is only tidiness.
  caffeinate?.kill()
  server?.close()
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    void cleanupAll(signal).finally(() => process.exit(130))
  })
}
process.on('exit', () => {
  for (const dir of [...profiles]) {
    if (dir.startsWith(profileRoot)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        // Nothing more can be done while exiting; the folder stays in the system's temporary folder.
        console.error(`le dossier jetable ${dir} n'a pas pu être supprimé : ${error.message}`)
      }
    }
  }
})

function makeProfile(id) {
  const dir = mkdtempSync(profileRoot + id + '-')
  profiles.add(dir)
  return dir
}

// ---------- sessions: one browser, started with a given number of pages and given more ----------

function spawnBrowser(exePath, args) {
  const child = spawn(exePath, args, { stdio: 'ignore', env: browserEnv() })
  child.on('error', (error) => log(`${basename(exePath)} : lancement impossible (${error.message})`))
  if (child.pid) startedRoots.add(child.pid)
  return child
}

/** Runs a command that hands its addresses to the browser already open and ends. */
function runAndWait(exePath, args, timeoutMs = 20_000) {
  return new Promise((resolveRun) => {
    const child = spawn(exePath, args, { stdio: 'ignore', env: browserEnv() })
    const timer = setTimeout(() => {
      log(`${basename(exePath)} : la commande ne se termine pas, elle est arrêtée`)
      child.kill('SIGTERM')
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      log(`${basename(exePath)} : commande impossible (${error.message})`)
      resolveRun(false)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolveRun(code === 0)
    })
  })
}

async function waitForMainPid(info, baseline, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pids = core.findMainPids(psRows(), info.mainSuffix, baseline)
    if (pids.length > 0) return pids[0]
    await sleep(500)
  }
  return null
}

/** Opens the browser with the first addresses. Returns an object: selector(rows), add(urls), isAlive(), stop(). */
async function openSession(spec, info, urls) {
  const baseline = new Set(psRows().map((r) => r.pid))
  const session = { spec, info, rootPid: null, profile: null, baseline }
  const chromiumArgs = () => [`--user-data-dir=${session.profile}`, '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen']

  if (spec.mode === 'chromium') {
    session.profile = makeProfile(spec.id)
    const child = spawnBrowser(info.exePath, [...chromiumArgs(), ...urls])
    session.rootPid = child.pid ?? null
    session.add = (more) => runAndWait(info.exePath, [...chromiumArgs(), ...more])
  } else if (spec.mode === 'firefox') {
    session.profile = makeProfile(spec.id)
    // A fresh profile would open its welcome page and ask about the default browser: that is not what a person has open.
    writeFileSync(
      join(session.profile, 'user.js'),
      [
        'user_pref("browser.aboutwelcome.enabled", false);',
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("startup.homepage_welcome_url", "");',
        'user_pref("startup.homepage_welcome_url.additional", "");',
        'user_pref("browser.startup.homepage_override.mstone", "ignore");',
        'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);',
        'user_pref("browser.tabs.warnOnOpen", false);',
        ''
      ].join('\n')
    )
    const firefoxArgs = () => ['-profile', session.profile, '-new-instance']
    const child = spawnBrowser(info.exePath, [...firefoxArgs(), ...urls])
    session.rootPid = child.pid ?? null
    session.add = (more) => runAndWait(info.exePath, ['-profile', session.profile, ...more.flatMap((u) => ['-new-tab', u])])
  } else if (spec.mode === 'lucium') {
    if (stateVersion === null) throw new Error('la version de l’état de Lucium est introuvable dans src/shared/model.ts')
    session.profile = makeProfile(spec.id)
    writeFileSync(join(session.profile, 'state.json'), JSON.stringify(core.luciumSeedState(stateVersion)))
    const args = () => [`--user-data-dir=${session.profile}`]
    const child = spawnBrowser(info.exePath, args())
    session.rootPid = child.pid ?? null
    // The application takes the addresses of a second launch (its single-instance rule), not those of the first one.
    log(`Lucium : attente de ${START_WAIT_S} s avant de lui donner les pages`)
    await sleep(START_WAIT_S * 1000)
    session.add = (more) => runAndWait(info.exePath, [...args(), ...more])
    await session.add(urls)
  } else if (spec.mode === 'safari') {
    if (core.findMainPids(psRows(), info.mainSuffix).length > 0) throw new Error("Safari est déjà ouvert : il n'a pas de profil jetable, le banc ne peut pas séparer ce qu'il ouvre de ce que vous aviez ouvert. Fermez-le (⌘Q) et recommencez.")
    const open = (more) => runAndWait('/usr/bin/open', ['-a', info.app, ...more])
    session.add = open
    await open(urls)
    session.rootPid = await waitForMainPid(info, baseline, 40_000)
    if (session.rootPid) startedRoots.add(session.rootPid)
  } else {
    throw new Error(`mode inconnu : ${spec.mode}`)
  }
  if (!session.rootPid) {
    // The program we started may have handed over to another one (a launcher): look for the main process that was not there before.
    session.rootPid = await waitForMainPid(info, baseline, 15_000)
    if (session.rootPid) startedRoots.add(session.rootPid)
  }
  if (!session.rootPid) throw new Error('le processus principal du navigateur est introuvable après son lancement')

  session.selector = () => {
    const selector = { rootPids: [session.rootPid] }
    if (spec.mode === 'safari') Object.assign(selector, { pathIncludes: ['com.apple.WebKit.', '/Safari.app/'], excludePids: baseline })
    return selector
  }
  session.seen = new Map()
  session.processes = () => {
    const rows = psRows()
    // Only the tree is remembered for the stop: the web-view processes Safari shares with other applications are never ours to end.
    for (const row of core.descendantsOf(rows, [session.rootPid])) session.seen.set(row.pid, row.command)
    return core.selectBrowserProcesses(rows, session.selector())
  }
  session.isAlive = () => alive(session.rootPid) && session.processes().length > 0
  session.stop = async () => {
    if (spec.mode === 'safari') {
      const quit = sh('/usr/bin/osascript', ['-e', 'tell application "Safari" to quit'], { timeout: 15_000 })
      if (!quit.ok) log(`Safari : fermeture demandée sans réponse (${quit.stderr.trim() || quit.error?.message}) ; arrêt du processus lancé par le banc`)
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && alive(session.rootPid)) await sleep(300)
    }
    await terminateTree(session.rootPid, spec.name, session.seen)
    if (session.profile) removeProfile(session.profile)
  }
  return session
}

// ---------- the window of measure ----------

async function waitForPages(token, count, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (site.missingPages(beacons.loaded(token), count).length === 0) return true
    await sleep(500)
  }
  return site.missingPages(beacons.loaded(token), count).length === 0
}

/**
 * One window: the processes of the browser are read every `sampleS` seconds for `windowS` seconds, while `top` measures the footprint and the
 * energy impact over the same time, and the battery and the keyboard are read at the same rate. `select(rows)` says which processes count.
 */
async function measureWindow(select, { withTop }) {
  const t0 = Date.now()
  const procSamples = []
  const idleSamples = []
  const power = []
  const pmStart = readPmset()
  let topOut = ''
  let topFinished = !withTop
  let topChild = null
  if (withTop) {
    topChild = spawn('top', ['-l', '2', '-s', String(WINDOW_S), '-stats', 'pid,mem,power', '-n', '100000'], { env: ENV_C, stdio: ['ignore', 'pipe', 'ignore'] })
    topChild.stdout.on('data', (chunk) => (topOut += chunk))
    topChild.on('close', () => (topFinished = true))
    topChild.on('error', (error) => {
      log(`top : ${error.message}`)
      topFinished = true
    })
  }
  const take = () => {
    const tMs = Date.now() - t0
    procSamples.push({ tMs, procs: select(psRows()) })
    const idleNs = readIdleNs()
    if (idleNs !== null) idleSamples.push({ tMs, idleNs })
    const battery = readBattery()
    if (battery) power.push(battery)
  }
  take()
  const hardStop = WINDOW_S * 1000 + 25_000
  while (Date.now() - t0 < hardStop) {
    await sleep(SAMPLE_S * 1000)
    if (withTop ? topFinished : Date.now() - t0 >= WINDOW_S * 1000) break
    take()
  }
  if (!topFinished) {
    log("top n'a pas terminé à temps : arrêt, l'énergie de cette fenêtre n'est pas mesurée")
    topChild?.kill('SIGTERM')
  }
  take()
  const warnings = []
  const stats = core.summarizeWindow(procSamples)
  let footprintMiB = null
  let energyImpact = null
  if (withTop && topFinished) {
    const top = core.parseTop(topOut)
    if (top.blocks < 2) warnings.push("top n'a donné qu'un échantillon : empreinte et impact énergétique non mesurés")
    else {
      const sum = core.sumTop(top.rows, new Set((procSamples.at(-1)?.procs ?? []).map((p) => p.pid)))
      footprintMiB = sum.footprintMiB
      energyImpact = sum.energyImpact
      const lastCount = procSamples.at(-1)?.procs.length ?? 0
      if (lastCount > 0 && sum.matched < lastCount * 0.8) warnings.push(`top ne liste que ${sum.matched} des ${lastCount} processus : empreinte et impact énergétique sous-estimés`)
    }
  }
  const loads = power.map(core.systemLoadW).filter((v) => v !== null)
  const discharges = power.map(core.batteryDischargeW).filter((v) => v !== null)
  const meanOf = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null)
  if (power.length === 0) warnings.push('pas de batterie lisible (ioreg) : puissance non mesurée')
  const inputDuring = idleSamples.length >= 2 && core.inputDuringWindow(idleSamples)
  if (idleSamples.length < 2) warnings.push("activité clavier et souris non lisible : rien ne dit que la machine est restée au repos")
  if (inputDuring) warnings.push('clavier ou souris touchés pendant la fenêtre : passe écartée')
  return {
    stats,
    footprintMiB,
    energyImpact,
    systemLoadW: meanOf(loads),
    batteryDischargeW: meanOf(discharges),
    onBattery: power.length ? power.at(-1).externalConnected === false : null,
    pmStart,
    pmEnd: readPmset(),
    inputDuring,
    warnings
  }
}

// ---------- asking the user (passive browsers only) ----------

/** Waits for the user's Enter; gives up after ten minutes so that a run left alone does not wait for ever. */
function ask(question, timeoutMs = 600_000) {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolveAsk, rejectAsk) => {
    const timer = setTimeout(() => {
      rl.close()
      rejectAsk(new Error(`pas de réponse en ${timeoutMs / 60000} minutes`))
    }, timeoutMs)
    rl.question(question, (answer) => {
      clearTimeout(timer)
      rl.close()
      resolveAsk(answer)
    })
  })
}

const shellQuote = (text) => `'${text.replace(/'/g, `'\\''`)}'`

// ---------- one browser, one pass ----------

async function runBrowserPass(spec, info, pass) {
  const results = []
  let token = ''
  // A token per session: the pages of an earlier session of the same browser must not count for the next one.
  const newToken = () => {
    token = randomBytes(8).toString('hex')
    beacons.open(token)
  }
  newToken()
  const urlsFor = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => site.pageUrl(origin, token, from + i))
  let session = null
  let opened = 0
  try {
    if (spec.mode === 'passive') {
      const rows = psRows()
      const roots = core.findMainPids(rows, info.mainSuffix)
      if (roots.length === 0) throw new Error(`${info.name} n'est pas ouvert`)
      session = { selector: () => ({ rootPids: roots }), processes: () => core.selectBrowserProcesses(psRows(), { rootPids: roots }), isAlive: () => roots.every(alive), stop: async () => {} }
    }
    for (const [index, step] of tabSteps.entries()) {
      const fresh = opts.fresh && index > 0 && spec.mode !== 'passive'
      const warnings = []
      if (spec.mode === 'passive') {
        const more = urlsFor(opened + 1, step)
        if (pass > 1 && index === 0) console.error(`\n  Passe ${pass} : fermez d'abord dans ${info.name} les onglets du banc ouverts à la passe précédente (leurs adresses ne sont plus valables).`)
        console.error(`\n  ${info.name} : ouvrez dans ${info.name} ${more.length === step ? `${step} pages` : `${more.length} pages de plus (${step} au total)`}, de préférence dans une fenêtre à part, puis ne touchez plus à la machine.`)
        console.error(`  Commande à lancer vous-même dans un autre terminal (le banc n'ouvre jamais rien dans ${info.name}) :\n  open -a ${shellQuote(info.app)} ${more.map(shellQuote).join(' ')}\n`)
        if (!process.stdin.isTTY) throw new Error(`pas de terminal pour vous demander d'ouvrir les pages dans ${info.name}`)
        await ask('  Appuyez sur Entrée quand les pages sont ouvertes : ')
      } else if (index === 0 || fresh) {
        if (fresh && session) {
          await session.stop()
          newToken()
        }
        session = await openSession(spec, info, urlsFor(1, step))
        opened = 0
        if (index === 0) log(`${info.name} ${info.version ?? ''} : lancé (processus ${session.rootPid})`)
      } else {
        const ok = await session.add(urlsFor(opened + 1, step))
        if (!ok) warnings.push("l'ajout des pages à la session ouverte a échoué")
      }
      opened = step
      if (!(await waitForPages(token, step, LOAD_TIMEOUT_MS / 3)) && session.add) {
        const lacking = site.missingPages(beacons.loaded(token), step)
        log(`${info.name} : ${lacking.length} page(s) manquent, une nouvelle tentative`)
        await session.add(lacking.map((n) => site.pageUrl(origin, token, n)))
        await waitForPages(token, step, LOAD_TIMEOUT_MS / 3)
      }
      const missing = site.missingPages(beacons.loaded(token), step)
      if (missing.length > 0) warnings.push(`${missing.length} page(s) sur ${step} ne se sont pas chargées`)
      log(`${info.name} : ${step - missing.length}/${step} pages chargées, repos de ${SETTLE_S} s`)
      const restUntil = Date.now() + SETTLE_S * 1000
      while (Date.now() < restUntil) {
        if (!session.isAlive()) throw new Error('le navigateur a cessé de fonctionner pendant le repos')
        await sleep(Math.min(5000, Math.max(100, restUntil - Date.now())))
      }
      if (!session.isAlive()) throw new Error('le navigateur a cessé de fonctionner avant la mesure')
      log(`${info.name} : fenêtre de ${WINDOW_S} s (${step} onglets, passe ${pass})`)
      const m = await measureWindow(() => session.processes(), { withTop: true })
      if (!session.isAlive()) throw new Error('le navigateur s’est arrêté pendant la fenêtre de mesure')
      const visible = beacons.visibleCount(token)
      if (visible === 0) warnings.push('aucune page visible : la fenêtre du navigateur est cachée derrière une autre (passe écartée)')
      else if (visible > 1) warnings.push(`${visible} pages se disent visibles au lieu d'une : la mémoire et l'énergie sont celles de cet état`)
      if (m.onBattery === false) warnings.push("sur secteur pendant la fenêtre : la décharge de la batterie n'est pas mesurable")
      results.push({
        browserId: spec.id,
        tabs: step,
        pass,
        window: m.stats,
        footprintMiB: m.footprintMiB,
        energyImpact: m.energyImpact,
        systemLoadW: m.systemLoadW,
        batteryDischargeW: m.batteryDischargeW,
        onBattery: m.onBattery,
        batteryPercentStart: m.pmStart.percent,
        batteryPercentEnd: m.pmEnd.percent,
        pagesExpected: step,
        pagesLoaded: step - missing.length,
        pagesVisible: visible,
        inputDuringWindow: m.inputDuring,
        warnings: [...warnings, ...m.warnings]
      })
      if (!m.stats) results.at(-1).warnings.push('fenêtre sans mesure')
    }
  } finally {
    if (session) await session.stop().catch((error) => log(`${info.name} : arrêt en erreur (${error.message})`))
  }
  return results
}

// ---------- the plan ----------

function describePlan(found, machine, battery, lowPower) {
  const lines = []
  lines.push('Banc d’essai comparatif des navigateurs')
  lines.push(`Machine : ${machine.model}, ${machine.chip}, ${machine.memoryGiB} Gio, ${machine.cores} cœurs, ${machine.os}`)
  lines.push(`Alimentation : ${battery.source === 'battery' ? 'batterie' : battery.source === 'ac' ? 'secteur' : 'inconnue'}${battery.percent !== null ? `, ${battery.percent} %` : ''}${lowPower === true ? ', mode économie d’énergie ACTIF' : ''}`)
  lines.push('')
  for (const f of found) lines.push(`  ${f.spec.name.padEnd(16)} ${f.info ? `${f.info.version ?? 'version inconnue'}  ${f.info.app}${f.spec.mode === 'passive' ? '  (ouvert : lecture passive de ps, il ne sera ni lancé ni piloté)' : ''}` : f.reason}`)
  lines.push('')
  return lines
}

// ---------- main ----------

async function main() {
  if (process.platform !== 'darwin') throw new Error('Ce banc ne mesure que macOS (ps, top, ioreg, pmset).')
  const machine = machineInfo()
  const battery = readPmset()
  const lowPower = core.parseLowPowerMode(sh('pmset', ['-g']).stdout)
  const wanted = opts.browsers ? opts.browsers.split(',').map((s) => s.trim()).filter(Boolean) : null
  const all = specs()
  for (const id of wanted ?? []) if (!all.some((s) => s.id === id)) throw new Error(`navigateur inconnu : ${id} (connus : ${all.map((s) => s.id).join(', ')})`)

  // A passive browser is only ever read: it is taken into account when it is already open and was asked for or nothing was asked.
  const rows = psRows()
  const found = all
    .filter((spec) => core.isMeasuredByDefault(spec, wanted))
    .map((spec) => {
      const info = findApp(spec)
      if (!info) return { spec, info: null, reason: 'introuvable (--app ' + spec.id + '=<chemin du .app> pour le désigner)' }
      if (spec.mode === 'passive' && core.findMainPids(rows, info.mainSuffix).length === 0) return { spec, info: null, reason: "installé mais pas ouvert : ignoré (le banc ne le lance jamais)" }
      return { spec, info }
    })
  const usable = found.filter((f) => f.info)

  if (opts.list || !opts.run) {
    for (const line of describePlan(found, machine, battery, lowPower)) console.log(line)
  }
  if (opts.list) return
  if (usable.length === 0) throw new Error('aucun navigateur à mesurer')

  const estimate = core.estimateDurationS({ browsers: usable.length, passes: PASSES, steps: tabSteps.length, settleS: SETTLE_S, windowS: WINDOW_S, launchS: 30, cooldownS: COOLDOWN_S })
  if (!opts.run) {
    console.log(`Plan : ${usable.map((f) => f.spec.name).join(', ')} ; ${tabSteps.join(' puis ')} onglets dans une même session${opts.fresh ? ' (une session neuve par palier)' : ''} ; ${PASSES} passe(s) ; ${SETTLE_S} s de repos puis ${WINDOW_S} s de mesure.`)
    console.log(`Durée estimée : ${Math.round(estimate / 60)} min (plus le temps que vous mettez à ouvrir les pages dans Arc).`)
    if (usable.some((f) => f.spec.mode === 'safari')) console.log("Safari s'ouvre avec VOTRE profil (pas de profil jetable) : il doit être fermé avant, et les pages du banc resteront dans son historique.")
    if (battery.source !== 'battery') console.log("Vous êtes sur secteur : la décharge de la batterie ne sera pas mesurée (la charge de la machine l'est).")
    console.log('Aucun navigateur n’a été lancé. Ajoutez --run pour mesurer (lisez docs/comparatif-navigateurs.md avant : fermer les autres applications, ne plus toucher la machine).')
    return
  }
  if (usable.some((f) => f.spec.mode === 'passive') && !process.stdin.isTTY) {
    log(`${usable.filter((f) => f.spec.mode === 'passive').map((f) => f.spec.name).join(', ')} est ouvert mais ce terminal n'est pas interactif : ignoré.`)
    usable.splice(0, usable.length, ...usable.filter((f) => f.spec.mode !== 'passive'))
    if (usable.length === 0) throw new Error('aucun navigateur à mesurer')
  }

  await startServer()
  log(`pages servies sur ${origin} (adresse locale seulement)`)
  if (!opts['no-caffeinate']) {
    // The screen stays on and the machine awake while the bench runs; it ends with this process.
    caffeinate = spawn('/usr/bin/caffeinate', ['-d', '-i', '-w', String(process.pid)], { stdio: 'ignore' })
    caffeinate.on('error', (error) => log(`caffeinate : ${error.message} (l'écran peut s'éteindre pendant la mesure)`))
  }

  const outDir = opts.out ? resolve(opts.out) : join(tmpdir(), 'lucium-bench-results', new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(outDir, { recursive: true })
  const runs = []
  const baselineWindows = []
  const failures = []
  const startedAt = new Date()

  const baselineWindow = async (label) => {
    log(`machine au repos, sans navigateur (${label}) : ${WINDOW_S} s`)
    const m = await measureWindow((r) => r, { withTop: false })
    baselineWindows.push({ label, systemLoadW: m.systemLoadW, backgroundCpuPercent: m.stats?.cpuPercent ?? null })
  }
  const writeOut = (final) => {
    const report = core.buildReport({
      date: startedAt.toLocaleString('sv-SE', { hour12: false }).slice(0, 16),
      machine,
      method: { settleS: SETTLE_S, windowS: WINDOW_S, sampleS: SAMPLE_S, passes: PASSES, tabSteps },
      powerAtStart: battery,
      lowPowerMode: lowPower,
      baselineWindows,
      browsers: usable.map((f) => ({ id: f.spec.id, name: f.info.name, version: f.info.version, engine: f.info.engine, mode: f.spec.mode === 'passive' ? 'passive' : 'launched', notes: f.info.notes })),
      runs,
      notes: [
        ...failures.map((x) => `${x.name}, passe ${x.pass} : ${x.error}`),
        `Pages locales (5 types, adresse 127.0.0.1) : ${tabSteps.join(' puis ')} onglets. Sites réels non mesurés.`,
        final ? 'Mesure terminée.' : 'Résultat partiel : la mesure a été interrompue.'
      ]
    })
    const home = homedir()
    writeFileSync(join(outDir, final ? 'comparatif.json' : 'comparatif.partial.json'), core.redactHome(JSON.stringify(report, null, 2), home) + '\n')
    const markdown = core.redactHome(core.renderMarkdown(report), home)
    if (final) {
      writeFileSync(join(outDir, 'comparatif.md'), markdown)
      rmSync(join(outDir, 'comparatif.partial.json'), { force: true })
    }
    return markdown
  }

  writePartial = () => writeOut(false)
  try {
    await baselineWindow('avant')
    for (let pass = 1; pass <= PASSES; pass++) {
      for (const f of core.rotateOrder(usable, pass)) {
        log(`passe ${pass}/${PASSES} : ${f.spec.name}`)
        try {
          runs.push(...(await runBrowserPass(f.spec, f.info, pass)))
        } catch (error) {
          log(`${f.spec.name}, passe ${pass} : ÉCHEC (${error.message})`)
          failures.push({ name: f.spec.name, pass, error: error.message })
        }
        writeOut(false)
        if (COOLDOWN_S > 0) await sleep(COOLDOWN_S * 1000)
      }
    }
    await baselineWindow('après')
  } finally {
    await cleanupAll(null)
  }
  const markdown = writeOut(true)
  console.log(markdown)
  log(`résultats : ${outDir}`)
  if (failures.length > 0) process.exitCode = 1
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  async (error) => {
    console.error(`Erreur : ${error?.message ?? error}`)
    await cleanupAll(null)
    process.exit(1)
  }
)
