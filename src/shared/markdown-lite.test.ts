// The model's answer is read as data: a tag in it stays text, in every place a summary puts text (paragraphs, titles, list items, table cells).
// markdown-lite only makes spans of text, strong and em; the escaping of the summary page is tested in summary-html.escape.test.ts.
import { describe, expect, it } from 'vitest'
import { parseMarkdown, spans, type Block, type Span } from './markdown-lite'

const TAG = '<img src=x onerror="alert(1)"><b>gras</b><script>run()</script>'

/** The text of every span of a block, in order: what a reader sees, with no tag made of it. */
function textOf(blocks: Block[]): string[] {
  const all = (runs: Span[]) => runs.map((run) => run.text)
  return blocks.flatMap((block) => {
    if (block.kind === 'table') return [...block.header.flatMap(all), ...block.rows.flatMap((row) => row.flatMap(all))]
    if (block.kind === 'list') return block.items.flatMap(all)
    return all(block.spans)
  })
}

describe('the answer of the model is never read as HTML', () => {
  it('keeps a tag in a line of text as text', () => {
    expect(spans(TAG)).toEqual([{ kind: 'text', text: TAG }])
  })

  it('keeps a tag in a paragraph, a title, a list item and a table cell as text', () => {
    const source = [`${TAG} **point**`, '', `## ${TAG}`, '', `- ${TAG}`, '', `| ${TAG} | b |`, '| --- | --- |', `| ${TAG} | *x* |`].join('\n')
    const blocks = parseMarkdown(source)
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'heading', 'list', 'table'])
    // Each of these places holds the tag whole, as the text it is.
    expect(textOf(blocks).filter((text) => text === TAG)).toHaveLength(4)
  })

  it('makes of a tag only the spans it has, never a new kind of run', () => {
    const kinds = new Set(parseMarkdown(`${TAG} **a** *b*`).flatMap((block) => (block.kind === 'table' ? [] : block.kind === 'list' ? block.items.flat() : block.spans)).map((run) => run.kind))
    expect([...kinds].sort()).toEqual(['em', 'strong', 'text'])
  })

  it('leaves the marks of a line as marks, and a tag inside a mark as text of that mark', () => {
    expect(spans(`**${TAG}**`)).toEqual([{ kind: 'strong', text: TAG }])
  })
})
