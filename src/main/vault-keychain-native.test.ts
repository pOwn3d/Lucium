// The keychain helper (native/vault-keychain/, an XPC service) is Swift and needs a fingerprint, and the addon that reaches it (native/vault-xpc/)
// needs a signed application: no test runs them together. What makes them safe is read here, in their source, so that a change that loosens
// them fails: the item behind the enrolled fingers, the data protection keychain only, nothing in an argument or a log, the key written only by
// a `load` the keychain accepted, the requirement of the other side's signature on every connection; and the build scripts, which never hold
// an identity.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KEYCHAIN_ADDON, KEYCHAIN_HELPER_BUNDLE, KEYCHAIN_HELPER_EXECUTABLE, KEYCHAIN_HELPER_IDENTIFIER, KEYCHAIN_PROMPT_REASON, KEYCHAIN_PROMPT_TIMEOUT_MS, KEYCHAIN_SERVICE_PREFIX } from './vault-keychain'
import { KEY_MATERIAL_BYTES } from './vault-crypto'
import { LANGUAGES } from '@shared/i18n'

const source = (path: string): string => readFileSync(fileURLToPath(new URL(`../../native/${path}`, import.meta.url)), 'utf8')
const native = (name: string): string => source(`vault-keychain/${name}`)
/** The code without the lines that are only comments. */
const code = (text: string, comment = '//'): string =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(comment))
    .join('\n')

const swift = code(native('main.swift'))
/** The addon of the main process (C), without its comment lines. */
const addon = code(source('vault-xpc/vault_xpc.c'))
/** The body of a top-level function, from its signature to the next top-level one. */
const bodyOf = (text: string, start: number, next: RegExp): string => {
  const rest = text.slice(start + 1).search(next)
  return text.slice(start, rest < 0 ? undefined : start + 1 + rest)
}
const fn = (name: string): string => {
  const start = swift.indexOf(`func ${name}(`)
  expect(start, `func ${name} is not in main.swift any more`).toBeGreaterThanOrEqual(0)
  return bodyOf(swift, start, /\n(?:func |final class |let |var |xpc_main)/)
}
const cFn = (name: string): string => {
  const start = addon.search(new RegExp(`\\n(?:static )?[a-z_ ]+\\*?\\b${name}\\(`))
  expect(start, `${name} is not in vault_xpc.c any more`).toBeGreaterThanOrEqual(0)
  return bodyOf(addon, start + 1, /\n(?:static |NAPI_MODULE_INIT)/)
}

describe('the keychain helper (main.swift)', () => {
  it('stores the key behind the fingers enrolled at that moment, on this Mac only', () => {
    const store = fn('store')
    expect(store).toMatch(/SecAccessControlCreateWithFlags\(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, \.biometryCurrentSet, &error\)/)
    expect(store).toMatch(/item\[kSecAttrAccessControl as String\] = access/)
    expect(store.indexOf('kSecAttrAccessControl')).toBeLessThan(store.indexOf('SecItemAdd('))
    // An accessibility of its own would be an item without the biometric constraint.
    expect(swift).not.toMatch(/kSecAttrAccessible as String/)
    expect(swift).not.toMatch(/\.userPresence|\.devicePasscode|\.or\b|kSecAttrAccessibleAlways/)
  })

  it('uses the data protection keychain for every call, never a synchronizable item, and one query shape for all', () => {
    const base = fn('baseQuery')
    expect(base).toMatch(/kSecUseDataProtectionKeychain as String: true/)
    expect(base).toMatch(/kSecAttrSynchronizable as String: false/)
    expect(swift.match(/kSecClass as String/g)).toHaveLength(1)
    const calls = [...swift.matchAll(/SecItem(?:Add|CopyMatching|Delete)\((\w+)/g)].map((m) => m[1])
    expect(calls).toHaveLength(4)
    for (const argument of calls) expect(['query', 'item', 'baseQuery']).toContain(argument)
    // `query` and `item` are made from `baseQuery` and nothing else.
    expect(swift.match(/(?:let|var) query = baseQuery\(service: service, account: account\)/g)).toHaveLength(2)
    expect(swift).toMatch(/var item = query\n/)
    expect(swift).not.toMatch(/kSecAttrSynchronizable as String: true|kSecAttrSynchronizableAny/)
  })

  it('writes the key only in the answer of a load the keychain accepted, and only as the answer of the request', () => {
    expect(swift.match(/"key":/g)).toHaveLength(1)
    const load = fn('load')
    const copy = load.indexOf('SecItemCopyMatching(')
    const success = load.indexOf('guard status == errSecSuccess, var key = result as? Data')
    const answer = load.indexOf('"key":')
    expect(copy).toBeGreaterThan(0)
    expect(success).toBeGreaterThan(copy)
    expect(answer).toBeGreaterThan(success)
    expect(swift.match(/kSecReturnData/g)).toHaveLength(1)
    expect(load).toMatch(/kSecReturnData/)
    expect(load).toMatch(/kSecUseAuthenticationContext as String\] = context/)
    expect(load).toMatch(/context\.localizedReason = reason/)
    // What is answered goes into the reply of the message it answers, and nowhere else.
    expect(swift.match(/xpc_dictionary_set_string\(/g)).toHaveLength(1)
    expect(fn('setAnswer')).toMatch(/xpc_dictionary_set_string\(reply, "answer", /)
    expect(fn('acceptRequest')).toMatch(/let reply = xpc_dictionary_create_reply\(event\)/)
  })

  it('takes the prompt off the screen when the caller goes away, and asks for nothing once it has', () => {
    expect(swift).toMatch(/func leave\(\) \{[\s\S]*?shown\?\.invalidate\(\)/)
    const load = fn('load')
    expect(load.indexOf('guard prompt.hold(context) else { throw Failure(code: "cancelled") }')).toBeGreaterThan(0)
    expect(load.indexOf('prompt.hold(context)')).toBeLessThan(load.indexOf('SecItemCopyMatching('))
    const request = fn('acceptRequest')
    expect(request).toMatch(/if xpc_get_type\(event\) == XPC_TYPE_ERROR \{\n\s*prompt\.leave\(\)/)
    // The work leaves the queue of the connection, so that the departure of the caller is heard during the prompt.
    expect(request).toMatch(/DispatchQueue\.global\(qos: \.userInitiated\)\.async \{/)
  })

  it('admits only Lucium of its own team, on every connection, before it is activated; signed ad hoc, nobody', () => {
    const admit = fn('admit')
    expect(admit).toMatch(/guard let requirement, xpc_connection_set_peer_code_signing_requirement\(peer, requirement\) == 0 else \{\n\s*xpc_connection_cancel\(peer\)\n\s*return false/)
    expect(swift).toMatch(/^let requirement: String\? = ownTeam\(\)\.map \{ luciumRequirement\(team: \$0\) \}$/m)
    expect(fn('luciumRequirement')).toContain('and anchor apple generic and certificate leaf[subject.OU] = \\"\\(team)\\"')
    const own = fn('ownTeam')
    expect(own).toMatch(/SecCodeCopySelf/)
    expect(own).toMatch(/kSecCodeInfoTeamIdentifier/)
    expect(own).toMatch(/team\.range\(of: teamPattern, options: \.regularExpression\) != nil \? team : nil/)
    expect(swift).toContain('let teamPattern = "^[A-Z0-9]{10}\\\\z"')
    // Both kinds of connection are admitted first, and only then given a handler and activated.
    for (const name of ['acceptNamed', 'acceptRequest']) {
      const body = fn(name)
      expect(body.indexOf('guard admit(peer) else')).toBeGreaterThan(0)
      expect(body.indexOf('guard admit(peer) else')).toBeLessThan(body.indexOf('xpc_connection_set_event_handler(peer)'))
      expect(body.indexOf('xpc_connection_activate(peer)')).toBeGreaterThan(body.indexOf('xpc_connection_set_event_handler(peer)'))
    }
    expect(swift).toMatch(/\nxpc_main \{ peer in acceptNamed\(peer\) \}\s*$/)
    // The connections of a listener made here go through acceptRequest, and nothing else creates one.
    expect(swift.match(/xpc_connection_create\(/g)).toHaveLength(1)
    expect(fn('oneRequestListener')).toMatch(/acceptRequest\(event, listener: listener\)/)
  })

  it('wants the same identifiers of Lucium as the translation helper does (native/shared/caller.swift)', () => {
    const shared = code(source('shared/caller.swift'))
    const list = (text: string, name: string): string => new RegExp(`^let ${name} = (\\[[^\\]]*\\])$`, 'm').exec(text)?.[1] ?? 'missing'
    expect(list(swift, 'luciumIdentifiers')).toBe('["app.lucium.browser", "app.lucium.browser.drm"]')
    expect(list(swift, 'luciumIdentifiers')).toBe(list(shared, 'luciumIdentifiers'))
  })

  it('answers the named connection with an endpoint only, and takes requests only on a connection of that endpoint, one each', () => {
    const named = fn('acceptNamed')
    expect(named).toMatch(/xpc_dictionary_set_value\(reply, "endpoint", xpc_endpoint_create\(oneRequestListener\(\)\)\)/)
    expect(named).not.toMatch(/respond\(|"request"/)
    const listener = fn('oneRequestListener')
    expect(listener).toMatch(/if taken \{\n\s*xpc_connection_cancel\(event\)\n\s*return\n\s*\}/)
    const request = fn('acceptRequest')
    expect(request).toMatch(/guard !answered, xpc_get_type\(event\) == XPC_TYPE_DICTIONARY/)
    expect(request).toMatch(/xpc_string_get_length\(value\) <= inputLimit/)
    expect(swift.match(/respond\(data, prompt: prompt\)/g)).toHaveLength(1)
  })

  it('shows its own words in the prompt: the caller names a reason and a language, never a text', () => {
    const prompt = fn('promptText')
    expect(prompt).toMatch(new RegExp(`request\\["reason"\\] as\\? String == "${KEYCHAIN_PROMPT_REASON}"`))
    expect(prompt).toMatch(/let text = prompts\[language\]/)
    expect(fn('load')).toMatch(/let reason = try promptText\(request\)/)
    // The only use of the reason of the request is the comparison with the one known key.
    expect(swift.match(/request\["reason"\]/g)).toHaveLength(1)
    const table = /^let prompts = \[(.*)\]$/m.exec(swift)?.[1] ?? ''
    const words = Object.fromEntries([...table.matchAll(/"(\w+)": "([^"]+)"/g)].map((m) => [m[1], m[2]]))
    expect(Object.keys(words).sort()).toEqual([...LANGUAGES].sort())
    expect(words).toEqual({ fr: 'ouvrir le coffre de mots de passe', en: 'open the password vault' })
  })

  it('reads its names strictly to their end (`\\z`: in ICU `$` lets a final line feed through)', () => {
    const respond = fn('respond')
    expect(respond).toContain('pattern: "^app\\\\.lucium\\\\.browser\\\\.[A-Za-z0-9.-]{1,120}\\\\z"')
    expect(respond).toContain('pattern: "^[A-Za-z0-9._-]{1,64}\\\\z"')
    expect(swift).not.toMatch(/pattern: "[^"]*\$"/)
  })

  it('never reads an argument and never logs', () => {
    expect(swift).not.toMatch(/CommandLine|ProcessInfo\.processInfo\.arguments/)
    expect(swift).not.toMatch(/\bprint\(|NSLog|os_log|Logger\(|standardError|fputs|debugPrint|dump\(|FileHandle/)
  })

  it('touches only the items of Lucium, and agrees with this side on the names and the size of the key', () => {
    expect(swift).toContain(`let servicePrefix = "${KEYCHAIN_SERVICE_PREFIX}"`)
    expect(swift).toContain(`let keyLength = ${KEY_MATERIAL_BYTES}`)
    expect(fn('respond')).toMatch(/guard service\.hasPrefix\(servicePrefix\)/)
    const plist = native('Info.plist')
    expect(plist).toContain(`<key>CFBundleExecutable</key>\n    <string>${KEYCHAIN_HELPER_EXECUTABLE}</string>`)
    expect(plist).toContain(`<string>${KEYCHAIN_HELPER_IDENTIFIER}</string>`)
  })

  it('is an XPC service of the application, in the session of its user', () => {
    const plist = native('Info.plist').replace(/<!--[\s\S]*?-->/g, '')
    expect(plist).toMatch(/<key>CFBundlePackageType<\/key>\s*<string>XPC!<\/string>/)
    expect(plist).toMatch(/<key>XPCService<\/key>\s*<dict>\s*<key>ServiceType<\/key>\s*<string>Application<\/string>\s*<key>JoinExistingSession<\/key>\s*<true\/>\s*<\/dict>/)
    expect(plist).toMatch(/<key>CFBundleDisplayName<\/key>\s*<string>Lucium<\/string>/)
  })
})

describe('the addon of the main process (native/vault-xpc/vault_xpc.c)', () => {
  it('reaches the helper by its identifier, and requires it to be signed by the team of this very application', () => {
    expect(addon).toContain(`#define SERVICE_NAME "${KEYCHAIN_HELPER_IDENTIFIER}"`)
    const read = cFn('read_requirement')
    expect(read).toMatch(/SecCodeCopySelf\(/)
    expect(read).toMatch(/kSecCodeInfoTeamIdentifier/)
    expect(read).toMatch(/if \(!is_team\(team\)\) goto done;/)
    expect(read).toContain('"identifier \\"%s\\" and anchor apple generic and certificate leaf[subject.OU] = \\"%s\\"", SERVICE_NAME, team')
    expect(cFn('is_team')).toMatch(/if \(strlen\(team\) != TEAM_LENGTH\) return 0;/)
  })

  it('sends nothing without a team, and checks what it is given first', () => {
    const send = cFn('send_request')
    const untrusted = send.indexOf('if (!requirement()) {')
    expect(untrusted).toBeGreaterThan(0)
    expect(send.indexOf('reject_with(env, deferred, "untrusted")')).toBeGreaterThan(untrusted)
    expect(send.indexOf('dispatch_async_f(queue, r, start)')).toBeGreaterThan(untrusted)
    expect(send).toMatch(/length == 0 \|\| length > REQUEST_LIMIT\)/)
    expect(send).toMatch(/timeout < 1 \|\| timeout > TIMEOUT_LIMIT_MS\)/)
    expect(addon).toContain('#define REQUEST_LIMIT (16 * 1024)')
    expect(addon).toContain('#define ANSWER_LIMIT 4096')
    // The longest wait it allows covers the prompt's.
    expect(Number(/#define TIMEOUT_LIMIT_MS \((\d+) \* 60 \* 1000\)/.exec(addon)?.[1]) * 60_000).toBeGreaterThan(KEYCHAIN_PROMPT_TIMEOUT_MS)
  })

  it('sets the requirement on both connections before they are activated', () => {
    const start = cFn('start')
    expect(start.indexOf('xpc_connection_set_peer_code_signing_requirement(r->named, requirement())')).toBeGreaterThan(0)
    expect(start.indexOf('xpc_connection_set_peer_code_signing_requirement(r->named, requirement())')).toBeLessThan(start.lastIndexOf('ready(r->named)'))
    const opened = cFn('opened')
    expect(opened.indexOf('xpc_connection_set_peer_code_signing_requirement(r->direct, requirement())')).toBeGreaterThan(opened.indexOf('xpc_connection_create_from_endpoint('))
    expect(opened.indexOf('xpc_connection_set_peer_code_signing_requirement(r->direct, requirement())')).toBeLessThan(opened.lastIndexOf('ready(r->direct)'))
    expect(addon.match(/xpc_connection_set_peer_code_signing_requirement\(/g)).toHaveLength(2)
    expect(cFn('kind_of')).toMatch(/if \(error == XPC_ERROR_PEER_CODE_SIGNING_REQUIREMENT\) return "untrusted";/)
  })

  it('sends the request only on the connection of the endpoint the helper answered, never on the one looked up by name', () => {
    expect(addon.match(/xpc_dictionary_set_string\(/g)).toHaveLength(1)
    const opened = cFn('opened')
    expect(opened).toMatch(/if \(xpc_get_type\(reply\) != XPC_TYPE_DICTIONARY\) \{\n\s*settle\(r, kind_of\(reply\)\);\n\s*return;/)
    expect(opened).toMatch(/if \(!endpoint \|\| xpc_get_type\(endpoint\) != XPC_TYPE_ENDPOINT\) \{/)
    expect(opened.indexOf('xpc_dictionary_set_string(message, "request", r->text)')).toBeGreaterThan(opened.indexOf('ready(r->direct)'))
    expect(opened).toMatch(/xpc_connection_send_message_with_reply\(r->direct, message, queue,/)
    // What goes on the named connection is an empty message.
    expect(cFn('start')).toMatch(/xpc_object_t message = xpc_dictionary_create\(NULL, NULL, 0\);\n\s*r->holds\+\+;\n\s*xpc_connection_send_message_with_reply\(r->named, message, queue,/)
    const answered = cFn('answered')
    expect(answered).toMatch(/xpc_string_get_length\(value\) > ANSWER_LIMIT\) \{\n\s*settle\(r, "invalid"\);/)
  })

  it('wipes its copies of the request and the answer, logs nothing, and cancels every waiting request when asked', () => {
    expect(cFn('opened')).toMatch(/xpc_dictionary_set_string\(message, "request", r->text\);\n\s*wipe\(r->text, r->text_length\);/)
    expect(cFn('release_request')).toMatch(/wipe\(r->text, r->text_length\);[\s\S]*wipe\(r->answer, r->answer_length\);/)
    expect(cFn('wipe')).toMatch(/memset_s\(/)
    expect(addon).not.toMatch(/\bprintf\(|fprintf|NSLog|os_log|syslog|puts\(|perror|stderr/)
    expect(cFn('cancel_pending')).toMatch(/while \(pending\) settle\(pending, "cancelled"\);/)
    expect(cFn('cancel_all')).toMatch(/dispatch_sync_f\(queue, NULL, cancel_pending\)/)
    expect(cFn('settle')).toMatch(/close_connection\(&r->direct\);\n\s*close_connection\(&r->named\);/)
  })
})

describe('the builds (build.sh of the helper and of the addon, entitlements.plist.in)', () => {
  const script = code(native('build.sh'), '#')
  const entitlements = native('entitlements.plist.in')
  const addonScript = code(source('vault-xpc/build.sh'), '#')

  it('hold no identity, no team and no profile: they come from the environment', () => {
    expect(native('build.sh')).not.toMatch(/\([A-Z0-9]{10}\)/)
    expect(source('vault-xpc/build.sh')).not.toMatch(/\([A-Z0-9]{10}\)/)
    expect(entitlements).not.toMatch(/[A-Z0-9]{10}\.app\.lucium/)
    expect(entitlements.match(/__TEAM_ID__/g)).toHaveLength(3)
    expect(script).toMatch(/identity="\$\{LUCIUM_SIGN_IDENTITY:-\}"/)
    expect(script).toMatch(/profile="\$\{LUCIUM_KEYCHAIN_PROFILE:-\}"/)
    expect(addonScript).toMatch(/identity="\$\{LUCIUM_SIGN_IDENTITY:-\}"/)
  })

  it('puts the keychain entitlements on the helper only with a profile that is its own, and signs it with the hardened runtime', () => {
    const check = script.indexOf('[ "$granted_id" = "$team.$bundle_id" ]')
    expect(check).toBeGreaterThan(0)
    expect(script.indexOf('--entitlements')).toBeGreaterThan(check)
    expect(script).toMatch(/codesign --force --options runtime/)
    expect(script).toMatch(/bundle_id="app\.lucium\.browser\.keychain"/)
    expect(script).toContain('cp "$profile" "$app/Contents/embedded.provisionprofile"')
    expect(entitlements).toContain('<string>__TEAM_ID__.app.lucium.browser.keychain</string>')
    expect(script).toContain(`app="$out/${KEYCHAIN_HELPER_BUNDLE}"`)
    expect(script).toContain(`executable="${KEYCHAIN_HELPER_EXECUTABLE}"`)
    // The helper is its main.swift alone: the check of a parent process (caller.swift) is the translation helper's.
    expect(script).toMatch(/-o "\$work\/\$executable-\$target" "\$here\/main\.swift"\n/)
  })

  it('builds the addon with clang alone, as a Node-API bundle for macOS 12, with the hardened runtime and no entitlement', () => {
    expect(addonScript).toContain(`addon="$out/${KEYCHAIN_ADDON}"`)
    expect(addonScript).toMatch(/clang -bundle -undefined dynamic_lookup /)
    expect(addonScript).toMatch(/-DNAPI_VERSION=8 /)
    expect(addonScript).toMatch(/-Werror /)
    expect(addonScript).toMatch(/minimum="12\.0"/)
    expect(addonScript).not.toMatch(/node-gyp|cmake|--entitlements/)
    expect(addonScript).toMatch(/codesign --force --options runtime /)
  })
})
