// Adding and removing the user's own filter lists, between the settings window and the blocker: a file or pasted rules are read and
// reviewed (shared/custom-filter-lists.ts), their rules are put on disk, and the list is recorded in the settings. Nothing is downloaded
// here, and a private window adds nothing (the rules would stay on disk after it closes). No Electron: the blocker, the dispatch and the
// clock come in through `CustomListsEnvironment`, so it is tested with stand-ins.

import { randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import {
  CUSTOM_FILE_MAX_BYTES,
  CUSTOM_LISTS_MAX,
  CUSTOM_PASTE_MAX_CHARS,
  isCustomListId,
  listTitleFor,
  type AddFilterListResult,
  type CustomFilterList,
  type CustomListSource,
  type CustomListVerdict,
  type ReviewSample
} from '@shared/custom-filter-lists'
import type { Action } from '@shared/sidebar'
import { t } from '@shared/i18n'
import { settingsPath } from '@shared/settings-path'

export interface CustomListsEnvironment {
  service: {
    reviewCustomText(text: string, maxChars?: number): Promise<CustomListVerdict>
    installCustomList(list: { id: string }, review: { text: string; rules: number; ignored: number; invalid: number; samples: ReviewSample[] }): Promise<void>
    removeCustomList(id: string): Promise<void>
  }
  /** The lists recorded in the settings now (read again after the dispatch: the reducer has the last word). */
  lists(): readonly CustomFilterList[]
  /** The function is switched on (Settings › Vie privée et sécurité › Listes de filtres): off, nothing is added. */
  enabled(): boolean
  dispatch(action: Action): void
  now(): number
  /** Where the id of a new list comes from (random, so two lists never share a file). */
  newId?(): string
  private: boolean
}

const defaultId = (): string => `custom-${randomBytes(4).toString('hex')}`

async function add(env: CustomListsEnvironment, input: { text: string; source: CustomListSource; sourceName: string; title?: string; maxChars: number }): Promise<AddFilterListResult> {
  if (env.private) return { ok: false, reason: t('feature.les-listes-personnalisees-ne-sont-pas') }
  if (!env.enabled()) return { ok: false, reason: t('custom-lists.les-listes-personnalisees-sont-desactivees', { settingsPath: settingsPath('customFilterLists') }) }
  if (env.lists().length >= CUSTOM_LISTS_MAX) return { ok: false, reason: t('custom-lists.vous-avez-deja-custom-lists-max-listes', { CUSTOM_LISTS_MAX }) }
  const verdict = await env.service.reviewCustomText(input.text, input.maxChars)
  if (!verdict.ok) return { ok: false, reason: verdict.reason }
  const taken = new Set(env.lists().map((l) => l.id))
  let id = (env.newId ?? defaultId)()
  for (let attempt = 0; taken.has(id) && attempt < 8; attempt++) id = (env.newId ?? defaultId)()
  if (!isCustomListId(id) || taken.has(id)) return { ok: false, reason: t('custom-lists.impossible-de-nommer-la-liste') }
  const list: CustomFilterList = { id, title: listTitleFor(input.title, verdict.review.title, input.sourceName), source: input.source, sourceName: input.sourceName, enabled: true, addedAt: env.now() }
  try {
    await env.service.installCustomList(list, verdict.review)
  } catch (error) {
    console.error('[blocking] cannot keep a custom list on disk:', error)
    return { ok: false, reason: t('custom-lists.les-regles-n-ont-pas-pu-etre-enregistrees-sur') }
  }
  env.dispatch({ type: 'filterlist/add', list })
  // The reducer refuses a list it cannot hold: the rules just written must not stay behind.
  if (!env.lists().some((l) => l.id === id)) {
    await env.service.removeCustomList(id).catch((error: unknown) => console.error('[blocking] cannot remove a refused custom list:', error))
    return { ok: false, reason: t('custom-lists.la-liste-a-ete-refusee') }
  }
  const { rules, ignored, invalid, samples } = verdict.review
  return { ok: true, list, rules, ignored, invalid, samples }
}

/** Rules pasted into the settings. The text is bounded again here: the interface is not trusted. */
export function addCustomListFromText(env: CustomListsEnvironment, title: unknown, text: unknown): Promise<AddFilterListResult> {
  if (typeof text !== 'string') return Promise.resolve({ ok: false, reason: t('custom-lists.texte-invalide') })
  return add(env, { text, source: 'paste', sourceName: t('custom-lists.regles-collees'), ...(typeof title === 'string' ? { title } : {}), maxChars: CUSTOM_PASTE_MAX_CHARS })
}

/** A file the user picked: its size is checked before it is read, and a failure is told, not swallowed. */
export async function addCustomListFromFile(env: CustomListsEnvironment, path: string): Promise<AddFilterListResult> {
  let text: string
  try {
    const info = await stat(path)
    if (!info.isFile()) return { ok: false, reason: t('custom-lists.ce-n-est-pas-un-fichier') }
    if (info.size > CUSTOM_FILE_MAX_BYTES) return { ok: false, reason: t('custom-lists.le-fichier-depasse-size-mo', { size: Math.round(CUSTOM_FILE_MAX_BYTES / 1_000_000) }) }
    text = await readFile(path, 'utf8')
  } catch (error) {
    console.error('[blocking] cannot read the filter list file:', error instanceof Error ? error.message : error)
    return { ok: false, reason: t('custom-lists.le-fichier-n-a-pas-pu-etre-lu') }
  }
  const name = basename(path)
  return add(env, { text, source: 'file', sourceName: name, title: name.slice(0, name.length - extname(name).length), maxChars: CUSTOM_FILE_MAX_BYTES })
}

/** Takes a list out: the settings first, then its rules on disk. Anything that is not the id of a custom list changes nothing. */
export async function removeCustomListById(env: CustomListsEnvironment, id: unknown): Promise<void> {
  if (!isCustomListId(id) || env.private || !env.lists().some((l) => l.id === id)) return
  env.dispatch({ type: 'filterlist/remove', id })
  await env.service.removeCustomList(id)
}
