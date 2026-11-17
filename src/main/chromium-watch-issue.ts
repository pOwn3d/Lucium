// The pure part of `scripts/chromium-watch-issue.mjs`: from the report of the daily watch (scripts/electron-watch.mjs --json), the ONE issue
// "Electron X (Chromium Y) disponible" of the repository, opened when there is none and rewritten when there is one. No network and no file
// here: the caller gives the report it read and the function that runs `gh`.
//
// This was a `node -p` fragment inside .github/workflows/chromium-watch.yml, which no test could run: a line starting with `[` after a line
// without a semicolon was read as an index into the line above, the target was read inside its own initializer, and the watch failed every
// day there was something to report. It is a module so that src/main/chromium-watch-issue.test.ts runs it on a sample of the feeds.
//
// What goes into the title, the links and the command of the issue is checked here against a pattern, whatever the readers of
// src/main/electron-watch.ts already refused: the report comes from a file, and those three fields leave the code fence of the body.

import type { WatchExitCode } from './electron-watch'

export const WATCH_LABEL = 'chromium-watch'
const LABEL_DESCRIPTION = "Nouvelle version d'Electron/Chromium détectée"
const LABEL_COLOR = '0E8A16'

// Copies of the constants of src/main/electron-watch.ts on purpose: Node runs this file directly for the script, and a relative import of a
// value would need the `.ts` extension the type checker of the project does not take. The test compares them with the originals.
export const ISSUE_EXIT_PATCH = 10
export const ISSUE_EXIT_MAJOR = 20

/** The version the issue names: a stable Electron, "45.2.3". */
const TARGET_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/
/** The version the repository declares: stable or a prerelease, "45.0.0-alpha.14". */
const INSTALLED_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,40})?$/
/** A Chromium version (four numbers) and a day: copies too, compared by the test like the two codes above. */
const CHROMIUM_VERSION = /^\d{1,4}(?:\.\d{1,6}){3}$/
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
export const ISSUE_PATTERNS = { chromium: CHROMIUM_VERSION, day: ISO_DAY } as const

export class IssueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IssueError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export interface IssueTarget {
  /** The Electron to move to. */
  version: string
  /** Its Chromium. */
  chrome: string
  /** The Electron the repository declares. */
  installed: string
  code: Exclude<WatchExitCode, 0>
}

const field = (value: unknown, pattern: RegExp, name: string): string => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new IssueError(`rapport de veille : ${name} n'a pas la forme attendue (${typeof value === 'string' ? `« ${value.slice(0, 40)} »` : typeof value})`)
  return value
}

/**
 * The three versions of the issue, read from the output of `electron-watch.mjs --json` (`{ kind: 'report', report }`). Throws an `IssueError`
 * when the output is not a report that has something to announce, or when a field is not a version.
 */
export function issueTarget(output: unknown): IssueTarget {
  if (!isRecord(output) || output['kind'] !== 'report' || !isRecord(output['report'])) throw new IssueError("rapport de veille : la sortie n'est pas un rapport")
  const report = output['report']
  const status = report['status']
  if (status !== 'major' && status !== 'patch') throw new IssueError(`rapport de veille : rien à annoncer (état « ${String(status).slice(0, 40)} »)`)
  const holder = status === 'major' ? report['latestMajor'] : report['line']
  const release = isRecord(holder) ? (status === 'major' ? holder['release'] : holder['latest']) : null
  if (!isRecord(release)) throw new IssueError(`rapport de veille : l'état est « ${status} » mais la version cible manque`)
  const installed = isRecord(report['installed']) ? report['installed']['version'] : undefined
  return {
    version: field(release['version'], TARGET_VERSION, 'la version cible'),
    chrome: field(release['chrome'], CHROMIUM_VERSION, 'le Chromium de la cible'),
    installed: field(installed, INSTALLED_VERSION, 'la version installée'),
    code: status === 'major' ? ISSUE_EXIT_MAJOR : ISSUE_EXIT_PATCH
  }
}

export const issueTitle = (target: IssueTarget): string => `Electron ${target.version} (Chromium ${target.chrome}) disponible`

/** A code fence no line of the text can close: one backtick more than the longest run the text holds (the report quotes release notes). */
const fenceFor = (text: string): string => '`'.repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length + 1)))

/** The body of the issue, in French. `reportText` is the text report (formatReport), shown as is inside a code fence; `today` is YYYY-MM-DD. */
export function issueBody(target: IssueTarget, reportText: string, today: string): string {
  if (!ISO_DAY.test(today)) throw new IssueError(`rapport de veille : la date du jour n'est pas AAAA-MM-JJ (« ${today.slice(0, 40)} »)`)
  const { version, chrome, installed, code } = target
  const fence = fenceFor(reportText)
  return [
    `Veille quotidienne (\`.github/workflows/chromium-watch.yml\`, \`scripts/electron-watch.mjs\`) : Lucium déclare Electron **${installed}**, Electron **${version}** (Chromium ${chrome}) est publié. Code ${code} (${code === ISSUE_EXIT_MAJOR ? 'nouvelle majeure' : 'mineure ou correctif'}).`,
    '',
    `${fence}text`,
    reportText.replace(/\s+$/, ''),
    fence,
    '',
    `- Notes de version : https://github.com/electron/electron/releases/tag/v${version}`,
    `- Changements cassants : https://github.com/electron/electron/blob/v${version}/docs/breaking-changes.md`,
    '- castLabs ECS (variante DRM) : https://github.com/castlabs/electron-releases/releases',
    '- Chrome stable : https://chromiumdash.appspot.com/releases?platform=Mac',
    '',
    `Préparer sur un Mac (rien n'est validé ni publié par le script) : \`node scripts/electron-upgrade.mjs ${version}\`, puis la liste de contrôle de \`docs/mise-a-jour-chromium.md\`.`,
    '',
    `_Mise à jour le ${today} ; ce texte est réécrit chaque jour tant que la version n'est pas adoptée ; fermer l'issue une fois la montée publiée._`,
    ''
  ].join('\n')
}

export interface OpenIssue {
  number: number
  title: string
}

/** The answer of `gh issue list --json number,title`: the open issues of the watch, oldest first. */
export function readOpenIssues(json: string): OpenIssue[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new IssueError("gh issue list : la réponse n'est pas du JSON")
  }
  if (!Array.isArray(raw)) throw new IssueError("gh issue list : un tableau JSON était attendu")
  const out: OpenIssue[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry['number'] !== 'number' || !Number.isInteger(entry['number']) || typeof entry['title'] !== 'string') throw new IssueError('gh issue list : une entrée sans numéro ni titre')
    out.push({ number: entry['number'], title: entry['title'] })
  }
  return out.sort((a, b) => a.number - b.number)
}

export type IssueAction =
  | { kind: 'create'; title: string }
  | { kind: 'edit'; number: number; title: string }
  /** One comment when the version moved since the issue was opened; nothing when only the day changed. */
  | { kind: 'comment'; number: number; body: string }

/** Never a second issue: with one open already (the oldest when a hand opened more), it is rewritten, and commented when the version moved. */
export function planIssue(open: readonly OpenIssue[], title: string): IssueAction[] {
  const existing = open[0]
  if (!existing) return [{ kind: 'create', title }]
  const actions: IssueAction[] = [{ kind: 'edit', number: existing.number, title }]
  if (existing.title !== title) actions.push({ kind: 'comment', number: existing.number, body: `Nouvelle version depuis l'ouverture : **${title}** (était : ${existing.title}).` })
  return actions
}

/** Runs `gh` with these arguments (never through a shell) and gives its standard output back; `input` is its standard input. */
export type Gh = (args: string[], input?: string) => string

export interface IssueRun {
  /** The parsed output of `electron-watch.mjs --json`. */
  output: unknown
  /** The text report (formatReport). */
  reportText: string
  /** `owner/name`. */
  repo: string
  /** YYYY-MM-DD. */
  today: string
  gh: Gh
  /** Reads the open issue and says what would be done, without writing anything. */
  dryRun?: boolean
}

export interface IssueResult {
  title: string
  body: string
  actions: IssueAction[]
}

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/

/** Opens the issue of the watch, or rewrites the open one. Everything is validated before the first call to `gh`. */
export function openOrUpdateIssue(run: IssueRun): IssueResult {
  if (!REPO.test(run.repo)) throw new IssueError(`dépôt inattendu : « ${run.repo.slice(0, 60)} » (attendu : propriétaire/nom)`)
  const target = issueTarget(run.output)
  const title = issueTitle(target)
  const body = issueBody(target, run.reportText, run.today)
  const repo = ['--repo', run.repo]
  if (!run.dryRun) run.gh(['label', 'create', WATCH_LABEL, '--description', LABEL_DESCRIPTION, '--color', LABEL_COLOR, '--force', ...repo])
  const actions = planIssue(readOpenIssues(run.gh(['issue', 'list', ...repo, '--label', WATCH_LABEL, '--state', 'open', '--limit', '100', '--json', 'number,title'])), title)
  if (run.dryRun) return { title, body, actions }
  for (const action of actions) {
    if (action.kind === 'create') run.gh(['issue', 'create', ...repo, '--title', action.title, '--body-file', '-', '--label', WATCH_LABEL], body)
    else if (action.kind === 'edit') run.gh(['issue', 'edit', String(action.number), ...repo, '--title', action.title, '--body-file', '-'], body)
    else run.gh(['issue', 'comment', String(action.number), ...repo, '--body', action.body])
  }
  return { title, body, actions }
}
