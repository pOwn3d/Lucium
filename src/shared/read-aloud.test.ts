import { describe, expect, it } from 'vitest'
import { TOOL_CHANNEL, parseToolMessage } from './page-tools'
import { SPEECH_CHUNK_MAX, SPEECH_TEXT_MAX, readerSpeechMarkup, readerSpeechScript, speakScript, speechChunks, speechLang, speechText, stopSpeakingScript } from './read-aloud'
import { isScriptNonce, policyWithScript, readerDocument, type ReaderArticle } from './reader'
import { setLanguage } from './i18n'

const NONCE = 'n-1'
const article: ReaderArticle = { title: 'Titre', content: '<p>Bonjour le monde.</p>', byline: null, siteName: null, lang: 'fr', dir: null, textLength: 300 }

describe('cutting a text for the voice', () => {
  it('keeps a short text in one piece, whitespace folded', () => {
    expect(speechChunks('  Bonjour\n le   monde.  ')).toEqual(['Bonjour le monde.'])
    expect(speechChunks('')).toEqual([])
    expect(speechChunks(' \n\t ')).toEqual([])
  })

  it('cuts a long text at the end of a sentence, in pieces that are never longer than the bound', () => {
    const sentence = 'Ceci est une phrase assez longue pour remplir une part de la ligne. '
    const text = sentence.repeat(30).trim()
    const chunks = speechChunks(text)
    expect(chunks.length).toBeGreaterThan(5)
    expect(chunks.every((chunk) => chunk.length <= SPEECH_CHUNK_MAX)).toBe(true)
    expect(chunks.slice(0, -1).every((chunk) => chunk.endsWith('.'))).toBe(true)
  })

  it('loses nothing and adds nothing: the pieces put back together are the text', () => {
    const text = Array.from({ length: 80 }, (_, i) => `Mot${i} suivi de quelques autres mots, puis une virgule`).join(' ')
    expect(speechChunks(text).join(' ')).toBe(text)
    const noSpace = 'x'.repeat(1000)
    expect(speechChunks(noSpace).join('')).toBe(noSpace)
  })

  it('cuts at a space when a sentence is longer than the bound, and anywhere when there is no space', () => {
    const words = Array.from({ length: 100 }, (_, i) => `mot${i}`).join(' ')
    expect(speechChunks(words).every((chunk) => chunk.length <= SPEECH_CHUNK_MAX && !chunk.startsWith(' ') && !chunk.endsWith(' '))).toBe(true)
    expect(speechChunks('y'.repeat(500)).map((chunk) => chunk.length)).toEqual([220, 220, 60])
  })

  it('is cut at the bound it is given', () => {
    expect(speechChunks('un deux trois quatre cinq six', 12).every((chunk) => chunk.length <= 12)).toBe(true)
  })

  it('reads at most the bound of a text', () => {
    expect(speechText('a '.repeat(SPEECH_TEXT_MAX)).length).toBeLessThanOrEqual(SPEECH_TEXT_MAX)
    expect(speechText('  a \n b ')).toBe('a b')
  })

  it('takes a language only if it looks like one (it comes from a page)', () => {
    expect(speechLang('fr')).toBe('fr')
    expect(speechLang('pt-BR')).toBe('pt-BR')
    for (const lang of ['', 'français', 'fr"; alert(1); "', "fr'", 'x'.repeat(30), 42, null, undefined]) expect(speechLang(lang), String(lang)).toBeNull()
  })
})

/** A voice: what `speechSynthesis` gives the scripts, with the end of each utterance fired by hand. */
function fakeVoice() {
  const spoken: Array<{ text: string; lang: string; onend: () => void; onerror: (event: { error: string }) => void }> = []
  const lines: string[] = []
  let cancels = 0
  class Utterance {
    lang = ''
    onend: () => void = () => {}
    onerror: (event: { error: string }) => void = () => {}
    constructor(readonly text: string) {}
  }
  const scope: Record<string, unknown> = {
    console: { debug: (line: string) => lines.push(line) },
    speechSynthesis: {
      speak: (utterance: Utterance) => spoken.push(utterance),
      cancel: () => {
        cancels++
      }
    },
    SpeechSynthesisUtterance: Utterance
  }
  scope['self'] = scope
  const evaluate = new Function('scope', 'script', 'with (scope) { return eval(script) }') as (scope: unknown, script: string) => unknown
  return { run: (script: string) => evaluate(scope, script), spoken, lines, cancels: () => cancels, reports: () => lines.map((line) => parseToolMessage(line, NONCE)) }
}

describe('the script that speaks', () => {
  it('speaks the pieces one after the other, each starting when the one before ended, and reports the end', () => {
    const voice = fakeVoice()
    voice.run(speakScript(['Un.', 'Deux.', 'Trois.'], 'fr', NONCE))
    expect(voice.spoken.map((u) => u.text)).toEqual(['Un.'])
    expect(voice.spoken[0]!.lang).toBe('fr')
    voice.spoken[0]!.onend()
    voice.spoken[1]!.onend()
    expect(voice.spoken.map((u) => u.text)).toEqual(['Un.', 'Deux.', 'Trois.'])
    expect(voice.reports()).toEqual([])
    voice.spoken[2]!.onend()
    expect(voice.reports()).toEqual([{ tool: 'speech', state: 'end' }])
  })

  it('stops a text that was being read when another one starts, and the old one does not go on', () => {
    const voice = fakeVoice()
    voice.run(speakScript(['A1.', 'A2.'], null, NONCE))
    const first = voice.spoken[0]!
    voice.run(speakScript(['B1.'], null, NONCE))
    expect(voice.cancels()).toBe(2)
    first.onend()
    expect(voice.spoken.map((u) => u.text)).toEqual(['A1.', 'B1.'])
  })

  it('stops for good when told to: the chain ends, and nothing is reported as an end', () => {
    const voice = fakeVoice()
    voice.run(speakScript(['A1.', 'A2.'], null, NONCE))
    const first = voice.spoken[0]!
    const before = voice.cancels()
    voice.run(stopSpeakingScript())
    expect(voice.cancels()).toBe(before + 1)
    first.onend()
    expect(voice.spoken).toHaveLength(1)
    expect(voice.reports()).toEqual([])
  })

  it('reports a failure of the voice, but a voice stopped on purpose is an end', () => {
    const failing = fakeVoice()
    failing.run(speakScript(['A.'], null, NONCE))
    failing.spoken[0]!.onerror({ error: 'synthesis-failed' })
    expect(failing.reports()).toEqual([{ tool: 'speech', state: 'error' }])
    const stopped = fakeVoice()
    stopped.run(speakScript(['A.'], null, NONCE))
    stopped.spoken[0]!.onerror({ error: 'interrupted' })
    expect(stopped.reports()).toEqual([{ tool: 'speech', state: 'end' }])
  })

  it('reports an error at once on a system without a voice', () => {
    const voice = fakeVoice()
    const scope: Record<string, unknown> = { console: { debug: (line: string) => voice.lines.push(line) } }
    scope['self'] = scope
    new Function('scope', 'script', 'with (scope) { return eval(script) }')(scope, speakScript(['A.'], null, NONCE))
    expect(voice.reports()).toEqual([{ tool: 'speech', state: 'error' }])
  })

  it('writes its line on the channel of the tools, signed with the secret of the page', () => {
    const voice = fakeVoice()
    voice.run(speakScript(['A.'], null, NONCE))
    voice.spoken[0]!.onend()
    expect(voice.lines).toEqual([`${TOOL_CHANNEL}${NONCE}:{"tool":"speech","state":"end"}`])
  })

  it('carries the text as data: a text that looks like code stays text', () => {
    const voice = fakeVoice()
    voice.run(speakScript(['"); self.hacked = 1; ("', '</script><script>x</script>'], 'fr', NONCE))
    expect(voice.spoken[0]!.text).toBe('"); self.hacked = 1; ("')
    voice.spoken[0]!.onend()
    expect(voice.spoken[1]!.text).toBe('</script><script>x</script>')
  })

  it('compiles in every shape it can take', () => {
    for (const script of [speakScript([], null, NONCE), speakScript(['a'], 'fr', NONCE), stopSpeakingScript(), readerSpeechScript()]) expect(() => new Function(script)).not.toThrow()
  })
})

describe('the reader with a voice', () => {
  it('has no script at all without it: the policy forbids every one, and the page has no button', () => {
    const html = readerDocument(article, 'https://example.org/a')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('script-src')
    expect(html).toContain("default-src 'none'")
    expect(html).not.toContain('listen-play')
  })

  it('has the buttons and one script, allowed by its nonce and no other, when the nonce is given', () => {
    const nonce = 'AbCdEfGhIjKlMnOpQrStUv=='
    const html = readerDocument(article, 'https://example.org/a', nonce)
    expect(html).toContain(readerSpeechMarkup())
    expect(html).toContain('<div class="listen" role="group" aria-label="Lecture à voix haute" hidden><button type="button" id="listen-play">Lire à voix haute</button>')
    expect(html).toContain(`script-src 'nonce-${nonce}'`)
    expect(html.match(/<script/g)).toHaveLength(1)
    expect(html).toContain(`<script nonce="${nonce}">`)
    // The rest of the policy is the same: no connection, no frame, no form, no base.
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("base-uri 'none'")
    expect(html).toContain("form-action 'none'")
    expect(html).not.toContain("'unsafe-inline'; script")
    expect(policyWithScript(nonce)).toBe(`default-src 'none'; img-src http: https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; script-src 'nonce-${nonce}'`)
  })

  it('puts the script after the article, so that nothing the article holds can come before it', () => {
    const html = readerDocument({ ...article, content: '<p>x</p><script>evil()</script>' }, 'https://example.org/a', 'AbCdEfGhIjKlMnOpQrStUv==')
    expect(html.indexOf('evil()')).toBeLessThan(html.indexOf('<script nonce='))
  })

  it('writes no nonce that could leave the attribute or the policy', () => {
    for (const nonce of ['"><script>x</script>', "x'; script-src *", 'short', 'a b c d e f g h i j k l m n o', 'x'.repeat(100), '', 7, null]) {
      const html = readerDocument(article, 'https://example.org/a', nonce as string)
      expect(html, String(nonce)).not.toContain('<script')
      expect(html, String(nonce)).not.toContain('script-src')
    }
    expect(isScriptNonce('AbCdEfGhIjKlMnOp')).toBe(true)
    expect(isScriptNonce('AbCdEfGhIjKlMn"')).toBe(false)
  })

  it('takes a nonce of 16 to 64 characters, and not one character shorter or longer: a short one is easier to guess', () => {
    expect(isScriptNonce('A'.repeat(15))).toBe(false)
    expect(isScriptNonce('A'.repeat(16))).toBe(true)
    expect(isScriptNonce('A'.repeat(64))).toBe(true)
    expect(isScriptNonce('A'.repeat(65))).toBe(false)
  })
})

/** The reader's page as its script sees it: the box of the buttons, the four elements it drives, the article and a voice that can pause. */
function fakeReader(articleText: string) {
  const element = () => {
    const listeners: Record<string, () => void> = {}
    return { hidden: true, textContent: '', listeners, addEventListener: (type: string, listener: () => void) => void (listeners[type] = listener) }
  }
  const box = element()
  const parts: Record<string, ReturnType<typeof element>> = { 'listen-play': element(), 'listen-pause': element(), 'listen-stop': element(), 'listen-note': element() }
  const spoken: Array<{ text: string; onend: () => void; onerror: (event: { error: string }) => void }> = []
  class Utterance {
    lang = ''
    onend: () => void = () => {}
    onerror: (event: { error: string }) => void = () => {}
    constructor(readonly text: string) {}
  }
  const synth = { paused: false, speak: (u: Utterance) => void spoken.push(u), cancel: () => {}, pause: () => void (synth.paused = true), resume: () => void (synth.paused = false) }
  const scope: Record<string, unknown> = {
    window: { speechSynthesis: synth },
    document: {
      querySelector: (selector: string) => (selector === '.listen' ? box : selector === 'article' ? { innerText: articleText } : null),
      getElementById: (id: string) => parts[id] ?? null,
      documentElement: { lang: 'en' },
      body: { innerText: articleText }
    },
    getSelection: () => '',
    addEventListener: () => {},
    SpeechSynthesisUtterance: Utterance
  }
  new Function('scope', 'script', 'with (scope) { return eval(script) }')(scope, readerSpeechScript())
  const click = (id: string) => parts[id]!.listeners['click']!()
  return { box, parts, spoken, click }
}

describe('the buttons of the reader, in the language of the interface', () => {
  it('are labelled, and written by the script, in English with English chosen', () => {
    setLanguage('en')
    try {
      const markup = readerSpeechMarkup()
      expect(markup).toContain('aria-label="Reading aloud"')
      expect(markup).toContain('>Read aloud</button>')
      expect(markup).toContain('id="listen-pause" hidden>Pause</button>')
      expect(markup).toContain('id="listen-stop" hidden>Stop</button>')

      const empty = fakeReader('   ')
      expect(empty.box.hidden).toBe(false)
      empty.click('listen-play')
      expect(empty.parts['listen-note']!.textContent).toBe('Nothing to read.')

      const reader = fakeReader('Hello world.')
      reader.click('listen-play')
      expect(reader.spoken.map((u) => u.text)).toEqual(['Hello world.'])
      expect(reader.parts['listen-pause']!.textContent).toBe('Pause')
      reader.click('listen-pause')
      expect(reader.parts['listen-pause']!.textContent).toBe('Resume')
      reader.spoken[0]!.onerror({ error: 'synthesis-failed' })
      expect(reader.parts['listen-note']!.textContent).toBe('The system voice couldn’t read this text.')
      expect(reader.parts['listen-play']!.hidden).toBe(false)
    } finally {
      setLanguage('fr')
    }
  })

  it('say "Reprendre" in French once paused, as they always did', () => {
    const reader = fakeReader('Bonjour le monde.')
    reader.click('listen-play')
    reader.click('listen-pause')
    expect(reader.parts['listen-pause']!.textContent).toBe('Reprendre')
  })
})
