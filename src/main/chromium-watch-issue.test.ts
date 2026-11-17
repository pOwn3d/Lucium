import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ISSUE_EXIT_MAJOR,
  ISSUE_EXIT_PATCH,
  ISSUE_PATTERNS,
  IssueError,
  WATCH_LABEL,
  issueBody,
  issueTarget,
  issueTitle,
  openOrUpdateIssue,
  planIssue,
  readOpenIssues,
  type Gh
} from './chromium-watch-issue'
import { CHROMIUM_VERSION, EXIT_MAJOR, EXIT_PATCH, ISO_DAY, WATCH_SOURCES, formatReport, readChromeReleases, readEcsReleases, readElectronReleases, readReleaseNotes, readSchedule, watch, type FetchJson } from './electron-watch'

// ---- A sample of the five feeds, in the shape of the real ones: 45.2.1 is declared, 45.2.3 is out on the line, 46.0.0 is the next major ----

const NOW = new Date('2026-11-10T06:28:00Z')
const TODAY = '2026-11-10'

const electron = (version: string, date: string, chrome: string) => ({ version, date, chrome, node: '24.22.0', v8: '15.6.75.19', files: ['darwin-arm64'] })
const RELEASES_MAJOR = [
  electron('47.0.0-nightly.20261109', '2026-11-09', '160.0.8200.0'),
  electron('46.0.0', '2026-11-08', '158.0.8120.40'),
  electron('45.2.3', '2026-11-07', '156.0.8078.112'),
  electron('45.2.2', '2026-11-05', '156.0.8078.99'),
  electron('45.2.1', '2026-11-03', '156.0.8078.90'),
  electron('44.9.3', '2026-10-21', '152.0.7977.167')
]
const RELEASES_PATCH = RELEASES_MAJOR.filter((r) => !r.version.startsWith('46.') && !r.version.startsWith('47.'))
const RELEASES_UP_TO_DATE = RELEASES_PATCH.filter((r) => r.version !== '45.2.3' && r.version !== '45.2.2')
const CHROME = [{ channel: 'Stable', version: '157.0.8103.51', milestone: 157, platform: 'Mac', time: Date.parse('2026-11-04') }]
const ECS = [{ tag_name: 'v45.2.1+wvcus', published_at: '2026-11-05T09:00:00Z' }]
const NOTES = [
  { tag_name: 'v45.2.3', published_at: '2026-11-07T18:00:00Z', body: '> Fix for https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9\n\n* Backported fixes from upstream Chromium. [#1](https://example.org)' },
  { tag_name: 'v45.2.1', published_at: '2026-11-03T18:00:00Z', body: '* Updated Chromium to 156.0.8078.90.' }
]
const SCHEDULE = [{ version: '46.0.0', stableDate: '2026-11-08', chromiumVersion: 158, eolDate: '2027-06-22', status: 'stable' }]

const fetcher = (releases: unknown, notes: unknown = NOTES): FetchJson => {
  const byUrl = new Map<string, unknown>([
    [WATCH_SOURCES.releases, releases],
    [WATCH_SOURCES.chrome, CHROME],
    [WATCH_SOURCES.ecs, ECS],
    [WATCH_SOURCES.notes, notes],
    [WATCH_SOURCES.schedule, SCHEDULE]
  ])
  return async (url) => {
    if (!byUrl.has(url)) throw new Error(`unexpected url ${url}`)
    return byUrl.get(url)
  }
}

/** What the workflow has in hand at its second step: report.json as scripts/electron-watch.mjs --json writes it (so through JSON), and report.txt. */
const watched = async (releases: unknown, notes?: unknown): Promise<{ output: unknown; reportText: string }> => {
  const outcome = await watch('45.2.1', fetcher(releases, notes), NOW)
  if (outcome.kind !== 'report') throw new Error(`the sample feeds were refused: ${outcome.message}`)
  return { output: JSON.parse(JSON.stringify({ ...outcome, notes: [], declared: { declared: '45.2.1', installed: null, spec: '45.2.1' } })), reportText: `${formatReport(outcome.report)}\n` }
}

/** A `gh` that answers the list of open issues it was given and remembers every call. */
const fakeGh = (open: { number: number; title: string }[] = []) => {
  const calls: { args: string[]; input: string | undefined }[] = []
  const gh: Gh = (args, input) => {
    calls.push({ args, input })
    return args[0] === 'issue' && args[1] === 'list' ? JSON.stringify(open) : ''
  }
  return { gh, calls, verbs: () => calls.map((c) => c.args.slice(0, 2).join(' ')) }
}

const REPO = 'pOwn3d/Lucium'

describe('issueTarget: the version the issue announces, from the report of the sample feeds', () => {
  it('names the newest release of the installed line when a patch is out', async () => {
    const { output } = await watched(RELEASES_PATCH)
    const target = issueTarget(output)
    expect(target).toEqual({ version: '45.2.3', chrome: '156.0.8078.112', installed: '45.2.1', code: 10 })
    expect(issueTitle(target)).toBe('Electron 45.2.3 (Chromium 156.0.8078.112) disponible')
  })

  it('names the newest major when one is out, not the patch of the line', async () => {
    const { output } = await watched(RELEASES_MAJOR)
    expect(issueTarget(output)).toEqual({ version: '46.0.0', chrome: '158.0.8120.40', installed: '45.2.1', code: 20 })
  })

  it('keeps the two exit codes and the two patterns it copies equal to the ones of the watch', () => {
    expect([ISSUE_EXIT_PATCH, ISSUE_EXIT_MAJOR]).toEqual([EXIT_PATCH, EXIT_MAJOR])
    expect([ISSUE_PATTERNS.chromium.source, ISSUE_PATTERNS.day.source]).toEqual([CHROMIUM_VERSION.source, ISO_DAY.source])
  })

  it('refuses a report with nothing to announce, an error of the watch, and a report without its target', async () => {
    const { output } = await watched(RELEASES_UP_TO_DATE)
    expect(() => issueTarget(output)).toThrow(/rien à annoncer \(état « up-to-date »\)/)
    expect(() => issueTarget({ kind: 'error', exitCode: 30, message: 'x' })).toThrow(IssueError)
    expect(() => issueTarget(null)).toThrow(/n'est pas un rapport/)
    expect(() => issueTarget({ kind: 'report', report: { status: 'patch', line: { latest: null }, installed: { version: '45.2.1' } } })).toThrow(/la version cible manque/)
  })

  it('refuses a version, a Chromium or an installed version that is not one (a report file is not trusted)', async () => {
    const tampered = async (change: (report: any) => void): Promise<unknown> => {
      const { output } = await watched(RELEASES_PATCH)
      change((output as { report: unknown }).report)
      return output
    }
    await expect(tampered((r) => (r.line.latest.chrome = '156 [clic](https://example.org) @someone'))).resolves.toSatisfy((o) => {
      expect(() => issueTarget(o)).toThrow(/le Chromium de la cible n'a pas la forme attendue/)
      return true
    })
    expect(() => issueTarget({ kind: 'report', report: { status: 'patch', line: { latest: { version: '45.2.3\n# titre', chrome: '156.0.8078.112' } }, installed: { version: '45.2.1' } } })).toThrow(/la version cible n'a pas la forme attendue/)
    expect(() => issueTarget({ kind: 'report', report: { status: 'patch', line: { latest: { version: '45.2.3', chrome: '156.0.8078.112' } }, installed: { version: '45.2.1 && rm' } } })).toThrow(/la version installée n'a pas la forme attendue/)
    expect(() => issueTarget({ kind: 'report', report: { status: 'patch', line: { latest: { version: '45.2.3', chrome: 156 } }, installed: { version: '45.2.1' } } })).toThrow(/le Chromium de la cible n'a pas la forme attendue \(number\)/)
    // A prerelease is a version the repository may declare (the DRM variant ran on 45.0.0-alpha.14).
    expect(issueTarget({ kind: 'report', report: { status: 'patch', line: { latest: { version: '45.2.3', chrome: '156.0.8078.112' } }, installed: { version: '45.0.0-alpha.14' } } }).installed).toBe('45.0.0-alpha.14')
  })
})

describe('issueBody', () => {
  it('says the two versions, shows the report in a fence, links the notes of the target and dates the text', async () => {
    const { output, reportText } = await watched(RELEASES_PATCH)
    const body = issueBody(issueTarget(output), reportText, TODAY)
    expect(body).toContain('Lucium déclare Electron **45.2.1**, Electron **45.2.3** (Chromium 156.0.8078.112) est publié. Code 10 (mineure ou correctif).')
    expect(body).toContain('```text\nElectron installé : 45.2.1 (Chromium 156.0.8078.90')
    expect(body).toContain('code de sortie 10\n```\n')
    expect(body).toContain('https://github.com/electron/electron/releases/tag/v45.2.3\n')
    expect(body).toContain('`node scripts/electron-upgrade.mjs 45.2.3`')
    expect(body).toContain('_Mise à jour le 2026-11-10 ;')
  })

  it('says a new major is one', async () => {
    const { output, reportText } = await watched(RELEASES_MAJOR)
    expect(issueBody(issueTarget(output), reportText, TODAY)).toContain('Code 20 (nouvelle majeure).')
  })

  it('closes the report with a fence longer than any run of backticks a release note brought into it', async () => {
    const hostile = [{ ...NOTES[0], body: '> CVE-2026-0001 ```` then text that would leave the fence' }, NOTES[1]]
    const { output, reportText } = await watched(RELEASES_PATCH, hostile)
    expect(reportText).toContain('````')
    const body = issueBody(issueTarget(output), reportText, TODAY)
    expect(body).toContain('`````text\n')
    // The opening fence and the closing one, nothing else that long.
    expect(body.match(/`{5,}/g)).toEqual(['`````', '`````'])
  })

  it('refuses a day that is not one', async () => {
    const { output, reportText } = await watched(RELEASES_PATCH)
    expect(() => issueBody(issueTarget(output), reportText, 'today')).toThrow(/AAAA-MM-JJ/)
  })
})

describe('one issue only', () => {
  const TITLE = 'Electron 45.2.3 (Chromium 156.0.8078.112) disponible'

  it('opens the issue when none is open', () => {
    expect(planIssue([], TITLE)).toEqual([{ kind: 'create', title: TITLE }])
  })

  it('rewrites the open one without a word when only the day changed, and comments once when the version moved', () => {
    expect(planIssue([{ number: 12, title: TITLE }], TITLE)).toEqual([{ kind: 'edit', number: 12, title: TITLE }])
    const old = 'Electron 45.2.2 (Chromium 156.0.8078.99) disponible'
    expect(planIssue([{ number: 12, title: old }], TITLE)).toEqual([
      { kind: 'edit', number: 12, title: TITLE },
      { kind: 'comment', number: 12, body: `Nouvelle version depuis l'ouverture : **${TITLE}** (était : ${old}).` }
    ])
  })

  it('reads the answer of gh oldest first, and refuses one that is not a list of issues', () => {
    expect(readOpenIssues('[{"number":31,"title":"b"},{"number":12,"title":"a"}]').map((i) => i.number)).toEqual([12, 31])
    expect(() => readOpenIssues('not json')).toThrow(/n'est pas du JSON/)
    expect(() => readOpenIssues('{"number":1}')).toThrow(/tableau JSON/)
    expect(() => readOpenIssues('[{"number":"1","title":"a"}]')).toThrow(/sans numéro ni titre/)
  })
})

describe('openOrUpdateIssue: the calls to gh', () => {
  it('creates the label then the issue, with the body on the standard input, when no issue is open', async () => {
    const { gh, calls, verbs } = fakeGh()
    const result = openOrUpdateIssue({ ...(await watched(RELEASES_PATCH)), repo: REPO, today: TODAY, gh })
    expect(verbs()).toEqual(['label create', 'issue list', 'issue create'])
    expect(calls[2]).toEqual({ args: ['issue', 'create', '--repo', REPO, '--title', 'Electron 45.2.3 (Chromium 156.0.8078.112) disponible', '--body-file', '-', '--label', WATCH_LABEL], input: result.body })
    expect(calls[1]?.args).toEqual(['issue', 'list', '--repo', REPO, '--label', WATCH_LABEL, '--state', 'open', '--limit', '100', '--json', 'number,title'])
  })

  it('never opens a second issue: the day after, the open one is edited, and nothing is created', async () => {
    const { gh, calls, verbs } = fakeGh([{ number: 12, title: 'Electron 45.2.3 (Chromium 156.0.8078.112) disponible' }])
    openOrUpdateIssue({ ...(await watched(RELEASES_PATCH)), repo: REPO, today: '2026-11-11', gh })
    expect(verbs()).toEqual(['label create', 'issue list', 'issue edit'])
    expect(calls[2]?.args.slice(0, 3)).toEqual(['issue', 'edit', '12'])
    expect(calls[2]?.input).toContain('_Mise à jour le 2026-11-11 ;')
  })

  it('edits and comments the oldest open issue when a newer version came out since', async () => {
    const { gh, calls, verbs } = fakeGh([
      { number: 31, title: 'opened by hand' },
      { number: 12, title: 'Electron 45.2.2 (Chromium 156.0.8078.99) disponible' }
    ])
    openOrUpdateIssue({ ...(await watched(RELEASES_PATCH)), repo: REPO, today: TODAY, gh })
    expect(verbs()).toEqual(['label create', 'issue list', 'issue edit', 'issue comment'])
    expect(calls[3]?.args).toEqual(['issue', 'comment', '12', '--repo', REPO, '--body', "Nouvelle version depuis l'ouverture : **Electron 45.2.3 (Chromium 156.0.8078.112) disponible** (était : Electron 45.2.2 (Chromium 156.0.8078.99) disponible)."])
  })

  it('calls gh for nothing when the report or the repository is refused, and writes nothing in a dry run', async () => {
    const refused = fakeGh()
    const sample = await watched(RELEASES_PATCH)
    expect(() => openOrUpdateIssue({ ...sample, output: { kind: 'error' }, repo: REPO, today: TODAY, gh: refused.gh })).toThrow(IssueError)
    expect(() => openOrUpdateIssue({ ...sample, repo: 'lucium --web', today: TODAY, gh: refused.gh })).toThrow(/dépôt inattendu/)
    expect(refused.calls).toEqual([])

    const dry = fakeGh([{ number: 12, title: 'x' }])
    const result = openOrUpdateIssue({ ...sample, repo: REPO, today: TODAY, gh: dry.gh, dryRun: true })
    expect(dry.verbs()).toEqual(['issue list'])
    expect(result.actions.map((a) => a.kind)).toEqual(['edit', 'comment'])
  })
})

describe('the readers refuse the free text a feed would put in the issue', () => {
  it('refuses a release whose chrome or date is not a Chromium version or a day', () => {
    expect(() => readElectronReleases([{ version: '45.2.3', date: '2026-11-07', chrome: '156.0.8078.112 [clic](https://example.org)' }])).toThrow(/entrée 0 \(45\.2\.3\) a un chrome qui n'est pas une version de Chromium/)
    expect(() => readElectronReleases([{ version: '45.2.3', date: '2026-11-07', chrome: '156' }])).toThrow(/chrome/)
    expect(() => readElectronReleases([{ version: '45.2.3', date: 'hier @someone', chrome: '156.0.8078.112' }])).toThrow(/entrée 0 \(45\.2\.3\) a une date qui n'est pas AAAA-MM-JJ/)
  })

  it('drops a Node or a V8 that is not a version, and gives the version back trimmed', () => {
    const [one] = readElectronReleases([{ version: ' 45.2.3 ', date: '2026-11-07', chrome: '156.0.8078.112', node: '24 <b>', v8: '14.2.231.21-electron.0' }])
    expect(one).toMatchObject({ version: '45.2.3', node: '', v8: '14.2.231.21-electron.0' })
  })

  it('refuses a Chrome release whose version or milestone is not one', () => {
    expect(() => readChromeReleases([{ version: '157.0.8103.51 `x`', milestone: 157 }])).toThrow(/entrée 0 a une version ou un jalon qui n'en est pas un/)
    expect(() => readChromeReleases([{ version: '157.0.8103.51', milestone: 157.5 }])).toThrow(/jalon/)
  })

  it('reads a day only from a timestamp, for castLabs and for the release notes', () => {
    expect(readEcsReleases([{ tag_name: 'v45.2.1+wvcus', published_at: '<img src=x>' }])[0]?.date).toBe('')
    expect(readEcsReleases([{ tag_name: 'v45.2.1+wvcus', published_at: '2026-11-05T09:00:00Z' }])[0]?.date).toBe('2026-11-05')
    expect(readReleaseNotes([{ tag_name: 'v45.2.3', published_at: 'soon, **really**' }])[0]?.date).toBe('')
  })

  it('refuses a schedule whose stable date is not a day, and drops an end of life or a state that is not one', () => {
    expect(() => readSchedule([{ version: '46.0.0', stableDate: 'Q1 [2027](x)' }])).toThrow(/stableDate qui n'est pas AAAA-MM-JJ/)
    expect(readSchedule([{ version: '46.0.0', stableDate: '2027-01-05', eolDate: 'never!', status: 'Stable <b>', chromiumVersion: 160.5 }])[0]).toMatchObject({ eolDate: '', status: '', chromium: 0 })
  })
})

// ---- The script itself, run by Node as the workflow runs it (with --offline: no gh, no network) ----

describe('scripts/chromium-watch-issue.mjs', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'chromium-watch-issue-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const files = async (releases: unknown, change: (output: any) => void = () => {}): Promise<string[]> => {
    const { output, reportText } = await watched(releases)
    change(output)
    writeFileSync(join(dir, 'report.json'), JSON.stringify(output, null, 2))
    writeFileSync(join(dir, 'report.txt'), reportText)
    return [`--report=${join(dir, 'report.json')}`, `--text=${join(dir, 'report.txt')}`]
  }
  const script = (args: string[]) => spawnSync(process.execPath, ['scripts/chromium-watch-issue.mjs', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: '' } })

  it('says which issue it would open for the sample feeds', async () => {
    const out = execFileSync(process.execPath, ['scripts/chromium-watch-issue.mjs', ...(await files(RELEASES_PATCH)), `--repo=${REPO}`, '--dry-run', '--offline'], { cwd: root, encoding: 'utf8' })
    const result = JSON.parse(out) as { title: string; body: string; actions: unknown[] }
    expect(result.title).toBe('Electron 45.2.3 (Chromium 156.0.8078.112) disponible')
    expect(result.actions).toEqual([{ kind: 'create', title: result.title }])
    expect(result.body).toContain('Electron **45.2.3** (Chromium 156.0.8078.112) est publié')
  })

  it('fails with a sentence, and without a stack, on a report it refuses', async () => {
    const run = script([...(await files(RELEASES_PATCH, (o) => (o.report.line.latest.chrome = 'x y z'))), `--repo=${REPO}`, '--dry-run', '--offline'])
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/^chromium-watch-issue: rapport de veille : le Chromium de la cible n'a pas la forme attendue \(« x y z »\)\n$/)
    expect(run.stdout).toBe('')
  })

  it('refuses a missing or an unknown argument with exit code 2', async () => {
    const args = await files(RELEASES_PATCH)
    expect(script(args).status).toBe(2)
    expect(script([...args, `--repo=${REPO}`, '--dryrun']).stderr).toMatch(/argument inconnu ou mal formé : --dryrun/)
    expect(script([...args, `--repo=${REPO}`, '--offline']).stderr).toMatch(/--offline ne va qu’avec --dry-run/)
  })
})

describe('.github/workflows/chromium-watch.yml', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../../.github/workflows/chromium-watch.yml', import.meta.url)), 'utf8')
  const step = workflow.slice(workflow.indexOf('- name: Open or update the issue'))

  it('opens the issue with the tested script, and writes no JavaScript of its own for it', () => {
    expect(step.length).toBeGreaterThan(100)
    expect(step).toMatch(/\n {8}run: node scripts\/chromium-watch-issue\.mjs --report=report\.json --text=report\.txt --repo="\$REPO"\n/)
    expect(step).not.toMatch(/node (-p|-e|--eval|--print)\b/)
    expect(step).not.toMatch(/\bgh (issue|label)\b/)
    expect(step).toContain("if: steps.watch.outputs.code == '10' || steps.watch.outputs.code == '20'")
  })
})
