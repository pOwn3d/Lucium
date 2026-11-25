// @vitest-environment happy-dom
// The panel of the resources mounted in a document: what ☾ and ✕ of a row say, and when. « Onglet mis en veille » is said in a live region, so a
// screen reader hears it: it must be true (the main process answered that it was done), and not said for a tab that was refused or a request lost.

import { createElement } from 'react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { LuciumApi } from '@shared/ipc'
import { RELEASE_MEASURE_MS, RELEASE_UNDO_MS, memoryGauge, resourceActionDone, type ReleaseOutcome, type ResourceAction, type ResourceActionReply, type ResourceReport } from '@shared/resources'
import { ResourcePanel } from './ResourcePanel'
import { frenchSpaces } from '@shared/french-typography'
import { click, mount, settle, type Mounted } from './dom.test-support'

const REPORT: ResourceReport = {
  memoryMb: 2000,
  cpu: 10,
  gauge: memoryGauge(2048, 16 * 1024, 1),
  tabs: [
    { tabId: 't1', name: 'Twitch', url: 'https://twitch.example/', memoryMb: 584, cpu: 7.4 },
    { tabId: 't2', name: 'Perso', url: 'https://perso.example/', memoryMb: 278, cpu: 0.2, pinned: true }
  ],
  others: { count: 4, memoryMb: 1100, cpu: 2.4, gpuMemoryMb: 900, gpuCpu: 1.8 },
  byCpu: {
    tabs: [
      { tabId: 't2', name: 'Perso', url: 'https://perso.example/', memoryMb: 278, cpu: 45, pinned: true },
      { tabId: 't1', name: 'Twitch', url: 'https://twitch.example/', memoryMb: 584, cpu: 7.4 }
    ],
    others: { count: 4, memoryMb: 1100, cpu: 2.4, gpuMemoryMb: 900, gpuCpu: 1.8 }
  },
  more: { tabs: [], others: { count: 4, memoryMb: 1100, cpu: 2.4, gpuMemoryMb: 900, gpuCpu: 1.8 } },
  byCpuMore: { tabs: [], others: { count: 4, memoryMb: 1100, cpu: 2.4, gpuMemoryMb: 900, gpuCpu: 1.8 } },
  levels: [
    { level: 'low', count: 0, memoryMb: 0, cpu: 0, siteTabs: 0 },
    { level: 'medium', count: 3, memoryMb: 900, cpu: 2, siteTabs: 0 },
    { level: 'high', count: 5, memoryMb: 2000, cpu: 4, siteTabs: 2 }
  ]
}

let mounted: Mounted | null = null
let answer: (reply: ResourceActionReply) => void = () => undefined
let fail: (error: Error) => void = () => undefined
let asked: ResourceAction[] = []
/** Draws the panel again with new figures, as the main process does every 2 s. */
let push: (report: ResourceReport) => void = () => undefined

/** The panel with two rows; each action waits for `answer` or `fail`. */
function panel(): HTMLElement {
  asked = []
  ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = {
    onResources: (listener) => {
      push = (report) => act(() => listener(report))
      listener(REPORT)
      return () => undefined
    },
    resourcePanel: () => undefined,
    resourceAction: (action) => {
      asked.push(action)
      return new Promise<ResourceActionReply>((resolve, reject) => {
        answer = resolve
        fail = reject
      })
    }
  }
  mounted = mount(createElement(ResourcePanel, { closing: false, onClose: () => undefined }))
  return mounted.container
}

const said = (container: Element): string => container.querySelector('.rp-notice')?.textContent ?? ''
const named = (container: Element, label: string): Element => {
  const found = container.querySelector(`[aria-label="${label}"]`)
  if (!found) throw new Error(`nothing is named "${label}"`)
  return found
}

beforeEach(() => setLanguage('fr'))
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('what the main process answers to ☾ and ✕', () => {
  it('is a success only when it says the tab was put to sleep or closed', () => {
    expect(resourceActionDone({ done: true })).toBe(true)
    expect(resourceActionDone({ done: false })).toBe(false)
    expect(resourceActionDone(null)).toBe(false)
    expect(resourceActionDone({ woken: 3 })).toBe(false)
    expect(resourceActionDone({ released: { level: 'low', slept: 3, refused: { unsent: 0, confirm: 0, other: 0 } } })).toBe(false)
  })
})

describe('the ranking of the rows', () => {
  const rows = (container: Element): string[] => [...container.querySelectorAll('.rp-row .rp-name')].map((el) => el.textContent ?? '')

  it('changes with « Processeur » and « Mémoire », keeps the state of the buttons and is kept for the next panel', async () => {
    const container = panel()
    expect(rows(container)).toEqual(['Twitch', 'Perso'])
    await click(container.querySelector('[data-sort="cpu"]')!)
    expect(rows(container)).toEqual(['Perso', 'Twitch'])
    expect(container.querySelector('[data-sort="cpu"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('[data-sort="memory"]')?.getAttribute('aria-pressed')).toBe('false')
    // The panel is closed and opened again: it starts from the ranking chosen last.
    mounted?.unmount()
    expect(rows(panel())).toEqual(['Perso', 'Twitch'])
    await click(mounted!.container.querySelector('[data-sort="memory"]')!)
    expect(rows(mounted!.container)).toEqual(['Twitch', 'Perso'])
  })
})

describe('☾ of a row', () => {
  it('says nothing before the answer, then « Onglet mis en veille » once the main process did it', async () => {
    const container = panel()
    await click(named(container, t('resources.mettre-en-veille-name', { name: 'Twitch' })))
    expect(asked).toEqual([{ kind: 'sleep', tabId: 't1' }])
    expect(said(container)).toBe('')
    await settle(() => answer({ done: true }))
    expect(said(container)).toBe(t('taskmanager.onglet-mis-en-veille'))
  })

  it('says that the tab could not be put to sleep when the main process refused it', async () => {
    const container = panel()
    await click(named(container, t('resources.mettre-en-veille-name', { name: 'Twitch' })))
    await settle(() => answer({ done: false }))
    expect(said(container)).toBe(t('resources.veille-impossible'))
  })

  it('says the same when the request is lost, and the error is in the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const container = panel()
    await click(named(container, t('resources.mettre-en-veille-name', { name: 'Twitch' })))
    await settle(() => fail(new Error('the window is gone')))
    expect(said(container)).toBe(t('resources.veille-impossible'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the action sleep of the panel failed'), 'the window is gone')
  })
})

describe('✕ of a row', () => {
  it('says what was done once it was: a pinned tab stays pinned', async () => {
    const container = panel()
    await click(named(container, t('resources.fermer-name', { name: 'Perso' })))
    expect(asked).toEqual([{ kind: 'close', tabId: 't2' }])
    expect(said(container)).toBe('')
    await settle(() => answer({ done: true }))
    expect(said(container)).toBe(t('taskmanager.onglet-epingle-ferme'))
  })

  it('says that the tab could not be closed when nothing was done', async () => {
    const container = panel()
    await click(named(container, t('resources.fermer-name', { name: 'Twitch' })))
    await settle(() => answer(null))
    expect(said(container)).toBe(t('resources.fermeture-impossible'))
  })
})

describe('« Libérer maintenant »', () => {
  const outcome = (patch: Partial<ReleaseOutcome> = {}): ReleaseOutcome => ({ level: 'medium', slept: 3, refused: { unsent: 0, confirm: 0, other: 0 }, ...patch })
  const level = (container: Element, name: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll<HTMLButtonElement>('.rp-level')].find((one) => one.querySelector('b')?.textContent === name)
    if (!found) throw new Error(`no strength "${name}"`)
    return found
  }
  const undoButton = (container: Element): Element | null => container.querySelector('.rp-undo')
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('asks for the strength that was pressed, says how many it takes while it runs, then how it ended', async () => {
    const container = panel()
    await click(level(container, 'Moyen'))
    expect(asked).toEqual([{ kind: 'sleep-level', level: 'medium' }])
    expect(said(container)).toBe(t('resources.liberer-en-cours.other', { count: 3 }))
    expect(container.querySelector('.rp-release')?.getAttribute('aria-busy')).toBe('true')
    await settle(() => answer({ released: outcome() }))
    expect(said(container)).toBe('3 onglets mis en veille')
    expect(container.querySelector('.rp-release')?.getAttribute('aria-busy')).toBe('false')
    expect(undoButton(container)).not.toBeNull()
  })

  it('takes one run at a time: the buttons wait, and a second press asks for nothing', async () => {
    const container = panel()
    await click(level(container, 'Moyen'))
    for (const one of container.querySelectorAll('.rp-level')) expect(one.getAttribute('aria-disabled')).toBe('true')
    await click(level(container, 'Fort'))
    await click(level(container, 'Moyen'))
    expect(asked).toHaveLength(1)
    await settle(() => answer({ released: outcome() }))
    await click(level(container, 'Fort'))
    expect(asked).toHaveLength(2)
    // The sentence and the « Annuler » of the first run give way to the new run: they would undo the wrong one.
    expect(said(container)).toBe(t('resources.liberer-en-cours.other', { count: 5 }))
    expect(undoButton(container)).toBeNull()
  })

  it('says how many went and why the others stayed awake, never which', async () => {
    const container = panel()
    await click(level(container, 'Fort'))
    await settle(() => answer({ released: outcome({ level: 'high', slept: 11, refused: { unsent: 2, confirm: 1, other: 0 } }) }))
    expect(said(container)).toBe(t('resources.liberer-partiel', { slept: 11, total: 14, reasons: `${t('resources.refus-texte.other', { count: 2 })}, ${t('resources.refus-confirmation.one', { count: 1 })}` }))
  })

  it('says it could not be done when the main process refused or the request was lost, and offers nothing to undo', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (const failure of [() => answer(null), () => fail(new Error('the window is gone'))]) {
      const container = panel()
      await click(level(container, 'Moyen'))
      await settle(failure)
      expect(said(container)).toBe(t('resources.liberer-impossible'))
      expect(undoButton(container)).toBeNull()
      mounted?.unmount()
      mounted = null
    }
  })

  it('says nothing was done when nothing could sleep, and offers nothing to undo', async () => {
    const container = panel()
    await click(level(container, 'Moyen'))
    await settle(() => answer({ released: outcome({ slept: 0 }) }))
    expect(said(container)).toBe(t('resources.rien-a-endormir'))
    expect(undoButton(container)).toBeNull()
  })

  it(`measures what was really freed ${RELEASE_MEASURE_MS / 1000} s later, from the total before and after`, async () => {
    const container = panel()
    await click(level(container, 'Moyen'))
    await settle(() => answer({ released: outcome() }))
    push({ ...REPORT, memoryMb: 1100 })
    await act(async () => void vi.advanceTimersByTime(RELEASE_MEASURE_MS))
    expect(said(container)).toBe(frenchSpaces('3 onglets mis en veille, ≈ 900 Mo libérés (mesuré).'))
  })

  it('leaves the gain out when the total did not go down by a measurable amount', async () => {
    const container = panel()
    await click(level(container, 'Moyen'))
    await settle(() => answer({ released: outcome() }))
    push({ ...REPORT, memoryMb: 1990 })
    await act(async () => void vi.advanceTimersByTime(RELEASE_MEASURE_MS))
    expect(said(container)).toBe('3 onglets mis en veille')
  })

  it(`takes « Annuler » away after ${RELEASE_UNDO_MS / 1000} s`, async () => {
    const container = panel()
    await click(level(container, 'Moyen'))
    await settle(() => answer({ released: outcome() }))
    await act(async () => void vi.advanceTimersByTime(RELEASE_UNDO_MS - 1))
    expect(undoButton(container)).not.toBeNull()
    await act(async () => void vi.advanceTimersByTime(1))
    expect(undoButton(container)).toBeNull()
  })

  it('« Annuler » asks the main process to load the tabs again and says how many', async () => {
    const container = panel()
    await click(level(container, 'Moyen'))
    await settle(() => answer({ released: outcome() }))
    await click(undoButton(container)!)
    expect(asked.at(-1)).toEqual({ kind: 'undo-level' })
    await settle(() => answer({ woken: 3 }))
    expect(said(container)).toBe(t('resources.annulation.other', { count: 3 }))
    expect(undoButton(container)).toBeNull()
  })

  it('says when « Annuler » could not be done, and when every tab was opened meanwhile', async () => {
    const container = panel()
    await click(level(container, 'Moyen'))
    await settle(() => answer({ released: outcome() }))
    await click(undoButton(container)!)
    await settle(() => answer(null))
    expect(said(container)).toBe(t('resources.annulation-impossible'))
    await click(level(container, 'Moyen'))
    await settle(() => answer({ released: outcome() }))
    await click(undoButton(container)!)
    await settle(() => answer({ woken: 0 }))
    expect(said(container)).toBe(t('resources.annulation-rien'))
  })

  it('drops « Annuler » when a row is put to sleep or closed after the run: the sentence it went with is gone', async () => {
    const container = panel()
    await click(level(container, 'Moyen'))
    await settle(() => answer({ released: outcome() }))
    await click(named(container, t('resources.fermer-name', { name: 'Twitch' })))
    expect(undoButton(container)).toBeNull()
  })
})
