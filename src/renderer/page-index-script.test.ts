// @vitest-environment happy-dom
// The script that reads a page for the full-text index, run on real documents: what a person typed is never in the text, and a page with a password
// or card field gives no text at all.

import { beforeEach, describe, expect, it } from 'vitest'
import { PAGE_INDEX_SCRIPT } from '@shared/page-index'

const read = (html: string): unknown => {
  document.body.innerHTML = html
  return (0, eval)(PAGE_INDEX_SCRIPT)
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('PAGE_INDEX_SCRIPT', () => {
  it('reads the visible text of the page', () => {
    expect(read('<main><h1>Tarte Tatin</h1><p>Des pommes caramélisées</p></main>')).toContain('Des pommes caramélisées')
  })

  it('leaves out scripts, styles, fields, editable zones and frames', () => {
    const text = String(
      read(
        '<p>Texte visible</p><script>var secret1 = 1</script><style>.secret2{}</style><noscript>secret3</noscript>' +
          '<input type="text" value="secret4"><textarea>secret5</textarea><select><option>secret6</option></select>' +
          '<div contenteditable="true">secret7</div><iframe srcdoc="secret8"></iframe><svg><text>secret9</text></svg>'
      )
    )
    expect(text).toContain('Texte visible')
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) expect(text, `secret${n}`).not.toContain(`secret${n}`)
  })

  it('gives nothing for a page with a password field or a card field', () => {
    expect(read('<p>Connexion</p><input type="password">')).toBeNull()
    expect(read('<p>Paiement</p><input type="text" autocomplete="cc-number">')).toBeNull()
  })

  it('does not change the page it reads', () => {
    read('<p>Texte</p><input type="text" value="x">')
    expect(document.querySelector('input')).not.toBeNull()
  })
})
