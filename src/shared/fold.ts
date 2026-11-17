// Folding a text for a search: decomposed (NFD), marks taken off, non-breaking spaces made ordinary, lower case. One implementation for every search of the application.
// The searches do not all fold alike, and making them alike would change what they find, so each one names what it folds:
// - `foldAccents`: the accents of U+0300–U+036F only (bookmarks, "Lire plus tard");
// - `foldAccentsAndQuotes`: the same, and the typographic apostrophes made straight (the command bar and what ranks with it, Settings, Fonctions,
//   the extensions page): « l’été » is found by "l'ete";
// - `foldMarks`: every combining mark (\p{M}), which also takes the vowel signs off the Indic scripts (notes, task manager, shortcuts).

const ACCENTS = /[̀-ͯ]/g
const MARKS = /\p{M}/gu
const QUOTES = /[’‘]/g
// The non-breaking spaces of a French label (« Page : ») are found by the ordinary space one types.
const NO_BREAK_SPACES = /[\u00a0\u202f]/g

/** "Été" → "ete". Only the combining diacritical marks (U+0300–U+036F) are taken off. */
export function foldAccents(text: string): string {
  return text.normalize('NFD').replace(ACCENTS, '').replace(NO_BREAK_SPACES, ' ').toLowerCase()
}

/** `foldAccents`, with the typographic apostrophes (’ ‘) made straight: « L’Été » → "l'ete". */
export function foldAccentsAndQuotes(text: string): string {
  return text.normalize('NFD').replace(ACCENTS, '').replace(QUOTES, "'").replace(NO_BREAK_SPACES, ' ').toLowerCase()
}

/** Every combining mark taken off (\p{M}), not only the accents: "Été" → "ete", and "हिंदी" loses its vowel signs. Apostrophes are kept. */
export function foldMarks(text: string): string {
  return text.normalize('NFD').replace(MARKS, '').replace(NO_BREAK_SPACES, ' ').toLowerCase()
}
