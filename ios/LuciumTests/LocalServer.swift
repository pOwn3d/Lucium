import Foundation
import Network

/// A tiny HTTP server on the loopback interface, for tests that need a real page and real sub-resources: it answers fixed routes and
/// remembers which paths were asked for, so a test can prove that a blocked request never reached it.
final class LocalServer: @unchecked Sendable {
    struct Route {
        let contentType: String
        let body: String
        /// A route that takes the request and never answers: a page that is loading for as long as the test needs.
        static let hang = Route(contentType: "hang", body: "")
        /// A route that answers with a redirect to `location`.
        static func redirect(_ location: String) -> Route { Route(contentType: "redirect", body: location) }
    }

    /// What the server was asked: the path, and the headers of the request (names in lower case).
    struct Request: Equatable {
        let path: String
        let headers: [String: String]
    }

    private let listener: NWListener
    private let routes: [String: Route]
    private let lock = NSLock()
    private var asked: [Request] = []
    /// A server that accepts every connection and never answers: a site that is silent over TLS.
    private let silent: Bool
    private var hung: [NWConnection] = []
    private let queue = DispatchQueue(label: "app.lucium.tests.local-server")

    init(routes: [String: Route], silent: Bool = false) throws {
        self.silent = silent
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        listener = try NWListener(using: parameters)
        self.routes = routes
    }

    var requests: [Request] { lock.withLock { asked } }
    var requestedPaths: [String] { requests.map(\.path) }

    /// Starts listening and returns the port.
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
        lock.withLock { hung.forEach { $0.cancel() } }
    }

    private func serve(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, _, _ in
            guard let self, let data else { connection.cancel(); return }
            // Not text (the first bytes of a TLS handshake, say): a silent server keeps the connection and says nothing, the others hang up.
            guard let text = String(data: data, encoding: .utf8) else {
                if self.silent { self.lock.withLock { self.hung.append(connection) } } else { connection.cancel() }
                return
            }
            // "GET /path HTTP/1.1": the second word of the first line, then the headers up to the blank line.
            let lines = text.components(separatedBy: "\r\n")
            let path = lines.first?.split(separator: " ", maxSplits: 2).dropFirst().first.map(String.init) ?? ""
            var headers: [String: String] = [:]
            for line in lines.dropFirst().prefix(while: { !$0.isEmpty }) {
                guard let colon = line.firstIndex(of: ":") else { continue }
                headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            }
            self.lock.withLock { self.asked.append(Request(path: path, headers: headers)) }
            let route = self.routes[path]
            if route?.contentType == "hang" || self.silent {
                self.lock.withLock { self.hung.append(connection) }
                return
            }
            if route?.contentType == "redirect", let route {
                let head = "HTTP/1.1 302 Found\r\nLocation: \(route.body)\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                connection.send(content: Data(head.utf8), completion: .contentProcessed { _ in connection.cancel() })
                return
            }
            let body = route?.body ?? "not found"
            let head = "HTTP/1.1 \(route == nil ? "404 Not Found" : "200 OK")\r\nContent-Type: \(route?.contentType ?? "text/plain")\r\n"
                + "Content-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n"
            connection.send(content: Data((head + body).utf8), completion: .contentProcessed { _ in connection.cancel() })
        }
    }
}

/// Lets a state handler that can fire several times resume a continuation once.
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func first() -> Bool { lock.withLock { defer { done = true }; return !done } }
}
