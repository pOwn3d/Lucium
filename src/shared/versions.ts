// The order of dotted version numbers ("0.10.0" after "0.9.0"). One definition: the update check compares the
// version of a feed with the running one, and the folders of the store extensions ("1.2.10_0") are ordered on it. The Electron watch keeps its own order
// on parsed versions (main/electron-watch.ts): there a prerelease comes before its release, which this order does not look at.

const VERSION = /^v?(\d+(?:\.\d+){0,3})(?:[-+].*)?$/

/** Whether the text is such a version (blanks around it aside). */
export const isDottedVersion = (text: string): boolean => VERSION.test(text.trim())

/**
 * Dotted numeric versions ("0.1.0", "v1.2", up to four numbers; what follows a "-" or a "+" is not compared): 1 when `a` is newer than `b`, -1 when older,
 * 0 when equal or when either is not a version. A missing number counts as 0 ("1.2" is "1.2.0").
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string): number[] | null => {
    const m = VERSION.exec(v.trim())
    return m ? m[1]!.split('.').map(Number) : null
  }
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return 0
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0
    const y = right[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}
