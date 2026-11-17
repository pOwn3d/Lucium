// Reading aloud (the reader mode reads the article out): the voices are the system's, reached through the web's own
// `speechSynthesis`, so nothing is sent anywhere and nothing is installed. Two places use it: the buttons of the reader mode (a script of
// the reader's page, allowed by a nonce its Content-Security-Policy names), and the page's menu on a text selection (a script run in the
// page's isolated world, whose end it reports on the console channel of page-tools.ts). Pure here: how a text is cut for the voice, and
// the scripts that speak it.

import { toolPreamble } from './page-tools'
import { escapeHtml } from './error-pages'
import { t } from './i18n'

/**
 * Chromium's voice stops in the middle of a long utterance (a few hundred characters, on some voices a quarter of a minute), so the text is
 * spoken a sentence or two at a time, each starting when the one before ended.
 */
export const SPEECH_CHUNK_MAX = 220
/** More than this is not read: an article is a few tens of thousands of characters, and the list of chunks goes into a script. */
export const SPEECH_TEXT_MAX = 200_000

/**
 * The text cut in pieces of at most `max` characters, at the end of a sentence when there is one, else at a space, else anywhere. Whitespace
 * is folded; nothing is lost, and nothing is added. Self-contained: the reader's script is built from this function's source.
 */
export function speechChunks(text: string, max = 220): string[] {
  const words = text.replace(/\s+/g, ' ').trim()
  if (words === '') return []
  const chunks: string[] = []
  let rest = words
  while (rest.length > max) {
    const window = rest.slice(0, max + 1)
    let cut = -1
    for (const end of ['. ', '! ', '? ', '… ', '; ', ': ']) cut = Math.max(cut, window.lastIndexOf(end) + end.length - 1)
    if (cut < max / 4) cut = window.lastIndexOf(' ')
    if (cut < max / 4) cut = max
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest !== '') chunks.push(rest)
  return chunks.filter((chunk) => chunk !== '')
}

/** A language tag a voice can be asked for ("fr", "pt-BR"), or null: it comes from a page. */
export function speechLang(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(value) ? value : null
}

/** The text of a selection or an article, ready to be spoken: cut at the bound. */
export const speechText = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, SPEECH_TEXT_MAX)

/** The script that speaks the chunks in the page's world and reports the end on the console channel. */
export function speakScript(chunks: readonly string[], lang: string | null, nonce: string): string {
  return `(function () {
  'use strict';
  ${toolPreamble(nonce)}
  const synth = self.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance !== 'function') { report({ tool: 'speech', state: 'error' }); return; }
  const chunks = ${JSON.stringify(chunks)};
  // A text read already is replaced; the end of the old one must not start the new one's next chunk.
  const turn = (tools.speechTurn = (tools.speechTurn || 0) + 1);
  synth.cancel();
  let index = 0;
  const next = () => {
    if (tools.speechTurn !== turn) return;
    if (index >= chunks.length) { report({ tool: 'speech', state: 'end' }); return; }
    const utterance = new SpeechSynthesisUtterance(chunks[index++]);
    ${lang ? `utterance.lang = ${JSON.stringify(lang)};` : ''}
    utterance.onend = next;
    utterance.onerror = (event) => {
      if (tools.speechTurn !== turn) return;
      // A voice stopped on purpose is no failure.
      report({ tool: 'speech', state: event.error === 'canceled' || event.error === 'interrupted' ? 'end' : 'error' });
    };
    synth.speak(utterance);
  };
  next();
})()`
}

/** Stops the voice, and the chain of chunks with it. */
export const stopSpeakingScript = (): string =>
  `(function () { const tools = (self.__lucium_tools = self.__lucium_tools || {}); tools.speechTurn = (tools.speechTurn || 0) + 1; if (self.speechSynthesis) self.speechSynthesis.cancel() })()`

// ---------- the reader's buttons ----------

/**
 * The buttons of the reader's header, shown only when reading aloud is on: the script of the page fills in what they do. Built when the
 * reader's page is, so that its words are those of the language of the interface at that moment.
 */
export function readerSpeechMarkup(): string {
  const word = (key: Parameters<typeof t>[0]): string => escapeHtml(t(key))
  return (
    `<div class="listen" role="group" aria-label="${word('read-aloud.lecture-a-voix-haute')}" hidden>` +
    `<button type="button" id="listen-play">${word('read-aloud.lire-a-voix-haute')}</button>` +
    `<button type="button" id="listen-pause" hidden>${word('read-aloud.pause')}</button>` +
    `<button type="button" id="listen-stop" hidden>${word('read-aloud.arreter')}</button>` +
    '<span id="listen-note" role="status"></span>' +
    '</div>'
  )
}

/** A text of the catalogue as a literal of the reader's script: quoted by JSON, and no `<` that could close the script element around it. */
const scriptString = (text: string): string => JSON.stringify(text).replace(/</g, '\\u003c')

export const READER_SPEECH_STYLE = `
.listen{margin-top:14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font:13px -apple-system,system-ui,sans-serif}
.listen button{font:inherit;padding:5px 12px;border-radius:7px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
.listen button:hover{background:var(--code)}
.listen #listen-note{color:var(--muted)}
`

/**
 * The script of the reader's page. It runs under a nonce of the document's policy, with nothing but the article in the page: the buttons
 * read the selection if there is one, else the whole article. `chunk` is `speechChunks`, carried as source.
 */
export function readerSpeechScript(): string {
  return `(function () {
  'use strict';
  const synth = window.speechSynthesis;
  const box = document.querySelector('.listen');
  if (!box || !synth || typeof SpeechSynthesisUtterance !== 'function') return;
  box.hidden = false;
  const chunk = ${speechChunks.toString()};
  const play = document.getElementById('listen-play');
  const pause = document.getElementById('listen-pause');
  const stop = document.getElementById('listen-stop');
  const note = document.getElementById('listen-note');
  const lang = document.documentElement.lang || '';
  // The words the script writes itself, in the language of the interface when the page was built.
  const PAUSE = ${scriptString(t('read-aloud.pause'))};
  const RESUME = ${scriptString(t('read-aloud.reprendre'))};
  const NOTHING = ${scriptString(t('read-aloud.rien-a-lire'))};
  const FAILED = ${scriptString(t('read-aloud.la-voix-du-systeme-n-a-pas-pu-lire-ce-texte'))};
  let turn = 0;
  const show = (state) => {
    play.hidden = state !== 'idle';
    pause.hidden = state === 'idle';
    stop.hidden = state === 'idle';
    pause.textContent = state === 'paused' ? RESUME : PAUSE;
  };
  const end = (message) => { turn += 1; show('idle'); note.textContent = message || ''; };
  const text = () => {
    const selected = String(getSelection() || '').trim();
    return selected !== '' ? selected : (document.querySelector('article') || document.body).innerText;
  };
  play.addEventListener('click', () => {
    const chunks = chunk(text().slice(0, ${200_000}));
    if (chunks.length === 0) { note.textContent = NOTHING; return; }
    synth.cancel();
    const mine = (turn += 1);
    let index = 0;
    note.textContent = '';
    show('playing');
    const next = () => {
      if (turn !== mine) return;
      if (index >= chunks.length) { end(''); return; }
      const utterance = new SpeechSynthesisUtterance(chunks[index++]);
      if (lang) utterance.lang = lang;
      utterance.onend = next;
      utterance.onerror = (event) => {
        if (turn !== mine) return;
        end(event.error === 'canceled' || event.error === 'interrupted' ? '' : FAILED);
      };
      synth.speak(utterance);
    };
    next();
  });
  pause.addEventListener('click', () => {
    if (synth.paused) { synth.resume(); show('playing'); } else { synth.pause(); show('paused'); }
  });
  stop.addEventListener('click', () => { synth.cancel(); end(''); });
  // The reader goes away with its page: the voice must not go on reading what is no longer shown.
  addEventListener('pagehide', () => synth.cancel());
})()`
}
