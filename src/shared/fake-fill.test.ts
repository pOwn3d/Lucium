import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FILL_MARK, FORM_FIELDS_MAX, FORM_HINT_CHARS, classifyField, fakeFillPlan, fillPlan, fakeFillScript, generateIdentity, readFormFieldHints, type FormFieldHint } from './fake-fill'

const field = (over: Partial<FormFieldHint>): FormFieldHint => ({ index: 0, tag: 'input', type: 'text', name: '', id: '', autocomplete: '', placeholder: '', label: '', usable: true, ...over })
const fixed = (values: number[]) => {
  let at = 0
  return () => values[at++ % values.length]!
}

describe('the kind of a field', () => {
  it('reads the autocomplete attribute first, then the type, then the words of the label', () => {
    expect(classifyField(field({ autocomplete: 'given-name' }))).toBe('givenName')
    expect(classifyField(field({ type: 'email' }))).toBe('email')
    expect(classifyField(field({ name: 'code_postal' }))).toBe('postalCode')
    expect(classifyField(field({ label: 'Prénom' }))).toBe('givenName')
    expect(classifyField(field({ placeholder: 'Nom de famille' }))).toBe('familyName')
    expect(classifyField(field({ label: 'Nom' }))).toBe('fullName')
    expect(classifyField(field({ label: "Nom d'utilisateur" }))).toBe('username')
  })

  it('never guesses a password, a search box or a free text', () => {
    expect(classifyField(field({ type: 'password', name: 'password' }))).toBeNull()
    // A password whose name holds a word the rules know must still be refused: only the type can say it is a secret.
    expect(classifyField(field({ type: 'password', name: 'nom' }))).toBeNull()
    expect(classifyField(field({ type: 'search', name: 'q' }))).toBeNull()
    expect(classifyField(field({ tag: 'textarea', name: 'message' }))).toBeNull()
    expect(classifyField(field({ name: 'commentaire' }))).toBeNull()
  })

  it('refuses every type of input but the text-like ones, whatever its autocomplete says', () => {
    // A password with an autocomplete that names a user, and a hidden or checkbox input that a rule would otherwise fill.
    expect(classifyField(field({ type: 'password', autocomplete: 'username' }))).toBeNull()
    expect(classifyField(field({ type: 'checkbox', autocomplete: 'given-name' }))).toBeNull()
    expect(classifyField(field({ type: 'hidden', name: 'email' }))).toBeNull()
  })

  it('refuses a card, a one-time code, a social security number, a national identity and a password, by the autocomplete or the words', () => {
    expect(classifyField(field({ autocomplete: 'cc-name', label: 'Nom' }))).toBeNull()
    expect(classifyField(field({ autocomplete: 'one-time-code', label: 'Nom' }))).toBeNull()
    expect(classifyField(field({ label: 'Nom sur la carte bancaire' }))).toBeNull()
    expect(classifyField(field({ label: 'Prénom, numéro de sécurité sociale' }))).toBeNull()
    expect(classifyField(field({ label: "Identifiant d'État" }))).toBeNull()
    expect(classifyField(field({ name: 'mot_de_passe', label: 'Nom' }))).toBeNull()
  })
})

describe('an identity', () => {
  it('keeps the e-mail and the username in line with the name, and the city with its postal code', () => {
    for (let trial = 0; trial < 50; trial++) {
      const me = generateIdentity()
      expect(me.email.startsWith(`${me.givenName.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '')}.`)).toBe(true)
      expect(me.email.endsWith('@example.com')).toBe(true)
      expect(me.username.startsWith(me.givenName.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, ''))).toBe(true)
      expect(me.phone).toMatch(/^06\d{8}$/)
      expect(me.postalCode).toMatch(/^\d{5}$/)
      expect(me.birthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    // One identity written out by hand: the family name too goes into the e-mail and the username, without its accent or its capital
    // (an address with "Lefèvre" in it is refused by a field of type email).
    const known = generateIdentity(fixed([0.1, 0.4, 0.6]))
    expect([known.givenName, known.familyName]).toEqual(['Julien', 'Lefèvre'])
    expect(known.email).toBe('julien.lefevre@example.com')
    expect(known.username).toMatch(/^julienlefevre\d{2}$/)
  })

  it('gives a city the same postal code every time, and uses the reserved domain of the documentation for the website', () => {
    const codes = new Map<string, string>()
    for (let trial = 0; trial < 300; trial++) {
      const me = generateIdentity()
      const known = codes.get(me.city)
      if (known !== undefined) expect(me.postalCode).toBe(known)
      else codes.set(me.city, me.postalCode)
      expect(me.website).toBe('https://example.org')
    }
    expect(codes.size).toBeGreaterThan(1)
  })

  it('is the same for the same random numbers', () => {
    expect(generateIdentity(fixed([0.5, 0.2, 0.9]))).toEqual(generateIdentity(fixed([0.5, 0.2, 0.9])))
  })
})

describe('the plan of a form', () => {
  it('fills the fields it knows, skips the others, and never plans a password', () => {
    const me = generateIdentity(fixed([0.1, 0.4, 0.6]))
    const plan = fillPlan(
      [field({ index: 0, autocomplete: 'given-name' }), field({ index: 1, type: 'password', name: 'pwd' }), field({ index: 2, name: 'commentaire' }), field({ index: 3, type: 'email' })],
      me
    )
    expect(plan.map((p) => p.index)).toEqual([0, 3])
    expect(plan[0]!.value).toBe(me.givenName)
    expect(plan[1]!.value).toBe(me.email)
  })

  it('never writes a field the page marked as not usable (filled, hidden, disabled or read-only)', () => {
    const me = generateIdentity(fixed([0.1, 0.4, 0.6]))
    const plan = fillPlan([field({ index: 0, autocomplete: 'given-name', usable: false }), field({ index: 1, autocomplete: 'family-name' })], me)
    expect(plan.map((p) => p.index)).toEqual([1])
  })

  it('plans nothing on an internal page, a file or another scheme, and fills a normal page', () => {
    const me = generateIdentity(fixed([0.1, 0.4, 0.6]))
    const hints = [field({ index: 0, autocomplete: 'given-name' })]
    expect(fakeFillPlan('lucium://settings', hints, me)).toEqual([])
    expect(fakeFillPlan('file:///Users/someone/form.html', hints, me)).toEqual([])
    expect(fakeFillPlan('chrome://extensions', hints, me)).toEqual([])
    expect(fakeFillPlan('https://example.com/inscription', hints, me)).toHaveLength(1)
  })
})

describe('the script that writes the values', () => {
  it('sets the values and announces them, and never submits the form nor clicks anything', () => {
    const script = fakeFillScript([{ index: 0, value: 'Camille' }])
    expect(script).toContain("'input'")
    expect(script).toContain("'change'")
    expect(script).not.toMatch(/submit|click/i)
  })

  it('finds its fields by the mark the reading step left, which names neither this browser nor a former name of it', () => {
    const script = fakeFillScript([{ index: 0, value: 'Camille' }])
    expect(script).toContain(`querySelectorAll('[${FILL_MARK}]')`)
    expect(script).toContain(`getAttribute('${FILL_MARK}')`)
    expect(script).toContain(`removeAttribute('${FILL_MARK}')`)
    expect(FILL_MARK).toMatch(/^data-[a-z-]+$/)
    expect(FILL_MARK).not.toMatch(/lucium|arb/)
    // The step that reads the fields (in the engine) writes the same mark: two spellings and no field would ever be found.
    const reader = readFileSync(new URL('../main/engine/electron-page-content.ts', import.meta.url), 'utf8')
    expect(reader).toContain("el.setAttribute('${FILL_MARK}', String(index));")
    expect(reader).not.toMatch(/setAttribute\('data-/)
  })
})

// The script that reads the fields runs in the page, among its own scripts: a page may answer in its place.
describe('the fields a page answered', () => {
  it('keeps a field as the script describes it', () => {
    const hint = field({ index: 2, name: 'email', autocomplete: 'email', label: 'Adresse e-mail' })
    expect(readFormFieldHints([hint])).toEqual([hint])
  })

  it('leaves out what is not a field, so that no rule throws on it', () => {
    const bad = [
      null,
      'input',
      7,
      [],
      { ...field({}), index: '0' },
      { ...field({}), index: -1 },
      { ...field({}), index: 1.5 },
      { ...field({}), index: FORM_FIELDS_MAX },
      { ...field({}), tag: 'select' },
      { ...field({}), usable: 'yes' },
      { ...field({}), name: { normalize: () => 'x' } },
      { ...field({}), label: null },
      { ...field({}), autocomplete: ['email'] },
      { index: 0, tag: 'input', usable: true }
    ]
    expect(readFormFieldHints(bad)).toEqual([])
    const kept = readFormFieldHints([...bad, field({ index: 4, autocomplete: 'email' })])
    expect(kept.map((hint) => hint.index)).toEqual([4])
    // What is kept goes through the rules without a throw.
    expect(() => fillPlan(kept, generateIdentity(fixed([0.1, 0.5, 0.9])))).not.toThrow()
    for (const raw of [null, undefined, 'fields', 3, { length: 2 }]) expect(readFormFieldHints(raw)).toEqual([])
  })

  it('bounds the number of fields and the length of their texts', () => {
    const many = Array.from({ length: FORM_FIELDS_MAX + 50 }, (_, index) => field({ index: index % FORM_FIELDS_MAX }))
    expect(readFormFieldHints(many)).toHaveLength(FORM_FIELDS_MAX)
    const [long] = readFormFieldHints([field({ label: 'x'.repeat(FORM_HINT_CHARS * 4), placeholder: 'y'.repeat(FORM_HINT_CHARS + 1) })])
    expect(long!.label).toHaveLength(FORM_HINT_CHARS)
    expect(long!.placeholder).toHaveLength(FORM_HINT_CHARS)
  })

  it('is how the engine takes the answer of the page', () => {
    const source = readFileSync(join(__dirname, '..', 'main', 'engine', 'electron-page-content.ts'), 'utf8')
    expect(source).toContain('return readFormFieldHints(await this.webContents.executeJavaScript(script))')
    expect(source).not.toContain('as FormFieldHint[]')
  })
})

