import CryptoKit
import Foundation

/// The identifier of the data store (cookies, storage) of a profile. It is derived from the profile's id, so that nothing has to be kept for it:
/// the same profile finds the same store after a restart, after a restore of the state file, and on a new install that reads a state from the
/// Mac. Two profiles never get the same one.
public enum ProfileStore {
    public static func identifier(for profileId: String) -> UUID {
        let digest = Array(SHA256.hash(data: Data("app.lucium.browser.ios.profile:\(profileId)".utf8)).prefix(16))
        var bytes = digest
        bytes[6] = (bytes[6] & 0x0F) | 0x80  // version 8: a name-based identifier of our own (RFC 9562)
        bytes[8] = (bytes[8] & 0x3F) | 0x80  // variant 10
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                           bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }
}
