import { describe, expect, it } from 'vitest'
import type { ProcessRow } from './ipc'
import { CPU_INTERVAL_MAX_MS, CpuMeter, contentsHost, filterProcessRows, isKillablePid, mayKillProcess, memoryShare, processRows, processSummary, rendererRow, sleepTargetOf, sortProcessRows, stepProcessRow, tabResourcesOf, type RendererHost } from './processes'
import { frenchSpaces } from './french-typography'

describe('processRows', () => {
  const raw = [
    { pid: 1, type: 'Browser', cpu: 1.234, memoryKb: 200 * 1024 },
    { pid: 2, type: 'Tab', cpu: 0, memoryKb: 500 * 1024 },
    { pid: 3, type: 'Tab', cpu: 0.04, memoryKb: 80 * 1024 },
    { pid: 4, type: 'GPU', cpu: 2, memoryKb: 120 * 1024 },
    { pid: 5, type: 'Pepper Plugin', cpu: 0, memoryKb: 10 * 1024 }
  ]

  it('names a tab after its page and the other processes after what they do', () => {
    const rows = processRows(raw, new Map([[2, 'GitHub']]))
    expect(rows.find((r) => r.pid === 2)).toMatchObject({ kind: 'tab', name: 'GitHub' })
    // A renderer nothing accounts for is not called a tab (it was "Onglet", like every renderer that was not one).
    expect(rows.find((r) => r.pid === 3)).toMatchObject({ kind: 'other', name: 'Processus de rendu' })
    expect(rows.find((r) => r.pid === 1)).toMatchObject({ kind: 'browser', name: 'Lucium' })
    expect(rows.find((r) => r.pid === 4)).toMatchObject({ kind: 'gpu' })
    expect(rows.find((r) => r.pid === 5)).toMatchObject({ kind: 'other', name: 'Autre' })
  })

  it('lists the heaviest first, in megabytes, with the CPU rounded to a tenth', () => {
    const rows = processRows(raw, new Map())
    expect(rows.map((r) => r.pid)).toEqual([2, 1, 4, 3, 5])
    expect(rows[1]).toMatchObject({ memoryMb: 200, cpu: 1.2 })
  })

  it('breaks a tie by process id', () => {
    const rows = processRows([{ pid: 9, type: 'Tab', cpu: 0, memoryKb: 1024 }, { pid: 7, type: 'Tab', cpu: 0, memoryKb: 1024 }], new Map())
    expect(rows.map((r) => r.pid)).toEqual([7, 9])
  })
})

describe('sortProcessRows', () => {
  const rows: ProcessRow[] = [
    { pid: 30, kind: 'tab', name: 'Zèbre', cpu: 1.5, memoryMb: 200 },
    { pid: 10, kind: 'browser', name: 'Lucium', cpu: 0.2, memoryMb: 300 },
    { pid: 20, kind: 'tab', name: 'abeille', cpu: 3, memoryMb: 200 }
  ]

  it('keeps the order it was sent in until a column is picked', () => {
    expect(sortProcessRows(rows, null, 'asc').map((r) => r.pid)).toEqual([30, 10, 20])
  })

  it('orders numbers as numbers, in both directions, the process id breaking ties', () => {
    expect(sortProcessRows(rows, 'memoryMb', 'desc').map((r) => r.pid)).toEqual([10, 20, 30])
    expect(sortProcessRows(rows, 'memoryMb', 'asc').map((r) => r.pid)).toEqual([20, 30, 10])
    expect(sortProcessRows(rows, 'cpu', 'desc').map((r) => r.pid)).toEqual([20, 30, 10])
    expect(sortProcessRows(rows, 'pid', 'asc').map((r) => r.pid)).toEqual([10, 20, 30])
  })

  it('orders words without regard to case or accents, and the type by its label', () => {
    expect(sortProcessRows(rows, 'name', 'asc').map((r) => r.name)).toEqual(['abeille', 'Lucium', 'Zèbre'])
    expect(sortProcessRows(rows, 'kind', 'asc').map((r) => r.pid)).toEqual([10, 20, 30])
  })

  it('does not change the rows it was given', () => {
    const before = rows.map((r) => r.pid)
    sortProcessRows(rows, 'pid', 'asc')
    expect(rows.map((r) => r.pid)).toEqual(before)
  })
})

describe('isKillablePid', () => {
  it('accepts the id of another process', () => {
    expect(isKillablePid(4321, 100)).toBe(true)
  })

  it('refuses the ids that signal a whole group or everything: 0, 1, negative numbers', () => {
    for (const pid of [0, 1, -1, -4321]) expect(isKillablePid(pid, 100)).toBe(false)
  })

  it('refuses a missing or odd id, and the main process itself', () => {
    for (const pid of [undefined, null, NaN, Infinity, 12.5, '4321']) expect(isKillablePid(pid, 100)).toBe(false)
    expect(isKillablePid(100, 100)).toBe(false)
  })
})

describe('mayKillProcess', () => {
  const pages = new Map([[4321, 'GitHub']])

  it('accepts the process of a page of the browser', () => {
    expect(mayKillProcess(4321, 100, pages)).toBe(true)
  })

  it('refuses any other process, even a renderer: an extension’s, a panel’s, a service', () => {
    expect(mayKillProcess(4322, 100, pages)).toBe(false)
    expect(mayKillProcess(100, 100, new Map([[100, 'itself']]))).toBe(false)
  })

  it('refuses ids that are not a process of a page, whatever the map holds', () => {
    const odd = new Map<number, string>([[0, 'a page without a process'], [1, 'init']])
    for (const pid of [0, 1, -1, '4321', undefined, NaN]) expect(mayKillProcess(pid, 100, odd), String(pid)).toBe(false)
  })
})

describe('tabResourcesOf', () => {
  const raw = [
    { pid: 100, type: 'Browser', cpu: 3, memoryKb: 300 * 1024 },
    { pid: 200, type: 'Tab', cpu: 1.26, memoryKb: 142.4 * 1024 },
    { pid: 300, type: 'Tab', cpu: 0, memoryKb: 90 * 1024 },
    { pid: 400, type: 'GPU', cpu: 2, memoryKb: 120 * 1024 },
    { pid: 500, type: 'Utility', cpu: 0, memoryKb: 40 * 1024 }
  ]
  // The pages of the user's tabs: 300 is the renderer of an extension (a 'Tab' for Electron, but not a page), so it is not in the map.
  const pages = new Map([[200, 'Une page'], [400, 'Pas un onglet'], [500, 'Pas un onglet non plus']])

  it('gives the memory in megabytes and the processor to a tenth, for the process of a tab page', () => {
    expect(tabResourcesOf(raw, 200, 100, pages, 1)).toEqual({ memoryMb: 142, cpu: 1.3, shared: false })
  })

  it('says the figures are the process\'s when other tabs render in it', () => {
    expect(tabResourcesOf(raw, 200, 100, pages, 3)?.shared).toBe(true)
  })

  it('has nothing for a tab with no process (Electron reports 0 for a page that was put to sleep)', () => {
    for (const pid of [0, 1, -1, undefined, null, NaN, '200']) expect(tabResourcesOf(raw, pid, 100, pages, 1), String(pid)).toBeNull()
  })

  it('shows no process that is not a page of the user\'s tabs: the browser, a service, an extension\'s renderer', () => {
    expect(tabResourcesOf(raw, 100, 100, pages, 1)).toBeNull()
    expect(tabResourcesOf(raw, 300, 100, pages, 1)).toBeNull()
    expect(tabResourcesOf(raw, 500, 999, pages, 1)).toBeNull()
    expect(tabResourcesOf(raw, 200, 200, pages, 1)).toBeNull()
  })

  it('shows nothing for a page process that Electron did not measure, or that is not a tab process', () => {
    expect(tabResourcesOf(raw.filter((p) => p.pid !== 200), 200, 100, pages, 1)).toBeNull()
    expect(tabResourcesOf(raw, 400, 100, pages, 1)).toBeNull()
  })
})

describe('stepProcessRow', () => {
  const pids = [30, 10, 20]

  it('steps through the rows as shown, without leaving the list', () => {
    expect(stepProcessRow(pids, 30, 'ArrowDown')).toBe(10)
    expect(stepProcessRow(pids, 10, 'ArrowDown')).toBe(20)
    expect(stepProcessRow(pids, 20, 'ArrowDown')).toBe(20)
    expect(stepProcessRow(pids, 20, 'ArrowUp')).toBe(10)
    expect(stepProcessRow(pids, 30, 'ArrowUp')).toBe(30)
  })

  it('goes to the ends, starts from the first row when none is picked or the picked one is gone, and ignores other keys', () => {
    expect(stepProcessRow(pids, 10, 'Home')).toBe(30)
    expect(stepProcessRow(pids, 10, 'End')).toBe(20)
    expect(stepProcessRow(pids, null, 'ArrowDown')).toBe(30)
    expect(stepProcessRow(pids, 999, 'ArrowDown')).toBe(30)
    expect(stepProcessRow(pids, 10, 'a')).toBeNull()
    expect(stepProcessRow([], null, 'ArrowDown')).toBeNull()
  })
})

describe('the task manager', () => {
  const rows = [
    { pid: 1, kind: 'browser' as const, name: 'Lucium', cpu: 1.2, memoryMb: 400 },
    { pid: 2, kind: 'tab' as const, name: 'Éditeur de réunion', cpu: 0.4, memoryMb: 200 },
    { pid: 3, kind: 'tab' as const, name: 'GitHub', cpu: 0.15, memoryMb: 100 },
    { pid: 4, kind: 'gpu' as const, name: 'Processeur graphique', cpu: 0, memoryMb: 0 }
  ]

  it('sums the memory and the processor of every process and counts the tabs', () => {
    expect(processSummary(rows)).toEqual({ memoryMb: 700, tabs: 2, cpu: 1.8 })
    expect(processSummary([])).toEqual({ memoryMb: 0, tabs: 0, cpu: 0 })
  })

  it('filters by name, type or process id, accents and case aside, and keeps everything for an empty filter', () => {
    expect(filterProcessRows(rows, 'reunion').map((r) => r.pid)).toEqual([2])
    expect(filterProcessRows(rows, 'ONGLET').map((r) => r.pid)).toEqual([2, 3])
    expect(filterProcessRows(rows, '4').map((r) => r.pid)).toEqual([4])
    expect(filterProcessRows(rows, '  ').map((r) => r.pid)).toEqual([1, 2, 3, 4])
    expect(filterProcessRows(rows, 'zzz')).toEqual([])
  })

  it('measures the bar of memory against the heaviest process, and draws none when nothing weighs', () => {
    expect(memoryShare(rows[0]!, rows)).toBe(1)
    expect(memoryShare(rows[1]!, rows)).toBe(0.5)
    expect(memoryShare(rows[3]!, rows)).toBe(0)
    expect(memoryShare({ ...rows[3]! }, [rows[3]!])).toBe(0)
  })
})

describe('CpuMeter', () => {
  const sample = (pid: number, cumulativeSeconds: number | undefined, percentAllCores = 0, creationTime = 1000) => ({ pid, creationTime, cumulativeSeconds, percentAllCores })

  it('gives the share of ONE core from the processor time over its own interval, as Activity Monitor does', () => {
    const meter = new CpuMeter(14)
    meter.measure([sample(1, 10), sample(2, 50)], 0)
    // 0.34 s of processor in 2 s is 17 % of a core; 3 s in 2 s is a process that keeps one and a half cores busy.
    const shares = meter.measure([sample(1, 10.34), sample(2, 53)], 2000)
    expect(shares.get(1)).toBeCloseTo(17, 5)
    expect(shares.get(2)).toBeCloseTo(150, 5)
  })

  it('multiplies Electron\'s figure back by the number of cores for a process measured for the first time (Electron 45 divides it by them)', () => {
    // The pid 1392 of the measures of 4 November: 1.2 % in the task manager on 14 cores was 17 % of one core with ps.
    expect(new CpuMeter(14).measure([sample(1392, 300, 1.2)], 0).get(1392)).toBeCloseTo(16.8, 5)
  })

  it('falls back on Electron\'s figure when this Electron gives no processor time', () => {
    const meter = new CpuMeter(8)
    meter.measure([sample(1, undefined, 1)], 0)
    expect(meter.measure([sample(1, undefined, 2.5)], 2000).get(1)).toBe(20)
  })

  it('does not take a new process with the same pid for the old one, nor a measure from before the window was closed', () => {
    const meter = new CpuMeter(4)
    meter.measure([sample(7, 100, 0, 1000)], 0)
    // The pid came back with another process (another creation time): its 2 s of processor since it started are not 2 s in the interval.
    expect(meter.measure([sample(7, 2, 5, 9000)], 2000).get(7)).toBe(20)
    meter.measure([sample(8, 10)], 10_000)
    expect(meter.measure([sample(8, 11, 3)], 10_000 + CPU_INTERVAL_MAX_MS + 1).get(8)).toBe(12)
  })

  it('never gives a negative or non-finite share', () => {
    const meter = new CpuMeter(4)
    meter.measure([sample(1, 10)], 0)
    expect(meter.measure([sample(1, 9)], 1000).get(1)).toBe(0)
    expect(new CpuMeter(4).measure([sample(2, undefined, Number.NaN)], 0).get(2)).toBe(0)
  })

  it('keeps one interval per meter: a reader that measures often does not shorten another one\'s', () => {
    const taskManager = new CpuMeter(2)
    const card = new CpuMeter(2)
    taskManager.measure([sample(1, 0)], 0)
    card.measure([sample(1, 0)], 0)
    card.measure([sample(1, 0.1)], 500)
    expect(taskManager.measure([sample(1, 1)], 2000).get(1)).toBeCloseTo(50, 5)
  })
})

describe('the names of the renderers that are not tabs', () => {
  const host = (url: string, facts: { surface?: boolean; extension?: string; persistent?: boolean } = {}) => contentsHost({ url, surface: facts.surface ?? false, extension: facts.extension, persistent: facts.persistent ?? true })

  it('reads a page of our interface by its file, wherever it is loaded from, and a private window\'s by its flag', () => {
    expect(host('file:///Applications/Lucium.app/Contents/Resources/app.asar/out/renderer/index.html?private=1', { surface: true })).toEqual({ kind: 'surface', surface: 'window', window: 'fenêtre privée' })
    expect(host('file:///x/out/renderer/index.html#float', { surface: true })).toEqual({ kind: 'surface', surface: 'floating', window: 'autre fenêtre' })
    expect(host('http://localhost:5173/overlay.html', { surface: true })).toMatchObject({ kind: 'surface', surface: 'overlay' })
    expect(host('file:///x/out/renderer/settings.html#general', { surface: true })).toEqual({ kind: 'app', page: 'settings' })
    expect(host('file:///x/out/renderer/littlearc.html?id=little-1&bar=1', { surface: true })).toEqual({ kind: 'app', page: 'little' })
    // A local file a page opened is not our interface, whatever its name.
    expect(host('file:///Users/me/settings.html')).toEqual({ kind: 'page', page: 'other' })
  })

  it('names an extension\'s page after the extension, our views, the developer tools, and a private window\'s page without saying what it is', () => {
    expect(host('chrome-extension://abcdefghijklmnopabcdefghijklmnop/manifest.json', { extension: 'Dashlane' })).toEqual({ kind: 'extension', name: 'Dashlane' })
    expect(host('chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html')).toEqual({ kind: 'extension', name: 'extension inconnue' })
    expect(host('data:text/html;charset=utf-8;base64,PGI+')).toEqual({ kind: 'app', page: 'view' })
    expect(host('devtools://devtools/bundled/devtools_app.html')).toEqual({ kind: 'app', page: 'devtools' })
    expect(host('https://mail.example/inbox', { persistent: false })).toEqual({ kind: 'page', page: 'private' })
    expect(host('not an address')).toEqual({ kind: 'page', page: 'other' })
  })

  it('names each surface of a window, and carries no address into the name', () => {
    const named = (hosts: RendererHost[]) => rendererRow(hosts)
    expect(named([{ kind: 'surface', surface: 'window', window: 'fenêtre 3' }])).toEqual({ kind: 'interface', name: frenchSpaces('Interface — fenêtre 3 : barre latérale') })
    expect(named([{ kind: 'surface', surface: 'overlay', window: 'fenêtre principale' }]).name).toBe(frenchSpaces('Interface — fenêtre principale : calque (barre de commandes, panneaux)'))
    expect(named([{ kind: 'surface', surface: 'tooltip', window: 'Travail' }]).name).toBe(frenchSpaces('Interface — Travail : infobulle'))
    expect(named([{ kind: 'extension', name: 'uBlock Origin Lite' }])).toEqual({ kind: 'extension', name: frenchSpaces('Extension : uBlock Origin Lite') })
    expect(named([{ kind: 'page', page: 'peek', window: 'fenêtre 2' }])).toEqual({ kind: 'page', name: 'Aperçu du lien (Coup d’œil) — fenêtre 2' })
    expect(named([{ kind: 'worker', owner: 'Boîte de réception' }])).toEqual({ kind: 'worker', name: frenchSpaces('Service worker de : Boîte de réception') })
    expect(named([{ kind: 'worker', private: true, owner: 'secret' }]).name).toBe('Service worker d’une fenêtre privée')
    expect(named([])).toEqual({ kind: 'other', name: 'Processus de rendu' })
  })

  it('names the frames of other sites after their tab, and carries the tab only when there is one', () => {
    expect(rendererRow([{ kind: 'subframe', tabId: 't1', tabName: 'Le Monde' }, { kind: 'subframe', tabId: 't1', tabName: 'Le Monde' }])).toEqual({ kind: 'subframe', name: frenchSpaces('Sous-cadre de : Le Monde'), tabId: 't1' })
    const shared = rendererRow([{ kind: 'subframe', tabId: 't1', tabName: 'Le Monde' }, { kind: 'subframe', tabId: 't2', tabName: 'Libération' }])
    expect(shared).toEqual({ kind: 'subframe', name: frenchSpaces('Sous-cadre de : Le Monde, Libération') })
    const many = rendererRow(['A', 'B', 'C', 'D'].map((name) => ({ kind: 'subframe' as const, tabId: name, tabName: name })))
    expect(many.name).toBe(frenchSpaces('Sous-cadre de : A, B, C, …'))
  })

  it('lists what a process hosts, the strongest first, which gives the kind of the row', () => {
    const row = rendererRow([{ kind: 'subframe', tabId: 't1', tabName: 'Gmail' }, { kind: 'extension', name: 'Dashlane' }, { kind: 'worker' }])
    expect(row).toEqual({ kind: 'extension', name: frenchSpaces('Extension : Dashlane · Sous-cadre de : Gmail · Service worker d’un site') })
  })

  it('names a renderer by what it hosts, a tab\'s page by its tab, and gives the type its label', () => {
    const raw = [
      { pid: 10, type: 'Tab', cpu: 17.04, memoryKb: 146 * 1024 },
      { pid: 11, type: 'Tab', cpu: 0, memoryKb: 90 * 1024 },
      { pid: 12, type: 'Tab', cpu: 0, memoryKb: 80 * 1024 }
    ]
    const hosts = new Map<number, RendererHost[]>([
      [10, [{ kind: 'surface', surface: 'window', window: 'fenêtre 3' }]],
      [11, [{ kind: 'surface', surface: 'window', window: 'ignored: the page of a tab is named after its tab' }]],
      [12, [{ kind: 'subframe', tabId: 't9', tabName: 'Actualités' }]]
    ])
    const rows = processRows(raw, new Map([[11, 'GitHub']]), hosts)
    expect(rows.find((r) => r.pid === 10)).toEqual({ pid: 10, kind: 'interface', name: frenchSpaces('Interface — fenêtre 3 : barre latérale'), cpu: 17, memoryMb: 146 })
    expect(rows.find((r) => r.pid === 11)).toMatchObject({ kind: 'tab', name: 'GitHub' })
    expect(rows.find((r) => r.pid === 12)).toMatchObject({ kind: 'subframe', tabId: 't9' })
    expect(filterProcessRows(rows, 'interface').map((r) => r.pid)).toEqual([10])
    expect(filterProcessRows(rows, 'sous-cadre').map((r) => r.pid)).toEqual([12])
    // Only the pages of tabs count as tabs in the summary.
    expect(processSummary(rows).tabs).toBe(1)
  })
})

describe('sleepTargetOf', () => {
  const row = (extra: Partial<ProcessRow>): ProcessRow => ({ pid: 5, kind: 'tab', name: 'x', cpu: 0, memoryMb: 1, ...extra })

  it('puts to sleep the tab of a page, and the tab the frames of another site are in', () => {
    expect(sleepTargetOf(row({ tabId: 't1' }))).toBe('t1')
    expect(sleepTargetOf(row({ kind: 'subframe', tabId: 't2' }))).toBe('t2')
  })

  it('has nothing to put to sleep for a sleeping tab, frames of several tabs, or any other process', () => {
    expect(sleepTargetOf(row({ tabId: 't1', asleep: true }))).toBeNull()
    expect(sleepTargetOf(row({ kind: 'subframe' }))).toBeNull()
    expect(sleepTargetOf(row({ kind: 'interface', tabId: 't1' }))).toBeNull()
    expect(sleepTargetOf(row({ kind: 'extension' }))).toBeNull()
    expect(sleepTargetOf(undefined)).toBeNull()
  })
})
