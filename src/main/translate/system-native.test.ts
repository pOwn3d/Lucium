// The helper of the system's translation (native/system-translate/) is Swift and needs the languages of the system: no test runs it. What makes it
// safe is read here, in its source, so that a change that loosens it fails: a session that cannot download, nothing in an argument or a log, the
// same limits as the main process, nothing before macOS 26, no request of its own, its protocol (lines with ids, the caller checked again before
// each request, quitting by itself); and the build script, which gives it no entitlement. (Run for real by hand: docs/traduction-locale.md § 2.1.)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SYSTEM_TRANSLATE_HELPER_BUNDLE, SYSTEM_TRANSLATE_HELPER_EXECUTABLE, SYSTEM_TRANSLATE_HELPER_IDENTIFIER, SYSTEM_TRANSLATE_IDLE_MS, SYSTEM_TRANSLATE_LIMITS, SYSTEM_TRANSLATE_MIN_MACOS, SYSTEM_TRANSLATE_PROTOCOL } from './system'

const native = (name: string): string => readFileSync(fileURLToPath(new URL(`../../../native/system-translate/${name}`, import.meta.url)), 'utf8')
/** The code without the lines that are only comments. */
const code = (text: string, comment = '//'): string =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(comment))
    .join('\n')

const swift = code(native('main.swift'))
const caller = code(readFileSync(fileURLToPath(new URL('../../../native/shared/caller.swift', import.meta.url)), 'utf8'))
/** The body of a Swift function, from its signature to the next top-level `func` (or `@available` line that opens one). */
const fn = (name: string): string => {
  const start = swift.indexOf(`func ${name}(`)
  expect(start, `func ${name} is not in main.swift any more`).toBeGreaterThanOrEqual(0)
  const next = swift.slice(start + 1).search(/\n(?:@available[^\n]*\n)?func /)
  return swift.slice(start, next < 0 ? undefined : start + 1 + next)
}
/** The body of `Input.next`, which reads the standard input line by line. */
const reader = (): string => {
  const start = swift.indexOf('func next() throws -> Data? {')
  expect(start, 'Input.next is not in main.swift any more').toBeGreaterThanOrEqual(0)
  return swift.slice(start, swift.indexOf('\nfunc ', start))
}

describe('the translation helper (main.swift)', () => {
  it('translates only with a session made for installed languages, which cannot ask for a download, and never asks for one', () => {
    expect(swift.match(/TranslationSession\(/g)).toHaveLength(1)
    expect(swift).toMatch(/TranslationSession\(installedSource: Locale\.Language\(identifier: from\), target: Locale\.Language\(identifier: to\)\)/)
    expect(swift).not.toMatch(/prepareTranslation|translationTask|\.Configuration\(|SwiftUI/)
    const session = fn('session')
    // The guard of "never a download", before the session is kept or used.
    const guard = session.indexOf('guard !session.canRequestDownloads else')
    expect(guard).toBeGreaterThan(session.indexOf('TranslationSession('))
    expect(session.indexOf('kept = (pair: pair, session: session)')).toBeGreaterThan(guard)
    expect(session.indexOf('guard await session.isReady else { throw Failure(code: "not-installed") }')).toBeGreaterThan(guard)
    // A pair that is only supported is refused before a session is made.
    expect(session.indexOf('case .supported: throw Failure(code: "not-installed")')).toBeLessThan(session.indexOf('TranslationSession('))
    // A translation goes through that function only: no session is made or used another way.
    const translate = fn('translate')
    expect(translate.indexOf('let session = try await session(from: from, to: to)')).toBeGreaterThanOrEqual(0)
    expect(translate.indexOf('let session = try await session(from: from, to: to)')).toBeLessThan(translate.indexOf('session.translations(from:'))
  })

  it('keeps the session of a pair for the next batches of the run, and drops it when a translation fails or another pair is asked', () => {
    expect(fn('session')).toMatch(/if let kept, kept\.pair == pair, let session = kept\.session as\? TranslationSession \{ return session \}\n\s*kept = nil/)
    expect(fn('translate')).toMatch(/\} catch \{\n\s*kept = nil\n\s*throw error/)
  })

  it('answers in the order of the texts, each answer checked against the text it names', () => {
    const translate = fn('translate')
    expect(translate).toMatch(/clientIdentifier: String\(index\)/)
    expect(translate).toMatch(/guard responses\.count == requests\.count else/)
    expect(translate).toMatch(/guard response\.clientIdentifier == String\(positions\[k\]\) else/)
  })

  it('reaches the framework only on macOS 26 and later, and says "unavailable" before', () => {
    expect(fn('respond')).toMatch(new RegExp(`guard #available\\(macOS ${SYSTEM_TRANSLATE_MIN_MACOS}\\.0, \\*\\) else \\{ throw Failure\\(code: "unavailable"\\) \\}`))
    for (const name of ['status', 'session', 'translate', 'failureOf', 'statusName']) expect(swift, name).toMatch(new RegExp(`@available\\(macOS ${SYSTEM_TRANSLATE_MIN_MACOS}\\.0, \\*\\)\\nfunc ${name}\\(`))
  })

  it('has the limits of the main process, checked before the framework sees anything', () => {
    expect(swift).toContain(`let maxTexts = ${SYSTEM_TRANSLATE_LIMITS.texts}\n`)
    expect(swift).toContain(`let maxTextChars = ${SYSTEM_TRANSLATE_LIMITS.textChars}\n`)
    expect(swift).toContain(`let maxTotalChars = ${String(SYSTEM_TRANSLATE_LIMITS.totalChars)}\n`)
    expect(swift).toContain(`let inputLimit = 256 * 1024\n`)
    expect(SYSTEM_TRANSLATE_LIMITS.inputBytes).toBe(256 * 1024)
    // Counted as JavaScript counts them, so that both sides agree.
    expect(fn('texts')).toMatch(/text\.utf16\.count/)
    const respond = fn('respond')
    expect(respond.indexOf('try texts(request)')).toBeGreaterThan(0)
    expect(respond.indexOf('try texts(request)')).toBeLessThan(respond.indexOf('translate(batch'))
    // Each line is bounded as it is read: a line longer than the limit is not a request, and nothing is read much further ahead than that.
    const next = reader()
    expect(next).toMatch(/guard line\.count <= inputLimit else \{ throw Failure\(code: "too-large"\) \}/)
    expect(next).toMatch(/guard buffer\.count <= inputLimit else \{ throw Failure\(code: "too-large"\) \}/)
    expect(next).toMatch(/let count = read\(descriptor, &chunk, chunk\.count\)/)
    expect(next).toMatch(/\[UInt8\]\(repeating: 0, count: 16 \* 1024\)/)
  })

  it('speaks the protocol this side reads in its bundle, greets first, and keeps the first protocol for a request without a greeting', () => {
    expect(swift).toContain(`let protocolVersion = ${SYSTEM_TRANSLATE_PROTOCOL}\n`)
    expect(native('Info.plist')).toMatch(new RegExp(`<key>LuciumTranslateProtocol</key>\\s*<integer>${SYSTEM_TRANSLATE_PROTOCOL}</integer>`))
    const run = fn('run')
    expect(run).toMatch(/guard first\["command"\] as\? String == "hello" else \{\n\s*answer\(await respond\(first\)\)\n\s*return\n\s*\}/)
    expect(run).toMatch(/guard first\["protocol"\] as\? Int == protocolVersion else \{\n\s*answer\(\["ok": false, "error": "invalid"\]\)\n\s*return/)
    expect(run.indexOf('answer(["ok": true, "protocol": protocolVersion])')).toBeGreaterThan(run.indexOf('guard first["protocol"]'))
    // Each request names its id, a whole number within bounds; one that does not ends the run, said without an id.
    expect(run).toMatch(/guard let id = request\["id"\] as\? Int, id > 0, id <= maxId else \{\n\s*answer\(\["ok": false, "error": "invalid"\]\)\n\s*return/)
    expect(run.indexOf('reply["id"] = id')).toBeGreaterThan(run.indexOf('await respond(request)'))
  })

  it('quits by itself: at the end of its input, after a while without a byte, at a line it cannot read', () => {
    expect(swift).toContain('let idleLimitMs: Int32 = 120_000\n')
    // The main process closes it sooner.
    expect(SYSTEM_TRANSLATE_IDLE_MS).toBeLessThan(120_000)
    expect(reader()).toMatch(/let ready = poll\(&waiting, 1, idleLimitMs\)\n\s*if ready == 0 \{ return nil \}/)
    const nextRequest = fn('nextRequest')
    expect(nextRequest).toMatch(/guard let line = try input\.next\(\) else \{ return nil \}/)
    expect(nextRequest).toMatch(/catch let failure as Failure \{\n\s*answer\(\["ok": false, "error": failure\.code\]\)\n\s*return nil/)
    expect(fn('run')).toMatch(/while let request = nextRequest\(input\) \{/)
    expect(swift).toMatch(/\nawait run\(\)\nexit\(0\)\n/)
  })

  it('never reads an argument, never logs, never writes a description of an error, and makes no request of its own', () => {
    expect(swift).not.toMatch(/CommandLine|ProcessInfo\.processInfo\.arguments/)
    expect(swift).not.toMatch(/\bprint\(|NSLog|os_log|Logger\(|standardError|fputs|debugPrint|dump\(/)
    expect(swift).not.toMatch(/localizedDescription|errorDescription|failureReason|String\(describing/)
    expect(swift).not.toMatch(/URLSession|URLRequest|import Network|NWConnection|CFNetwork/)
    expect(swift).toMatch(/FileHandle\.standardInput/)
    // The only things written: the answer of `run`.
    expect(swift.match(/FileHandle\.standardOutput\.write/g)).toHaveLength(1)
  })

  it('translates for Lucium only: the caller is checked before the request is even read, and again before each request of a run', () => {
    const run = fn('run')
    const guard = run.indexOf('guard let caller = verifiedCaller(adHoc: .carrierApplication) else {\n    answer(["ok": false, "error": "caller"])\n    return\n  }')
    expect(guard).toBeGreaterThan(0)
    expect(run.indexOf('Input()')).toBeGreaterThan(guard)
    expect(run.indexOf('nextRequest(input)')).toBeGreaterThan(guard)
    const again = run.indexOf('guard stillCaller(caller) else {\n      answer(["ok": false, "error": "caller"])\n      return\n    }')
    expect(again).toBeGreaterThan(run.indexOf('while let request = nextRequest(input) {'))
    expect(again).toBeLessThan(run.indexOf('await respond(request)'))
    expect(native('build.sh')).toContain('"$here/main.swift" "$here/../shared/caller.swift"')
    // The check it is compiled with logs nothing and reads no argument.
    expect(caller).not.toMatch(/CommandLine|ProcessInfo\.processInfo\.arguments|\bprint\(|NSLog|os_log|standardError/)
  })

  it('reads a language strictly to its end (`\\z`: in ICU `$` lets a final line feed through)', () => {
    expect(swift).toContain('let languagePattern = "^[a-z]{2,3}\\\\z"')
  })

  it('agrees with this side on the names of the bundle and the program', () => {
    const plist = native('Info.plist')
    expect(plist).toContain(`<key>CFBundleExecutable</key>\n    <string>${SYSTEM_TRANSLATE_HELPER_EXECUTABLE}</string>`)
    expect(plist).toContain(`<string>${SYSTEM_TRANSLATE_HELPER_IDENTIFIER}</string>`)
    expect(plist).toMatch(/<key>LSUIElement<\/key>\n\s*<true\/>/)
  })
})

describe('the build of the helper (build.sh)', () => {
  const script = code(native('build.sh'), '#')

  it('links the framework weakly, so that the program starts on the systems Lucium starts on, and says "unavailable" there', () => {
    expect(script).toMatch(/-Xlinker -weak_framework -Xlinker Translation/)
    expect(script).toMatch(/minimum="12\.0"/)
  })

  it('refuses to build a bundle that names another protocol than the program speaks', () => {
    expect(script).toContain(`named="$(/usr/libexec/PlistBuddy -c 'Print :LuciumTranslateProtocol' "$here/Info.plist"`)
    expect(script).toContain('grep -q "^let protocolVersion = ${named:-none}\\$" "$here/main.swift" || fail')
    expect(script.indexOf('grep -q "^let protocolVersion')).toBeLessThan(script.indexOf('swiftc -O'))
  })

  it('signs with the hardened runtime and no entitlement, and holds no identity: it comes from the environment', () => {
    expect(native('build.sh')).not.toMatch(/\([A-Z0-9]{10}\)/)
    expect(script).not.toMatch(/--entitlements|provisionprofile/)
    expect(script).toMatch(/identity="\$\{LUCIUM_SIGN_IDENTITY:-\}"/)
    expect(script.match(/codesign --force --options runtime/g)).toHaveLength(2)
    expect(script).toContain(`app="$out/${SYSTEM_TRANSLATE_HELPER_BUNDLE}"`)
    expect(script).toContain(`executable="${SYSTEM_TRANSLATE_HELPER_EXECUTABLE}"`)
  })
})

describe('this side of the system translation (system.ts)', () => {
  const source = code(readFileSync(fileURLToPath(new URL('./system.ts', import.meta.url)), 'utf8'))

  it('makes no request: no network module, no fetch', () => {
    expect(source).not.toMatch(/from 'node:(?:http|https|net|dgram|tls)'|from 'electron'|\bfetch\(|net\.request/)
  })

  it('starts the helper with no argument, and logs kinds, never the texts it is given', () => {
    expect(source).toMatch(/spawnHelper\(executable, \[\], \{ stdio: \['pipe', 'pipe', 'ignore'\], env: helperEnvironment\(\) \}\)/)
    for (const line of source.split('\n').filter((l) => /console\.\w+\(/.test(l))) expect(line).not.toMatch(/\btexts\b|request\b|\btext\b/)
  })
})

// The check of the parent process, compiled with this helper only (the keychain helper is an XPC service: vault-keychain-native.test.ts).
describe('the check of the caller (native/shared/caller.swift)', () => {
  /** The body of a function of caller.swift. */
  const callerFn = (name: string): string => {
    const start = caller.indexOf(`func ${name}(`)
    expect(start, `func ${name} is not in caller.swift any more`).toBeGreaterThanOrEqual(0)
    const next = caller.indexOf('\nfunc ', start + 1)
    return caller.slice(start, next < 0 ? undefined : next)
  }

  it('asks the system about the running parent, by its audit token: never a pid alone, a path or a name it is told', () => {
    const parent = callerFn('parentToken')
    expect(parent).toMatch(/let parent = getppid\(\)/)
    expect(parent).toMatch(/guard parent > 1 else \{ return nil \}/)
    expect(parent).toMatch(/task_info\(port, task_flavor_t\(TASK_AUDIT_TOKEN\)/)
    expect(parent).toMatch(/token\.val\.5 == UInt32\(bitPattern: parent\)/)
    expect(callerFn('guestCode')).toMatch(/SecCodeCopyGuestWithAttributes\(nil, \[kSecGuestAttributeAudit: audit\]/)
    expect(caller).not.toMatch(/kSecGuestAttributePid/)
    expect(callerFn('satisfies')).toMatch(/SecCodeCheckValidity\(code, \[\], requirement\)/)
  })

  it('wants a parent of the helper’s own team, under an identifier of Lucium, signed through Apple’s chain', () => {
    expect(caller).toContain('let luciumIdentifiers = ["app.lucium.browser", "app.lucium.browser.drm"]')
    expect(callerFn('luciumRequirement')).toContain('and anchor apple generic and certificate leaf[subject.OU] = \\"\\(team)\\"')
    const own = callerFn('ownTeam')
    expect(own).toMatch(/SecCodeCopySelf/)
    expect(own).toMatch(/kSecCodeInfoTeamIdentifier/)
    expect(caller).toContain('let teamPattern = "^[A-Z0-9]{10}\\\\z"')
    const verified = callerFn('verifiedCaller')
    expect(verified).toMatch(/if let team = ownTeam\(\) \{\n\s*guard satisfies\(code, luciumRequirement\(team: team\)\) else \{ return nil \}/)
    expect(verified).toMatch(/case \.refuse:\n\s*return nil/)
    expect(verified).toMatch(/guard let carrier = carrierApplication\(\), let path = codePath\(code\), path == carrier, satisfies\(code, nil\) else \{ return nil \}/)
    expect(callerFn('stillCaller')).toMatch(/return words\(token\) == checked/)
  })

  it('never reads an argument and never logs either', () => {
    expect(caller).not.toMatch(/CommandLine|ProcessInfo\.processInfo\.arguments/)
    expect(caller).not.toMatch(/\bprint\(|NSLog|os_log|Logger\(|standardError|fputs|debugPrint|dump\(|FileHandle/)
  })
})
