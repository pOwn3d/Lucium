// The iOS application (ios/) re-implements the Mac's rules for a name made from what a page says: the file name of a download, the number
// added to make it unique, and the name of a page saved as PDF. The two sides are held by one file of vectors, ios/Contracts/file-name-vectors.json:
// this suite runs it against the Mac's code, `swift test` (ios/LuciumKit) runs the same file against the Swift.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { suggestedFileName } from './file-names'
import { pdfFileName } from './pdf-source'
import { uniquePath } from '../main/engine/download-paths'

/** A text, or a text repeated (so that a long name does not fill the file of vectors). */
type Text = string | { repeat: string; times: number; prefix?: Text; suffix?: Text }

interface Vectors {
  suggested: { input: Text; expect: string | Text }[]
  unique: { name: string; taken: string[]; expect: string }[]
  pdfName: { title: Text; expect: Text }[]
}

function expand(text: Text | undefined): string {
  if (text === undefined) return ''
  if (typeof text === 'string') return text
  return `${expand(text.prefix)}${text.repeat.repeat(text.times)}${expand(text.suffix)}`
}

const vectors = JSON.parse(readFileSync(join(__dirname, '../../ios/Contracts/file-name-vectors.json'), 'utf8')) as Vectors
const label = (text: Text): string => {
  const out = expand(text)
  return out.length > 40 ? `${out.slice(0, 20)}… (${out.length} characters)` : JSON.stringify(out)
}

describe('iOS contract: file name vectors', () => {
  it('has vectors to run (an empty file would pass for nothing)', () => {
    expect(vectors.suggested.length).toBeGreaterThan(20)
    expect(vectors.unique.length).toBeGreaterThan(5)
    expect(vectors.pdfName.length).toBeGreaterThan(5)
  })

  it.each(vectors.suggested.map((v, index) => [index, label(v.input), v] as const))('suggestedFileName #%i %s', (_index, _label, vector) => {
    expect(suggestedFileName(expand(vector.input))).toBe(expand(vector.expect))
  })

  it.each(vectors.unique.map((v) => [v.name, v.taken.join(', ') || '(nothing)', v] as const))('uniquePath(%s) with %s taken', (_name, _taken, vector) => {
    // The Mac asks the disk and the list of paths promised to other downloads: here both are the list of the vector, compared without regard to case.
    const taken = new Set(vector.taken.map((name) => join('/d', name).toLowerCase()))
    const path = uniquePath('/d', vector.name, { has: (candidate) => taken.has(candidate.toLowerCase()) }, () => false)
    expect(path).toBe(join('/d', vector.expect))
  })

  it.each(vectors.pdfName.map((v, index) => [index, label(v.title), v] as const))('pdfFileName #%i %s', (_index, _label, vector) => {
    expect(pdfFileName(expand(vector.title))).toBe(expand(vector.expect))
  })
})
