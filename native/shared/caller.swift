// Who may run a helper of Contents/Helpers/. Compiled by its build.sh beside the main.swift of the one helper that runs on pipes:
// native/system-translate/ (the system's translation). The keychain helper of the password vault is an XPC service and does not use this file:
// the system checks Lucium's signature on each of its messages (native/vault-keychain/main.swift, `admit`).
//
// A helper is a program of Contents/Helpers/ that any process of the session can start. Before it reads its request, it checks the process that
// started it (its parent), through the parent's audit token and the Security framework, never through a path or a name it is told:
//  - a helper signed with a Developer ID answers only a parent signed by the same team (read on the helper's own signature, never written in this
//    repository) whose identifier is Lucium's: `(identifier "app.lucium.browser" or identifier "app.lucium.browser.drm") and anchor apple
//    generic and certificate leaf[subject.OU] = "<team>"`, checked on the running parent (SecCodeCheckValidity on its dynamic code);
//  - a helper signed ad hoc (a build without a Developer ID) has no team to compare: `AdHocRule.refuse` answers nobody, and
//    `AdHocRule.carrierApplication` (the translation helper's) only the main program of the application that carries it in its Contents/Helpers/,
//    with a valid signature (no authenticity without a team, a check of place);
//  - `stillCaller` tells whether the parent is still the very process checked: the audit token holds the pid and the pid version, which an exec
//    changes.
// What this does not stop: a local program that starts the helper and then replaces its own code by Lucium's (exec) before the check, while a
// process it forked keeps the other end of the pipes; the parent is then a genuine Lucium, and the answer goes to that other process. For the
// translation helper that is a translation of texts the other process chose, nothing secret; it is why the keychain helper no longer runs on pipes.
//
// Nothing here logs, reads an argument or writes anything: it answers whether the caller is Lucium, and the helper says "caller" when it is not.

import Foundation
import Security

/// The identifiers of the applications the helpers answer: Lucium (the normal build, and the DRM one built under its name) and "Lucium DRM"
/// built beside it (scripts/package-drm.mjs without --as-lucium), which opens the same data folder.
let luciumIdentifiers = ["app.lucium.browser", "app.lucium.browser.drm"]
/// A team identifier as Apple gives them: ten capitals and digits, nothing after (`\z`, not `$`, which lets a final line feed through in ICU).
let teamPattern = "^[A-Z0-9]{10}\\z"

/// How a helper signed ad hoc decides, having no team to compare.
enum AdHocRule {
  /// No caller is accepted.
  case refuse
  /// Only the main program of the application whose Contents/Helpers/ holds this helper, with a valid signature.
  case carrierApplication
}

/// The signing information of a piece of code (its identifier, its team…), or nil when the system cannot read it.
func signingInformation(_ code: SecStaticCode) -> [String: Any]? {
  var information: CFDictionary?
  guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess else { return nil }
  return information as? [String: Any]
}

/// The team of this helper's own signature; nil when it is signed ad hoc (or its signature cannot be read).
func ownTeam() -> String? {
  var running: SecCode?
  guard SecCodeCopySelf([], &running) == errSecSuccess, let running else { return nil }
  var onDisk: SecStaticCode?
  guard SecCodeCopyStaticCode(running, [], &onDisk) == errSecSuccess, let onDisk else { return nil }
  guard let team = signingInformation(onDisk)?[kSecCodeInfoTeamIdentifier as String] as? String else { return nil }
  return team.range(of: teamPattern, options: .regularExpression) != nil ? team : nil
}

/// The audit token of the process that started this one, or nil when there is none to check (started by launchd: the parent is gone).
func parentToken() -> audit_token_t? {
  let parent = getppid()
  guard parent > 1 else { return nil }
  var port = mach_port_name_t(MACH_PORT_NULL)
  guard task_name_for_pid(mach_task_self_, parent, &port) == KERN_SUCCESS else { return nil }
  defer { mach_port_deallocate(mach_task_self_, port) }
  var token = audit_token_t()
  var count = mach_msg_type_number_t(MemoryLayout<audit_token_t>.size / MemoryLayout<natural_t>.size)
  let status = withUnsafeMutablePointer(to: &token) { pointer in
    pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(port, task_flavor_t(TASK_AUDIT_TOKEN), $0, &count) }
  }
  // The sixth word of the token is the pid: a token of another process is not the parent's.
  guard status == KERN_SUCCESS, token.val.5 == UInt32(bitPattern: parent) else { return nil }
  return token
}

/// The words of an audit token (pid and pid version among them), to compare two of them.
func words(_ token: audit_token_t) -> [UInt32] {
  return withUnsafeBytes(of: token) { Array($0.bindMemory(to: UInt32.self)) }
}

/// The running code of the process this token names.
func guestCode(_ token: audit_token_t) -> SecCode? {
  var copy = token
  let audit = Data(bytes: &copy, count: MemoryLayout<audit_token_t>.size)
  var code: SecCode?
  guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributeAudit: audit] as CFDictionary, [], &code) == errSecSuccess else { return nil }
  return code
}

/// The requirement a parent signed by `team` must meet: one of Lucium's identifiers, a certificate of Apple's chain, and the helper's own team.
func luciumRequirement(team: String) -> String {
  let identifiers = luciumIdentifiers.map { "identifier \"\($0)\"" }.joined(separator: " or ")
  return "(\(identifiers)) and anchor apple generic and certificate leaf[subject.OU] = \"\(team)\""
}

/// Whether the running `code` is valid, and meets `text` when one is given.
func satisfies(_ code: SecCode, _ text: String?) -> Bool {
  var requirement: SecRequirement?
  if let text, SecRequirementCreateWithString(text as CFString, [], &requirement) != errSecSuccess { return false }
  return SecCodeCheckValidity(code, [], requirement) == errSecSuccess
}

/// The application that carries this helper (<App>.app/Contents/Helpers/<Helper>.app → <App>.app), or nil when it is not carried by one.
func carrierApplication() -> URL? {
  let helpers = Bundle.main.bundleURL.deletingLastPathComponent()
  let contents = helpers.deletingLastPathComponent()
  guard helpers.lastPathComponent == "Helpers", contents.lastPathComponent == "Contents" else { return nil }
  return contents.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL
}

/// Where the running `code` is on the disk (the bundle of an application).
func codePath(_ code: SecCode) -> URL? {
  var onDisk: SecStaticCode?
  guard SecCodeCopyStaticCode(code, [], &onDisk) == errSecSuccess, let onDisk else { return nil }
  var path: CFURL?
  guard SecCodeCopyPath(onDisk, [], &path) == errSecSuccess, let path else { return nil }
  return (path as URL).resolvingSymlinksInPath().standardizedFileURL
}

/**
 * THE GUARD: whether the process that started this helper is Lucium. Answers the words of its audit token when it is (for
 * `stillCaller`), nil when it is not or cannot be told: the helper then answers "caller" and does nothing else.
 */
func verifiedCaller(adHoc: AdHocRule) -> [UInt32]? {
  guard let token = parentToken(), let code = guestCode(token) else { return nil }
  if let team = ownTeam() {
    guard satisfies(code, luciumRequirement(team: team)) else { return nil }
    return words(token)
  }
  switch adHoc {
  case .refuse:
    return nil
  case .carrierApplication:
    guard let carrier = carrierApplication(), let path = codePath(code), path == carrier, satisfies(code, nil) else { return nil }
    return words(token)
  }
}

/// Whether the parent is still the process `verifiedCaller` checked: the same pid and the same pid version (an exec since would change it).
func stillCaller(_ checked: [UInt32]) -> Bool {
  guard let token = parentToken() else { return false }
  return words(token) == checked
}
