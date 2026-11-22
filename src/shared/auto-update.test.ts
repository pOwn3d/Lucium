// The rules of the notice of an update (auto-update.ts): when a version may be offered again, when it is given up, what the notice offers, its
// words in both languages, and the windows it may show in.
import { afterEach, describe, expect, it } from 'vitest'
import { frenchSpaces } from './french-typography'
import {
  NO_UPDATE_NOTICE,
  UPDATE_NOTICE_MAX_TIMES,
  UPDATE_NOTICE_PAUSE_MS,
  afterNoticeAccepted,
  afterNoticeShown,
  cleanUpdateNotices,
  droppedUpdateText,
  noticeGivenUp,
  noticeKind,
  noticePaused,
  noticeWindowAllowed,
  updateNoticeText,
  withoutDrop,
  type InstallerState,
  type NoticeWindowFacts
} from './auto-update'
import { setLanguage } from './i18n'
import type { UpdateOffer } from './update-check'

afterEach(() => setLanguage('fr'))

const HOUR = 60 * 60 * 1000
const offer: UpdateOffer = { version: '0.2.2', url: 'https://lucium.example/telecharger/', notes: '', archive: 'https://lucium.example/updates/Lucium-0.2.2-arm64.zip', size: 128172732 }
const installer = (state: Partial<Record<'canInstall' | 'isDownloading' | 'isReady', boolean>> & { ready?: string } = {}): InstallerState => ({
  canInstall: () => state.canInstall ?? true,
  isDownloading: () => state.isDownloading ?? false,
  isReady: () => state.isReady ?? false,
  readyVersion: () => state.ready ?? ''
})

describe('« Plus tard »: the same version is not offered again before a day, or the next launch', () => {
  it('pauses only the version shown, for UPDATE_NOTICE_PAUSE_MS (a day) in this run', () => {
    expect(UPDATE_NOTICE_PAUSE_MS).toBe(24 * HOUR)
    const shown = { version: '0.2.2', at: 1_000 }
    expect(noticePaused('0.2.2', shown, 1_000 + 23 * HOUR)).toBe(true)
    expect(noticePaused('0.2.2', shown, 1_000 + 24 * HOUR)).toBe(false)
    expect(noticePaused('0.2.3', shown, 1_000 + HOUR)).toBe(false)
  })

  it('pauses nothing at a new launch: a run starts with no notice shown', () => {
    expect(noticePaused('0.2.2', null, 0)).toBe(false)
  })
})

describe('a version passed over three times', () => {
  it('is given up after the third showing without « Installer », and only that version', () => {
    let memory = NO_UPDATE_NOTICE
    for (let shown = 1; shown <= UPDATE_NOTICE_MAX_TIMES; shown++) {
      expect(noticeGivenUp('0.2.2', memory), `before showing ${shown}`).toBe(false)
      memory = afterNoticeShown(memory, '0.2.2')
    }
    expect(memory).toEqual({ version: '0.2.2', shown: 3 })
    expect(noticeGivenUp('0.2.2', memory)).toBe(true)
    // A newer version starts its own count.
    expect(noticeGivenUp('0.2.3', memory)).toBe(false)
    expect(afterNoticeShown(memory, '0.2.3')).toEqual({ version: '0.2.3', shown: 1 })
  })

  it('does not count a showing that ended on « Installer »', () => {
    const twice = afterNoticeShown(afterNoticeShown(NO_UPDATE_NOTICE, '0.2.2'), '0.2.2')
    const accepted = afterNoticeAccepted(afterNoticeShown(twice, '0.2.2'), '0.2.2')
    expect(accepted).toEqual({ version: '0.2.2', shown: 2 })
    expect(noticeGivenUp('0.2.2', accepted)).toBe(false)
    // An acceptance of another version leaves the memory alone.
    expect(afterNoticeAccepted(twice, '0.2.3')).toBe(twice)
  })

  it('is read from the profile as it may be written there: anything else is no memory', () => {
    expect(cleanUpdateNotices({ version: '0.2.2', shown: 3 })).toEqual({ version: '0.2.2', shown: 3 })
    expect(cleanUpdateNotices({ version: '0.2.2', shown: -1 })).toEqual({ version: '0.2.2', shown: 0 })
    expect(cleanUpdateNotices({ version: '0.2.2', shown: 1e9 })).toEqual({ version: '0.2.2', shown: 99 })
    for (const raw of [null, undefined, 'x', [], { version: 'v0.2.2', shown: 1 }, { version: '', shown: 3 }, { shown: 3 }]) expect(cleanUpdateNotices(raw), JSON.stringify(raw)).toEqual(NO_UPDATE_NOTICE)
  })

  it('keeps a drop to tell (a downloaded update the feed withdrew at the quit) only as a plain version, until it was told', () => {
    expect(cleanUpdateNotices({ version: '0.2.2', shown: 1, dropped: '0.2.2' })).toEqual({ version: '0.2.2', shown: 1, dropped: '0.2.2' })
    expect(cleanUpdateNotices({ version: '', shown: 0, dropped: '0.2.3' })).toEqual({ ...NO_UPDATE_NOTICE, dropped: '0.2.3' })
    for (const dropped of ['v0.2.2', '', 3, null, '<b>0.2.2</b>']) expect(cleanUpdateNotices({ version: '0.2.2', shown: 1, dropped }), String(dropped)).toEqual({ version: '0.2.2', shown: 1 })
    expect(withoutDrop({ version: '0.2.2', shown: 1, dropped: '0.2.2' })).toEqual({ version: '0.2.2', shown: 1 })
    // Shown once, the memory of the next version carries no drop.
    expect(afterNoticeShown({ version: '0.2.2', shown: 1, dropped: '0.2.2' }, '0.2.3')).toEqual({ version: '0.2.3', shown: 1 })
  })
})

describe('what the notice offers', () => {
  it('« Installer » when this run can install the archive the feed names', () => {
    expect(noticeKind(offer, installer())).toBe('install')
  })

  it('« Installer et relancer » when an update is downloaded and waits', () => {
    expect(noticeKind(offer, installer({ isReady: true, ready: '0.2.2' }))).toBe('restart')
  })

  it('nothing while a download the user started runs: its own boxes follow', () => {
    expect(noticeKind(offer, installer({ isDownloading: true }))).toBeNull()
  })

  it('the download page when this run installs nothing, or the feed names no archive', () => {
    expect(noticeKind(offer, null)).toBe('page')
    expect(noticeKind(offer, installer({ canInstall: false }))).toBe('page')
    expect(noticeKind({ ...offer, archive: undefined }, installer())).toBe('page')
  })

  it('the download page for a version below the running one (the way back from a withdrawn version): Squirrel installs no older bundle', () => {
    expect(noticeKind(offer, installer(), false)).toBe('page')
    expect(noticeKind(offer, installer(), true)).toBe('install')
    // What is under way or ready is said first, as for any offer.
    expect(noticeKind(offer, installer({ isDownloading: true }), false)).toBeNull()
    expect(noticeKind(offer, installer({ isReady: true, ready: '0.2.3' }), false)).toBe('restart')
  })
})

describe('the words of the notice', () => {
  it('in French', () => {
    expect(updateNoticeText('install', '0.2.2', offer.size)).toEqual({ message: 'Lucium 0.2.2 est disponible (122,2 Mo).', action: 'Installer', later: 'Plus tard' })
    expect(updateNoticeText('install', '0.2.2')).toEqual({ message: 'Lucium 0.2.2 est disponible.', action: 'Installer', later: 'Plus tard' })
    expect(updateNoticeText('restart', '0.2.2')).toEqual({ message: 'Lucium 0.2.2 est prêt à être installé.', action: 'Installer et relancer', later: 'Plus tard' })
    expect(updateNoticeText('page', '0.2.2').action).toBe('Page de téléchargement')
  })

  it('for a withdrawn running version, in both languages: it says so and names the version to install', () => {
    expect(updateNoticeText('page', '0.2.2', undefined, true)).toEqual({ message: 'Cette version a été retirée. Installez Lucium 0.2.2.', action: 'Page de téléchargement', later: 'Plus tard' })
    expect(updateNoticeText('install', '0.2.2', offer.size, true)).toEqual({ message: 'Cette version a été retirée. Installez Lucium 0.2.2.', action: 'Installer', later: 'Plus tard' })
    // An update that waits is what replaces it: the usual words.
    expect(updateNoticeText('restart', '0.2.2', undefined, true).message).toBe('Lucium 0.2.2 est prêt à être installé.')
    setLanguage('en')
    expect(updateNoticeText('page', '0.2.2', undefined, true)).toEqual({ message: 'This version has been withdrawn. Install Lucium 0.2.2.', action: 'Download Page', later: 'Later' })
  })

  it('for a downloaded update the feed withdrew, in both languages: it says it is not installed, and names the version to install when there is one', () => {
    const dropped = { version: '0.2.2', failed: false }
    expect(updateNoticeText('install', '0.2.3', offer.size, false, dropped)).toEqual({ message: frenchSpaces('La version 0.2.2 a été retirée : elle n’est pas installée. Installez Lucium 0.2.3.'), action: 'Installer', later: 'Plus tard' })
    expect(updateNoticeText('page', '0.2.3', undefined, true, dropped).action).toBe('Page de téléchargement')
    expect(droppedUpdateText(dropped)).toBe(frenchSpaces('La version 0.2.2 a été retirée : elle n’est pas installée.'))
    expect(droppedUpdateText({ version: '0.2.2', failed: true })).toBe(frenchSpaces('La version 0.2.2 a été retirée, mais Lucium n’a pas pu l’écarter : elle peut encore s’installer à la fermeture.'))
    expect(droppedUpdateText({ version: '0.2.2', failed: true }, '0.2.3')).toBe(frenchSpaces('La version 0.2.2 a été retirée, mais Lucium n’a pas pu l’écarter. Installez Lucium 0.2.3 : elle la remplace.'))
    setLanguage('en')
    expect(updateNoticeText('install', '0.2.3', offer.size, false, dropped).message).toBe('Version 0.2.2 was withdrawn: it is not installed. Install Lucium 0.2.3.')
    expect(droppedUpdateText(dropped)).toBe('Version 0.2.2 was withdrawn: it is not installed.')
  })

  it('in English', () => {
    setLanguage('en')
    expect(updateNoticeText('install', '0.2.2', offer.size)).toEqual({ message: 'Lucium 0.2.2 is available (122.2 MB).', action: 'Install', later: 'Later' })
    expect(updateNoticeText('restart', '0.2.2')).toEqual({ message: 'Lucium 0.2.2 is ready to install.', action: 'Install and Relaunch', later: 'Later' })
    expect(updateNoticeText('page', '0.2.2').action).toBe('Download Page')
  })
})

describe('the window the notice may show in', () => {
  const facts = (over: Partial<NoticeWindowFacts> = {}, front: Partial<NonNullable<NoticeWindowFacts['front']>> = {}): NoticeWindowFacts => ({
    locked: false,
    sharing: false,
    front: { kind: 'main', alive: true, focused: true, ...front },
    ...over
  })

  it('is a normal window that has the focus', () => {
    expect(noticeWindowAllowed(facts())).toBe(true)
    expect(noticeWindowAllowed(facts({}, { kind: 'window' }))).toBe(true)
  })

  it('is never a private window, even the only one', () => {
    expect(noticeWindowAllowed(facts({}, { kind: 'private' }))).toBe(false)
  })

  it('is none while a window is shared, behind the lock, with Lucium in the background, or with no window left', () => {
    expect(noticeWindowAllowed(facts({ sharing: true }))).toBe(false)
    expect(noticeWindowAllowed(facts({ locked: true }))).toBe(false)
    expect(noticeWindowAllowed(facts({}, { focused: false }))).toBe(false)
    expect(noticeWindowAllowed(facts({}, { alive: false }))).toBe(false)
    expect(noticeWindowAllowed(facts({ front: null }))).toBe(false)
  })
})

describe('the words of an urgent notice', () => {
  afterEach(() => setLanguage('fr'))

  it('says that the version fixes a security flaw, with the button that acts, whatever the kind', () => {
    expect(updateNoticeText('install', '0.2.2', 5, false, undefined, true)).toEqual({ message: 'Lucium 0.2.2 corrige une faille de sécurité. Installez-la dès que possible.', action: 'Installer', later: 'Plus tard' })
    expect(updateNoticeText('page', '0.2.2', undefined, false, undefined, true).action).toBe('Page de téléchargement')
    expect(updateNoticeText('restart', '0.2.2', undefined, false, undefined, true)).toEqual({ message: 'Lucium 0.2.2 corrige une faille de sécurité et attend d’être installé.', action: 'Installer et relancer', later: 'Plus tard' })
    setLanguage('en')
    expect(updateNoticeText('install', '0.2.2', 5, false, undefined, true).message).toBe('Lucium 0.2.2 fixes a security flaw. Install it as soon as you can.')
  })

  it('is the ordinary notice when nothing says it is urgent', () => {
    expect(updateNoticeText('install', '0.2.2', undefined, false, undefined, false).message).toBe('Lucium 0.2.2 est disponible.')
  })
})
