// One translation of the text of a page: what the controller does once the page was read and the engine loaded (controller.ts `translate`).
//
//  - What is on screen goes first: the texts are taken in `readingOrder` (on screen, then by distance to the viewport, hidden last), so the first
//    batch is the part the person is looking at; the engine's first batch is small (its pace) so that it comes back soon.
//  - A text the page repeats (a menu, a button) is translated once and put in each node that has it; a text the memory knows (memory.ts) is put in
//    at once, before any batch comes back.
//  - The engine is given up to `inFlight` batches at once (its pace: macOS's helper takes them one after the other without a pause between two;
//    Bergamot one at a time), THE BOUND being MAX_IN_FLIGHT; each batch goes into the page as soon as it and those before it are translated, so the
//    page fills in the order of the plan, never with a hole above.
//  - A stop (« Arrêter », « Afficher l'original », another document) or a failure ends it: no batch is put in the page after it, the batches under way
//    are given up (their signal), and the controller puts the page back as it was.

import { DEFAULT_PACE, MAX_IN_FLIGHT, checkReply, planBatches, readingOrder, usableOffsets, type BatchPace } from '@shared/translate-local'
import type { EngineModel } from './engines'
import type { RouteMemory } from './memory'

/** An engine answered something that is not one text for each text sent: the page is put back and the person is told. */
export class BadReply extends Error {
  constructor() {
    super('an engine answered with something that is not one text for each text sent')
    this.name = 'BadReply'
  }
}

export interface PassPage {
  /** The words of each node, in the page's order (ExtractReply.nodes). */
  texts: readonly string[]
  /** Where each node is from the viewport (ExtractReply.offsets); unknown: the page's order. */
  offsets?: unknown
}

export interface PassDeps {
  /** The models of the route, one after the other for each batch (a pivot has two). */
  models: readonly EngineModel[]
  /** Puts translations in the page: the positions of the nodes and their texts. Null: the page refused (it was not read, or changed). */
  apply(positions: number[], texts: string[]): Promise<{ applied: number; skipped: number } | null>
  /** The stop of this translation. */
  signal: AbortSignal
  /** What was translated before by the same route (null: nothing is kept, a private page). */
  memory: RouteMemory | null
}

/** The pace of a route: an engine's own when it is the only one, else one batch at a time; never more than MAX_IN_FLIGHT batches at once. */
export function paceOf(models: readonly EngineModel[]): BatchPace {
  const pace = models.length === 1 && models[0]!.pace ? models[0]!.pace : DEFAULT_PACE
  const inFlight = Number.isInteger(pace.inFlight) ? Math.min(Math.max(pace.inFlight, 1), MAX_IN_FLIGHT) : 1
  return { ...pace, inFlight }
}

const stopped = (): Error => new Error('stopped')

/** Translates the texts of a page and puts them in it. Throws on a stop ('stopped'), a bad answer (BadReply), a page that refused ('page') or a failure of the engine. */
export async function translatePass(page: PassPage, deps: PassDeps): Promise<{ applied: number; skipped: number }> {
  const { models, signal, memory } = deps
  // Each distinct text once, at the place of its node nearest the viewport; its translation goes into every node that has it.
  const nodesOf = new Map<string, number[]>()
  const distinct: string[] = []
  for (const index of readingOrder(usableOffsets(page.offsets, page.texts.length))) {
    const text = page.texts[index]!
    const nodes = nodesOf.get(text)
    if (nodes) nodes.push(index)
    else {
      nodesOf.set(text, [index])
      distinct.push(text)
    }
  }
  const known: Array<[string, string]> = []
  const unknown: string[] = []
  for (const text of distinct) {
    const found = memory?.get(text)
    if (found === undefined) unknown.push(text)
    else known.push([text, found])
  }
  const pace = paceOf(models)
  const batches = planBatches(
    unknown.map((text) => text.length),
    pace
  ).map((batch) => batch.map((k) => unknown[k]!))

  const total = { applied: 0, skipped: 0 }
  const put = async (pairs: ReadonlyArray<readonly [string, string]>): Promise<void> => {
    const positions: number[] = []
    const texts: string[] = []
    for (const [text, translation] of pairs) {
      for (const index of nodesOf.get(text)!) {
        positions.push(index)
        texts.push(translation)
      }
    }
    if (signal.aborted) throw stopped()
    const reply = await deps.apply(positions, texts)
    if (!reply) throw new Error('page')
    total.applied += reply.applied
    total.skipped += reply.skipped
  }

  // The batches under way listen to this one: a stop, a failure or the end gives up those that did not come back.
  const work = new AbortController()
  const giveUp = (): void => work.abort()
  signal.addEventListener('abort', giveUp, { once: true })
  const translateBatch = async (sent: readonly string[]): Promise<string[]> => {
    let texts = [...sent]
    for (const model of models) {
      const answer = checkReply(texts, await model.translate(texts, work.signal))
      if (!answer) throw new BadReply()
      texts = answer
    }
    return texts
  }
  try {
    if (signal.aborted) throw stopped()
    // Each batch's outcome is kept until its turn, when its failure is thrown: one that fails ahead of its turn is not an unhandled rejection, and a
    // batch given up because the pass ended first (a stop, an earlier failure, both already thrown) has nobody to tell.
    const underWay: Array<Promise<{ ok: true; texts: string[] } | { ok: false; error: unknown }>> = []
    const launch = (): void => {
      underWay.push(
        translateBatch(batches[underWay.length]!).then(
          (texts) => ({ ok: true as const, texts }),
          (error: unknown) => ({ ok: false as const, error })
        )
      )
    }
    while (underWay.length < Math.min(pace.inFlight, batches.length)) launch()
    if (known.length > 0) await put(known)
    for (let i = 0; i < batches.length; i++) {
      if (signal.aborted) throw stopped()
      const outcome = await underWay[i]!
      if (signal.aborted) throw stopped()
      if (!outcome.ok) throw outcome.error
      const translated = outcome.texts
      if (underWay.length < batches.length) launch()
      const pairs = batches[i]!.map((text, k) => [text, translated[k]!] as const)
      for (const [text, translation] of pairs) memory?.set(text, translation)
      await put(pairs)
    }
    if (signal.aborted) throw stopped()
    return total
  } finally {
    work.abort()
    signal.removeEventListener('abort', giveUp)
  }
}
