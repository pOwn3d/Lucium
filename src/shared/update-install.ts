// What the installation of an update by Squirrel.Mac (Electron's autoUpdater, shell/app-update.ts) tells the user when it fails: a sentence
// that says what went wrong, then the words of Squirrel (English, for a report). Electron hands the error over with Squirrel's `domain` and `code`
// (electron_api_auto_updater.cc, OnError); the values below are those of Squirrel.Mac (SQRLUpdater.m, SQRLCodeSignature.m).

import { t } from './i18n'

/** The kinds of failure the user is told apart. */
export type InstallFailureKind = 'network' | 'signature' | 'feed' | 'package' | 'read-only' | 'other'

/** Squirrel.Mac's SQRLUpdaterErrorDomain codes. */
const SQUIRREL_UPDATER: Record<number, InstallFailureKind> = {
  // MissingUpdateBundle: no application in the archive, or (ElectronSquirrelPreventDowngrades) a version older than the running one.
  2: 'package',
  // PreparingUpdateJob: ShipIt could not be prepared.
  3: 'other',
  // RetrievingCodeSigningRequirement: the running application's own signature could not be read.
  4: 'signature',
  // InvalidServerResponse, InvalidJSON, InvalidServerBody: the release file.
  5: 'feed',
  6: 'feed',
  7: 'feed',
  // ReadOnlyVolume: run from a disk image, or translocated from the Downloads folder.
  8: 'read-only',
  // InvalidUpdatePackage: the download does not have the size or the SHA-256 the feed gives.
  9: 'package'
}

/** The error Electron's autoUpdater emits, as far as it is read here. */
export interface InstallError {
  message?: unknown
  code?: unknown
  domain?: unknown
}

/** Which kind of failure an error of the autoUpdater is. */
export function installFailureKind(error: InstallError | null | undefined): InstallFailureKind {
  const domain = typeof error?.domain === 'string' ? error.domain : ''
  const code = typeof error?.code === 'number' ? error.code : NaN
  if (domain === 'NSURLErrorDomain') return 'network'
  if (domain === 'SQRLCodeSignatureErrorDomain') return 'signature'
  if (domain === 'SQRLUpdaterErrorDomain') return SQUIRREL_UPDATER[code] ?? 'other'
  // Thrown by setFeedURL, without a domain: Squirrel could not read the signature of the running application (an unsigned build).
  if (typeof error?.message === 'string' && /code ?sign/i.test(error.message)) return 'signature'
  return 'other'
}

const SENTENCES: Record<InstallFailureKind, () => string> = {
  network: () => t('update-install.le-serveur-des-mises-a-jour-est-injoignable'),
  signature: () => t('update-install.la-signature-de-la-mise-a-jour-a-ete-refusee'),
  feed: () => t('update-install.le-flux-de-mises-a-jour-est-invalide'),
  package: () => t('update-install.l-archive-telechargee-a-ete-refusee'),
  'read-only': () => t('update-install.lucium-tourne-depuis-un-volume-en-lecture-seule'),
  other: () => t('update-install.l-installation-n-a-pas-pu-se-faire')
}

/** The reason shown to the user: the sentence of its kind, then Squirrel's own words when there are any. */
export function installFailureReason(error: InstallError | null | undefined): string {
  const sentence = SENTENCES[installFailureKind(error)]()
  const words = typeof error?.message === 'string' ? error.message.trim() : ''
  return words ? `${sentence}\n\n${t('update-install.detail-words', { words })}` : sentence
}

/** A look at the feed that got no answer (no network, a name that does not resolve, the time-out): the network sentence, then the engine's words. */
export const unreachableFeedReason = (words: string): string => installFailureReason({ domain: 'NSURLErrorDomain', message: words })
