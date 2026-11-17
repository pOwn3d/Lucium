// What the buttons that share Tweaks and themes do: bring one in from a file or from the clipboard, send one out as a file or as a link.
// The dialogs, the files, the clipboard and the state are reached through `ShareEnvironment`, so the rules are testable without Electron;
// `share-environment.ts` is the real one. The rules, in the order they are applied to what comes in:
//
//   1. a private window keeps nothing: it does not import, and it has no Tweak to export;
//   2. the file is read within its size limit, then judged by the pure reader (shared/boost-share.ts), then the site by the public
//      suffix list, and a refusal is shown with its reason: nothing was written;
//   3. the person sees what the Tweak holds and says yes, or no, or "without the script";
//   4. only then is the `boost/import` action dispatched, and the reducer reads the Tweak once more.
// Nothing is ever fetched: a link is a text, a file is a file.

import { THEME_FILE_MAX_BYTES, BOOST_BUNDLE_MAX_BYTES, boostFileText, boostLink, boostsFileText, importBundlePreview, importPreview, parseBoostFiles, parseBoostLink, parseThemeFile, scriptExportWarning, shareFileName, shareRefusalMessage, shareableBoost, shareableBoosts, themeFileText, type BoostShareRequest, type ImportPreview, type SharedBoost, type ShareReply } from '@shared/boost-share'
import type { SidebarState } from '@shared/model'
import type { Action } from '@shared/sidebar'
import type { SpaceTheme } from '@shared/theme'
import type { ThemeFileRequest } from '@shared/theme-code'
import { fileFailureMessage, type BoundedRead } from './bounded-file'
import { spaceLookRefusal } from '@shared/lock'
import { t, tp } from '@shared/i18n'
import { settingsPath } from '@shared/settings-path'

export type ImportChoice = 'install' | 'install-without-script' | 'cancel'
export type ExportChoice = 'with-script' | 'without-script' | 'cancel'

/** The extensions the files are written with: `.lucium-boost` and `.lucium-theme`. A file is read by its content, never by its extension. */
export const BOOST_EXTENSION = 'lucium-boost'

export interface ShareEnvironment {
  /** What identifies the window: one request at a time is served for it, whichever object the environment is rebuilt as. */
  readonly window: object
  state(): SidebarState
  dispatch(action: Action): void
  /** A notice at the foot of the sidebar. */
  toast(message: string): void
  readClipboard(): Promise<string>
  writeClipboard(text: string): Promise<void>
  isPrivate(): boolean
  /** The spaces locked at this moment: their theme does not change. Without it none is. */
  lockedSpaces?(): readonly string[]
  newId(): string
  /** Whether the site is a whole family of sites (a public suffix): a shared Tweak must aim at one site. */
  isWideHost(host: string): boolean
  /** Asks for a file to open; null when the person cancels. */
  chooseOpenFile(title: string): Promise<string | null>
  /** Asks where to save; null when the person cancels. `extension` is without its dot. */
  chooseSaveFile(title: string, defaultName: string, extension: string): Promise<string | null>
  readFile(path: string, maxBytes: number): Promise<BoundedRead>
  writeFile(path: string, text: string): Promise<void>
  /** The sheet that shows a Tweak before it is installed. */
  confirmImport(preview: ImportPreview): Promise<ImportChoice>
  /**
   * The sheet that says a Tweak holds a script before it goes into a file or a link. For a file of all the Tweaks, `scripted` names the ones
   * that hold a script (and `boostName` is not used): one sheet for the whole file, with the same three answers.
   */
  confirmExportScript(boostName: string, warning: string, scripted?: readonly string[]): Promise<ExportChoice>
  /** The sheet that shows a theme before it is applied to a space. */
  confirmThemeImport(message: string, detail: string): Promise<boolean>
  /** Tells the person why something was refused or failed (a dialog: the reason can be a few lines). */
  showProblem(title: string, sentence: string): Promise<void>
}

// Functions, not constants: the language of the process is set after this module is loaded.
const inPrivate = (): string => t('boostshare.le-partage-de-retouches-et-de-themes-n-est-pas')
const goneBoost = (): string => t('boostshare.cette-retouche-n-existe-plus')
const goneSpace = (): string => t('sessions.cet-espace-n-existe-plus')
const noClipboard = (): string => t('themeact.le-presse-papiers-n-est-pas-accessible')
const alreadySharing = (): string => t('boostshare.un-partage-est-deja-en-cours-terminez-le-d')
const sharingOff = (): string => t('boostshare.le-partage-de-retouches-et-de-themes-est-desactive', { settingsPath: settingsPath('boostSharing') })
/** Why a file could not be written, as the sheet says it. */
const notWritten = (error: unknown): string => t('boostshare.le-fichier-n-a-pas-pu-etre-ecrit-reason', { reason: String((error as Error).message ?? error) })

const cancelled = (): ShareReply => ({ ok: false, message: '', cancelled: true })
const fail = (message: string): ShareReply => ({ ok: false, message })

/** One sheet at a time per window: a second request while a dialog is open is answered, not queued behind it. */
const busy = new WeakSet<object>()

async function exclusive(env: ShareEnvironment, run: () => Promise<ShareReply>): Promise<ShareReply> {
  // The switch of the feature, read at every request: with it off, no dialog opens, no file is read, nothing is written.
  if (!env.state().settings.boostSharing) return fail(sharingOff())
  if (busy.has(env.window)) return fail(alreadySharing())
  busy.add(env.window)
  try {
    return await run()
  } finally {
    busy.delete(env.window)
  }
}

/** Shows why something was refused and says so in the reply; the dialog itself failing is logged, the reply still carries the sentence. */
async function problem(env: ShareEnvironment, title: string, sentence: string): Promise<ShareReply> {
  try {
    await env.showProblem(title, sentence)
  } catch (error) {
    console.error('[share] cannot show the dialog:', error)
    env.toast(sentence)
  }
  return { ok: false, message: sentence, shown: true }
}

// ---------- coming in ----------

/** What to do with the text of a Tweak file or link, once it is in memory: judge it, show it, install it if the person agrees. */
async function installFromText(env: ShareEnvironment, text: string, source: 'file' | 'link'): Promise<ShareReply> {
  const title = source === 'file' ? t('boostshare.retouche-refusee') : t('boostshare.lien-de-retouche-refuse')
  // A file may hold one Tweak or all of someone's ("Tout exporter"); a link holds one.
  const read = source === 'file' ? parseBoostFiles(text) : parseBoostLink(text)
  if (!read.ok) return problem(env, title, shareRefusalMessage(read))
  if ('boosts' in read && read.bundle) return installBundle(env, read.boosts, title)
  const parsed = { boost: 'boosts' in read ? read.boosts[0]! : read.boost }
  // Judged by the list of public suffixes: a Tweak matches its site and every subdomain, so it must not aim at a whole family of sites.
  if (env.isWideHost(parsed.boost.host)) return problem(env, title, shareRefusalMessage({ ok: false, reason: 'host-too-wide', detail: parsed.boost.host }))

  const preview = importPreview(parsed.boost, env.state().settings.boostScriptImport)
  const choice = await env.confirmImport(preview)
  if (choice === 'cancel') return cancelled()
  // The window can have become private while the sheet was open: nothing is written then.
  if (env.isPrivate()) return fail(inPrivate())
  const boost: SharedBoost = choice === 'install-without-script' ? { ...parsed.boost, js: '' } : parsed.boost

  const id = env.newId()
  env.dispatch({ type: 'boost/import', id, boost })
  const installed = env.state().boosts.find((b) => b.id === id)
  if (!installed) {
    console.error(`[share] the Tweak "${boost.name}" for ${boost.host} was not installed: the reducer refused it`)
    return problem(env, title, t('boostshare.cette-retouche-n-a-pas-pu-etre-installee'))
  }
  const waiting = installed.jsEnabled === false
  const message = `${t('boostshare.retouche-name-installee', { name: installed.name })}${waiting ? t('boostshare.javascript-desactive-suffix') : ''}`
  env.toast(message)
  return { ok: true, message, boostId: installed.id }
}

/**
 * A file of several Tweaks, once it is in memory and every Tweak of it has passed the reader: all or nothing at the gate (one that aims at a whole
 * family of sites stops the file, named), then one sheet for the file, then one `boost/import` per Tweak: each is read again by the reducer, which
 * gives it a new id, switches it on and keeps its script off.
 */
async function installBundle(env: ShareEnvironment, boosts: SharedBoost[], title: string): Promise<ShareReply> {
  const wide = boosts.findIndex((b) => env.isWideHost(b.host))
  if (wide >= 0) return problem(env, title, shareRefusalMessage({ ok: false, reason: 'host-too-wide', detail: boosts[wide]!.host, entry: wide + 1, entryName: boosts[wide]!.name }))

  const choice = await env.confirmImport(importBundlePreview(boosts, env.state().settings.boostScriptImport))
  if (choice === 'cancel') return cancelled()
  if (env.isPrivate()) return fail(inPrivate())
  const ids = boosts.map(() => env.newId())
  boosts.forEach((boost, index) => env.dispatch({ type: 'boost/import', id: ids[index]!, boost: choice === 'install-without-script' ? { ...boost, js: '' } : boost }))
  const installed = ids.flatMap((id) => env.state().boosts.filter((b) => b.id === id))
  if (installed.length < boosts.length) console.error(`[share] ${boosts.length - installed.length} of the ${boosts.length} Tweaks of a file were not installed: the reducer refused them`)
  if (installed.length === 0) return problem(env, title, t('boostshare.cette-retouche-n-a-pas-pu-etre-installee'))
  const waiting = installed.some((b) => b.jsEnabled === false)
  const base = installed.length === boosts.length ? tp('boostshare.count-retouches-installees', installed.length) : t('boostshare.count-retouches-installees-sur-total', { count: installed.length, total: boosts.length })
  const message = `${base}${waiting ? t('boostshare.javascript-desactive-suffix') : ''}`
  env.toast(message)
  return { ok: true, message }
}

/** "Importer une Retouche…": a file chosen in a dialog. */
export function importBoostFromFile(env: ShareEnvironment): Promise<ShareReply> {
  return exclusive(env, async () => {
    if (env.isPrivate()) return fail(inPrivate())
    const path = await env.chooseOpenFile(t('boostshare.importer-une-retouche'))
    if (path === null) return cancelled()
    // The file may hold all the Tweaks of someone: the bound is that of such a file (a file of one Tweak keeps its own, smaller one in the reader).
    const read = await env.readFile(path, BOOST_BUNDLE_MAX_BYTES)
    if (!read.ok) return problem(env, t('boostshare.retouche-refusee'), fileFailureMessage(read, BOOST_BUNDLE_MAX_BYTES))
    return installFromText(env, read.text, 'file')
  })
}

/** "Coller une Retouche": the link on the clipboard. */
export function importBoostFromClipboard(env: ShareEnvironment): Promise<ShareReply> {
  return exclusive(env, async () => {
    if (env.isPrivate()) return fail(inPrivate())
    let text: string
    try {
      text = await env.readClipboard()
    } catch (error) {
      console.error('[share] cannot read the clipboard:', error)
      return fail(noClipboard())
    }
    return installFromText(env, text, 'link')
  })
}

// ---------- going out ----------

/** The Tweak as it will be shared, once the person has decided about its script; null when they cancel, or a reply when it cannot be shared. */
async function boostToShare(env: ShareEnvironment, boostId: string): Promise<{ boost: SharedBoost } | { reply: ShareReply }> {
  const stored = env.state().boosts.find((b) => b.id === boostId)
  if (!stored) return { reply: fail(goneBoost()) }
  let withScript = false
  if (stored.js.trim() !== '') {
    // Said out loud, with the way out: the person may send the Tweak without the script.
    const choice = await env.confirmExportScript(stored.name, scriptExportWarning())
    if (choice === 'cancel') return { reply: cancelled() }
    withScript = choice === 'with-script'
  }
  const shared = shareableBoost(stored, withScript)
  if (!shared.ok) return { reply: await problem(env, t('boostshare.cette-retouche-ne-peut-pas-etre-partagee'), shareRefusalMessage(shared)) }
  return { boost: shared.boost }
}

/** "Exporter cette Retouche…": a file the person names. */
export function exportBoostToFile(env: ShareEnvironment, boostId: string): Promise<ShareReply> {
  return exclusive(env, async () => {
    if (env.isPrivate()) return fail(inPrivate())
    const chosen = await boostToShare(env, boostId)
    if ('reply' in chosen) return chosen.reply
    const path = await env.chooseSaveFile(t('boostshare.exporter-la-retouche'), shareFileName(chosen.boost.name, BOOST_EXTENSION), BOOST_EXTENSION)
    if (path === null) return cancelled()
    try {
      await env.writeFile(path, boostFileText(chosen.boost))
    } catch (error) {
      console.error(`[share] cannot write ${path}:`, error)
      return problem(env, t('boostshare.export-impossible'), notWritten(error))
    }
    const message = t('boostshare.retouche-name-exportee', { name: chosen.boost.name })
    env.toast(message)
    return { ok: true, message }
  })
}

/**
 * "Tout exporter…": every Tweak in one file the person names, which "Importer une Retouche…" reads back. A script is asked about once for the whole file,
 * as for one Tweak. A Tweak that cannot be shared is left out and named in a sheet after the file is written, so that it does not stop the others.
 */
export function exportAllBoostsToFile(env: ShareEnvironment): Promise<ShareReply> {
  return exclusive(env, async () => {
    if (env.isPrivate()) return fail(inPrivate())
    const all = env.state().boosts
    if (all.length === 0) return fail(t('boostshare.aucune-retouche-a-exporter'))
    const scripted = all.filter((b) => b.js.trim() !== '')
    let withScript = false
    if (scripted.length > 0) {
      const choice = await env.confirmExportScript('', scriptExportWarning(), scripted.map((b) => b.name))
      if (choice === 'cancel') return cancelled()
      withScript = choice === 'with-script'
    }
    const title = t('boostshare.ces-retouches-ne-peuvent-pas-etre-partagees')
    const shared = shareableBoosts(all, withScript)
    if (!shared.ok) return problem(env, title, shareRefusalMessage(shared))
    const leftSentence = shared.left.map(({ name, refusal }) => t('boostshare.name-sentence', { name, sentence: shareRefusalMessage(refusal) })).join('\n')
    if (shared.boosts.length === 0) return problem(env, title, leftSentence)
    const file = boostsFileText(shared.boosts)
    if (!file.ok) return problem(env, title, shareRefusalMessage(file))
    const path = await env.chooseSaveFile(t('boostshare.exporter-toutes-les-retouches'), shareFileName('retouches-lucium', BOOST_EXTENSION), BOOST_EXTENSION)
    if (path === null) return cancelled()
    try {
      await env.writeFile(path, file.text)
    } catch (error) {
      console.error(`[share] cannot write ${path}:`, error)
      return problem(env, t('boostshare.export-impossible'), notWritten(error))
    }
    const message = tp('boostshare.count-retouches-exportees', shared.boosts.length)
    env.toast(message)
    // The file is written; what was left out is said, with its reason, so that nobody believes a Tweak is in a file it is not in.
    if (shared.left.length > 0) await problem(env, tp('boostshare.count-retouches-ne-sont-pas-dans-le-fichier', shared.left.length), leftSentence)
    return { ok: true, message }
  })
}

/** "Copier le lien de cette Retouche": the link on the clipboard. */
export function copyBoostLink(env: ShareEnvironment, boostId: string): Promise<ShareReply> {
  return exclusive(env, async () => {
    if (env.isPrivate()) return fail(inPrivate())
    const chosen = await boostToShare(env, boostId)
    if ('reply' in chosen) return chosen.reply
    try {
      await env.writeClipboard(boostLink(chosen.boost))
    } catch (error) {
      console.error('[share] cannot write to the clipboard:', error)
      env.toast(noClipboard())
      return fail(noClipboard())
    }
    const message = t('boostshare.lien-de-la-retouche-name-copie', { name: chosen.boost.name })
    env.toast(message)
    return { ok: true, message }
  })
}

/**
 * A share ends with a reply whatever happens: an exception (a sheet that cannot be shown, a window that closed under it) is logged with its
 * context, said in a toast and answered, never left as a promise that rejects in the interface.
 */
export async function answering(run: () => Promise<ShareReply>, toast: (message: string) => void): Promise<ShareReply> {
  try {
    return await run()
  } catch (error) {
    console.error('[share] a share failed:', error)
    const message = t('boostshare.le-partage-a-echoue-reason', { reason: String((error as Error).message ?? error) })
    toast(message)
    return { ok: false, message, shown: true }
  }
}

/** One request of the interface. */
export function runBoostShareRequest(env: ShareEnvironment, request: BoostShareRequest): Promise<ShareReply> {
  switch (request.kind) {
    case 'import-file':
      return importBoostFromFile(env)
    case 'import-link':
      return importBoostFromClipboard(env)
    case 'export-file':
      return exportBoostToFile(env, request.boostId)
    case 'copy-link':
      return copyBoostLink(env, request.boostId)
    case 'export-all':
      return exportAllBoostsToFile(env)
  }
}

// ---------- themes, as files ----------

export const THEME_EXTENSION = 'lucium-theme'

// Getters: the language of the process is set after this module is loaded. The words are those of a line of the sheet, in lower case.
const HARMONY_LABEL: Record<SpaceTheme['harmony'], string> = {
  get complementary() { return t('boostshare.complementaire') },
  get analogous() { return t('boostshare.analogue') },
  get triadic() { return t('boostshare.triade') },
  get monochrome() { return t('boostshare.monochrome') },
  get custom() { return t('boostshare.libre') }
}
const APPEARANCE_LABEL: Record<SpaceTheme['appearance'], string> = {
  get auto() { return t('boostshare.automatique') },
  get light() { return t('boostshare.claire') },
  get dark() { return t('boostshare.sombre') }
}
const OVERLAY_LABEL: Record<SpaceTheme['overlay'], string> = {
  get none() { return t('boostshare.aucune') },
  get grain() { return t('boostshare.grain') },
  get fine() { return t('boostshare.fine') },
  get coarse() { return t('boostshare.grossiere') }
}

/** The few lines that tell what a theme is, for the sheet before it is applied. */
export function describeTheme(theme: SpaceTheme): string {
  return [
    t('boostshare.couleurs-colors', { colors: theme.baseColors.join(', ') }),
    t('boostshare.harmonie-harmony', { harmony: HARMONY_LABEL[theme.harmony] }),
    t('boostshare.apparence-appearance', { appearance: APPEARANCE_LABEL[theme.appearance] }),
    t('boostshare.texture-texture', { texture: OVERLAY_LABEL[theme.overlay] })
  ].join('\n')
}

/** "Exporter le thème dans un fichier…" in the menu of a space. */
export function exportThemeToFile(env: ShareEnvironment, spaceId: string): Promise<ShareReply> {
  return exclusive(env, async () => {
    if (env.isPrivate()) return fail(inPrivate())
    const space = env.state().spaces.find((s) => s.id === spaceId)
    if (!space) return fail(goneSpace())
    const path = await env.chooseSaveFile(t('boostshare.exporter-le-theme'), shareFileName(space.name, THEME_EXTENSION), THEME_EXTENSION)
    if (path === null) return cancelled()
    try {
      await env.writeFile(path, themeFileText(space.theme, space.name))
    } catch (error) {
      console.error(`[share] cannot write ${path}:`, error)
      return problem(env, t('boostshare.export-impossible'), notWritten(error))
    }
    const message = t('boostshare.theme-de-name-exporte', { name: space.name })
    env.toast(message)
    return { ok: true, message }
  })
}

/** "Importer un thème depuis un fichier…": the file is read like a Tweak's, shown, and applied to the space only if the person agrees. */
export function importThemeFromFile(env: ShareEnvironment, spaceId: string): Promise<ShareReply> {
  return exclusive(env, async () => {
    if (env.isPrivate()) return fail(inPrivate())
    if (!env.state().spaces.some((s) => s.id === spaceId)) return fail(goneSpace())
    // Said before a file is asked for; asked again after the sheet, the lock may come while it is read.
    const locked = (): string | null => spaceLookRefusal(spaceId, env.lockedSpaces?.() ?? [])
    const refusal = locked()
    if (refusal !== null) return fail(refusal)
    const path = await env.chooseOpenFile(t('boostshare.importer-un-theme'))
    if (path === null) return cancelled()
    const read = await env.readFile(path, THEME_FILE_MAX_BYTES)
    if (!read.ok) return problem(env, t('boostshare.theme-refuse'), fileFailureMessage(read, THEME_FILE_MAX_BYTES))
    const parsed = parseThemeFile(read.text)
    if (!parsed.ok) return problem(env, t('boostshare.theme-refuse'), shareRefusalMessage(parsed))
    // The state is read after the sheet: the space can be gone by then.
    const space = env.state().spaces.find((s) => s.id === spaceId)
    if (!space) return fail(goneSpace())
    const label = parsed.name || t('boostshare.sans-nom')
    const agreed = await env.confirmThemeImport(t('boostshare.appliquer-le-theme-label-a-l-espace-name', { label, name: space.name }), `${describeTheme(parsed.theme)}\n\n${t('boostshare.le-theme-de-l-espace-est-remplace-le-fichier')}`)
    if (!agreed) return cancelled()
    if (env.isPrivate() || !env.state().spaces.some((s) => s.id === spaceId)) return fail(goneSpace())
    const lockedSince = locked()
    if (lockedSince !== null) return fail(lockedSince)
    env.dispatch({ type: 'space/update', id: spaceId, patch: { theme: parsed.theme } })
    const message = t('boostshare.theme-label-applique', { label })
    env.toast(message)
    return { ok: true, message }
  })
}

/** One theme file request of the interface. */
export function runThemeFileRequest(env: ShareEnvironment, request: ThemeFileRequest): Promise<ShareReply> {
  return request.kind === 'export-file' ? exportThemeToFile(env, request.spaceId) : importThemeFromFile(env, request.spaceId)
}
