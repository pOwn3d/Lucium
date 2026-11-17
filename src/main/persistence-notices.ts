// What the user must be told about the files the application keeps: one that could not be read (and was set aside, or could not even be),
// and a save that fails. The store and the history report here; the window shows a dialog (shell/announce-persistence.ts) as soon as one
// is open. Nothing imports Electron, so the texts can be tested.

import { t } from '@shared/i18n'
import { copyWhen } from '@shared/session-backups'
import { settingsPath } from '@shared/settings-path'

export type PersistenceNotice =
  /** The file was unreadable: it was moved to `backup`, and the application started from nothing. */
  | { kind: 'set-aside'; file: string; backup: string; reason: string }
  /** The file was written by a more recent version of the application: it was moved to `backup` untouched, and this version started from nothing. */
  | { kind: 'newer-version'; file: string; backup: string; reason: string }
  /**
   * The file was written by a more recent version of the application and this one read it: a copy was made at `copy` before anything is written.
   * `writer` is that version and `running` this one.
   */
  | { kind: 'older-version'; file: string; copy: string; writer: string; running: string }
  /** The same, but the copy could not be made: nothing is written over the file in this run. */
  | { kind: 'older-version-kept'; file: string; writer: string; running: string; reason: string }
  /** The user comes back from an older version: `copy` is the state the newer version had left, kept on the way down. */
  | { kind: 'copy-to-resume'; file: string; copy: string }
  /** The file was unreadable and could not be moved either: the application started from nothing and writes nothing over it for now. */
  | { kind: 'kept-in-place'; file: string; reason: string; moveError: string }
  /** The file cannot be written: the data stays in memory and the write is tried again. */
  | { kind: 'save-failed'; file: string; reason: string }
  /** A copy of the session cannot be written (see session-backups.ts): the copies stop being kept until it works again; nothing else is affected. */
  | { kind: 'backup-failed'; reason: string }
  /**
   * The lock was on and its file is gone or cannot be read: the lock was switched off (lock-service.ts), which leaves the spaces open to whoever
   * sits at the machine. `reason` is the sentence that says so. A box the user closes, not a toast that passes while nobody looks.
   */
  | { kind: 'lock-off'; reason: string }

type Listener = (notice: PersistenceNotice) => void

/** Notices nobody was listening for yet (the load happens before the first window): shown when one listens. A bound, not a feature. */
const PENDING_MAX = 20
const pending: PersistenceNotice[] = []
const listeners = new Set<Listener>()

export function reportPersistenceNotice(notice: PersistenceNotice): void {
  if (listeners.size === 0) {
    pending.push(notice)
    if (pending.length > PENDING_MAX) pending.shift()
    return
  }
  for (const listener of listeners) listener(notice)
}

/** Calls `listener` for the notices waiting and for every one reported from now on. Answers the function that stops it. */
export function onPersistenceNotice(listener: Listener): () => void {
  listeners.add(listener)
  for (const notice of pending.splice(0)) listener(notice)
  return () => listeners.delete(listener)
}

/** The notices still waiting for a listener, emptied (for tests and for a window that wants them all at once). */
export const takePersistenceNotices = (): PersistenceNotice[] => pending.splice(0)

const isHistory = (file: string): boolean => file.startsWith('history')
// `history.json` is the history of the default profile and `history-<id>.json` that of another profile: only that one is concerned.
// Both are names put in a sentence of their own (`{thing}`, `{fresh}`), never a piece of one.
const thingOf = (file: string): string =>
  file === 'history.json' ? t('persistence-notices.votre-historique') : isHistory(file) ? t('persistence-notices.l-historique-d-un-de-vos-profils') : t('persistence-notices.vos-espaces-onglets-et-reglages')
const freshOf = (file: string): string => (isHistory(file) ? t('persistence-notices.un-historique-vide') : t('persistence-notices.des-donnees-neuves'))

/**
 * The dialog that says it. `newestCopy` is when the newest automatic copy of the session was made (see session-backups.ts), if there is one: when the state
 * itself could not be read, the user is told where to get their spaces and tabs back from instead of being left with the file set aside.
 */
export function noticeDialog(notice: PersistenceNotice, newestCopy: number | null = null, now = Date.now()): { message: string; detail: string } {
  if (notice.kind === 'backup-failed') {
    return {
      message: t('persistence-notices.copies-automatiques-impossibles'),
      detail:
        t('persistence-notices.lucium-n-arrive-pas-a-ecrire-une-copie-de', { reason: notice.reason }) +
        t('persistence-notices.vos-donnees-et-vos-reglages-ne-sont-pas-touches')
    }
  }
  if (notice.kind === 'lock-off') {
    return { message: t('persistence-notices.le-verrouillage-est-desactive'), detail: `${notice.reason}\n\n${t('persistence-notices.vos-espaces-ne-sont-plus-proteges', { settingsPath: settingsPath('lock') })}` }
  }
  const thing = thingOf(notice.file)
  switch (notice.kind) {
    case 'set-aside':
      return {
        message: t('persistence-notices.impossible-de-lire-thing', { thing }),
        detail:
          t('persistence-notices.le-fichier-file-est-illisible-reason-il-n-a-pas', { file: notice.file, reason: notice.reason, backup: notice.backup }) +
          t('persistence-notices.lucium-a-demarre-avec-fresh', { fresh: freshOf(notice.file) }) +
          '\n\n' +
          (isHistory(notice.file) ? t('persistence-notices.le-fichier-mis-de-cote-peut-etre-repare-a-la-main') : t('persistence-notices.le-fichier-mis-de-cote-peut-etre-repare-aide')) +
          t('persistence-notices.lucium-ne-garde-que-les-trois-mises-de-cote') +
          (newestCopy !== null && !isHistory(notice.file) ? '\n\n' + t('persistence-notices.des-copies-automatiques-de-vos-espaces-et-onglets', { when: copyWhen(newestCopy, now) }) : '')
      }
    case 'newer-version':
      return {
        message: t('persistence-notices.donnees-d-une-version-plus-recente-d-lucium'),
        detail:
          t('persistence-notices.le-fichier-file-thing-a-ete-ecrit-par-une', { file: notice.file, thing, reason: notice.reason, backup: notice.backup }) +
          t('persistence-notices.cette-version-demarre-avec-fresh', { fresh: freshOf(notice.file) }) +
          '\n\n' +
          t('persistence-notices.pour-retrouver-ces-donnees-relancez-la-version') +
          t('persistence-notices.lucium-ne-garde-que-les-trois-mises-de-cote-2')
      }
    case 'older-version':
      return {
        message: t('persistence-notices.lucium-running-est-plus-ancien-que-la-version', { running: notice.running }),
        detail:
          t('persistence-notices.vos-donnees-ont-ete-enregistrees-par-lucium-writer', { writer: notice.writer, running: notice.running, copy: notice.copy }) +
          '\n\n' +
          t('persistence-notices.cette-version-peut-ne-pas-connaitre', { writer: notice.writer }) +
          t('persistence-notices.lucium-ne-garde-que-les-trois-copies-de-cette-sorte')
      }
    case 'older-version-kept':
      return {
        message: t('persistence-notices.lucium-running-est-plus-ancien-que-la-version', { running: notice.running }),
        detail:
          t('persistence-notices.vos-donnees-ont-ete-enregistrees-par-lucium-writer-sans-copie', { writer: notice.writer, running: notice.running, reason: notice.reason }) +
          '\n\n' +
          t('persistence-notices.pour-ne-rien-perdre-cette-version-n-ecrit-rien', { file: notice.file, writer: notice.writer })
      }
    case 'copy-to-resume':
      return {
        message: t('persistence-notices.une-copie-de-vos-donnees-peut-etre-reprise'),
        detail: t('persistence-notices.avant-votre-retour-a-une-version-plus-ancienne', { copy: notice.copy }) + '\n\n' + t('persistence-notices.pour-reprendre-cette-copie')
      }
    case 'kept-in-place':
      return {
        message: t('persistence-notices.impossible-de-lire-thing', { thing }),
        detail:
          t('persistence-notices.le-fichier-file-est-illisible-reason-et', { file: notice.file, reason: notice.reason, moveError: notice.moveError }) +
          t('persistence-notices.lucium-demarre-avec-fresh-mais-n-ecrit-rien', { fresh: freshOf(notice.file) })
      }
    case 'save-failed':
      return {
        message: t('browser.enregistrement-impossible'),
        detail: t('persistence-notices.lucium-n-arrive-pas-a-ecrire-file-reason-vos', { file: notice.file, reason: notice.reason })
      }
  }
}
