// The floating pill of the reader: the settings of the reading (font, size of the text, width of the column, background),
// how far the reader has got, and a way out, on a pill at the foot of the article and a line at the top of the page. The choices are kept from one article to the next
// (reader-mode.ts keeps them for the session). Pure here: the choices and their checks, the markup, the style and the script of the page, and what the page tells the shell.
//
// The page is the reader's cover (reader.ts): its policy forbids every script but the one a nonce names, so the pill only exists with that nonce. The page tells the
// shell by setting its title to `<nonce>:<message>` (the shell hears `page-title-updated`): the nonce is drawn for the document and is known to this script only, so a title
// the article itself brings (the first one the shell hears) is never taken for a message.

import { escapeHtml } from './error-pages'
import { t } from './i18n'

/** `readable` is a stack of faces the system already has (wide letters, open shapes); no font file is shipped. */
export const READER_FONTS = ['serif', 'sans', 'readable'] as const
export const READER_WIDTHS = ['narrow', 'normal', 'wide'] as const
/** `auto` follows the system (light or dark), as the reader always did. */
export const READER_THEMES = ['auto', 'light', 'sepia', 'night', 'contrast', 'gray'] as const
/** Line height, letter spacing and word spacing: three steps each, the first being the reader's own. */
export const READER_LEVELS = ['normal', 'wide', 'wider'] as const
/** How many lines stay lit around the pointer (0: the focus is off). */
export const READER_FOCUS = [0, 1, 3, 5] as const
/** Steps of 2 px around the 20 px of the text. */
export const READER_SIZE_MIN = -2
export const READER_SIZE_MAX = 3

export interface ReaderPrefs {
  font: (typeof READER_FONTS)[number]
  size: number
  width: (typeof READER_WIDTHS)[number]
  theme: (typeof READER_THEMES)[number]
  lineHeight: (typeof READER_LEVELS)[number]
  letters: (typeof READER_LEVELS)[number]
  words: (typeof READER_LEVELS)[number]
  focus: (typeof READER_FOCUS)[number]
}

export const DEFAULT_READER_PREFS: ReaderPrefs = { font: 'serif', size: 0, width: 'normal', theme: 'auto', lineHeight: 'normal', letters: 'normal', words: 'normal', focus: 0 }
/** What the assisted-reading button sets (readable font, airy lines, wider letters and words), and what it gives back when pressed again. */
export const ASSISTED_READER_PREFS = { font: 'readable', lineHeight: 'wider', letters: 'wide', words: 'wide' } as const

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value)

/** The choices as the page reports them, or null when it is not exactly that: nothing is guessed from a message. */
export function parseReaderPrefs(raw: unknown): ReaderPrefs | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Record<string, unknown>
  if (!oneOf(READER_FONTS, p['font']) || !oneOf(READER_WIDTHS, p['width']) || !oneOf(READER_THEMES, p['theme'])) return null
  if (!oneOf(READER_LEVELS, p['lineHeight']) || !oneOf(READER_LEVELS, p['letters']) || !oneOf(READER_LEVELS, p['words'])) return null
  const focus = READER_FOCUS.find((f) => f === p['focus'])
  if (focus === undefined) return null
  const size = p['size']
  if (typeof size !== 'number' || !Number.isInteger(size) || size < READER_SIZE_MIN || size > READER_SIZE_MAX) return null
  return { font: p['font'], size, width: p['width'], theme: p['theme'], lineHeight: p['lineHeight'], letters: p['letters'], words: p['words'], focus }
}

export type ReaderMessage = { kind: 'prefs'; prefs: ReaderPrefs } | { kind: 'quit' }

/** What a title of the page says to the shell: only `<nonce>:quit` or `<nonce>:<the choices as JSON>`; any other title (the article's own, a wrong nonce, broken JSON) is not a message. */
export function readerMessage(title: string, nonce: string): ReaderMessage | null {
  const prefix = `${nonce}:`
  if (!title.startsWith(prefix)) return null
  const body = title.slice(prefix.length)
  if (body === 'quit') return { kind: 'quit' }
  try {
    const prefs = parseReaderPrefs(JSON.parse(body))
    return prefs ? { kind: 'prefs', prefs } : null
  } catch {
    return null
  }
}

/** The attributes of `<html>` that carry the choices: the style of the page reads them. */
export const readerRootAttributes = (prefs: ReaderPrefs): string => ` data-font="${prefs.font}" data-width="${prefs.width}" data-theme="${prefs.theme}" data-lh="${prefs.lineHeight}" data-ls="${prefs.letters}" data-ws="${prefs.words}" data-focus="${prefs.focus}" style="--step:${prefs.size}"`

const GLYPH = 'viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'

/** The pill and the line of progress. The buttons say what they are by their `aria-label`; `aria-pressed` follows the choices (the script keeps it so). */
export function readerPillMarkup(prefs: ReaderPrefs): string {
  const pressed = (on: boolean): string => ` aria-pressed="${on}"`
  const label = (key: Parameters<typeof t>[0]): string => escapeHtml(t(key))
  const choice = (k: 'font' | 'width' | 'theme', v: string, name: Parameters<typeof t>[0], inner: string, cls = ''): string =>
    `<button type="button" data-k="${k}" data-v="${v}"${cls ? ` class="${cls}"` : ''}${pressed(prefs[k] === v)} aria-label="${label(name)}" title="${label(name)}">${inner}</button>`
  const step = (s: -1 | 1, name: Parameters<typeof t>[0], inner: string): string => `<button type="button" data-k="size" data-s="${s}" aria-label="${label(name)}" title="${label(name)}">${inner}</button>`
  const divider = '<span class="div" aria-hidden="true"></span>'
  // A button that goes round its steps: `aria-pressed` says that it is on a step other than the first (the script keeps it so).
  const cycle = (k: 'lineHeight' | 'letters' | 'words' | 'focus', name: Parameters<typeof t>[0], inner: string): string =>
    `<button type="button" data-k="${k}" data-cycle="1" class="cy"${pressed(prefs[k] !== DEFAULT_READER_PREFS[k])} aria-label="${label(name)}" title="${label(name)}">${inner}<span class="lv" aria-hidden="true"></span></button>`
  const assisted = (Object.keys(ASSISTED_READER_PREFS) as (keyof typeof ASSISTED_READER_PREFS)[]).every((k) => prefs[k] === ASSISTED_READER_PREFS[k])
  return (
    `<div class="rbar" aria-hidden="true"></div><div class="rfocus" aria-hidden="true"><i class="rf-top"></i><i class="rf-bot"></i></div>` +
    `<div class="rp" role="toolbar" aria-label="${label('reader.reglages-de-lecture')}">` +
    choice('font', 'serif', 'reader.police-avec-empattements', 'Aa', 'serif') +
    choice('font', 'sans', 'reader.police-sans-empattement', 'Aa') +
    choice('font', 'readable', 'reader.police-lisible', 'Aa', 'readable') +
    divider +
    step(-1, 'reader.reduire-le-texte', 'A−') +
    step(1, 'reader.agrandir-le-texte', 'A+') +
    divider +
    choice('width', 'narrow', 'reader.colonne-etroite', `<svg ${GLYPH}><path d="M4 4v16M20 4v16M9 12h6"/><path d="m11 9-3 3 3 3M13 9l3 3-3 3"/></svg>`) +
    choice('width', 'normal', 'reader.colonne-normale', `<svg ${GLYPH}><path d="M4 4v16M20 4v16M8 12h8"/></svg>`) +
    choice('width', 'wide', 'reader.colonne-large', `<svg ${GLYPH}><path d="M4 4v16M20 4v16M7 12h10"/><path d="m10 9-3 3 3 3M14 9l3 3-3 3"/></svg>`) +
    divider +
    choice('theme', 'light', 'reader.fond-clair', '<span class="dot light"></span>') +
    choice('theme', 'sepia', 'reader.fond-sepia', '<span class="dot sepia"></span>') +
    choice('theme', 'night', 'reader.fond-sombre', '<span class="dot night"></span>') +
    choice('theme', 'gray', 'reader.fond-gris', '<span class="dot gray"></span>') +
    choice('theme', 'contrast', 'reader.fond-contraste', '<span class="dot contrast"></span>') +
    divider +
    cycle('lineHeight', 'reader.interligne', '≡') +
    cycle('letters', 'reader.espacement-des-lettres', 'A·A') +
    cycle('words', 'reader.espacement-des-mots', 'A A') +
    cycle('focus', 'reader.focus-de-ligne', '▭') +
    `<button type="button" data-k="assist"${pressed(assisted)} aria-label="${label('reader.lecture-assistee')}" title="${label('reader.lecture-assistee')}">Aa+</button>` +
    divider +
    `<span class="rp-hint" aria-hidden="true"></span>` +
    `<button type="button" data-k="quit" class="quit">${label('reader.quitter')} <kbd>${label('cmd.echap')}</kbd></button>` +
    `</div>`
  )
}

/** The look of the choices (the themes, the fonts, the widths, the size) and of the pill. The colours are the reader's own, like the rest of its page. */
export const READER_PILL_STYLE = `
html[data-theme=light]{color-scheme:light;--bg:#fbfbf9;--fg:#232323;--muted:#707070;--line:#dcdcd6;--link:#0a58c9;--quote:#c9c9c2;--code:#efefea}
html[data-theme=sepia]{color-scheme:light;--bg:#f4ecd8;--fg:#3a2f1f;--muted:#6a5c46;--line:#d9cdb0;--link:#8a4b08;--quote:#c9b996;--code:#ebe0c6}
html[data-theme=night]{color-scheme:dark;--bg:#1b1b1f;--fg:#e6e6ea;--muted:#9a9aa5;--line:#38383b;--link:#6aa7ff;--quote:#4a4a4e;--code:#2a2a2d}
html[data-theme=contrast]{color-scheme:dark;--bg:#000;--fg:#fff;--muted:#e6e6e6;--line:#fff;--link:#8fd8ff;--quote:#fff;--code:#141414}
html[data-theme=gray]{color-scheme:light;--bg:#d9d9db;--fg:#262628;--muted:#505055;--line:#b4b4b8;--link:#0b4fb0;--quote:#a4a4a9;--code:#cdcdd0}
html[data-font=readable] body{font-family:Verdana,Tahoma,"Trebuchet MS",system-ui,sans-serif}
html[data-lh=wide] body{line-height:1.9}html[data-lh=wider] body{line-height:2.25}
html[data-ls=wide] body{letter-spacing:.05em}html[data-ls=wider] body{letter-spacing:.1em}
html[data-ws=wide] body{word-spacing:.16em}html[data-ws=wider] body{word-spacing:.32em}
html[data-focus="0"] .rfocus{display:none}
.rfocus i{position:fixed;left:0;width:100%;background:rgb(0 0 0/.55);pointer-events:none;z-index:1}
.rf-top{top:0;height:var(--fy1,0)}.rf-bot{top:var(--fy2,100%);bottom:0}
@media (prefers-reduced-motion:no-preference){.rfocus i{transition:height .08s linear,top .08s linear}}
html[data-font=sans] body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif}
html[data-width=narrow] main{max-width:560px}
html[data-width=wide] main{max-width:860px}
body{font-size:calc(20px + var(--step,0) * 2px)}
.rbar{position:fixed;left:0;top:0;width:100%;height:3px;background:var(--link);transform:scaleX(0);transform-origin:left;z-index:2}
.rp{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2;display:flex;align-items:center;gap:4px;max-width:calc(100% - 24px);overflow-x:auto;padding:5px 6px;border-radius:999px;border:1px solid var(--line);background:color-mix(in srgb,var(--bg) 88%,var(--fg) 12%);box-shadow:0 8px 28px rgb(0 0 0/.18);color:var(--fg);font:12px/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;white-space:nowrap}
.rp button{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:28px;min-height:28px;padding:0 9px;border:0;border-radius:999px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.rp button:hover{background:color-mix(in srgb,var(--fg) 10%,transparent)}
.rp button:focus-visible{outline:2px solid var(--link);outline-offset:1px}
.rp button[aria-pressed=true]{background:var(--fg);color:var(--bg)}
.rp button.serif{font-family:Georgia,serif}
.rp .div{width:1px;height:18px;margin:0 3px;background:var(--line)}
.rp .dot{width:14px;height:14px;border-radius:50%;border:1px solid var(--line)}
.rp .dot.light{background:#fafaf9}.rp .dot.sepia{background:#f4ecd8}.rp .dot.night{background:#1b1b1f}.rp .dot.gray{background:#d9d9db}.rp .dot.contrast{background:#000;border-color:#fff}
.rp button.readable{font-family:Verdana,Tahoma,sans-serif}
.rp .lv{font-size:10px;min-width:8px;color:var(--muted)}
.rp button[aria-pressed=true] .lv{color:inherit}
.rp-hint{padding:0 8px;color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.rp .quit{border:1px solid var(--line)}
.rp kbd{font:inherit;font-size:11px;color:var(--muted)}
.rp button[aria-pressed=true] kbd{color:inherit}
`

/**
 * The script of the page. It applies a choice at once (the attributes of `<html>` and the pressed buttons), tells the shell the new choices or the wish to leave
 * (a title that begins with the nonce), and follows the scroll for the line and the figure of progress. `hintText` has `{percent}` in it.
 */
export function readerPillScript(nonce: string, prefs: ReaderPrefs, hintText: string): string {
  return `(function () {
  'use strict';
  const NONCE = ${JSON.stringify(nonce)};
  const HINT = ${JSON.stringify(hintText)};
  const root = document.documentElement;
  const pill = document.querySelector('.rp');
  const bar = document.querySelector('.rbar');
  const hint = document.querySelector('.rp-hint');
  if (!pill || !bar || !hint) return;
  const focusBox = document.querySelector('.rfocus');
  const LEVELS = ${JSON.stringify(READER_LEVELS)};
  const FOCUS = ${JSON.stringify(READER_FOCUS)};
  const ASSISTED = ${JSON.stringify(ASSISTED_READER_PREFS)};
  const OFF = ${JSON.stringify({ font: DEFAULT_READER_PREFS.font, lineHeight: 'normal', letters: 'normal', words: 'normal' })};
  const MARKS = ['', '+', '++'];
  let prefs = ${JSON.stringify(prefs)};
  let pointerY = null;
  const send = (text) => { document.title = NONCE + ':' + text; };
  const apply = () => {
    root.dataset.font = prefs.font;
    root.dataset.width = prefs.width;
    root.dataset.theme = prefs.theme;
    root.dataset.lh = prefs.lineHeight;
    root.dataset.ls = prefs.letters;
    root.dataset.ws = prefs.words;
    root.dataset.focus = String(prefs.focus);
    root.style.setProperty('--step', String(prefs.size));
    for (const button of pill.querySelectorAll('[data-k]')) {
      const k = button.dataset.k;
      if (k === 'font' || k === 'width' || k === 'theme') button.setAttribute('aria-pressed', String(prefs[k] === button.dataset.v));
      else if (button.dataset.cycle) {
        button.setAttribute('aria-pressed', String(k === 'focus' ? prefs.focus !== 0 : prefs[k] !== 'normal'));
        const mark = button.querySelector('.lv');
        if (mark) mark.textContent = k === 'focus' ? (prefs.focus === 0 ? '' : String(prefs.focus)) : MARKS[LEVELS.indexOf(prefs[k])];
      } else if (k === 'assist') button.setAttribute('aria-pressed', String(Object.keys(ASSISTED).every((key) => prefs[key] === ASSISTED[key])));
    }
    lightLines();
  };
  // The lines kept lit: a band of N lines around the pointer (the middle of the window until it moves); the rest of the window is dimmed.
  const lightLines = () => {
    if (!focusBox || prefs.focus === 0) return;
    const line = parseFloat(getComputedStyle(document.body).lineHeight) || 32;
    const band = line * prefs.focus;
    const centre = pointerY === null ? root.clientHeight / 2 : pointerY;
    const top = Math.max(0, Math.min(root.clientHeight - band, centre - band / 2));
    root.style.setProperty('--fy1', top + 'px');
    root.style.setProperty('--fy2', (top + band) + 'px');
  };
  addEventListener('pointermove', (event) => { pointerY = event.clientY; lightLines(); }, { passive: true });
  pill.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-k]') : null;
    if (!button) return;
    const k = button.dataset.k;
    if (k === 'quit') { send('quit'); return; }
    if (k === 'size') prefs = Object.assign({}, prefs, { size: Math.max(${READER_SIZE_MIN}, Math.min(${READER_SIZE_MAX}, prefs.size + Number(button.dataset.s))) });
    else if (button.dataset.cycle) prefs = Object.assign({}, prefs, { [k]: k === 'focus' ? FOCUS[(FOCUS.indexOf(prefs.focus) + 1) % FOCUS.length] : LEVELS[(LEVELS.indexOf(prefs[k]) + 1) % LEVELS.length] });
    else if (k === 'assist') prefs = Object.assign({}, prefs, Object.keys(ASSISTED).every((key) => prefs[key] === ASSISTED[key]) ? OFF : ASSISTED);
    else if (k === 'theme') prefs = Object.assign({}, prefs, { theme: prefs.theme === button.dataset.v ? 'auto' : button.dataset.v });
    else prefs = Object.assign({}, prefs, { [k]: button.dataset.v });
    apply();
    send(JSON.stringify(prefs));
  });
  const progress = () => {
    const room = root.scrollHeight - root.clientHeight;
    const done = room > 0 ? Math.min(1, Math.max(0, root.scrollTop / room)) : 1;
    bar.style.transform = 'scaleX(' + done + ')';
    hint.textContent = HINT.replace('{percent}', String(Math.round(done * 100)));
  };
  addEventListener('scroll', progress, { passive: true });
  addEventListener('resize', () => { progress(); lightLines(); });
  apply();
  progress();
})();`
}
