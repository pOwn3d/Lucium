// The translation helper of Lucium's local page translation (src/main/translate/system.ts, docs/traduction-locale.md).
//
// macOS has its own translation (the Translation framework, the one of Safari and of the Translate app), run on this Mac with the languages
// the person installed in System Settings › General › Language & Region › Translation Languages. Electron cannot reach it: this program does,
// only with a session made by `TranslationSession(installedSource:target:)` (macOS 26): such a session cannot ask for a download
// (`canRequestDownloads` is false) and throws `notInstalled` instead. This program never downloads a language, never shows a window, and never
// calls `prepareTranslation()`.
//
// Two ways to run it (the main process picks one by the protocol the bundle's Info.plist names, `LuciumTranslateProtocol`):
//  - one request per run (the first protocol): the request comes as JSON on the standard input, until it ends; the answer goes as one line of
//    JSON to the standard output, and the program exits;
//  - a page per run (protocol 2): the first line is {"command":"hello","protocol":2}, answered {"ok":true,"protocol":2}; then each line is one
//    request with its "id", answered by one line with the same "id", one after the other in the order they came. The session of a pair is made
//    at its first translation and used again for the next batches (making it is the slow part). The program quits when its input ends (the main
//    process closes it after 45 s without a request, or quits), after `idleLimitMs` without a byte, at a line it cannot read (answered with a
//    code and no id), and as soon as its parent is not the process it checked any more.
//
//   {"command":"availability","from":"fr","to":"en"}                -> {"ok":true,"status":"installed"|"supported"|"unsupported"}
//   {"command":"translate","from":"fr","to":"en","texts":["…",…]}   -> {"ok":true,"texts":["…",…]}   (one for each text sent, in order)
//   any failure                                                      -> {"ok":false,"error":"<code>"}
// (with "id":<n> in each request and its answer, in protocol 2). Codes: caller, unavailable (macOS older than 26), not-installed, unsupported,
// too-large, invalid, cancelled, failed, error.
//
// Rules this file keeps (src/main/translate/system-native.test.ts reads them in this source):
//  - only Lucium is answered (native/shared/caller.swift, compiled with this file): the process that started the helper is checked before the
//    first line is read, by its signature (the team of the helper's own, Lucium's identifier); signed ad hoc, only the application that carries
//    the helper in its Contents/Helpers/ is answered. Anything else gets "caller". In protocol 2 the parent is checked again before each request
//    (`stillCaller`: the same process, not one that replaced it);
//  - the text never comes from an argument (`CommandLine` is not read) and is written nowhere but in the answer of a `translate`;
//  - nothing is logged: no print, no NSLog, no standard error; an error's description is never written (only a code);
//  - each request is bounded (bytes of its line, number of texts, characters of each and of all), with the same limits as the main process
//    (SYSTEM_TRANSLATE_LIMITS in src/main/translate/system.ts);
//  - no language is ever downloaded: no `prepareTranslation`, no `translationTask`, no session that can request downloads.

import Foundation
import Translation

let inputLimit = 256 * 1024
let maxTexts = 64
let maxTextChars = 2000
let maxTotalChars = 12000
/// The protocol of a run that serves a page (Info.plist `LuciumTranslateProtocol`, system.ts `SYSTEM_TRANSLATE_PROTOCOL`).
let protocolVersion = 2
/// A run that gets no byte for this long quits by itself (the main process closes its input sooner, after 45 s without a request).
let idleLimitMs: Int32 = 120_000
/// The largest id of a request (the main process counts from 1).
let maxId = 1 << 30
/// `\z` and not `$`: in ICU `$` also matches before a final line feed.
let languagePattern = "^[a-z]{2,3}\\z"

struct Failure: Error {
  let code: String
}

/// The standard input, read line by line, never more than a request's limit ahead: a line longer than `inputLimit` is not a request.
final class Input {
  private let descriptor = FileHandle.standardInput.fileDescriptor
  private var buffer = Data()
  private var ended = false

  /// The next line, without its line feed; when the input ends, what is left (the request of the first protocol has no line feed); nil when
  /// nothing is left, or when no byte came for `idleLimitMs`.
  func next() throws -> Data? {
    while true {
      if let newline = buffer.firstIndex(of: 0x0A) {
        let line = buffer.subdata(in: buffer.startIndex..<newline)
        buffer.removeSubrange(buffer.startIndex...newline)
        guard line.count <= inputLimit else { throw Failure(code: "too-large") }
        return line
      }
      guard buffer.count <= inputLimit else { throw Failure(code: "too-large") }
      if ended {
        if buffer.isEmpty { return nil }
        let rest = buffer
        buffer = Data()
        return rest
      }
      var waiting = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
      let ready = poll(&waiting, 1, idleLimitMs)
      if ready == 0 { return nil }
      if ready < 0 {
        if errno == EINTR { continue }
        return nil
      }
      var chunk = [UInt8](repeating: 0, count: 16 * 1024)
      let count = read(descriptor, &chunk, chunk.count)
      if count < 0 && errno == EINTR { continue }
      if count <= 0 {
        ended = true
        continue
      }
      buffer.append(contentsOf: chunk[0..<count])
    }
  }
}

/// One request: a JSON object, nothing else.
func parse(_ line: Data) throws -> [String: Any] {
  guard let object = try? JSONSerialization.jsonObject(with: line), let request = object as? [String: Any] else { throw Failure(code: "invalid") }
  return request
}

func language(_ request: [String: Any], _ field: String) throws -> String {
  guard let value = request[field] as? String, value.range(of: languagePattern, options: .regularExpression) != nil else { throw Failure(code: "invalid") }
  return value
}

/// The texts of a `translate`, checked against the limits before anything is given to the framework.
func texts(_ request: [String: Any]) throws -> [String] {
  guard let list = request["texts"] as? [Any], !list.isEmpty else { throw Failure(code: "invalid") }
  guard list.count <= maxTexts else { throw Failure(code: "too-large") }
  var out: [String] = []
  var total = 0
  for item in list {
    guard let text = item as? String else { throw Failure(code: "invalid") }
    // Characters as JavaScript counts them (UTF-16 code units), so that both sides agree on the limits.
    let length = text.utf16.count
    guard length <= maxTextChars else { throw Failure(code: "too-large") }
    total += length
    guard total <= maxTotalChars else { throw Failure(code: "too-large") }
    out.append(text)
  }
  return out
}

/// Whether a text has anything to translate: the framework refuses an empty one (`nothingToTranslate`), it comes back as it was.
func hasWords(_ text: String) -> Bool {
  return text.unicodeScalars.contains { !CharacterSet.whitespacesAndNewlines.contains($0) }
}

@available(macOS 26.0, *)
func status(from: String, to: String) async -> LanguageAvailability.Status {
  return await LanguageAvailability().status(from: Locale.Language(identifier: from), to: Locale.Language(identifier: to))
}

@available(macOS 26.0, *)
func statusName(_ status: LanguageAvailability.Status) -> String {
  switch status {
  case .installed: return "installed"
  case .supported: return "supported"
  case .unsupported: return "unsupported"
  @unknown default: return "unsupported"
  }
}

/// The code of a failure of the framework. Its description is never written: only a code the main process knows.
@available(macOS 26.0, *)
func failureOf(_ error: Error) -> Failure {
  if let failure = error as? Failure { return failure }
  if TranslationError.notInstalled ~= error { return Failure(code: "not-installed") }
  if TranslationError.unsupportedSourceLanguage ~= error || TranslationError.unsupportedTargetLanguage ~= error || TranslationError.unsupportedLanguagePairing ~= error {
    return Failure(code: "unsupported")
  }
  if TranslationError.alreadyCancelled ~= error || (error as? CocoaError)?.code == .userCancelled || error is CancellationError { return Failure(code: "cancelled") }
  return Failure(code: "failed")
}

/// The session of this run and the pair it was made for: made at the first translation of a pair, used again for the next batches of the page,
/// dropped when a translation fails or another pair is asked. Kept as an object: its type exists on macOS 26 only.
nonisolated(unsafe) var kept: (pair: String, session: AnyObject)? = nil

/// The session of a pair, made once per run: only for a pair already installed, and never one that could ask for a download.
@available(macOS 26.0, *)
func session(from: String, to: String) async throws -> TranslationSession {
  let pair = "\(from)-\(to)"
  if let kept, kept.pair == pair, let session = kept.session as? TranslationSession { return session }
  kept = nil
  // Only a pair already installed is translated: a pair that is merely supported would need a download, which this program never asks for.
  switch await status(from: from, to: to) {
  case .installed: break
  case .supported: throw Failure(code: "not-installed")
  default: throw Failure(code: "unsupported")
  }
  let session = TranslationSession(installedSource: Locale.Language(identifier: from), target: Locale.Language(identifier: to))
  // THE GUARD of "never a download": a session that could ask the person to download a language is not used.
  guard !session.canRequestDownloads else { throw Failure(code: "failed") }
  guard await session.isReady else { throw Failure(code: "not-installed") }
  kept = (pair: pair, session: session)
  return session
}

@available(macOS 26.0, *)
func translate(_ texts: [String], from: String, to: String) async throws -> [String] {
  let session = try await session(from: from, to: to)
  var out = texts
  var positions: [Int] = []
  var requests: [TranslationSession.Request] = []
  for (index, text) in texts.enumerated() where hasWords(text) {
    positions.append(index)
    requests.append(TranslationSession.Request(sourceText: text, clientIdentifier: String(index)))
  }
  if requests.isEmpty { return out }
  do {
    let responses = try await session.translations(from: requests)
    // The framework answers in the order of the requests; each answer is also checked against the request it names.
    guard responses.count == requests.count else { throw Failure(code: "failed") }
    for (k, response) in responses.enumerated() {
      guard response.clientIdentifier == String(positions[k]) else { throw Failure(code: "failed") }
      out[positions[k]] = response.targetText
    }
  } catch {
    // A session that failed is not used again: the next batch makes a new one (a language removed since, a service that restarted).
    kept = nil
    throw error
  }
  return out
}

func answer(_ object: [String: Any]) {
  let fallback = Data("{\"ok\":false,\"error\":\"error\"}".utf8)
  var data = (try? JSONSerialization.data(withJSONObject: object)) ?? fallback
  data.append(0x0A)
  FileHandle.standardOutput.write(data)
}

/// The answer to one request, without its id: every field is checked before the framework sees anything.
func respond(_ request: [String: Any]) async -> [String: Any] {
  do {
    let command = request["command"] as? String
    guard command == "availability" || command == "translate" else { throw Failure(code: "invalid") }
    let from = try language(request, "from")
    let to = try language(request, "to")
    guard from != to else { throw Failure(code: "invalid") }
    let batch = command == "translate" ? try texts(request) : []
    // The framework is reached only on macOS 26 and later: an older system has no session that works without a window.
    guard #available(macOS 26.0, *) else { throw Failure(code: "unavailable") }
    do {
      if command == "availability" { return ["ok": true, "status": statusName(await status(from: from, to: to))] }
      return ["ok": true, "texts": try await translate(batch, from: from, to: to)]
    } catch {
      throw failureOf(error)
    }
  } catch let failure as Failure {
    return ["ok": false, "error": failure.code]
  } catch {
    return ["ok": false, "error": "error"]
  }
}

/// The next request of the input; nil (after the answer that says why) when there is none to answer.
func nextRequest(_ input: Input) -> [String: Any]? {
  do {
    guard let line = try input.next() else { return nil }
    return try parse(line)
  } catch let failure as Failure {
    answer(["ok": false, "error": failure.code])
    return nil
  } catch {
    answer(["ok": false, "error": "error"])
    return nil
  }
}

func run() async {
  // THE GUARD for this helper, before anything is read: it translates for Lucium only (native/shared/caller.swift).
  guard let caller = verifiedCaller(adHoc: .carrierApplication) else {
    answer(["ok": false, "error": "caller"])
    return
  }
  let input = Input()
  guard let first = nextRequest(input) else { return }
  // The first protocol: this was the one request of the run.
  guard first["command"] as? String == "hello" else {
    answer(await respond(first))
    return
  }
  guard first["protocol"] as? Int == protocolVersion else {
    answer(["ok": false, "error": "invalid"])
    return
  }
  answer(["ok": true, "protocol": protocolVersion])
  while let request = nextRequest(input) {
    // THE GUARD of a run that lasts: the parent is still the very process checked at the start (an exec since would change it).
    guard stillCaller(caller) else {
      answer(["ok": false, "error": "caller"])
      return
    }
    guard let id = request["id"] as? Int, id > 0, id <= maxId else {
      answer(["ok": false, "error": "invalid"])
      return
    }
    var reply = await respond(request)
    reply["id"] = id
    answer(reply)
  }
}

await run()
exit(0)
