// Where the private key of the device is sealed (docs/synchronisation.md §3.3): `safeStorage` of Electron on the Mac, which seals with a key of the system's
// keychain. The key never reaches the disk in clear. The sealing is a port, so that the identity is tested without Electron: a test puts a stand-in.

export interface SecretBox {
  /** Whether the system can seal at all (no keychain, no sealing: the synchronisation then refuses to start rather than write a key in clear). */
  available(): boolean
  seal(plain: Buffer): Buffer
  /** Throws when the sealed bytes cannot be opened here (another machine, another user, a keychain that refuses). */
  open(sealed: Buffer): Buffer
}
