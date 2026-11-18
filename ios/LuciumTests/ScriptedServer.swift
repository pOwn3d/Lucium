import Foundation
import Network

/// A server on the loopback interface whose answers a test writes byte by byte when it needs to: a response that announces more than it sends (a
/// connection that ends early), one that stalls after a few bytes (a download that is under way), one that honours `Range`. `LocalServer` answers fixed
/// routes; the downloads need to say how the answer ends.
final class ScriptedServer: @unchecked Sendable {
    struct Reply {
        var status = 200
        var headers: [String: String] = [:]
        var body = Data()
        /// What `Content-Length` says when it is not the length of the body: a connection that ends before it ends a download in failure.
        var announcedLength: Int?
        /// How many bytes go out at once; the rest waits for `release()` (a download that stalls). `nil`: everything at once.
        var stallAfter: Int?
    }

    struct Request: Equatable {
        let path: String
        let headers: [String: String]
    }

    typealias Handler = @Sendable (Request) -> Reply

    private let listener: NWListener
    private let handler: Handler
    private let lock = NSLock()
    private var seen: [Request] = []
    private var held: [(connection: NWConnection, rest: Data)] = []
    private let queue = DispatchQueue(label: "app.lucium.tests.scripted-server")

    init(handler: @escaping Handler) throws {
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        listener = try NWListener(using: parameters)
        self.handler = handler
    }

    var requests: [Request] { lock.withLock { seen } }

    func start() async throws -> UInt16 {
        listener.newConnectionHandler = { [weak self] connection in self?.serve(connection) }
        return try await withCheckedThrowingContinuation { continuation in
            let once = Once()
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if once.first(), let port = self.listener.port?.rawValue { continuation.resume(returning: port) }
                case .failed(let error):
                    if once.first() { continuation.resume(throwing: error) }
                default: break
                }
            }
            listener.start(queue: queue)
        }
    }

    func stop() {
        listener.cancel()
        lock.withLock { held.forEach { $0.connection.cancel() } }
    }

    /// Sends what the stalled answers were holding back, and ends them.
    func release() {
        let waiting = lock.withLock { () -> [(connection: NWConnection, rest: Data)] in
            defer { held = [] }
            return held
        }
        for entry in waiting {
            // The last message closes the connection gracefully (a FIN after the data): cancelling at once can reset it before the client has read.
            entry.connection.send(content: entry.rest, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in entry.connection.cancel() })
        }
    }

    private func serve(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, _, _ in
            guard let self, let data, let text = String(data: data, encoding: .utf8) else { connection.cancel(); return }
            let request = Self.parse(text)
            self.lock.withLock { self.seen.append(request) }
            let reply = self.handler(request)
            var head = "HTTP/1.1 \(reply.status) \(Self.reason(reply.status))\r\n"
            for (name, value) in reply.headers { head += "\(name): \(value)\r\n" }
            head += "Content-Length: \(reply.announcedLength ?? reply.body.count)\r\nConnection: close\r\n\r\n"
            let first = reply.stallAfter.map { reply.body.prefix($0) } ?? reply.body
            if reply.stallAfter != nil {
                self.lock.withLock { self.held.append((connection, reply.body.dropFirst(first.count))) }
                connection.send(content: Data(head.utf8) + first, completion: .contentProcessed { _ in })
            } else {
                connection.send(content: Data(head.utf8) + first, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in connection.cancel() })
            }
        }
    }

    /// "GET /path HTTP/1.1" and the header lines under it (names in lower case).
    private static func parse(_ text: String) -> Request {
        let lines = text.components(separatedBy: "\r\n")
        let path = lines.first?.split(separator: " ", maxSplits: 2).dropFirst().first.map(String.init) ?? ""
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        return Request(path: path, headers: headers)
    }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: "OK"
        case 206: "Partial Content"
        case 404: "Not Found"
        default: "Status"
        }
    }
}

/// Lets a state handler that can fire several times resume a continuation once.
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func first() -> Bool { lock.withLock { defer { done = true }; return !done } }
}
