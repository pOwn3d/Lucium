// The spaces of French typography. The French catalogue is written with ordinary spaces, the way one types; this puts the non-breaking ones where
// the usage wants them, so that a line never starts with « ? », « : », « » » or a unit:
//   - a no-break space (U+00A0) before « : » and « % », and inside the quotation marks « … »;
//   - a narrow no-break space (U+202F) before « ; », « ! » and « ? », and between the thousands of a number (« 1 024 »);
//   - a no-break space between a number (or a variable) and its unit (« 30 s », « {size} Ko »).
// It runs on the text of the catalogue, before the variables are put in: what the user or a page wrote is never touched.

export const NBSP = ' '
export const NARROW_NBSP = ' '

// What may follow a high punctuation mark: a space, the end, or a closing mark. « !w » (a search shortcut) and « ::1 » (an address) are not punctuation.
const AFTER_MARK = String.raw`(?=$|[\s)\]»,.…])`
const BEFORE_COLON = new RegExp(String.raw` (?=:${AFTER_MARK})`, 'gm')
const BEFORE_NARROW = new RegExp(String.raw` (?=[;!?]+${AFTER_MARK})`, 'gm')
const BEFORE_PERCENT = /(?<=[\d}]) (?=%)/g
// A unit follows a number or a variable, and ends there: « {count} s’ouvrent » is not a count of seconds.
const BEFORE_UNIT = /(?<=[\d}]) (?=(?:h|min|s|ms|j|px|pt|o|Ko|Mo|Go|To)(?![\p{L}\p{N}’'{-]))/gu
const THOUSANDS = /(?<=\d) (?=\d{3}(?!\d))/g

/** `text` with the non-breaking spaces of French typography. Idempotent: a text that already has them comes back as it is. */
export function frenchSpaces(text: string): string {
  if (!text.includes(' ')) return text
  return text
    .replace(/« /g, `«${NBSP}`)
    .replace(/ »/g, `${NBSP}»`)
    .replace(BEFORE_COLON, NBSP)
    .replace(BEFORE_NARROW, NARROW_NBSP)
    .replace(BEFORE_PERCENT, NBSP)
    .replace(BEFORE_UNIT, NBSP)
    .replace(THOUSANDS, NARROW_NBSP)
}

/** `text` with every non-breaking space made an ordinary one: what a search compares, since nobody types a non-breaking space. */
export function plainSpaces(text: string): string {
  return text.replace(/[  ]/g, ' ')
}
