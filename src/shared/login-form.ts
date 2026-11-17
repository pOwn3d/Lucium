// Finding the sign-in form of a page, filling it, and reading what a user submitted. The code that touches the page is here as functions
// that carry no variable of their own scope ("self-contained"): the fill runs in an isolated world of the main frame as the source of
// those functions (`fillScript`), the capture runs in the page bridge (src/preload/password-bridge.ts) as the same functions, and the test
// runs them in a node `vm` against a small stand-in for the DOM (login-form.test.ts), so the three are the same code.
//
// What it will not do, on purpose: fill a field the user cannot see, fill a registration or change-password form (`autocomplete=
// "new-password"`, or several password fields with no hint), fill a form that sends its fields to another origin than the page (by its
// own `action` or by the `formaction` of one of its buttons), fill
// anything in a frame, or fill a page whose origin is not the one it was asked for (rechecked here, in the page, besides the main process).
// The DOM is read through the prototype of `Element` and the setter of `HTMLInputElement` of the isolated world: a page that replaces
// or shadows a method of its own world (or names a field `action`, `getAttribute`…) changes nothing here.

/** No DOM library in the node build: the page's objects are only ever used through the few members below. */
import { t } from './i18n'

type Dom = any
// The interfaces of the world the functions run in (the page's isolated world, or the test's stand-in): they are globals there, not imports.
declare const Element: Dom
declare const HTMLInputElement: Dom

export const LOGIN_FIELDS_MAX = 300

/** Why a fill did not happen, as the page reports it. */
export type FillFailure = 'frame' | 'origin' | 'no-form' | 'not-login' | 'action'

export interface FillPlan {
  /** The origin the entry belongs to: the page must be exactly this. */
  origin: string
  username: string
  password: string
}

export type FillOutcome = { ok: true; username: boolean } | { ok: false; reason: FillFailure }

export const FILL_FAILURE_MESSAGES: Record<FillFailure, string> = {
  get frame() { return t('login-form.seule-la-page-elle-meme-est-remplie-jamais-un') },
  get origin() { return t('login-form.l-adresse-de-la-page-a-change-rien-n-a-ete-rempli') },
  get 'no-form'() { return t('login-form.aucun-champ-de-mot-de-passe-visible-sur-cette-page') },
  get 'not-login'() { return t('login-form.ce-formulaire-n-est-pas-un-formulaire-de-connexion') },
  get action() { return t('login-form.ce-formulaire-envoie-ses-champs-vers-un-autre-site') }
}

/**
 * The reading of the page: its input fields in document order, whether the user can see and use each, and the pick of a sign-in form.
 * Self-contained (see the top of this file). `win` and `doc` are the page's window and document.
 */
export function loginToolkit(win: Dom, doc: Dom) {
  const attribute = (el: Dom, name: string): string => {
    const value = Element.prototype.getAttribute.call(el, name)
    return typeof value === 'string' ? value : ''
  }
  const tokens = (el: Dom): string[] => attribute(el, 'autocomplete').toLowerCase().split(/\s+/).filter(Boolean)
  const visible = (el: Dom): boolean => {
    if (!el.isConnected || el.type === 'hidden') return false
    const shown = typeof el.checkVisibility === 'function' ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : el.getClientRects().length > 0
    if (!shown) return false
    const box = el.getBoundingClientRect()
    // A field of a few pixels, or placed outside the page (negative coordinates of the document), is not one the user can use.
    return box.width >= 4 && box.height >= 4 && box.right + (win.scrollX || 0) > 0 && box.bottom + (win.scrollY || 0) > 0
  }
  const usable = (el: Dom): boolean => !el.disabled && !el.readOnly && visible(el)
  /** The input fields of the page and of its open shadow trees, in document order, at most `LOGIN_FIELDS_MAX`. */
  const fields = (): Dom[] => {
    const out: Dom[] = []
    const walk = (root: Dom): void => {
      for (const el of root.querySelectorAll('input')) {
        if (out.length >= 300) return
        out.push(el)
      }
      for (const host of root.querySelectorAll('*')) if (host.shadowRoot && out.length < 300) walk(host.shadowRoot)
    }
    walk(doc)
    return out
  }
  /** The fields that share a form (those outside any form are one group). */
  const groups = (list: Dom[]): Dom[][] => {
    const byForm = new Map<Dom, Dom[]>()
    for (const el of list) {
      const key = el.form ?? null
      const group = byForm.get(key)
      if (group) group.push(el)
      else byForm.set(key, [el])
    }
    return [...byForm.values()]
  }
  const TEXTUAL = ['text', 'email', 'tel', 'url']
  const HINT = /user|login|e-?mail|mail|ident|account|compte|pseudo|member|membre/i
  /** The field of a group that holds the username for `password`: the best one before it (nearest on a tie). Null when there is none. */
  const usernameFor = (group: Dom[], password: Dom, needsValue: boolean): Dom | null => {
    let best: Dom | null = null
    let bestScore = 0
    for (const el of group) {
      if (el === password) break
      if (!TEXTUAL.includes(el.type) || !usable(el) || (needsValue && !el.value)) continue
      const t = tokens(el)
      const hint = `${el.name ?? ''} ${el.id ?? ''} ${attribute(el, 'placeholder')} ${attribute(el, 'aria-label')}`
      const score = t.includes('username') || t.includes('email') ? 3 : HINT.test(hint) ? 2 : 1
      // `>=`: on equal scores the later one, the nearest to the password, wins.
      if (score >= bestScore) {
        best = el
        bestScore = score
      }
    }
    return best
  }
  /** The password field of a sign-in form among the groups, or why there is none. */
  const findLogin = (): { password: Dom; username: Dom | null; form: Dom | null } | { reason: 'no-form' | 'not-login' } => {
    const all = fields()
    let sawPassword = false
    for (const group of groups(all)) {
      const passwords = group.filter((el) => el.type === 'password' && usable(el))
      if (passwords.length === 0) continue
      sawPassword = true
      const kinds = passwords.map((el) => tokens(el))
      // A new password asked for (registration, change): not a sign-in.
      if (kinds.some((t) => t.includes('new-password'))) continue
      const current = passwords.filter((_el, i) => kinds[i]!.includes('current-password'))
      const pick = current[0] ?? (passwords.length === 1 ? passwords[0] : undefined)
      if (!pick) continue
      return { password: pick, username: usernameFor(group, pick, false), form: pick.form ?? null }
    }
    return { reason: sawPassword ? 'not-login' : 'no-form' }
  }
  /** Whether an address a form is sent to stays on `origin` (none means the page itself; `javascript:` runs the page's own code). */
  const targetOk = (action: string, origin: string): boolean => {
    if (action === '') return true
    if (!URL.canParse(action, doc.baseURI)) return false
    const target = new URL(action, doc.baseURI)
    return target.protocol === 'javascript:' || target.origin === origin
  }
  /**
   * Whether the form sends its fields to `origin`, whichever of its buttons is pressed: its own `action`, and the `formaction` of every
   * button that submits it (inside it, or tied to it by a `form` attribute from anywhere in the page), which replaces the action of the form.
   */
  const actionOk = (form: Dom | null, origin: string): boolean => {
    if (!form) return true
    if (!targetOk(attribute(form, 'action').trim(), origin)) return false
    for (const button of doc.querySelectorAll('[formaction]')) {
      if (button.form === form && !targetOk(attribute(button, 'formaction').trim(), origin)) return false
    }
    return true
  }
  /** Writes a value the way typing does: the native setter (a framework's tracking of the field reads it), then the events. */
  const setValue = (el: Dom, value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setter) setter.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  /** The login in a form the user submitted: its password (the new one, when the form asks for one) and the username before it. Null when it is not clear. */
  const capture = (form: Dom): { username: string; password: string } | null => {
    if (!form) return null
    const group = fields().filter((el) => el.form === form)
    const filled = group.filter((el) => el.type === 'password' && el.value && usable(el))
    if (filled.length === 0) return null
    const fresh = filled.filter((el) => tokens(el).includes('new-password'))
    const chosen = fresh.length > 0 ? fresh : filled
    // Two fields that differ (a confirmation mistyped, an old and a new password with no hint): which one is the password is not known.
    if (new Set(chosen.map((el) => el.value)).size !== 1) return null
    const password = chosen[0]
    const user = usernameFor(group, password, true)
    return { username: user ? String(user.value) : '', password: String(password.value) }
  }
  return { win, doc, fields, groups, findLogin, usernameFor, actionOk, setValue, capture }
}

export type LoginToolkit = ReturnType<typeof loginToolkit>

/**
 * The fill, in the page. `kit` is `loginToolkit(window, document)`. The page's own origin and frame are checked first, whatever the main process
 * checked before, and the secrets are written only once a sign-in form has passed every check.
 */
export function fillAgent(kit: LoginToolkit, plan: FillPlan): FillOutcome {
  if (kit.win.top !== kit.win) return { ok: false, reason: 'frame' }
  if (kit.win.location.origin !== plan.origin) return { ok: false, reason: 'origin' }
  const found = kit.findLogin()
  if (!('password' in found)) return { ok: false, reason: found.reason }
  if (!kit.actionOk(found.form, plan.origin)) return { ok: false, reason: 'action' }
  let username = false
  if (found.username && plan.username !== '') {
    kit.setValue(found.username, plan.username)
    username = true
  }
  kit.setValue(found.password, plan.password)
  return { ok: true, username }
}

/** The source evaluated in the page: the toolkit, the agent and the plan (JSON, so that nothing of it can be code). */
export function fillScript(plan: FillPlan): string {
  return `(${fillAgent.toString()})((${loginToolkit.toString()})(window, document), ${JSON.stringify(plan)})`
}

/** The answer of a fill script, trusted no further than its shape. */
export function parseFillOutcome(raw: unknown): FillOutcome | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as { ok?: unknown; username?: unknown; reason?: unknown }
  if (r.ok === true && typeof r.username === 'boolean') return { ok: true, username: r.username }
  if (r.ok === false && (r.reason === 'frame' || r.reason === 'origin' || r.reason === 'no-form' || r.reason === 'not-login' || r.reason === 'action')) return { ok: false, reason: r.reason }
  return null
}
