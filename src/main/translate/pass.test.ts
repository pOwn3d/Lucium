import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PACE, MAX_IN_FLIGHT, TRANSLATE_LIMITS, type BatchPace } from '@shared/translate-local'
import type { EngineModel } from './engines'
import { TranslationMemory } from './memory'
import { BadReply, paceOf, translatePass, type PassDeps } from './pass'
import { SYSTEM_TRANSLATE_LIMITS, SYSTEM_TRANSLATE_PACE } from './system'

// One translation of a page (pass.ts), with engines and a page of the tests' own: what is on screen goes first, a repeated text once, several
// batches ahead but never more than the bound, each batch in the page in its turn, nothing in the page after a stop or a failure.

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** A batch the engine was given, answered when the test says so. */
interface Asked {
  texts: string[]
  signal: AbortSignal
  answer(texts?: string[]): void
  fail(error: Error): void
}

/** An engine whose batches wait for the test: it says what it was given, how many were under way at most, and which were given up. */
function heldEngine(pace?: BatchPace) {
  const asked: Asked[] = []
  let underWay = 0
  let most = 0
  const model: EngineModel = {
    ...(pace ? { pace } : {}),
    translate: (texts, signal) =>
      new Promise<string[]>((resolve, reject) => {
        underWay++
        most = Math.max(most, underWay)
        const done = (): void => void underWay--
        asked.push({
          texts: [...texts],
          signal,
          answer: (out) => (done(), resolve(out ?? texts.map((text) => text.toUpperCase()))),
          fail: (error) => (done(), reject(error))
        })
        signal.addEventListener('abort', () => (done(), reject(new Error('stopped'))), { once: true })
      }),
    dispose: () => undefined
  }
  return { model, asked, most: () => most }
}

/** A page that keeps what was put in it, in order. */
function page() {
  const applied: Array<{ positions: number[]; texts: string[] }> = []
  const apply: PassDeps['apply'] = async (positions, texts) => {
    applied.push({ positions, texts })
    return { applied: positions.length, skipped: 0 }
  }
  return { applied, apply }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const SMALL: BatchPace = { inFlight: 3, first: { chars: 10, items: 1 }, next: { chars: 10, items: 1 } }

describe('the order of a translation', () => {
  it('sends what is on screen first, then by distance to the viewport, the hidden texts last', async () => {
    const engine = heldEngine({ inFlight: 1, first: { chars: 1000, items: 2 }, next: { chars: 1000, items: 2 } })
    const target = page()
    //                      0 (above)   1 (hidden)  2 (screen)  3 (below)  4 (screen)
    const texts = ['Tout en haut', 'Caché', 'Titre visible', 'Plus bas', 'Texte visible']
    const pass = translatePass({ texts, offsets: [-2000, null, 0, 300, 0] }, { models: [engine.model], apply: target.apply, signal: new AbortController().signal, memory: null })
    for (let k = 0; k < 3; k++) {
      await flush()
      engine.asked[k]!.answer()
    }
    await pass
    expect(engine.asked.map((batch) => batch.texts)).toEqual([['Titre visible', 'Texte visible'], ['Plus bas', 'Tout en haut'], ['Caché']])
    expect(target.applied[0]).toEqual({ positions: [2, 4], texts: ['TITRE VISIBLE', 'TEXTE VISIBLE'] })
  })

  it('takes the page’s order when the page said nothing usable of where its texts are', async () => {
    const engine = heldEngine()
    const pass = translatePass({ texts: ['Un', 'Deux', 'Trois'], offsets: [0, 'x', 1] }, { models: [engine.model], apply: page().apply, signal: new AbortController().signal, memory: null })
    await flush()
    engine.asked[0]!.answer()
    await pass
    expect(engine.asked[0]!.texts).toEqual(['Un', 'Deux', 'Trois'])
  })

  it('translates a text the page repeats once, and puts it in every node that has it', async () => {
    const engine = heldEngine()
    const target = page()
    const pass = translatePass({ texts: ['Menu', 'Un texte', 'Menu', 'Menu'] }, { models: [engine.model], apply: target.apply, signal: new AbortController().signal, memory: null })
    await flush()
    engine.asked[0]!.answer()
    expect(await pass).toEqual({ applied: 4, skipped: 0 })
    expect(engine.asked.map((batch) => batch.texts)).toEqual([['Menu', 'Un texte']])
    expect(target.applied).toEqual([{ positions: [0, 2, 3, 1], texts: ['MENU', 'MENU', 'MENU', 'UN TEXTE'] }])
  })
})

describe('the batches under way', () => {
  it('are never more than the engine’s pace, nor than the bound, and go into the page in their order whatever order they come back in', async () => {
    const engine = heldEngine(SMALL)
    const target = page()
    const texts = Array.from({ length: 8 }, (_, i) => `Texte ${i}`)
    const pass = translatePass({ texts }, { models: [engine.model], apply: target.apply, signal: new AbortController().signal, memory: null })
    await flush()
    expect(engine.asked).toHaveLength(3)
    // The third and the second come back before the first: nothing goes in before the first.
    engine.asked[2]!.answer()
    engine.asked[1]!.answer()
    await flush()
    expect(target.applied).toEqual([])
    expect(engine.asked).toHaveLength(3)
    engine.asked[0]!.answer()
    await flush()
    expect(target.applied.map((batch) => batch.positions)).toEqual([[0], [1], [2]])
    for (let k = 3; k < 8; k++) {
      await flush()
      engine.asked[k]!.answer()
    }
    await pass
    expect(target.applied.map((batch) => batch.positions[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(engine.most()).toBe(3)
  })

  it('are one at a time for an engine that names no pace (Bergamot, the glossary), and never more than the bound for one that asks more', () => {
    const plain: EngineModel = { translate: async (texts) => [...texts], dispose: () => undefined }
    expect(paceOf([plain])).toEqual(DEFAULT_PACE)
    expect(paceOf([{ ...plain, pace: { ...SMALL, inFlight: 50 } }]).inFlight).toBe(MAX_IN_FLIGHT)
    expect(paceOf([{ ...plain, pace: { ...SMALL, inFlight: 0 } }]).inFlight).toBe(1)
    expect(paceOf([{ ...plain, pace: { ...SMALL, inFlight: 2.5 } }]).inFlight).toBe(1)
    // A pivot (two models one after the other) goes one batch at a time.
    expect(paceOf([{ ...plain, pace: SMALL }, plain])).toEqual(DEFAULT_PACE)
  })

  it('of macOS’s translation fit the helper’s limits, and Bergamot keeps its own', () => {
    for (const size of [SYSTEM_TRANSLATE_PACE.first, SYSTEM_TRANSLATE_PACE.next]) {
      expect(size.items).toBeLessThanOrEqual(SYSTEM_TRANSLATE_LIMITS.texts)
      expect(size.chars).toBeLessThanOrEqual(SYSTEM_TRANSLATE_LIMITS.totalChars - TRANSLATE_LIMITS.nodeChars)
    }
    expect(SYSTEM_TRANSLATE_PACE.inFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT)
    expect(DEFAULT_PACE.first).toEqual({ chars: TRANSLATE_LIMITS.batchChars, items: TRANSLATE_LIMITS.batchItems })
  })
})

describe('a translation that ends early', () => {
  it('stops at « Arrêter »: nothing more goes into the page, and the batches under way are given up', async () => {
    const engine = heldEngine(SMALL)
    const target = page()
    const stop = new AbortController()
    const pass = translatePass({ texts: ['Un texte', 'Deux textes', 'Trois textes', 'Quatre textes'] }, { models: [engine.model], apply: target.apply, signal: stop.signal, memory: null })
    await flush()
    engine.asked[0]!.answer()
    await flush()
    expect(target.applied).toHaveLength(1)
    // The next batch comes back just as « Arrêter » is pressed: it does not go in.
    engine.asked[1]!.answer()
    stop.abort()
    await expect(pass).rejects.toThrow('stopped')
    expect(target.applied).toHaveLength(1)
    expect(engine.asked.slice(2).every((batch) => batch.signal.aborted)).toBe(true)
    // Nothing is sent after the stop.
    expect(engine.asked).toHaveLength(4)
  })

  it('stops when a batch fails: that failure is thrown, the later batches are given up, and none goes into the page', async () => {
    const engine = heldEngine(SMALL)
    const target = page()
    const pass = translatePass({ texts: ['Un texte', 'Deux textes', 'Trois textes', 'Quatre'] }, { models: [engine.model], apply: target.apply, signal: new AbortController().signal, memory: null })
    await flush()
    // The third comes back first, then the second fails.
    engine.asked[2]!.answer()
    engine.asked[1]!.fail(new Error('out of memory'))
    engine.asked[0]!.answer()
    await expect(pass).rejects.toThrow('out of memory')
    expect(target.applied.map((batch) => batch.positions)).toEqual([[0]])
    expect(engine.asked.slice(3).every((batch) => batch.signal.aborted)).toBe(true)
  })

  it('stops on an answer that is not one text for each text sent (BadReply), and on a page that refuses what it is given', async () => {
    const engine = heldEngine()
    const pass = translatePass({ texts: ['Un texte', 'Deux'] }, { models: [engine.model], apply: page().apply, signal: new AbortController().signal, memory: null })
    await flush()
    engine.asked[0]!.answer(['only one'])
    await expect(pass).rejects.toBeInstanceOf(BadReply)
    const refusing = heldEngine()
    const refused = translatePass({ texts: ['Un texte'] }, { models: [refusing.model], apply: async () => null, signal: new AbortController().signal, memory: null })
    await flush()
    refusing.asked[0]!.answer()
    await expect(refused).rejects.toThrow('page')
  })
})

describe('the memory of a translation', () => {
  it('puts a text translated before at once, without the engine, and keeps what the engine answered', async () => {
    const memory = new TranslationMemory()
    memory.set('system:fr>en', 'Accueil', 'Home')
    const engine = heldEngine()
    const target = page()
    const pass = translatePass({ texts: ['Accueil', 'Un texte neuf'] }, { models: [engine.model], apply: target.apply, signal: new AbortController().signal, memory: memory.of('system:fr>en') })
    await flush()
    // What is known is in the page before the engine answered.
    expect(target.applied).toEqual([{ positions: [0], texts: ['Home'] }])
    expect(engine.asked.map((batch) => batch.texts)).toEqual([['Un texte neuf']])
    engine.asked[0]!.answer()
    await pass
    expect(memory.get('system:fr>en', 'Un texte neuf')).toBe('UN TEXTE NEUF')
    // Again (« Afficher l'original », then « Traduire »): nothing for the engine, all in one go.
    const again = heldEngine()
    const second = page()
    expect(await translatePass({ texts: ['Accueil', 'Un texte neuf'] }, { models: [again.model], apply: second.apply, signal: new AbortController().signal, memory: memory.of('system:fr>en') })).toEqual({ applied: 2, skipped: 0 })
    expect(again.asked).toEqual([])
    expect(second.applied).toHaveLength(1)
    // Another route translates again.
    expect(memory.get('bergamot:fr-en@1', 'Accueil')).toBeUndefined()
  })
})

// The time a page takes, on a clock of the test's own, with an engine that costs what the system's helper was measured to cost on this Mac (macOS
// 27.2, its default strategy, docs/traduction-locale.md): a run of the helper 430 ms (the process, its check of the caller, the session), then
// 150 ms a text and 2,9 ms a character, one text after the other whatever the number of sessions; putting a batch in the page costs a little too.
// Before: a run per batch, the page's order, batches of 3 000 characters one after the other. Now: one run for the page, what is on screen first,
// a small first batch, three batches ahead. A model of the measures, not a measure of a page.
describe('the time a long page takes (a model of the helper)', () => {
  const COST = { start: 430, text: 150, perChar: 2.9, apply: 8 }

  function timedEngine(startEachBatch: boolean, pace?: BatchPace): EngineModel {
    let free = 0
    let started = false
    return {
      ...(pace ? { pace } : {}),
      translate: (texts, signal) =>
        new Promise<string[]>((resolve, reject) => {
          const now = Date.now()
          const chars = texts.reduce((sum, text) => sum + text.length, 0)
          const begin = Math.max(now, free)
          const end = begin + (startEachBatch || !started ? COST.start : 0) + texts.length * COST.text + chars * COST.perChar
          started = true
          free = end
          const timer = setTimeout(() => resolve(texts.map((text) => text.toUpperCase())), end - now)
          signal.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('stopped'))), { once: true })
        }),
      dispose: () => undefined
    }
  }

  async function measure(model: EngineModel, offsets: Array<number | null> | undefined, texts: string[], screen: number[]) {
    vi.useFakeTimers({ now: 0 })
    const seen = new Set<number>()
    let firstOnScreen = -1
    let allOnScreen = -1
    const apply: PassDeps['apply'] = (positions, out) =>
      new Promise((resolve) => {
        setTimeout(() => {
          for (const position of positions) seen.add(position)
          if (firstOnScreen < 0 && screen.some((position) => seen.has(position))) firstOnScreen = Date.now()
          if (allOnScreen < 0 && screen.every((position) => seen.has(position))) allOnScreen = Date.now()
          resolve({ applied: out.length, skipped: 0 })
        }, COST.apply)
      })
    const pass = translatePass({ texts, offsets }, { models: [model], apply, signal: new AbortController().signal, memory: null })
    await vi.runAllTimersAsync()
    await pass
    const total = Date.now()
    vi.useRealTimers()
    return { firstOnScreen, allOnScreen, total }
  }

  // 300 paragraphs of 200 characters (60 000 characters, a long article); ten of them on screen.
  const texts = Array.from({ length: 300 }, (_, i) => `Paragraphe ${String(i).padStart(3, '0')} `.padEnd(200, 'x'))
  const read = (top: number) => ({ offsets: texts.map((_, i) => (i < top ? (i - top) * 80 : i < top + 10 ? 0 : (i - top - 9) * 80)), screen: Array.from({ length: 10 }, (_, k) => top + k) })

  it('shows what is on screen far sooner, read from the top or from the middle; the whole page is what macOS takes', async () => {
    const top = read(0)
    const middle = read(150)
    const results = {
      top: { before: await measure(timedEngine(true), undefined, texts, top.screen), after: await measure(timedEngine(false, SYSTEM_TRANSLATE_PACE), top.offsets, texts, top.screen) },
      middle: { before: await measure(timedEngine(true), undefined, texts, middle.screen), after: await measure(timedEngine(false, SYSTEM_TRANSLATE_PACE), middle.offsets, texts, middle.screen) }
    }
    // Read from the top: the first paragraph on screen after 1,9 s instead of 11,4 s. From the middle: 1,9 s instead of 125 s (the page's order
    // reached it last). The whole page: 219 s instead of 228 s: the runs saved, the rest is macOS's own pace (some 270 characters a second).
    expect(results.top.before).toEqual({ firstOnScreen: 11_388, allOnScreen: 11_388, total: 227_608 })
    expect(results.middle.before).toEqual({ firstOnScreen: 125_188, allOnScreen: 125_188, total: 227_608 })
    for (const where of [results.top, results.middle]) expect(where.after).toEqual({ firstOnScreen: 1898, allOnScreen: 10_658, total: 219_438 })
  })
})
