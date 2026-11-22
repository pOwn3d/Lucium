// Which stored passwords are weak or used twice (docs/gestionnaire-mots-de-passe.md, « Mots de passe faibles et réutilisés »). Pure rules, run in
// the main process over the entries it holds: the interface is given two flags per row, never a password, never how it was judged, and
// nothing here asks a network (no breach list, no hash sent anywhere).

/** Passwords everybody tries first, compared in lower case and without the digits and signs people add at the end. */
const COMMON = new Set([
  'password', 'passw0rd', 'motdepasse', 'monmotdepasse', 'azerty', 'azertyuiop', 'qwerty', 'qwertyuiop', 'qwertz', 'azerty123', 'letmein', 'welcome', 'bienvenue', 'admin', 'administrator', 'root',
  'iloveyou', 'jetaime', 'soleil', 'doudou', 'chocolat', 'marseille', 'football', 'monkey', 'dragon', 'master', 'login', 'abc', 'abcdef', 'secret', 'changeme', 'trustno', 'sunshine', 'princess', 'superman', 'azertyu'
])

/** Below this many bits (length × log2 of the alphabet it draws on), a password is guessed too fast. A deliberately blunt estimate: it only has to tell the plainly weak. */
const WEAK_BELOW_BITS = 40

/** A password made of at most this many different characters (case ignored) is a pattern, whatever its length. */
const FEWEST_DISTINCT = 3

function alphabetSize(password: string): number {
  let size = 0
  if (/\p{Ll}/u.test(password)) size += 26
  if (/\p{Lu}/u.test(password)) size += 26
  if (/\p{Nd}/u.test(password)) size += 10
  if (/[^\p{L}\p{Nd}]/u.test(password)) size += 33
  return size
}

/** Every character one after the other in the alphabet or the keyboard digits (`abcdefgh`, `87654321`). */
function isRun(chars: string[]): boolean {
  if (chars.length < 4) return false
  const step = chars[1]!.codePointAt(0)! - chars[0]!.codePointAt(0)!
  return Math.abs(step) === 1 && chars.every((char, index) => index === 0 || char.codePointAt(0)! - chars[index - 1]!.codePointAt(0)! === step)
}

/** Whether a password is weak: common, a repetition, a run, or too short for its alphabet. */
export function passwordIsWeak(password: string): boolean {
  const chars = [...password.normalize('NFKC')]
  const lower = chars.join('').toLowerCase()
  if (new Set(lower).size <= FEWEST_DISTINCT) return true
  if (isRun([...lower])) return true
  if (COMMON.has(lower.replace(/[\d\p{P}\p{S}]+$/u, ''))) return true
  return chars.length * Math.log2(Math.max(alphabetSize(password), 2)) < WEAK_BELOW_BITS
}

export interface PasswordHealth {
  weak: boolean
  /** Another entry (of any site, any username) holds exactly this password. */
  reused: boolean
}

/** The flags of each entry by id. Equal means equal to the character: a different case is a different password. */
export function passwordHealth(entries: readonly { id: string; password: string }[]): Map<string, PasswordHealth> {
  const uses = new Map<string, number>()
  for (const entry of entries) uses.set(entry.password, (uses.get(entry.password) ?? 0) + 1)
  return new Map(entries.map((entry) => [entry.id, { weak: passwordIsWeak(entry.password), reused: (uses.get(entry.password) ?? 0) > 1 }]))
}
