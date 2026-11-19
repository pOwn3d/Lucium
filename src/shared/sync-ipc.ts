// What the Settings page « Synchronisation » (src/renderer/SyncSettings.tsx) and the main process say to each other (docs/synchronisation.md §13.1): the requests the
// page may make, the state the main process gives back, and the check of a request. The synchronisation itself lives in the main process (src/main/sync/); the page
// holds no secret and no key, it asks and it draws. The main process checks every request again (parseSyncRequest) and refuses anything that is not exactly one of these.
//
// Pure: no Electron, no Node.

/**
 * The categories the person ticks (§10.1). A category passes only when both devices ticked it. `todayTabs` (§27, card 508) is the data side of the shared Today tabs: its
 * row on the page, its sentence and its box at the pairing are the interface cards'; `openTabs` goes when « Reprendre un onglet du Mac » does [Q8].
 */
export const SYNC_CATEGORIES = ['structure', 'settings', 'archive', 'openTabs', 'todayTabs'] as const
export type SyncCategory = (typeof SYNC_CATEGORIES)[number]

/**
/**
 * The categories that cannot be ticked without « Espaces et dossiers » (`structure`): what they carry hangs on a space (`spaceId`: the archive, the Today tabs), and the spaces
 * travel with the structure (§10.1, §27.2). Without it the merge finds no space for them, takes each for dangling (§11.7.1) and removes it. The page greys the row while the
 * structure is unticked and the service refuses it and unticks it with the structure (card 510); a session announces and takes them as common only with the structure,
 * whatever is ticked (`announcedCategories`, `commonCategories`: card 516).
 */
export const NEEDS_STRUCTURE: readonly SyncCategory[] = ['archive', 'todayTabs']

/** [Q2]: only the structure is ticked by default; the settings, the archive, the open tabs and the Today tabs [Q9] are the person's choice, each with its own sentence. */
export const DEFAULT_SYNC_CATEGORIES: Readonly<Record<SyncCategory, boolean>> = { structure: true, settings: false, archive: false, openTabs: false, todayTabs: false }

/** What the page asks. `status` is asked about once a second while the page is open (it carries the countdowns); `leave` is sent when the page is left (the sheet of a pairing goes with it). */
export type SyncRequest =
  | { kind: 'status' }
  | { kind: 'enable'; on: boolean }
  | { kind: 'category'; category: SyncCategory; on: boolean }
  | { kind: 'pair-start' }
  | { kind: 'pair-close' }
  /** `shareToday`: the box « Partager aussi les onglets d'Aujourd'hui » of the question (§27.8 [Q9]), unticked unless the person ticked it. Only meaningful with `allow`. */
  | { kind: 'answer'; allow: boolean; shareToday?: boolean }
  | { kind: 'forget'; id: string }
  | { kind: 'leave' }

export interface SyncDeviceView {
  id: string
  name: string
  platform: 'mac' | 'ios'
  pairedAt: number
  lastSessionAt: number | null
}

/** The sheet of « Ajouter un iPhone »: what is drawn, and what is typed when the iPhone has no camera. The secret is in it, and only the page that asked is given it. */
export interface SyncPairingView {
  /** The text the QR carries (`lucium-sync:1/…`): the page draws it, it does not read it. */
  qr: string
  /** The secret as a person types it (`ABCDE-FGHIJ-…`) and the address to go with it (`mac-de-….local:49213`). */
  code: string
  address: string
  /** The milliseconds before the secret expires. */
  remainingMs: number
}

/**
 * The question the Mac asks the person once the iPhone has proved it holds the secret: « Un iPhone nommé « … » demande à s'appairer ». It carries what lets the person
 * tell the iPhone they scanned for from another one (review n° 9 and 21): the six characters the iPhone shows too (docs/synchronisation.md §4.6), and the address the request
 * came from.
 */
export interface SyncConfirmView {
  name: string
  /** Six characters made of the two fingerprints: the iPhone that is really connected shows the same ones. */
  code: string
  /** The source address of the connection, as the system gave it (`192.168.1.40`). */
  address: string
  /**
   * false: « Autoriser » or « Refuser ». true: the person allowed, and the Mac waits for the iPhone's person to compare the code and say yes; nothing is kept before. The
   * sheet keeps the code on screen and offers « Annuler ».
   */
  waiting: boolean
  /** The milliseconds before no answer becomes a refusal. */
  remainingMs: number
}

/** Why the synchronisation could not do what was asked; the page says it in words of the catalogue (`sync.error.<code>`). */
export type SyncProblem = 'unavailable' | 'port' | 'identity' | 'identity-unopenable' | 'locked' | 'network' | 'internal'

/** How the last session ended, for the page to say: `code` is null when it went through. */
export interface SyncLastExchange {
  at: number
  ok: boolean
  /** The Today tabs taken from the other device by this session, and the ones this device kept to itself because the shared set was full (§27.4); 0 when the category is not common. */
  todayTabsReceived: number
  todayTabsUnshared: number
  code: 'divergence' | 'state-too-new' | 'interrupted' | 'locked' | 'other' | null
}

export interface SyncStatus {
  /** Whether the system can seal the key of the device (without it the switch cannot be turned on). */
  available: boolean
  enabled: boolean
  categories: Record<SyncCategory, boolean>
  /** Whether the Mac listens now: the switch is on, the application is unlocked, and an iPhone is paired (or a pairing is open). There is no window to open any more (§6.1). */
  listening: boolean
  pairing: SyncPairingView | null
  confirm: SyncConfirmView | null
  devices: SyncDeviceView[]
  /** The identity was made again (a restored profile, a keychain that refused): the devices that were paired are forgotten and have to be paired again. */
  identityReplaced: boolean
  /** An iPhone that has just been paired, by name; the page says it once. */
  justPaired: string | null
  /** How the last session ended, or null before any. */
  lastExchange: SyncLastExchange | null
  /** The other device closed the tab this one showed (§27.5, [Q11]): when, for the line « Fermé sur l'iPhone ». Forgotten with the device, and when the page is left. */
  closedShown: { at: number } | null
  /** The last thing that went wrong when the page asked for something, or null. */
  problem: SyncProblem | null
}

export type SyncReply = { ok: true; status: SyncStatus } | { ok: false; message: string; status: SyncStatus | null }

const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key))

/**
 * The request a message holds, or null: it must be exactly one of the kinds above, with exactly the fields of its kind and each of the right type. A request with a
 * field more, a category that does not exist, an identifier that is not one, or an object that is not plain (an array, a null) is refused.
 */
export function parseSyncRequest(raw: unknown): SyncRequest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const request = raw as Record<string, unknown>
  // Own fields only: a value that the object inherits is not something the page sent.
  const own = (key: string): unknown => (Object.hasOwn(request, key) ? request[key] : undefined)
  const kind = own('kind')
  switch (kind) {
    case 'status':
    case 'pair-start':
    case 'pair-close':
    case 'leave':
      return hasOnly(request, ['kind']) ? { kind } : null
    case 'enable':
      return hasOnly(request, ['kind', 'on']) && typeof own('on') === 'boolean' ? { kind, on: own('on') as boolean } : null
    case 'category': {
      const category = own('category')
      return hasOnly(request, ['kind', 'category', 'on']) && (SYNC_CATEGORIES as readonly unknown[]).includes(category) && typeof own('on') === 'boolean' ? { kind, category: category as SyncCategory, on: own('on') as boolean } : null
    }
    case 'answer': {
      const share = own('shareToday')
      if (!hasOnly(request, ['kind', 'allow', 'shareToday']) || typeof own('allow') !== 'boolean') return null
      if (share === undefined) return { kind, allow: own('allow') as boolean }
      return typeof share === 'boolean' ? { kind, allow: own('allow') as boolean, shareToday: share } : null
    }
    case 'forget': {
      const id = own('id')
      return hasOnly(request, ['kind', 'id']) && typeof id === 'string' && DEVICE_ID.test(id) ? { kind, id } : null
    }
    default:
      return null
  }
}
