// "Exporter les données" and "Restaurer les données…" as files: what is written (plain JSON as before, or the sealed form of export-crypto.ts)
// and how a file chosen for restoring is opened. No Electron here: the passphrase is asked through a function handed in, so that every rule
// can be tested against real files and a real cipher.

import { statSync, readFileSync } from 'node:fs'
import type { SidebarState } from '@shared/model'
import { exportableState } from '@shared/lock'
import { cleanStoredNotes, type Note } from '@shared/notes'
import { EXPORT_FILE_MAX, ExportCryptoError, checkEnvelope, decryptExport, encryptExport, exportErrorMessage, isEncryptedExport, type EncryptOptions } from './export-crypto'
import { notesForExport } from './notes-store'
import { t } from '@shared/i18n'

/**
 * The text of the file for the state: sealed with the passphrase when there is one, plain JSON as before otherwise. The quick notes (notes.json, not part
 * of the state) go with it under `notes` while their function is on and there are some; a restore puts them back (`exportedNotes`, `finishRestore`).
 */
export async function exportText(state: SidebarState, passphrase: string | null, options?: EncryptOptions, notes: readonly Note[] | null = notesForExport(state.settings.notes)): Promise<{ text: string; encrypted: boolean }> {
  const exported = exportableState(state)
  const json = `${JSON.stringify(notes && notes.length > 0 ? { ...exported, notes } : exported, null, 2)}\n`
  if (passphrase === null) return { text: json, encrypted: false }
  return { text: await encryptExport(json, passphrase, options), encrypted: true }
}

/** What the interface may send with an export request: nothing, or `{ passphrase }` (a text; an empty one means "no encryption"). */
export function parseExportRequest(raw: unknown): { ok: true; passphrase: string | null } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, passphrase: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: t('export-file.demande-d-exportation-invalide') }
  const passphrase = (raw as { passphrase?: unknown }).passphrase
  if (passphrase === undefined) return { ok: true, passphrase: null }
  if (typeof passphrase !== 'string') return { ok: false, message: t('export-file.demande-d-exportation-invalide') }
  return { ok: true, passphrase }
}

/**
 * The quick notes a file chosen for restoring carries (`notes`, as `exportText` writes it), cleaned like notes.json: notes that are not valid are left out.
 * Null when it carries none (an export made while the function was off or without a note, a backup of state.json): the notes on this Mac are then left
 * as they are, never emptied by a file that says nothing about them.
 */
export function exportedNotes(value: unknown): Note[] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = (value as { notes?: unknown }).notes
  if (!Array.isArray(raw)) return null
  const { notes } = cleanStoredNotes(raw)
  return notes.length > 0 ? notes : null
}

/** What the end of a confirmed restore needs (Help › Restaurer les données…, shell/menu-actions.ts). */
export interface RestoreSteps {
  /** Why nothing may be restored now (a space is locked: lock.ts `restoreRefusal`), or null. Asked last, when the user has already confirmed: the lock may have come since the menu was opened. */
  refusal: () => string | null
  /** The copy of state.json beside it (persist.ts `backUpBeforeRestore`): null when made, or the reason it could not be. */
  backUpState: () => string | null
  /** The file of the notes (notes-store.ts), or null when it is not configured. */
  notes: { restore(notes: readonly Note[]): string | null } | null
  /** Replaces the state (`state/restore`). */
  applyState: () => void
}

/**
 * The end of a restore the user confirmed: the copies first (state.json, then notes.json when the file carries notes), then the notes, then the state.
 * Nothing is restored when a copy or the notes fail: the data about to be replaced would exist nowhere else, and the user is told why. The notes are
 * written before the state so that a failure leaves both as they were (the write of notes.json is atomic).
 */
export function finishRestore(steps: RestoreSteps, notes: readonly Note[] | null): { ok: true } | { ok: false; message: string } {
  const refusal = steps.refusal()
  if (refusal !== null) {
    console.warn('[restore] refused while a space is locked; nothing restored')
    return { ok: false, message: `${refusal}\n\n${t('export-file.rien-n-a-ete-restaure')}` }
  }
  const failure = steps.backUpState()
  if (failure !== null) {
    console.error(`[restore] no backup of the current state (${failure}); nothing restored`)
    return { ok: false, message: `${t('export-file.copie-avant-restauration-impossible', { detail: failure })}\n\n${t('export-file.rien-n-a-ete-restaure')}` }
  }
  if (notes !== null) {
    const notesFailure = steps.notes ? steps.notes.restore(notes) : t('notes.les-notes-ne-sont-pas-disponibles')
    if (notesFailure !== null) {
      console.error('[restore] the notes of the file were not restored; nothing restored')
      return { ok: false, message: `${t('export-file.notes-non-restaurees', { detail: notesFailure })}\n\n${t('export-file.rien-n-a-ete-restaure')}` }
    }
  }
  steps.applyState()
  return { ok: true }
}

export type OpenedExport = { ok: true; value: unknown; encrypted: boolean } | { ok: false; message: string; cancelled?: boolean }

/** How many wrong passphrases are tried before the file is given up on (each one costs a key derivation). */
export const PASSPHRASE_TRIES = 5

/**
 * Reads a file chosen for restoring. The size is checked before the file is read; a plain file is parsed as it always was; a sealed one is
 * bounded first (a file that asks for an absurd cost is refused before the user is asked for anything) and then opened with the passphrase
 * `ask` returns (`previous` is the sentence about the last wrong one). Answering null to `ask` is giving up: nothing is read.
 */
export async function openExportFile(path: string, ask: (previous: string | null) => Promise<string | null>): Promise<OpenedExport> {
  let text: string
  try {
    if (statSync(path).size > EXPORT_FILE_MAX) return { ok: false, message: exportErrorMessage(new ExportCryptoError('too-large', 'file too large')) }
    text = readFileSync(path, 'utf8')
  } catch (error) {
    console.error(`[restore] cannot read ${path}:`, error)
    return { ok: false, message: `${path}\n\n${String((error as Error).message ?? error)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    console.error(`[restore] ${path} is not JSON:`, error)
    return { ok: false, message: `${path}\n\n${String((error as Error).message ?? error)}` }
  }
  if (!isEncryptedExport(parsed)) return { ok: true, value: parsed, encrypted: false }

  try {
    checkEnvelope(parsed)
  } catch (error) {
    console.error(`[restore] ${path} is not an export this version can open (${error instanceof ExportCryptoError ? error.kind : 'unreadable'})`)
    return { ok: false, message: exportErrorMessage(error) }
  }
  let previous: string | null = null
  for (let attempt = 0; attempt < PASSPHRASE_TRIES; attempt++) {
    const passphrase = await ask(previous)
    if (passphrase === null) return { ok: false, message: t('export-file.restauration-annulee'), cancelled: true }
    try {
      const json = await decryptExport(parsed, passphrase)
      return { ok: true, value: JSON.parse(json), encrypted: true }
    } catch (error) {
      // Only the kind of failure is logged, never anything that could hold the passphrase.
      const kind = error instanceof ExportCryptoError ? error.kind : 'unreadable'
      console.error(`[restore] the encrypted export ${path} was not opened (${kind})`)
      if (!(error instanceof ExportCryptoError) || error.kind !== 'wrong-passphrase') return { ok: false, message: exportErrorMessage(error) }
      previous = exportErrorMessage(error)
    }
  }
  return { ok: false, message: `${previous ?? ''} ${t('export-file.apres-tries-essais-la-restauration-est-abandonnee', { tries: PASSPHRASE_TRIES })}`.trim() }
}
