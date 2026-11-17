// A small markdown reader for the summaries: titles, bullet and numbered lists, paragraphs, **bold** and *italic*. It only produces
// data (blocks and spans); the screen draws them as elements, so no HTML of the model is ever interpreted.

export type Span = { kind: 'text' | 'strong' | 'em'; text: string }
export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; spans: Span[] }
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'list'; ordered: boolean; items: Span[][] }
  | { kind: 'table'; header: Span[][]; rows: Span[][][] }

/** The inline marks of one line: **bold** and *italic*; everything else is plain text. */
export function spans(line: string): Span[] {
  const out: Span[] = []
  const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*/g
  let last = 0
  for (const match of line.matchAll(pattern)) {
    const at = match.index ?? 0
    if (at > last) out.push({ kind: 'text', text: line.slice(last, at) })
    if (match[1] !== undefined) out.push({ kind: 'strong', text: match[1] })
    else out.push({ kind: 'em', text: match[2] ?? '' })
    last = at + match[0].length
  }
  if (last < line.length) out.push({ kind: 'text', text: line.slice(last) })
  return out
}

/** The cells of a table row written as `| a | b |`, or null when the line is not one. */
const cells = (line: string): string[] | null => {
  if (!line.startsWith('|') || !line.endsWith('|') || line.length < 3) return null
  return line.slice(1, -1).split('|').map((cell) => cell.trim())
}

/** A table separator row: `|---|:---:|`. */
const isSeparator = (line: string): boolean => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line) && line.includes('-')

/** The blocks of a summary, in reading order. Blank lines separate blocks; a list is the run of its items. */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = []
  const lines = source.split('\n')
  // A table: a header row, the separator row, then the rows. Read first, so that its pipes are not taken for text.
  const tableAt = (index: number): number => {
    const head = cells(lines[index]?.trim() ?? '')
    if (!head || !isSeparator(lines[index + 1]?.trim() ?? '')) return 0
    let end = index + 2
    while (end < lines.length && cells(lines[end]!.trim())) end++
    return end - index
  }
  let paragraph: string[] = []
  let list: { ordered: boolean; items: Span[][] } | null = null
  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', spans: spans(paragraph.join(' ')) })
    paragraph = []
  }
  const flushList = () => {
    if (list) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items })
    list = null
  }
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!
    const span = tableAt(index)
    if (span > 0) {
      flushParagraph()
      flushList()
      const head = cells(lines[index]!.trim())!
      const rows = lines.slice(index + 2, index + span).map((row) => cells(row.trim())!.map((cell) => spans(cell)))
      blocks.push({ kind: 'table', header: head.map((cell) => spans(cell)), rows })
      index += span - 1
      continue
    }
    const line = raw.trim()
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    const bullet = /^[-*•]\s+(.*)$/.exec(line)
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line)
    if (line === '') {
      flushParagraph()
      flushList()
    } else if (heading) {
      flushParagraph()
      flushList()
      blocks.push({ kind: 'heading', level: heading[1]!.length as 1 | 2 | 3, spans: spans(heading[2]!) })
    } else if (bullet || numbered) {
      flushParagraph()
      const ordered = !bullet
      if (!list || list.ordered !== ordered) {
        flushList()
        list = { ordered, items: [] }
      }
      list.items.push(spans((bullet ?? numbered)![1]!))
    } else {
      flushList()
      paragraph.push(line)
    }
  }
  flushParagraph()
  flushList()
  return blocks
}

/** The plain text of a summary, for the clipboard: the marks taken out, the lines kept. */
export function plainText(source: string): string {
  return source.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
}
