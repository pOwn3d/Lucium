import Network
import XCTest
@testable import Lucium

/// Lets a state handler that can fire several times resume a continuation once.
private final class FirstCall: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func isFirst() -> Bool { lock.withLock { defer { done = true }; return !done } }
}

/// A process that listens on `127.0.0.1:port` itself and answers every request with its own 404, the way a dev server or a session of another tool
/// does on the same Mac.
final class Squatter: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "app.lucium.tests.squatter")
    private(set) var port: UInt16 = 0

    init() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { connection in
            connection.start(queue: DispatchQueue(label: "app.lucium.tests.squatter.connection"))
            connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { _, _, _, _ in
                let head = "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain;charset=utf-8\r\nContent-Length: 9\r\n\r\nNot Found"
                connection.send(content: Data(head.utf8), contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in connection.cancel() })
            }
        }
    }

    func start() async throws {
        port = try await withCheckedThrowingContinuation { continuation in
            let once = FirstCall()
            listener.stateUpdateHandler = { [listener] state in
                switch state {
                case .ready:
                    if once.isFirst() { continuation.resume(returning: listener.port?.rawValue ?? 0) }
                case .failed(let error):
                    if once.isFirst() { continuation.resume(throwing: error) }
                default: break
                }
            }
            listener.start(queue: queue)
        }
    }

    func stop() { listener.cancel() }
}

/// The ports of the test servers (`LoopbackPort`): a server answers on its own port, and gives up one that another process answers on.
final class LoopbackPortTests: XCTestCase {
    private func get(_ port: UInt16, _ path: String) async throws -> (status: Int, body: String) {
        let (data, response) = try await URLSession(configuration: .ephemeral).data(from: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, String(decoding: data, as: UTF8.self))
    }

    func testAServerGivesUpAPortThatAnotherProcessListensOnAndAnswersOnItsOwn() async throws {
        let squatter = try Squatter()
        try await squatter.start()
        defer { squatter.stop() }

        let server = try LocalServer(routes: ["/a.html": .init(contentType: "text/html", body: "ours")], firstPort: squatter.port)
        let port = try await server.start()
        defer { server.stop() }

        XCTAssertNotEqual(port, squatter.port, "the port the other process listens on is not kept")
        let answer = try await get(port, "/a.html")
        XCTAssertEqual(answer.status, 200)
        XCTAssertEqual(answer.body, "ours", "the request reaches this server, not the other process")
        XCTAssertEqual(server.requestedPaths, ["/a.html"])
    }

    func testTheScriptedServerGivesUpSuchAPortToo() async throws {
        let squatter = try Squatter()
        try await squatter.start()
        defer { squatter.stop() }

        let server = try ScriptedServer(handler: { _ in .init(body: Data("ours".utf8)) }, firstPort: squatter.port)
        let port = try await server.start()
        defer { server.stop() }

        XCTAssertNotEqual(port, squatter.port)
        let answer = try await get(port, "/x")
        XCTAssertEqual(answer.body, "ours")
        XCTAssertEqual(server.requests.map(\.path), ["/x"])
    }

    /// The control: with no other process on the port, the server answers on the port it kept, and the probe that checked the port is not a request.
    func testAFreePortGivesARealServerAndTheProbeIsNotARequest() async throws {
        let server = try LocalServer(routes: ["/a.html": .init(contentType: "text/html", body: "ours")])
        let port = try await server.start()
        defer { server.stop() }
        XCTAssertEqual(server.requestedPaths, [], "the probe that checked the port is not a request")
        let answer = try await get(port, "/a.html")
        XCTAssertEqual(answer.body, "ours")
        XCTAssertEqual(server.requestedPaths, ["/a.html"])
    }
}
