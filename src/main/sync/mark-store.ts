// `sync-marks.json`: the book of marks (marks.ts) kept next to state.json and never inside it. It holds hashes and marks, no address and no title. A file that cannot be
// read is moved aside and the book starts empty: every field then takes a mark of now, which is only a loss of the order of old changes, never of data.

import { existsSync } from 'node:fs'
import { replaceFileDurably } from '../durable-write'
import { readTextBounded, setAsideOrHold, DATA_FILE_MAX_BYTES } from '../persist'
import { MarkBook, MARKS_VERSION, type MarksFile } from './marks'

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The formats this version reads: the one it writes, and the 1 that had no Today tabs in it (a book of 1 is a book of 2 that admitted none). */
const READABLE_VERSIONS: readonly unknown[] = [1, MARKS_VERSION]

/** The file as a book, or throws on a file that is not one of this version's. The depth of what it holds is the one `MarkBook` writes: kind → id → field → mark. */
function parse(text: string, device: string): MarkBook {
  const raw: unknown = JSON.parse(text)
  if (!isObject(raw) || !READABLE_VERSIONS.includes(raw['version'])) throw new Error('not a marks file of this version')
  const clock = raw['clock']
  if (!isObject(clock) || !Number.isFinite(clock['ms']) || !Number.isFinite(clock['counter'])) throw new Error('no clock')
  for (const part of ['entities', 'tombstones', 'orders']) if (!isObject(raw[part])) throw new Error(`no ${part}`)
  return new MarkBook(device, raw as unknown as MarksFile)
}

export class MarkStore {
  constructor(private readonly path: string) {}

  load(device: string): MarkBook {
    if (!existsSync(this.path)) return new MarkBook(device)
    try {
      return parse(readTextBounded(this.path, DATA_FILE_MAX_BYTES), device)
    } catch (error) {
      setAsideOrHold(this.path, error, 'sync')
      return new MarkBook(device)
    }
  }

  save(book: MarkBook): void {
    replaceFileDurably(this.path, `${JSON.stringify(book)}\n`)
  }
}
