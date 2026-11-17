// The keychain service of Lucium's password vault (src/main/vault-keychain.ts, docs/gestionnaire-mots-de-passe.md): an XPC service of the
// application, Contents/XPCServices/LuciumKeychain.xpc, that launchd starts when Lucium asks for it.
//
// Electron has no call that stores a secret behind Touch ID: `systemPreferences.promptTouchID` only answers yes or no, it protects nothing.
// This program keeps the key of the vault (the 64 bytes scrypt derived from the master phrase) in the data protection keychain, under an
// access control that the system itself enforces: `.biometryCurrentSet`. The key comes back out only after a fingerprint of the fingers
// enrolled when it was stored; adding or removing a finger invalidates the item, and the master phrase is then the way in again.
//
// How a request travels (the addon of the main process, native/vault-xpc/, is the other end):
//  1. Lucium connects to the service by its name and sends an empty message; the answer holds an endpoint: a listener made for that one
//     request, which no name leads to;
//  2. Lucium connects to that endpoint and sends {"request": "<JSON>"}; the answer comes back as {"answer": "<JSON>"}.
// The request is the same JSON as ever, one per connection:
//   {"command":"store","service":"…","account":"…","key":"<base64 of 64 bytes>"}                            -> {"ok":true,"state":"<base64>"|null}
//   {"command":"load","service":"…","account":"…","reason":"open-vault","language":"fr"|"en","state":"<base64>"?} -> {"ok":true,"key":"<base64>"}
//   {"command":"delete","service":"…","account":"…"}                                                          -> {"ok":true,"deleted":true|false}
//   any failure                                                                                               -> {"ok":false,"error":"<code>","status":<OSStatus>?}
// Codes: cancelled, failed, biometry-changed, unavailable, not-found, not-entitled, invalid, error. A caller that is not Lucium gets no answer
// at all: the system drops its message before this code sees it.
// Why the second step: the system checks the signature of the service on every reply Lucium receives, not where Lucium's own messages go. A
// request sent on a connection looked up by name could, after the service went away, be sent to whatever the next lookup gives; a connection
// made from an endpoint is never looked up again. So the key of a `store` leaves Lucium only towards the listener whose endpoint came in a
// reply the system checked as this service's.
//
// Rules this file keeps (src/main/vault-keychain-native.test.ts reads them in this source):
//  - only Lucium is answered: every connection, the named one and the endpoint's, gets Lucium's code requirement before it is activated
//    (`admit`: `(identifier "app.lucium.browser" or identifier "app.lucium.browser.drm") and anchor apple generic and
//    certificate leaf[subject.OU] = "<team>"`, the team of this service's own signature, never written in this repository). The system checks
//    it on every message, against the audit token the kernel stamped on that message when it was sent: a process that is not Lucium, or that
//    replaced its code by Lucium's (exec) after it sent, is not answered. Signed ad hoc, the service has no team and admits nobody;
//  - the text of the prompt is the service's own (`prompts`): the caller names the reason and the language, never the words the system shows;
//  - the key never comes from an argument (`CommandLine` is not read) and is never written anywhere but in the answer of a `load` that the
//    keychain accepted, after the biometric check it enforces;
//  - a prompt whose caller went away (it quit, gave up, timed out) is taken off the screen: its context is invalidated;
//  - nothing is logged: no print, no NSLog, no standard error;
//  - every item lives in the data protection keychain (`kSecUseDataProtectionKeychain`), on this Mac only (`ThisDeviceOnly`, never
//    synchronizable), under a service of Lucium (`app.lucium.browser.`).

import Foundation
import LocalAuthentication
import Security
import XPC

let inputLimit = 16 * 1024
let keyLength = 64
let servicePrefix = "app.lucium.browser."
/// The words the system shows after "Lucium" (CFBundleDisplayName of Info.plist) in its Touch ID prompt, by language: the same as the catalogue of the application
/// ('pwd-touch.raison' of src/shared/i18n-fr.ts and i18n-en.ts, compared by the test). Only `reason: "open-vault"` exists.
let prompts = ["fr": "ouvrir le coffre de mots de passe", "en": "open the password vault"]
/// The identifiers of the applications the service answers: Lucium (the normal build, and the DRM one built under its name) and "Lucium DRM"
/// built beside it (scripts/package-drm.mjs without --as-lucium). The same as native/shared/caller.swift (compared by the test).
let luciumIdentifiers = ["app.lucium.browser", "app.lucium.browser.drm"]
/// A team identifier as Apple gives them: ten capitals and digits, nothing after (`\z`, not `$`, which lets a final line feed through in ICU).
let teamPattern = "^[A-Z0-9]{10}\\z"
/// How long the service stays without any connection before it leaves (the next request starts it again).
let idleSeconds = 10.0

struct Failure: Error {
  let code: String
  var status: OSStatus? = nil
}

/// The team of this service's own signature; nil when it is signed ad hoc (or its signature cannot be read).
func ownTeam() -> String? {
  var running: SecCode?
  guard SecCodeCopySelf([], &running) == errSecSuccess, let running else { return nil }
  var onDisk: SecStaticCode?
  guard SecCodeCopyStaticCode(running, [], &onDisk) == errSecSuccess, let onDisk else { return nil }
  var information: CFDictionary?
  guard SecCodeCopySigningInformation(onDisk, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess else { return nil }
  guard let team = (information as? [String: Any])?[kSecCodeInfoTeamIdentifier as String] as? String else { return nil }
  return team.range(of: teamPattern, options: .regularExpression) != nil ? team : nil
}

/// The requirement a caller signed by `team` must meet: one of Lucium's identifiers, a certificate of Apple's chain, the service's own team.
func luciumRequirement(team: String) -> String {
  let identifiers = luciumIdentifiers.map { "identifier \"\($0)\"" }.joined(separator: " or ")
  return "(\(identifiers)) and anchor apple generic and certificate leaf[subject.OU] = \"\(team)\""
}

/// Read once: the signature of a running program does not change. Nil signed ad hoc: no connection is admitted then.
let requirement: String? = ownTeam().map { luciumRequirement(team: $0) }

/// The whole request, bounded: a request is a few hundred bytes, anything near the limit is not one.
func parse(_ data: Data) throws -> [String: Any] {
  guard let object = try? JSONSerialization.jsonObject(with: data), let request = object as? [String: Any] else { throw Failure(code: "invalid") }
  return request
}

func text(_ request: [String: Any], _ field: String, pattern: String) throws -> String {
  guard let value = request[field] as? String, value.range(of: pattern, options: .regularExpression) != nil else { throw Failure(code: "invalid") }
  return value
}

/// The codes the caller understands, from what the keychain answered.
func failureOf(_ status: OSStatus) -> Failure {
  switch status {
  case errSecUserCanceled: return Failure(code: "cancelled", status: status)
  case errSecAuthFailed: return Failure(code: "failed", status: status)
  case errSecItemNotFound: return Failure(code: "not-found", status: status)
  case errSecInteractionNotAllowed, errSecNotAvailable: return Failure(code: "unavailable", status: status)
  // The program is not signed with the entitlements that open the data protection keychain (an unsigned or ad-hoc build).
  case errSecMissingEntitlement: return Failure(code: "not-entitled", status: status)
  default: return Failure(code: "error", status: status)
  }
}

/// A context that can ask for a fingerprint now, or "unavailable": no sensor, no finger enrolled, too many failures, a closed lid.
func biometryContext() throws -> LAContext {
  let context = LAContext()
  var error: NSError?
  guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else { throw Failure(code: "unavailable") }
  return context
}

/// The opaque mark of the enrolled fingers: it changes when one is added or removed. Not a secret; used only to name a missing item.
func biometryState(_ context: LAContext) -> Data? {
  if #available(macOS 15.0, *) { return context.domainState.biometry.stateHash }
  return context.evaluatedPolicyDomainState
}

func baseQuery(service: String, account: String) -> [String: Any] {
  return [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecUseDataProtectionKeychain as String: true,
    kSecAttrSynchronizable as String: false,
  ]
}

/// Stores the key behind the fingers enrolled now. An older key under the same name is replaced.
func store(_ request: [String: Any], service: String, account: String) throws -> [String: Any] {
  guard let encoded = request["key"] as? String, var key = Data(base64Encoded: encoded) else { throw Failure(code: "invalid") }
  defer { key.resetBytes(in: 0..<key.count) }
  guard key.count == keyLength else { throw Failure(code: "invalid") }
  let context = try biometryContext()
  var error: Unmanaged<CFError>?
  // The guard of the whole service: the system releases this item only after a fingerprint of the fingers enrolled at this moment.
  guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .biometryCurrentSet, &error) else {
    error?.release()
    throw Failure(code: "error")
  }
  let query = baseQuery(service: service, account: account)
  let removed = SecItemDelete(query as CFDictionary)
  guard removed == errSecSuccess || removed == errSecItemNotFound else { throw failureOf(removed) }
  var item = query
  item[kSecAttrAccessControl as String] = access
  item[kSecAttrLabel as String] = "Lucium"
  item[kSecValueData as String] = key
  let status = SecItemAdd(item as CFDictionary, nil)
  guard status == errSecSuccess else { throw failureOf(status) }
  return ["ok": true, "state": biometryState(context)?.base64EncodedString() ?? NSNull()]
}

/// The text of the prompt, chosen here from the reason and the language the request names: never a text of the caller's.
func promptText(_ request: [String: Any]) throws -> String {
  guard request["reason"] as? String == "open-vault", let language = request["language"] as? String, let text = prompts[language] else { throw Failure(code: "invalid") }
  return text
}

/// The prompt of one connection: when its caller goes away before the answer, the context is invalidated and the system takes the prompt away.
final class Prompt {
  private let lock = NSLock()
  private var context: LAContext?
  private var gone = false

  /// Keeps `context` for `leave`; false when the caller has left already (nothing is asked then).
  func hold(_ context: LAContext) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if gone { return false }
    self.context = context
    return true
  }

  func leave() {
    lock.lock()
    gone = true
    let shown = context
    context = nil
    lock.unlock()
    shown?.invalidate()
  }
}

/// The key, after the fingerprint the item's access control asks for. The system shows the prompt, with the service's own text.
func load(_ request: [String: Any], service: String, account: String, prompt: Prompt) throws -> [String: Any] {
  let reason = try promptText(request)
  let context = try biometryContext()
  context.localizedReason = reason
  // Only a fingerprint opens this item: no "Use Password…" button that could not open it anyway.
  context.localizedFallbackTitle = ""
  context.interactionNotAllowed = false
  guard prompt.hold(context) else { throw Failure(code: "cancelled") }
  var query = baseQuery(service: service, account: account)
  query[kSecReturnData as String] = true
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  query[kSecUseAuthenticationContext as String] = context
  var result: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  guard status == errSecSuccess, var key = result as? Data else {
    // An item made for other fingers is gone: say so when the enrolled fingers are not the ones of the store.
    if status == errSecItemNotFound, let stored = request["state"] as? String, let before = Data(base64Encoded: stored), let now = biometryState(context), before != now {
      throw Failure(code: "biometry-changed", status: status)
    }
    throw status == errSecSuccess ? Failure(code: "error") : failureOf(status)
  }
  defer { key.resetBytes(in: 0..<key.count) }
  guard key.count == keyLength else { throw Failure(code: "error") }
  return ["ok": true, "key": key.base64EncodedString()]
}

/// Removes the item. Missing already is not an error: the caller wants it gone.
func remove(service: String, account: String) throws -> [String: Any] {
  let status = SecItemDelete(baseQuery(service: service, account: account) as CFDictionary)
  guard status == errSecSuccess || status == errSecItemNotFound else { throw failureOf(status) }
  return ["ok": true, "deleted": status == errSecSuccess]
}

/// The answer to one request (its JSON, wiped by the caller once parsed).
func respond(_ data: Data, prompt: Prompt) -> [String: Any] {
  do {
    let request = try parse(data)
    // `\z` and not `$`: in ICU `$` also matches before a final line feed.
    let service = try text(request, "service", pattern: "^app\\.lucium\\.browser\\.[A-Za-z0-9.-]{1,120}\\z")
    guard service.hasPrefix(servicePrefix) else { throw Failure(code: "invalid") }
    let account = try text(request, "account", pattern: "^[A-Za-z0-9._-]{1,64}\\z")
    switch request["command"] as? String {
    case "store": return try store(request, service: service, account: account)
    case "load": return try load(request, service: service, account: account, prompt: prompt)
    case "delete": return try remove(service: service, account: account)
    default: throw Failure(code: "invalid")
    }
  } catch let failure as Failure {
    var out: [String: Any] = ["ok": false, "error": failure.code]
    if let status = failure.status { out["status"] = Int(status) }
    return out
  } catch {
    return ["ok": false, "error": "error"]
  }
}

/// Puts the JSON of `object` in `reply` as its "answer", through bytes that are wiped once XPC has its copy.
func setAnswer(_ reply: xpc_object_t, _ object: [String: Any]) {
  var data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{\"ok\":false,\"error\":\"error\"}".utf8)
  data.append(0)
  data.withUnsafeBytes { bytes in
    if let base = bytes.baseAddress { xpc_dictionary_set_string(reply, "answer", base.assumingMemoryBound(to: CChar.self)) }
  }
  data.resetBytes(in: 0..<data.count)
}

// The life of the process: it leaves once no connection has been open for `idleSeconds`, as the earlier helper left after its one request.
let lifetime = DispatchQueue(label: "app.lucium.browser.keychain.lifetime")
var openConnections = 0
var leaving: DispatchWorkItem?

func opened() {
  lifetime.sync {
    openConnections += 1
    leaving?.cancel()
    leaving = nil
  }
}

func closed() {
  lifetime.sync {
    openConnections -= 1
    guard openConnections <= 0 else { return }
    let item = DispatchWorkItem { exit(0) }
    leaving = item
    lifetime.asyncAfter(deadline: .now() + idleSeconds, execute: item)
  }
}

/**
 * THE GUARD: a connection is kept only once Lucium's requirement is set on it, before it is activated; the system then refuses every message
 * of a sender that does not meet it. Signed ad hoc there is no team to require: the connection is cancelled, nothing is read.
 */
func admit(_ peer: xpc_connection_t) -> Bool {
  guard let requirement, xpc_connection_set_peer_code_signing_requirement(peer, requirement) == 0 else {
    xpc_connection_cancel(peer)
    return false
  }
  return true
}

/// Step 1, a connection made by the service's name: each message is answered with the endpoint of a listener made for one request.
func acceptNamed(_ peer: xpc_connection_t) {
  guard admit(peer) else { return }
  opened()
  xpc_connection_set_event_handler(peer) { event in
    if xpc_get_type(event) == XPC_TYPE_ERROR {
      if event === XPC_ERROR_CONNECTION_INVALID { closed() }
      return
    }
    guard xpc_get_type(event) == XPC_TYPE_DICTIONARY, let reply = xpc_dictionary_create_reply(event) else { return }
    xpc_dictionary_set_value(reply, "endpoint", xpc_endpoint_create(oneRequestListener()))
    xpc_connection_send_message(peer, reply)
  }
  xpc_connection_activate(peer)
}

/// Step 2: a listener that no name leads to. It takes one connection; a second one is refused. It closes when its connection does (closing it
/// before would end that connection too).
func oneRequestListener() -> xpc_connection_t {
  let listener = xpc_connection_create(nil, nil)
  var taken = false
  xpc_connection_set_event_handler(listener) { event in
    guard xpc_get_type(event) == XPC_TYPE_CONNECTION else { return }
    if taken {
      xpc_connection_cancel(event)
      return
    }
    taken = true
    acceptRequest(event, listener: listener)
  }
  xpc_connection_activate(listener)
  return listener
}

/// The connection of one request: its first message is answered, any other is not.
func acceptRequest(_ peer: xpc_connection_t, listener: xpc_connection_t) {
  guard admit(peer) else {
    xpc_connection_cancel(listener)
    return
  }
  opened()
  let prompt = Prompt()
  var answered = false
  xpc_connection_set_event_handler(peer) { event in
    if xpc_get_type(event) == XPC_TYPE_ERROR {
      // The caller went away (it quit, gave up or timed out): its prompt goes with it.
      prompt.leave()
      if event === XPC_ERROR_CONNECTION_INVALID {
        xpc_connection_cancel(listener)
        closed()
      }
      return
    }
    guard !answered, xpc_get_type(event) == XPC_TYPE_DICTIONARY, let reply = xpc_dictionary_create_reply(event) else { return }
    answered = true
    var data = Data()
    if let value = xpc_dictionary_get_value(event, "request"), xpc_get_type(value) == XPC_TYPE_STRING, xpc_string_get_length(value) <= inputLimit, let bytes = xpc_string_get_string_ptr(value) {
      data = Data(bytes: bytes, count: xpc_string_get_length(value))
    }
    // Off the queue of the connection: a prompt can wait for a minute and a half, and the departure of the caller must still be heard meanwhile.
    DispatchQueue.global(qos: .userInitiated).async {
      let answer = data.isEmpty ? ["ok": false, "error": "invalid"] : respond(data, prompt: prompt)
      data.resetBytes(in: 0..<data.count)
      setAnswer(reply, answer)
      xpc_connection_send_message(peer, reply)
    }
  }
  xpc_connection_activate(peer)
}

xpc_main { peer in acceptNamed(peer) }
