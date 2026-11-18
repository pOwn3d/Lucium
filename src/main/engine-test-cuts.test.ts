import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The engine suites run the application from its sources with `--smoke`, and what that switch turns off or replaces is out of their sight: it is
// checked by the end-to-end tests or by hand. docs/architecture.md says what it is (« Ce que le mode `--smoke` débranche »). This file ties every
// line of the application that reads the switch to the words of that paragraph that name what the line does. A new reading fails here until it is
// listed and written in the paragraph; a listed line that is gone, or words that left the paragraph, fail too. So the paragraph stays the whole
// list. Text is read here on purpose: the subject is the text of the code against the text of the documentation.

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

/** A line of the application that reads the switch, and either the words of the paragraph that name what it does, or why it changes nothing. */
interface Reading {
  file: string
  /** A piece of the line, enough to find it. */
  code: string
  /** Words of the paragraph of docs/architecture.md. */
  doc?: string
  /** Why the line is not a cut: it carries the switch to a place listed here, or opens a door only the suites use. */
  plumbing?: string
}

const READINGS: readonly Reading[] = [
  { file: 'src/main/index.ts', code: 'const smoke = isSmokeRun(process.argv)', plumbing: 'reads the switch (runtime.ts: from the sources only)' },
  { file: 'src/main/index.ts', code: 'if (!smoke) logUnhandledRejections()', doc: 'le journal des rejets et des exceptions non capturés' },
  { file: 'src/main/index.ts', code: 'if (!smoke) logUncaughtExceptions(', doc: 'le journal des rejets et des exceptions non capturés' },
  { file: 'src/main/index.ts', code: "force: smoke && (only === '' || only === 'downloadresume')", doc: 'ils se font en un seul flux' },
  { file: 'src/main/index.ts', code: "const measuring = smoke && process.env['LUCIUM_SMOKE_ONLY'] === 'perf'", doc: 'la suite `perf` les démarre' },
  { file: 'src/main/index.ts', code: 'if (smoke) {\n  const skipped', doc: 'remplacés par une ligne de journal), et le trousseau de macOS' },
  { file: 'src/main/index.ts', code: 'isPrimaryInstance(smoke, () => app.requestSingleInstanceLock(), process.argv)', doc: "le verrou d'instance unique" },
  { file: 'src/main/index.ts', code: 'if (smoke) app.exit(1)', doc: 'la passe refuse de démarrer' },
  { file: 'src/main/index.ts', code: 'if (!smoke) void installWidevine(', doc: "l'installation de Widevine" },
  { file: 'src/main/index.ts', code: 'let quitConfirmed = smoke', doc: 'la question avant de quitter' },
  { file: 'src/main/index.ts', code: "if (smoke) app.setPath('downloads',", doc: 'les téléchargements vont dans le dossier de données de la passe' },
  { file: 'src/main/index.ts', code: 'if (!smoke && stateTrusted) sweepBackgroundMedia(', doc: "balayage des fonds d'espace inutilisés" },
  { file: 'src/main/index.ts', code: "else if (!smoke) console.warn('[media] no background is deleted", doc: "balayage des fonds d'espace inutilisés" },
  { file: 'src/main/index.ts', code: 'profileRecordsHistory(sharedStore.get().settings, profileId), !smoke)', doc: "l'historique est écrit d'un bloc" },
  { file: 'src/main/index.ts', code: 'const restoreWindows = !smoke && ', doc: 'la restauration des fenêtres au lancement' },
  { file: 'src/main/index.ts', code: 'touchId: smoke ? NO_TOUCH_ID :', doc: 'Touch ID (pour le verrou' },
  { file: 'src/main/index.ts', code: '...smokeWindowOptions(smoke),', doc: "la fenêtre principale qui peut dépasser l'écran" },
  { file: 'src/main/index.ts', code: 'installPasswordVault({ sharedStore, gates, engine, lock, win, platform, smoke })', plumbing: 'hands the switch to password-wiring.ts, listed below' },
  { file: 'src/main/index.ts', code: 'if (!smoke || measuring) gateWindowMemory(', doc: 'seuil mémoire des fenêtres' },
  { file: 'src/main/index.ts', code: 'if (!smoke || measuring) {\n    gateBackups(gates, backups)', doc: 'copies de la session (et la copie à la fermeture)' },
  { file: 'src/main/index.ts', code: 'if (!smoke || measuring)\n    gateAutoUpdate(', doc: 'mise à jour automatique' },
  { file: 'src/main/index.ts', code: 'if (!smoke) {\n    const littleShortcut = new LittleShortcut(', doc: 'le raccourci global de la mini-fenêtre' },
  { file: 'src/main/index.ts', code: '    smoke,\n    quitClearMarker,', plumbing: 'hands the switch to quit-flow.ts, listed below' },
  { file: 'src/main/index.ts', code: "if (smoke && ['favicons', 'favicons-measure'].includes(", plumbing: 'the window of two suites that read no mouse nor key is made transparent: what they check is the same' },
  { file: 'src/main/index.ts', code: 'if (!smoke) announcePersistenceNotices(', doc: 'les notices de persistance' },
  { file: 'src/main/index.ts', code: 'if (!smoke) {\n      scheduleLaunchSheet(', doc: "la feuille d'accueil ou de nouveautés" },
  { file: 'src/main/index.ts', code: 'if (!smoke) void replayQuitClear(', doc: 'effacement à la fermeture rejoué' },
  { file: 'src/main/index.ts', code: "if (smoke) {\n    // A main-process exception normally opens a native alert", doc: 'la passe a le sien' },
  { file: 'src/main/shell/single-instance.ts', code: 'export function isPrimaryInstance(smoke: boolean,', plumbing: 'the switch as an argument' },
  { file: 'src/main/shell/single-instance.ts', code: 'if (!smoke) return requestLock()', doc: "le verrou d'instance unique" },
  { file: 'src/main/shell/password-wiring.ts', code: 'smoke: boolean', plumbing: 'the switch as a field of the dependencies' },
  { file: 'src/main/shell/password-wiring.ts', code: 'platform, smoke }: PasswordVaultDeps', plumbing: 'the switch read from the dependencies' },
  { file: 'src/main/shell/password-wiring.ts', code: 'if (smoke || !platform.facts.touchId', doc: 'pour le coffre des mots de passe' },
  { file: 'src/main/shell/quit-flow.ts', code: 'smoke: boolean', plumbing: 'the switch as a field of the dependencies' },
  { file: 'src/main/shell/quit-flow.ts', code: 'browser, smoke, quitClearMarker } = deps', plumbing: 'the switch read from the dependencies' },
  { file: 'src/main/shell/quit-flow.ts', code: 'if (clearedOnQuit || smoke ||', doc: "l'effacement des sites à la fermeture" },
  { file: 'src/main/blocking/index.ts', code: "if (argv.includes('--smoke')) return offline('engine')", doc: 'le téléchargement des listes du bloqueur' },
  { file: 'src/main/blocking/service.ts', code: "if (!argv.includes('--smoke')) throw new Error('useForTests", plumbing: 'a door of the suites, refused to the application' },
  { file: 'src/main/shell/favicon-service.ts', code: "if (!argv.includes('--smoke')) throw new Error('allowHostsForTest", plumbing: 'a door of the suites, refused to the application' },
  { file: 'src/main/shell/browser-base.ts', code: "slideEnabled = !process.argv.includes('--smoke')", doc: 'le glissement de la barre latérale' },
  { file: 'src/main/shell/browser-overlay.ts', code: "if (!this.isPrivate() && !process.argv.includes('--smoke')) {\n      this.screenWatch = new ScreenWatch(", doc: "le suivi de l'écran de la fenêtre" }
]

/** Files that name the switch without reading it for the application: its definition, and the checks that the built application refuses it. */
const NAMING_ONLY = new Set(['src/main/runtime.ts', 'src/main/verify-app.ts', 'src/main/code-text-scan.ts'])

/** A line that reads the switch: the variable `smoke` of index.ts and of what it hands it to, or the switch itself in the command line. */
const READS = /(?:^|[^\w.'"`[-])smoke(?![\w'"`\]-])|'--smoke'/

/** The files of the application (not the suites, not the tests) whose code, comments left out, reads the switch, with those lines. */
function readingsInCode(): Map<string, string[]> {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'src/main', 'src/preload', 'src/shared'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((path) => /\.tsx?$/.test(path) && !/\/smoke[^/]*\.ts$/.test(path) && !/\.test\.tsx?$|test-support/.test(path) && !NAMING_ONLY.has(path))
  const found = new Map<string, string[]>()
  for (const file of files.filter((path) => existsSync(join(ROOT, path)))) {
    const lines = read(file)
      .split('\n')
      .filter((line) => READS.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line))
      .map((line) => line.trim())
    if (lines.length > 0) found.set(file, lines)
  }
  return found
}

const paragraph = (): string => {
  const doc = read('docs/architecture.md')
  const start = doc.indexOf('**Ce que le mode `--smoke` débranche')
  const end = doc.indexOf('De même, `smoke-run.ts`', start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return doc.slice(start, end)
}

describe('what the engine test switches off', () => {
  it('is listed: every line of the application that reads the switch is one of the readings above, as many times as it is there', () => {
    const firstLine = (reading: Reading): string => reading.code.split('\n')[0]!.trim()
    const unlisted: string[] = []
    const files = new Set([...readingsInCode().keys(), ...READINGS.map((reading) => reading.file)])
    for (const file of files) {
      const lines = readingsInCode().get(file) ?? []
      const listed = READINGS.filter((reading) => reading.file === file)
      for (const line of lines) if (!listed.some((reading) => line.includes(firstLine(reading)))) unlisted.push(`${file}: ${line}`)
      if (lines.length !== listed.length) unlisted.push(`${file}: ${lines.length} line(s) read the switch, ${listed.length} listed`)
    }
    expect(unlisted).toEqual([])
  })

  it('lists only readings that are still in the code, each once', () => {
    const missing = READINGS.filter((reading) => !read(reading.file).includes(reading.code)).map((reading) => `${reading.file}: ${reading.code}`)
    expect(missing).toEqual([])
    const keys = READINGS.map((reading) => `${reading.file}\n${reading.code}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('is written in docs/architecture.md: the words of every cut are in its paragraph, and every reading is a cut or says why not', () => {
    const text = paragraph()
    expect(READINGS.filter((reading) => !reading.doc && !reading.plumbing)).toEqual([])
    expect(READINGS.filter((reading) => reading.doc && !text.includes(reading.doc)).map((reading) => reading.doc)).toEqual([])
  })
})
