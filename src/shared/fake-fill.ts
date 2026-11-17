// Fake but consistent data for the forms of a page: "Remplir avec de fausses données" (right click on a field). Everything here is pure:
// the page is read and written by the engine; this module only decides which field gets which value. Nothing leaves the machine.
// The domain of the addresses is example.com (reserved for documentation): an e-mail sent there goes nowhere.

/** What the page tells about one field, read from its attributes and its label. */
export interface FormFieldHint {
  index: number
  tag: 'input' | 'textarea'
  type: string
  name: string
  id: string
  autocomplete: string
  placeholder: string
  label: string
  /** Visible, enabled, not read-only and empty: only such a field is ever written (the page computes it). */
  usable: boolean
}

/** How many fields of a form are read, and how long a text of a field may be: a form has a few dozen fields, a label a few words. */
export const FORM_FIELDS_MAX = 300
export const FORM_HINT_CHARS = 500

/**
 * The fields a page answered, as the main process takes them. The script that reads them runs in the page, among its own scripts: what
 * comes back is a value of any shape. An entry that is not a field (a text that is not one, an index that is not a number) is left out, a
 * text is cut to `FORM_HINT_CHARS`, and no more than `FORM_FIELDS_MAX` fields are kept: the rules below then never throw on a field.
 */
export function readFormFieldHints(raw: unknown): FormFieldHint[] {
  if (!Array.isArray(raw)) return []
  const hints: FormFieldHint[] = []
  for (const entry of raw.slice(0, FORM_FIELDS_MAX)) {
    if (typeof entry !== 'object' || entry === null) continue
    const { index, tag, usable, ...texts } = entry as Record<string, unknown>
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= FORM_FIELDS_MAX) continue
    if ((tag !== 'input' && tag !== 'textarea') || typeof usable !== 'boolean') continue
    const text = (name: string): string | null => (typeof texts[name] === 'string' ? (texts[name] as string).slice(0, FORM_HINT_CHARS) : null)
    const [type, name, id, autocomplete, placeholder, label] = [text('type'), text('name'), text('id'), text('autocomplete'), text('placeholder'), text('label')]
    if (type === null || name === null || id === null || autocomplete === null || placeholder === null || label === null) continue
    hints.push({ index, tag, type, name, id, autocomplete, placeholder, label, usable })
  }
  return hints
}

export type FieldKind = 'givenName' | 'familyName' | 'fullName' | 'email' | 'phone' | 'street' | 'postalCode' | 'city' | 'country' | 'company' | 'website' | 'birthDate' | 'username'

/** One coherent person: the name, the address and the contact details agree with each other. */
export interface FakeIdentity {
  givenName: string
  familyName: string
  email: string
  phone: string
  street: string
  postalCode: string
  city: string
  country: string
  company: string
  website: string
  birthDate: string
  username: string
}

const GIVEN_NAMES = ['Camille', 'Julien', 'Léa', 'Thomas', 'Chloé', 'Antoine', 'Manon', 'Nicolas', 'Sarah', 'Hugo', 'Emma', 'Louis']
const FAMILY_NAMES = ['Martin', 'Bernard', 'Dubois', 'Durand', 'Lefèvre', 'Moreau', 'Laurent', 'Simon', 'Michel', 'Garcia', 'Roux', 'Fournier']
/** Each city with its own postal code: a city never gets another city's code. */
const CITIES: ReadonlyArray<readonly [string, string]> = [
  ['Paris', '75011'],
  ['Lyon', '69003'],
  ['Marseille', '13006'],
  ['Bordeaux', '33000'],
  ['Lille', '59000'],
  ['Nantes', '44000'],
  ['Toulouse', '31000'],
  ['Strasbourg', '67000'],
  ['Rennes', '35000'],
  ['Grenoble', '38000']
]
const STREETS = ['rue des Lilas', 'avenue de la République', 'rue du Moulin', 'boulevard Victor Hugo', 'place du Marché', 'chemin des Vignes', 'rue Jean Jaurès', 'allée des Tilleuls']
const COMPANIES = ['Atelier Lumière', 'Groupe Horizon', 'Nordic Conseil', 'Studio Bleu', 'Maison Forge', 'Cabinet Aurore']

/** A name without accents and spaces, for an e-mail address or a username. */
const slug = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

const pick = <T>(list: readonly T[], random: () => number): T => list[Math.floor(random() * list.length)]!
const digits = (count: number, random: () => number): string => Array.from({ length: count }, () => Math.floor(random() * 10)).join('')
const two = (value: number): string => String(value).padStart(2, '0')

/** A new identity. `random` returns numbers in [0, 1): a test passes a fixed sequence, the app passes Math.random. */
export function generateIdentity(random: () => number = Math.random): FakeIdentity {
  const givenName = pick(GIVEN_NAMES, random)
  const familyName = pick(FAMILY_NAMES, random)
  const [city, postalCode] = pick(CITIES, random)!
  const year = 1965 + Math.floor(random() * 35)
  const month = 1 + Math.floor(random() * 12)
  const day = 1 + Math.floor(random() * 28)
  return {
    givenName,
    familyName,
    email: `${slug(givenName)}.${slug(familyName)}@example.com`,
    phone: `06${digits(8, random)}`,
    street: `${1 + Math.floor(random() * 120)} ${pick(STREETS, random)}`,
    postalCode,
    city,
    country: 'France',
    company: pick(COMPANIES, random),
    website: 'https://example.org',
    birthDate: `${year}-${two(month)}-${two(day)}`,
    username: `${slug(givenName)}${slug(familyName)}${digits(2, random)}`
  }
}

const norm = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/** The types of input a fake value may go into: any other (password, hidden, file, checkbox, radio...) is refused before any rule runs. */
const FILLABLE_TYPES = ['', 'text', 'email', 'tel', 'url', 'date']
/** The autocomplete tokens of a secret: a card, a password, a one-time code. */
const SECRET_AUTOCOMPLETE = /(^|\s)(cc-|current-password|new-password|one-time-code)/
/** A card, a password, a social security number, a national identity or a tax number, by the words of the field: never filled. */
const SECRET_WORDS = /mot.?de.?passe|passw|\bpwd\b|\bpin\b|code secret|carte|card|cvc|cvv|crypto|iban|\bbic\b|securite sociale|\bsecu\b|\bssn\b|\bnir\b|identifiant d.?etat|identifiant national|identite|identity|national id|\bcni\b|passeport|passport|permis|numero fiscal|siret|\btax/

/** Which kind of value a field expects, or null when no fake value fits it (a password, a card, a search box, a free text...). */
export function classifyField(hint: FormFieldHint): FieldKind | null {
  if (hint.tag === 'textarea' || !FILLABLE_TYPES.includes(hint.type)) return null
  const auto = norm(hint.autocomplete)
  const words = norm(`${hint.name} ${hint.id} ${hint.placeholder} ${hint.label}`)
  if (SECRET_AUTOCOMPLETE.test(auto) || SECRET_WORDS.test(auto) || SECRET_WORDS.test(words)) return null
  const byAutocomplete: Record<string, FieldKind> = {
    'given-name': 'givenName',
    'family-name': 'familyName',
    name: 'fullName',
    email: 'email',
    tel: 'phone',
    'street-address': 'street',
    'address-line1': 'street',
    'postal-code': 'postalCode',
    'address-level2': 'city',
    'country-name': 'country',
    organization: 'company',
    url: 'website',
    bday: 'birthDate',
    username: 'username'
  }
  for (const token of auto.split(/\s+/)) if (byAutocomplete[token]) return byAutocomplete[token]!
  if (hint.type === 'email') return 'email'
  if (hint.type === 'tel') return 'phone'
  if (hint.type === 'url') return 'website'
  if (hint.type === 'date') return 'birthDate'
  // The order matters: "nom de famille" before "nom", "prénom" before "nom", "code postal" before "postal" alone.
  const rules: ReadonlyArray<readonly [RegExp, FieldKind]> = [
    [/prenom|first.?name|given/, 'givenName'],
    [/nom de famille|last.?name|family|surname/, 'familyName'],
    [/courriel|e.?mail|mail/, 'email'],
    [/telephone|phone|mobile|portable|tel\b/, 'phone'],
    [/code postal|postal|zip/, 'postalCode'],
    [/ville|city|localite/, 'city'],
    [/adresse|address|rue|street/, 'street'],
    [/pays|country/, 'country'],
    [/societe|entreprise|company|organi[sz]ation/, 'company'],
    [/site|website|url/, 'website'],
    [/naissance|birth/, 'birthDate'],
    [/identifiant|username|login|pseudo|nom d.utilisateur/, 'username'],
    [/^nom$|^name$|nom complet|full.?name|\bnom\b/, 'fullName']
  ]
  for (const [pattern, kind] of rules) if (pattern.test(words)) return kind
  return null
}

const VALUE_OF: Record<FieldKind, (identity: FakeIdentity) => string> = {
  givenName: (i) => i.givenName,
  familyName: (i) => i.familyName,
  fullName: (i) => `${i.givenName} ${i.familyName}`,
  email: (i) => i.email,
  phone: (i) => i.phone,
  street: (i) => i.street,
  postalCode: (i) => i.postalCode,
  city: (i) => i.city,
  country: (i) => i.country,
  company: (i) => i.company,
  website: (i) => i.website,
  birthDate: (i) => i.birthDate,
  username: (i) => i.username
}

/** The value of each field the identity can fill. Fields with no kind are left out, so a field is never guessed. */
export function fillPlan(hints: readonly FormFieldHint[], identity: FakeIdentity): Array<{ index: number; value: string }> {
  const plan: Array<{ index: number; value: string }> = []
  for (const hint of hints) {
    // A field the user already filled, or one that is hidden, disabled or read-only, is never written.
    if (!hint.usable) continue
    const kind = classifyField(hint)
    if (kind) plan.push({ index: hint.index, value: VALUE_OF[kind](identity) })
  }
  return plan
}

/** Only a page of a normal navigation (http or https): never an internal page (settings, extensions), a file or another scheme. */
export function isNormalPage(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** The plan for the form of a page: empty on any other page, whatever its fields. */
export function fakeFillPlan(pageUrl: string, hints: readonly FormFieldHint[], identity: FakeIdentity): Array<{ index: number; value: string }> {
  return isNormalPage(pageUrl) ? fillPlan(hints, identity) : []
}

/**
 * The attribute the reading step leaves on each field, with its place in the list, for the writing step to find it again. The page can see it
 * for the time between the two: it names neither the browser nor what is about to be written.
 */
export const FILL_MARK = 'data-form-fill-index'

/**
 * The script that writes the plan into the marked fields of the page. It sets the values and announces them (input, change); it never
 * submits the form nor clicks anything, so the page's own code decides what happens next.
 */
export function fakeFillScript(values: ReadonlyArray<{ index: number; value: string }>): string {
  return `(() => {
      const plan = ${JSON.stringify(values)};
      const marked = Array.from(document.querySelectorAll('[${FILL_MARK}]'));
      let written = 0;
      for (const { index, value } of plan) {
        const el = marked.find((item) => item.getAttribute('${FILL_MARK}') === String(index));
        if (!el || el.value !== '') continue;
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        written++;
      }
      for (const item of marked) item.removeAttribute('${FILL_MARK}');
      return written;
    })()`
}
