import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from './i18n'
import { quitClearStep, quitDialogHost, quitLosesData, quitQuestion, quitStep, SYSTEM_QUIT_DEADLINE_MS, type QuitFacts } from './quit-decision'
import { frenchSpaces } from './french-typography'

afterEach(() => setLanguage('fr'))

const facts = (patch: Partial<Omit<QuitFacts, 'downloading'>> & { downloading?: number } = {}): QuitFacts => ({
  confirmed: false,
  system: false,
  warnBeforeQuitting: true,
  ...patch,
  downloading: () => patch.downloading ?? 0
})

describe('quitStep', () => {
  it('asks on ⌘Q while "Avertir avant de quitter" is on (the default)', () => {
    expect(quitStep(facts())).toBe('ask')
  })

  it('goes ahead when the setting is off and nothing downloads', () => {
    expect(quitStep(facts({ warnBeforeQuitting: false }))).toBe('go')
  })

  it('still asks about downloads in progress when the setting is off', () => {
    expect(quitStep(facts({ warnBeforeQuitting: false, downloading: 2 }))).toBe('ask')
  })

  it('goes ahead once the question was answered or the last window closed', () => {
    expect(quitStep(facts({ confirmed: true }))).toBe('go')
    expect(quitStep(facts({ confirmed: true, downloading: 3 }))).toBe('go')
  })

  it('never asks when the system is the one quitting: not with the setting on, nor with downloads in progress', () => {
    expect(quitStep(facts({ system: true }))).toBe('go')
    expect(quitStep(facts({ system: true, downloading: 4 }))).toBe('go')
    expect(quitStep(facts({ system: true, warnBeforeQuitting: false, downloading: 1 }))).toBe('go')
  })

  it('counts the downloads only when the answer depends on them', () => {
    const counted = (patch: Partial<QuitFacts>): number => {
      const downloading = vi.fn(() => 1)
      quitStep({ confirmed: false, system: false, warnBeforeQuitting: false, ...patch, downloading })
      return downloading.mock.calls.length
    }
    expect(counted({ system: true })).toBe(0)
    expect(counted({ confirmed: true })).toBe(0)
    expect(counted({ warnBeforeQuitting: true })).toBe(0)
    expect(counted({})).toBe(1)
  })
})

describe('quitClearStep', () => {
  it('holds the quit for the erasure of the sites when the user quits', () => {
    expect(quitClearStep({ system: false })).toBe('wait')
  })

  it('leaves the erasure to the next launch when the system quits (the marker is written, nobody waits)', () => {
    expect(quitClearStep({ system: true })).toBe('defer')
  })
})

describe('SYSTEM_QUIT_DEADLINE_MS', () => {
  it('is short enough for a shutdown (macOS gives an application a few seconds) and longer than the erasure at quit is held', () => {
    expect(SYSTEM_QUIT_DEADLINE_MS).toBeGreaterThanOrEqual(5_000)
    expect(SYSTEM_QUIT_DEADLINE_MS).toBeLessThanOrEqual(20_000)
  })
})

describe('quitQuestion', () => {
  it('keeps "Quitter" as the default button of the plain question: nothing is lost by quitting', () => {
    const question = quitQuestion({ downloading: 0, privateTabs: 0 })
    expect(quitLosesData({ downloading: 0, privateTabs: 0 })).toBe(false)
    expect(question.type).toBe('question')
    expect(question.message).toBe(frenchSpaces('Quitter Lucium ?'))
    expect(question.buttons[question.defaultId]).toBe('Quitter')
    expect(question.offersNeverAsk).toBe(true)
  })

  it('makes "Annuler" the default button when downloads in progress would be cancelled, and says so', () => {
    const question = quitQuestion({ downloading: 2, privateTabs: 0 })
    expect(question.type).toBe('warning')
    expect(question.buttons[question.defaultId]).toBe('Annuler')
    expect(question.cancelId).toBe(question.defaultId)
    expect(question.message).toBe('Téléchargements en cours')
    expect(question.detail).toContain('les annulera')
    // That question stays whatever the setting says: it cannot be switched off from its own box.
    expect(question.offersNeverAsk).toBe(false)
  })

  it('makes "Annuler" the default button when private tabs would be lost, and counts them', () => {
    const one = quitQuestion({ downloading: 0, privateTabs: 1 })
    expect(one.type).toBe('warning')
    expect(one.buttons[one.defaultId]).toBe('Annuler')
    expect(one.detail).toContain('1 onglet ouvert dans une fenêtre privée sera perdu')
    expect(one.detail).toContain('Réglages › Onglets et fenêtres')
    expect(quitQuestion({ downloading: 0, privateTabs: 4 }).detail).toContain('4 onglets ouverts dans des fenêtres privées seront perdus')
    expect(one.offersNeverAsk).toBe(true)
  })

  it('says both when both would be lost', () => {
    const question = quitQuestion({ downloading: 1, privateTabs: 3 })
    expect(question.detail).toContain('les annulera')
    expect(question.detail).toContain('3 onglets')
    expect(question.buttons[question.defaultId]).toBe('Annuler')
  })

  it('is in English when the interface is', () => {
    setLanguage('en')
    const question = quitQuestion({ downloading: 0, privateTabs: 2 })
    expect(question.buttons).toEqual(['Quit', 'Cancel'])
    expect(question.detail).toContain('2 tabs open in private windows will be lost')
  })
})

describe('quitDialogHost', () => {
  const win = (id: string, visible = true, destroyed = false) => ({ id, visible, destroyed })

  it('hangs the question from the window the user works in', () => {
    expect(quitDialogHost([win('main'), win('w2'), win('w3')], 'w2')).toBe('w2')
  })

  it('takes another window that can be seen when the one in use cannot (hidden, minimized or closed)', () => {
    expect(quitDialogHost([win('main'), win('w2', false), win('w3')], 'w2')).toBe('main')
    expect(quitDialogHost([win('main', false), win('w2'), win('w3')], 'main')).toBe('w2')
    expect(quitDialogHost([win('main', true, true), win('w2')], 'main')).toBe('w2')
  })

  it('gives a box of its own when no window can be seen, so that the question is never lost behind one', () => {
    expect(quitDialogHost([win('main', false), win('w2', false, true)], 'main')).toBeNull()
    expect(quitDialogHost([], null)).toBeNull()
  })

  it('takes the first window that can be seen when the one in use is unknown', () => {
    expect(quitDialogHost([win('main', false), win('w2'), win('w3')], null)).toBe('w2')
    expect(quitDialogHost([win('main'), win('w2')], 'gone')).toBe('main')
  })
})
