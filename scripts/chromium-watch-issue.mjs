// Opens the issue "Electron X (Chromium Y) disponible" of the daily watch, or rewrites the one already open: never a second one. Run by
// .github/workflows/chromium-watch.yml after scripts/electron-watch.mjs said a newer Electron is out (exit code 10 or 20).
//
//   node scripts/chromium-watch-issue.mjs --report=report.json --text=report.txt --repo=owner/name
//   node scripts/chromium-watch-issue.mjs --report=report.json --text=report.txt --repo=owner/name --dry-run
//
//   --report   the output of `node scripts/electron-watch.mjs --json`
//   --text     the same report as text (what the issue shows)
//   --repo     the repository of the issue (GITHUB_REPOSITORY when absent)
//   --dry-run  reads the open issue and prints what would be done, as JSON; writes nothing
//   --offline  with --dry-run: does not call gh at all (no issue is taken as open)
//
// It needs `gh` and a token that can write issues (GH_TOKEN). Exit code: 0 done, 1 the report or the answer of gh is not what it should be,
// 2 the arguments cannot be read.
//
// The logic (which version, the title, the body, one issue only) is in src/main/chromium-watch-issue.ts, with its tests in
// src/main/chromium-watch-issue.test.ts; this file only reads the two files and runs gh.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// See scripts/electron-watch.mjs: the module is TypeScript that Node runs as is, and only the warning about its module type is silenced.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.error(`${warning.name}: ${warning.message}`)
})
const { openOrUpdateIssue } = await import('../src/main/chromium-watch-issue.ts')

const usage = () => {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))
}

/** `--name=value` and `--flag`; anything else is an error (a typo must not pass for a default). */
const readArgs = (argv) => {
  const args = { report: null, text: null, repo: process.env.GITHUB_REPOSITORY ?? null, dryRun: false, offline: false, help: false }
  for (const arg of argv) {
    const [key, value] = arg.includes('=') ? arg.split(/=(.*)/s) : [arg, undefined]
    if (key === '--dry-run' && value === undefined) args.dryRun = true
    else if (key === '--offline' && value === undefined) args.offline = true
    else if (key === '--help' || key === '-h') args.help = true
    else if (key === '--report' && value) args.report = value
    else if (key === '--text' && value) args.text = value
    else if (key === '--repo' && value) args.repo = value
    else throw new Error(`argument inconnu ou mal formé : ${arg} (voir --help)`)
  }
  if (args.help) return args
  if (!args.report || !args.text || !args.repo) throw new Error('--report, --text et --repo sont attendus (voir --help)')
  if (args.offline && !args.dryRun) throw new Error('--offline ne va qu’avec --dry-run')
  return args
}

let args
try {
  args = readArgs(process.argv.slice(2))
} catch (error) {
  console.error(`chromium-watch-issue: ${error.message}`)
  process.exit(2)
}
if (args.help) {
  usage()
  process.exit(0)
}

/** gh, without a shell: an argument is never read as a command. Its errors go to the log of the run. */
const gh = (ghArgs, input) => (args.offline ? '[]' : execFileSync('gh', ghArgs, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }))

try {
  const result = openOrUpdateIssue({
    output: JSON.parse(readFileSync(args.report, 'utf8')),
    reportText: readFileSync(args.text, 'utf8'),
    repo: args.repo,
    today: new Date().toISOString().slice(0, 10),
    gh,
    dryRun: args.dryRun
  })
  if (args.dryRun) console.log(JSON.stringify(result, null, 2))
  else for (const action of result.actions) console.log(action.kind === 'create' ? `Issue ouverte : ${action.title}` : action.kind === 'edit' ? `Issue #${action.number} réécrite : ${action.title}` : `Issue #${action.number} commentée : la version a changé`)
} catch (error) {
  console.error(`chromium-watch-issue: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
