import Foundation
import Network

/// The loopback port of a test server, and the proof that the server is the one that answers on it. The simulator shares the loopback of the Mac with
/// every other process on it (another worker's simulator, a dev server, a Claude Code session that listens on `127.0.0.1`). The kernel can give a
/// listener a port that another process already listens on, bound to `127.0.0.1` itself: a connection to `127.0.0.1:port` then goes to the other
/// process, which answers its own 404, and the test never sees a request (a download that never starts, a page that never loads: one run in several
/// hundred, found by seeing the answer of a server that was not ours, headers and all, while ours had served nothing).
final class LoopbackPort: @unchecked Sendable {
    struct NoFreePort: Error {}

    private let lock = NSLock()
    private var probing = false
    private var reached = false

    /// A listener on the loopback interface: on `port` when it is given, else on a port the kernel picks.
    static func makeListener(port: UInt16? = nil) throws -> NWListener {
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        if let port, let endpoint = NWEndpoint.Port(rawValue: port) { return try NWListener(using: parameters, on: endpoint) }
        return try NWListener(using: parameters)
    }

    /// Called first by the new-connection handler of a server: `true` when the connection is the probe's (the caller drops it).
    func intercept(_ connection: NWConnection) -> Bool {
        let isProbe = lock.withLock { () -> Bool in
            guard probing else { return false }
            reached = true
            return true
        }
        if isProbe { connection.cancel() }
        return isProbe
    }

    /// Whether a connection made to `127.0.0.1:port` reaches the listener this object is watching (it does not when another process listens there).
    func owns(port: UInt16) async -> Bool {
        guard let endpoint = NWEndpoint.Port(rawValue: port) else { return false }
        lock.withLock { probing = true; reached = false }
        defer { lock.withLock { probing = false } }
        let probe = NWConnection(host: "127.0.0.1", port: endpoint, using: .tcp)
        probe.start(queue: DispatchQueue(label: "app.lucium.tests.port-probe"))
        defer { probe.cancel() }
        let deadline = ContinuousClock.now + .seconds(3)
        while ContinuousClock.now < deadline {
            if lock.withLock({ reached }) { return true }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return false
    }
}
