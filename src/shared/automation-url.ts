// Commands by address: `lucium://open?url=…`, `lucium://new-tab`, `lucium://search?q=…`. This is how AppleScript (`open location`), the
// Shortcuts app ("Ouvrir des URL"), the Terminal (`open`) and any script drive Lucium without a scripting dictionary (Electron has none:
// docs/architecture.md, "Automatisation").
//
// THREAT MODEL. Anyone who can make the system open a URL can call this: another application, a script, a web page in another browser (which asks
// the user first, but the user may say yes). So:
//   - it is switched off by default (`urlAutomation`), and a refused command is only a line in the log;
//   - the commands are a fixed list (below), each with the parameters it takes; an unknown command, an unknown or repeated parameter, a
//     fragment, a port, a login, a path, a control character, a long value: all refused;
//   - nothing here reads or erases anything, and nothing answers (no reply, no x-callback-url): the caller learns nothing about the state.
//     A command that did read or erase would have to ask the user first, in a native box; none does, so none is on the list;
//   - what is opened is a web address (http or https, no login in it), never `file:`, `javascript:`, `data:` or another `lucium:` command;
//   - a flood is cut: at most `AUTOMATION_RATE.max` commands in `AUTOMATION_RATE.windowMs`;
//   - an application that is locked takes none (the command is dropped, not kept for later).

import { t } from './i18n'

/** The one scheme taken, which the settings and the documentation show (electron-builder.yml declares it, and no other). */
export const AUTOMATION_SCHEME = 'lucium:'

/** The whole URL; the web address inside it is bounded by `AUTOMATION_ADDRESS_MAX` and may be percent-encoded (three characters for one). */
export const AUTOMATION_URL_MAX = 8192
export const AUTOMATION_ADDRESS_MAX = 2048
export const AUTOMATION_QUERY_MAX = 500

/** Commands in a window of time: a shortcut that opens a list of pages passes, a loop does not. */
export const AUTOMATION_RATE = { max: 20, windowMs: 10_000 } as const

export interface AutomationCommandInfo {
  /** The host part of the address. */
  name: string
  /** The parameters it takes, all required. */
  params: readonly string[]
  /** One line, in the language of the interface: what it does (the pane and the documentation show it). */
  description: string
  /** An address the command accepts, written with the scheme shown. */
  example: string
}

/** The whole list. Adding a command means answering the threat model above in its pull request: it reads nothing, erases nothing, answers nothing. */
export const AUTOMATION_COMMANDS = [
  { name: 'open', params: ['url'], get description() { return t('automation-url.ouvre-une-adresse-web-dans-un-onglet') }, example: 'lucium://open?url=https%3A%2F%2Fexample.com%2F' },
  { name: 'new-tab', params: [], get description() { return t('automation-url.ouvre-la-barre-de-commandes-pour-un-nouvel') }, example: 'lucium://new-tab' },
  {
    name: 'search',
    params: ['q'],
    get description() { return t('automation-url.lance-une-recherche-avec-le-moteur-du-profil') },
    // The words searched for in the example are the reader's: the address carries them percent-encoded, as a script must write them.
    get example() { return `lucium://search?q=${encodeURIComponent(t('automation-url.navigateur-libre'))}` }
  }
] as const satisfies readonly AutomationCommandInfo[]

export type AutomationCommand = { command: 'open'; url: string } | { command: 'new-tab' } | { command: 'search'; query: string }

/** Why a command was not run. `locked` and `rate` come from the shell's state, the others from the address. */
export type AutomationRefusal = 'disabled' | 'locked' | 'rate' | 'malformed' | 'unknown-command' | 'bad-parameter' | 'bad-address' | 'bad-query'

export type AutomationVerdict = { ok: true; command: AutomationCommand } | { ok: false; reason: AutomationRefusal; command?: string }

/** Whether an address is for this module at all (the scheme, any case): everything else goes the way links from other applications always did. */
export const isAutomationUrl = (url: unknown): boolean =>
  typeof url === 'string' && url.slice(0, AUTOMATION_SCHEME.length).toLowerCase() === AUTOMATION_SCHEME

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

/** The web address a command may open: http or https, a host, no login, no control character, not longer than `AUTOMATION_ADDRESS_MAX`. */
export function automationAddress(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > AUTOMATION_ADDRESS_MAX) return null
  if (CONTROL.test(value) || value !== value.trim() || /\s/.test(value)) return null
  if (!URL.canParse(value)) return null
  const parsed = new URL(value)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.hostname === '' || parsed.username !== '' || parsed.password !== '') return null
  return parsed.href
}

/** A search text: one line, not empty, not longer than `AUTOMATION_QUERY_MAX`. */
export function automationQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length > 0 && text.length <= AUTOMATION_QUERY_MAX && !CONTROL.test(text) ? text : null
}

/** The search address for a text, in the form the settings keep (`%s` marks the place; `encodeURIComponent` leaves no `$` for `replace` to read). */
export const automationSearchAddress = (template: string, query: string): string => template.replace('%s', encodeURIComponent(query))

/**
 * What a `lucium:` address asks for, or why it is refused. `enabled` is the setting; it is read first, so that a switched-off application
 * reads nothing of the address beyond its scheme. The refusal carries the command's name when it is one of the list (for the log: never the
 * parameters, which may be a private search).
 */
export function parseAutomationUrl(raw: unknown, enabled: boolean): AutomationVerdict {
  if (!enabled) return { ok: false, reason: 'disabled' }
  if (typeof raw !== 'string' || !isAutomationUrl(raw) || raw.length > AUTOMATION_URL_MAX || CONTROL.test(raw) || raw !== raw.trim() || !raw.toLowerCase().startsWith(`${AUTOMATION_SCHEME}//`) || !URL.canParse(raw)) {
    return { ok: false, reason: 'malformed' }
  }
  const url = new URL(raw)
  const name = url.hostname.toLowerCase()
  const info = AUTOMATION_COMMANDS.find((command) => command.name === name)
  if (!info) return { ok: false, reason: 'unknown-command' }
  // Nothing but the command and its parameters: no login, port, fragment or path (a trailing slash is the only one let through).
  if (url.username !== '' || url.password !== '' || url.port !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')) return { ok: false, reason: 'malformed', command: name }
  const given = new Map<string, string>()
  for (const [key, value] of url.searchParams) {
    if (!(info.params as readonly string[]).includes(key) || given.has(key)) return { ok: false, reason: 'bad-parameter', command: name }
    given.set(key, value)
  }
  if (given.size !== info.params.length) return { ok: false, reason: 'bad-parameter', command: name }
  switch (info.name) {
    case 'open': {
      const address = automationAddress(given.get('url'))
      return address ? { ok: true, command: { command: 'open', url: address } } : { ok: false, reason: 'bad-address', command: name }
    }
    case 'search': {
      const query = automationQuery(given.get('q'))
      return query ? { ok: true, command: { command: 'search', query } } : { ok: false, reason: 'bad-query', command: name }
    }
    case 'new-tab':
      return { ok: true, command: { command: 'new-tab' } }
  }
}

/** Counts the commands of the last `windowMs` and says no past `max`. A refused command is not counted: the window frees itself. */
export class AutomationLimiter {
  private readonly at: number[] = []

  constructor(
    private readonly max: number = AUTOMATION_RATE.max,
    private readonly windowMs: number = AUTOMATION_RATE.windowMs
  ) {}

  allow(now: number): boolean {
    while (this.at.length > 0 && now - this.at[0]! >= this.windowMs) this.at.shift()
    if (this.at.length >= this.max) return false
    this.at.push(now)
    return true
  }
}
