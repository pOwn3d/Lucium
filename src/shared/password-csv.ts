// Importing passwords from a CSV file (the export of Chrome, Bitwarden or 1Password) and from Lucium's own export. The file is hostile
// input: it is read whole only after its size was checked, its shape is bounded before anything is looked at, a field is only ever data
// (never code, never a path), and what comes out is a list of logins that each went through the same check as a login typed in the panel.
// Pure: no file is read here (the main process reads it with a size limit first).

import { PASSWORD_LIMITS, checkedLogin, siteAddress, type ImportReport, type PasswordEntry } from './passwords'
import { t, tp } from './i18n'
import { storedTotp, type TotpConfig } from './totp'

export const CSV_LIMITS = {
  /** A larger file is not a list of passwords (20 000 logins are about 2 MiB). */
  bytes: 4 * 1024 * 1024,
  rows: 20_000,
  columns: 40,
  /** Any field, used or not: the notes of an item can be long, a megabyte in one cell cannot be one. */
  field: 100_000
} as const

export type CsvError = 'binary' | 'quote' | 'too-many-rows' | 'too-many-columns' | 'field-too-long' | 'empty' | 'unknown-format'

export const CSV_MESSAGES: Record<CsvError, string> = {
  get binary() { return t('password-csv.ce-fichier-n-est-pas-un-fichier-texte') },
  get quote() { return t('password-csv.le-fichier-est-mal-forme-un-guillemet-n-est-pas') },
  get 'too-many-rows'() { return t('password-csv.le-fichier-a-plus-de-rows-lignes', { rows: CSV_LIMITS.rows }) },
  get 'too-many-columns'() { return t('password-csv.une-ligne-a-plus-de-columns-colonnes', { columns: CSV_LIMITS.columns }) },
  get 'field-too-long'() { return t('password-csv.une-cellule-du-fichier-est-demesuree') },
  get empty() { return t('password-csv.le-fichier-est-vide') },
  get 'unknown-format'() { return t('password-csv.ce-fichier-n-a-pas-les-colonnes-d-un-export') }
}

/** RFC 4180 rows from a text, bounded. A quoted field may hold commas, quotes (doubled) and line breaks. */
export function parseCsv(text: string): { ok: true; rows: string[][] } | { ok: false; error: CsvError } {
  if (text.includes('\u0000')) return { ok: false, error: 'binary' }
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let touched = false
  const endField = (): CsvError | null => {
    if (field.length > CSV_LIMITS.field) return 'field-too-long'
    row.push(field)
    field = ''
    return row.length > CSV_LIMITS.columns ? 'too-many-columns' : null
  }
  const endRow = (): CsvError | null => {
    const problem = endField()
    if (problem) return problem
    // A blank line is not a row.
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
    row = []
    touched = false
    return rows.length > CSV_LIMITS.rows ? 'too-many-rows' : null
  }
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else {
        field += c
        if (field.length > CSV_LIMITS.field) return { ok: false, error: 'field-too-long' }
      }
      continue
    }
    if (c === '"' && field === '') {
      quoted = true
      touched = true
    } else if (c === ',') {
      touched = true
      const problem = endField()
      if (problem) return { ok: false, error: problem }
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i++
      const problem = endRow()
      if (problem) return { ok: false, error: problem }
    } else {
      field += c
      touched = true
      if (field.length > CSV_LIMITS.field) return { ok: false, error: 'field-too-long' }
    }
  }
  if (quoted) return { ok: false, error: 'quote' }
  if (touched || field !== '' || row.length > 0) {
    const problem = endRow()
    if (problem) return { ok: false, error: problem }
  }
  return rows.length === 0 ? { ok: false, error: 'empty' } : { ok: true, rows }
}

const URL_COLUMNS = ['url', 'login_uri', 'website', 'web site', 'login url', 'uri']
const USER_COLUMNS = ['username', 'login_username', 'user name', 'login']
const PASSWORD_COLUMNS = ['password', 'login_password']
const TYPE_COLUMNS = ['type']

export interface ParsedLogins {
  format: ImportReport['format']
  logins: Array<{ origin: string; username: string; password: string; totp?: TotpConfig }>
  /** Rows read, and the ones that were left out, by reason. */
  counts: Pick<ImportReport, 'read' | 'unsupported' | 'empty' | 'invalid'>
}

const indexOfColumn = (header: string[], names: readonly string[]): number => header.findIndex((cell) => names.includes(cell))

/**
 * The first address of a cell that can hold a password. A Bitwarden item lists several, one per line or separated by commas. A comma is no part
 * of a host: cutting there never changes the site of the first address, and two addresses joined by one are not read as a single site.
 */
function firstEligible(cell: string): { origin: string } | { error: 'invalid' | 'unsupported' | 'credentials' } {
  let last: { error: 'invalid' | 'unsupported' | 'credentials' } = { error: 'invalid' }
  for (const token of cell.split(/[\s,]+/).filter(Boolean).slice(0, 8)) {
    const found = siteAddress(token)
    if ('origin' in found) return found
    last = found
  }
  return last
}

/**
 * The logins of an exported CSV. The columns are found by their names (case does not matter), whatever their order: Chrome (`name,url,
 * username,password`), Bitwarden (`login_uri`, `login_username`, `login_password`, `type`), 1Password (`Title`, `Website` or `Url`,
 * `Username`, `Password`, `Type`). Items that are not logins and every column that is not one of these are ignored.
 */
export function parseLoginCsv(text: string): { ok: true; parsed: ParsedLogins } | { ok: false; error: CsvError } {
  if (text.length > CSV_LIMITS.bytes) return { ok: false, error: 'field-too-long' }
  const csv = parseCsv(text)
  if (!csv.ok) return csv
  const header = csv.rows[0]!.map((cell) => cell.trim().toLowerCase())
  const url = indexOfColumn(header, URL_COLUMNS)
  const password = indexOfColumn(header, PASSWORD_COLUMNS)
  if (url < 0 || password < 0) return { ok: false, error: 'unknown-format' }
  const user = indexOfColumn(header, USER_COLUMNS)
  const type = indexOfColumn(header, TYPE_COLUMNS)
  const format: ImportReport['format'] = header.includes('login_uri') ? 'bitwarden' : header.includes('title') && !header.includes('name') ? '1password' : 'chrome'
  const counts = { read: 0, unsupported: 0, empty: 0, invalid: 0 }
  const logins: ParsedLogins['logins'] = []
  for (const cells of csv.rows.slice(1)) {
    const kind = type >= 0 ? (cells[type] ?? '').trim().toLowerCase() : ''
    // Cards, notes and identities have no login to bring along (a 1Password "Password" item has a password but no site).
    if (kind !== '' && kind !== 'login' && kind !== 'password') continue
    counts.read++
    const address = (cells[url] ?? '').trim()
    const secret = cells[password] ?? ''
    if (address === '' || secret === '') {
      counts.empty++
      continue
    }
    const site = firstEligible(address)
    if ('error' in site) {
      counts[site.error === 'invalid' ? 'invalid' : 'unsupported']++
      continue
    }
    const checked = checkedLogin({ address: site.origin, username: user >= 0 ? (cells[user] ?? '') : '', password: secret })
    if (!checked.ok) {
      counts.invalid++
      continue
    }
    logins.push({ origin: checked.origin, username: checked.username, password: checked.password })
  }
  return { ok: true, parsed: { format, logins, counts } }
}

// ---------- Lucium's own export ----------

export const EXPORT_KIND = 'lucium-passwords'
const EXPORT_VERSION = 1

/** The plain text sealed inside an export file (the file itself is sealed by vault-crypto.ts). */
export function exportText(entries: readonly PasswordEntry[]): string {
  return JSON.stringify({ kind: EXPORT_KIND, version: EXPORT_VERSION, entries: entries.map(({ origin, username, password, totp }) => ({ origin, username, password, ...(totp ? { totp } : {}) })) })
}

/** The logins inside an export, once opened. Every entry is checked like a login typed by hand; anything else in the text is ignored. */
export function parseExportText(text: string): { ok: true; parsed: ParsedLogins } | { ok: false; error: 'unknown-format' | 'too-many-rows' } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'unknown-format' }
  }
  if (typeof raw !== 'object' || raw === null || (raw as { kind?: unknown }).kind !== EXPORT_KIND || (raw as { version?: unknown }).version !== EXPORT_VERSION) return { ok: false, error: 'unknown-format' }
  const list = (raw as { entries?: unknown }).entries
  if (!Array.isArray(list)) return { ok: false, error: 'unknown-format' }
  if (list.length > PASSWORD_LIMITS.entries) return { ok: false, error: 'too-many-rows' }
  const counts = { read: 0, unsupported: 0, empty: 0, invalid: 0 }
  const logins: ParsedLogins['logins'] = []
  for (const item of list) {
    counts.read++
    const r = typeof item === 'object' && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : null
    if (!r) {
      counts.invalid++
      continue
    }
    const checked = checkedLogin({ address: r['origin'], username: r['username'], password: r['password'] })
    if (!checked.ok) {
      counts[checked.problem === 'unsupported' ? 'unsupported' : checked.problem === 'password' ? 'empty' : 'invalid']++
      continue
    }
    // The key of the one-time codes comes along when the entry has one. A key that is not what this version writes makes the entry invalid:
    // adding the login without its key would be a quiet loss of the second factor.
    const totp = r['totp'] === undefined ? undefined : storedTotp(r['totp'])
    if (totp === null) {
      counts.invalid++
      continue
    }
    logins.push({ origin: checked.origin, username: checked.username, password: checked.password, ...(totp ? { totp } : {}) })
  }
  return { ok: true, parsed: { format: 'lucium', logins, counts } }
}

/**
 * What an import adds to a vault. Never replaces: a login already there (same origin and username) is left as it is, the one in the file counts
 * as a duplicate; so does a second occurrence in the file itself. The vault's capacity is a ceiling: the rest is counted, not added.
 */
export function mergeLogins(existing: readonly Pick<PasswordEntry, 'origin' | 'username'>[], parsed: ParsedLogins, capacity: number = PASSWORD_LIMITS.entries): { toAdd: ParsedLogins['logins']; report: ImportReport } {
  const toAdd: ParsedLogins['logins'] = []
  const report: ImportReport = { format: parsed.format, ...parsed.counts, added: 0, duplicates: 0, overCapacity: 0 }
  const index = new Set(existing.map((e) => `${e.origin}\u0000${e.username}`))
  let room = Math.max(0, capacity - existing.length)
  for (const login of parsed.logins) {
    const key = `${login.origin}\u0000${login.username}`
    if (index.has(key)) {
      report.duplicates++
      continue
    }
    if (room <= 0) {
      report.overCapacity++
      continue
    }
    index.add(key)
    room--
    toAdd.push(login)
    report.added++
  }
  return { toAdd, report }
}

/** One sentence for a report: counts only, never a value; each count by the plural rules of the language (French counts zero as one). */
export function describeReport(report: ImportReport): string {
  const parts = [tp('password-csv.count-ajoutes', report.added)]
  if (report.duplicates > 0) parts.push(tp('password-csv.count-deja-presents-laisses-tels-quels', report.duplicates))
  if (report.unsupported > 0) parts.push(tp('password-csv.count-ignores-adresse-non-prise-en-charge', report.unsupported))
  if (report.empty > 0) parts.push(t('password-csv.empty-sans-adresse-ou-sans-mot-de-passe', { empty: report.empty }))
  if (report.invalid > 0) parts.push(tp('password-csv.count-invalides', report.invalid))
  if (report.overCapacity > 0) parts.push(tp('password-csv.count-non-ajoutes-coffre-plein', report.overCapacity))
  return `${parts.join(', ')}.`
}
