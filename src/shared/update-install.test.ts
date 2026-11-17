import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import { installFailureKind, installFailureReason, unreachableFeedReason } from './update-install'
import { frenchSpaces } from './french-typography'

// The errors as Electron hands them over from Squirrel.Mac (electron_api_auto_updater.cc sets `code` and `domain`; the words are Squirrel's).
const squirrel = (code: number, message: string) => ({ domain: 'SQRLUpdaterErrorDomain', code, message })

afterEach(() => setLanguage('fr'))

describe('installFailureKind', () => {
  it('tells the network, the signature and the feed apart', () => {
    expect(installFailureKind({ domain: 'NSURLErrorDomain', code: -1009, message: 'The Internet connection appears to be offline.' })).toBe('network')
    expect(installFailureKind({ domain: 'SQRLCodeSignatureErrorDomain', code: -1, message: 'Code signature at URL file:///… did not pass validation' })).toBe('signature')
    expect(installFailureKind(squirrel(4, 'Failed to retrieve the code signing requirement'))).toBe('signature')
    for (const code of [5, 6, 7]) expect(installFailureKind(squirrel(code, 'Invalid'))).toBe('feed')
  })

  it('names the archive refused (size, digest, an older version) and the read-only volume', () => {
    expect(installFailureKind(squirrel(9, 'Update download failed: The downloaded file is 12 bytes, expected 128172732.'))).toBe('package')
    expect(installFailureKind(squirrel(2, 'Cannot update to a bundle with a lower version number'))).toBe('package')
    expect(installFailureKind(squirrel(8, 'Cannot update while running on a read-only volume'))).toBe('read-only')
  })

  it('reads the throw of setFeedURL on an application Squirrel cannot read the signature of, and calls anything else "other"', () => {
    expect(installFailureKind({ message: 'Could not get code signature for running application' })).toBe('signature')
    expect(installFailureKind({ message: 'No update available, can’t quit and install' })).toBe('other')
    expect(installFailureKind(squirrel(3, 'Could not prepare'))).toBe('other')
    expect(installFailureKind(null)).toBe('other')
    expect(installFailureKind({ domain: 7, code: 'x' })).toBe('other')
  })
})

describe('installFailureReason', () => {
  it('says what went wrong in plain words, then Squirrel’s own', () => {
    expect(installFailureReason({ domain: 'NSURLErrorDomain', message: 'offline' })).toBe(frenchSpaces('Le serveur des mises à jour est injoignable : vérifiez la connexion à Internet, puis réessayez.\n\nDétail : offline'))
    expect(installFailureReason({ domain: 'SQRLCodeSignatureErrorDomain', message: 'did not pass validation' })).toMatch(/^La signature de la mise à jour a été refusée/)
    expect(installFailureReason(squirrel(7, 'bad body'))).toMatch(/^Le flux de mises à jour n’est pas valide/)
    expect(installFailureReason(squirrel(8, 'read-only'))).toMatch(/dossier Applications/)
    expect(installFailureReason(null)).toBe('La mise à jour n’a pas pu se faire.')
  })

  it('speaks the language of the interface', () => {
    setLanguage('en')
    expect(installFailureReason({ domain: 'SQRLCodeSignatureErrorDomain', message: 'x' })).toBe('The signature of the update was refused: it doesn’t come from the same developer as this Lucium, or it is damaged. Nothing was installed.\n\nDetail: x')
  })

  it('reports a look at the feed that got no answer as the network', () => {
    expect(unreachableFeedReason('net::ERR_NAME_NOT_RESOLVED')).toMatch(/^Le serveur des mises à jour est injoignable.*\n\nDétail\u00a0: net::ERR_NAME_NOT_RESOLVED$/s)
  })
})
