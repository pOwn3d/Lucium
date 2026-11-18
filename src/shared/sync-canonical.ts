// The canonical form of a JSON value (docs/synchronisation.md §8.4, RFC 8785): the text whose SHA-256 is the digest both devices compare after a merge, and the
// text that settles a tie between two values the marks cannot tell apart (§9.2). It is written twice, here and in LuciumKit (`SyncCanonical.swift`), and held
// together by `canonical` in ios/Contracts/sync-message-vectors.json.
//
// Pure: no hashing here (`node:crypto` is not available to the renderer, which imports `src/shared/`), the main process hashes the text.

/** What a message can carry: the JSON values, numbers finite. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * Strings are compared by UTF-16 code unit, as JavaScript does and as RFC 8785 sorts keys: a character outside the Basic Multilingual Plane
 * (a surrogate pair, D800–DFFF) comes before U+E000–U+FFFF, which is not the order of the UTF-8 bytes. LuciumKit compares the same way.
 */
export function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The RFC 8785 text of a value: no space, object keys sorted by UTF-16 code unit, strings and numbers written as `JSON.stringify` writes them.
 * A number that is not finite has no JSON text and is refused (the message layer never lets one in: §7.1), and an `undefined` object member is left out
 * as `JSON.stringify` leaves it out. Throws a `TypeError` for anything else that is not JSON (a function, a symbol, a bigint, a cycle is not reached
 * because the depth of a message is bounded).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('a number that is not finite has no canonical form')
      return JSON.stringify(value)
    case 'string':
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`
      const object = value as Record<string, unknown>
      const members: string[] = []
      for (const key of Object.keys(object).sort()) {
        if (object[key] === undefined) continue
        members.push(`${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      }
      return `{${members.join(',')}}`
    }
    default:
      throw new TypeError(`a ${typeof value} has no canonical form`)
  }
}

/**
 * The same text for two values: the comparison of the merge ("did this field change?"). Two numbers, strings or booleans are compared as they are (the
 * common case, no text built); anything else by canonical text, so that the order of the keys of an object does not matter and a list is compared in order.
 * A value that is `undefined` is a field that is absent: equal to another absent field, to nothing else.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  return canonicalJson(a) === canonicalJson(b)
}
