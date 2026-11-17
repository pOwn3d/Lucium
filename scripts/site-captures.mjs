// `pnpm captures:site`: the screenshots of the public site, taken from the application itself, in French and in English, light and dark.
//
// For each language and theme it starts Lucium in a throw-away data folder (`--user-data-dir` in the temporary folder of the run, never the real
// profile ~/Library/Application Support/Lucium), filled with the demonstration state of scripts/site-captures/demo.ts, with a made-up home
// folder (HOME) that holds nothing but a bookmarks file for the import sheet: the application never sees the real data of this Mac, and the
// import sheet reads no application's name in /Applications (LUCIUM_IMPORT_APP_FOLDERS, capture.ts), so that no shot shows another browser's
// name. The pages of the tabs are served on 127.0.0.1 from scripts/site-captures/pages.ts under the reserved domain `.example`, and the Community
// page of the public site from a checkout of the site under its own address, with a stand-in of its API (community.ts), both by
// `--host-resolver-rules`. The keychain is a stand-in (`--use-mock-keychain`): no « Lucium Safe Storage » prompt. Each shot of
// scripts/site-captures/shots.ts is put in place the way the end-to-end tests drive the application (the reducer's actions and the interface's
// requests through `window.lucium`, a Shift-click in a page, typing in the command bar; with the development build, a file chooser answered
// with a file of the run and a click on a menu, in the main process), then the window is captured whole by `screencapture -l <CGWindowID>`, with
// the shadow of macOS and without it, and made into WebP images for the site with ImageMagick.
//
// Two targets: the development build (out/, built first unless --no-build), driven by Playwright's Electron launcher, which gives the main process
// (`BrowserWindow.getMediaSourceId()` is `window:<CGWindowID>:0` on macOS); or a packaged application (`--app …/Lucium.app`), whose fuses refuse
// the Node inspector Playwright needs: it is started with the DevTools protocol of Chromium instead, driven through its pages only, and its
// windows are found in the list macOS keeps (CGWindowListCopyWindowInfo, by process and place). Since 1.0 the packaged application refuses to
// start with these switches (src/main/runtime.ts, REFUSED_SWITCHES): `--app` works with an older build only, and says so for a newer one.
//
// It opens windows and takes the focus: run it when nobody uses the Mac. macOS must let the terminal record the screen (checked first).
// The rules (shots, paths, switches, the window to pick, the arguments of the tools) are in scripts/site-captures/*.ts, loaded with Node's
// type stripping and tested by vitest; this file starts processes, serves pages and writes files.
//
// `--features` takes the images of the cards of the features page of the site instead (scripts/site-captures/features.ts): one scenario per card, in
// French and in English, light only, each cropped to what matters and written as out-captures/features/<card>-<lang>-light.webp with manifest.json
// (the files, their sizes, the alternative texts, what each image shows). `--missing` takes only the images not there yet; `--dry-run` lists the
// scenarios and checks each against the sources of the application and the pages of the site, without starting anything. An image that would
// show another browser's name is refused: its text on screen is read first, and the image itself is read again by tesseract when it is there.
//
// Exit code: 0 every shot taken, 1 a shot failed, 2 nothing could be taken (a missing tool, the permission, the command line).

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { crc32, deflateSync } from 'node:zlib'
import * as capture from './site-captures/capture.ts'
import * as community from './site-captures/community.ts'
import * as demo from './site-captures/demo.ts'
import * as features from './site-captures/features.ts'
import * as labels from './site-captures/labels.ts'
import * as names from './site-captures/names.ts'
import * as pages from './site-captures/pages.ts'
import * as shots from './site-captures/shots.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** The profile of the installed application (and of `pnpm dev`): never opened here. Its name is the productName of package.json. */
const REAL_PROFILE = join(homedir(), 'Library/Application Support/Lucium')
const SCREENCAPTURE = '/usr/sbin/screencapture'
const OSASCRIPT = '/usr/bin/osascript'
/** How long the application may take to quit before it is stopped. */
const QUIT_LIMIT_MS = 10_000
/** The animations of the interface (a panel that opens, a selection that moves) are over well before this. */
const SETTLE_MS = 900

const USAGE = `Usage : pnpm captures:site [options]

Prend les captures d’écran du site public : Lucium dans un profil de démonstration jetable, en français et en anglais, en clair et en sombre.
Les images vont dans out-captures/<langue>/<thème>/ : <prise>.png (avec l’ombre de macOS), <prise>-no-shadow.png, et les WebP du site dans web/.

  --app CHEMIN          capture cette application empaquetée (par exemple dist-drm/mac-arm64/Lucium.app) au lieu de la build de développement ;
                        une application 1.0 ou plus récente refuse les commutateurs de pilotage et ne peut pas être capturée ainsi
  --only a,b            seulement ces prises (voir --list)
  --langs fr,en         langues (les deux par défaut)
  --themes light,dark   thèmes (les deux par défaut)
  --widths 1280,2560    largeurs maximales des images WebP (${shots.WEB_WIDTHS.join(',')} par défaut)
  --out DOSSIER         dossier des images (out-captures par défaut)
  --site DOSSIER        copie du site public, pour la page Communauté (../lucium-website par défaut) ; sans elle, ses deux prises sont laissées de côté
  --no-build            n’exécute pas « electron-vite build » avant (out/ doit être à jour ; sans effet avec --app)
  --no-webp             ne fait pas les images WebP
  --allow-1x            accepte un écran qui n’est pas Retina (les images sont alors en 1×)
  --keep                garde le dossier temporaire du passage (profils, journaux de l’application)
  --list                affiche les prises et les fichiers qu’elles produiront, sans rien lancer
  --features            prend les images des cartes de la page Fonctions du site (une par carte, en clair), dans out-captures/features/
  --missing             avec --features : seulement les images qui manquent (reprend un passage interrompu)
  --dry-run             avec --features : liste les scénarios et vérifie chacun contre les sources et le site, sans rien lancer
  --serve               sert seulement les pages de démonstration, pour les regarder
  -h, --help            cette aide

Avec --app, les prises qui demandent la build de développement (sélecteur de fichiers, menu, noms génériques des navigateurs) sont laissées de côté.
Avec --features, --only prend des identifiants de cartes (fn-sleep,fn-qr-code), et --themes est sans effet (le site est en clair) ; --app est refusé.
Code de sortie : 0 toutes les prises faites, 1 une prise a échoué, 2 rien n’a pu être pris (outil manquant, autorisation, ligne de commande).
Les fenêtres de Lucium s’ouvrent et prennent le focus, et le pointeur est déplacé au bord de l’écran : lancez-le quand personne n’utilise le Mac.
Le terminal doit avoir l’autorisation d’enregistrer l’écran (Réglages Système › Confidentialité et sécurité › Enregistrement de l’écran et de l’audio système).`

const progress = (message) => console.error(`[captures] ${message}`)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function fail(message, code = 2) {
  console.error(`[captures] ${message}`)
  process.exit(code)
}

function parseCommandLine() {
  const argv = process.argv.slice(2)
  // `pnpm captures:site -- --only x` forwards the double dash.
  if (argv[0] === '--') argv.shift()
  try {
    return parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        app: { type: 'string' },
        only: { type: 'string' },
        langs: { type: 'string' },
        themes: { type: 'string' },
        widths: { type: 'string' },
        out: { type: 'string' },
        site: { type: 'string' },
        'no-build': { type: 'boolean' },
        'no-webp': { type: 'boolean' },
        'allow-1x': { type: 'boolean' },
        keep: { type: 'boolean' },
        list: { type: 'boolean' },
        serve: { type: 'boolean' },
        features: { type: 'boolean' },
        missing: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' }
      }
    }).values
  } catch (error) {
    console.error(`[captures] option invalide : ${error.message}\n\n${USAGE}`)
    return process.exit(2)
  }
}

// ---------- the machine ----------

/** Runs a JavaScript for Automation script (capture.ts) with its arguments and returns what it printed. */
function jxa(script, args = []) {
  return execFileSync(OSASCRIPT, ['-l', 'JavaScript', '-e', script, ...args.map(String)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function hasCommand(command) {
  return spawnSync('/usr/bin/which', [command], { stdio: 'ignore' }).status === 0
}

/**
 * Whether the images of the features page are read again once taken (tesseract, `brew install tesseract`): without it, only the text on screen is
 * checked for names, which leaves out what an image, an icon or a canvas draws. Said once at the start of the run.
 */
function findTesseract() {
  if (hasCommand('tesseract')) return true
  progress('tesseract est absent : le texte dessiné dans les images ne sera pas relu, seul le texte à l’écran est vérifié (brew install tesseract)')
  return false
}

function checkTools(webp) {
  if (process.platform !== 'darwin') fail('les captures se font sur macOS (screencapture, osascript).')
  const missing = [
    ...(existsSync(SCREENCAPTURE) ? [] : ['screencapture']),
    ...(existsSync(OSASCRIPT) ? [] : ['osascript']),
    ...(hasCommand('openssl') ? [] : ['openssl (le certificat du serveur local)']),
    ...(!webp || hasCommand('magick') ? [] : ['magick (ImageMagick, pour les WebP : brew install imagemagick, ou --no-webp)'])
  ]
  if (missing.length > 0) fail(`outil manquant : ${missing.join(', ')}`)
}

/** Stops when macOS does not let this terminal record the screen: `screencapture -l` would then give images without the windows. */
function checkScreenRecording() {
  let answer
  try {
    answer = jxa(capture.PREFLIGHT_JXA)
  } catch (error) {
    fail(`impossible de demander à macOS si l’enregistrement de l’écran est autorisé : ${error.message.split('\n')[0]}`)
  }
  if (answer === 'true') return
  fail(
    [
      'macOS n’autorise pas l’enregistrement de l’écran à l’application qui lance ce script (le terminal, ou l’éditeur qui l’héberge).',
      'Accordez-le dans Réglages Système › Confidentialité et sécurité › Enregistrement de l’écran et de l’audio système :',
      'activez votre terminal (ajoutez-le avec « + » s’il n’est pas dans la liste), quittez-le complètement et rouvrez-le, puis relancez.'
    ].join('\n[captures] ')
  )
}

/** The screen the shots are taken on: a Retina screen with room for the main window (or, with --allow-1x, any screen with room for it). */
function chooseScreen(allowLowScale) {
  let screens
  try {
    screens = capture.parseScreens(jxa(capture.SCREENS_JXA))
  } catch (error) {
    fail(`impossible de lire les écrans : ${error.message.split('\n')[0]}`)
  }
  const chosen = capture.pickScreen(screens, shots.MAIN_SIZE, allowLowScale)
  if (chosen) {
    if (chosen.scale < 2) progress(`attention : l’écran choisi est à l’échelle ${chosen.scale} : les images seront en ${chosen.scale}×, pas en Retina 2×.`)
    return chosen
  }
  const described = screens.map((s) => `${s.workArea.width}×${s.workArea.height} points utiles à l’échelle ${s.scale}`).join(' ; ')
  fail(
    `aucun écran ne convient (${described}). Il faut un écran Retina (échelle 2) dont la zone utile dépasse ${shots.MAIN_SIZE.width}×${shots.MAIN_SIZE.height} points : ` +
      'l’écran du portable (Dock masqué automatiquement s’il prend trop de place), ou un écran externe réglé dans une résolution « Retina » ' +
      '(Réglages Système › Moniteurs). --allow-1x accepte un écran en 1×.'
  )
}

/** Puts the pointer where it hovers nothing of the application (pointerRestingPlace), on the screen of the shots. */
function restPointer(screen, windows = []) {
  const spot = capture.pointerRestingPlace(screen.workArea, windows)
  try {
    jxa(capture.MOVE_POINTER_JXA, [spot.x, spot.y])
  } catch (error) {
    progress(`le pointeur n’a pas pu être déplacé (${error.message.split('\n')[0]}) : une ligne survolée peut apparaître sur la capture`)
  }
}

function systemWindows(pid) {
  return capture.parseWindowList(jxa(capture.WINDOW_LIST_JXA, [pid]))
}

// ---------- the run's folder: certificate, made-up home folders, profiles ----------

function makeCertificate(work) {
  const dir = join(work, 'certificate')
  mkdirSync(dir)
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=demo.example'], { stdio: 'ignore' })
  return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }
}

/**
 * A home folder with nothing but the bookmarks file of the demonstration (Documents/), which the file chooser of the import sheet is answered
 * with. No other browser's data is there: the first-launch guide finds only the browser of macOS, which it always lists, under its generic label.
 */
function makeHome(work, lang) {
  const home = join(work, `home-${lang}`)
  const file = demo.bookmarksPath(home, lang)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, demo.bookmarksFile(lang).html)
  return home
}

/** The unpacked extension of the demonstration, in the language of the session: its manifest and its icon (a PNG made here). */
function makeExtension(work, lang) {
  const dir = join(work, `extension-${lang}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(demo.extensionManifest(lang), null, 2))
  writeFileSync(join(dir, 'icon-128.png'), capture.encodePng(128, 128, demo.extensionIcon(128), (data) => deflateSync(data), (data) => crc32(data)))
  return dir
}

/** The extensions of the features page (demo.ts `DEMO_EXTENSIONS`), in the language of the session: a folder for each, by kind. */
function makeDemoExtensions(work, lang) {
  const folders = {}
  for (const [kind, def] of Object.entries(demo.DEMO_EXTENSIONS)) {
    const dir = join(work, `extension-${kind}-${lang}`)
    mkdirSync(dir, { recursive: true })
    for (const [name, text] of Object.entries(def.files(lang))) writeFileSync(join(dir, name), text)
    folders[kind] = dir
  }
  return folders
}

function makeProfile(work, session, bounds, siteFound) {
  const profile = mkdtempSync(join(work, `profile-${session.lang}-${session.theme}-${session.kind}-`))
  capture.assertThrowawayProfile(profile, REAL_PROFILE, work)
  // The first-launch guide opens by itself only for a profile without a state file: the fresh session writes only where its window goes.
  if (session.kind === 'demo') {
    const now = Date.now()
    writeFileSync(join(profile, 'state.json'), JSON.stringify(demo.demoState(session.lang, session.theme, now, { leaveOut: siteFound ? [] : ['community'] })))
    writeFileSync(join(profile, 'notes.json'), `${JSON.stringify(demo.demoNotes(session.lang, now))}\n`)
  }
  writeFileSync(join(profile, 'windows.json'), JSON.stringify(demo.demoWindows(bounds)))
  return profile
}

// ---------- the local server ----------

/** The body of a request of the page of the site (a vote: a few dozen bytes), up to `limit` bytes; null beyond. */
function readBody(request, limit = 64 * 1024) {
  return new Promise((done, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    request.on('end', () => done(size <= limit ? Buffer.concat(chunks).toString('utf8') : null))
    request.on('error', reject)
  })
}

/**
 * A request for the site's own address (capture.ts SITE_HOST): the stand-in of its API (community.ts), or a file of the checkout of the site that
 * `community.siteFile` allows (the two Community pages and their assets). Nothing else of the checkout is ever served.
 */
async function serveSite(request, response, siteRoot, votes, say) {
  const method = (request.method ?? 'GET').toUpperCase()
  const url = request.url ?? '/'
  const send = (status, headers, body) => {
    response.writeHead(status, headers)
    response.end(method === 'HEAD' ? undefined : body)
  }
  if (url.startsWith('/api/')) {
    const body = method === 'POST' || method === 'DELETE' ? await readBody(request) : ''
    if (body === null) return send(413, { 'Content-Type': 'text/plain; charset=utf-8' }, '')
    const answer = community.communityApi(votes, { method, url, referer: request.headers.referer, signedIn: /^Bearer \S+$/.test(request.headers.authorization ?? ''), body })
    if (answer) return send(answer.status, answer.headers, answer.body)
    return send(404, { 'Content-Type': 'text/plain; charset=utf-8' }, '')
  }
  if (method !== 'GET' && method !== 'HEAD') return send(405, { ...community.SITE_HEADERS }, '')
  const file = siteRoot === null ? null : community.siteFile(url)
  if (file === null) return send(404, { ...community.SITE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }, '')
  let data
  try {
    data = readFileSync(join(siteRoot, file.file))
  } catch (error) {
    say(`site : ${file.file} non lu (${error.code ?? error.message})`)
    return send(404, { ...community.SITE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }, '')
  }
  send(200, { ...community.SITE_HEADERS, 'Content-Type': file.contentType }, data)
}

/** The local server of the run: the demonstration pages under `.example`, the site under its own address. `votes`: the stand-in's, emptied by each scene. */
async function startServer(credentials, siteRoot) {
  const site = demo.demoSite()
  const votes = { voted: new Set() }
  let refused = 0
  const said = new Set()
  const sayOnce = (message) => {
    if (!said.has(message)) progress(message)
    said.add(message)
  }
  const server = createServer(credentials, (request, response) => {
    const host = (request.headers.host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
    if (host === capture.SITE_HOST) {
      serveSite(request, response, siteRoot, votes, sayOnce).catch((error) => {
        sayOnce(`site : la requête ${request.method} ${request.url} a échoué (${error.message})`)
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, pages.PAGE_HEADERS)
      response.end()
      return
    }
    const answer = pages.respond(site, request.headers.host ?? '', request.url ?? '/')
    response.writeHead(answer.status, answer.headers)
    response.end(request.method === 'HEAD' ? undefined : answer.body)
  })
  // A connection that does not finish its handshake (a probe, a closed tab) is no page of ours: counted, and said once.
  server.on('tlsClientError', (error) => {
    if (refused++ === 0) progress(`serveur local : une connexion sans poignée de main TLS a été refusée (${error.code ?? error.message})`)
  })
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => done())
  })
  return { server, port: server.address().port, votes }
}

// ---------- the two ways to start and drive Lucium ----------

/**
 * The environment of the application: the made-up home folder, none of the variables of the development (the tests' switches, a dev server),
 * and the script's own (capture.ts APP_ENVIRONMENT: no application's name read for the import sheet).
 */
function appEnvironment(home) {
  const env = { ...process.env, HOME: home }
  for (const name of Object.keys(env)) if (name.startsWith('LUCIUM_') || name.startsWith('ELECTRON_') || name === 'NODE_OPTIONS') delete env[name]
  return { ...env, ...capture.APP_ENVIRONMENT }
}

/** What the shots that need the main process say with a packaged application: it lets no one reach it (fuses). */
const NEEDS_DEVELOPMENT = 'possible seulement avec la build de développement (l’application empaquetée ne laisse pas atteindre son processus principal)'

/** Keeps what the application writes in a file of the run (the progress lines stay readable), and its last lines for an error message. */
function logTo(file) {
  const tail = []
  const write = (chunk) => {
    const text = chunk.toString()
    try {
      writeFileSync(file, text, { flag: 'a' })
    } catch (error) {
      progress(`journal de l’application non écrit (${error.message})`)
    }
    for (const line of text.split('\n')) if (line.trim()) tail.push(line)
    if (tail.length > 30) tail.splice(0, tail.length - 30)
  }
  return { write, tail: () => tail.join('\n') }
}

/** The page of the window a shot captures (its own web contents, not a view of it). A private window's page carries a query; the main one's none. */
const isWindowPage = (kind, url) =>
  kind === 'main'
    ? url.endsWith('/index.html')
    : kind === 'settings'
      ? url.includes('/settings.html')
      : kind === 'taskmanager'
        ? url.includes('/taskmanager.html')
        : kind === 'private'
          ? url.includes('/index.html?')
          : url.includes('/littlearc.html') && !/[?&](picker|tray|bar)=1/.test(url)

async function launchDevelopment({ profile, home, lang, port, log }) {
  const { _electron } = await import('@playwright/test')
  const args = ['.', ...capture.launchSwitches({ userDataDir: profile, serverPort: port, lang, devtools: false })]
  // `colorScheme: null`: Playwright would otherwise make every page see the light scheme, whatever Apparence says.
  const app = await _electron.launch({ args, cwd: root, env: appEnvironment(home), colorScheme: null, timeout: 60_000 })
  const child = app.process()
  child.stdout?.on('data', log.write)
  child.stderr?.on('data', log.write)
  // Playwright sends the text of a function to the main process, where it closes over nothing: the lookup of a window by the page it shows (the
  // rule of isWindowPage) is put there once, and each call below uses it.
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__siteCapturesWindow = (kind) =>
      BrowserWindow.getAllWindows().find((w) => {
        if (w.isDestroyed() || !w.isVisible()) return false
        const url = w.webContents.getURL()
        return kind === 'main'
          ? url.endsWith('/index.html')
          : kind === 'settings'
            ? url.includes('/settings.html')
            : kind === 'taskmanager'
              ? url.includes('/taskmanager.html')
              : kind === 'private'
                ? url.includes('/index.html?')
                : url.includes('/littlearc.html') && !/[?&](picker|tray|bar)=1/.test(url)
      }) ?? null
  })
  // No native box may open during a run (nobody answers it, and it would hold the main process): the error boxes of the application are kept
  // here and said by the scene that caused them. The file chooser keeps the system's until a scene answers it (`answerFileChooser`).
  await app.evaluate(({ dialog }) => {
    globalThis.__siteCapturesErrors = []
    dialog.showErrorBox = (title, content) => void globalThis.__siteCapturesErrors.push(`${title} — ${content}`)
  })
  return {
    kind: 'development',
    pid: child.pid,
    alive: () => child.exitCode === null && child.signalCode === null,
    pages: () => app.windows(),
    windowId: async (kind) => {
      // `window:<CGWindowID>:0` on macOS (electron.d.ts, BrowserWindow.getMediaSourceId).
      const id = await app.evaluate((_electron, wanted) => globalThis.__siteCapturesWindow(wanted)?.getMediaSourceId() ?? null, kind)
      const parsed = capture.parseMediaSourceId(id ?? '')
      if (parsed === null) throw new Error(`la fenêtre ${kind} n’a pas d’identifiant de source (${id})`)
      return parsed
    },
    bounds: (kind) => app.evaluate((_electron, wanted) => globalThis.__siteCapturesWindow(wanted)?.getBounds() ?? null, kind),
    /**
     * Where the page at `url` is drawn in the window of `kind`, in points from the top left corner of the window (its frame included), and its zoom:
     * the window's own page, or a view of it (the overlay, a tab), found by its address among the views of the window. Null when none shows it.
     */
    viewFrame: (kind, url) =>
      app.evaluate((_electron, [wanted, address]) => {
        const win = globalThis.__siteCapturesWindow(wanted)
        if (!win) return null
        const outer = win.getBounds()
        const content = win.getContentBounds()
        const same = (contents) => Boolean(contents) && !contents.isDestroyed() && contents.getURL() === address
        if (same(win.webContents)) return { x: content.x - outer.x, y: content.y - outer.y, width: content.width, height: content.height, zoom: win.webContents.getZoomFactor() }
        // A view put away (a tab not on screen, the overlay closed) is hidden or has no size: it is not what the window shows.
        const walk = (view, x, y) => {
          for (const child of view.children ?? []) {
            const box = child.getBounds()
            if ((typeof child.getVisible === 'function' && !child.getVisible()) || box.width === 0 || box.height === 0) continue
            if (same(child.webContents)) return { x: x + box.x, y: y + box.y, width: box.width, height: box.height, zoom: child.webContents.getZoomFactor() }
            const inner = walk(child, x + box.x, y + box.y)
            if (inner) return inner
          }
          return null
        }
        return walk(win.contentView, content.x - outer.x, content.y - outer.y)
      }, [kind, url]),
    /** Closes the window of `kind` (a private window, the task manager) the way its close button does. */
    closeWindow: (kind) => app.evaluate((_electron, wanted) => globalThis.__siteCapturesWindow(wanted)?.close(), kind),
    setBounds: (kind, _page, rect) => app.evaluate((_electron, [wanted, bounds]) => globalThis.__siteCapturesWindow(wanted)?.setBounds(bounds), [kind, rect]),
    // Only a window that does not have the focus is given it: the window that has it keeps the element that has it (the field of the command bar).
    focus: (kind) =>
      app.evaluate(({ app: electronApp }, wanted) => {
        const win = globalThis.__siteCapturesWindow(wanted)
        if (win?.isFocused()) return
        electronApp.focus({ steal: true })
        win?.show()
        win?.focus()
      }, kind),
    display: (kind) =>
      app.evaluate(({ screen }, wanted) => {
        const win = globalThis.__siteCapturesWindow(wanted)
        const display = win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay()
        return { workArea: display.workArea, scale: display.scaleFactor }
      }, kind),
    locale: () => app.evaluate(({ app: electronApp }) => electronApp.getLocale()),
    /**
     * The next file chooser the application opens is answered with `path` at once, without showing anything (the way the import sheet and
     * « Charger une extension non empaquetée » are given a file of the run); the one after it is the system's again.
     */
    answerFileChooser: (path) =>
      app.evaluate(({ dialog }, chosen) => {
        const original = dialog.showOpenDialog
        globalThis.__siteCapturesChooser = { asked: false }
        dialog.showOpenDialog = async () => {
          dialog.showOpenDialog = original
          globalThis.__siteCapturesChooser.asked = true
          return { canceled: false, filePaths: [chosen] }
        }
      }, path),
    /** Whether the answered file chooser was opened, and the error boxes the application meant to show since the last call. */
    mainProcessNews: () =>
      app.evaluate(() => {
        const errors = globalThis.__siteCapturesErrors.splice(0)
        return { asked: globalThis.__siteCapturesChooser?.asked === true, errors }
      }),
    /** Clicks the item of the menu bar labelled one of `labels` (the item has no shortcut by default): false when there is none, or it is off. */
    clickMenu: (labels) =>
      app.evaluate(({ Menu }, wanted) => {
        const find = (items) => {
          for (const item of items) {
            if (wanted.includes(item.label)) return item
            const inner = item.submenu ? find(item.submenu.items) : null
            if (inner) return inner
          }
          return null
        }
        const item = find(Menu.getApplicationMenu()?.items ?? [])
        if (!item || !item.enabled) return false
        item.click()
        return true
      }, labels),
    quit: async () => {
      const quitting = app.close().catch((error) => progress(`l’application ne s’est pas fermée proprement : ${error.message.split('\n')[0]}`))
      const late = await Promise.race([quitting.then(() => false), sleep(QUIT_LIMIT_MS).then(() => true)])
      if (late && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }
}

/** The executable of a .app: Contents/MacOS/<CFBundleExecutable>. */
function executableOf(appPath) {
  const plist = join(appPath, 'Contents/Info.plist')
  if (!existsSync(plist)) fail(`--app : ${appPath} n’est pas une application (Contents/Info.plist manque)`)
  const name = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim()
  const executable = join(appPath, 'Contents/MacOS', name)
  if (!existsSync(executable)) fail(`--app : l’exécutable ${executable} manque`)
  return executable
}

async function launchPackaged(executable, { profile, home, lang, port, log }) {
  const args = capture.launchSwitches({ userDataDir: profile, serverPort: port, lang, devtools: true })
  const child = spawn(executable, args, { env: appEnvironment(home), stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', log.write)
  const endpoint = await new Promise((done, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error(`l’application n’a pas ouvert le protocole DevTools en 60 s\n${log.tail()}`)), 60_000)
    child.stderr.on('data', (chunk) => {
      log.write(chunk)
      buffer += chunk.toString()
      const found = capture.devToolsEndpoint(buffer)
      if (found) {
        clearTimeout(timer)
        done(found)
      }
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      const refused = /\[launch\] refused:/.test(log.tail())
      reject(new Error(`l’application s’est arrêtée au démarrage (${code ?? signal})${refused ? ' : à partir de la 1.0, l’application empaquetée refuse les commutateurs par lesquels --app la pilote ; faites les prises avec la build de développement (sans --app)' : ''}\n${log.tail()}`))
    })
  })
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 30_000 })
  const context = browser.contexts()[0]
  // Playwright makes every page it attaches to see the light scheme unless told otherwise: each one is given back the scheme of the application.
  const neutral = (page) => page.emulateMedia({ colorScheme: null }).catch((error) => progress(`schéma de couleurs d’une page non rendu (${error.message.split('\n')[0]})`))
  for (const page of context.pages()) await neutral(page)
  context.on('page', (page) => void neutral(page))
  const pageBounds = (page) => page.evaluate(() => ({ x: screenX, y: screenY, width: outerWidth, height: outerHeight }))
  const exited = () => child.exitCode !== null || child.signalCode !== null
  return {
    kind: 'packaged',
    pid: child.pid,
    alive: () => !exited(),
    pages: () => context.pages(),
    windowId: async (kind, page) => {
      const wanted = await pageBounds(page)
      const id = capture.pickWindow(systemWindows(child.pid), wanted)
      if (id === null) throw new Error(`fenêtre ${kind} introuvable dans la liste de macOS (attendue en ${JSON.stringify(wanted)})`)
      return id
    },
    bounds: (_kind, page) => pageBounds(page),
    // window.moveTo and window.resizeTo of a window's own page move and size the window (Electron's `content-bounds-updated`, which the application leaves alone).
    setBounds: (_kind, page, rect) => page.evaluate((r) => {
      moveTo(r.x, r.y)
      resizeTo(r.width, r.height)
    }, rect),
    // The other windows take the focus when they open; the main one is brought forward before its scene, never while a panel has the keyboard.
    focus: async (_kind, page) => {
      if (await page.evaluate(() => document.hasFocus())) return
      await page.bringToFront().catch((error) => progress(`la fenêtre n’a pas pu être mise au premier plan (${error.message.split('\n')[0]})`))
    },
    display: async (_kind, page) => page.evaluate(() => ({ workArea: { x: screen.availLeft, y: screen.availTop, width: screen.availWidth, height: screen.availHeight }, scale: devicePixelRatio })),
    locale: (page) => page.evaluate(() => navigator.language),
    // The shots that need these are left out of the plan with --app (shots.ts `developmentOnly`): reaching here is a mistake of the list.
    answerFileChooser: async () => {
      throw new Error(`sélecteur de fichiers : ${NEEDS_DEVELOPMENT}`)
    },
    mainProcessNews: async () => ({ asked: false, errors: [] }),
    clickMenu: async () => {
      throw new Error(`menu : ${NEEDS_DEVELOPMENT}`)
    },
    viewFrame: async () => {
      throw new Error(`cadre d’une vue : ${NEEDS_DEVELOPMENT}`)
    },
    closeWindow: async () => {
      throw new Error(`fermeture d’une fenêtre : ${NEEDS_DEVELOPMENT}`)
    },
    quit: async () => {
      await browser.close().catch((error) => progress(`déconnexion du protocole DevTools : ${error.message.split('\n')[0]}`))
      if (!exited()) child.kill('SIGTERM')
      const done = await Promise.race([new Promise((resolveExit) => child.once('exit', () => resolveExit(true))), sleep(QUIT_LIMIT_MS).then(() => false)])
      if (!done && !exited()) child.kill('SIGKILL')
    }
  }
}

// ---------- driving the interface (the bridge `window.lucium`, as tests/e2e/helpers.ts does) ----------

async function until(check, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    try {
      if (await check()) return
    } catch (error) {
      last = error
    }
    if (Date.now() > deadline) throw new Error(`délai dépassé : ${what}${last ? ` (${last.message.split('\n')[0]})` : ''}`)
    await sleep(150)
  }
}

/** The first page that passes `match` and was not in `before`, once it exists. */
async function waitPage(run, match, what, { before = new Set(), timeoutMs = 20_000 } = {}) {
  let found
  await until(() => (found = run.pages().find((page) => !before.has(page) && !page.isClosed() && match(page.url()))) !== undefined, what, timeoutMs)
  return found
}

const bridge = (page, method, ...args) => page.evaluate(([name, values]) => globalThis.lucium[name](...values), [method, args])
const dispatch = (page, action) => bridge(page, 'dispatch', action)
const snapshotOf = (page) => bridge(page, 'getSnapshot')

/** The lines of the command bar, with the title of the group each is listed under (tests/e2e/helpers.ts `barRows`). */
const barRows = (overlay) =>
  overlay.evaluate(() => {
    const rows = []
    let group = ''
    for (const li of document.querySelectorAll('.results li')) {
      if (li.classList.contains('group-title')) group = li.textContent ?? ''
      else if (li.getAttribute('role') === 'option') rows.push({ label: li.querySelector('.label')?.textContent ?? '', group })
    }
    return rows
  })
const OPEN_TABS_GROUP = /^(Onglets ouverts|Open tabs)$/

/**
 * The sheet of the news with every point of the version listed (« Voir tout », as a person does), its list scrolled to bring the point titled
 * `title` to its top (shots.ts `newsFrom`). A version without that point fails the scene, with the titles it has: the scenario must choose again.
 */
async function showNewsFrom(overlay, title) {
  const { list, title: pointTitle, all } = labels.NEWS_SHEET
  const more = overlay.locator(all)
  if ((await more.count()) > 0) {
    await more.first().click()
    await until(async () => (await more.count()) === 0, 'tous les points de la feuille des nouveautés')
  }
  const titles = await overlay.locator(`${list} > li > ${pointTitle}`).allTextContents()
  const index = titles.findIndex((text) => labels.sameText(text, title))
  if (index < 0) throw new Error(`la feuille des nouveautés n’a pas de point « ${title} » ; elle a ${titles.length} points, dont : ${titles.slice(0, 12).join(' · ')}`)
  const scrolled = await overlay.evaluate(({ list, index }) => {
    const ul = document.querySelector(list)
    const li = ul?.children[index]
    if (!ul || !li) return false
    ul.scrollTop += li.getBoundingClientRect().top - ul.getBoundingClientRect().top - parseFloat(getComputedStyle(ul).paddingTop)
    return true
  }, { list, index })
  if (!scrolled) throw new Error(`le point « ${title} » de la feuille des nouveautés a disparu avant d’être montré`)
  await overlay.mouse.move(1, 1)
}

async function pageLoaded(run, url, before) {
  const page = await waitPage(run, (address) => address === url, `la page ${url}`, { before })
  await page.waitForLoadState('load')
  await page.evaluate(() => document.fonts?.ready.then(() => true))
  return page
}

/** Puts a window at its size in the middle of the screen of the shots (the mini window in its corner, where it opens). */
async function placeWindow(run, kind, page, size, screen, warnings) {
  const area = screen.workArea
  const rect = kind === 'little' ? { x: area.x + area.width - size.width - 20, y: area.y + 20, ...size } : capture.centered(area, size)
  const current = await run.bounds(kind, page)
  if (!current || current.x !== rect.x || current.y !== rect.y || current.width !== rect.width || current.height !== rect.height) {
    await run.setBounds(kind, page, rect)
    await until(async () => {
      const now = await run.bounds(kind, page)
      return now && now.width === rect.width && now.height === rect.height
    }, `la fenêtre ${kind} à ${rect.width}×${rect.height}`, 4000).catch((error) => warnings.push(`${kind} : ${error.message}`))
  }
  return (await run.bounds(kind, page)) ?? rect
}

/** Gives the session the language and the theme, the application's own settings, when the profile did not already hold them. */
async function applyLook(shell, session) {
  const wanted = { interfaceTranslated: true, language: session.lang, interfaceAppearance: session.theme, warnBeforeQuitting: false }
  const settings = (await snapshotOf(shell)).state.settings
  if (Object.entries(wanted).some(([key, value]) => settings[key] !== value)) await dispatch(shell, { type: 'settings/update', patch: wanted })
  await until(async () => {
    const now = (await snapshotOf(shell)).state.settings
    return Object.entries(wanted).every(([key, value]) => now[key] === value)
  }, 'la langue et le thème dans les réglages')
}

/** The text a person sees in a page (what is hidden is not in it), or '' when the page is gone. */
const visibleText = (page) => page.evaluate(() => document.body?.innerText ?? '').catch((error) => (page.isClosed() ? '' : Promise.reject(error)))

/** Refuses the shot when one of these pages shows another browser's name (names.ts): the shots of the import name none. */
async function assertNoBrowserName(shot, pagesToRead) {
  const found = names.browserNamesIn((await Promise.all(pagesToRead.map(visibleText))).join('\n'))
  if (found.length > 0) throw new Error(`un nom d’autre navigateur est à l’écran (${found.join(', ')}) : la prise est refusée`)
}

/** The overlay page (overlay.html), where the sheets and the panels of the main window are drawn. */
const overlayPage = (run) => waitPage(run, (url) => url.endsWith('/overlay.html'), 'la couche des panneaux')

/** The error boxes the application meant to show (development build): a scene fails with them rather than leave them unsaid. */
async function failOnErrorBoxes(run, what) {
  const { errors } = await run.mainProcessNews()
  if (errors.length > 0) throw new Error(`${what} : ${errors.join(' ; ')}`)
}

/** The import sheet with the bookmarks file of the demonstration, previewed: the file chooser is answered with it. Answers the overlay and the sheet. */
async function previewBookmarks(run, ctx) {
  const { shell, session } = ctx
  const lang = session.lang
  await bridge(shell, 'openOverlay', { panel: 'import' })
  const overlay = await overlayPage(run)
  const sheet = overlay.locator('.card.import')
  const row = (label) => sheet.locator('.import-row').filter({ has: overlay.locator('strong', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })
  const file = row(labels.IMPORT_ROWS.html[lang])
  await file.waitFor({ timeout: 20_000 })
  await file.click()
  await sheet.locator('.import-category').first().waitFor()
  await run.answerFileChooser(demo.bookmarksPath(ctx.home, lang))
  await sheet.locator('.row.end .button.primary').click()
  await sheet.locator('.import-report.ok').waitFor({ timeout: 30_000 })
  await failOnErrorBoxes(run, 'import')
  if (!(await run.mainProcessNews()).asked) throw new Error('le sélecteur de fichiers de l’import n’a pas été ouvert : l’aperçu ne vient pas du fichier de démonstration')
  // « Autre navigateur » tells which file to pick by the names of the engines and of a browser: its row leaves the image (it stays in the sheet).
  await overlay.evaluate((label) => {
    for (const strong of document.querySelectorAll('.card.import .import-row strong')) if (strong.textContent === label) strong.closest('li')?.style.setProperty('display', 'none')
  }, labels.IMPORT_ROWS.other[lang])
  return { overlay, sheet }
}

/**
 * An extension of the demonstration (features.ts `demoExtension`), loaded the way a person does it (« Charger une extension non empaquetée », the
 * file chooser answered with its folder) and switched off once the shot is taken: the scenes that follow see the demonstration as it was. Answers
 * what the application lists of it.
 */
async function loadDemoExtension(run, ctx, kind, cleanups) {
  return loadExtensionFolder(run, ctx, demo.DEMO_EXTENSIONS[kind].name[ctx.session.lang], ctx.demoExtensions[kind], cleanups)
}

/** The extension in `folder`, which the application lists under `name`: loaded the way a person does it, and switched off again by the cleanups. */
async function loadExtensionFolder(run, ctx, name, folder, cleanups) {
  const { shell } = ctx
  await run.answerFileChooser(folder)
  await bridge(shell, 'loadExtension')
  await failOnErrorBoxes(run, `extension « ${name} »`)
  if (!(await run.mainProcessNews()).asked) throw new Error(`le sélecteur de dossier de l’extension « ${name} » n’a pas été ouvert`)
  let info
  await until(async () => (info = (await snapshotOf(shell)).extensions.find((e) => e.name === name && e.enabled)) !== undefined, `l’extension « ${name} » chargée`, 15_000)
  cleanups.push(() => dispatch(shell, { type: 'extension/set-enabled', profileId: info.profileId, extensionId: info.id, enabled: false }))
  return info
}

/**
 * The group of `scene.tabGroup`, made by the extension `groups` as an extension does it (`chrome.tabs.group`, `chrome.tabGroups.update`), asked
 * from the page of the scene's tab; then its folder in the sidebar, holding its tabs. The group goes with the switch put back after the shot.
 */
async function makeTabGroup(run, ctx, scene, tabPage, info) {
  const { shell, session } = ctx
  const lang = session.lang
  const title = scene.tabGroup.title[lang]
  const urls = scene.tabGroup.tabs.map((key) => demo.tabPage(key, lang).url)
  // The extension finds only the tabs whose page is loaded: each tab of the group is shown once, then the tab of the scene again.
  for (const key of scene.tabGroup.tabs.filter((key) => key !== scene.tab)) {
    await dispatch(shell, { type: 'tab/select', id: demo.tabId(scene.space, key) })
    await pageLoaded(run, demo.tabPage(key, lang).url)
  }
  await dispatch(shell, { type: 'tab/select', id: demo.tabId(scene.space, scene.tab) })
  await until(async () => (await snapshotOf(shell)).state.activeTabBySpace[demo.spaceId(scene.space)] === demo.tabId(scene.space, scene.tab), `l’onglet ${scene.tab} de nouveau à l’écran`)
  const ask = () =>
    tabPage.evaluate(
      ([id, message]) =>
        new Promise((resolve) => {
          if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return resolve({ ok: false, offered: false, error: 'chrome.runtime is not offered to the page' })
          chrome.runtime.sendMessage(id, message, (answer) => resolve(answer ?? { ok: false, error: chrome.runtime.lastError?.message ?? 'no answer' }))
        }),
      [info.id, { kind: 'group', urls, title }]
    )
  let reply = await ask()
  if (reply?.offered === false) {
    // The page was loaded before the extension that answers it: the engine offers it the messages of extensions from its next load.
    await tabPage.reload()
    await tabPage.waitForLoadState('load')
    reply = await ask()
  }
  // A tab just loaded reaches the extensions a moment later.
  for (let round = 0; round < 10 && reply?.ok !== true && String(reply?.error).startsWith('no tab at'); round++) {
    await sleep(500)
    reply = await ask()
  }
  if (!reply?.ok) throw new Error(`l’extension n’a pas fait le groupe « ${title} » : ${reply?.error ?? 'pas de réponse'}`)
  const ids = scene.tabGroup.tabs.map((key) => demo.tabId(scene.space, key))
  await until(async () => {
    const { state } = await snapshotOf(shell)
    const folder = state.folders.find((f) => f.name === title)
    return folder !== undefined && ids.every((id) => state.tabs.some((t) => t.id === id && t.folderId === folder.id))
  }, `le dossier « ${title} » du groupe, avec ses ${ids.length} onglets`)
  await shell.mouse.move(1, 1)
}

/**
 * Puts the state the shot needs and opens what it shows; answers the page of the window to capture and, for a shot that must name no other
 * browser, the pages whose text is read first. What undoes the scene goes into `cleanups` as soon as it is done: it runs even when the scene fails.
 */
async function setScene(run, ctx, shot, cleanups) {
  const { shell, session } = ctx
  const lang = session.lang
  const scene = shot.scene
  const before = new Set(run.pages())

  if (scene.firstLaunch) {
    await run.focus('main', shell)
    const overlay = await overlayPage(run)
    await overlay.locator('.card.first-launch').waitFor({ timeout: 20_000 })
    if (scene.freshSpaceName) {
      const space = (await snapshotOf(shell)).state.spaces[0]
      if (space && space.name !== scene.freshSpaceName[lang]) await dispatch(shell, { type: 'space/update', id: space.id, patch: { name: scene.freshSpaceName[lang] } })
    }
    await until(async () => (await overlay.locator('.first-launch-source').count()) >= 2, 'les navigateurs trouvés par la feuille du premier lancement')
    // The browser found (the one of macOS, which the guide always lists), chosen: what it would bring is listed. Nothing is read before the last step.
    await overlay.locator('.first-launch-source').first().click()
    await overlay.locator('.first-launch-check').first().waitFor()
    await overlay.mouse.move(1, 1)
    return { page: shell, readNames: [overlay, shell] }
  }

  // ---- what the previous shot may have left ----
  await bridge(shell, 'closeOverlay')
  if (shot.window === 'main') await run.focus('main', shell)
  // The pointer of the page (Playwright's) stays where the last click left it: over the gauge of the resources, it shows its tooltip in the
  // shots that follow (« Mémoire du navigateur : … »). It goes to the corner of the window, over nothing of the page.
  await shell.mouse.move(1, 1)
  let left = await snapshotOf(shell)
  if (left.peek) await bridge(shell, 'peekAction', 'close')
  // `split/remove` takes one pane out of its split view, which goes away under two panes: again until none is left.
  for (let round = 0; left.state.splits.length > 0 && round < 12; round++) {
    await dispatch(shell, { type: 'split/remove', tabId: left.state.splits[0].tabIds[0] })
    left = await snapshotOf(shell)
  }

  // ---- the space and its tab ----
  const spaceId = demo.spaceId(scene.space)
  const tabId = demo.tabId(scene.space, scene.tab)
  const split = scene.split ?? []
  await dispatch(shell, { type: 'space/select', id: spaceId })
  await dispatch(shell, { type: 'tab/select', id: tabId })
  // Each pane joins the split view of `tab`, at its end.
  for (const other of split) await dispatch(shell, { type: 'split/create', tabId, withTabId: demo.tabId(scene.space, other) })
  await until(async () => {
    const { state } = await snapshotOf(shell)
    return state.activeSpaceId === spaceId && state.activeTabBySpace[spaceId] === tabId && (split.length === 0 || state.splits.some((s) => s.tabIds.includes(tabId) && s.tabIds.length === split.length + 1))
  }, `l’espace ${scene.space} et l’onglet ${scene.tab}${split.length > 0 ? ` en vue scindée à ${split.length + 1} volets` : ''}`)
  const tabPage = await pageLoaded(run, demo.tabPage(scene.tab, lang).url)
  for (const other of split) await pageLoaded(run, demo.tabPage(other, lang).url)

  // ---- the captures of the features page (features.ts): settings, lists, panels, menus ----
  if (scene.patch) {
    const before = (await snapshotOf(shell)).state.settings
    const previous = Object.fromEntries(Object.keys(scene.patch).map((key) => [key, before[key]]))
    await dispatch(shell, { type: 'settings/update', patch: scene.patch })
    // Put back once everything else is closed (the cleanups run backwards): the window looks as before for the next scene.
    cleanups.push(() => dispatch(shell, { type: 'settings/update', patch: previous }))
    await until(async () => {
      const now = (await snapshotOf(shell)).state.settings
      return Object.entries(scene.patch).every(([key, value]) => JSON.stringify(now[key]) === JSON.stringify(value))
    }, `les réglages ${Object.keys(scene.patch).join(', ')}`)
  }

  if (scene.demoExtension) {
    const info = await loadDemoExtension(run, ctx, scene.demoExtension, cleanups)
    if (scene.tabGroup) await makeTabGroup(run, ctx, scene, tabPage, info)
  }

  if (scene.readLater) {
    for (const key of scene.readLater) await dispatch(shell, { type: 'readlater/add', tabId: demo.tabId(scene.space, key) })
    cleanups.push(() => dispatch(shell, { type: 'readlater/clear' }))
    await until(async () => ((await snapshotOf(shell)).state.readLater ?? []).length >= scene.readLater.length, 'les pages de « Lire plus tard »')
  }

  if (scene.bookmarks) {
    const known = new Set(((await snapshotOf(shell)).state.bookmarks ?? []).map((b) => b.id))
    for (const mark of scene.bookmarks) await dispatch(shell, { type: 'bookmark/add', tabId: demo.tabId(scene.space, mark.tab), tags: [...mark.tags[lang]] })
    await until(async () => ((await snapshotOf(shell)).state.bookmarks ?? []).filter((b) => !known.has(b.id)).length >= scene.bookmarks.length, 'les signets de la bibliothèque')
    cleanups.push(async () => {
      for (const mark of ((await snapshotOf(shell)).state.bookmarks ?? []).filter((b) => !known.has(b.id))) await dispatch(shell, { type: 'bookmark/remove', id: mark.id })
    })
  }

  if (scene.sessions) {
    const known = new Set((await snapshotOf(shell)).state.sessions.map((s) => s.id))
    for (const session of scene.sessions) await dispatch(shell, { type: 'session/save', name: session.name[lang], tabIds: session.tabs.map((key) => demo.tabId(scene.space, key)) })
    await until(async () => (await snapshotOf(shell)).state.sessions.filter((s) => !known.has(s.id)).length >= scene.sessions.length, 'les sessions enregistrées')
    cleanups.push(async () => {
      for (const session of (await snapshotOf(shell)).state.sessions.filter((s) => !known.has(s.id))) await dispatch(shell, { type: 'session/delete', id: session.id })
    })
  }

  if (scene.commandBar) {
    const text = scene.commandBar.text[lang]
    await bridge(shell, 'openOverlay', { panel: 'commandbar', mode: 'new', initial: '' })
    const overlay = await overlayPage(run)
    await overlay.locator('.palette .palette-input').waitFor()
    await until(() => overlay.evaluate(() => document.activeElement?.classList.contains('palette-input') === true), 'le champ de la barre de commandes a le focus')
    await overlay.keyboard.type(text, { delay: 40 })
    // The field may complete the word inline (« weather » → an address, the added part selected): what was typed is what precedes the selection.
    await until(() => overlay.evaluate((typed) => {
      const field = document.querySelector('.palette-input')
      return field !== null && (field.value === typed || field.value.slice(0, field.selectionStart ?? 0) === typed)
    }, text), `« ${text} » dans la barre de commandes`)
    if (scene.commandBar.expect === 'calc') await until(async () => (await barRows(overlay))[0]?.label.startsWith('=') === true, 'le résultat du calcul en première ligne')
    else if (scene.commandBar.expect === 'extension') {
      // The line that hands the words after the keyword to the extension, first and chosen: « Glossaire : « sérendipité » ».
      const name = demo.DEMO_EXTENSIONS[scene.demoExtension].name[lang]
      const word = text.slice(text.indexOf(' ') + 1)
      const first = async () => {
        const row = (await barRows(overlay))[0]
        return row !== undefined && row.label.startsWith(name) && row.label.includes(word)
      }
      await until(first, `la ligne de l’extension « ${name} » en tête de la barre de commandes`)
      const selected = await overlay.evaluate(() => document.querySelector('.results li[role="option"][aria-selected="true"] .label')?.textContent ?? '')
      if (!selected.startsWith(name)) throw new Error(`la ligne choisie de la barre de commandes est « ${selected} », pas celle de l’extension « ${name} »`)
    }
    else if (scene.commandBar.expect === 'rows') {
      // The first line is the web search, whose preview names the search engine: the first command is chosen with the arrows, as a person does.
      const commands = labels.COMMAND_GROUP[lang]
      await until(async () => (await barRows(overlay)).some((row) => row.group === commands), `les commandes que « ${text} » trouve`)
      const chosenGroup = () =>
        overlay.evaluate(() => {
          let group = ''
          for (const li of document.querySelectorAll('.results li')) {
            if (li.classList.contains('group-title')) group = li.textContent ?? ''
            else if (li.getAttribute('aria-selected') === 'true') return group
          }
          return ''
        })
      // The line labelled `pick` (with the spaces French typography gives it on screen), or else the first command.
      const pick = scene.commandBar.pick?.[lang]
      const chosen = async () => {
        const group = await chosenGroup()
        const label = await overlay.evaluate(() => document.querySelector('.results li[role="option"][aria-selected="true"] .label')?.textContent ?? '')
        return pick ? labels.sameText(label, pick) : group === commands
      }
      for (let step = 0; step < 12 && !(await chosen()); step++) await overlay.keyboard.press('ArrowDown')
      if (!(await chosen())) throw new Error(`la ligne « ${pick ?? commands} » n’a pas pu être choisie dans la barre de commandes`)
    }
    else {
      const title = demo.pageDef(scene.commandBar.openTab).title[lang]
      await until(async () => (await barRows(overlay)).some((row) => OPEN_TABS_GROUP.test(row.group) && row.label.includes(title)), `l’onglet ouvert « ${title} »`)
      // The line of the tab is chosen with the arrows, as a person does: the preview shows the tab, not the first line (a search, whose preview
      // names the search engine, or an address).
      const chosen = () => overlay.evaluate(() => document.querySelector('.results li[role="option"][aria-selected="true"] .label')?.textContent ?? '')
      for (let step = 0; step < 8 && !(await chosen()).includes(title); step++) await overlay.keyboard.press('ArrowDown')
      if (!(await chosen()).includes(title)) ctx.warnings.push(`${shot.id} : la ligne de l’onglet « ${title} » n’a pas pu être choisie ; l’aperçu montre une autre ligne`)
    }
    cleanups.push(() => bridge(shell, 'closeOverlay'))
  }

  if (scene.peek) {
    const target = (await tabPage.locator(scene.peek.link).getAttribute('href')) ?? ''
    const opened = new Set(run.pages())
    await tabPage.click(scene.peek.link, { modifiers: ['Shift'] })
    await until(async () => (await snapshotOf(shell)).peek !== null, 'le Coup d’œil ouvert')
    await pageLoaded(run, target, opened)
    // The pointer of the page (Playwright's, not the system's) leaves the link: no underline, no address of a hovered link.
    await tabPage.mouse.move(1, 1)
    cleanups.push(() => bridge(shell, 'peekAction', 'close'))
  }

  if (scene.resourcePanel) {
    const gauge = shell.locator('.rg-gauge')
    await gauge.waitFor({ timeout: 20_000 })
    await gauge.click()
    await shell.locator('.rp-head').waitFor()
    await until(async () => (await shell.locator('.rp-rows li').count()) > 0, 'les onglets du panneau des ressources', 20_000).catch((error) => ctx.warnings.push(`${shot.id} : ${error.message}`))
    if (scene.resourcePanel === 'asleep') {
      // The button waits for a first reading of the tabs; the gauge follows the sleep at the next one (every 2 s).
      const sleepAll = shell.locator('.rp-sleep-all:not(:disabled)')
      await sleepAll.waitFor({ timeout: 20_000 })
      const memory = await shell.locator('.rp-bar').getAttribute('aria-valuenow')
      await sleepAll.click()
      await shell.locator('.rp-notice').waitFor({ timeout: 10_000 })
      await until(async () => (await shell.locator('.rp-bar').getAttribute('aria-valuenow')) !== memory, 'la jauge de mémoire après la mise en veille', 10_000).catch((error) => ctx.warnings.push(`${shot.id} : ${error.message}`))
    }
    await shell.mouse.move(1, 1)
    cleanups.push(async () => {
      if ((await shell.locator('.rg-gauge.open').count()) > 0) await shell.locator('.rg-gauge').click()
      await shell.mouse.move(1, 1)
    })
  }

  if (scene.importBookmarks === 'preview') {
    // Nothing is imported: the preview waits for « Confirmer l’import », which is never pressed.
    const { overlay } = await previewBookmarks(run, ctx)
    await overlay.mouse.move(1, 1)
    cleanups.push(() => bridge(shell, 'closeOverlay'))
    return { page: shell, readNames: [overlay, shell] }
  }

  if (scene.importBookmarks === 'done') {
    const { sheet } = await previewBookmarks(run, ctx)
    const known = new Set((await snapshotOf(shell)).state.spaces.map((s) => s.id))
    await sheet.locator('.row.end .button.primary').click()
    let imported
    await until(async () => (imported = (await snapshotOf(shell)).state.spaces.find((s) => !known.has(s.id))) !== undefined, 'le nouvel espace de l’import')
    await failOnErrorBoxes(run, 'import')
    // Taken back after the shot: the shots that follow see the demonstration as it was.
    cleanups.push(async () => {
      await dispatch(shell, { type: 'space/select', id: spaceId })
      await dispatch(shell, { type: 'space/delete', id: imported.id })
    })
    await bridge(shell, 'closeOverlay')
    // The new space on screen, its first bookmark shown (a page of the demonstration), its first folder open.
    const firstLink = demo.bookmarkLink(demo.BOOKMARK_LINKS[0], lang)
    const { state } = await snapshotOf(shell)
    const firstTab = state.tabs.find((t) => t.spaceId === imported.id && t.url === firstLink.url)
    const folder = state.folders.find((f) => f.spaceId === imported.id && f.name === demo.BOOKMARK_FOLDERS[0].title[lang])
    if (!firstTab) throw new Error(`l’onglet « ${firstLink.title} » de l’import est introuvable`)
    const opened = new Set(run.pages())
    await dispatch(shell, { type: 'space/select', id: imported.id })
    await dispatch(shell, { type: 'tab/select', id: firstTab.id })
    if (folder?.collapsed) await dispatch(shell, { type: 'folder/toggle', id: folder.id })
    await pageLoaded(run, firstLink.url, opened)
    await shell.mouse.move(1, 1)
    // The sheet is closed: only the sidebar is read.
    return { page: shell, readNames: [shell] }
  }

  if (scene.community) {
    ctx.votes.voted.clear()
    // The page must be the local copy, whose stand-in answers a question the real service does not know: otherwise nothing is touched.
    const answer = await tabPage.evaluate(async (path) => {
      const response = await fetch(path, { cache: 'no-store' })
      return response.ok ? ((await response.json()).demo ?? null) : null
    }, community.DEMO_CHECK_PATH)
    if (answer !== community.DEMO_CHECK_ANSWER) throw new Error('la page Communauté n’est pas la copie locale du site : rien n’y est touché')
    // A made-up voter, as if the address were confirmed on this device: the page votes in one click (the real service would refuse it).
    await tabPage.evaluate(([key, token]) => localStorage.setItem(key, JSON.stringify({ token, expiresAt: Date.now() + 86_400_000 })), [community.VOTER_STORAGE_KEY, community.DEMO_VOTER_TOKEN])
    cleanups.push(async () => {
      ctx.votes.voted.clear()
      await tabPage.evaluate((key) => localStorage.removeItem(key), community.VOTER_STORAGE_KEY)
    })
    await tabPage.reload()
    await tabPage.waitForLoadState('load')
    const first = tabPage.locator('.cm-list .cm-item').first()
    await first.waitFor({ timeout: 15_000 })
    const title = community.VOTED_IDEA.title[lang]
    await until(async () => (await first.locator('h3').textContent()) === title, `l’idée « ${title} » en tête du tableau`)
    // The board at the top of the view, under the header of the site when that header stays at the top (the pages before the redesign of
    // November 2026); a header that scrolls away leaves no room above the board, where the end of the introduction would be cut.
    await tabPage.evaluate(() => {
      const board = document.querySelector('[data-community]')
      const header = document.querySelector('.site-header')
      const stays = header !== null && ['sticky', 'fixed'].includes(getComputedStyle(header).position)
      if (board) window.scrollTo(0, board.getBoundingClientRect().top + window.scrollY - (stays ? header.getBoundingClientRect().height : 0) - 24)
    })
    if (scene.community === 'voted') {
      await first.locator('.vote').click()
      const counted = String(community.VOTED_IDEA.votes + 1)
      await until(async () => (await first.locator('.vote').getAttribute('aria-pressed')) === 'true' && (await first.locator('.vote b').textContent()) === counted, `la voix comptée (${counted})`)
    }
    await tabPage.mouse.move(1, 1)
  }

  if (scene.reader) {
    const opened = new Set(run.pages())
    if (!(await run.clickMenu(labels.READER_MENU))) throw new Error('l’entrée « Mode lecture » du menu Affichage est introuvable ou désactivée')
    const reader = await waitPage(run, (url) => url.startsWith('data:text/html'), 'la vue du mode lecture', { before: opened })
    await reader.waitForLoadState('load')
    await reader.locator('article').first().waitFor({ timeout: 15_000 })
    await reader.evaluate(() => document.fonts?.ready.then(() => true))
    await reader.mouse.move(1, 1)
    cleanups.push(async () => {
      if (!reader.isClosed()) await run.clickMenu(labels.READER_MENU)
    })
  }

  if (scene.pdf) {
    // The viewer of the engine draws itself after the load: its frame comes in, then its toolbar and the page.
    await until(() => tabPage.frames().some((frame) => frame.url().startsWith(labels.PDF_VIEWER)), 'le lecteur de PDF de l’onglet', 15_000).catch((error) => ctx.warnings.push(`${shot.id} : ${error.message} (la prise est faite quand même : à vérifier)`))
    await sleep(1500)
  }

  if (scene.notes) {
    // On « Toutes »: the panel opens on « Cette page » when the page has notes, which lists two of the four.
    await bridge(shell, 'openOverlay', { ...demo.NOTES_PANEL_REQUEST })
    const overlay = await overlayPage(run)
    await overlay.locator('.lp.notes-panel:not([aria-busy="true"])').waitFor({ timeout: 15_000 })
    await until(async () => (await overlay.locator('.notes-panel li.lp-row').count()) >= demo.demoNotes(lang, 0).notes.length, 'les notes de démonstration')
    await overlay.mouse.move(1, 1)
    cleanups.push(() => bridge(shell, 'closeOverlay'))
  }

  if (scene.spaceTheme) {
    // Opening changes nothing; only a click in the panel would (`closeOverlay` closes it without a word).
    await bridge(shell, 'openOverlay', { panel: 'theme', spaceId })
    const overlay = await overlayPage(run)
    await overlay.locator('.theme-pop .tp-theme').first().waitFor({ timeout: 15_000 })
    await overlay.mouse.move(1, 1)
    cleanups.push(() => bridge(shell, 'closeOverlay'))
  }

  if (scene.vault) {
    await dispatch(shell, { type: 'settings/update', patch: { passwordManager: true } })
    cleanups.push(() => dispatch(shell, { type: 'settings/update', patch: { passwordManager: false } }))
    await until(async () => (await snapshotOf(shell)).state.settings.passwordManager === true, 'le gestionnaire de mots de passe activé')
    // A vault of this profile only, opened by a phrase drawn here and never kept or shown; the passwords are drawn the same way. No Touch ID.
    const status = await bridge(shell, 'passwords', { kind: 'status' })
    if (status.view.vault === 'none') {
      const created = await bridge(shell, 'passwords', { kind: 'create', phrase: randomBytes(24).toString('base64url') })
      if (!created.ok) throw new Error(`coffre non créé : ${created.message ?? '?'}`)
    } else if (status.view.vault !== 'unlocked') throw new Error(`le coffre du profil jetable est ${status.view.vault}`)
    for (const login of demo.VAULT_LOGINS) {
      const added = await bridge(shell, 'passwords', { kind: 'add', address: new URL(demo.pageUrl(login.page, lang)).origin, username: login.username[lang], password: randomBytes(15).toString('base64url') })
      if (!added.ok) throw new Error(`identifiant de démonstration non ajouté : ${added.message ?? '?'}`)
    }
    cleanups.push(() => bridge(shell, 'passwords', { kind: 'lock' }))
    await bridge(shell, 'openOverlay', { panel: 'passwords' })
    const overlay = await overlayPage(run)
    await until(async () => (await overlay.locator('.card.passwords .passwords-list li.passwords-row').count()) >= demo.VAULT_LOGINS.length, 'les identifiants du coffre', 15_000)
    await overlay.mouse.move(1, 1)
    cleanups.push(() => bridge(shell, 'closeOverlay'))
  }

  if (scene.extension) {
    // « Surligneur », which has an icon, loaded the way a person does it; then the Extensions page, which the application opens in a tab of the window
    // (chrome://extensions), the tab shown. It goes after the shot.
    const name = demo.extensionManifest(lang).name
    await loadExtensionFolder(run, ctx, name, ctx.extensions[lang], cleanups)
    const opened = new Set(run.pages())
    await bridge(shell, 'openOverlay', { panel: 'extensions' })
    const page = await waitPage(run, (url) => url === labels.EXTENSIONS_PAGE, 'la page Extensions dans un onglet', { before: opened })
    await page.waitForLoadState('load')
    await until(async () => (await page.locator('.xp-card').filter({ hasText: name }).count()) > 0, `l’extension « ${name} » dans la liste`, 15_000)
    await page.evaluate(() => document.fonts?.ready.then(() => true))
    await page.mouse.move(1, 1)
    cleanups.push(async () => {
      for (const tab of (await snapshotOf(shell)).state.tabs.filter((t) => t.url.startsWith(labels.EXTENSIONS_PAGE))) await dispatch(shell, { type: 'tab/close', id: tab.id })
    })
  }

  if (scene.siteExtensions) {
    // The same extension, then the panel of the site with its section of the extensions unfolded (folded again after the shot: the choice is kept by the panel).
    const name = demo.extensionManifest(lang).name
    await loadExtensionFolder(run, ctx, name, ctx.extensions[lang], cleanups)
    await bridge(shell, 'openOverlay', { panel: 'site' })
    const overlay = await overlayPage(run)
    await overlay.locator('.scc').waitFor({ timeout: 15_000 })
    const section = overlay.locator('.scc-section').filter({ has: overlay.locator('.scc-section-title', { hasText: new RegExp(`^${labels.EXTENSIONS_SECTION[lang]}$`) }) })
    const head = section.locator('.scc-section-head')
    const unfolded = (await head.getAttribute('aria-expanded')) !== 'true'
    if (unfolded) await head.click()
    const row = section.locator('.scc-extensions')
    await row.locator('.scc-ext').first().waitFor({ timeout: 15_000 })
    // A tile draws the icon of the extension, or its initial when the picture fails to load: either way, no picture is still on its way.
    await until(() => row.locator('.scc-ext .scc-tile').evaluateAll((tiles) => tiles.length > 0 && tiles.every((tile) => { const icon = tile.querySelector('img.scc-ext-icon'); return icon === null || (icon.complete && icon.naturalWidth > 0) })), 'l’icône de l’extension dans la rangée')
    await row.scrollIntoViewIfNeeded()
    await overlay.locator('.scc').evaluate((card) => Promise.allSettled(card.getAnimations({ subtree: true }).map((animation) => animation.finished)))
    await overlay.evaluate(() => document.fonts?.ready.then(() => true))
    await overlay.mouse.move(1, 1)
    cleanups.push(() => bridge(shell, 'closeOverlay'))
    // Run before the panel closes (the cleanups run backwards).
    if (unfolded) cleanups.push(() => head.click())
  }

  if (scene.framing) {
    // « Personnaliser l'espace » of the space on screen, a video wider than the sidebar added in it, and its frame moved with the arrow keys.
    const id = demo.spaceId(scene.space)
    const own = (await snapshotOf(shell)).state.spaces.find((space) => space.id === id)?.background ?? null
    const backgroundOf = async () => (await snapshotOf(shell)).state.spaces.find((space) => space.id === id)?.background
    await bridge(shell, 'openOverlay', { panel: 'space', spaceId: id })
    const overlay = await overlayPage(run)
    // The panel's own file field (hidden behind « Ajouter un média »), given the video of the demonstration as a person gives one of theirs.
    const field = overlay.locator('.space-media-panel input[type="file"]')
    await field.waitFor({ state: 'attached', timeout: 15_000 })
    cleanups.push(() => bridge(shell, 'closeOverlay'))
    // The space gets its own background back; run before the panel closes (the cleanups run backwards).
    cleanups.push(() => dispatch(shell, { type: 'space/update', id, patch: { background: own } }))
    await field.setInputFiles(join(root, 'scripts/site-captures', demo.FRAMING_VIDEO.file))
    // The video is stored, read back and measured: the frame is drawn once its size is known.
    const frame = overlay.locator('.media-framing .media-framing-frame')
    await frame.waitFor({ timeout: 30_000 })
    await frame.focus()
    for (let moved = 0; moved < scene.framing.moves; moved++) await overlay.keyboard.press('ArrowRight')
    await until(async () => ((await backgroundOf())?.position?.x ?? 50) > 50, 'le cadre de la vidéo déplacé')
    await overlay.locator('.media-framing .media-button').waitFor({ timeout: 10_000 })
    await overlay.evaluate(() => document.fonts?.ready.then(() => true))
    await overlay.mouse.move(1, 1)
  }

  if (scene.little) {
    const url = demo.pageUrl(scene.little, lang)
    restPointer(ctx.screen)
    await bridge(shell, 'submitUrl', url, 'little')
    const little = await waitPage(run, (address) => isWindowPage('little', address), 'la mini-fenêtre', { before })
    await pageLoaded(run, url, before)
    const id = new URL(little.url()).searchParams.get('id')
    cleanups.push(() => (id ? bridge(little, 'littleAction', id, 'close') : undefined))
    return { page: little }
  }

  if (scene.foreignPage) {
    // The page in the other language, in a new tab of the space, closed after the shot.
    const url = demo.pageUrl(scene.foreignPage, lang === 'fr' ? 'en' : 'fr')
    const opened = new Set(run.pages())
    await bridge(shell, 'submitUrl', url, 'new')
    await pageLoaded(run, url, opened)
    cleanups.push(async () => {
      for (const tab of (await snapshotOf(shell)).state.tabs.filter((t) => t.url === url)) await dispatch(shell, { type: 'tab/close', id: tab.id })
    })
  }

  if (scene.click) {
    const target = shell.locator(scene.click.selector).first()
    await target.waitFor({ timeout: 15_000 })
    await target.click()
    const overlay = await overlayPage(run)
    await overlay.locator(scene.click.wait).first().waitFor({ timeout: 15_000 })
    await overlay.evaluate(() => document.fonts?.ready.then(() => true))
    await overlay.mouse.move(1, 1)
    await shell.mouse.move(1, 1)
    cleanups.push(() => bridge(shell, 'closeOverlay'))
  }

  if (scene.find) {
    await bridge(shell, 'openOverlay', { panel: 'find' })
    const overlay = await overlayPage(run)
    const field = overlay.locator('.fb .fb-input')
    await field.waitFor({ timeout: 15_000 })
    if (scene.find.regex) {
      const toggle = overlay.locator('.fb .fb-toggle')
      await toggle.waitFor({ timeout: 10_000 })
      if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
    }
    await field.click()
    await overlay.keyboard.type(scene.find.text[lang], { delay: 30 })
    // The counter says how many were found once the page answered.
    await until(async () => /\d/.test((await overlay.locator('.fb .fb-count').textContent().catch(() => '')) ?? ''), 'le nombre de résultats de la recherche').catch((error) => ctx.warnings.push(`${shot.id} : ${error.message}`))
    await overlay.mouse.move(1, 1)
    cleanups.push(() => bridge(shell, 'closeOverlay'))
  }

  if (scene.overlay) {
    // `$tab`, `$url` and `$host` stand for the tab on screen (shots.ts).
    const url = demo.tabPage(scene.tab, lang).url
    const values = { $tab: tabId, $url: url, $host: new URL(url).host }
    const request = Object.fromEntries(Object.entries(scene.overlay.request).map(([key, value]) => [key, typeof value === 'string' && Object.hasOwn(values, value) ? values[value] : value]))
    await bridge(shell, 'openOverlay', request)
    const overlay = await overlayPage(run)
    await overlay.locator(scene.overlay.wait).first().waitFor({ timeout: 15_000 })
    await overlay.evaluate(() => document.fonts?.ready.then(() => true))
    await overlay.mouse.move(1, 1)
    cleanups.push(() => bridge(shell, 'closeOverlay'))
  }

  if (scene.menu) {
    const opened = new Set(run.pages())
    const label = scene.menu.label[lang]
    if (!(await run.clickMenu([label]))) throw new Error(`l’entrée « ${label} » du menu est introuvable ou désactivée`)
    await failOnErrorBoxes(run, `menu « ${label} »`)
    if (scene.menu.wait) {
      const overlay = await overlayPage(run)
      await overlay.locator(scene.menu.wait).first().waitFor({ timeout: 15_000 })
      await overlay.mouse.move(1, 1)
      cleanups.push(() => bridge(shell, 'closeOverlay'))
    }
    if (scene.newsFrom) await showNewsFrom(await overlayPage(run), scene.newsFrom[lang])
    if (scene.menu.opens) {
      const kind = scene.menu.opens
      const page = await waitPage(run, (url) => isWindowPage(kind, url), `la fenêtre ${kind}`, { before: opened })
      cleanups.push(() => run.closeWindow(kind))
      await page.waitForLoadState('load')
      await page.evaluate(() => document.fonts?.ready.then(() => true))
      await page.mouse.move(1, 1)
      return { page }
    }
  }

  if (scene.settings) {
    if (scene.settings.blockerOff) {
      // Both keys: the blocker reads either (src/shared/privacy-dashboard.ts). On again after the shot.
      await dispatch(shell, { type: 'settings/update', patch: { blockAds: false, blockTrackers: false } })
      cleanups.push(() => dispatch(shell, { type: 'settings/update', patch: { blockAds: true, blockTrackers: true } }))
    }
    // The page, or its subpage (`#protection/network`): an open window elsewhere, on the page of a subpage included, is taken there.
    const address = shots.settingsAddress(scene.settings)
    const where = `Réglages › ${address}`
    let settings = run.pages().find((page) => !page.isClosed() && isWindowPage('settings', page.url()))
    if (!settings || settingsHashOf(settings.url()) !== address) {
      await bridge(shell, 'openOverlay', { panel: 'settings', pane: scene.settings.pane, ...(scene.settings.sub ? { anchor: scene.settings.sub } : {}) })
      settings = await waitPage(run, (url) => isWindowPage('settings', url) && settingsHashOf(url) === address, `la fenêtre des Réglages (${where})`)
    }
    await settings.locator('.settings-cat').first().waitFor()
    await settings.evaluate(() => document.fonts?.ready.then(() => true))
    if (scene.settings.sub) await settings.locator(`.subpage-content[data-subpage="${scene.settings.sub}"]`).first().waitFor()
    if (scene.settings.row) {
      // The row of a feature (features.ts): unfolded and brought to the middle of the window, the way a result of the search is.
      const selectors = features.rowSelectors(scene.settings.row)
      await until(() => settings.evaluate((list) => list.some((selector) => document.querySelector(selector) !== null), selectors), `la ligne ${scene.settings.row} dans ${where}`)
      if (!(await showSettingsRow(settings, selectors))) throw new Error(`la ligne ${scene.settings.row} n’est pas montrée dans ${where} (seulement dans une recherche, ou en double d’une autre page)`)
      await settings.mouse.move(1, 1)
      return { page: settings }
    }
    // The page of the privacy holds the switch of the blocker (the guide is on « Pour commencer », which does not).
    if (scene.settings.pane === 'protection') {
      const blocker = settings.locator('[data-setting="blockAds"] input[role="switch"]')
      await until(async () => (await blocker.isChecked()) === !scene.settings.blockerOff, `l’interrupteur du bloqueur ${scene.settings.blockerOff ? 'éteint' : 'allumé'}`)
    }
    if (scene.settings.guide) {
      // The one entry of the guide, on « Pour commencer »: its questions, those of every category in turn.
      await settings.locator('.guide-start').first().click()
      await settings.locator('.guide-step .guide-question').waitFor()
      // « Suivant », and the next question (or the summary) drawn.
      const next = async () => {
        const progressText = await settings.locator('.guide-progress').textContent()
        await settings.locator('.guide-step .guide-nav button[type="submit"]').click()
        await until(async () => (await settings.locator('.guide-step.guide-plan').count()) > 0 || (await settings.locator('.guide-progress').textContent()) !== progressText, 'la question suivante du guide')
      }
      if (scene.settings.guide === 'question' && scene.settings.question) {
        const wanted = scene.settings.question[lang]
        const title = settings.locator('.guide-step .guide-question-title')
        for (let step = 0; step < shots.GUIDE_STEPS_MAX && !labels.sameText(((await title.count()) > 0 ? await title.first().textContent() : '') ?? '', wanted); step++) await next()
        if (!labels.sameText(((await title.count()) > 0 ? await title.first().textContent() : '') ?? '', wanted)) throw new Error(`la question « ${wanted} » n’est pas posée par le guide`)
      }
      if (scene.settings.guide === 'recap') {
        const plan = settings.locator('.guide-step.guide-plan')
        for (let step = 0; step < shots.GUIDE_STEPS_MAX && (await plan.count()) === 0; step++) {
          const offered = await settings.locator('.guide-step input[type="radio"]').evaluateAll((inputs) => inputs.map((input) => input.value))
          const wanted = (scene.settings.answers ?? []).find((answer) => offered.includes(answer))
          if (wanted) await settings.locator('.guide-answer').filter({ has: settings.locator(`input[value="${wanted}"]`) }).click()
          await next()
        }
        await plan.waitFor({ timeout: 5000 })
      }
      await settings.mouse.move(1, 1)
      cleanups.push(() => settings.keyboard.press('Escape'))
    }
    return { page: settings }
  }

  return { page: shell }
}

/** The address a Settings window is at (`protection/network`), from the URL of its page; '' when it names none. */
const settingsHashOf = (url) => {
  try {
    return decodeURIComponent(new URL(url).hash.replace(/^#/, ''))
  } catch {
    return ''
  }
}

/**
 * Unfolds the groups around the first row `selectors` find and scrolls it just under the head of the Settings window (its title and sidebar),
 * with the title of its group when it is the group's first row: the image keeps the top of the window (features.ts, `anchor: 'top'`). A row that only
 * a search shows (`data-search-only`) or that « Pour commencer » draws again (`data-mirror`) is passed over: the image keeps the row of the page. False
 * when no row is left.
 */
const showSettingsRow = (settings, selectors, bottom = null) =>
  settings.evaluate(([list, foot]) => {
    const shown = (element) => !element.closest('[data-search-only], [data-mirror]')
    const row = list.map((selector) => [...document.querySelectorAll(selector)].find(shown) ?? null).find((element) => element !== null)
    if (!row) return false
    for (let fold = row.closest('details'); fold; fold = fold.parentElement?.closest('details') ?? null) fold.open = true
    // A row that waits in « Plus de réglages »: the fold is opened by its button (React draws it open before the click returns).
    if (row.closest('.more-settings-body')?.hidden) row.closest('.more-settings')?.querySelector('.more-settings-toggle')?.click()
    // The title of its group comes along when the row is the first of the group (nothing of another row above it).
    const section = row.closest('.pref-section')
    const firstRow = section?.querySelector('.pref-row')
    const first = section && (firstRow === row || firstRow?.contains(row) || row.contains(firstRow)) ? section : row
    let box = row.parentElement
    while (box && !(box.scrollHeight > box.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement
    const scroller = box ?? document.scrollingElement
    // A row near the end of its page could not reach the top: blank room under the last group lets it (nothing drawn, only space).
    if (scroller.style.paddingBottom === '') scroller.style.paddingBottom = `${scroller.clientHeight}px`
    // `foot`: the row's bottom at this height of the page instead (the foot of the image).
    if (foot !== null) scroller.scrollTop += row.getBoundingClientRect().bottom - foot
    else scroller.scrollTop += first.getBoundingClientRect().top - (box ? box.getBoundingClientRect().top : 0) - 12
    return true
  }, [selectors, bottom])

/**
 * The CGWindowID of the window of the shot. The development build gives it (getMediaSourceId); it is checked against the windows macOS lists for the
 * process, and the window found there by its place and size is taken instead when the two disagree.
 */
async function windowToCapture(run, shot, page, bounds, warnings) {
  const id = await run.windowId(shot.window, page)
  if (run.kind !== 'development') return id
  const listed = systemWindows(run.pid)
  if (listed.some((window) => window.id === id && window.onscreen)) return id
  const found = capture.pickWindow(listed, bounds)
  warnings.push(`${shot.id} : la fenêtre ${id} de getMediaSourceId() n’est pas dans la liste de macOS ; ${found === null ? 'aucune autre ne convient' : `la fenêtre ${found} est prise à sa place`}`)
  if (found === null) throw new Error(`fenêtre ${shot.window} introuvable dans la liste de macOS`)
  return found
}

async function takeShot(run, ctx, shot) {
  const { session, outRoot, screen } = ctx
  const cleanups = []
  try {
    const { page, readNames } = await setScene(run, ctx, shot, cleanups)
    const bounds = await placeWindow(run, shot.window, page, shot.size, screen, ctx.warnings)
    // A notice at the foot of the sidebar (« Onglet archivé »…) would be in the image: it goes by itself.
    await until(async () => (await snapshotOf(ctx.shell)).toast === null, 'la fin d’une notice de la barre latérale', 8000).catch((error) => ctx.warnings.push(`${shot.id} : ${error.message}`))
    if (run.kind === 'development' || shot.window !== 'main') await run.focus(shot.window, page)
    restPointer(screen, [bounds])
    await sleep(SETTLE_MS)
    if (shot.noBrowserNames) await assertNoBrowserName(shot, readNames ?? [page])
    const id = await windowToCapture(run, shot, page, bounds, ctx.warnings)
    const files = shots.shotFiles(outRoot, session.lang, session.theme, shot.id, ctx.widths)
    mkdirSync(dirname(files.shadow), { recursive: true })
    for (const [file, shadow] of [[files.shadow, true], [files.flat, false]]) {
      execFileSync(SCREENCAPTURE, capture.screencaptureArgs(id, file, shadow), { stdio: 'pipe' })
      if (!existsSync(file) || statSync(file).size === 0) throw new Error(`screencapture n’a rien écrit pour ${relative(root, file)}`)
    }
    const flatSize = capture.pngSize(readFileSync(files.flat))
    if (!flatSize || !capture.flatCaptureMatches(flatSize, bounds, screen.scale)) {
      ctx.warnings.push(`${session.key} ${shot.id} : capture de ${flatSize ? `${flatSize.width}×${flatSize.height}` : '?'} px pour une fenêtre de ${bounds.width}×${bounds.height} points à l’échelle ${screen.scale}`)
    }
    ctx.made.push(files)
    progress(`  ${shot.id} → ${relative(root, files.shadow)}`)
  } finally {
    for (const cleanup of cleanups.reverse()) {
      await Promise.resolve()
        .then(cleanup)
        .catch((error) => progress(`  ${shot.id} : la fin de la prise n’a pas tout refermé (${error.message.split('\n')[0]})`))
    }
  }
}

async function runSession(target, session, base) {
  const { work, port, homes, extensions, votes, siteFound, screen, outRoot, widths, warnings, made, failures } = base
  const bounds = capture.centered(screen.workArea, shots.MAIN_SIZE)
  const profile = makeProfile(work, session, bounds, siteFound)
  const log = logTo(join(work, `${session.lang}-${session.theme}-${session.kind}.log`))
  progress(`${session.key} : démarrage de Lucium (${target.kind === 'packaged' ? relative(root, target.app) || target.app : 'build de développement'})…`)
  // The mini window opens on the screen of the pointer: the pointer is put on the screen of the shots first.
  restPointer(screen)
  const options = { profile, home: homes[session.lang], lang: session.lang, port, log }
  const run = target.kind === 'packaged' ? await launchPackaged(target.executable, options) : await launchDevelopment(options)
  base.running = run
  try {
    const shell = await waitPage(run, (url) => isWindowPage('main', url), 'la fenêtre principale', { timeoutMs: 60_000 })
    await shell.waitForLoadState('domcontentloaded')
    await until(() => shell.evaluate(() => typeof globalThis.lucium?.getSnapshot === 'function'), 'l’interface de la fenêtre principale')
    if (session.kind === 'demo') await until(async () => (await snapshotOf(shell)).state.spaces.some((s) => s.id === demo.spaceId('work')), 'l’état de démonstration')
    await applyLook(shell, session)
    const locale = await run.locale(shell)
    if (!String(locale).toLowerCase().startsWith(session.lang)) warnings.push(`${session.key} : la langue du système vue par l’application est ${locale} (attendu ${session.lang}) : les textes faits par le processus principal peuvent rester dans l’autre langue`)
    const display = await run.display('main', shell)
    if (display.scale !== screen.scale) warnings.push(`${session.key} : la fenêtre est sur un écran à l’échelle ${display.scale}, pas ${screen.scale}`)
    const ctx = { shell, session, screen, outRoot, widths, warnings, made, home: homes[session.lang], extensions, votes }
    for (const shot of session.shots) {
      if (!run.alive()) {
        failures.push(`${session.key} ${shot.id} : l’application s’est arrêtée\n${log.tail()}`)
        continue
      }
      try {
        await takeShot(run, ctx, shot)
      } catch (error) {
        failures.push(`${session.key} ${shot.id} : ${error.message}`)
        progress(`  ${shot.id} : ÉCHEC : ${error.message.split('\n')[0]}`)
      }
    }
  } finally {
    await run.quit()
    base.running = null
    if (!base.keep) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

function makeWebp(made, failures) {
  for (const files of made) {
    for (const web of files.web) {
      mkdirSync(dirname(web.path), { recursive: true })
      const result = spawnSync('magick', capture.webpArgs(web.from === 'flat' ? files.flat : files.shadow, web.path, web.width), { encoding: 'utf8' })
      if (result.status !== 0) failures.push(`WebP ${relative(root, web.path)} : ${(result.stderr || result.error?.message || `code ${result.status}`).trim().split('\n')[0]}`)
    }
  }
}

// ---------- the images of the features page (--features) ----------

/** The size each window of a feature scenario is put at. */
const FEATURE_WINDOW_SIZES = { main: shots.MAIN_SIZE, private: shots.MAIN_SIZE, settings: shots.SETTINGS_SIZE, taskmanager: shots.TASK_MANAGER_SIZE, little: shots.LITTLE_SIZE }

/** A scenario of features.ts as a shot of setScene: the main window, a window it opens, or Settings, in the demonstration profile. */
const featureShot = (scenario) => ({
  id: scenario.card,
  description: features.shows(scenario),
  session: 'demo',
  window: features.windowOf(scenario),
  size: FEATURE_WINDOW_SIZES[features.windowOf(scenario)],
  langs: shots.LANGS,
  themes: ['light'],
  scene: scenario.scene
})

/**
 * The target of the crop in points of the window (its frame included) and the text of the element, or null for the whole window. The element is
 * the first of the selectors with a size, in the page the crop names; the main process says where that page is drawn in the window (viewFrame).
 */
async function measureTarget(run, ctx, scenario, windowPage) {
  const crop = scenario.crop
  if (!crop) return null
  const page = crop.page === 'shell' ? ctx.shell : crop.page === 'overlay' ? await overlayPage(run) : windowPage
  const found = await page.evaluate((selectors) => {
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const box = element.getBoundingClientRect()
        if (box.width > 0 && box.height > 0) return { x: box.x, y: box.y, width: box.width, height: box.height, text: element.innerText ?? '' }
      }
    }
    return null
  }, crop.selectors)
  if (!found) throw new Error(`rien à l’écran pour ${crop.selectors.join(' | ')}`)
  const frame = await run.viewFrame(features.windowOf(scenario), page.url())
  if (!frame) throw new Error(`la page ${page.url()} n’est dans aucune vue de la fenêtre ${features.windowOf(scenario)}`)
  const zoom = frame.zoom || 1
  return { rect: { x: frame.x + found.x * zoom, y: frame.y + found.y * zoom, width: found.width * zoom, height: found.height * zoom }, text: found.text }
}

/** Writes manifest.json from the table and the images of the output folder (their sizes read from their headers). */
function writeFeatureManifest(outDir) {
  const manifest = features.buildManifest(features.FEATURE_SCENARIOS, (name) => {
    const file = join(outDir, name)
    return existsSync(file) ? features.webpSize(readFileSync(file)) : null
  })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

async function takeFeatureShot(run, ctx, scenario) {
  const { session, screen } = ctx
  const shot = featureShot(scenario)
  const cleanups = []
  try {
    const { page } = await setScene(run, ctx, shot, cleanups)
    const bounds = await placeWindow(run, shot.window, page, shot.size, screen, ctx.warnings)
    // The window was sized after the row was brought up: again, at its size; at the foot of the image for `place: 'bottom'`.
    if (scenario.scene?.settings?.row) {
      let foot = null
      if (scenario.scene.settings.place === 'bottom') {
        const box = features.regionFor(scenario.crop, null, bounds)
        const frame = await run.viewFrame(shot.window, page.url())
        if (!frame) throw new Error('la page des Réglages n’est dans aucune vue de sa fenêtre')
        // Right at the foot: the text under the row starts a few pixels lower, out of the image.
        foot = (box.y + box.height - frame.y) / (frame.zoom || 1) - 2
      }
      await showSettingsRow(page, features.rowSelectors(scenario.scene.settings.row), foot)
    }
    await until(async () => (await snapshotOf(ctx.shell)).toast === null, 'la fin d’une notice de la barre latérale', 8000).catch((error) => ctx.warnings.push(`${shot.id} : ${error.message}`))
    await run.focus(shot.window, page)
    restPointer(screen, [bounds])
    await sleep(SETTLE_MS)
    const target = await measureTarget(run, ctx, scenario, page)
    // The image says what its alternative text quotes (the name of a row of Réglages): a row renamed or moved is refused, not captured under a wrong text.
    if (scenario.quote && target && !features.showsQuote(target.text, scenario.quote[session.lang])) {
      throw new Error(`l’image montrerait « ${target.text.split('\n')[0]?.slice(0, 80) ?? ''} » et non « ${scenario.quote[session.lang]} », que cite son texte de remplacement`)
    }
    const region = features.regionFor(scenario.crop, target?.rect ?? null, bounds)
    if (target && !features.showsTarget(region, target.rect)) throw new Error(`${scenario.crop.selectors[0]} sort de l’image (${JSON.stringify(target.rect)} hors de ${JSON.stringify(region)})`)
    // The site names no other browser (names.ts): every text the image shows is read first, a few ordinary words in lower case set aside.
    refuseNames(await regionText(run, shot.window, region), 'l’image montrerait')
    const id = await windowToCapture(run, shot, page, bounds, ctx.warnings)
    const flat = join(ctx.work, `feature-${session.lang}-${scenario.card}.png`)
    execFileSync(SCREENCAPTURE, capture.screencaptureArgs(id, flat, false), { stdio: 'pipe' })
    const image = existsSync(flat) ? capture.pngSize(readFileSync(flat)) : null
    if (!image) throw new Error('screencapture n’a rien écrit')
    const crop = features.pixelCrop(region, image.width / bounds.width, image)
    const out = join(ctx.featuresOut, features.outputName(scenario.card, session.lang))
    // The text drawn in the image itself (a picture, an icon, a canvas), which the pages do not hold as text, read by tesseract when it is there:
    // the same names refuse the image.
    try {
      if (ctx.ocr) refuseNames(readImageText(flat, crop), 'l’image, relue par tesseract, montre')
    } catch (error) {
      if (!ctx.keep) rmSync(flat, { force: true })
      throw error
    }
    // Written beside, then renamed: an interrupted run leaves no half image that --missing would take for a done one.
    const partial = `${out}.part.webp`
    const result = spawnSync('magick', features.cropWebpArgs(flat, partial, crop), { encoding: 'utf8' })
    // --keep keeps the whole window too, beside the profiles of the run.
    if (!ctx.keep) rmSync(flat, { force: true })
    if (result.status !== 0) throw new Error(`WebP : ${(result.stderr || result.error?.message || `code ${result.status}`).trim().split('\n')[0]}`)
    renameSync(partial, out)
    ctx.made.push(out)
    progress(`  ${scenario.card} → ${relative(root, out)} (${crop.width}×${crop.height} px de la fenêtre)`)
  } finally {
    for (const cleanup of cleanups.reverse()) {
      await Promise.resolve()
        .then(cleanup)
        .catch((error) => progress(`  ${scenario.card} : la fin de la scène n’a pas tout refermé (${error.message.split('\n')[0]})`))
    }
  }
}

/** Refuses an image whose text names another browser (names.ts `namesShown`): the names, and the line where the first one is. */
function refuseNames(text, what) {
  const named = names.namesShown(text)
  if (named.length === 0) return
  const line = text.split('\n').find((part) => names.namesShown(part).length > 0) ?? ''
  const at = Math.max(0, line.indexOf(names.namesShown(line)[0] ?? '') - 50)
  throw new Error(`${what} ${named.join(', ')} (« …${line.slice(at, at + 110).trim()}… ») : la capture est refusée (le site ne nomme aucun autre navigateur)`)
}

/** The text tesseract reads in the part of the capture the image keeps (`crop`, in pixels of the capture, at the scale of the screen). */
function readImageText(flat, crop) {
  const piece = `${flat}.ocr.png`
  try {
    const cut = spawnSync('magick', features.ocrCropArgs(flat, piece, crop), { encoding: 'utf8' })
    if (cut.status !== 0) throw new Error(`relecture de l’image : ${(cut.stderr || cut.error?.message || `code ${cut.status}`).trim().split('\n')[0]}`)
    const read = spawnSync('tesseract', features.tesseractArgs(piece), { encoding: 'utf8' })
    if (read.status !== 0) throw new Error(`relecture de l’image par tesseract : ${(read.stderr || read.error?.message || `code ${read.status}`).trim().split('\n')[0]}`)
    return read.stdout
  } finally {
    rmSync(piece, { force: true })
  }
}

/**
 * The texts the image of a scenario shows: those of every page drawn in the window (its own, the overlay, the tab on screen) whose place is in the
 * box, `region` in points of the window. A text node counts as soon as one of its boxes meets the box.
 */
async function regionText(run, kind, region) {
  const texts = []
  for (const page of run.pages()) {
    if (page.isClosed()) continue
    const frame = await run.viewFrame(kind, page.url())
    if (!frame) continue
    const zoom = frame.zoom || 1
    const left = Math.max(region.x, frame.x)
    const top = Math.max(region.y, frame.y)
    const right = Math.min(region.x + region.width, frame.x + frame.width)
    const bottom = Math.min(region.y + region.height, frame.y + frame.height)
    if (right <= left || bottom <= top) continue
    const box = { x: (left - frame.x) / zoom, y: (top - frame.y) / zoom, width: (right - left) / zoom, height: (bottom - top) / zoom }
    const text = await page.evaluate((r) => {
      const found = []
      const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT)
      const range = document.createRange()
      const meets = (rect) => rect.width > 0 && rect.right > r.x && rect.left < r.x + r.width && rect.bottom > r.y && rect.top < r.y + r.height
      // A text scrolled under the head of the window (or under anything else) is not in the image: what the point in its middle shows is it, or not.
      const seen = (element, rect) => {
        const x = Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1)
        const y = Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1)
        const hit = document.elementFromPoint(x, y)
        return hit !== null && (hit === element || element.contains(hit) || hit.contains(element))
      }
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim() || !node.parentElement) continue
        range.selectNodeContents(node)
        for (const rect of range.getClientRects()) {
          if (meets(rect) && seen(node.parentElement, rect)) {
            found.push(node.textContent)
            break
          }
        }
      }
      // What is typed in a field, and the choice a menu shows, are in the image too.
      for (const field of document.querySelectorAll('input, textarea, select')) {
        const rect = field.getBoundingClientRect()
        const value = field.tagName === 'SELECT' ? (field.selectedOptions[0]?.textContent ?? '') : field.value
        if (value && meets(rect) && seen(field, rect)) found.push(value)
      }
      return found.join('\n')
    }, box)
    texts.push(text)
  }
  return texts.join('\n')
}

async function runFeatureSession(session, base) {
  const { work, port, homes, extensions, demoExtensions, votes, siteFound, screen, warnings, made, failures, featuresOut, ocr } = base
  const look = { lang: session.lang, theme: 'light', kind: 'demo', key: `${session.lang}/light/fonctions` }
  const bounds = capture.centered(screen.workArea, shots.MAIN_SIZE)
  const profile = makeProfile(work, look, bounds, siteFound)
  const log = logTo(join(work, `${session.lang}-features.log`))
  progress(`${look.key} : démarrage de Lucium (build de développement), ${session.scenarios.length} scénarios…`)
  restPointer(screen)
  const run = await launchDevelopment({ profile, home: homes[session.lang], lang: session.lang, port, log })
  base.running = run
  try {
    const shell = await waitPage(run, (url) => isWindowPage('main', url), 'la fenêtre principale', { timeoutMs: 60_000 })
    await shell.waitForLoadState('domcontentloaded')
    await until(() => shell.evaluate(() => typeof globalThis.lucium?.getSnapshot === 'function'), 'l’interface de la fenêtre principale')
    await until(async () => (await snapshotOf(shell)).state.spaces.some((s) => s.id === demo.spaceId('work')), 'l’état de démonstration')
    await applyLook(shell, look)
    const ctx = { shell, session: look, screen, warnings, made, home: homes[session.lang], extensions, demoExtensions: demoExtensions[session.lang], votes, work, featuresOut, keep: base.keep, ocr }
    for (const scenario of session.scenarios) {
      if (!run.alive()) {
        failures.push(`${session.lang} ${scenario.card} : l’application s’est arrêtée\n${log.tail()}`)
        continue
      }
      try {
        await takeFeatureShot(run, ctx, scenario)
      } catch (error) {
        failures.push(`${session.lang} ${scenario.card} : ${error.message.split('\n')[0]}`)
        progress(`  ${scenario.card} : ÉCHEC : ${error.message.split('\n')[0]}`)
      }
      writeFeatureManifest(featuresOut)
    }
    // The question before quitting stays off, whatever a scene left.
    await dispatch(shell, { type: 'settings/update', patch: { warnBeforeQuitting: false } }).catch((error) => warnings.push(`${look.key} : la question avant de quitter n’a pas pu être coupée (${error.message.split('\n')[0]})`))
  } finally {
    await run.quit()
    base.running = null
    if (!base.keep) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

/** The texts the dry run checks the scenarios against: the sources of the application, and the features page of the site when it is there. */
function featureSources(siteRoot) {
  const read = (path) => readFileSync(join(root, path), 'utf8')
  const renderer = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(tsx|ts|css)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) renderer.push(readFileSync(path, 'utf8'))
    }
  }
  walk(join(root, 'src/renderer'))
  const catalog = read('src/shared/settings-catalog.ts')
  const pages = ['fonctions/index.html', 'en/features/index.html'].map((page) => join(siteRoot, page))
  const cards = pages.every((page) => existsSync(page)) ? pages.map((page) => features.parseCards(readFileSync(page, 'utf8'))) : null
  return {
    sources: {
      settingsKeys: features.parseSettingsKeys(catalog),
      searchIds: features.parseConstList(read('src/shared/settings-synonyms.ts'), 'SEARCH_IDS'),
      subpages: features.parseConstList(read('src/shared/ipc.ts'), 'SETTINGS_SUBPAGES'),
      otherKeys: features.parseObjectKeys(catalog, 'NO_CONTROL_KEYS'),
      overlayPanels: features.parseOverlayPanels(read('src/main/shell/ipc.ts')),
      featureIds: features.parseFeatureIds(read('src/shared/features.ts')),
      renderer: renderer.join('\n'),
      catalogues: { fr: features.parseCatalogue(read('src/shared/i18n-fr.ts')), en: features.parseCatalogue(read('src/shared/i18n-en.ts')) },
      shotIds: shots.SHOTS.map((shot) => shot.id),
      ...(cards ? { cards: cards[0] } : {})
    },
    // The two pages list the same cards in the same order.
    pagesDiffer: cards ? JSON.stringify(cards[0]) !== JSON.stringify(cards[1]) : false,
    siteFound: cards !== null
  }
}

/** `--features --dry-run`: the scenarios, what each shows and writes, and the problems the sources show. Nothing is started. */
function dryRunFeatures(siteRoot, outDir, only) {
  const { sources, pagesDiffer, siteFound } = featureSources(siteRoot)
  const scenarios = features.FEATURE_SCENARIOS.filter((s) => only.length === 0 || only.includes(s.card))
  console.log('Scénarios de la page Fonctions :')
  for (const s of scenarios) {
    const files = features.capturable(s) ? ['fr', 'en'].map((lang) => features.outputName(s.card, lang)).join(', ') : s.evidence === 'shot' ? `image du site (${s.shot})` : `aucune : ${s.todo}`
    console.log(`  ${s.card.padEnd(28)} ${s.evidence.padEnd(8)} ${features.windowOf(s).padEnd(11)} ${features.shows(s)}\n  ${''.padEnd(28)} → ${files}`)
  }
  const counts = {}
  for (const s of features.FEATURE_SCENARIOS) counts[s.evidence] = (counts[s.evidence] ?? 0) + 1
  const plan = features.planFeatures(features.FEATURE_SCENARIOS, { langs: shots.LANGS, only, done: () => false })
  console.log(`\n${features.FEATURE_SCENARIOS.length} cartes : ${Object.entries(counts).map(([kind, n]) => `${n} ${kind}`).join(', ')} ; ${plan.reduce((n, session) => n + session.scenarios.length, 0)} images à prendre en ${plan.length} passages (fr, en), dans ${relative(root, outDir) || outDir}`)
  const problems = features.checkScenarios(features.FEATURE_SCENARIOS, sources)
  if (!siteFound) console.log(`copie du site introuvable (${siteRoot}) : les cartes de la page ne sont pas comparées au tableau (--site DOSSIER)`)
  if (pagesDiffer) problems.push('les pages française et anglaise n’ont pas les mêmes cartes dans le même ordre')
  if (problems.length === 0) console.log('Vérification : chaque scénario vise un réglage, un panneau, un menu et des éléments qui existent.')
  else console.log(`Problèmes (${problems.length}) :\n  ${problems.join('\n  ')}`)
  return problems.length === 0 ? 0 : 1
}

/** `--features`: the images of the cards, FR and EN, light. */
async function mainFeatures(values, siteRoot, siteFound) {
  const outRoot = resolve(root, values.out ?? 'out-captures')
  const featuresOut = join(outRoot, 'features')
  let langs
  try {
    langs = shots.parseChoice(values.langs, shots.LANGS, 'langue')
  } catch (error) {
    fail(`${error.message}\n\n${USAGE}`)
  }
  const only = (values.only ?? '').split(',').map((id) => id.trim()).filter((id) => id !== '')
  const unknown = features.unknownCards(features.FEATURE_SCENARIOS, only)
  if (unknown.length > 0) fail(`carte inconnue : ${unknown.join(', ')} (voir --features --dry-run)`)
  if (values['dry-run'] || values.list) return dryRunFeatures(siteRoot, featuresOut, only)
  if (values.app) fail('--features pilote la build de développement : --app est refusé (les scènes ouvrent des menus et mesurent les vues dans le processus principal)')
  const { sources } = featureSources(siteRoot)
  const problems = features.checkScenarios(features.FEATURE_SCENARIOS, sources)
  if (problems.length > 0) fail(`le tableau des scénarios ne passe pas la vérification (--features --dry-run) :\n  ${problems.join('\n  ')}`)
  const done = (card, lang) => values.missing === true && existsSync(join(featuresOut, features.outputName(card, lang)))
  const plan = features.planFeatures(features.FEATURE_SCENARIOS, { langs, only, done })
  if (plan.length === 0) {
    writeFeatureManifest(featuresOut)
    progress('rien à prendre : chaque image demandée est déjà là (manifest.json réécrit)')
    return 0
  }
  checkTools(true)
  checkScreenRecording()
  const screen = chooseScreen(values['allow-1x'] === true)
  if (values['no-build']) {
    if (!existsSync(join(root, 'out/main/index.js'))) fail('out/main/index.js manque : lancez sans --no-build.')
  } else build()

  const started = Date.now()
  const work = mkdtempSync(join(tmpdir(), 'lucium-captures-'))
  mkdirSync(featuresOut, { recursive: true })
  for (const entry of readdirSync(featuresOut)) if (entry.endsWith('.part.webp')) rmSync(join(featuresOut, entry), { force: true })
  const base = { work, screen, warnings: [], made: [], failures: [], running: null, keep: values.keep === true, homes: {}, extensions: {}, demoExtensions: {}, siteFound, featuresOut, ocr: findTesseract() }
  const cleanUp = () => {
    if (!base.keep) rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    else progress(`dossier du passage gardé : ${work}`)
  }
  const { server, port, votes } = await startServer(makeCertificate(work), siteFound ? siteRoot : null)
  base.port = port
  base.votes = votes
  const interrupt = async (signal) => {
    progress(`${signal} : arrêt de Lucium et nettoyage…`)
    await base.running?.quit().catch((error) => progress(`arrêt de Lucium : ${error.message.split('\n')[0]}`))
    server.closeAllConnections()
    server.close()
    writeFeatureManifest(featuresOut)
    cleanUp()
    process.exit(130)
  }
  process.once('SIGINT', () => void interrupt('SIGINT'))
  process.once('SIGTERM', () => void interrupt('SIGTERM'))
  try {
    for (const lang of langs) {
      base.homes[lang] = makeHome(work, lang)
      base.extensions[lang] = makeExtension(work, lang)
      base.demoExtensions[lang] = makeDemoExtensions(work, lang)
    }
    progress(`${plan.reduce((n, s) => n + s.scenarios.length, 0)} images en ${plan.length} passages, sur un écran à l’échelle ${screen.scale} ; serveur local sur 127.0.0.1:${port}`)
    for (const session of plan) {
      try {
        await runFeatureSession(session, base)
      } catch (error) {
        base.failures.push(`${session.lang} : ${error.message.split('\n')[0]}`)
        progress(`${session.lang} : ÉCHEC : ${error.message.split('\n')[0]}`)
      }
    }
  } finally {
    server.closeAllConnections()
    server.close()
    cleanUp()
  }
  const manifest = writeFeatureManifest(featuresOut)
  const missing = manifest.cards.filter((card) => card.source === 'capture' && (only.length === 0 || only.includes(card.card)) && langs.some((lang) => card.files[lang] === null)).map((card) => card.card)
  const minutes = ((Date.now() - started) / 60_000).toFixed(1)
  progress(`${base.made.length} images faites en ${minutes} min, dans ${relative(root, featuresOut) || featuresOut} (manifest.json)`)
  if (missing.length > 0) progress(`sans image dans au moins une langue : ${missing.join(', ')} (--features --missing pour les reprendre)`)
  for (const warning of base.warnings) progress(`attention : ${warning}`)
  for (const failure of base.failures) progress(`échec : ${failure}`)
  return base.failures.length > 0 ? 1 : 0
}

// ---------- what --list and --serve do ----------

function printPlan(plan, outRoot, widths, { packaged, siteRoot, siteFound }) {
  console.log('Prises :')
  for (const shot of shots.SHOTS) {
    const note = shot.todo ? `À FAIRE : ${shot.todo}` : packaged && shot.developmentOnly ? `LAISSÉE DE CÔTÉ avec --app : ${shot.developmentOnly}` : shot.description
    console.log(`  ${shot.id.padEnd(22)} ${shot.window.padEnd(10)} ${shot.size.width}×${shot.size.height}  ${note}`)
  }
  console.log(`\nPage Communauté : ${siteFound ? `copie du site ${relative(root, siteRoot) || siteRoot}` : `copie du site introuvable (${siteRoot}) : community et community-voted sont laissées de côté (--site DOSSIER)`}`)
  console.log('\nPassages :')
  for (const session of plan) console.log(`  ${session.key.padEnd(16)} ${session.shots.length} prise${session.shots.length > 1 ? 's' : ''} : ${session.shots.map((shot) => shot.id).join(', ')}`)
  console.log(`  ${plan.reduce((n, session) => n + session.shots.length, 0)} prises en ${plan.length} passages`)
  const first = plan[0]?.shots[0]
  if (first) {
    const files = shots.shotFiles(outRoot, plan[0].lang, plan[0].theme, first.id, widths)
    console.log(`\nFichiers d’une prise (exemple) :\n  ${[files.shadow, files.flat, ...files.web.map((w) => w.path)].map((path) => relative(root, path)).join('\n  ')}`)
  }
}

async function serveOnly(siteRoot, siteFound) {
  const work = mkdtempSync(join(tmpdir(), 'lucium-captures-'))
  const { server, port } = await startServer(makeCertificate(work), siteFound ? siteRoot : null)
  console.log(`Pages de démonstration servies sur https://127.0.0.1:${port} (certificat de ce passage, à accepter).`)
  console.log(`Règle d’hôtes pour un navigateur Chromium : --host-resolver-rules="${capture.hostRules(port)}" --ignore-certificate-errors`)
  console.log(`Ou avec curl : curl -k --connect-to ::127.0.0.1:${port} ${demo.pageUrl('notes', 'fr')}`)
  for (const def of demo.PAGES) console.log(`  ${def.key.padEnd(14)} ${demo.pageUrl(def.key, 'fr').padEnd(48)} ${demo.pageUrl(def.key, 'en')}`)
  console.log(`  ${'community'.padEnd(14)} ${community.communityUrl('fr').padEnd(48)} ${community.communityUrl('en')}${siteFound ? '' : `  (copie du site introuvable : ${siteRoot})`}`)
  console.log('Ctrl+C pour arrêter.')
  const stop = () => {
    server.closeAllConnections()
    server.close()
    rmSync(work, { recursive: true, force: true })
    process.exit(0)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
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
  let langs, themes, widths
  try {
    langs = shots.parseChoice(values.langs, shots.LANGS, 'langue')
    themes = shots.parseChoice(values.themes, shots.THEMES, 'thème')
    widths = shots.parseWidths(values.widths)
  } catch (error) {
    fail(`${error.message}\n\n${USAGE}`)
  }
  // The checkout of the public site, beside this repository by default: the Community page and its assets are read from it, never fetched.
  const siteRoot = resolve(root, values.site ?? '../lucium-website')
  const siteFound = existsSync(join(siteRoot, 'communaute/index.html')) && existsSync(join(siteRoot, 'en/community/index.html'))
  if (values.features) return mainFeatures(values, siteRoot, siteFound)
  if (values.missing || values['dry-run']) fail('--missing et --dry-run vont avec --features')
  const only = (values.only ?? '').split(',').map((id) => id.trim()).filter((id) => id !== '')
  const unknown = only.filter((id) => !shots.SHOTS.some((shot) => shot.id === id))
  if (unknown.length > 0) fail(`prise inconnue : ${unknown.join(', ')} (voir --list)`)
  const packaged = values.app !== undefined
  const plan = shots.planSessions(shots.SHOTS, { langs, themes, only, packaged, without: siteFound ? [] : shots.SITE_SHOTS })
  const outRoot = resolve(root, values.out ?? 'out-captures')
  if (values.list) {
    printPlan(plan, outRoot, widths, { packaged, siteRoot, siteFound })
    return 0
  }
  if (values.serve) {
    await serveOnly(siteRoot, siteFound)
    return null
  }
  if (plan.length === 0) fail('aucune prise à faire avec ces options')
  for (const shot of shots.todoShots(shots.SHOTS)) progress(`à faire, non prise : ${shot.id} (${shot.todo})`)
  if (packaged) for (const shot of shots.developmentOnlyShots(shots.SHOTS)) progress(`laissée de côté avec --app : ${shot.id} (${shot.developmentOnly})`)
  if (!siteFound) progress(`copie du site introuvable (${siteRoot}) : ${shots.SITE_SHOTS.join(' et ')} laissées de côté (--site DOSSIER)`)

  const webp = values['no-webp'] !== true
  checkTools(webp)
  checkScreenRecording()
  const screen = chooseScreen(values['allow-1x'] === true)
  let target
  if (values.app) {
    const app = resolve(process.cwd(), values.app)
    target = { kind: 'packaged', app, executable: executableOf(app) }
  } else {
    if (values['no-build']) {
      if (!existsSync(join(root, 'out/main/index.js'))) fail('out/main/index.js manque : lancez sans --no-build.')
    } else build()
    target = { kind: 'development' }
  }

  const started = Date.now()
  const work = mkdtempSync(join(tmpdir(), 'lucium-captures-'))
  const base = { work, screen, outRoot, widths, warnings: [], made: [], failures: [], running: null, keep: values.keep === true, homes: {}, extensions: {}, siteFound }
  const cleanUp = () => {
    if (!base.keep) rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    else progress(`dossier du passage gardé : ${work}`)
  }
  const { server, port, votes } = await startServer(makeCertificate(work), siteFound ? siteRoot : null)
  base.port = port
  base.votes = votes
  const interrupt = async (signal) => {
    progress(`${signal} : arrêt de Lucium et nettoyage…`)
    await base.running?.quit().catch((error) => progress(`arrêt de Lucium : ${error.message.split('\n')[0]}`))
    server.closeAllConnections()
    server.close()
    cleanUp()
    process.exit(130)
  }
  process.once('SIGINT', () => void interrupt('SIGINT'))
  process.once('SIGTERM', () => void interrupt('SIGTERM'))

  try {
    for (const lang of langs) {
      base.homes[lang] = makeHome(work, lang)
      base.extensions[lang] = makeExtension(work, lang)
    }
    progress(`${plan.reduce((n, s) => n + s.shots.length, 0)} prises en ${plan.length} passages, sur un écran à l’échelle ${screen.scale} ; serveur local sur 127.0.0.1:${port}`)
    for (const session of plan) {
      try {
        await runSession(target, session, base)
      } catch (error) {
        base.failures.push(`${session.key} : ${error.message}`)
        progress(`${session.key} : ÉCHEC : ${error.message.split('\n')[0]}`)
      }
    }
  } finally {
    server.closeAllConnections()
    server.close()
    cleanUp()
  }

  if (webp && base.made.length > 0) {
    progress('images WebP…')
    makeWebp(base.made, base.failures)
  }
  const minutes = ((Date.now() - started) / 60_000).toFixed(1)
  progress(`${base.made.length} prises faites en ${minutes} min, dans ${relative(root, outRoot) || outRoot}`)
  for (const warning of base.warnings) progress(`attention : ${warning}`)
  for (const failure of base.failures) progress(`échec : ${failure}`)
  return base.failures.length > 0 ? 1 : 0
}

main().then(
  (code) => {
    if (code !== null) process.exit(code)
  },
  (error) => {
    console.error(error)
    process.exit(2)
  }
)
