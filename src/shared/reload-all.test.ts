import { describe, expect, it } from 'vitest'
import { RELOAD_ALL_AWAKE_MAX, RELOAD_ALL_DONE_MARK_MS, RELOAD_ALL_ESTIMATE_AFTER_MS, RELOAD_ALL_ESTIMATE_AFTER_TABS, RELOAD_ALL_TOTAL_LIMIT_MS, reloadButtonBusy, reloadButtonBusyLabel, reloadDetailWithDead, reloadMarks, reloadPhaseDetail, reloadRemainingMs, reloadWakeLimit, deadTabsNotice, deadTabsOfferLabel, reloadAllNotice, reloadAllTargets, reloadBusyNotice, reloadEndNotice, reloadProgressNotice, runLimited, scopedReloadNotice, sleepingTargets, tabsInScope, wakeOfferLabel } from './reload-all'
import { setLanguage } from './i18n'
import { frenchSpaces } from './french-typography'

const tab = (id: string, url = `https://exemple.fr/${id}`) => ({ id, url })

describe('reloadAllTargets', () => {
  it('takes the tabs of every space that have a page in memory, in the order of the list', () => {
    const tabs = [tab('a'), tab('b'), tab('c')]
    expect(reloadAllTargets(tabs, new Set(['c', 'a', 'b']), new Set())).toEqual(['a', 'b', 'c'])
  })

  it('leaves a tab without a page alone: it would only be woken up by the reload', () => {
    expect(reloadAllTargets([tab('a'), tab('asleep')], new Set(['a']), new Set())).toEqual(['a'])
  })

  it('leaves a frozen page as it is', () => {
    expect(reloadAllTargets([tab('a'), tab('frozen')], new Set(['a', 'frozen']), new Set(['frozen']))).toEqual(['a'])
  })

  it('leaves out what a reload cannot fetch: blank pages, internal addresses, extension pages', () => {
    const tabs = [tab('web'), tab('blank', 'about:blank'), tab('ext', 'chrome-extension://abc/page.html'), tab('file', 'file:///tmp/a.html'), tab('junk', 'pas une adresse')]
    expect(reloadAllTargets(tabs, new Set(tabs.map((t) => t.id)), new Set())).toEqual(['web', 'file'])
  })

  it('has nothing to do for an empty list', () => {
    expect(reloadAllTargets([], new Set(), new Set())).toEqual([])
  })
})

describe('reloadAllNotice', () => {
  it('counts the tabs that came back', () => {
    expect(reloadAllNotice(1, 0)).toBe('1 onglet actualisé')
    expect(reloadAllNotice(12, 0)).toBe('12 onglets actualisés')
  })

  it('says so when there was nothing to reload', () => {
    expect(reloadAllNotice(0, 0)).toBe('Aucun onglet à actualiser')
  })

  it('tells the tabs left alone because the user is typing in them', () => {
    expect(reloadAllNotice(5, 1)).toBe('5 onglets actualisés, 1 laissé tel quel (saisie en cours)')
    expect(reloadAllNotice(3, 2)).toBe('3 onglets actualisés, 2 laissés tels quels (saisie en cours)')
    expect(reloadAllNotice(0, 2)).toBe('2 laissés tels quels (saisie en cours)')
  })
})

describe('sleepingTargets', () => {
  it('takes the tabs without a page in any window and the frozen ones, in the order of the list', () => {
    const tabs = [tab('a'), tab('gone'), tab('frozen'), tab('never')]
    expect(sleepingTargets(tabs, new Set(['a', 'frozen']), new Set(['frozen']))).toEqual(['gone', 'frozen', 'never'])
  })

  it('leaves a tab alone that has a page, in this window or another one', () => {
    expect(sleepingTargets([tab('here'), tab('elsewhere')], new Set(['here', 'elsewhere']), new Set())).toEqual([])
  })

  it('leaves out what a reload cannot fetch, as the awake tabs do', () => {
    const tabs = [tab('web'), tab('blank', 'about:blank'), tab('ext', 'chrome-extension://abc/page.html'), tab('junk', 'pas une adresse')]
    expect(sleepingTargets(tabs, new Set(), new Set())).toEqual(['web'])
  })

  it('shares nothing with the awake targets', () => {
    const tabs = [tab('a'), tab('b'), tab('c')]
    const live = new Set(['a', 'c'])
    const frozen = new Set(['c'])
    const awake = reloadAllTargets(tabs, live, frozen)
    const asleep = sleepingTargets(tabs, live, frozen)
    expect(awake).toEqual(['a'])
    expect(asleep).toEqual(['b', 'c'])
    expect(awake.filter((id) => asleep.includes(id))).toEqual([])
  })
})

describe('the notice with woken tabs', () => {
  it('counts the woken tabs among the tabs that came back, and says how many were asleep', () => {
    expect(reloadAllNotice(4, 0, 3)).toBe('7 onglets actualisés, dont 3 réveillés')
    expect(reloadAllNotice(2, 0, 1)).toBe('3 onglets actualisés, dont 1 réveillé')
  })

  it('does not say "dont" when every tab was asleep, and still counts them', () => {
    expect(reloadAllNotice(0, 0, 5)).toBe('5 onglets actualisés')
    expect(reloadAllNotice(0, 0, 1)).toBe('1 onglet actualisé')
  })

  it('keeps the tabs left alone in the sentence', () => {
    expect(reloadAllNotice(3, 1, 2)).toBe('5 onglets actualisés, dont 2 réveillés, 1 laissé tel quel (saisie en cours)')
  })

  it('is the old sentence when nothing was woken', () => {
    expect(reloadAllNotice(12, 0, 0)).toBe('12 onglets actualisés')
    expect(reloadAllNotice(0, 0)).toBe('Aucun onglet à actualiser')
  })
})

describe('wakeOfferLabel', () => {
  it('counts the sleeping tabs', () => {
    expect(wakeOfferLabel(1)).toBe('Actualiser aussi l’onglet en veille')
    expect(wakeOfferLabel(8)).toBe('Actualiser aussi les 8 onglets en veille')
  })
})

describe('the offer of the tabs whose site does not answer', () => {
  it('says how many, in the singular and the plural', () => {
    expect(deadTabsNotice(1)).toBe('1 site ne répond plus')
    expect(deadTabsNotice(3)).toBe('3 sites ne répondent plus')
    expect(deadTabsOfferLabel(1)).toBe('Voir l’onglet…')
    expect(deadTabsOfferLabel(3)).toBe('Voir les 3 onglets…')
  })
})

describe('reloading one space only', () => {
  const tabs = [{ id: 'a', spaceId: 's1' }, { id: 'b', spaceId: 's2' }, { id: 'c', spaceId: 's1' }]

  it('covers the tabs of that space, and all of them when no space is named', () => {
    expect(tabsInScope(tabs, 's1').map((t) => t.id)).toEqual(['a', 'c'])
    expect(tabsInScope(tabs, 's2').map((t) => t.id)).toEqual(['b'])
    expect(tabsInScope(tabs).map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(tabsInScope(tabs, 'gone')).toEqual([])
  })

  it('does not hand back the list it was given', () => {
    expect(tabsInScope(tabs)).not.toBe(tabs)
  })

  // Asked from the sidebar and run by the shell: renderer/reload-space.test.ts.
  it('names the space in the notice, so that it is not taken for the reload of every space', () => {
    expect(scopedReloadNotice('Travail', '3 onglets actualisés')).toBe(frenchSpaces('Espace « Travail » : 3 onglets actualisés'))
  })

})

describe('runLimited (the sleeping tabs "Actualiser tous les onglets" wakes)', () => {
  /** Runs that end when the test says so, and how many were going on at the busiest moment. */
  function bench() {
    const ends = new Map<string, () => void>()
    const order: string[] = []
    let running = 0
    let peak = 0
    const start = (id: string): Promise<void> => {
      order.push(id)
      running++
      peak = Math.max(peak, running)
      return new Promise<void>((resolve) => ends.set(id, resolve)).finally(() => running--)
    }
    const end = async (id: string): Promise<void> => {
      ends.get(id)!()
      ends.delete(id)
      await settle()
    }
    return { ends, order, start, end, peak: () => peak }
  }
  /** The runner sees an end a few turns of the queue later. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  it('never has more runs going on than the limit, and starts the next one as soon as one ends, in order', async () => {
    const runs = bench()
    const ids = Array.from({ length: 10 }, (_, n) => `t${n}`)
    let done = false
    const all = runLimited(ids, 3, 0, runs.start).then(() => (done = true))
    await settle()
    expect(runs.order).toEqual(['t0', 't1', 't2'])
    await runs.end('t1')
    expect(runs.order).toEqual(['t0', 't1', 't2', 't3'])
    while (runs.ends.size > 0) await runs.end([...runs.ends.keys()][0]!)
    await all
    expect(done).toBe(true)
    expect(runs.order).toEqual(ids)
    expect(runs.peak()).toBe(3)
  })

  it('resolves only once every run has ended', async () => {
    const runs = bench()
    let done = false
    const all = runLimited(['a', 'b'], 6, 0, runs.start).then(() => (done = true))
    await settle()
    await runs.end('a')
    expect(done).toBe(false)
    await runs.end('b')
    await all
    expect(done).toBe(true)
  })

  it('waits the gap between two starts, and not for an item with nothing to do', async () => {
    const waits: number[] = []
    const started: string[] = []
    const start = (id: string): Promise<void> | null => {
      if (id === 'skip') return null
      started.push(id)
      return Promise.resolve()
    }
    await runLimited(['a', 'skip', 'b', 'c'], 6, 150, start, { wait: async (ms) => void waits.push(ms) })
    expect(started).toEqual(['a', 'b', 'c'])
    expect(waits).toEqual([150, 150, 150])
  })

  it('gives no place to an item with nothing to do: the limit counts runs, not items', async () => {
    const runs = bench()
    const all = runLimited(['skip-1', 'a', 'skip-2', 'b', 'c'], 2, 0, (id) => (id.startsWith('skip') ? null : runs.start(id)))
    await settle()
    expect(runs.order).toEqual(['a', 'b'])
    await runs.end('a')
    await runs.end('b')
    await runs.end('c')
    await all
    expect(runs.order).toEqual(['a', 'b', 'c'])
  })

  it('goes on after a run that fails or a start that throws, and says which', async () => {
    const failed: string[] = []
    const started: string[] = []
    const start = (id: string): Promise<void> => {
      if (id === 'throw') throw new Error('no page')
      started.push(id)
      return id === 'boom' ? Promise.reject(new Error('gone')) : Promise.resolve()
    }
    await runLimited(['a', 'boom', 'throw', 'b'], 1, 0, start, { onError: (id, error) => void failed.push(`${id}: ${(error as Error).message}`) })
    expect(started).toEqual(['a', 'boom', 'b'])
    expect(failed).toEqual(['boom: gone', 'throw: no page'])
  })

  it('runs one at a time for a limit that is not a usable number', async () => {
    for (const limit of [0, -2, Number.NaN, 0.5]) {
      const runs = bench()
      const all = runLimited(['a', 'b'], limit, 0, runs.start)
      await settle()
      expect(runs.order, String(limit)).toEqual(['a'])
      await runs.end('a')
      await runs.end('b')
      await all
    }
  })

  it('keeps few pages loaded at once, and fewer when macOS says the memory is short', () => {
    expect(RELOAD_ALL_AWAKE_MAX).toBe(8)
    expect(reloadWakeLimit('normal')).toBe(8)
    expect(reloadWakeLimit('warning')).toBe(3)
    expect(reloadWakeLimit('critical')).toBe(1)
  })

  it('asks the limit again before each start, when it is a function', async () => {
    const runs = bench()
    let limit = 3
    const all = runLimited(Array.from({ length: 8 }, (_, n) => `t${n}`), () => limit, 0, runs.start)
    await settle()
    expect(runs.order).toEqual(['t0', 't1', 't2'])
    // The memory became short: as the runs end, fewer start again.
    limit = 1
    await runs.end('t0')
    await runs.end('t1')
    expect(runs.order).toEqual(['t0', 't1', 't2'])
    await runs.end('t2')
    expect(runs.order).toEqual(['t0', 't1', 't2', 't3'])
    limit = 2
    await runs.end('t3')
    expect(runs.order).toEqual(['t0', 't1', 't2', 't3', 't4', 't5'])
    while (runs.ends.size > 0) await runs.end([...runs.ends.keys()][0]!)
    await all
    expect(runs.order).toHaveLength(8)
  })
})

describe('the notices of a run that goes on', () => {
  it('say at the click how many tabs the run covers, then how far it is', () => {
    expect(reloadProgressNotice(0, 1)).toBe('Actualisation de 1 onglet…')
    expect(reloadProgressNotice(0, 135)).toBe('Actualisation de 135 onglets…')
    expect(reloadProgressNotice(12, 135)).toBe(frenchSpaces('Actualisation des onglets : 12 sur 135…'))
  })

  it('answer a second click with how far the run under way is', () => {
    expect(reloadBusyNotice(40, 135)).toBe(frenchSpaces('Actualisation déjà en cours : 40 sur 135'))
  })

  it('say at the end how a run that did not go to its end was ended, and how many tabs it left', () => {
    const notice = reloadAllNotice(30, 0, 10)
    expect(reloadEndNotice(notice, 'done', 0)).toBe(notice)
    expect(reloadEndNotice(notice, 'stopped', 95)).toBe(frenchSpaces('40 onglets actualisés, dont 10 réveillés. Actualisation arrêtée : 95 onglets non traités'))
    expect(reloadEndNotice(notice, 'timeout', 1)).toBe(frenchSpaces('40 onglets actualisés, dont 10 réveillés. Actualisation interrompue au bout de 10 min : 1 onglet non traité'))
    // Nothing reached before the end: the counts would only say « Aucun onglet à actualiser ».
    expect(reloadEndNotice(reloadAllNotice(0, 0), 'stopped', 4, false)).toBe(frenchSpaces('Actualisation arrêtée : 4 onglets non traités'))
    // Stopped once every tab was dealt with: nothing was left.
    expect(reloadEndNotice(notice, 'stopped', 0)).toBe(notice)
  })

  it('are written in the language of the interface', () => {
    setLanguage('en')
    try {
      expect(reloadProgressNotice(0, 3)).toBe('Reloading 3 tabs…')
      expect(reloadBusyNotice(1, 3)).toBe('Already reloading: 1 of 3')
      expect(reloadEndNotice(reloadAllNotice(2, 0), 'timeout', 1)).toBe('2 tabs reloaded. Reload ended after 10 min: 1 tab not reached')
    } finally {
      setLanguage('fr')
    }
  })

  it('bound the whole run at ten minutes', () => {
    expect(RELOAD_ALL_TOTAL_LIMIT_MS).toBe(10 * 60_000)
  })
})

describe('the rows a run covers', () => {
  const source = (over: { pending?: string[]; running?: string[]; reloadedAt?: Array<[string, number]> } = {}) => ({ pending: new Set(over.pending ?? []), running: new Set(over.running ?? []), reloadedAt: new Map(over.reloadedAt ?? []) })

  it('are marked to come, under way, or reloaded a moment ago, and the mark « Actualisé » goes after a few seconds', () => {
    const marks = reloadMarks(source({ pending: ['a', 'b'], running: ['c'], reloadedAt: [['d', 1000], ['old', 1000 - RELOAD_ALL_DONE_MARK_MS]] }), 1000)
    expect(marks).toEqual({ a: 'pending', b: 'pending', c: 'running', d: 'reloaded' })
    expect(reloadMarks(source({ reloadedAt: [['d', 1000]] }), 1000 + RELOAD_ALL_DONE_MARK_MS - 1)).toEqual({ d: 'reloaded' })
    expect(reloadMarks(source({ reloadedAt: [['d', 1000]] }), 1000 + RELOAD_ALL_DONE_MARK_MS)).toBeUndefined()
    expect(RELOAD_ALL_DONE_MARK_MS).toBe(4000)
  })

  it('say under way before anything else, and nothing at all outside a run', () => {
    expect(reloadMarks(source({ pending: ['a'], running: ['a'], reloadedAt: [['a', 5]] }), 5)).toEqual({ a: 'running' })
    expect(reloadMarks(source(), 5)).toBeUndefined()
  })
})

describe('the time left of a run', () => {
  it('is not said before eight sleeping tabs and ten seconds: the first ones load all at once', () => {
    expect(reloadRemainingMs({ startedAt: 0, done: RELOAD_ALL_ESTIMATE_AFTER_TABS - 1, total: 129 }, 60_000)).toBeNull()
    expect(reloadRemainingMs({ startedAt: 0, done: 40, total: 129 }, RELOAD_ALL_ESTIMATE_AFTER_MS - 1)).toBeNull()
    expect(RELOAD_ALL_ESTIMATE_AFTER_TABS).toBe(8)
    expect(RELOAD_ALL_ESTIMATE_AFTER_MS).toBe(10_000)
  })

  it('goes at the pace of the tabs done so far', () => {
    // 129 sleeping tabs, 16 of them done in 20 s: 113 left, 1.25 s each.
    expect(reloadRemainingMs({ startedAt: 1000, done: 16, total: 129 }, 21_000)).toBe(141_250)
    expect(reloadRemainingMs({ startedAt: 0, done: 129, total: 129 }, 1)).toBe(0)
  })

  it('is said in whole minutes, or as less than one', () => {
    expect(reloadPhaseDetail('sleeping', { remainingMs: 141_250 })).toBe(frenchSpaces('Onglets en veille : réveil et rechargement, environ 2 min restantes'))
    expect(reloadPhaseDetail('sleeping', { remainingMs: 61_000 })).toBe(frenchSpaces('Onglets en veille : réveil et rechargement, environ 1 min restante'))
    expect(reloadPhaseDetail('sleeping', { remainingMs: 59_000 })).toBe(frenchSpaces('Onglets en veille : réveil et rechargement, moins d’une minute restante'))
  })
})

describe('the line under the count of a run', () => {
  it('names the phase: the awake tabs, then the sleeping ones, saying when the awake ones were done just before', () => {
    expect(reloadPhaseDetail('awake')).toBe('Onglets éveillés')
    expect(reloadPhaseDetail('sleeping')).toBe(frenchSpaces('Onglets en veille : réveil et rechargement'))
    expect(reloadPhaseDetail('sleeping', { afterAwake: true })).toBe(frenchSpaces('Onglets éveillés actualisés. Onglets en veille : réveil et rechargement'))
    // The time left, once it can be told, takes the place of the end of the awake ones.
    expect(reloadPhaseDetail('sleeping', { afterAwake: true, remainingMs: 200_000 })).toBe(frenchSpaces('Onglets en veille : réveil et rechargement, environ 3 min restantes'))
    expect(reloadPhaseDetail('awake', { remainingMs: 200_000 })).toBe('Onglets éveillés')
  })

  it('says how many sites no longer answer once some are known', () => {
    expect(reloadDetailWithDead('Onglets éveillés', 0)).toBe('Onglets éveillés')
    expect(reloadDetailWithDead(frenchSpaces('Onglets en veille : réveil et rechargement'), 3)).toBe(frenchSpaces('Onglets en veille : réveil et rechargement. 3 sites ne répondent plus'))
  })

  it('is written in English too', () => {
    setLanguage('en')
    try {
      expect(reloadPhaseDetail('sleeping', { afterAwake: true })).toBe('Awake tabs reloaded. Sleeping tabs: waking and reloading')
      expect(reloadPhaseDetail('sleeping', { remainingMs: 200_000 })).toBe('Sleeping tabs: waking and reloading, about 3 min left')
      expect(reloadButtonBusyLabel({ done: 12, total: 135 })).toBe('Reloading: 12 of 135. Click for the option to stop.')
    } finally {
      setLanguage('fr')
    }
  })
})

describe('the button of a run', () => {
  it('is the one of every space for a run of every space, and the one of the space for a run of a space', () => {
    expect(reloadButtonBusy(undefined)).toBe(false)
    expect(reloadButtonBusy({})).toBe(true)
    expect(reloadButtonBusy({}, 'travail')).toBe(false)
    expect(reloadButtonBusy({ spaceId: 'travail' }, 'travail')).toBe(true)
    expect(reloadButtonBusy({ spaceId: 'travail' })).toBe(false)
    expect(reloadButtonBusy({ spaceId: 'travail' }, 'perso')).toBe(false)
  })

  it('says how far the run is and that a click offers to stop it, then that it is stopping', () => {
    expect(reloadButtonBusyLabel({ done: 12, total: 135 })).toBe(frenchSpaces('Actualisation en cours : 12 sur 135. Un clic propose de l’arrêter.'))
    expect(reloadButtonBusyLabel({ done: 12, total: 135, stopping: true })).toBe('Arrêt de l’actualisation…')
  })
})
