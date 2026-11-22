// The box shown before a form with a password goes to an `http:` address (the form guard: src/preload/form-guard.ts, engine/electron-engine-preloads.ts).
// « Annuler » is the default button and the one Escape presses: nothing is sent unless « Envoyer quand même » is clicked.

import { dialog, type BrowserWindow } from 'electron'
import { t } from '@shared/i18n'

/** True when the user chose to send the password without encryption. The host is the one the form goes to (never the whole address, which may carry a token). */
export async function askInsecureForm(win: BrowserWindow | null, host: string): Promise<boolean> {
  const options = {
    type: 'warning' as const,
    message: t('insecure-form.titre'),
    detail: t('insecure-form.texte', { host: host.slice(0, 120) }),
    buttons: [t('confirm-box.annuler'), t('insecure-form.envoyer')],
    defaultId: 0,
    cancelId: 0
  }
  const answer = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return answer.response === 1
}
