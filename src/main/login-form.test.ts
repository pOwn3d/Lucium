import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { fillScript, loginToolkit, parseFillOutcome, type FillPlan } from '@shared/login-form'

// (This test is in src/main because it runs the page code in a node `vm`; the code itself is src/shared/login-form.ts.)
// A stand-in for the DOM: just the members the page code uses. The page code is run as the source `fillScript` builds (as the page runs it)
// in a context that has nothing else, so a variable the functions took from their module would be a ReferenceError here.

class FakeElement {
  attrs: Record<string, string> = {}
  getAttribute(name: string): string | null {
    return Object.hasOwn(this.attrs, name) ? this.attrs[name]! : null
  }
}
class FakeForm extends FakeElement {}
class FakeInput extends FakeElement {
  type = 'text'
  name = ''
  id = ''
  form: FakeForm | null = null
  disabled = false
  readOnly = false
  isConnected = true
  shown = true
  box = { width: 200, height: 30, right: 300, bottom: 50 }
  events: string[] = []
  #value = ''
  get value(): string {
    return this.#value
  }
  set value(v: string) {
    this.#value = String(v)
  }
  checkVisibility(): boolean {
    return this.shown
  }
  getClientRects(): number[] {
    return this.shown ? [1] : []
  }
  getBoundingClientRect() {
    return this.box
  }
  dispatchEvent(event: { type: string }): boolean {
    this.events.push(event.type)
    return true
  }
}

class FakeRoot {
  constructor(private readonly inputs: FakeInput[]) {}
  querySelectorAll(selector: string): FakeInput[] {
    return selector === 'input' ? this.inputs : []
  }
}

/** A button that submits a form: inside it, or tied to it from elsewhere by a `form` attribute (the DOM gives its owner either way). */
class FakeButton extends FakeElement {
  constructor(
    readonly form: FakeForm | null,
    formaction: string
  ) {
    super()
    this.attrs['formaction'] = formaction
  }
}

interface Page {
  /** The elements of the page that carry a `formaction`. */
  buttons?: FakeButton[]
  inputs: FakeInput[]
  hosts: Array<{ shadowRoot: FakeRoot }>
  origin: string
  top: 'self' | 'other'
}

function input(patch: Partial<FakeInput> & { autocomplete?: string; placeholder?: string } = {}): FakeInput {
  const { autocomplete, placeholder, ...rest } = patch
  const el = new FakeInput()
  Object.assign(el, rest)
  if (autocomplete) el.attrs['autocomplete'] = autocomplete
  if (placeholder) el.attrs['placeholder'] = placeholder
  return el
}

function signInForm(extra: Partial<FakeInput> = {}) {
  const form = new FakeForm()
  const user = input({ type: 'text', name: 'email', form })
  const password = input({ type: 'password', name: 'pw', form, ...extra })
  return { form, user, password }
}

function world(page: Partial<Page> & { inputs: FakeInput[] }) {
  const win: Record<string, unknown> = { scrollX: 0, scrollY: 0, location: { origin: page.origin ?? 'https://example.com' } }
  win['top'] = page.top === 'other' ? { other: true } : win
  const doc = {
    baseURI: `${page.origin ?? 'https://example.com'}/login`,
    querySelectorAll: (selector: string) => (selector === 'input' ? page.inputs : selector === '[formaction]' ? (page.buttons ?? []) : (page.hosts ?? []))
  }
  return { window: win, document: doc, Element: FakeElement, HTMLInputElement: FakeInput, Event: class { constructor(readonly type: string) {} }, URL }
}

const PLAN: FillPlan = { origin: 'https://example.com', username: 'ana@example.com', password: 'p4ss-secret' }
const run = (page: Parameters<typeof world>[0], plan: FillPlan = PLAN): unknown => runInNewContext(fillScript(plan), world(page))

describe('filling a sign-in form', () => {
  it('writes the username and the password, and tells the page as typing does', () => {
    const { user, password } = signInForm()
    expect(run({ inputs: [user, password] })).toEqual({ ok: true, username: true })
    expect(user.value).toBe('ana@example.com')
    expect(password.value).toBe('p4ss-secret')
    expect(user.events).toEqual(['input', 'change'])
    expect(password.events).toEqual(['input', 'change'])
  })

  it('writes through the native setter: a field whose value the page has trapped does not see the secret before the events', () => {
    const { user, password } = signInForm()
    const leaked: string[] = []
    Object.defineProperty(password, 'value', { get: () => '', set: (v: string) => void leaked.push(v), configurable: true })
    run({ inputs: [user, password] })
    expect(leaked).toEqual([])
    expect(FakeInput.prototype.hasOwnProperty('value')).toBe(true)
  })

  it('fills only a password when the entry has no username, and only the password when no field takes the username', () => {
    const { user, password } = signInForm()
    expect(run({ inputs: [user, password] }, { ...PLAN, username: '' })).toEqual({ ok: true, username: false })
    expect(user.value).toBe('')
    const alone = input({ type: 'password' })
    expect(run({ inputs: [alone] })).toEqual({ ok: true, username: false })
    expect(alone.value).toBe('p4ss-secret')
  })

  it('takes the plan as data: quotes, markup and line separators in a value are the value', () => {
    const { user, password } = signInForm()
    const nasty = '"); throw 1; //</script> ${x}`\\'
    expect(run({ inputs: [user, password] }, { ...PLAN, username: nasty, password: nasty })).toEqual({ ok: true, username: true })
    expect(user.value).toBe(nasty)
    expect(password.value).toBe(nasty)
  })

  it('picks the username by its hint, not by its place, and never a field after the password', () => {
    const form = new FakeForm()
    const hinted = input({ type: 'text', name: 'x', form, autocomplete: 'username' })
    const nearer = input({ type: 'text', name: 'zip', form })
    const password = input({ type: 'password', form })
    const after = input({ type: 'text', name: 'login', form })
    run({ inputs: [hinted, nearer, password, after] })
    expect([hinted.value, nearer.value, after.value]).toEqual(['ana@example.com', '', ''])
    const plain = signInForm()
    const search = input({ type: 'search', form: plain.form })
    run({ inputs: [search, plain.user, plain.password] })
    expect([search.value, plain.user.value]).toEqual(['', 'ana@example.com'])
  })

  it('takes no username from a field that comes after the password', () => {
    const form = new FakeForm()
    const password = input({ type: 'password', form })
    const after = input({ type: 'text', name: 'login', form, autocomplete: 'username' })
    expect(run({ inputs: [password, after] })).toEqual({ ok: true, username: false })
    expect(after.value).toBe('')
    expect(password.value).toBe('p4ss-secret')
  })

  it('leaves the fields of another form alone', () => {
    const a = signInForm()
    const b = signInForm()
    run({ inputs: [a.user, a.password, b.user, b.password] })
    expect([a.password.value, b.user.value, b.password.value]).toEqual(['p4ss-secret', '', ''])
  })

  it('reads a form with no <form> element, and the open shadow trees', () => {
    const user = input({ type: 'email' })
    const password = input({ type: 'password' })
    expect(run({ inputs: [user, password] })).toEqual({ ok: true, username: true })
    const inner = input({ type: 'password' })
    expect(run({ inputs: [], hosts: [{ shadowRoot: new FakeRoot([inner]) }] })).toEqual({ ok: true, username: false })
    expect(inner.value).toBe('p4ss-secret')
  })

  it('looks at no more than 300 fields', () => {
    const many = Array.from({ length: 400 }, () => input({ type: 'text' }))
    const password = input({ type: 'password' })
    expect(run({ inputs: [...many, password] })).toEqual({ ok: false, reason: 'no-form' })
    expect(password.value).toBe('')
  })
})

describe('what it never fills', () => {
  it('a field the user cannot see: hidden, tiny, outside the page, disabled, read-only', () => {
    const cases: Array<Partial<FakeInput>> = [{ shown: false }, { type: 'hidden' }, { box: { width: 1, height: 1, right: 5, bottom: 5 } }, { box: { width: 200, height: 30, right: -10, bottom: 20 } }, { disabled: true }, { readOnly: true }, { isConnected: false }]
    for (const patch of cases) {
      const { user, password } = signInForm(patch)
      expect(run({ inputs: [user, password] }), JSON.stringify(patch)).toEqual({ ok: false, reason: 'no-form' })
      expect(password.value).toBe('')
    }
  })

  it('a hidden username field is left empty while the visible password is filled', () => {
    const { user, password } = signInForm()
    user.shown = false
    expect(run({ inputs: [user, password] })).toEqual({ ok: true, username: false })
    expect(user.value).toBe('')
  })

  it('a registration or change-password form', () => {
    const fresh = signInForm({ attrs: { autocomplete: 'new-password' } } as Partial<FakeInput>)
    fresh.password.attrs['autocomplete'] = 'new-password'
    expect(run({ inputs: [fresh.user, fresh.password] })).toEqual({ ok: false, reason: 'not-login' })
    expect(fresh.password.value).toBe('')

    const form = new FakeForm()
    const first = input({ type: 'password', form })
    const second = input({ type: 'password', form })
    expect(run({ inputs: [first, second] })).toEqual({ ok: false, reason: 'not-login' })

    const change = new FakeForm()
    const old = input({ type: 'password', form: change, autocomplete: 'current-password' })
    const next = input({ type: 'password', form: change, autocomplete: 'new-password' })
    expect(run({ inputs: [old, next] })).toEqual({ ok: false, reason: 'not-login' })
    expect([old.value, next.value, first.value, second.value]).toEqual(['', '', '', ''])
  })

  it('picks the current password among several when the page says which', () => {
    const form = new FakeForm()
    const hint = input({ type: 'password', form, autocomplete: 'current-password' })
    const other = input({ type: 'password', form })
    run({ inputs: [hint, other] })
    expect([hint.value, other.value]).toEqual(['p4ss-secret', ''])
  })

  it('a page that is not the origin of the entry, checked in the page itself', () => {
    const { user, password } = signInForm()
    expect(run({ inputs: [user, password], origin: 'https://example.com.evil.test' })).toEqual({ ok: false, reason: 'origin' })
    expect(run({ inputs: [user, password], origin: 'http://example.com' })).toEqual({ ok: false, reason: 'origin' })
    expect(run({ inputs: [user, password], origin: 'https://example.com:8443' })).toEqual({ ok: false, reason: 'origin' })
    expect([user.value, password.value]).toEqual(['', ''])
  })

  it('a frame', () => {
    const { user, password } = signInForm()
    expect(run({ inputs: [user, password], top: 'other' })).toEqual({ ok: false, reason: 'frame' })
    expect([user.value, password.value]).toEqual(['', ''])
  })

  it('a form that sends its fields to another origin, or to http, read from the attribute and not from what the page put on the form object', () => {
    // `data:` and `vbscript:` have no origin to compare: only `javascript:` (the page's own code) is let through besides the origin of the page.
    for (const action of ['https://evil.test/collect', 'http://example.com/login', '//evil.test/x', 'https://example.com.evil.test/', 'data:text/html,<p>x</p>', 'vbscript:msgbox(1)']) {
      const { form, user, password } = signInForm()
      form.attrs['action'] = action
      expect(run({ inputs: [user, password] }), action).toEqual({ ok: false, reason: 'action' })
      expect(password.value).toBe('')
    }
    for (const action of ['', '/session', 'login', 'https://example.com/session', 'javascript:void(0)']) {
      const { form, user, password } = signInForm()
      form.attrs['action'] = action
      expect(run({ inputs: [user, password] }), action).toEqual({ ok: true, username: true })
    }
    // A field named "action" (or "getAttribute") makes form.action (form.getAttribute) that field: the attribute is read the other way.
    const { form, user, password } = signInForm()
    form.attrs['action'] = 'https://evil.test/collect'
    Object.assign(form, { action: 'https://example.com/ok', getAttribute: 'clobbered' })
    expect(run({ inputs: [user, password] })).toEqual({ ok: false, reason: 'action' })
  })

  // Markup injected into a page that allows no script: a button whose `formaction` replaces the action of the form it submits.
  it('a form one of whose buttons sends its fields to another origin, the button inside the form or tied to it from elsewhere', () => {
    for (const formaction of ['https://evil.test/collect', 'http://example.com/login', '//evil.test/x', ' https://evil.test/padded ', 'data:text/html,<p>x</p>', 'vbscript:msgbox(1)']) {
      const { form, user, password } = signInForm()
      form.attrs['action'] = '/session'
      expect(run({ inputs: [user, password], buttons: [new FakeButton(form, '/session'), new FakeButton(form, formaction)] }), formaction).toEqual({ ok: false, reason: 'action' })
      expect([user.value, password.value]).toEqual(['', ''])
    }
    for (const formaction of ['', '/session/sso', 'https://example.com/other', 'javascript:void(0)']) {
      const { form, user, password } = signInForm()
      expect(run({ inputs: [user, password], buttons: [new FakeButton(form, formaction)] }), formaction).toEqual({ ok: true, username: true })
    }
    // The button of another form, or of no form, sends nothing of this one.
    const { user, password } = signInForm()
    expect(run({ inputs: [user, password], buttons: [new FakeButton(new FakeForm(), 'https://evil.test/collect'), new FakeButton(null, 'https://evil.test/collect')] })).toEqual({ ok: true, username: true })
  })

  it('a page with no password field', () => {
    expect(run({ inputs: [input({ type: 'text' })] })).toEqual({ ok: false, reason: 'no-form' })
    expect(run({ inputs: [] })).toEqual({ ok: false, reason: 'no-form' })
  })
})

describe('reading a submitted form', () => {
  const kit = (inputs: FakeInput[]) => {
    const w = world({ inputs })
    return loginToolkit(w.window, w.document)
  }
  const globals = { Element: FakeElement, HTMLInputElement: FakeInput }
  Object.assign(globalThis, globals)

  it('gives the username and the password the user typed', () => {
    const { form, user, password } = signInForm()
    user.value = 'ana'
    password.value = 'typed-pw'
    expect(kit([user, password]).capture(form)).toEqual({ username: 'ana', password: 'typed-pw' })
  })

  it('gives nothing without a typed password, or for a form that is not the submitted one', () => {
    const { form, user, password } = signInForm()
    user.value = 'ana'
    expect(kit([user, password]).capture(form)).toBeNull()
    const other = signInForm()
    other.password.value = 'pw'
    expect(kit([user, password, other.user, other.password]).capture(form)).toBeNull()
    expect(kit([user, password]).capture(null)).toBeNull()
  })

  it('prefers the new password of a registration, and gives nothing when two differ with no hint', () => {
    const form = new FakeForm()
    const user = input({ type: 'text', form })
    user.value = 'ana'
    const fresh = input({ type: 'password', form, autocomplete: 'new-password' })
    const confirm = input({ type: 'password', form, autocomplete: 'new-password' })
    fresh.value = 'new-pw'
    confirm.value = 'new-pw'
    expect(kit([user, fresh, confirm]).capture(form)).toEqual({ username: 'ana', password: 'new-pw' })
    confirm.value = 'mistyped'
    expect(kit([user, fresh, confirm]).capture(form)).toBeNull()
    const a = input({ type: 'password', form })
    const b = input({ type: 'password', form })
    a.value = 'one'
    b.value = 'two'
    expect(kit([a, b]).capture(form)).toBeNull()
  })

  it('does not read a password the user cannot see', () => {
    const { form, user, password } = signInForm({ shown: false })
    user.value = 'ana'
    password.value = 'pw'
    expect(kit([user, password]).capture(form)).toBeNull()
  })
})

describe('the answer of the page', () => {
  it('is trusted no further than its shape', () => {
    expect(parseFillOutcome({ ok: true, username: false })).toEqual({ ok: true, username: false })
    expect(parseFillOutcome({ ok: false, reason: 'origin' })).toEqual({ ok: false, reason: 'origin' })
    expect(parseFillOutcome({ ok: false, reason: 'made up' })).toBeNull()
    expect(parseFillOutcome({ ok: true })).toBeNull()
    expect(parseFillOutcome(null)).toBeNull()
    expect(parseFillOutcome('ok')).toBeNull()
  })
})
