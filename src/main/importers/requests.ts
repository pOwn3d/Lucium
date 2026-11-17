// What the messages of the import sheet do in the main process, kept apart from Electron so that it can be tested: nothing is imported,
// previewed, confirmed or undone for a private window (it keeps no space, pin or history to put it in), a request that is not exactly
// what the sheet sends is refused with a sentence, and the pages of the history go to the profile the import was started in.

import { noReport, parseImportRequest, parseImportToken, type ImportReport, type ImportSourceInfo } from '@shared/import-sources'
import { withHistoryProfile } from './history-target'
import type { ImportService } from './service'
import { t } from '@shared/i18n'

export interface ImportEnv {
  service: ImportService | null
  /** The window that sent the message is a private one. */
  isPrivate: boolean
  /** The profile of the space the window shows: where the pages of the history go. */
  historyProfile: string
}

/** A function, not a constant: the sentence is read when it is shown, in the language the interface has then. */
export const privateImportMessage = (): string => t('import.private-window')

export const listImportSources = (env: ImportEnv): ImportSourceInfo[] => (env.isPrivate ? [] : (env.service?.listSources() ?? []))

/** `mode` "run" imports at once (the engine checks and older callers); "preview" reads and writes nothing. */
export async function importRequest(env: ImportEnv, mode: 'run' | 'preview', raw: unknown): Promise<ImportReport> {
  if (env.isPrivate) return noReport(privateImportMessage())
  const request = parseImportRequest(raw)
  if (!request || !env.service) return noReport(t('requests.demande-d-import-invalide'))
  const service = env.service
  return withHistoryProfile(env.historyProfile, () => (mode === 'run' ? service.run(request) : service.preview(request)))
}

/** Carries out the preview that has this key. */
export function confirmImport(env: ImportEnv, raw: unknown): ImportReport {
  if (env.isPrivate) return noReport(privateImportMessage())
  const token = parseImportToken(raw)
  if (!token || !env.service) return noReport(t('requests.demande-d-import-invalide'))
  const service = env.service
  return withHistoryProfile(env.historyProfile, () => service.commit(token))
}

/** Takes back the latest import, the one that has this key. */
export function undoImport(env: ImportEnv, raw: unknown): ImportReport {
  if (env.isPrivate) return noReport(privateImportMessage())
  const token = parseImportToken(raw)
  if (!token || !env.service) return noReport(t('requests.demande-d-annulation-invalide'))
  const service = env.service
  return withHistoryProfile(env.historyProfile, () => service.undo(token))
}
