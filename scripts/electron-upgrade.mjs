// Prepares the move of Lucium to another Electron (so another Chromium), step by step, on this Mac (docs/mise-a-jour-chromium.md).
// It prepares and shows; it never commits, never pushes, never publishes, and never reads, prints or stores a secret (the VMP signature asks
// its password in the terminal itself, the Developer ID identity is a name in LUCIUM_SIGN_IDENTITY).
//
//   node scripts/electron-upgrade.mjs 45.1.0                 all the steps below, in this order
//   node scripts/electron-upgrade.mjs 45.1.0 --steps=check   one or some steps (comma-separated), to replay one
//
// Steps:
//   check      reads the public feeds (GET, no key): the target exists and is stable, its castLabs build exists, what changes (Chromium, Node, V8)
//   branch     `git switch -c chore/electron-<version>` (or switches to it when it exists); the working tree is kept as it is
//   bump       writes the exact version in package.json, then `pnpm install` (the project's method: the lockfile and the Electron binary follow)
//   typecheck  tsc on tsconfig.node.json and tsconfig.web.json
//   test       vitest (the unit tests, about half a minute)
//   ecs        downloads the castLabs build of the version into ~/Library/Application Support/lucium-drm-tools/ecs-<version>/, unless it is
//              already there; its SHA-256 must be the one the SHASUMS256.txt of the release, the checksums.json of castLabs' repository at the tag
//              and, for a version already recorded, scripts/ecs-checksums.json agree on (src/main/ecs-checksum.ts); nothing is written in the
//              repository: for a new version, the step prints the line to add to scripts/ecs-checksums.json
//   build      `node scripts/package-drm.mjs --castlabs-fuses` on that build (the fuses of scripts/build-drm-release.sh: castLabs' set, the one EVS
//              signs besides castLabs' defaults, cookie encryption included): dist-drm/mac-arm64/Lucium DRM.app, unsigned unless --sign
//              (then --vmp --apple)
//   notarize   with --notarize (NOTARIZATION_ENABLED below): sends the signed application to Apple with `xcrun notarytool` and the keychain profile
//              named in LUCIUM_NOTARY_PROFILE, waits, staples the ticket and checks it; skipped unless --notarize
//   report     what changed, where the application is, how to try it beside the installed one, what to do next
//
// Options:
//   --engine            also runs the engine contract after the unit tests (a real Electron opens windows and takes the focus; ~ minutes)
//   --sign              builds signed: VMP by castLabs' EVS (a session or the password, asked in the terminal), then the Developer ID of
//                       LUCIUM_SIGN_IDENTITY; without it the build is unsigned and the protected videos will not play
//   --notarize          notarizes the signed build (needs --sign and LUCIUM_NOTARY_PROFILE, the name of a profile made once with
//                       `xcrun notarytool store-credentials <name>`: a name, the credentials stay in the keychain); refused while disabled
//   --as-lucium      builds under the name and identifier of the normal application (to be installed in its place); the default is
//                       "Lucium DRM", a second application beside it, for trying the version first
//   --without-ecs       goes on when castLabs has no build of the version: the steps ecs and build are skipped, the DRM variant waits
//   --allow-prerelease  accepts an alpha or a beta as target, to prepare the main line and read what changes; the step build is then refused by
//                       scripts/package-drm.mjs, which never builds the DRM variant on a prerelease (src/main/drm-engine-guard.ts, docs/drm.md)
//   --no-branch         stays on the current branch
//   --dry-run           prints what each step would run and writes nothing (no file, no download, no command)
//   --timeout=ms        the wait for each feed (15 s by default)
//
// Exit code: 0 done (or dry run), 1 a step failed (the message says which and why), 2 the arguments are wrong.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.error(`${warning.name}: ${warning.message}`)
})
const { WATCH_SOURCES, compareVersions, ecsTagFor, formatVersion, parseVersion, readEcsReleases, readElectronReleases } = await import('../src/main/electron-watch.ts')
const { expectedEcsSum, readPinnedEcsSums } = await import('../src/main/ecs-checksum.ts')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STEPS = ['check', 'branch', 'bump', 'typecheck', 'test', 'ecs', 'build', 'notarize', 'report']
// The notarization uses the keychain profile named by LUCIUM_NOTARY_PROFILE (made once with `xcrun notarytool store-credentials`; the
// credentials never leave the keychain, docs/drm.md). It runs only with --notarize. Turning it off is this line (--notarize is then refused and
// the step only says it is skipped).
const NOTARIZATION_ENABLED = true
const TOOLS = join(homedir(), 'Library/Application Support/lucium-drm-tools')
const USER_AGENT = 'lucium-electron-upgrade (https://github.com/pOwn3d/Lucium)'

const usage = () => console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))

/** @type {(message: string) => never} */
const fail = (message) => {
  console.error(`electron-upgrade: ${message}`)
  process.exit(1)
}

// ---- Arguments ----

const readArgs = (argv) => {
  const args = { target: null, steps: STEPS, engine: false, sign: false, notarize: false, asLucium: false, withoutEcs: false, allowPrerelease: false, branch: true, dryRun: false, timeout: 15_000, help: false }
  for (const arg of argv) {
    const [key, value] = arg.includes('=') ? arg.split(/=(.*)/s) : [arg, undefined]
    if (key === '--help' || key === '-h') args.help = true
    else if (key === '--engine') args.engine = true
    else if (key === '--sign') args.sign = true
    else if (key === '--notarize') args.notarize = true
    else if (key === '--as-lucium') args.asLucium = true
    else if (key === '--without-ecs') args.withoutEcs = true
    else if (key === '--allow-prerelease') args.allowPrerelease = true
    else if (key === '--no-branch') args.branch = false
    else if (key === '--dry-run') args.dryRun = true
    else if (key === '--timeout' && value !== undefined && /^\d+$/.test(value) && Number(value) >= 1000) args.timeout = Number(value)
    else if (key === '--steps' && value) {
      args.steps = value.split(',').map((s) => s.trim())
      const unknown = args.steps.filter((s) => !STEPS.includes(s))
      if (unknown.length > 0) throw new Error(`étape(s) inconnue(s) : ${unknown.join(', ')} (connues : ${STEPS.join(', ')})`)
    } else if (!key.startsWith('-') && args.target === null) args.target = key
    else throw new Error(`argument inconnu ou mal formé : ${arg} (voir --help)`)
  }
  if (args.help) return args
  if (args.target === null) throw new Error('la version cible manque (exemple : node scripts/electron-upgrade.mjs 45.1.0)')
  if (!parseVersion(args.target)) throw new Error(`« ${args.target} » n'est pas une version (attendu : 45.1.0)`)
  if (args.sign && !process.env.LUCIUM_SIGN_IDENTITY) throw new Error('--sign demande LUCIUM_SIGN_IDENTITY (le nom de l’identité « Developer ID Application: … », jamais un secret)')
  if (args.notarize && !NOTARIZATION_ENABLED) throw new Error('la notarisation est désactivée (NOTARIZATION_ENABLED) : elle demande le profil de trousseau configuré par LUCIUM_NOTARY_PROFILE (xcrun notarytool store-credentials, docs/drm.md, section « Notarisation »)')
  if (args.notarize && !args.sign) throw new Error('--notarize demande --sign : Apple refuse une application qui n’est pas signée par un Developer ID')
  if (args.notarize && !process.env.LUCIUM_NOTARY_PROFILE?.trim()) throw new Error('--notarize demande LUCIUM_NOTARY_PROFILE (le nom du profil de trousseau créé par `xcrun notarytool store-credentials`, jamais un secret)')
  return args
}

let args
try {
  args = readArgs(process.argv.slice(2))
} catch (error) {
  console.error(`electron-upgrade: ${error.message}`)
  process.exit(2)
}
if (args.help) {
  usage()
  process.exit(0)
}
/** A version that was already checked (the target, by readArgs) or that package.json pins: `parseVersion` gives it back. */
const versionOf = (text) => /** @type {NonNullable<ReturnType<typeof parseVersion>>} */ (parseVersion(text))
const target = formatVersion(versionOf(args.target))
const targetMajor = versionOf(target).major
const ecsDir = join(TOOLS, `ecs-${target}`)
/** The application `build` makes (scripts/package-drm.mjs), which `notarize` sends and `report` names. */
const builtApp = join(root, 'dist-drm/mac-arm64', args.asLucium ? 'Lucium.app' : 'Lucium DRM.app')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const installed = String(packageJson.devDependencies?.electron ?? '').replace(/^[\^~=v]+/, '')
if (!parseVersion(installed)) fail(`package.json ne déclare pas une version exacte d'electron (« ${packageJson.devDependencies?.electron} »)`)

// ---- Helpers ----

const started = Date.now()
const stamp = () => `${Math.round((Date.now() - started) / 1000)} s`
const say = (message) => console.log(`\nelectron-upgrade [${stamp()}] ${message}`)

/** Runs a command in the repository, output shown; a failure stops everything with the command named. In a dry run, prints it. */
const run = (command, cmdArgs, options = {}) => {
  const shown = [command, ...cmdArgs].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
  const envShown = options.env ? Object.entries(options.env).filter(([k]) => !(k in process.env) || process.env[k] !== options.env[k]).map(([k, v]) => `${k}=${v} `).join('') : ''
  console.log(`  $ ${envShown}${shown}`)
  if (args.dryRun) return { status: 0, stdout: '' }
  const result = spawnSync(command, cmdArgs, { cwd: root, stdio: options.capture ? ['inherit', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8', env: { ...process.env, ...(options.env ?? {}) } })
  if (result.error) fail(`${command} : ${result.error.message}`)
  if (result.status !== 0 && !options.allowFailure) fail(`« ${shown} » a échoué (code ${result.status}) : l'étape s'arrête là, rien n'est annulé ; corriger puis rejouer avec --steps=…`)
  return result
}

const has = (command) => spawnSync('which', [command], { encoding: 'utf8' }).status === 0

const fetchJson = async (url) => {
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(args.timeout) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

const fetchText = async (url) => {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(args.timeout) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

// ---- The steps ----

/** What `check` found, for the report; filled by `check` or read again from the feeds when `report` runs alone. */
/** @type {{ from: any, to: any, ecsBuild: any, ecsTag: string } | null} */
let found = null

const check = async () => {
  say(`check : Electron ${installed} → ${target}`)
  let releases
  let ecs
  try {
    ;[releases, ecs] = await Promise.all([fetchJson(WATCH_SOURCES.releases).then((raw) => readElectronReleases(raw)), fetchJson(WATCH_SOURCES.ecs).then((raw) => readEcsReleases(raw))])
  } catch (error) {
    fail(`les flux publics n'ont pas pu être lus (${error.message}) : rien n'est décidé sans eux`)
  }
  const from = releases.find((r) => r.version === installed) ?? null
  const to = releases.find((r) => r.version === target) ?? null
  if (!to) fail(`Electron ${target} n'est pas dans ${WATCH_SOURCES.releases} : vérifier la version (node scripts/electron-watch.mjs donne les dernières)`)
  if (to.parsed.prerelease !== null && !args.allowPrerelease) fail(`Electron ${target} est une préversion ; --allow-prerelease pour l'accepter en connaissance de cause`)
  if (compareVersions(to.parsed, versionOf(installed)) <= 0) fail(`Electron ${target} n'est pas plus récent que ${installed} : rien à préparer`)
  const ecsTag = ecsTagFor(target)
  const ecsBuild = ecs.find((e) => e.tag === ecsTag) ?? null
  const ecsOfLine = ecs.filter((e) => e.parsed.major === targetMajor).sort((a, b) => compareVersions(b.parsed, a.parsed))[0] ?? null
  const row = (label, a, b) => `  ${label.padEnd(10)} ${String(a ?? '?').padEnd(28)} → ${b ?? '?'}`
  console.log(row('Electron', from?.version ?? installed, to.version))
  console.log(row('Chromium', from?.chrome, to.chrome))
  console.log(row('Node', from?.node, to.node))
  console.log(row('V8', from?.v8, to.v8))
  console.log(row('publiée le', from?.date, to.date))
  if (!from) console.log(`  (la version installée ${installed} n'est pas dans le calendrier : les valeurs de départ manquent)`)
  if (from && Number(to.chrome.split('.')[0]) !== Number(from.chrome.split('.')[0])) {
    console.log(`  Jalon Chromium ${from.chrome.split('.')[0]} → ${to.chrome.split('.')[0]} : lire les notes de version et les changements cassants :`)
    console.log(`    https://github.com/electron/electron/releases/tag/v${target}`)
    console.log(`    https://github.com/electron/electron/blob/v${target}/docs/breaking-changes.md`)
  }
  if (ecsBuild) console.log(`  castLabs : ${ecsBuild.tag} existe${ecsBuild.date ? ` (${ecsBuild.date})` : ''}`)
  else {
    console.log(`  castLabs : pas de ${ecsTag}${ecsOfLine ? ` (la plus récente de la ligne ${targetMajor} : ${ecsOfLine.tag})` : ` (aucune version sur la ligne ${targetMajor})`}`)
    if (!args.withoutEcs) fail(`la variante DRM ne peut pas suivre sans ${ecsTag} ; attendre castLabs, ou --without-ecs pour préparer la ligne principale seule (étapes ecs et build sautées)`)
  }
  found = { from, to, ecsBuild, ecsTag }
}

const branch = () => {
  if (!args.branch) return say('branch : sautée (--no-branch)')
  const name = `chore/electron-${target}`
  say(`branch : ${name}`)
  const current = spawnSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  if (current === name) return console.log(`  déjà sur ${name}`)
  const exists = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd: root }).status === 0
  run('git', exists ? ['switch', name] : ['switch', '-c', name])
  console.log('  (les modifications en cours sont conservées ; rien n’est validé : le commit est à votre demande)')
}

const bump = () => {
  say(`bump : package.json electron ${installed} → ${target}, puis pnpm install`)
  const file = join(root, 'package.json')
  const text = readFileSync(file, 'utf8')
  const needle = `"electron": "${packageJson.devDependencies.electron}"`
  const count = text.split(needle).length - 1
  if (count !== 1) fail(`package.json : « ${needle} » trouvé ${count} fois, une seule attendue ; modifier à la main`)
  console.log(`  package.json : ${needle} → "electron": "${target}"`)
  if (!args.dryRun) writeFileSync(file, text.replace(needle, `"electron": "${target}"`))
  if (!has('pnpm')) fail('pnpm est introuvable : lancer `pnpm install` à la main (il met à jour pnpm-lock.yaml et télécharge l’Electron de la version), puis rejouer --steps=typecheck,test,ecs,build,report')
  run('pnpm', ['install'])
}

const typecheck = () => {
  say('typecheck : tsc (node, web)')
  run('node_modules/.bin/tsc', ['--noEmit', '-p', 'tsconfig.node.json'])
  run('node_modules/.bin/tsc', ['--noEmit', '-p', 'tsconfig.web.json'])
}

const test = () => {
  say('test : vitest')
  run('node_modules/.bin/vitest', ['run'])
  if (!args.engine) return console.log('  (contrat moteur non lancé : --engine pour le jouer, il ouvre des fenêtres)')
  say('test : contrat moteur dans un vrai Electron')
  // The list of probes is the one of `pnpm test:engine` (package.json), read from there so that the two stay equal.
  const script = String(packageJson.scripts?.['test:engine'] ?? '')
  const probes = /\$\{LUCIUM_EXTENSIONS:-([^}]*)\}/.exec(script)?.[1]?.replaceAll('$PWD', root) ?? ''
  if (!probes) fail('package.json : le script test:engine ne donne plus la liste des sondes ; lancer pnpm test:engine à la main')
  run('node_modules/.bin/electron-vite', ['build'])
  const profile = args.dryRun ? '<dossier temporaire>' : mkdtempSync(join(tmpdir(), 'lucium-upgrade-'))
  run('node_modules/.bin/electron', ['.', '--smoke', `--user-data-dir=${profile}`], { env: { LUCIUM_EXTENSIONS: probes } })
  console.log(`  Comparer le rapport avec la référence d'avant la montée : pnpm compat:compare après un pnpm test:engine (ce lancement-ci n'écrit pas de rapport), puis pnpm compat:baseline une fois les écarts acceptés (docs/architecture.md, « Comment mettre à jour Chromium sans casse »)`)
}

const ecsStep = async () => {
  if (args.withoutEcs && !found?.ecsBuild) return say('ecs : sautée (--without-ecs)')
  const tag = ecsTagFor(target)
  say(`ecs : castLabs ${tag} dans ${ecsDir}`)
  if (existsSync(join(ecsDir, 'Electron.app'))) return console.log('  déjà présent')
  const base = `https://github.com/castlabs/electron-releases/releases/download/${tag}`
  // The same sums, kept in the git tree of castLabs' repository at the tag rather than in the release's attachments (src/main/ecs-checksum.ts).
  const tree = `https://raw.githubusercontent.com/castlabs/electron-releases/${encodeURIComponent(tag)}/checksums.json`
  const zipName = `electron-${tag}-darwin-arm64.zip`
  console.log(`  GET ${base}/SHASUMS256.txt`)
  console.log(`  GET ${tree}`)
  console.log(`  GET ${base}/${zipName}`)
  console.log(`  ditto -x -k ${zipName} ${ecsDir}`)
  if (args.dryRun) return
  let pinned
  try {
    pinned = readPinnedEcsSums(readFileSync(join(root, 'scripts/ecs-checksums.json'), 'utf8'))
  } catch (error) {
    fail(`scripts/ecs-checksums.json illisible (${error.message}) : aucun téléchargement sans les sommes enregistrées`)
  }
  let sums
  let treeSums
  try {
    sums = await fetchText(`${base}/SHASUMS256.txt`)
  } catch (error) {
    fail(`SHASUMS256.txt de ${tag} introuvable (${error.message}) : aucun téléchargement sans somme de contrôle à vérifier`)
  }
  try {
    treeSums = await fetchText(tree)
  } catch (error) {
    fail(`checksums.json de ${tag} introuvable dans le dépôt de castLabs (${error.message}) : aucun téléchargement sans second relevé de la somme`)
  }
  const check = expectedEcsSum({ tag, zipName, shasums: sums, checksumsJson: treeSums, pinned })
  if (!check.ok) fail(`${check.reason} : rien n'est téléchargé`)
  const expected = check.sum
  mkdirSync(TOOLS, { recursive: true })
  const zipPath = join(TOOLS, zipName)
  const response = await fetch(`${base}/${zipName}`, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(Math.max(args.timeout, 600_000)) }).catch((error) => fail(`téléchargement de ${zipName} : ${error.message}`))
  if (!response.ok) fail(`téléchargement de ${zipName} : HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) fail(`somme SHA-256 de ${zipName} : ${actual}, attendu ${expected} : fichier refusé, rien n'est écrit`)
  writeFileSync(zipPath, bytes)
  console.log(`  ${zipName} : ${(bytes.length / 1e6).toFixed(0)} Mo, SHA-256 vérifiée (SHASUMS256.txt et checksums.json${check.recorded ? ', et scripts/ecs-checksums.json' : ''})`)
  if (!check.recorded) console.log(`  Version pas encore enregistrée : ajouter à scripts/ecs-checksums.json, dans le commit de la montée :\n    "${tag}": { "${zipName}": "${expected}" }`)
  mkdirSync(ecsDir, { recursive: true })
  const unzip = spawnSync('ditto', ['-x', '-k', zipPath, ecsDir], { stdio: 'inherit' })
  rmSync(zipPath, { force: true })
  if (unzip.status !== 0) fail(`ditto a échoué (code ${unzip.status})`)
  if (!existsSync(join(ecsDir, 'Electron.app')) || !existsSync(join(ecsDir, 'version'))) fail(`${ecsDir} n'a pas Electron.app et version après extraction : archive inattendue`)
  const version = readFileSync(join(ecsDir, 'version'), 'utf8').trim().replace(/^v/, '')
  if (version !== `${target}+wvcus` && version !== target) fail(`${ecsDir}/version dit « ${version} », attendu ${target}+wvcus`)
}

const build = () => {
  if (args.withoutEcs && !found?.ecsBuild) return say('build : sautée (--without-ecs ; pour la ligne principale : pnpm package)')
  say(`build : scripts/package-drm.mjs --castlabs-fuses${args.asLucium ? ' --as-lucium' : ''}${args.sign ? ' --vmp --apple' : ' (non signée)'}`)
  if (!args.dryRun && !existsSync(join(ecsDir, 'Electron.app'))) fail(`${ecsDir}/Electron.app manque : rejouer --steps=ecs`)
  // The flags of scripts/build-drm-release.sh: castLabs' set of fuses, the one set EVS signs besides castLabs' defaults
  // (any other change is answered "Binary signature denied"), and the Developer ID signs after EVS (--sign needs LUCIUM_SIGN_IDENTITY, checked with
  // the arguments). --as-lucium stays a choice here: the default is "Lucium DRM", tried beside the installed application.
  const flags = ['--castlabs-fuses', ...(args.asLucium ? ['--as-lucium'] : []), ...(args.sign ? ['--vmp', '--apple'] : []), ...(args.sign && args.notarize ? ['--timestamp-required'] : [])]
  run('node', ['scripts/package-drm.mjs', ...flags], { env: { LUCIUM_ECS_DIST: ecsDir } })
}

/**
 * Sends the signed application to Apple's notary service with the keychain profile, waits for the answer, staples the ticket to the application
 * and checks it as Gatekeeper will. Nothing secret is read or printed: the profile is a name, the credentials stay in the keychain. The JSON read
 * from `notarytool submit --output-format json` (its `id` and `status`) is to be checked on the first real notarization.
 */
const notarize = () => {
  if (!args.notarize) return say(`notarize : sautée (${NOTARIZATION_ENABLED ? 'sans --notarize' : 'désactivée (NOTARIZATION_ENABLED) : elle demande le profil de trousseau configuré par LUCIUM_NOTARY_PROFILE, docs/drm.md'})`)
  if (args.withoutEcs && !found?.ecsBuild) return say('notarize : sautée (--without-ecs : aucune application construite)')
  const profile = (process.env.LUCIUM_NOTARY_PROFILE ?? '').trim()
  say(`notarize : ${builtApp} (profil de trousseau « ${profile} »)`)
  if (!args.dryRun && !existsSync(builtApp)) fail(`${builtApp} manque : rejouer --steps=ecs,build avec --sign`)
  // notarytool takes a zip, a dmg or a pkg, not a folder: the zip is a throw-away copy, the ticket is stapled to the application itself.
  const work = args.dryRun ? '<dossier temporaire>' : mkdtempSync(join(tmpdir(), 'lucium-notarize-'))
  if (!args.dryRun) process.once('exit', () => rmSync(work, { recursive: true, force: true }))
  const zip = join(work, 'notarize.zip')
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', builtApp, zip])
  const submit = run('xcrun', ['notarytool', 'submit', zip, '--keychain-profile', profile, '--wait', '--output-format', 'json'], { capture: true, allowFailure: true })
  if (!args.dryRun) {
    let answer
    try {
      answer = JSON.parse(submit.stdout)
    } catch {
      // Not JSON (notarytool printed an error instead): said in the failure below, never taken for an acceptance.
      answer = { status: `réponse illisible de notarytool, code ${submit.status}` }
    }
    if (submit.status !== 0 || answer?.status !== 'Accepted') fail(`Apple n’a pas accepté l’application (${answer?.status ?? `code ${submit.status}`})${answer?.id ? ` : xcrun notarytool log ${answer.id} --keychain-profile "${profile}" en donne la raison` : ''}`)
    console.log(`  acceptée par Apple (soumission ${answer.id})`)
  }
  run('xcrun', ['stapler', 'staple', builtApp])
  run('xcrun', ['stapler', 'validate', builtApp])
  run('spctl', ['--assess', '--type', 'execute', '-vv', builtApp])
}

const report = async () => {
  say('report : prêt à tester')
  if (!found) await check()
  const { from, to } = /** @type {NonNullable<typeof found>} */ (found)
  const app = builtApp
  const profile = join(homedir(), 'Library/Application Support/Lucium')
  const trial = join(homedir(), 'Library/Application Support/lucium-next')
  console.log(`
Electron ${from?.version ?? installed} → ${to.version} : Chromium ${from?.chrome ?? '?'} → ${to.chrome}, Node ${from?.node ?? '?'} → ${to.node}, V8 ${from?.v8 ?? '?'} → ${to.v8}
Application : ${app}${existsSync(app) ? '' : ' (pas encore construite : --steps=ecs,build)'}
Signature : ${args.sign ? `VMP + Developer ID${args.notarize ? ', notarisée par Apple et agrafée' : ` (pas de notarisation : ${NOTARIZATION_ENABLED ? '--notarize pour la faire' : 'étape notarize désactivée'})`}` : 'aucune (les vidéos protégées ne liront pas ; --sign pour signer)'}

Essai sans toucher au profil réel (la copie est la vôtre, le profil réel n'est jamais écrit ; la build chiffre les cookies de la copie, ensemble castLabs) :
  rm -rf "${trial}" && ditto "${profile}" "${trial}"
  open -na "${app}" --args --user-data-dir="${trial}"
Liste de contrôle : docs/mise-a-jour-chromium.md, § « Liste de contrôle ».

Fichiers modifiés par la préparation (rien n'est validé) :`)
  const status = spawnSync('git', ['status', '--short', '--', 'package.json', 'pnpm-lock.yaml'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  console.log(status ? status.replace(/^/gm, '  ') : '  (aucun : package.json est déjà à cette version, ou bump n’a pas tourné)')
  console.log(`
Ensuite, à votre demande seulement : git commit -m "chore(deps-dev): electron ${to.version} (Chromium ${to.chrome})" et la suite de docs/mise-a-jour-chromium.md (§ « Déployer »).`)
}

// ---- Run ----

const actions = { check, branch, bump, typecheck, test, ecs: ecsStep, build, notarize, report }
if (args.dryRun) console.log('electron-upgrade : simulation (--dry-run), rien n’est exécuté ni écrit')
for (const step of STEPS) if (args.steps.includes(step)) await actions[step]()
say(`terminé${args.dryRun ? ' (simulation)' : ''}`)
