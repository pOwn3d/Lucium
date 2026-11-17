// What the buttons of « Signaler un problème » do, apart from the picture: the report is asked of the main process, « Copier » puts it on the clipboard,
// « Enregistrer… » has the main process write it where the user chooses. Each ends in a sentence, never in silence (except giving up the save dialog),
// and nothing here sends anything anywhere. The bridge is a parameter, so that the tests stand a fake in for it.

import { number } from '@shared/engine-status'
import { t } from '@shared/i18n'
import type { ProblemReportSave, ProblemReportView } from '@shared/problem-report'

/** The part of the bridge (`window.lucium`) the sheet uses. */
export interface ProblemReportBridge {
  problemReport(): Promise<string | null>
  saveProblemReport(): Promise<ProblemReportSave>
  writeClipboardText(text: string): Promise<boolean>
}

/** The line under the buttons: what was done, or why not. */
export interface ReportNotice {
  text: string
  failed: boolean
}

/** The report to show: the text, or that it could not be prepared (the window is closing, the application is locked, a source failed). */
export async function loadReport(bridge: Pick<ProblemReportBridge, 'problemReport'>): Promise<ProblemReportView> {
  try {
    const text = await bridge.problemReport()
    // The answer of a channel is data: anything but a text is a report that was not made.
    return typeof text === 'string' && text.length > 0 ? { state: 'ready', text } : { state: 'failed' }
  } catch (error) {
    console.warn('[report] the report could not be asked for:', error instanceof Error ? error.name : typeof error)
    return { state: 'failed' }
  }
}

/** « Copier »: the report on the clipboard, and the sentence that says so (or that the clipboard refused; the text stays readable in the sheet). */
export async function copyReport(bridge: Pick<ProblemReportBridge, 'writeClipboardText'>, text: string): Promise<ReportNotice> {
  try {
    if (await bridge.writeClipboardText(text)) return { text: t('problem-report.rapport-copie-count-caracteres', { count: number(text.length) }), failed: false }
  } catch (error) {
    console.warn('[report] the clipboard refused the report:', error instanceof Error ? error.name : typeof error)
  }
  return { text: t('engine-status.le-presse-papiers-n-est-pas-accessible'), failed: true }
}

/** « Enregistrer… »: null when the user gave up the dialog (nothing to say), else the sentence. */
export async function saveReport(bridge: Pick<ProblemReportBridge, 'saveProblemReport'>): Promise<ReportNotice | null> {
  let saved: ProblemReportSave
  try {
    saved = await bridge.saveProblemReport()
  } catch (error) {
    console.warn('[report] the report could not be saved:', error instanceof Error ? error.name : typeof error)
    return { text: t('problem-report.le-rapport-n-a-pas-pu-etre-prepare'), failed: true }
  }
  if (saved.status === 'canceled') return null
  return saved.status === 'saved' ? { text: t('problem-report.rapport-enregistre-file', { file: saved.file }), failed: false } : { text: saved.message, failed: true }
}
