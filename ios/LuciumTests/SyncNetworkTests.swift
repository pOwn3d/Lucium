import LuciumKit
import Network
import Security
import XCTest
@testable import Lucium

/// A TLS server of a test, on the loopback: the Mac's side, written with the same system calls the phone uses, so that what is proved is what a connection really
/// does with the pins, the identities, the version and the ALPN. It records what its verification block saw of the client and every byte it received.
final class TestTLSServer: @unchecked Sendable {
    let identity: SyncIdentity
    private let listener: NWListener
    private let queue = DispatchQueue(label: "app.lucium.tests.server")
    private let lock = NSLock()
    private var clientFingerprints: [Data] = []
    private var chunks: [Data] = []
    private var accepted: [NetworkSyncTransport] = []
    private(set) var port: UInt16 = 0
    /// What to do with a connection once its handshake is done.
    var handler: @Sendable (NetworkSyncTransport) async -> Void = { _ in }

    var seenClientFingerprints: [Data] { lock.withLock { clientFingerprints } }
    var bytesReceived: Int { lock.withLock { chunks.reduce(0) { $0 + $1.count } } }

    init(identity: SyncIdentity, maxVersion: tls_protocol_version_t = .TLSv13, minVersion: tls_protocol_version_t = .TLSv13, alpn: String? = NetworkSyncConnector.alpn,
         requireClientCertificate: Bool = true) throws {
        self.identity = identity
        let tls = NWProtocolTLS.Options()
        let options = tls.securityProtocolOptions
        sec_protocol_options_set_min_tls_protocol_version(options, minVersion)
        sec_protocol_options_set_max_tls_protocol_version(options, maxVersion)
        if let alpn { sec_protocol_options_add_tls_application_protocol(options, alpn) }
        if let local = sec_identity_create(identity.identity) { sec_protocol_options_set_local_identity(options, local) }
        sec_protocol_options_set_peer_authentication_required(options, requireClientCertificate)
        let recorder = Recorder()
        sec_protocol_options_set_verify_block(options, { metadata, _, complete in
            _ = sec_protocol_metadata_access_peer_certificate_chain(metadata) { certificate in
                recorder.add(SyncCertificate.fingerprint(of: SecCertificateCopyData(sec_certificate_copy_ref(certificate).takeRetainedValue()) as Data))
            }
            complete(true)
        }, DispatchQueue(label: "app.lucium.tests.server.verify"))
        listener = try NWListener(using: NWParameters(tls: tls, tcp: NWProtocolTCP.Options()), on: .any)
        recorderBox = recorder
    }

    private final class Recorder: @unchecked Sendable {
        let lock = NSLock()
        var seen: [Data] = []
        func add(_ fingerprint: Data) { lock.withLock { seen.append(fingerprint) } }
    }
    private var recorderBox: Recorder?
    /// What the verification block saw: the certificates a client showed (none when the client stopped the handshake before showing its own).
    var shownByClients: [Data] { recorderBox?.lock.withLock { recorderBox?.seen ?? [] } ?? [] }

    func start() async throws {
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            let transport = NetworkSyncTransport(connection)
            self.lock.withLock { self.accepted.append(transport) }
            Task {
                do {
                    try await transport.start(timeout: .seconds(5))
                    await self.handler(transport)
                } catch {
                    // A handshake that the client broke off: what the tests look at is what the server saw, not this error.
                    print("[test] server side: \(error)")
                }
            }
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let once = OnceFlag()
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready: if once.take() { continuation.resume() }
                case .failed(let error): if once.take() { continuation.resume(throwing: error) }
                default: break
                }
            }
            listener.start(queue: queue)
        }
        port = listener.port?.rawValue ?? 0
    }

    func stop() {
        listener.cancel()
        let open = lock.withLock { accepted }
        for transport in open { transport.close() }
    }

    func note(_ bytes: Data) { lock.withLock { chunks.append(bytes) } }
}

private final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var taken = false
    func take() -> Bool { lock.withLock { defer { taken = true }; return !taken } }
}

/// A real TLS 1.3 connection with both identities and the Mac's pinned (docs/synchronisation.md §6.4), over the loopback.
final class SyncNetworkTests: XCTestCase {
    private var phoneStore: TestIdentityStore!
    private var macStore: TestIdentityStore!
    private var phone: SyncIdentity!
    private var mac: SyncIdentity!
    private var servers: [TestTLSServer] = []

    override func setUp() async throws {
        phoneStore = TestIdentityStore()
        macStore = TestIdentityStore()
        phone = try phoneStore.loadOrCreate()
        mac = try macStore.loadOrCreate()
    }

    override func tearDown() async throws {
        for server in servers { server.stop() }
        servers = []
        phoneStore.cleanUp()
        macStore.cleanUp()
    }

    private func server(maxVersion: tls_protocol_version_t = .TLSv13, minVersion: tls_protocol_version_t = .TLSv13, alpn: String? = NetworkSyncConnector.alpn,
                        identity: SyncIdentity? = nil) async throws -> TestTLSServer {
        let made = try TestTLSServer(identity: identity ?? mac, maxVersion: maxVersion, minVersion: minVersion, alpn: alpn)
        try await made.start()
        servers.append(made)
        return made
    }

    private func connector(loopback: Bool = true) -> NetworkSyncConnector { NetworkSyncConnector(identity: phone.identity, allowsLoopback: loopback) }

    // MARK: Identity

    func testTheIdentityIsMadeOnceKeptAndFormsAnIdentityFromAKeyAndACertificateTheProjectWrote() throws {
        let store = TestIdentityStore()
        defer { store.cleanUp() }
        XCTAssertTrue(store.isEmpty)
        let first = try store.loadOrCreate()
        let second = try store.loadOrCreate()
        XCTAssertEqual(first.certificate, second.certificate, "an identity that exists is not made again")
        XCTAssertEqual(first.fingerprint.count, 32)
        XCTAssertEqual(try XCTUnwrap(try store.load()).fingerprint, first.fingerprint)
        var key: SecKey?
        XCTAssertEqual(SecIdentityCopyPrivateKey(first.identity, &key), errSecSuccess, "the key of the identity is the one made on this phone")
        XCTAssertNotNil(key)
        let certificate = try XCTUnwrap(SecCertificateCreateWithData(nil, first.certificate as CFData))
        XCTAssertEqual(SecCertificateCopySubjectSummary(certificate) as String?, "lucium-sync")
        // §3.3: the key never leaves the phone (it is not extractable, it is not in a backup that goes to another phone, it does not travel through the iCloud keychain).
        for kind in [kSecClassKey, kSecClassCertificate] {
            let query: [String: Any] = [kSecClass as String: kind, kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll, kSecAttrSynchronizable as String: kSecAttrSynchronizableAny]
            var found: CFTypeRef?
            XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &found), errSecSuccess)
            let mine = (found as? [[String: Any]] ?? []).filter { ($0[kSecAttrLabel as String] as? String)?.contains("tests.") == true || ($0[kSecAttrApplicationTag as String] as? Data).flatMap { String(data: $0, encoding: .utf8) }?.contains("tests.") == true }
            XCTAssertFalse(mine.isEmpty, "the items of the store are in the keychain")
            for item in mine {
                // What the keychain was asked for and keeps. Whether the system also refuses to export the key is not proved here: on the simulator it does not
                // (`SecKeyCopyExternalRepresentation` gives the bytes of the key whatever this attribute says), and a device has not been tried.
                if kind == kSecClassKey { XCTAssertEqual(item[kSecAttrIsExtractable as String] as? Bool, false, "the key is made not extractable") }
                XCTAssertEqual(item[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String, "usable after the first unlock, on this phone only")
                XCTAssertNotEqual(item[kSecAttrSynchronizable as String] as? Bool, true, "never through the iCloud keychain")
            }
        }
        try store.delete()
        XCTAssertTrue(store.isEmpty, "forgetting removes the key and the certificate")
        XCTAssertNotEqual(try store.loadOrCreate().fingerprint, first.fingerprint, "a new identity is a new certificate: a Mac has to pair again")
    }

    func testTwoStoresWithDifferentTagsDoNotShareTheirItems() throws {
        XCTAssertNotEqual(phone.fingerprint, mac.fingerprint)
        XCTAssertEqual(try XCTUnwrap(try phoneStore.load()).fingerprint, phone.fingerprint)
        XCTAssertEqual(try XCTUnwrap(try macStore.load()).fingerprint, mac.fingerprint)
    }

    // MARK: The connection

    func testAPinnedConnectionIsMutualTLS13WithTheProjectsALPNAndEachSideSeesTheOthersFingerprint() async throws {
        let server = try await server()
        server.handler = { transport in
            do {
                let hello = try await transport.receive()
                server.note(hello)
                try await transport.send(Data("pong".utf8))
            } catch { print("[test] server handler: \(error)") }
        }
        let connection = try await connector().connect(host: "127.0.0.1", port: server.port, pin: .fingerprint(mac.fingerprint), timeout: .seconds(5))
        XCTAssertEqual(connection.presentedFingerprint, mac.fingerprint)
        let transport = try XCTUnwrap(connection.transport as? NetworkSyncTransport)
        let negotiated = try XCTUnwrap(transport.negotiated())
        XCTAssertEqual(negotiated.tlsVersion, .TLSv13)
        XCTAssertEqual(negotiated.alpn, "lucium-sync/1")
        try await connection.transport.send(Data("ping".utf8))
        let answer = try await connection.transport.receive()
        XCTAssertEqual(answer, Data("pong".utf8))
        XCTAssertEqual(server.bytesReceived, 4)
        XCTAssertEqual(server.shownByClients, [phone.fingerprint], "the Mac saw the certificate of the phone, the one it will pin")
        connection.transport.close()
    }

    func testACertificateThatIsNotThePinnedOneStopsTheHandshakeBeforeThePhoneShowsItsOwn() async throws {
        let server = try await server()
        let wrong = Data(repeating: 0x42, count: 32)
        do {
            _ = try await connector().connect(host: "127.0.0.1", port: server.port, pin: .fingerprint(wrong), timeout: .seconds(5))
            XCTFail("a certificate that is not the pinned one was accepted")
        } catch let error as SyncConnectError {
            XCTAssertEqual(error, .fingerprintMismatch)
        }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(server.shownByClients, [], "the phone never showed its certificate to a device that is not the pinned one")
        XCTAssertEqual(server.bytesReceived, 0)
    }

    func testATypedCodeHasNothingToPinAndHandsBackWhatTheMacShowed() async throws {
        let server = try await server()
        let connection = try await connector().connect(host: "127.0.0.1", port: server.port, pin: .learn, timeout: .seconds(5))
        XCTAssertEqual(connection.presentedFingerprint, mac.fingerprint)
        connection.transport.close()
    }

    func testAServerThatOnlySpeaksTLS12IsRefused() async throws {
        let server = try await server(maxVersion: .TLSv12, minVersion: .TLSv12)
        do {
            let connection = try await connector().connect(host: "127.0.0.1", port: server.port, pin: .learn, timeout: .seconds(3))
            connection.transport.close()
            XCTFail("TLS 1.2 was accepted")
        } catch let error as SyncConnectError {
            XCTAssertNotEqual(error, .refused)
        }
        XCTAssertEqual(server.bytesReceived, 0)
    }

    func testAServerWithAnotherALPNIsRefused() async throws {
        let server = try await server(alpn: "lucium-sync/2")
        do {
            let connection = try await connector().connect(host: "127.0.0.1", port: server.port, pin: .learn, timeout: .seconds(3))
            connection.transport.close()
            XCTFail("a protocol the phone does not speak was accepted")
        } catch is SyncConnectError {
        }
    }

    func testAClosedPortIsARefusalAndASilentServerIsATimeout() async throws {
        let closed = try await server()
        let port = closed.port
        closed.stop()
        try await Task.sleep(for: .milliseconds(200))
        do {
            _ = try await connector().connect(host: "127.0.0.1", port: port, pin: .learn, timeout: .seconds(3))
            XCTFail("a closed port gave a connection")
        } catch let error as SyncConnectError {
            XCTAssertEqual(error, .refused, "nobody listens: the Mac is there and its window is closed")
        }
        // A listener that accepts the TCP connection and says nothing: the handshake never ends.
        let silent = try NWListener(using: .tcp, on: .any)
        let held = HeldConnections()
        silent.newConnectionHandler = { connection in
            held.add(connection)
            connection.start(queue: .global())
        }
        let ready = expectation(description: "listener ready")
        silent.stateUpdateHandler = { if case .ready = $0 { ready.fulfill() } }
        silent.start(queue: .global())
        await fulfillment(of: [ready], timeout: 5)
        defer { silent.cancel(); held.cancelAll() }
        do {
            _ = try await connector().connect(host: "127.0.0.1", port: try XCTUnwrap(silent.port).rawValue, pin: .learn, timeout: .milliseconds(500))
            XCTFail("a silent server gave a connection")
        } catch let error as SyncConnectError {
            XCTAssertEqual(error, .timedOut)
        }
    }

    func testTheApplicationNeverConnectsToAnAddressThatIsNotLocalNorToTheLoopback() async throws {
        let server = try await server()
        for host in ["8.8.8.8", "example.com", "127.0.0.1", "::1", "localhost"] {
            do {
                _ = try await connector(loopback: false).connect(host: host, port: server.port, pin: .learn, timeout: .seconds(1))
                XCTFail("\(host) was reached by the application's connector")
            } catch let error as SyncConnectError {
                XCTAssertEqual(error, .failed("not a local address"), host)
            }
        }
        XCTAssertEqual(server.shownByClients, [], "no connection reached the server")
    }

    // MARK: A pairing and a session, over TLS

    private let secret = Data((0..<16).map { UInt8($0 &* 7 &+ 1) })

    private func macScript(secret: Data, server: TestTLSServer) -> @Sendable (NetworkSyncTransport, Data) async -> Void {
        { [weak server] transport, macFingerprint in
            do {
                let mac = TestMac(transport)
                let nonce = Data((0..<16).map { UInt8(200 - $0) })
                try await mac.write("pair.challenge", ["nonce": SyncEncoding.base64url(nonce)])
                let request = try await mac.read()
                let device = request["device"] as? [String: Any]
                let phoneNonce = SyncEncoding.base64urlDecode(request["nonce"] as? String ?? "", characters: 22) ?? Data()
                // The phone's fingerprint is not in the message: the Mac takes it from the certificate the phone showed in the handshake.
                let phoneFingerprint = server?.shownByClients.last ?? Data()
                let inputs = SyncProofInputs(secret: secret, fingerprintMac: macFingerprint, fingerprintPhone: phoneFingerprint, nonceMac: nonce, noncePhone: phoneNonce,
                                             idMac: "mac-test-0000000001", idPhone: device?["id"] as? String ?? "")
                guard SyncProof.requestTag(inputs).map(SyncEncoding.base64url) == request["proof"] as? String else {
                    try await mac.write("error", ["code": "bad-proof", "fatal": true])
                    return
                }
                // The commitment exchange (§4.7): the Mac's code nonce goes out after a right proof, and the phone reveals its own.
                try await mac.write("pair.nonce", ["nonce": SyncEncoding.base64url(Data(repeating: 0x61, count: 16))])
                _ = try await mac.read()
                let accept = SyncProof.acceptTag(inputs).map(SyncEncoding.base64url) ?? ""
                try await mac.write("pair.accept", ["device": ["id": "mac-test-0000000001", "name": "Mac de test", "platform": "mac"], "proof": accept, "hosts": ["mac-de-test.local"], "port": 49213])
                // The phone's person says yes (§4.6): a bye, which the Mac answers with its own once it has kept the phone.
                let word = try await mac.read()
                if word["t"] as? String == "bye" { try await mac.write("bye") }
            } catch { print("[test] mac script: \(error)") }
        }
    }

    func testAPairingGoesThroughAndTheMacIsKnownByWhatItProved() async throws {
        let server = try await server()
        let script = macScript(secret: secret, server: server)
        let macFingerprint = mac.fingerprint
        server.handler = { transport in await script(transport, macFingerprint) }
        let code = SyncPairingCode(fingerprint: mac.fingerprint, secret: secret, port: server.port, hosts: ["127.0.0.1"])
        let connection = try await connector().connect(host: "127.0.0.1", port: server.port, pin: .fingerprint(mac.fingerprint), timeout: .seconds(5))
        let outcome = try await SyncPairingClient.pair(code: code, connection: connection, ownFingerprint: phone.fingerprint,
                                                      device: SyncDeviceInfo(id: "phone-test-000000001", name: "iPhone de test", platform: .ios), nonce: Data(repeating: 5, count: 16), codeNonce: Data(repeating: 6, count: 16),
                                                      handshakeTimeout: .seconds(5), confirmationTimeout: .seconds(5), confirm: { _ in true })
        XCTAssertEqual(outcome.mac.id, "mac-test-0000000001")
        XCTAssertEqual(outcome.fingerprint, mac.fingerprint)
        XCTAssertEqual(outcome.hosts, ["mac-de-test.local"])
    }

    func testAPairingWithTheWrongSecretIsRefusedByTheMacAndRegistersNothing() async throws {
        let server = try await server()
        let script = macScript(secret: Data(repeating: 9, count: 16), server: server)
        let macFingerprint = mac.fingerprint
        server.handler = { transport in await script(transport, macFingerprint) }
        let code = SyncPairingCode(fingerprint: mac.fingerprint, secret: secret, port: server.port, hosts: ["127.0.0.1"])
        let connection = try await connector().connect(host: "127.0.0.1", port: server.port, pin: .fingerprint(mac.fingerprint), timeout: .seconds(5))
        do {
            _ = try await SyncPairingClient.pair(code: code, connection: connection, ownFingerprint: phone.fingerprint,
                                                device: SyncDeviceInfo(id: "phone-test-000000001", name: "iPhone de test", platform: .ios), nonce: Data(repeating: 5, count: 16), codeNonce: Data(repeating: 6, count: 16),
                                                handshakeTimeout: .seconds(5), confirmationTimeout: .seconds(5), confirm: { _ in true })
            XCTFail("a pairing with the wrong secret went through")
        } catch let failure as SyncFailure {
            XCTAssertEqual(failure.code, .badProof)
        }
    }
}

private final class HeldConnections: @unchecked Sendable {
    private let lock = NSLock()
    private var held: [NWConnection] = []
    func add(_ connection: NWConnection) { lock.withLock { held.append(connection) } }
    func cancelAll() { lock.withLock { held.forEach { $0.cancel() } } }
}
