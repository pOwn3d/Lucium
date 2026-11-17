// What the theme buttons do (the space menu's "Copier le thème", "Coller le thème", "Appliquer ce thème à tous les espaces", and the theme
// editor's code fields). The clipboard, the toast and the state are reached through `ThemeEnvironment`, so the rules are testable without
// Electron; `theme-environment.ts` is the real one.

import type { SidebarState } from '@shared/model'
import type { Action } from '@shared/sidebar'
import type { SpaceTheme } from '@shared/theme'
import { encodeThemeCode, parseThemeCode, pastedThemePatch, themeCodeMessage, type ThemeFileRequest, type ThemeReply, type ThemeRequest } from '@shared/theme-code'
import { spaceLookRefusal } from '@shared/lock'
import { t } from '@shared/i18n'

export interface ThemeEnvironment {
  state(): SidebarState
  dispatch(action: Action): void
  /** A notice at the foot of the sidebar, with an optional button. */
  toast(message: string, action?: { label: string; run: () => void }): void
  readClipboard(): Promise<string>
  writeClipboard(text: string): Promise<void>
  isPrivate(): boolean
  /** The spaces locked at this moment: their theme does not change. Without it none is. */
  lockedSpaces?(): readonly string[]
}

const fail = (message: string): ThemeReply => ({ ok: false, message })
// Functions, not constants: the language of the process is set after this module is loaded.
const inPrivate = (): string => t('themeact.les-themes-ne-sont-pas-disponibles-dans-une')
const goneSpace = (): string => t('sessions.cet-espace-n-existe-plus')
const noClipboard = (): string => t('themeact.le-presse-papiers-n-est-pas-accessible')

/** Puts a text on the clipboard and says so; a clipboard that refuses is reported to the person, not swallowed. */
async function put(env: ThemeEnvironment, text: string, done: string): Promise<ThemeReply> {
  try {
    await env.writeClipboard(text)
  } catch (error) {
    console.error('[theme] cannot write to the clipboard:', error)
    env.toast(noClipboard())
    return fail(noClipboard())
  }
  env.toast(done)
  return { ok: true, message: done }
}

/** "Copier" next to a code or a colour in the editor. Only a theme code or a colour goes to the clipboard, and in its canonical form. */
export async function copyThemeText(env: ThemeEnvironment, text: string): Promise<ThemeReply> {
  const parsed = parseThemeCode(text)
  if (!parsed.ok) return fail(t('themeact.seul-un-code-de-theme-ou-une-couleur-peut-etre'))
  return parsed.kind === 'theme' ? put(env, encodeThemeCode(parsed.theme), t('themeact.code-du-theme-copie')) : put(env, parsed.color, t('themeact.couleur-copiee'))
}

/** "Copier le thème" in the menu of a space. */
export async function copySpaceTheme(env: ThemeEnvironment, spaceId: string): Promise<ThemeReply> {
  if (env.isPrivate()) return fail(inPrivate())
  const space = env.state().spaces.find((s) => s.id === spaceId)
  if (!space) return fail(goneSpace())
  return put(env, encodeThemeCode(space.theme), t('themeact.theme-copie'))
}

/**
 * "Coller le thème" and the editor's paste field: a code replaces the whole theme of the space, a colour becomes its base colour. Without
 * `text` the clipboard is read. Nothing changes when the text is refused, and the reply says why.
 */
export async function pasteTheme(env: ThemeEnvironment, spaceId: string, text?: string): Promise<ThemeReply> {
  if (env.isPrivate()) return fail(inPrivate())
  let source = text
  if (source === undefined) {
    try {
      source = await env.readClipboard()
    } catch (error) {
      console.error('[theme] cannot read the clipboard:', error)
      return fail(noClipboard())
    }
  }
  const parsed = parseThemeCode(source)
  if (!parsed.ok) return fail(themeCodeMessage(parsed.reason))
  // The state is read after the clipboard: the space can be gone by then.
  const space = env.state().spaces.find((s) => s.id === spaceId)
  if (!space) return fail(goneSpace())
  const refusal = spaceLookRefusal(space.id, env.lockedSpaces?.() ?? [])
  if (refusal !== null) return fail(refusal)
  env.dispatch({ type: 'space/update', id: space.id, patch: { theme: pastedThemePatch(parsed, space.theme) } })
  const message = parsed.kind === 'theme' ? t('themeact.theme-colle') : t('themeact.couleur-collee-comme-couleur-de-base')
  env.toast(message)
  return { ok: true, message }
}

/**
 * "Appliquer ce thème à tous les espaces": `theme` (the editor's draft) or else the space's own is given to every space in one step, and the
 * toast offers to put each space's previous theme back.
 */
export async function applyThemeToAll(env: ThemeEnvironment, spaceId: string, theme?: SpaceTheme): Promise<ThemeReply> {
  if (env.isPrivate()) return fail(inPrivate())
  const spaces = env.state().spaces
  const source = spaces.find((s) => s.id === spaceId)
  if (!source) return fail(goneSpace())
  if (spaces.length < 2) return fail(t('themeact.il-n-y-a-qu-un-espace-rien-a-appliquer-aux'))
  // `theme` was repaired when the request was read, and the reducer repairs what it is given once more.
  const given = theme ?? source.theme
  // A locked space keeps its theme: the theme goes to the others, and the notice counts those only.
  const locked = env.lockedSpaces?.() ?? []
  const targets = spaces.filter((s) => !locked.includes(s.id))
  if (!targets.some((s) => s.id !== spaceId)) return fail(t('themeact.les-autres-espaces-sont-verrouilles-leur-theme'))
  const previous = targets.map((s) => ({ id: s.id, theme: s.theme }))
  env.dispatch({ type: 'space/apply-themes', entries: targets.map((s) => ({ id: s.id, theme: given })) })
  const message = t('themeact.theme-applique-aux-length-espaces', { length: targets.length })
  env.toast(message, { label: t('menu.annuler'), run: () => env.dispatch({ type: 'space/apply-themes', entries: previous }) })
  return { ok: true, message }
}

/** One request of the editor (the file requests are the share module's: they need dialogs). */
export function runThemeRequest(env: ThemeEnvironment, request: Exclude<ThemeRequest, ThemeFileRequest>): Promise<ThemeReply> {
  switch (request.kind) {
    case 'copy':
      return copyThemeText(env, request.text)
    case 'paste':
      return pasteTheme(env, request.spaceId, request.text)
    case 'apply-all':
      return applyThemeToAll(env, request.spaceId, request.theme)
  }
}
