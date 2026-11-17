// What the import tells the person when a file cannot be read. The reasons come from Node, from SQLite, from `JSON.parse` and from
// `plutil`, in English and with paths in them; the sheet shows a sentence about the file instead (an unreadable file is a refusal
// with a cause the person can act on, never a stack message).

import { t } from '@shared/i18n'
import { NBSP } from '@shared/french-typography'

/** A refusal whose sentence is already written for the person (too big, not an ordinary file, not the expected tables…): shown as it is. */
export class ImportReadError extends Error {}

/** Technical text cut down for the fallback sentence: no path, one line, short. */
const brief = (message: string): string =>
  message
    .split('\n')[0]!
    // A quoted path may hold spaces ("Application Support"): the quotes go with it.
    .replace(/'[^']*\/[^']*'|"[^"]*\/[^"]*"|[^\s'"]*\/[^\s'"]*/g, '…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)

/**
 * The sentence for a file that could not be read: the file's name, then what is wrong with it ("Bookmarks est tronqué ou abîmé…"). A
 * permission refusal and a missing file are not handled here: the import tells those apart earlier (the first asks for full disk
 * access, the second says "introuvable").
 */
export function readFailureMessage(error: unknown, name: string): string {
  // Our own refusals are phrases that follow a colon ("le fichier est trop volumineux…"); the others are written to follow the name.
  return error instanceof ImportReadError ? `${name}${NBSP}: ${error.message}` : `${name} ${reasonOf(error)}`
}

function reasonOf(error: unknown): string {
  const raw = error as { code?: unknown; errcode?: unknown; message?: unknown } | null
  const message = typeof raw?.message === 'string' ? raw.message : String(error)
  const code = typeof raw?.code === 'string' ? raw.code : ''

  // SQLite (node:sqlite): the numbers are the primary result codes.
  if (code === 'ERR_SQLITE_ERROR' && typeof raw?.errcode === 'number') {
    switch (raw.errcode & 0xff) {
      case 5: // BUSY
      case 6: // LOCKED
        return t('import.fichier-en-cours-d-utilisation')
      case 10: // IOERR
        return t('import.erreur-de-lecture-du-disque')
      case 11: // CORRUPT
      case 26: // NOTADB
        return t('import.base-de-donnees-illisible')
      case 13: // FULL
        return t('import.plus-de-place-sur-le-disque')
    }
  }
  switch (code) {
    case 'ENOSPC':
      return t('import.plus-de-place-sur-le-disque')
    case 'EMFILE':
    case 'ENFILE':
      return t('import.trop-de-fichiers-ouverts')
    case 'EBUSY':
    case 'ETXTBSY':
    case 'EAGAIN':
      return t('import.fichier-en-cours-d-utilisation')
    case 'EIO':
    case 'ETIMEDOUT':
    case 'ENXIO':
    case 'ENODEV':
      return t('import.erreur-de-lecture-du-disque')
  }
  // JSON.parse: an unfinished or damaged text. The browsers rewrite their files in place, so a read can catch one half written.
  if (error instanceof SyntaxError) return t('import.fichier-tronque-ou-abime')
  if (error instanceof RangeError) return t('import.fichier-trop-imbrique-ou-trop-gros')
  if (/^Invalid property list|^plutil /.test(message)) return t('import.liste-de-proprietes-illisible')
  return t('import.lecture-impossible-detail', { detail: brief(message) })
}

/**
 * Why a file could not be written (the export of the bookmarks), as the end of "Enregistrement impossible dans x.html : …": what the
 * person can do about it, not the system's English with the whole path in it.
 */
export function writeFailureReason(error: unknown): string {
  const raw = error as { code?: unknown; message?: unknown } | null
  switch (typeof raw?.code === 'string' ? raw.code : '') {
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return t('import.ecriture-refusee')
    case 'ENOENT':
    case 'ENOTDIR':
      return t('import.dossier-introuvable')
    case 'ENOSPC':
    case 'EDQUOT':
      return t('import.disque-plein-pour-ecrire')
    case 'EISDIR':
      return t('import.nom-d-un-dossier')
    case 'ENAMETOOLONG':
      return t('import.nom-de-fichier-trop-long')
  }
  return t('import.ecriture-impossible-detail', { detail: brief(typeof raw?.message === 'string' ? raw.message : String(error)) })
}
