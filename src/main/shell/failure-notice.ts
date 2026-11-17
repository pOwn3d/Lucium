// What a command that failed leaves behind: a line in the journal that says which one and why, and a toast, so that the user is not left
// looking at a button that did nothing. The journal alone was what these paths left.

import { t } from '@shared/i18n'

/** The sentence when the command says nothing of its own: a function, so that it is read in the language of the moment, not of the module's loading. */
export const commandFailed = (): string => t('failure-notice.la-commande-n-a-pas-pu-etre-executee')

export function noteFailure(logLine: string, error: unknown, toast: (message: string) => void, message: string = commandFailed()): void {
  console.error(logLine, error)
  toast(message)
}
