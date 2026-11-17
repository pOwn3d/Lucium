// Who may be granted a web permission, and what the prompt says. The origin of a page is not enough to decide: `new URL(...).origin`
// is the string 'null' for every `file:`, `data:`, `about:blank` and `chrome-extension:` page, so the decision is taken on the protocol
// of the URL that asks, and an answer is only ever remembered for a real web origin.

import { isAppScheme } from './external-links'
import { HARDWARE_PERMISSIONS } from './web-hardware'
import { t } from './i18n'
import type { PermissionDecision } from './model'

/**
 * Granted without asking: they cannot expose anything about the user or their machine. The last three are the ones a question would only
 * get in the way of, as in every other browser: `screen-wake-lock` keeps the screen on while the page is on show (a call, a video, a
 * recipe), `persistent-storage` asks that the site's own data is not evicted when the disk fills, and `background-sync` lets a site send
 * what was written offline once the network is back.
 */
export const GRANTED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'screen-wake-lock', 'persistent-storage', 'background-sync'])

/**
 * Refused without asking, whoever asks. `keyboardLock` lets a page in full screen keep Escape for itself: a page in full screen covers the whole
 * window, the address included, and the notice drawn over it when it takes the window (fullscreen-notice.ts) tells to press Escape, so Escape
 * must always be the way out. A question would be of no use: it would be drawn under the page that fills the window.
 */
export const ALWAYS_REFUSED_PERMISSIONS: ReadonlySet<string> = new Set(['keyboardLock'])

/**
 * Refused to a web page without a question: there is nothing here the user could say yes to. No headset and no NFC reader on a Mac (`ar`,
 * `vr`, `hand-tracking`, `nfc`); features only an installed web application of another system gets (`smart-card`, `web-printing`,
 * `web-app-installation`, `automatic-fullscreen`, `periodic-background-sync`); a download that goes on with no page and no line in the
 * downloads (`background-fetch`); a lock on the sleep of the machine no page is given (`system-wake-lock`); and a request the engine
 * cannot even name (`unknown`).
 */
export const REFUSED_PERMISSIONS: ReadonlySet<string> = new Set(['ar', 'vr', 'hand-tracking', 'nfc', 'smart-card', 'web-printing', 'web-app-installation', 'automatic-fullscreen', 'periodic-background-sync', 'background-fetch', 'system-wake-lock', 'unknown'])

/**
 * How long a permission question must have been on screen before « Autoriser » counts. Shorter than the time a person needs to see the bubble and
 * decide; long enough that a click the page had the user aim elsewhere, just before it asked, does not land on the button: the bubble comes at a
 * place a page can foresee (under the toolbar, in the middle), at a moment the page chooses. The shell refuses such an answer and the bubble
 * keeps its button off for that time, each question counting its own wait. « Refuser » and Escape answer at once.
 */
export const PERMISSION_ARM_MS = 500

/**
 * Permissions whose answer is never kept. `openExternal` hands one address to another application: what was allowed for one scheme
 * (a mail link) must not go with the origin to every other scheme (a link to an app that deletes or installs). A yes can be kept for one
 * scheme of one site only, under a name of its own (`appLinkPermission`). `fileSystem` is about one file or one folder of the user, in one
 * mode: a yes for a document must not become a yes for every folder the site later holds a handle to.
 */
const NEVER_REMEMBERED: ReadonlySet<string> = new Set(['openExternal', 'fileSystem'])

/** What the name of a kept answer about the links to another application starts with; the scheme follows (`openExternal:zoommtg:`). */
const APP_LINK_PREFIX = 'openExternal:'

/**
 * The name under which « Toujours ouvrir les liens de ce type depuis ce site » is kept for a site: one name for each scheme, so that a yes for
 * the links of a meeting application says nothing of any other application. Null for a scheme that is not one of another application's.
 */
export function appLinkPermission(scheme: string): string | null {
  return isAppScheme(scheme) ? `${APP_LINK_PREFIX}${scheme}` : null
}

/** The scheme a kept answer about the links to another application is for (`zoommtg:`), or null when the name is not one of those. */
export function appLinkSchemeOf(permission: string): string | null {
  if (!permission.startsWith(APP_LINK_PREFIX)) return null
  const scheme = permission.slice(APP_LINK_PREFIX.length)
  return isAppScheme(scheme) ? scheme : null
}

/**
 * Permissions a page of an extension does not get on the strength of its manifest: they show the user's screen, or act on what is shown of it,
 * and only a web page is asked.
 */
const WEB_PAGES_ONLY: ReadonlySet<string> = new Set(['display-capture', 'captured-surface-control'])

/**
 * The permissions a page of an extension is granted when its manifest declares them, by the name the manifest gives them. The approximate
 * position goes with `geolocation`, and the older way to read what was copied (`document.execCommand('paste')`) with `clipboardRead`.
 */
const EXTENSION_MANIFEST_GRANTS: Readonly<Record<string, string>> = {
  notifications: 'notifications',
  geolocation: 'geolocation',
  'geolocation-approximate': 'geolocation',
  'clipboard-read': 'clipboardRead',
  'deprecated-sync-clipboard-read': 'clipboardRead'
}

/**
 * What a page of an extension is asked for, like a web page, unless its manifest grants it (above): the camera and the microphone, another
 * application, the position, the notices, what was copied, the instruments and the screens. No manifest entry covers the first two, and the
 * installation review never showed them. The list of the fonts installed (`local-fonts`) is asked for too: no manifest entry stands for it either.
 */
const EXTENSION_ASKED: ReadonlySet<string> = new Set(['media', 'openExternal', 'midi', 'midiSysex', 'idle-detection', 'window-management', 'local-fonts', ...Object.keys(EXTENSION_MANIFEST_GRANTS)])

/**
 * What a page of an extension is granted without a question, by name: what an installed extension does as a matter of course. It talks to a
 * program of the machine or of the local network (a password manager, a companion application), plays protected media, reads its own storage
 * from a frame, picks an audio output, reads the motion sensors, and reads or writes the file its user picked in the system's own box. The list is closed: a permission a later engine brings is refused to a page
 * of an extension until it is given a place here, in `EXTENSION_ASKED` or in a refusal (permissions.test.ts fails on a name nobody placed).
 */
const EXTENSION_GRANTED: ReadonlySet<string> = new Set(['fileSystem', 'local-network', 'local-network-access', 'loopback-network', 'mediaKeySystem', 'payment-handler', 'sensors', 'speaker-selection', 'storage-access', 'top-level-storage-access'])

/** The `permissions` of the manifest of an installed extension, by its id; undefined when the extension is not loaded. */
export type ManifestPermissionsOf = (extensionId: string) => readonly unknown[] | undefined

/**
 * What the engine does with a request: grant it, refuse it, let the policy (the user's remembered answers, then a prompt) decide, or hand it to
 * the web hardware service (WebHID, WebUSB, Web Serial), which has its own register and never reads the remembered answers.
 */
export type PermissionRoute = { kind: 'grant' } | { kind: 'deny'; notOffered?: true } | { kind: 'policy'; origin: string } | { kind: 'hardware' }

/** What a web origin gets for a permission: the question, unless the permission is one no page is offered here (`notOffered`, for the log). */
const routeWebPermission = (permission: string, origin: string): PermissionRoute => (REFUSED_PERMISSIONS.has(permission) ? { kind: 'deny', notOffered: true } : { kind: 'policy', origin })

/**
 * Routes a request by the URL that makes it. A page of an installed extension is granted what its manifest declares, and asked like a web
 * page for the camera, the microphone, another application and the rest of `EXTENSION_ASKED` (under its `chrome-extension://<id>` origin,
 * never remembered); a web page goes to the policy under its real origin; anything else (`file:`, `about:blank`, `data:`, an address that
 * does not parse) has no origin to hold an answer for and is refused without a question.
 * `inheritedOrigin`: the origin an `about:blank` or `about:srcdoc` document runs under, the one of the page that opened or embedded it (Chromium gives
 * it as the security origin of the request). Such a document, a window Slack opens for a call and writes into for example, is judged as that page:
 * without it, the call window of Slack was refused the microphone although app.slack.com was allowed it.
 */
export function routePermission(permission: string, requestingUrl: string, manifestPermissionsOf?: ManifestPermissionsOf, inheritedOrigin?: string): PermissionRoute {
  // Before everything else: a page of an extension is not granted a device on its manifest, and a remembered "allow" in a state file opens nothing.
  if (HARDWARE_PERMISSIONS.has(permission)) return { kind: 'hardware' }
  if (ALWAYS_REFUSED_PERMISSIONS.has(permission)) return { kind: 'deny' }
  if (GRANTED_PERMISSIONS.has(permission)) return { kind: 'grant' }
  if (!URL.canParse(requestingUrl)) return { kind: 'deny' }
  const url = new URL(requestingUrl)
  if (url.protocol === 'chrome-extension:') return routeExtensionPermission(permission, url.hostname, manifestPermissionsOf)
  if (url.protocol === 'http:' || url.protocol === 'https:') return routeWebPermission(permission, url.origin)
  // A document with no address of its own runs under the origin of its opener or its parent: a web origin there is the site that asks.
  if (url.protocol === 'about:' && (url.pathname === 'blank' || url.pathname === 'srcdoc') && inheritedOrigin !== undefined && URL.canParse(inheritedOrigin)) {
    const inherited = new URL(inheritedOrigin)
    if (inherited.protocol === 'http:' || inherited.protocol === 'https:') return routeWebPermission(permission, inherited.origin)
  }
  return { kind: 'deny' }
}

function routeExtensionPermission(permission: string, extensionId: string, manifestPermissionsOf: ManifestPermissionsOf | undefined): PermissionRoute {
  if (WEB_PAGES_ONLY.has(permission)) return { kind: 'deny' }
  const declaredAs = EXTENSION_MANIFEST_GRANTS[permission]
  if (declaredAs !== undefined && manifestPermissionsOf?.(extensionId)?.includes(declaredAs)) return { kind: 'grant' }
  // The origin of an extension's page is the string 'null' for URL: the prompt names the extension's own address instead.
  if (EXTENSION_ASKED.has(permission)) return /^[a-p]{32}$/.test(extensionId) ? { kind: 'policy', origin: `chrome-extension://${extensionId}` } : { kind: 'deny' }
  if (EXTENSION_GRANTED.has(permission)) return { kind: 'grant' }
  // What no page is offered here, and a name this list does not know: refused, and said in the log, never granted for want of a rule.
  return { kind: 'deny', notOffered: true }
}

/**
 * The layer of the permission bubble, in CSS pixels: the bubble's 360 px with 16 px on each side for its shadow, and the height of a question with a
 * long site name and a few lines of explanation. The shell places it at the top edge of the page card, centred.
 */
export const PERMISSION_LAYER = { width: 392, height: 232 }

/** What the bubble hangs from, in the coordinates of its layer: the strip along its top edge, which is the foot of the toolbar (the address). */
export const PERMISSION_ANCHOR = { x: 0, y: -4, width: PERMISSION_LAYER.width, height: 4 }

/** The "origin" under which an answer for every site is kept. */
export const ALL_SITES = '*'

/**
 * What may be answered for every site at once. A notice shown on a page gives nothing away; the camera, the microphone, the position, the screen and the
 * rest are always asked site by site, whatever a state file says under `ALL_SITES`.
 */
const ANSWERABLE_FOR_ALL: ReadonlySet<string> = new Set(['notifications'])

/** The remembered answer for a site and a permission: the site's own, else the one for every site when this permission may have one. */
export function rememberedDecision(sitePermissions: Record<string, Record<string, PermissionDecision>>, origin: string, permission: string): PermissionDecision | undefined {
  const own = sitePermissions[origin]?.[permission]
  if (own) return own
  return ANSWERABLE_FOR_ALL.has(permission) ? sitePermissions[ALL_SITES]?.[permission] : undefined
}

/** The sites that have an answer of their own to list, with those answers: the record for every site is its own menu, not a site, and a site left without an answer has no line. */
export function sitesWithAnswers(sitePermissions: Record<string, Record<string, PermissionDecision>>): Array<[origin: string, answers: Record<string, PermissionDecision>]> {
  return Object.entries(sitePermissions).filter(([origin, answers]) => origin !== ALL_SITES && Object.keys(answers).length > 0)
}

/** One line of the permissions of the site on show (site panel): what the site was answered, and what stands in place when it was not. */
export interface SitePermissionRow {
  permission: string
  /** The site's own answer; undefined while it has none (the question is asked, or the answer for every site stands). */
  own: PermissionDecision | undefined
  /** The answer for every site that stands for this site, when it has no answer of its own: only ever notifications (`ANSWERABLE_FOR_ALL`). */
  everywhere: PermissionDecision | undefined
}

/**
 * The permissions of one site, in the order the panel shows them: the camera and the microphone first when the panel offers them (`media`: they can be
 * answered before a page asks), then every answer the site was given, then the notifications of the answer for every site when that is all there is.
 * `answers` is the record of origins of the profile (`sitePermissions`) or of a container, which has no answer for every site.
 */
export function sitePermissionRows(answers: Record<string, Record<string, PermissionDecision>>, origin: string, media: boolean): SitePermissionRow[] {
  const own = answers[origin] ?? {}
  const rows: SitePermissionRow[] = media ? [{ permission: MEDIA_PERMISSION, own: own[MEDIA_PERMISSION], everywhere: undefined }] : []
  for (const [permission, decision] of Object.entries(own)) if (permission !== MEDIA_PERMISSION) rows.push({ permission, own: decision, everywhere: undefined })
  // `rememberedDecision` is what the engine asks: it says whether the answer for every site stands for this permission and this site.
  const standing = rememberedDecision(answers, origin, 'notifications')
  if (own['notifications'] === undefined && standing !== undefined) rows.push({ permission: 'notifications', own: undefined, everywhere: standing })
  return rows
}

/** What the choice of a row ("Demander", "Autoriser", "Bloquer") asks of the state: `null` is no answer kept, which is "ask" (or the answer for every site). */
export const decisionOfChoice = (choice: string): PermissionDecision | null => (choice === 'allow' || choice === 'deny' ? choice : null)

/** True when an answer for this origin and permission may be kept: a real web origin, and not a permission that is asked each time. */
export function mayRemember(origin: string, permission: string): boolean {
  if (NEVER_REMEMBERED.has(permission)) return false
  // A name that looks like an answer about the links to an application, for a scheme that never leaves: nothing is kept, and nothing read.
  if (permission.startsWith(APP_LINK_PREFIX) && appLinkSchemeOf(permission) === null) return false
  return /^https?:\/\/[^/\s]+$/i.test(origin) && origin !== 'null'
}

/** The scheme an `openExternal` request wants to open, as shown in the prompt (`mailto:`), or '' when the address is not one. */
export function externalSchemeOf(externalUrl: unknown): string {
  // Cut short: the scheme comes from a page, and it is printed in a prompt.
  return typeof externalUrl === 'string' && URL.canParse(externalUrl) ? new URL(externalUrl).protocol.slice(0, 40) : ''
}

/**
 * What each permission is called in the question ("<site> souhaite …"); a lookup of the catalogue each time, so that the language chosen later counts.
 * Every permission the engine can ask a page's question for has its words here (permissions.test.ts reads the engine's own list): the name
 * the engine gives a permission (« storage-access ») is not something to put in front of the user.
 */
const PERMISSION_LABELS: Record<string, () => string> = {
  geolocation: () => t('permissions.connaitre-votre-position'),
  'geolocation-approximate': () => t('permissions.connaitre-votre-position-approximative'),
  media: () => t('permissions.utiliser-votre-camera-ou-votre-micro'),
  notifications: () => t('permissions.vous-envoyer-des-notifications'),
  midi: () => t('permissions.acceder-a-vos-appareils-midi'),
  midiSysex: () => t('permissions.reconfigurer-vos-appareils-midi'),
  'clipboard-read': () => t('permissions.lire-le-presse-papiers'),
  // The old way to read what was copied (`document.execCommand('paste')`): the same thing asked for.
  'deprecated-sync-clipboard-read': () => t('permissions.lire-le-presse-papiers'),
  'storage-access': () => t('permissions.utiliser-ses-cookies-dans-la-page-qui-l-integre'),
  'top-level-storage-access': () => t('permissions.laisser-un-site-integre-utiliser-ses-cookies'),
  'local-fonts': () => t('permissions.lire-la-liste-de-vos-polices'),
  'speaker-selection': () => t('permissions.choisir-la-sortie-audio'),
  'local-network-access': () => t('permissions.se-connecter-a-votre-reseau-local'),
  'local-network': () => t('permissions.se-connecter-a-votre-reseau-local'),
  'loopback-network': () => t('permissions.se-connecter-aux-logiciels-de-ce-mac'),
  'payment-handler': () => t('permissions.s-enregistrer-comme-moyen-de-paiement'),
  sensors: () => t('permissions.utiliser-les-capteurs-de-ce-mac'),
  mediaKeySystem: () => t('permissions.identifier-ce-mac-pour-les-contenus-proteges'),
  'captured-surface-control': () => t('permissions.piloter-l-onglet-partage'),
  'display-capture': () => t('permissions.partager-votre-ecran-ou-une-fenetre'),
  'idle-detection': () => t('permissions.savoir-quand-vous-etes-inactif'),
  'window-management': () => t('permissions.gerer-vos-fenetres-et-ecrans'),
  openExternal: () => t('permissions.ouvrir-une-application-externe'),
  fileSystem: () => t('permissions.acceder-a-un-fichier-ou-un-dossier')
}

/** How a remembered answer names the permission in the site panel and in Settings; the ones without a name here show their own. */
const PERMISSION_NAMES: Record<string, () => string> = {
  'display-capture': () => t('permissions.partage-d-ecran'),
  geolocation: () => t('permissions.position'),
  'geolocation-approximate': () => t('permissions.position-approximative'),
  notifications: () => t('permissions.notifications'),
  midi: () => t('permissions.appareils-midi'),
  midiSysex: () => t('permissions.appareils-midi-controle-complet'),
  'clipboard-read': () => t('permissions.presse-papiers'),
  'deprecated-sync-clipboard-read': () => t('permissions.presse-papiers'),
  'storage-access': () => t('permissions.cookies-dans-une-page-integree'),
  'top-level-storage-access': () => t('permissions.cookies-des-sites-integres'),
  'local-fonts': () => t('permissions.polices-installees'),
  'speaker-selection': () => t('permissions.sortie-audio'),
  'local-network-access': () => t('permissions.reseau-local'),
  'local-network': () => t('permissions.reseau-local'),
  'loopback-network': () => t('permissions.logiciels-de-ce-mac'),
  'payment-handler': () => t('permissions.moyen-de-paiement'),
  sensors: () => t('permissions.capteurs'),
  mediaKeySystem: () => t('permissions.contenus-proteges'),
  'captured-surface-control': () => t('permissions.controle-de-l-onglet-partage'),
  'idle-detection': () => t('permissions.detection-d-inactivite'),
  'window-management': () => t('permissions.fenetres-et-ecrans')
}

export function permissionName(permission: string): string {
  if (permission === MEDIA_PERMISSION) return t('permissions.camera-et-micro')
  const scheme = appLinkSchemeOf(permission)
  if (scheme !== null) return t('permissions.liens-vers-une-autre-application', { scheme })
  return PERMISSION_NAMES[permission]?.() ?? permission
}

/** What a page asks for with getUserMedia: one answer for the camera and the microphone together. */
export const MEDIA_PERMISSION = 'media'

/**
 * Whether a window of the browser has a panel for the question of a page: one of its own pages does, except the preview. The preview is itself the panel on
 * show, so a question put in the queue behind it waits for it to close, which ends the page that asked (Meet opened as a preview was never given the camera).
 */
export const hasQuestionPanel = (owned: boolean, preview: boolean): boolean => owned && !preview

/**
 * Where the question of a permission is put. A tab has a panel in its window; a popup, and the page of a window that is not a tab (a link opened in a mini window, a web
 * app) have none, and a question put in the panel of another window is one nobody sees: the system's sheet is put on the window of the page itself.
 * `panel` is whether a window of the browser has a panel for the page (undefined: the page is not known, which is how it always was: the panel).
 */
export function questionPlace(popup: boolean, panel: boolean | undefined): 'panel' | 'sheet' {
  return popup || panel === false ? 'sheet' : 'panel'
}

/** What the sheet of the system says when a window without a panel asks: who, what, and that the answer is not kept (there is no box to tick for it). */
export function permissionSheet(origin: string, permission: string, detail?: string): { message: string; detail: string; deny: string; allow: string } {
  return {
    message: t('permissions.site-souhaite', { site: origin.replace(/^https?:\/\//, ''), what: permissionPhrase(permission, detail) }),
    detail: t('permissions.ce-choix-n-est-pas-memorise'),
    deny: t('permissions.refuser'),
    allow: t('permissions.autoriser')
  }
}

/** The longest path printed in a question; a longer one keeps its two ends (the volume and the name). */
const PATH_SHOWN_MAX = 160

/** A path as a question prints it: nothing that hides or reorders what is read (control and direction characters), and a bounded length. */
function shownPath(path: string): string {
  const plain = path.replace(/[\p{Cc}​-‏‪-‮⁠-⁩﻿]/gu, '?')
  return plain.length <= PATH_SHOWN_MAX ? plain : `${plain.slice(0, 50)}…${plain.slice(-(PATH_SHOWN_MAX - 51))}`
}

/**
 * What a `fileSystem` request (File System Access) wants, in the words of the question: read or modify, a file or a folder, and which one. ''
 * when the request names no path: the question then says the least (« accéder à un fichier ou à un dossier »).
 */
export function fileSystemDetail(details: unknown): string {
  if (typeof details !== 'object' || details === null) return ''
  const { filePath, isDirectory, fileAccessType } = details as { filePath?: unknown; isDirectory?: unknown; fileAccessType?: unknown }
  if (typeof filePath !== 'string' || filePath === '') return ''
  const path = shownPath(filePath)
  // Anything that is not plainly a read is told as a change: the stronger of the two.
  const read = fileAccessType === 'readable'
  if (isDirectory === true) return read ? t('permissions.lire-le-dossier-path', { path }) : t('permissions.modifier-le-dossier-path', { path })
  return read ? t('permissions.lire-le-fichier-path', { path }) : t('permissions.modifier-le-fichier-path', { path })
}

/**
 * What the prompt says the site wants to do. For `openExternal`, `detail` is the scheme asked for: the user must see what would open. For
 * `fileSystem`, it is the whole phrase (`fileSystemDetail`): the file or the folder, and whether it is read or modified.
 */
export function permissionPhrase(permission: string, detail?: string): string {
  // The last resort names the permission as the engine does: only for a name that came after this list was written.
  if (permission === 'fileSystem' && detail) return detail
  // The question that offers « Toujours ouvrir… » is the question of `openExternal`, in the same words, with the scheme.
  const scheme = appLinkSchemeOf(permission)
  if (scheme !== null) return `${t('permissions.ouvrir-une-application-externe')} (${detail ?? scheme})`
  const label = PERMISSION_LABELS[permission]?.() ?? t('permissions.utiliser-permission', { permission })
  return permission === 'openExternal' && detail ? `${label} (${detail})` : label
}
