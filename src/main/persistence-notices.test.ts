import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import { noticeDialog, onPersistenceNotice, reportPersistenceNotice, takePersistenceNotices, type PersistenceNotice } from './persistence-notices'
import { frenchSpaces } from '@shared/french-typography'

// The dialog of the window (shell/announce-persistence.ts) is Electron's: a stand-in that records what it is asked to show.
const showMessageBox = vi.hoisted(() => vi.fn(async () => ({ response: 0, checkboxChecked: false })))
vi.mock('electron', () => ({ dialog: { showMessageBox } }))
const { announcePersistenceNotices, newestCopyAt } = await import('./shell/announce-persistence')

const saveFailed = (file: string): PersistenceNotice => ({ kind: 'save-failed', file, reason: 'ENOSPC' })
beforeEach(() => void takePersistenceNotices())

describe('the queue of notices', () => {
  it('holds what is reported while nobody listens and hands it to the first listener, once', () => {
    reportPersistenceNotice(saveFailed('a'))
    reportPersistenceNotice(saveFailed('b'))
    const heard = vi.fn()
    const stop = onPersistenceNotice(heard)
    expect(heard.mock.calls.map(([n]) => n.file)).toEqual(['a', 'b'])
    const later = vi.fn()
    const stopLater = onPersistenceNotice(later)
    expect(later).not.toHaveBeenCalled()
    reportPersistenceNotice(saveFailed('c'))
    expect(heard).toHaveBeenCalledTimes(3)
    expect(later).toHaveBeenCalledTimes(1)
    stop()
    stopLater()
  })

  it('stops calling a listener that was stopped, and holds again', () => {
    const heard = vi.fn()
    onPersistenceNotice(heard)()
    reportPersistenceNotice(saveFailed('a'))
    expect(heard).not.toHaveBeenCalled()
    expect(takePersistenceNotices()).toHaveLength(1)
  })

  it('does not grow without bound when nobody ever listens', () => {
    for (let i = 0; i < 100; i++) reportPersistenceNotice(saveFailed(`f${i}`))
    const kept = takePersistenceNotices()
    expect(kept.length).toBeLessThanOrEqual(20)
    expect(kept.at(-1)).toMatchObject({ file: 'f99' })
  })
})

describe('noticeDialog', () => {
  it('says which file, why, and where an unreadable one went', () => {
    const { message, detail } = noticeDialog({ kind: 'set-aside', file: 'state.json', backup: '/data/state.json.corrupt-1', reason: 'SyntaxError: Unexpected token' })
    expect(message).toContain('vos espaces, onglets et réglages')
    expect(detail).toContain(frenchSpaces('« state.json »'))
    expect(detail).toContain('SyntaxError: Unexpected token')
    expect(detail).toContain('/data/state.json.corrupt-1')
    expect(detail).toContain('trois mises de côté')
    expect(detail).toContain('Restaurer les données')
  })

  it('says a file of a more recent version is intact, where it is, and how to get it back (not “unreadable”)', () => {
    const { message, detail } = noticeDialog({ kind: 'newer-version', file: 'state.json', backup: '/data/state.json.future-1', reason: 'Error: state version 2 is newer than the 1 this application reads' })
    expect(message).toBe('Données d’une version plus récente de Lucium')
    expect(detail).toContain('/data/state.json.future-1')
    expect(detail).toContain('Il n’est ni abîmé ni supprimé')
    // The way back is the menu command of the newer version, not a file to rename by hand in a hidden folder.
    expect(detail).toContain('relancez la version plus récente de Lucium, puis choisissez Aide › Restaurer les données… et ce fichier')
    expect(detail).not.toContain('remettez ce fichier à sa place')
    expect(detail).not.toContain('illisible')
  })

  it('says, to an older version started over newer data, which version wrote them, where the copy is and how to get everything back', () => {
    const { message, detail } = noticeDialog({ kind: 'older-version', file: 'state.json', copy: '/data/state.json.version-change-2026-11-10T08-30-05-from-0.3.1', writer: '0.3.1', running: '0.3.0' })
    expect(message).toBe('Lucium 0.3.0 est plus ancien que la version qui a enregistré vos données')
    expect(detail).toContain('enregistrés par Lucium 0.3.1, une version plus récente que celle-ci (0.3.0)')
    expect(detail).toContain(frenchSpaces('« /data/state.json.version-change-2026-11-10T08-30-05-from-0.3.1 »'))
    expect(detail).toContain('revenez à Lucium 0.3.1 ou à une version plus récente, puis choisissez Aide › Restaurer les données… et cette copie')
    expect(detail).toContain('trois copies les plus récentes')
    expect(detail).not.toContain('illisible')
  })

  it('says, when that copy could not be made, why, and that nothing is saved in this session', () => {
    const { message, detail } = noticeDialog({ kind: 'older-version-kept', file: 'state.json', writer: '0.3.1', running: '0.3.0', reason: 'ENOSPC: no space left on device' })
    expect(message).toBe('Lucium 0.3.0 est plus ancien que la version qui a enregistré vos données')
    expect(detail).toContain('Lucium n’a pas pu en faire une copie (ENOSPC: no space left on device)')
    expect(detail).toContain(frenchSpaces('cette version n’écrit rien dans « state.json » : ce que vous changez pendant cette session ne sera pas enregistré'))
    expect(detail).toContain('revenez à Lucium 0.3.1')
  })

  it('offers, back on the newer version, the copy kept before the older one wrote the data, and says what restoring it replaces', () => {
    const { message, detail } = noticeDialog({ kind: 'copy-to-resume', file: 'state.json', copy: '/data/state.json.version-change-2026-11-10T08-30-05-from-0.3.1' })
    expect(message).toBe('Une copie de vos données peut être reprise')
    expect(detail).toContain(frenchSpaces('« /data/state.json.version-change-2026-11-10T08-30-05-from-0.3.1 »'))
    expect(detail).toContain('choisissez Aide › Restaurer les données… et ce fichier')
    expect(detail).toContain(frenchSpaces('Ce que vous avez changé depuis sera remplacé ; Lucium en garde une copie avant de restaurer'))
  })

  it('speaks of the history for the history file, which Restore Data does not restore', () => {
    const { message, detail } = noticeDialog({ kind: 'set-aside', file: 'history.json', backup: '/data/history.json.corrupt-1', reason: 'x' })
    expect(message).toContain('votre historique')
    expect(detail).toContain('un historique vide')
    expect(detail).not.toContain('Restaurer les données')
  })

  it('names the file and what Lucium started with in the language of the interface', () => {
    setLanguage('en')
    try {
      const { message, detail } = noticeDialog({ kind: 'set-aside', file: 'history-work.json', backup: '/data/history-work.json.corrupt-1', reason: 'x' })
      expect(message).toBe('Couldn’t read the history of one of your profiles')
      expect(detail).toContain('Lucium started with an empty history.\n\nThe set-aside file can be repaired by hand. ')
      expect(noticeDialog({ kind: 'kept-in-place', file: 'state.json', reason: 'x', moveError: 'EACCES' }).detail).toContain('Lucium starts with fresh data, but writes nothing to this file')
    } finally {
      setLanguage('fr')
    }
  })

  it('says that only one profile’s history is concerned when the file is the history of a profile other than the default one', () => {
    const { message, detail } = noticeDialog({ kind: 'set-aside', file: 'history-travail.json', backup: '/data/history-travail.json.corrupt-1', reason: 'x' })
    expect(message).toBe('Impossible de lire l’historique d’un de vos profils')
    expect(detail).toContain('history-travail.json')
    expect(detail).toContain('un historique vide')
    expect(detail).not.toContain('Restaurer les données')
  })

  it('tells where the spaces and tabs can come back from when the state is unreadable and an automatic copy exists', () => {
    const now = new Date(2026, 9, 26, 19, 40).getTime()
    const copyAt = new Date(2026, 9, 26, 19, 30).getTime()
    const { detail } = noticeDialog({ kind: 'set-aside', file: 'state.json', backup: '/data/state.json.corrupt-1', reason: 'x' }, copyAt, now)
    expect(detail).toContain('Des copies automatiques de vos espaces et onglets existent')
    expect(detail).toContain('Aujourd’hui à 19:30')
    expect(detail).toContain('Fichier › Sessions…')
    expect(detail).toContain('Copies automatiques')
  })

  it('says nothing of copies when there is none, nor for the history (a copy holds spaces and tabs only)', () => {
    const notice = { kind: 'set-aside', file: 'state.json', backup: '/data/state.json.corrupt-1', reason: 'x' } as const
    expect(noticeDialog(notice).detail).not.toContain('copies automatiques')
    expect(noticeDialog(notice, null).detail).not.toContain('copies automatiques')
    expect(noticeDialog({ ...notice, file: 'history.json' }, Date.now()).detail).not.toContain('copies automatiques')
    expect(noticeDialog({ ...notice, file: 'history-travail.json' }, Date.now()).detail).not.toContain('copies automatiques')
  })

  it('is given the date of the newest copy by the window that shows it, read when the notice comes', () => {
    showMessageBox.mockClear()
    const win = { isDestroyed: () => false, isVisible: () => true }
    let newest: number | null = null
    const stop = announcePersistenceNotices(win as never, () => newest)
    const unreadable = { kind: 'set-aside', file: 'state.json', backup: '/data/state.json.corrupt-1', reason: 'x' } as const
    reportPersistenceNotice(unreadable)
    newest = new Date(2026, 9, 26, 19, 30).getTime()
    reportPersistenceNotice(unreadable)
    stop()
    const details = showMessageBox.mock.calls.map((call) => (call as unknown as [unknown, { type: string; detail: string }])[1])
    expect(details.map((shown) => shown.type)).toEqual(['warning', 'warning'])
    expect(details[0]!.detail).not.toContain('copies automatiques')
    expect(details[1]!.detail).toContain('Des copies automatiques de vos espaces et onglets existent')
    expect(showMessageBox.mock.calls.every((call) => (call as unknown[])[0] === win)).toBe(true)
  })

  it('stands alone when the window is hidden (the main window put away on macOS): a sheet there would never be seen', () => {
    showMessageBox.mockClear()
    const stop = announcePersistenceNotices({ isDestroyed: () => false, isVisible: () => false } as never, () => null)
    reportPersistenceNotice(saveFailed('state.json'))
    stop()
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect((showMessageBox.mock.calls[0] as unknown as [{ type: string }])[0].type).toBe('warning')
  })

  it('is shown on no window that is gone', () => {
    showMessageBox.mockClear()
    const stop = announcePersistenceNotices({ isDestroyed: () => true } as never, () => null)
    reportPersistenceNotice(saveFailed('state.json'))
    stop()
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('takes the newest copy from the listing, which is newest first, and none from an empty one', () => {
    const entry = (createdAt: number) => ({ id: `c${createdAt}`, createdAt, reason: 'interval', tabs: 1, spaces: 1 }) as never
    expect(newestCopyAt({ entries: [entry(30), entry(20), entry(10)] })).toBe(30)
    expect(newestCopyAt({ entries: [] })).toBeNull()
  })

  it('says that nothing is written when the file could not be put aside', () => {
    const { detail } = noticeDialog({ kind: 'kept-in-place', file: 'state.json', reason: 'x', moveError: 'EACCES' })
    expect(detail).toContain('EACCES')
    expect(detail).toContain('n’écrit rien')
    expect(detail).toContain('ne seront pas enregistrés')
  })

  it('says that only the copies stop when a copy of the session cannot be written, and that nothing else is touched', () => {
    const { message, detail } = noticeDialog({ kind: 'backup-failed', reason: 'ENOSPC: no space left on device' })
    expect(message).toBe('Copies automatiques impossibles')
    expect(detail).toContain('ENOSPC')
    expect(detail).toContain('ne sont pas touchés')
    expect(detail).toContain('aucune copie ne sera gardée')
  })

  it('says that the changes stay in memory when a save fails', () => {
    const { message, detail } = noticeDialog(saveFailed('state.json'))
    expect(message).toBe('Enregistrement impossible')
    expect(detail).toContain('ENOSPC')
    expect(detail).toContain('restent en mémoire')
  })
})

describe('a lock that went off because its file is gone or unreadable', () => {
  afterEach(() => setLanguage('fr'))

  it('is said in a box, with what it leaves open and where to put the lock back', () => {
    const reason = t('lock-service.le-fichier-de-la-phrase-du-verrou-est-introuvable')
    const { message, detail } = noticeDialog({ kind: 'lock-off', reason })
    expect(message).toBe('Le verrouillage est désactivé')
    expect(detail).toBe(frenchSpaces('Le fichier de la phrase du verrou est introuvable ou illisible : le verrouillage a été désactivé.\n\nVos espaces et vos onglets ne sont plus protégés par une phrase. Pour remettre le verrou, choisissez une nouvelle phrase dans Réglages › Vie privée et sécurité › Verrouillage.'))
    setLanguage('en')
    const english = noticeDialog({ kind: 'lock-off', reason: t('lock-service.le-fichier-de-la-phrase-du-verrou-est-introuvable') })
    expect(english.message).toBe('The lock is turned off')
    expect(english.detail).toBe('The lock passphrase file is missing or unreadable: the lock has been turned off.\n\nYour spaces and tabs are no longer protected by a passphrase. To turn the lock back on, choose a new passphrase in Settings › Privacy and security › Locking.')
  })

  it('waits for the first window like the notices of the files, and is what the lock is wired to', () => {
    takePersistenceNotices()
    reportPersistenceNotice({ kind: 'lock-off', reason: 'x' })
    expect(takePersistenceNotices()).toEqual([{ kind: 'lock-off', reason: 'x' }])
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    expect(source).toContain("notify: (message) => reportPersistenceNotice({ kind: 'lock-off', reason: message })")
  })
})

