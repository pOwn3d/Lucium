import { describe, expect, it } from 'vitest'
import {
  MEDIA_PLAYER,
  MEDIA_TEXT,
  addPlayer,
  isPlaying,
  mediaLabels,
  mergeProbes,
  opensPlayer,
  parseMediaRequest,
  parseSessionActions,
  parseVolume,
  prunePlayers,
  tabVolume,
  thumbLeft,
  volumeAt,
  type PlayerFacts
} from './media-player'

const live = { awake: true, media: true }

describe('the labels of the buttons', () => {
  const all = { playing: true, previous: true, next: true, video: true }

  it('name what each button does: the previous button goes back and the next one goes forward', () => {
    const labels = mediaLabels(all)
    expect(labels.previous).toBe('Piste précédente')
    expect(labels.next).toBe('Piste suivante')
    expect(labels.previous).not.toBe(labels.next)
    expect(labels).toMatchObject({ back: 'Retour à l’onglet', volume: 'Régler le volume de l’onglet', pip: 'Ouvrir l’image dans l’image', close: 'Fermer le mini-lecteur' })
  })

  it('says Pause while it plays and Lecture once it is paused', () => {
    expect(mediaLabels(all).toggle).toBe('Pause')
    expect(mediaLabels({ ...all, playing: false }).toggle).toBe('Lecture')
  })

  it('tells the truth about a button that cannot act: no previous track, no next track, no video to float', () => {
    const labels = mediaLabels({ playing: true, previous: false, next: false, video: false })
    expect(labels.previous).toBe(MEDIA_TEXT.noPrevious)
    expect(labels.next).toBe(MEDIA_TEXT.noNext)
    expect(labels.pip).toBe(MEDIA_TEXT.noVideo)
    expect(mediaLabels({ ...all, previous: false }).next).toBe('Piste suivante')
  })
})

describe('what a tab plays and at which level', () => {
  it('takes what the page said, and a tab that makes sound for playing until it says', () => {
    expect(isPlaying({ audible: true, playing: false })).toBe(false)
    expect(isPlaying({ audible: false, playing: true })).toBe(true)
    expect(isPlaying({ audible: true })).toBe(true)
    expect(isPlaying({ audible: false })).toBe(false)
    expect(isPlaying(undefined)).toBe(false)
  })

  it('starts at the page\'s own level', () => {
    expect(tabVolume(undefined)).toBe(1)
    expect(tabVolume({})).toBe(1)
    expect(tabVolume({ volume: 0.3 })).toBe(0.3)
    expect(tabVolume({ volume: 0 })).toBe(0)
  })
})

describe('which tabs get a player', () => {
  it('opens one for a tab that makes sound the user hears', () => {
    expect(opensPlayer({ audible: true, muted: false })).toBe(true)
  })

  it('opens none for a tab that is silent, muted when it was left, or unknown', () => {
    expect(opensPlayer({ audible: false, muted: false })).toBe(false)
    expect(opensPlayer({ audible: true, muted: true })).toBe(false)
    expect(opensPlayer(undefined)).toBe(false)
  })

  it('stacks the newest last, once per tab, up to the ceiling', () => {
    expect(addPlayer([], 'a')).toEqual(['a'])
    expect(addPlayer(['a', 'b'], 'a')).toEqual(['b', 'a'])
    const full = addPlayer(addPlayer(addPlayer(addPlayer([], 'a'), 'b'), 'c'), 'd')
    expect(full).toEqual(['b', 'c', 'd'])
    expect(full).toHaveLength(MEDIA_PLAYER.maxPlayers)
  })
})

describe('which players stay', () => {
  type Info = ReturnType<PlayerFacts['info']>
  /** Everything is fine unless the test says otherwise: tabs that are gone or on screen, and the facts of the others (undefined: unknown). */
  const facts = (over: { gone?: string[]; visible?: string[]; info?: Record<string, Info> } = {}): PlayerFacts => ({
    exists: (id) => !over.gone?.includes(id),
    visible: (id) => over.visible?.includes(id) === true,
    info: (id) => (over.info && id in over.info ? over.info[id] : live)
  })

  it('keeps the players of tabs that exist, are off screen, are awake and still have media, as the same array', () => {
    const players = ['a', 'b'] as const
    expect(prunePlayers(players, facts())).toBe(players)
  })

  it('drops a tab that was closed', () => {
    expect(prunePlayers(['a', 'b'], facts({ gone: ['a'] }))).toEqual(['b'])
  })

  it('drops a tab that is on screen again: its own controls are there', () => {
    expect(prunePlayers(['a', 'b'], facts({ visible: ['b'] }))).toEqual(['a'])
  })

  it('drops a tab put to sleep, and one whose page has no media left', () => {
    expect(prunePlayers(['a', 'b'], facts({ info: { a: { awake: false, media: true } } }))).toEqual(['b'])
    expect(prunePlayers(['a', 'b'], facts({ info: { b: { awake: true, media: false } } }))).toEqual(['a'])
  })

  it('keeps a tab whose media was not asked about yet, and drops one nobody knows', () => {
    expect(prunePlayers(['a'], facts({ info: { a: { awake: true } } }))).toEqual(['a'])
    expect(prunePlayers(['a'], facts({ info: { a: undefined } }))).toEqual([])
  })
})

describe('the volume slider', () => {
  it('accepts a level from 0 to 1 in hundredths and refuses everything else', () => {
    expect(parseVolume(0)).toBe(0)
    expect(parseVolume(1)).toBe(1)
    expect(parseVolume(0.866)).toBe(0.87)
    for (const bad of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, '0.5', null, undefined, {}]) expect(parseVolume(bad)).toBeNull()
  })

  it('follows the pointer with the centre of the thumb, which travels the track minus its own width', () => {
    const track = 291
    expect(volumeAt(10, track)).toBe(0)
    expect(volumeAt(track - 10, track)).toBe(1)
    expect(volumeAt(10 + (track - 20) / 2, track)).toBe(0.5)
    expect(volumeAt(-50, track)).toBe(0)
    expect(volumeAt(500, track)).toBe(1)
    expect(volumeAt(Number.NaN, track)).toBe(1)
    expect(volumeAt(5, 10)).toBe(1)
  })

  it('puts the thumb back where the pointer was: a volume of 0.866 sits at x = 234 of a 291 px track', () => {
    expect(thumbLeft(0, 291)).toBe(0)
    expect(thumbLeft(1, 291)).toBe(271)
    expect(thumbLeft(0.866, 291)).toBeCloseTo(234.7, 1)
    expect(thumbLeft(2, 291)).toBe(271)
    expect(thumbLeft(-1, 291)).toBe(0)
    for (const v of [0, 0.25, 0.5, 0.87, 1]) expect(volumeAt(thumbLeft(v, 291) + 10, 291)).toBe(v)
  })

  it('fits three rows: 33 px each, 99 px with the slider open', () => {
    expect(MEDIA_PLAYER.row * 3).toBe(99)
    expect(MEDIA_PLAYER.foldFromSliderMs).toBeGreaterThan(MEDIA_PLAYER.unfoldMs)
  })
})

describe('parseMediaRequest', () => {
  it('accepts each command of the buttons on a tab id', () => {
    for (const command of ['toggle', 'previous', 'next', 'pip', 'close', 'back']) expect(parseMediaRequest({ tabId: 't1', command })).toEqual({ tabId: 't1', command })
  })

  it('accepts a volume only with a level from 0 to 1, rounded to hundredths', () => {
    expect(parseMediaRequest({ tabId: 't1', command: 'volume', volume: 0.333 })).toEqual({ tabId: 't1', command: 'volume', volume: 0.33 })
    expect(parseMediaRequest({ tabId: 't1', command: 'volume', volume: 3 })).toBeNull()
    expect(parseMediaRequest({ tabId: 't1', command: 'volume' })).toBeNull()
    expect(parseMediaRequest({ tabId: 't1', command: 'volume', volume: '0.5' })).toBeNull()
  })

  it('refuses what a page or a bug could send: no tab, an unknown command, junk', () => {
    expect(parseMediaRequest(null)).toBeNull()
    expect(parseMediaRequest('toggle')).toBeNull()
    expect(parseMediaRequest({ command: 'toggle' })).toBeNull()
    expect(parseMediaRequest({ tabId: '', command: 'toggle' })).toBeNull()
    expect(parseMediaRequest({ tabId: 'x'.repeat(201), command: 'toggle' })).toBeNull()
    expect(parseMediaRequest({ tabId: 7, command: 'toggle' })).toBeNull()
    expect(parseMediaRequest({ tabId: 't1', command: 'seek' })).toBeNull()
    expect(parseMediaRequest({ tabId: 't1', command: 'constructor' })).toBeNull()
  })
})

describe('what the pages report', () => {
  it('reads which track actions a site registered from the names its page sent', () => {
    expect(parseSessionActions(['play', 'nexttrack'])).toEqual({ previous: false, next: true })
    expect(parseSessionActions(['previoustrack', 'nexttrack'])).toEqual({ previous: true, next: true })
    expect(parseSessionActions([])).toEqual({ previous: false, next: false })
  })

  it('refuses a report that is not a short list of names', () => {
    expect(parseSessionActions('nexttrack')).toBeNull()
    expect(parseSessionActions([1])).toBeNull()
    expect(parseSessionActions(new Array(41).fill('play'))).toBeNull()
    expect(parseSessionActions(['x'.repeat(41)])).toBeNull()
    expect(parseSessionActions(null)).toBeNull()
  })

  it('merges the frames of a page: one frame that plays, has media or has a video is enough, and a frame that said nothing is ignored', () => {
    expect(mergeProbes([])).toEqual({ playing: false, media: false, video: false })
    expect(mergeProbes([null, { playing: true, media: true, video: false }, { playing: false, media: true, video: true }, undefined])).toEqual({ playing: true, media: true, video: true })
    expect(mergeProbes([{ playing: false, media: false, video: false }])).toEqual({ playing: false, media: false, video: false })
    expect(mergeProbes([{ playing: 'yes' as unknown as boolean }])).toEqual({ playing: false, media: false, video: false })
  })
})
