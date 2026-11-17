// A guard for regular expressions that come from outside the application (the `regexFilter` of an extension's request rule, shared/net-rules.ts).
// Those are written for RE2, which reads a text in a time proportional to its length whatever the expression. The engine of JavaScript goes back
// over its choices instead: an expression in which one text can be cut in many ways (`(a+)+`, `(a|aa)*`, `(a?b?)+`) takes a time that doubles
// with each character of an address that almost matches, and a page chooses the addresses it asks for. One such rule would stop the main process.
//
// `regexHazard` reads the expression without running it and names what makes it dangerous, or answers null. It refuses:
//  - a look-around and a back-reference: RE2 has neither, so the platform refuses the rule too;
//  - a repeated group in which a text can be cut in several ways. A repeated group is let through only in the shapes whose cut is unique:
//    parts of a fixed length (`(ab)+`, `([0-9]{2}:)*`), runs each closed by a character they cannot hold (`([a-z0-9-]+\.)*`, `(/[^/]+)+`,
//    `(\w+=[^&]*&)*`), or a choice between fixed parts that start differently (`(%20|\+)+`).
// It is stricter than needed (a safe expression of another shape is refused).
//
// What it lets through can still be slow without doubling: runs one after the other (`a.*b.*c.*d`) are tried in every combination of places,
// which costs a power of the length of the text, one degree per run. `regexTextLimit` counts those degrees and answers the longest text the
// expression may be run on for the work to stay under `REGEX_STEP_BUDGET`: the caller runs it on nothing longer (net-rules.ts). It is an
// estimate of the worst case, on the safe side, and not a proof.

interface Atom {
  kind: 'literal' | 'class' | 'group' | 'other'
  /** The text of the atom in the expression, without its quantifier. */
  source: string
  /** The character a literal stands for. */
  char?: string
  min: number
  max: number
  /** How many open runs the atom holds: places the engine comes back to, one by one, over the whole text, each letting it go on from there. */
  opens: number
  /** The power of the length of the text the atom costs alone. */
  degree: number
  /** In how many ways, at most a few, the atom can be read at one place (`a?`, `a{2,4}`, a choice between parts that can start the same way). */
  ways: number
}

interface Frame {
  /** The parts of the group between its `|`. */
  branches: Atom[][]
  /** Something inside, at any depth, repeats without a bound. */
  unbounded: boolean
}

const CLASS_ESCAPES = new Set(['d', 'D', 'w', 'W', 's', 'S'])
/** Escapes that stand for a character this file does not work out (`\n`, `\x41`, `é`…), and the word boundaries. */
const OTHER_ESCAPES = new Set(['b', 'B', 'n', 'r', 't', 'f', 'v', '0', 'c', 'x', 'u', 'p', 'P'])

const fixed = (atom: Atom): boolean => (atom.kind === 'literal' || atom.kind === 'class') && atom.min === atom.max

/** Whether the atom can match the character: asked of the engine itself, on one character. */
function matches(atom: Atom, char: string): boolean {
  if (atom.kind === 'literal') return atom.char?.toLowerCase() === char.toLowerCase()
  try {
    return new RegExp(`^(?:${atom.source})$`, 'i').test(char)
  } catch {
    // A class the engine does not read: it is held to match everything, so that no shape is let through on its account.
    return true
  }
}

/** Whether no text can start both atoms. Known only when one of them is a single character. */
function startDifferently(a: Atom, b: Atom): boolean {
  if (a.kind === 'literal' && a.char !== undefined) return (b.kind === 'literal' || b.kind === 'class') && !matches(b, a.char)
  if (b.kind === 'literal' && b.char !== undefined) return a.kind === 'class' && !matches(a, b.char)
  return false
}

/** What makes a group dangerous to repeat, or null when a text it matches can be cut in one way only. */
function repeatHazard(frame: Frame): string | null {
  if (frame.branches.length > 1) {
    const firsts: Atom[] = []
    for (const branch of frame.branches) {
      const first = branch[0]
      if (!first || !branch.every((atom) => fixed(atom) && atom.max === 1)) return 'a repeated choice between parts that are not of a fixed length'
      if (firsts.some((other) => !startDifferently(other, first))) return 'a repeated choice between parts that can start the same way'
      firsts.push(first)
    }
    return null
  }
  const branch = frame.branches[0] ?? []
  // Every part is a character or a class, and each one of a length that varies (a run) is followed by a character it cannot hold, which is
  // always there: the run ends at the first such character, nowhere else. The part after the last one is the first of the next turn.
  const unique = branch.every((atom, index) => {
    if (atom.kind !== 'literal' && atom.kind !== 'class') return false
    if (fixed(atom)) return true
    const stop = branch[(index + 1) % branch.length] as Atom
    return stop !== atom && stop.kind === 'literal' && stop.char !== undefined && fixed(stop) && stop.min >= 1 && !matches(atom, stop.char)
  })
  if (unique) return null
  return frame.unbounded ? 'a repetition inside a repetition' : 'a repeated group whose parts are optional or of several lengths'
}

/** The quantifier that starts at `at` (`*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`, each with an optional `?`), or null. */
function quantifierAt(source: string, at: number): { min: number; max: number; end: number } | null {
  const char = source[at]
  let found: { min: number; max: number; end: number } | null = null
  if (char === '*') found = { min: 0, max: Infinity, end: at + 1 }
  else if (char === '+') found = { min: 1, max: Infinity, end: at + 1 }
  else if (char === '?') found = { min: 0, max: 1, end: at + 1 }
  else if (char === '{') {
    const braces = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(at, at + 24))
    if (braces) found = { min: Number(braces[1]), max: braces[2] === undefined ? Number(braces[1]) : braces[3] === '' ? Infinity : Number(braces[3]), end: at + braces[0].length }
  }
  if (found && source[found.end] === '?') found.end += 1
  return found
}

/** A quantifier that leaves at least this many lengths open is a run: the engine may come back to it once per character of the text. */
const RUN_SPAN = 32

interface Cost {
  /** The runs that leave the engine several places to go on from. */
  opens: number
  /** The power of the length of the text the work grows as. */
  degree: number
  /** The ways the short choices can be read. */
  ways: number
}

/**
 * What the parts of a group cost together, read in their order. A run multiplies the work of everything after it by the length of the text.
 * A run closed by a character it cannot hold ends at one place only: it is gone over once each time the engine reaches it, and multiplies
 * nothing after it. `before` is the count of open runs ahead of the group.
 */
function costOf(branches: ReadonlyArray<readonly Atom[]>, before = 0): Cost {
  let opens = before
  let degree = before
  let ways = 1
  for (const branch of branches) {
    branch.forEach((atom, index) => {
      ways *= atom.ways
      const stop = branch[index + 1]
      const closed = atom.opens === 1 && (atom.kind === 'literal' || atom.kind === 'class') && stop !== undefined && stop.kind === 'literal' && stop.char !== undefined && stop.min >= 1 && !matches(atom, stop.char)
      if (closed) degree = Math.max(degree, opens + 1)
      else {
        degree = Math.max(degree, opens + atom.degree)
        opens += atom.opens
      }
    })
  }
  if (branches.length > 1) {
    // A choice between parts that all start differently is settled by the first character; any other may be tried part after part.
    const firsts = branches.map((branch) => branch[0])
    const settled = firsts.length <= 32 && firsts.every((first, index) => first !== undefined && firsts.slice(0, index).every((other) => other !== undefined && startDifferently(other, first)))
    if (!settled) ways *= branches.length
  }
  return { opens, degree, ways }
}

interface Reading {
  hazard: string | null
  /** The whole expression, read as a group. Meaningful only without a hazard. */
  root: Frame
}

function read(source: string): Reading {
  const root: Frame = { branches: [[]], unbounded: false }
  const stack: Frame[] = [root]
  let at = 0
  /** Puts an atom in the group being read, with the quantifier that follows it; answers the hazard of repeating it. */
  const add = (atom: Atom, inner: Frame | null): string | null => {
    const quantifier = quantifierAt(source, at)
    if (quantifier) {
      atom.min = quantifier.min
      atom.max = quantifier.max
      at = quantifier.end
    }
    const frame = stack[stack.length - 1] as Frame
    if (inner && atom.max > 1) {
      const hazard = repeatHazard(inner)
      if (hazard) return hazard
    }
    const span = atom.max - atom.min
    if (inner && atom.max > 1) {
      // A repeated group that was let through is read in one way only: however many runs it holds, it is one run over the text.
      if (span >= RUN_SPAN || costOf(inner.branches).degree > 0) atom.opens = atom.degree = 1
      else atom.ways = span + 1
    } else if (inner) {
      const inside = costOf(inner.branches)
      atom.opens = inside.opens
      atom.degree = inside.degree
      atom.ways = inside.ways * (span + 1)
    } else if (span >= RUN_SPAN) {
      atom.opens = atom.degree = 1
    } else {
      atom.ways = span + 1
    }
    if (atom.max === Infinity || inner?.unbounded) frame.unbounded = true
    ;(frame.branches[frame.branches.length - 1] as Atom[]).push(atom)
    return null
  }
  const done = (hazard: string | null): Reading => ({ hazard, root })
  while (at < source.length) {
    const char = source[at] as string
    let hazard: string | null = null
    if (char === '\\') {
      const next = source[at + 1]
      if (next === undefined) return done(null)
      if (/[1-9k]/.test(next)) return done('a back-reference')
      at += 2
      const kind = CLASS_ESCAPES.has(next) ? 'class' : OTHER_ESCAPES.has(next) ? 'other' : 'literal'
      hazard = add({ kind, source: `\\${next}`, ...(kind === 'literal' ? { char: next } : {}), min: 1, max: 1, opens: 0, degree: 0, ways: 1 }, null)
    } else if (char === '[') {
      let end = at + 1
      while (end < source.length && source[end] !== ']') end += source[end] === '\\' ? 2 : 1
      if (end >= source.length) return done(null)
      const text = source.slice(at, end + 1)
      at = end + 1
      hazard = add({ kind: 'class', source: text, min: 1, max: 1, opens: 0, degree: 0, ways: 1 }, null)
    } else if (char === '(') {
      const head = /^\((?:\?(?:(<?[=!])|(:)|<[A-Za-z_$][\w$]*>|[a-zA-Z-]+:))?/.exec(source.slice(at)) as RegExpExecArray
      if (head[1]) return done('a look-around')
      at += head[0].length
      stack.push({ branches: [[]], unbounded: false })
    } else if (char === ')') {
      const inner = stack.pop() as Frame
      if (stack.length === 0) return done(null)
      at += 1
      hazard = add({ kind: 'group', source: '', min: 1, max: 1, opens: 0, degree: 0, ways: 1 }, inner)
    } else if (char === '|') {
      ;(stack[stack.length - 1] as Frame).branches.push([])
      at += 1
    } else {
      at += 1
      const kind = char === '.' ? 'class' : char === '^' || char === '$' ? 'other' : 'literal'
      hazard = add({ kind, source: kind === 'literal' ? char.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') : char, ...(kind === 'literal' ? { char } : {}), min: 1, max: 1, opens: 0, degree: 0, ways: 1 }, null)
    }
    if (hazard) return done(hazard)
  }
  return done(null)
}

/** A leading `(?i)`, the one inline flag the rules use, is no part of the shape of the expression. */
const shapeOf = (source: string): string => (source.startsWith('(?i)') ? source.slice(4) : source)

/**
 * What makes a regular expression dangerous to run on a text somebody else chooses, in a few words for the journal, or null. An expression the
 * engine cannot read at all is not judged here (null): building it fails, and the caller says so.
 */
export function regexHazard(source: string): string | null {
  return read(shapeOf(source)).hazard
}

/** The work one regular expression may cost on one text, counted in places tried: some ten milliseconds of the main process at the very worst. */
export const REGEX_STEP_BUDGET = 2_000_000

/**
 * The longest text the expression may be run on, at most `cap`, for the places the engine can try to stay under `budget` (`REGEX_STEP_BUDGET` unless the caller
 * has its own measure of what one text may cost). Each run
 * (`.*`, `[^/]+`, a repeated group) is a place the engine comes back to character by character, and so is the start of the match when the
 * expression is not tied to the start of the text: with `d` of them one inside the other, a text of `n` characters costs about `n^d / d!`,
 * times the ways the short choices can be read. What ends the expression costs nothing as long as nothing after it can fail. 0 when no text
 * is short enough.
 * Asked only of an expression `regexHazard` lets through.
 */
export function regexTextLimit(source: string, cap: number, budget: number = REGEX_STEP_BUDGET): number {
  const { root } = read(shapeOf(source))
  const whole = root.branches.length === 1 ? (root.branches[0] as Atom[]) : null
  let counted: ReadonlyArray<readonly Atom[]> = root.branches
  if (whole) {
    // From the end: a single character or class that repeats never sends the engine back, while everything after it may match nothing.
    let end = whole.length
    while (end > 0) {
      const atom = whole[end - 1] as Atom
      if (atom.kind !== 'literal' && atom.kind !== 'class') break
      end -= 1
      if (atom.min > 0) break
    }
    counted = [whole.slice(0, end)]
  }
  const tied = root.branches.every((branch) => branch[0]?.source === '^' && branch[0].max === 1)
  // Not tied to the start of the text, the expression is tried from every character: one more run, ahead of all the others.
  const { degree, ways } = costOf(counted, tied ? 0 : 1)
  if (degree === 0) return ways <= budget ? cap : 0
  let factorial = 1
  for (let step = 2; step <= degree; step++) factorial *= step
  const longest = Math.floor(Math.pow((budget * factorial) / ways, 1 / degree))
  return Math.max(0, Math.min(cap, Number.isFinite(longest) ? longest : 0))
}
