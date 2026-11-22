import { t } from './i18n'
import { BLOCKED_EXTENSIONS } from './extension-blocklist-data'

/** Why an extension is on the list: the word the message uses. */
export type BlockReason = 'malware' | 'spyware' | 'adware' | 'compromised'

export interface BlockedExtension {
  /** The 32 letters (a to p) of the extension's identifier. */
  id: string
  reason: BlockReason
}

/** The entry for an extension, or undefined when it is not on the list. The list is the one embedded in the application: no network is involved. */
export function blockedExtension(id: string, list: readonly BlockedExtension[] = BLOCKED_EXTENSIONS): BlockedExtension | undefined {
  return list.find((entry) => entry.id === id)
}

const REASONS: Record<BlockReason, () => string> = {
  malware: () => t('blocklist.reason-malware'),
  spyware: () => t('blocklist.reason-spyware'),
  adware: () => t('blocklist.reason-adware'),
  compromised: () => t('blocklist.reason-compromised')
}

/** What the person is told when an install of a listed extension is refused. */
export const blockedInstallMessage = (entry: BlockedExtension, name: string): string => t('blocklist.install-refused', { name, reason: REASONS[entry.reason]() })

/** What the person is told when a listed extension that was already there is turned off. */
export const blockedDisabledMessage = (entry: BlockedExtension, name: string): string => t('blocklist.turned-off', { name, reason: REASONS[entry.reason]() })
