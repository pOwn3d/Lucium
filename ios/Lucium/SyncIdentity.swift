import CryptoKit
import Foundation
import LuciumKit
import Security

/// This phone's identity for the synchronisation: a P-256 key made on the phone and never exported, and the self-signed certificate written by hand around it
/// (docs/synchronisation.md §3.2, §6.3). The certificate's SHA-256 is the fingerprint the Mac pins.
/// `SecIdentity` is a reference to an immutable keychain item, safe to use from any thread; the compiler cannot know that of a Core Foundation type.
struct SyncIdentity: @unchecked Sendable {
    let identity: SecIdentity
    let certificate: Data

    var fingerprint: Data { SyncCertificate.fingerprint(of: certificate) }
}

/// Where the identity is kept. The real one is the keychain; a test may give another.
protocol SyncIdentityStoring: Sendable {
    /// The identity, or nil when there is none (never made, or lost with a restore).
    func load() throws -> SyncIdentity?
    /// Makes the identity (the key, the certificate) and keeps it. Replaces nothing: an identity that exists is returned as it is.
    func loadOrCreate() throws -> SyncIdentity
    /// Forgets the identity: the key and the certificate are removed. A Mac that was paired with it can no longer be reached, which is the point.
    func delete() throws
}

enum SyncIdentityError: Error, Equatable {
    case keychain(String, OSStatus)
    case noIdentity
}

/// The keychain of the phone. The key is a keychain item that is not extractable and is usable only after the first unlock of the phone and only on this
/// phone (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: it is not part of a backup that goes to another phone and does not travel through the iCloud
/// keychain); there is no `kSecAttrSynchronizable`. The certificate is a keychain item next to it, and the system forms the identity from the two.
struct KeychainSyncIdentityStore: SyncIdentityStoring {
    /// What tells this identity's items from any other of the application. A test gives its own, so that it never touches the real one.
    let tag: String

    init(tag: String = "app.lucium.sync.identity") { self.tag = tag }

    private var keyTag: Data { Data(tag.utf8) }

    func load() throws -> SyncIdentity? {
        guard let certificate = try storedCertificate() else { return nil }
        // An identity is a certificate with its key: ask the keychain for the identities and take the one that holds this certificate.
        let query: [String: Any] = [kSecClass as String: kSecClassIdentity, kSecReturnRef as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let identities = result as? [SecIdentity] else { throw SyncIdentityError.keychain("identities", status) }
        for identity in identities {
            var certificateRef: SecCertificate?
            guard SecIdentityCopyCertificate(identity, &certificateRef) == errSecSuccess, let certificateRef else { continue }
            if (SecCertificateCopyData(certificateRef) as Data) == certificate { return SyncIdentity(identity: identity, certificate: certificate) }
        }
        return nil
    }

    func loadOrCreate() throws -> SyncIdentity {
        if let existing = try load() { return existing }
        // A half made identity (a key without its certificate, a certificate without its key: the app was stopped between the two) is removed and made again.
        try delete()
        let key = try makeKey()
        var random = Data(count: 16)
        let filled = random.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        guard filled == errSecSuccess, let serial = SyncCertificate.serial(fromRandom: random) else { throw SyncIdentityError.keychain("random", filled) }
        let der = try SyncCertificate.make(privateKey: key, serial: serial)
        guard let certificate = SecCertificateCreateWithData(nil, der as CFData) else { throw SyncIdentityError.keychain("certificate", errSecDecode) }
        let add: [String: Any] = [kSecClass as String: kSecClassCertificate, kSecValueRef as String: certificate, kSecAttrLabel as String: tag,
                                  kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else {
            try? delete()
            throw SyncIdentityError.keychain("add certificate", status)
        }
        guard let made = try load() else {
            try? delete()
            throw SyncIdentityError.noIdentity
        }
        return made
    }

    func delete() throws {
        for (name, query) in [("certificate", [kSecClass as String: kSecClassCertificate, kSecAttrLabel as String: tag]),
                              ("key", [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: keyTag])] as [(String, [String: Any])] {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw SyncIdentityError.keychain("delete \(name)", status) }
        }
    }

    private func makeKey() throws -> SecKey {
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrIsExtractable as String: false,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: keyTag,
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                kSecAttrIsExtractable as String: false,
            ],
        ]
        var failure: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &failure) else {
            throw SyncIdentityError.keychain("key: \(failure?.takeRetainedValue().localizedDescription ?? "no key")", errSecParam)
        }
        return key
    }

    private func storedCertificate() throws -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassCertificate, kSecAttrLabel as String: tag, kSecReturnRef as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let result else { throw SyncIdentityError.keychain("certificate", status) }
        return SecCertificateCopyData(unsafeDowncast(result as AnyObject, to: SecCertificate.self)) as Data
    }
}
