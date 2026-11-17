import { describe, expect, it } from 'vitest'
import { TRANSLATE_LIMITS, isTranslatable, splitPadding } from './translate-local'
import { SAMPLE_CHARS, applyScript, extractScript, readApplyReply, readExtractReply, readSampleReply, restoreScript, sampleScript, type ExtractReply, type SampleReply } from './translate-page-script'
import { el, fakePage, text, type FakeBox } from './translate-test-support'

const prose = (value: string, box?: FakeBox) => text(value, box)

describe('the page scripts', () => {
  it('list the text of the page in reading order, without the spacing around it', async () => {
    const page = fakePage(el('BODY', [el('H1', [prose('Bonjour')]), el('P', [prose('  Le monde\n'), el('B', [prose('entier')]), prose(' est là.')])]), 'fr-FR')
    const listed = (await page.run(extractScript())) as ExtractReply
    expect(listed.nodes).toEqual(['Bonjour', 'Le monde', 'entier', 'est là.'])
    expect(listed.lang).toBe('fr-FR')
    expect(listed.more).toBe(false)
  })

  it('leave out what is not prose for a reader: code, fields, scripts, what says translate="no", editors, addresses, numbers', async () => {
    const page = fakePage(
      el('BODY', [
        prose('Un texte'),
        el('SCRIPT', [prose('var secret = "ne pas traduire"')]),
        el('STYLE', [prose('.a { color: red }')]),
        el('code', [prose('const x = 1')]),
        el('PRE', [prose('texte préformaté')]),
        el('TEXTAREA', [prose('brouillon')]),
        el('DIV', [prose('Marque déposée')], { attrs: { translate: 'no' } }),
        el('DIV', [prose('Ne pas traduire non plus')], { classes: ['notranslate'] }),
        el('DIV', [prose('Zone de saisie')], { editable: true }),
        el('svg', [prose('légende du dessin')]),
        prose('https://exemple.org/page'),
        prose('moi@exemple.org'),
        prose('12 345'),
        prose('x'),
        prose('Un autre texte')
      ])
    )
    expect(((await page.run(extractScript())) as ExtractReply).nodes).toEqual(['Un texte', 'Un autre texte'])
  })

  it('go into the shadow root an element opened, before its other children', async () => {
    const page = fakePage(el('BODY', [el('MY-CARD', [prose('Dans la lumière')], { shadow: [prose('Dans l’ombre')] })]))
    expect(((await page.run(extractScript())) as ExtractReply).nodes).toEqual(['Dans l’ombre', 'Dans la lumière'])
  })

  it('put the translation in the text node, with the spacing the page had', async () => {
    const body = el('BODY', [el('P', [prose('  Bonjour le monde\n')])])
    const page = fakePage(body)
    await page.run(extractScript())
    const answer = (await page.run(applyScript([0], ['Hello world']))) as { applied: number; skipped: number } | { error: 'state' }
    expect(answer).toEqual({ applied: 1, skipped: 0 })
    expect(page.texts()).toEqual(['  Hello world\n'])
  })

  it('put a translation in as text and never as markup', async () => {
    const page = fakePage(el('BODY', [el('P', [prose('Bonjour tout le monde')])]))
    await page.run(extractScript())
    await page.run(applyScript([0], ['<img src=x onerror=alert(1)> & "quoted" </script>']))
    // One text node, holding the characters as they are: no element was made.
    expect(page.body.childNodes[0]!.childNodes).toHaveLength(1)
    expect(page.texts()).toEqual(['<img src=x onerror=alert(1)> & "quoted" </script>'])
  })

  it('put the original back, and forget it all', async () => {
    const page = fakePage(el('BODY', [el('P', [prose(' Un deux '), prose('Trois quatre')])]))
    await page.run(extractScript())
    await page.run(applyScript([0, 1], ['One two', 'Three four']))
    expect(page.texts()).toEqual([' One two ', 'Three four'])
    expect(await page.run(restoreScript())).toEqual({ restored: 2 })
    expect(page.texts()).toEqual([' Un deux ', 'Trois quatre'])
    expect(page.world['__luciumTranslate']).toBeUndefined()
  })

  it('apply by batches, each translation at the position it names, in any order', async () => {
    const page = fakePage(el('BODY', [prose('Alpha un'), prose('Beta deux'), prose('Gamma trois'), prose('Delta quatre')]))
    await page.run(extractScript())
    expect(await page.run(applyScript([2, 0], ['G3', 'A1']))).toEqual({ applied: 2, skipped: 0 })
    expect(page.texts()).toEqual(['A1', 'Beta deux', 'G3', 'Delta quatre'])
    await page.run(applyScript([3, 1], ['D4', 'B2']))
    expect(page.texts()).toEqual(['A1', 'B2', 'G3', 'D4'])
    // The same node twice: the second finds the translation in it, not the original, and leaves it.
    await page.run(restoreScript())
    await page.run(extractScript())
    expect(await page.run(applyScript([1, 1], ['B2', 'X']))).toEqual({ applied: 1, skipped: 1 })
    expect(page.texts()).toEqual(['Alpha un', 'B2', 'Gamma trois', 'Delta quatre'])
  })

  // A text the page rewrote between reading and answering is the page's now: neither the translation nor the original of a stale read goes over it.
  it('leave alone a node the page changed since it was read, and a node that is gone', async () => {
    const changed = prose('Premier texte')
    const gone = prose('Deuxième texte')
    const page = fakePage(el('BODY', [changed, gone, prose('Troisième texte')]))
    await page.run(extractScript())
    changed.nodeValue = 'Le site a changé ceci'
    gone.isConnected = false
    expect(await page.run(applyScript([0, 1, 2], ['One', 'Two', 'Three']))).toEqual({ applied: 1, skipped: 2 })
    expect(page.texts()).toEqual(['Le site a changé ceci', 'Deuxième texte', 'Three'])
    // And on the way back: a node that shows what the page wrote since is left as the page has it.
    const rewritten = page.body.childNodes[2]!
    rewritten.nodeValue = 'Réécrit par la page'
    expect(await page.run(restoreScript())).toEqual({ restored: 0 })
    expect(rewritten.nodeValue).toBe('Réécrit par la page')
  })

  it('refuse an answer that does not fit what was read, and a page that was not read', async () => {
    const page = fakePage(el('BODY', [prose('Un texte'), prose('Deux textes')]))
    expect(await page.run(applyScript([0], ['x']))).toEqual({ error: 'state' })
    await page.run(extractScript())
    // A position past the list, before it, not a whole number, or not one for each text: nothing at all goes in.
    for (const positions of [[1, 2], [-1], [0.5], [NaN], [Infinity]]) expect(await page.run(applyScript(positions, ['x', 'y'].slice(0, positions.length))), JSON.stringify(positions)).toEqual({ error: 'state' })
    expect(await page.run(applyScript([0], ['x', 'y']))).toEqual({ error: 'state' })
    expect(await page.run(applyScript([0, 1], ['x']))).toEqual({ error: 'state' })
    expect(page.texts()).toEqual(['Un texte', 'Deux textes'])
  })

  it('do not read again a page that is translated: the original comes first', async () => {
    const page = fakePage(el('BODY', [prose('Un texte')]))
    await page.run(extractScript())
    await page.run(applyScript([0], ['A text']))
    expect(await page.run(extractScript())).toEqual({ error: 'translated' })
    await page.run(restoreScript())
    expect(((await page.run(extractScript())) as ExtractReply).nodes).toEqual(['Un texte'])
  })

  it('stop at the limits and say so', async () => {
    const many = Array.from({ length: TRANSLATE_LIMITS.nodes + 5 }, (_, i) => prose(`Texte numéro ${i}`))
    const listed = (await fakePage(el('BODY', many)).run(extractScript())) as ExtractReply
    expect(listed.nodes).toHaveLength(TRANSLATE_LIMITS.nodes)
    expect(listed.more).toBe(true)
    const piece = 'mot '.repeat(349).trim()
    const long = Array.from({ length: Math.ceil(TRANSLATE_LIMITS.totalChars / piece.length) + 20 }, () => prose(piece))
    const heavy = (await fakePage(el('BODY', long)).run(extractScript())) as ExtractReply
    expect(heavy.nodes.length * piece.length).toBeLessThanOrEqual(TRANSLATE_LIMITS.totalChars)
    expect(heavy.nodes.length).toBeLessThan(long.length)
    expect(heavy.more).toBe(true)
    // A single text longer than the limit is left out whole.
    const huge = (await fakePage(el('BODY', [prose('x '.repeat(TRANSLATE_LIMITS.nodeChars)), prose('Court texte')])).run(extractScript())) as ExtractReply
    expect(huge.nodes).toEqual(['Court texte'])
  })

  // Where each text is, so that the controller translates what is on screen first (shared/translate-local.ts `readingOrder`).
  it('say where each text is from the viewport: on screen, how far below or above, or not drawn', async () => {
    const page = fakePage(
      el('BODY', [
        prose('Tout en haut', { top: -900, height: 20 }),
        prose('Juste au-dessus', { top: -30, height: 20 }),
        prose('À l’écran', { top: 100, height: 20 }),
        prose('Coupé en bas', { top: 790, height: 20 }),
        prose('Plus bas', { top: 1300, height: 20 }),
        prose('Caché ici'),
        prose('Hors champ à droite', { top: 100, height: 20, left: 1500, width: 200 }),
        prose('Hors champ à gauche', { top: 100, height: 20, left: -400, width: 100 })
      ]),
      '',
      { width: 1200, height: 800 }
    )
    const listed = (await page.run(extractScript())) as ExtractReply
    expect(listed.nodes).toEqual(['Tout en haut', 'Juste au-dessus', 'À l’écran', 'Coupé en bas', 'Plus bas', 'Caché ici', 'Hors champ à droite', 'Hors champ à gauche'])
    expect(listed.offsets).toEqual([-880, -10, 0, 0, 500, null, 300, 300])
    // A page with no geometry (no window size): nothing is known, the page's order stands.
    const flat = (await fakePage(el('BODY', [prose('Un texte'), prose('Deux textes')])).run(extractScript())) as ExtractReply
    expect(flat.offsets).toEqual([null, null])
  })

  it('beyond the limits, keep the texts nearest the viewport (a long page read from its middle), in the page’s order, and say there is more', async () => {
    const count = TRANSLATE_LIMITS.nodes + 1000
    // A long page scrolled down: the viewport shows the texts 3 000 to 3 039 (20 pixels each, the viewport 800 high).
    const many = Array.from({ length: count }, (_, i) => prose(`Texte numéro ${i}`, { top: (i - 3000) * 20, height: 20 }))
    const listed = (await fakePage(el('BODY', many), '', { width: 1200, height: 800 }).run(extractScript())) as ExtractReply
    expect(listed.more).toBe(true)
    expect(listed.nodes).toHaveLength(TRANSLATE_LIMITS.nodes)
    // What is on screen is in, and what was left out is the farthest from it.
    for (const i of [3000, 3039, 1001, 4999 - 1]) expect(listed.nodes, String(i)).toContain(`Texte numéro ${i}`)
    expect(listed.nodes).not.toContain('Texte numéro 0')
    const numbers = listed.nodes.map((node) => Number(node.split(' ').pop()))
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b))
    expect(listed.offsets!.filter((offset) => offset === 0)).toHaveLength(40)
    // The page's limits are kept: the script reads at most twice as far to choose.
    const beyond = Array.from({ length: TRANSLATE_LIMITS.scanNodes + 10 }, (_, i) => prose(`Texte numéro ${i}`))
    const scanned = (await fakePage(el('BODY', beyond)).run(extractScript())) as ExtractReply
    expect(scanned.nodes).toHaveLength(TRANSLATE_LIMITS.nodes)
    expect(scanned.nodes[0]).toBe('Texte numéro 0')
  })

  it('read a sample of the visible text and the declared language, and change nothing', async () => {
    const page = fakePage(el('BODY', [el('P', [prose('Bonjour tout le monde')])]), 'en')
    const sample = (await page.run(sampleScript())) as SampleReply
    expect(sample).toEqual({ lang: 'en', text: 'Bonjour tout le monde' })
    expect(page.world['__luciumTranslate']).toBeUndefined()
    const long = (await fakePage(el('BODY', [prose('a'.repeat(9000))])).run(sampleScript())) as SampleReply
    expect(long.text).toHaveLength(4000)
  })

  // The scripts repeat the rules of translate-local.ts; this is what keeps the two from drifting apart.
  it('choose the same texts as the rules of translate-local.ts', async () => {
    const samples = ['  Bonjour  ', 'x', '12', '12 345', 'ab', 'a b', 'https://exemple.org', 'www.exemple.org/page', 'a@b.fr', 'Écrit à moi@exemple.org', '…', '— —', 'Ça va ?', '日本語のテキスト', 'x '.repeat(TRANSLATE_LIMITS.nodeChars), '\n\t', '']
    const page = fakePage(el('BODY', samples.map((value) => prose(value))))
    const listed = ((await page.run(extractScript())) as ExtractReply).nodes
    const expected = samples.map((value) => splitPadding(value).core).filter((core) => isTranslatable(core))
    expect(listed).toEqual(expected)
  })
})

describe('what the main process takes of a reply of the page', () => {
  it('reads what the scripts answer as they answer it', async () => {
    const page = fakePage(el('BODY', [el('P', [prose('Le chat dort ici.')])]), 'fr-FR')
    expect(readSampleReply(await page.run(sampleScript()))).toEqual({ lang: 'fr-FR', text: expect.stringContaining('Le chat dort ici.') })
    const extracted = await page.run(extractScript())
    expect(readExtractReply(extracted)).toEqual(extracted)
    expect(readApplyReply(await page.run(applyScript([0], ['The cat sleeps here.'])))).toEqual({ applied: 1, skipped: 0 })
    // A page translated already refuses, and that refusal is read as one.
    expect(readExtractReply(await page.run(extractScript()))).toEqual({ error: 'translated' })
    expect(readApplyReply({ error: 'state' })).toBeNull()
  })

  it('takes a sample only as a text, cut to the length of a sample', () => {
    expect(readSampleReply({ lang: 'fr', text: 'a'.repeat(SAMPLE_CHARS + 500) })?.text).toHaveLength(SAMPLE_CHARS)
    expect(readSampleReply({ lang: { toString: () => 'fr' }, text: 'Bonjour' })).toEqual({ lang: '', text: 'Bonjour' })
    for (const raw of [null, undefined, 'text', 4, [], { text: 4 }, { text: { slice: () => 'x' } }, { lang: 'fr' }]) expect(readSampleReply(raw), JSON.stringify(raw)).toBeNull()
  })

  it('takes a list of texts only whole and within the limits of a page: a list cut here would not match the one the page keeps', () => {
    const ok = { lang: 'fr', nodes: ['Bonjour', 'le monde'], offsets: [0, null], more: false }
    expect(readExtractReply(ok)).toEqual(ok)
    expect(readExtractReply({ nodes: ['Bonjour'] })).toEqual({ lang: '', nodes: ['Bonjour'], more: false })
    expect(readExtractReply({ nodes: Array(TRANSLATE_LIMITS.nodes).fill('ab') })).toHaveProperty('nodes.length', TRANSLATE_LIMITS.nodes)
    for (const raw of [
      null,
      7,
      ['Bonjour'],
      { nodes: 'Bonjour' },
      { nodes: ['Bonjour', 7] },
      { nodes: [{ length: 3 }] },
      { nodes: Array(TRANSLATE_LIMITS.nodes + 1).fill('ab') },
      { nodes: ['a'.repeat(TRANSLATE_LIMITS.nodeChars + 1)] },
      { nodes: Array(Math.floor(TRANSLATE_LIMITS.totalChars / TRANSLATE_LIMITS.nodeChars) + 1).fill('a'.repeat(TRANSLATE_LIMITS.nodeChars)) },
      { error: 5 }
    ]) {
      expect(readExtractReply(raw), JSON.stringify(raw)?.slice(0, 60)).toBeNull()
    }
  })

  it('takes the counts of an application only as two counts', () => {
    for (const raw of [null, 5, 'done', [], {}, { applied: 1 }, { applied: '1', skipped: 0 }, { applied: -1, skipped: 0 }, { applied: 1.5, skipped: 0 }, { applied: 1, skipped: TRANSLATE_LIMITS.nodes + 1 }]) expect(readApplyReply(raw), JSON.stringify(raw)).toBeNull()
  })
})

