import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabResources } from './ipc'
import { defaultSettings } from './model'
import { setLanguage } from './i18n'
import { RESOURCES_REFRESH_MS, RESOURCES_SECOND_MEASURE_MS, cardStatus, formatMemory, pollResources, resourcesLine, splitAddress, type ResourcesReading } from './hover-card'
import { frenchSpaces } from './french-typography'

describe('the address on a hover card', () => {
  it('keeps the host whole and puts the rest after it', () => {
    expect(splitAddress('https://www.example.com/docs/page?q=1#top')).toEqual({ host: 'www.example.com', rest: '/docs/page?q=1#top' })
  })

  it('drops a bare trailing slash and keeps a port', () => {
    expect(splitAddress('http://localhost:3000/')).toEqual({ host: 'localhost:3000', rest: '' })
  })

  it('shows anything that is not a web address as it is', () => {
    expect(splitAddress('about:blank')).toEqual({ host: 'about:blank', rest: '' })
    expect(splitAddress('not a url')).toEqual({ host: 'not a url', rest: '' })
  })
})

describe('the state of a tab on its card', () => {
  it('lists the states that apply, in a fixed order', () => {
    expect(cardStatus({ pinned: true }, { audible: true, muted: false, awake: false })).toBe('Épinglé · Son en cours · En veille')
    expect(cardStatus({ pinned: false }, { audible: true, muted: true, awake: true })).toBe('Son coupé')
  })

  it('says nothing for a plain awake tab, or when the tab has no runtime yet', () => {
    expect(cardStatus({ pinned: false }, { audible: false, muted: false, awake: true })).toBe('')
    expect(cardStatus({ pinned: false }, undefined)).toBe('')
  })
})

describe('the memory line of a card', () => {
  const read = (resources: TabResources | null, measures: number): ResourcesReading => ({ state: 'read', resources, measures })
  const page: TabResources = { memoryMb: 142, cpu: 0.34, shared: false }

  it('is off by default, so that the card shows no memory line', () => {
    expect(defaultSettings().showTabMemory).toBe(false)
  })

  it('writes megabytes, and gigabytes from one gigabyte on', () => {
    expect(formatMemory(142)).toBe(frenchSpaces('142 Mo'))
    expect(formatMemory(1023)).toBe(frenchSpaces('1023 Mo'))
    expect(formatMemory(1536)).toBe(frenchSpaces('1,5 Go'))
  })

  it('gives the memory at the first measure and the processor from the second, which has the first to compare with', () => {
    expect(resourcesLine(read(page, 1))).toBe(frenchSpaces('Mémoire 142 Mo · Processeur …'))
    expect(resourcesLine(read(page, 2))).toBe(frenchSpaces('Mémoire 142 Mo · Processeur 0,3 %'))
    expect(resourcesLine(read({ ...page, cpu: 0 }, 5))).toBe(frenchSpaces('Mémoire 142 Mo · Processeur 0,0 %'))
  })

  it('holds its place while the first answer is on its way, so that the card does not grow', () => {
    expect(resourcesLine({ state: 'waiting' })).toBe('Mémoire … · Processeur …')
  })

  it('writes a dash for both figures when the tab has no process (asleep, frozen)', () => {
    expect(resourcesLine(read(null, 1))).toBe('Mémoire — · Processeur —')
    expect(resourcesLine(read(null, 4))).toBe('Mémoire — · Processeur —')
  })

  it('says when the process is shared with other tabs, because its figures are not the tab\'s alone', () => {
    expect(resourcesLine(read({ ...page, shared: true }, 2))).toBe(frenchSpaces('Mémoire 142 Mo · Processeur 0,3 % · processus partagé'))
  })

  it('writes the line, its units and its decimal mark in the language of the interface', () => {
    setLanguage('en')
    try {
      expect(formatMemory(1536)).toBe('1.5 GB')
      expect(resourcesLine(read(page, 2))).toBe('Memory 142 MB · CPU 0.3%')
      expect(resourcesLine(read({ ...page, shared: true }, 2))).toBe('Memory 142 MB · CPU 0.3% · shared process')
    } finally {
      setLanguage('fr')
    }
  })
})

describe('pollResources', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const resources: TabResources = { memoryMb: 100, cpu: 1, shared: false }

  it('measures at once, a second later, then every three seconds, and never again once stopped', async () => {
    const measure = vi.fn(() => Promise.resolve(resources))
    const readings: ResourcesReading[] = []
    const stop = pollResources(measure, (r) => void readings.push(r), () => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(measure).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(measure).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(measure).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2999)
    expect(measure).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(measure).toHaveBeenCalledTimes(3)
    expect(readings.map((r) => (r.state === 'read' ? r.measures : 0))).toEqual([1, 2, 3])
    expect([RESOURCES_SECOND_MEASURE_MS, RESOURCES_REFRESH_MS]).toEqual([1000, 3000])
    stop()
    await vi.advanceTimersByTimeAsync(RESOURCES_REFRESH_MS * 10)
    expect(measure).toHaveBeenCalledTimes(3)
  })

  it('drops an answer that comes after the stop', async () => {
    let answer: (value: TabResources | null) => void = () => {}
    const readings: ResourcesReading[] = []
    const stop = pollResources(() => new Promise((resolve) => (answer = resolve)), (r) => void readings.push(r), () => {})
    // The measure starts a tick after the call: let it, so that there is an answer on its way when the card closes.
    await vi.advanceTimersByTimeAsync(0)
    stop()
    answer(resources)
    await vi.advanceTimersByTimeAsync(RESOURCES_REFRESH_MS * 2)
    expect(readings).toEqual([])
  })

  it('shows "no process" and reports the cause when a measure fails, and does not go on', async () => {
    const errors: unknown[] = []
    const readings: ResourcesReading[] = []
    const measure = vi.fn(() => Promise.reject(new Error('ipc closed')))
    pollResources(measure, (r) => void readings.push(r), (e) => void errors.push(e))
    await vi.advanceTimersByTimeAsync(RESOURCES_REFRESH_MS * 3)
    expect(readings).toEqual([{ state: 'read', resources: null, measures: 0 }])
    expect((errors[0] as Error).message).toBe('ipc closed')
    expect(measure).toHaveBeenCalledTimes(1)
  })

  it('treats a measure that throws like one that rejects', async () => {
    const errors: unknown[] = []
    pollResources(() => { throw new Error('no api') }, () => {}, (e) => void errors.push(e))
    await vi.advanceTimersByTimeAsync(0)
    expect((errors[0] as Error).message).toBe('no api')
  })

  it('does not report a failure that comes after the stop', async () => {
    let fail: (error: Error) => void = () => {}
    const errors: unknown[] = []
    const readings: ResourcesReading[] = []
    const stop = pollResources(() => new Promise((_resolve, reject) => (fail = reject)), (r) => void readings.push(r), (e) => void errors.push(e))
    await vi.advanceTimersByTimeAsync(0)
    stop()
    fail(new Error('late'))
    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toEqual([])
    expect(readings).toEqual([])
  })
})
