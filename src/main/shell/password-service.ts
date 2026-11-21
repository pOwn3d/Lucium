// The password manager of the main process (docs/gestionnaire-mots-de-passe.md). It decides, for a request of the panel, a command of the menu
// or the shortcut, or a login a page was seen to submit, what happens to the vault and to the page. Nothing here imports Electron: the
// windows, the files and the power events are handed in, so that every path (a private window, a frame, a page that is not the entry's) is
// tested without a window.
//
// Rules this file keeps, each with its test (password-service.test.ts):
//  - the feature off: nothing is read, nothing is offered, nothing is filled;
//  - a private window, a private tab: nothing is offered, saved or filled;
//  - a password reaches a page only through `fillEntry`, only on a request from the interface or the menu (never a message of a page), and
//    only after `fillVerdict` said the page's origin is exactly the entry's;
//  - the interface is told rows and counts, never a password (the one exception is the text of the generator, which it asked for);
//  - a login seen on a page is kept in memory for three minutes and written only after the user said so;
//  - no identifier, password, phrase or address is ever in a log line: the logs say what failed, as a kind;
//  - the key of an entry's one-time codes (TOTP) stays in this process: the interface is given the digits it asked for and the seconds they last,
//    never the key; a code copied is put on the clipboard from here and taken off it after a delay, and at once when the vault locks;
//  - Touch ID (vault-keychain.ts) opens the vault only with the key the keychain released after a fingerprint, never with a key kept here;
//    whatever goes wrong with it, the phrase is asked (password-touch-id.test.ts).

import { randomInt } from 'node:crypto'
import { generatePassword } from '@shared/password-generator'
import { CSV_LIMITS, CSV_MESSAGES, describeReport, parseLoginCsv } from '@shared/password-csv'
import { FILL_FAILURE_MESSAGES, parseFillOutcome, type FillOutcome, type FillPlan } from '@shared/login-form'
import { siteOf } from '@shared/party'
import { parseTotpInput } from '@shared/totp'
import {
  NEW_LOGIN_MESSAGES,
  NO_PASSWORDS_VIEW,
  PASSWORD_LIMITS,
  checkedLogin,
  cameOverUntrustedCertificate,
  eligibleOriginOf,
  fillVerdict,
  hostLabel,
  phraseProblem,
  type CaptureView,
  type PagePasswords,
  type PasswordReply,
  type PasswordRequest,
  type PasswordsView,
  type Submission
} from '@shared/passwords'
import type { Settings } from '@shared/model'
import { ExportCryptoError } from '../export-crypto'
import type { PowerPort } from '../lock-service'
import { PasswordVault, VaultError, openExport } from '../password-vault'
import { SEALED_FILE_MAX, vaultErrorMessage } from '../vault-crypto'
import { KeychainError, type VaultKeychainPort } from '../vault-keychain'
import { totpAt } from '../totp'
import { getLanguage, t, tp } from '@shared/i18n'

/** The tab on screen of the window that asked: what the fill needs to know of it, and the one way to write into it. */
export interface PasswordTarget {
  /** The address of its main frame, as the main process holds it. */
  url: string | null
  /** A private tab of a normal window (a private window is the window's own `isPrivate`). */
  privateTab: boolean
  /** The page came over a certificate that is not valid and was let through (the tab says « Non sécurisé »): nothing is filled there. */
  untrustedCertificate?: boolean
  /** Runs the fill in the main frame of the page, and only there. Rejects when the page is gone. */
  fill(plan: FillPlan): Promise<unknown>
}

/** A browser window, as the service uses it. */
export interface PasswordWindow {
  isPrivate(): boolean
  target(): PasswordTarget | null
  /** Shows a notice; answers its id when the window has ids for its notices. */
  toast(message: string, action?: { label: string; run: () => void }, durationMs?: number): number | void
  /** Takes the notice with this id away if it still shows (a later notice is left alone). */
  dismissToast?(id: number): void
  /** Opens the panel "Mots de passe…" in this window. */
  openPanel(): void
}

/** The file dialogs and the disk, as the main process has them. Paths come from dialogs of the main process, never from the interface. */
export interface PasswordFiles {
  chooseToRead(kind: 'csv' | 'export'): Promise<string | null>
  chooseToWrite(): Promise<string | null>
  readText(path: string, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; message: string }>
  writePrivate(path: string, text: string): void
}

/** The system clipboard, as the service uses it (the application's own is Electron's, whose text calls answer by promise). */
export interface ClipboardPort {
  readText(): Promise<string>
  clear(): void
  writeText(text: string): Promise<void>
}

export interface PasswordDeps {
  settings: () => Settings
  vault: PasswordVault
  power: PowerPort
  files: PasswordFiles
  now?: () => number
  /** Where the generator's randomness comes from; defaults to the cryptographic `randomInt`. */
  randomInt?: (below: number) => number
  autoLockMs?: number
  /** The key of the vault behind Touch ID (macOS); absent, Touch ID is never offered and the phrase is the only way in. */
  keychain?: VaultKeychainPort
  /** Where a copied one-time code goes; absent, a code is never copied (it can still be read in the panel). */
  clipboard?: ClipboardPort
  /** How long a copied code stays on the clipboard; the default is `PASSWORD_LIMITS.clipboardClearMs`. */
  clipboardClearMs?: number
}

interface Pending {
  window: PasswordWindow
  origin: string
  username: string
  password: string
  /** The number the panel names this offer by (CaptureView.offer). */
  offer: number
  timer: NodeJS.Timeout
  /** The notice that offered to save it: it goes away with the login, whichever way that ends. */
  toast?: number
}

/** How long the toast that offers to save stays, and the least time between two offers of one window. */
const OFFER_TOAST_MS = 12_000
const OFFER_GAP_MS = 1500

const POWER_EVENTS = ['suspend', 'lock-screen'] as const

export class PasswordService {
  private checking = false
  /** A fingerprint is being asked: one prompt at a time. */
  private touching = false
  private lockTimer: NodeJS.Timeout | null = null
  private attached = false
  private readonly pending = new Map<PasswordWindow, Pending>()
  private readonly lastOffer = new WeakMap<PasswordWindow, number>()
  private offers = 0
  /** The code this service put on the clipboard, until it is taken off. */
  private copied: { code: string; timer: NodeJS.Timeout } | null = null
  private readonly onPower = (): void => this.lock()

  constructor(private readonly deps: PasswordDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private on(): boolean {
    return this.deps.settings().passwordManager === true
  }

  // ---------- the vault's open time ----------

  /** Starts the idle timer and listens to the power events: only while the vault is open, so a closed vault owns neither. */
  private arm(): void {
    this.touch()
    if (this.attached) return
    this.attached = true
    for (const event of POWER_EVENTS) this.deps.power.on(event, this.onPower)
  }

  private disarm(): void {
    if (this.lockTimer) clearTimeout(this.lockTimer)
    this.lockTimer = null
    if (!this.attached) return
    this.attached = false
    for (const event of POWER_EVENTS) this.deps.power.off(event, this.onPower)
  }

  /** Every use of the vault puts the idle lock back to its full time. */
  private touch(): void {
    if (!this.deps.vault.isUnlocked()) return
    if (this.lockTimer) clearTimeout(this.lockTimer)
    this.lockTimer = setTimeout(() => this.lock(), this.deps.autoLockMs ?? PASSWORD_LIMITS.autoLockMs)
    this.lockTimer.unref?.()
  }

  /** Locks the vault and forgets the logins that were waiting for an answer (they hold passwords too). */
  lock(): void {
    this.deps.vault.lock()
    this.disarm()
    this.forgetCaptures()
    void this.clearCopiedCode()
  }

  /**
   * The feature was switched off, or the application is quitting: nothing stays open. The file stays. The wait after wrong phrases stays too:
   * switching the feature off and on again does not buy another round of tries.
   */
  stop(): void {
    this.lock()
  }

  /** A window is closing: the login it was offered is forgotten now, not when its three minutes are over. */
  forgetWindow(window: PasswordWindow): void {
    this.forgetCapture(window)
  }

  // ---------- what the panel is shown ----------

  private pageOf(window: PasswordWindow): PagePasswords | null {
    const target = window.target()
    if (!target) return null
    const origin = eligibleOriginOf(target.url)
    const unlocked = this.deps.vault.isUnlocked()
    const verdict = fillVerdict({ featureOn: true, privateTab: window.isPrivate() || target.privateTab, untrustedCertificate: target.untrustedCertificate === true, vaultUnlocked: unlocked, pageUrl: target.url, entryOrigin: origin ?? '' })
    // "Locked" is a state of the vault, not a reason the page cannot take a password.
    const fillable = verdict.ok || verdict.reason === 'locked'
    return {
      host: origin === null ? null : hostLabel(origin),
      fillable,
      ...(fillable ? {} : { reason: verdict.ok ? undefined : verdict.message }),
      matching: unlocked ? this.deps.vault.rowsForPage(target.url).map((row) => row.id) : []
    }
  }

  private captureOf(window: PasswordWindow): CaptureView | null {
    const seen = this.pending.get(window)
    if (!seen) return null
    const kind = this.deps.vault.isUnlocked() ? this.deps.vault.captureKind(seen) : 'new'
    return kind === 'same' ? null : { kind, host: hostLabel(seen.origin), username: seen.username, offer: seen.offer }
  }

  view(window: PasswordWindow): PasswordsView {
    if (!this.on() || window.isPrivate()) return NO_PASSWORDS_VIEW
    const unlocked = this.deps.vault.isUnlocked()
    return {
      enabled: true,
      vault: unlocked ? 'unlocked' : this.deps.vault.exists() ? 'locked' : 'none',
      entries: unlocked ? this.deps.vault.rows() : [],
      page: this.pageOf(window),
      capture: this.captureOf(window),
      retryInMs: this.deps.vault.retryInMs(),
      touchId: { available: this.deps.keychain?.available() ?? false, enabled: this.deps.keychain?.enabled() ?? false, installed: this.deps.keychain?.installed() ?? false }
    }
  }

  private reply(window: PasswordWindow, ok: boolean, message?: string, extra: Partial<PasswordReply> = {}): PasswordReply {
    return { ok, ...(message ? { message } : {}), view: this.view(window), ...extra }
  }

  /** Logs what failed as a kind (never a value) and gives the sentence the user reads. */
  private failure(what: string, error: unknown): string {
    if (error instanceof ExportCryptoError) {
      console.error(`[passwords] ${what} failed:`, error.kind)
      return vaultErrorMessage(error)
    }
    if (error instanceof VaultError) {
      console.error(`[passwords] ${what} failed:`, error.kind)
      return error.kind === 'wait' ? waitMessage(error.retryInMs) : VAULT_MESSAGES[error.kind]
    }
    console.error(`[passwords] ${what} failed:`, error instanceof Error ? error.name : typeof error)
    return t('pwd.l-operation-a-echoue')
  }

  // ---------- the requests of the panel ----------

  /** `files` are the dialogs of the window that asked (the owner of the sheets); the defaults are the service's own. */
  async handle(request: PasswordRequest, window: PasswordWindow, files: PasswordFiles = this.deps.files): Promise<PasswordReply> {
    if (!this.on()) return { ok: false, message: t('pwd.le-gestionnaire-de-mots-de-passe-est-desactive'), view: NO_PASSWORDS_VIEW }
    // A private window keeps nothing: it is not even told whether a vault exists.
    if (window.isPrivate()) return { ok: false, message: t('pwd.le-gestionnaire-de-mots-de-passe-n-est-pas'), view: NO_PASSWORDS_VIEW }
    switch (request.kind) {
      case 'status':
        return this.reply(window, true)
      case 'create':
        return this.create(request.phrase, window)
      case 'unlock':
        return this.unlock(request.phrase, window)
      case 'lock':
        this.lock()
        return this.reply(window, true, t('pwd.coffre-verrouille'))
      case 'change-phrase':
        return this.changePhrase(request.current, request.next, window)
      case 'destroy':
        return this.destroy(request.phrase, window)
      case 'generate':
        return this.reply(window, true, undefined, { password: generatePassword(request.options, this.deps.randomInt ?? randomInt) })
      case 'add':
        return this.add(request, window)
      case 'remove':
        return this.remove(request.id, window)
      case 'fill':
        return this.fillEntry(window, request.id, false)
      case 'fill-active':
        return this.fillActive(window)
      case 'capture':
        return request.op === 'confirm' ? this.confirmCapture(window, request.offer) : this.dismissCapture(window, request.offer)
      case 'import-csv':
        return this.importCsv(window, files)
      case 'export':
        return this.exportSealed(request.phrase, window, files)
      case 'import-export':
        return this.importExport(request.phrase, window, files)
      case 'unlock-touch-id':
        return this.unlockWithTouchId(window)
      case 'touch-id-on':
        return this.touchIdOn(request.phrase, window)
      case 'touch-id-off':
        return this.touchIdOff(window)
      case 'totp-set':
        return this.totpSet(request.id, request.secret, window)
      case 'totp-remove':
        return this.totpRemove(request.id, window)
      case 'totp-code':
        return this.totpCode(request.id, request.auto === true, window)
      case 'totp-copy':
        return this.totpCopy(request.id, window)
    }
  }

  private async create(phrase: string, window: PasswordWindow): Promise<PasswordReply> {
    const problem = phraseProblem(phrase)
    if (problem) return this.reply(window, false, problem)
    try {
      await this.deps.vault.create(phrase)
    } catch (error) {
      return this.reply(window, false, this.failure('creating the vault', error))
    }
    // A record left by a vault that is gone (its file deleted by hand) belongs to another key: it does not carry over to a new vault.
    if (this.deps.keychain?.enabled()) await this.forgetTouchId('a new vault was made')
    this.arm()
    return this.reply(window, true, t('pwd.coffre-cree-et-deverrouille'))
  }

  private async unlock(phrase: string, window: PasswordWindow): Promise<PasswordReply> {
    // The count of wrong phrases is the vault's (it is on the disk, and every check of the phrase goes through it): a phrase is not even tried while the wait lasts.
    const wait = this.deps.vault.retryInMs()
    if (wait > 0) return this.reply(window, false, waitMessage(wait))
    // One phrase is checked at a time: a second one waits for the answer instead of starting another derivation.
    if (this.checking) return this.reply(window, false, t('pwd.une-phrase-est-deja-en-cours-de-verification'))
    this.checking = true
    try {
      await this.deps.vault.unlock(phrase)
    } catch (error) {
      if (error instanceof ExportCryptoError && error.kind === 'wrong-passphrase') {
        const delay = this.deps.vault.retryInMs()
        console.error('[passwords] a wrong phrase was tried for the vault')
        return this.reply(window, false, delay > 0 ? t('pwd.phrase-incorrecte-reessayez-dans-seconds-s', { seconds: Math.ceil(delay / 1000) }) : t('pwd.phrase-incorrecte'))
      }
      return this.reply(window, false, this.failure('opening the vault', error))
    } finally {
      this.checking = false
    }
    this.arm()
    return this.reply(window, true, this.unlockedMessage())
  }

  private async changePhrase(current: string, next: string, window: PasswordWindow): Promise<PasswordReply> {
    const problem = phraseProblem(next)
    if (problem) return this.reply(window, false, problem)
    if (!this.deps.vault.isUnlocked()) return this.reply(window, false, t('pwd.le-coffre-est-verrouille'))
    try {
      await this.deps.vault.changePhrase(current, next)
    } catch (error) {
      return this.reply(window, false, error instanceof ExportCryptoError && error.kind === 'wrong-passphrase' ? t('pwd.la-phrase-actuelle-est-incorrecte') : this.failure('changing the phrase', error))
    }
    this.touch()
    // The key kept for Touch ID was the old phrase's: the new one replaces it (the user just typed it), or Touch ID goes off.
    if (this.deps.keychain?.enabled() && !(await this.restoreTouchId(next))) return this.reply(window, true, t('pwd-touch.phrase-changee-touch-id-desactive'))
    return this.reply(window, true, t('pwd.phrase-changee'))
  }

  private async destroy(phrase: string, window: PasswordWindow): Promise<PasswordReply> {
    if (!this.deps.vault.isUnlocked()) return this.reply(window, false, t('pwd.deverrouillez-le-coffre-pour-le-supprimer'))
    try {
      await this.deps.vault.destroy(phrase)
    } catch (error) {
      return this.reply(window, false, error instanceof ExportCryptoError && error.kind === 'wrong-passphrase' ? t('pwd.la-phrase-est-incorrecte-le-coffre-n-a-pas') : this.failure('deleting the vault', error))
    }
    this.disarm()
    this.forgetCaptures()
    void this.clearCopiedCode()
    // The vault is gone, and so is its key in the keychain.
    if (this.deps.keychain?.enabled()) await this.forgetTouchId('the vault was deleted')
    return this.reply(window, true, t('pwd.coffre-supprime'))
  }

  // ---------- Touch ID ----------

  /** Takes the key out of the keychain and the record away, whatever the keychain answers (the key no longer opens anything). Logs a kind. */
  private async forgetTouchId(why: string): Promise<void> {
    const failure = await this.deps.keychain!.forget()
    if (failure) console.error(`[passwords] Touch ID was turned off (${why}) but the keychain could not delete the key:`, failure.kind, failure.status ?? '')
  }

  /** After a change of phrase: the new key in the keychain. False when it could not be (Touch ID is then off). */
  private async restoreTouchId(phrase: string): Promise<boolean> {
    let secret: { material: Buffer; salt: Buffer } | null = null
    try {
      secret = await this.deps.vault.keyMaterial(phrase)
      await this.deps.keychain!.enable(secret.material, secret.salt)
      return true
    } catch (error) {
      console.error('[passwords] Touch ID could not follow the new phrase:', error instanceof KeychainError || error instanceof ExportCryptoError || error instanceof VaultError ? error.kind : error instanceof Error ? error.name : typeof error)
      await this.forgetTouchId('the phrase changed')
      return false
    } finally {
      secret?.material.fill(0)
    }
  }

  /**
   * Opens the vault with Touch ID: the helper asks for the fingerprint and the keychain gives back the key only then. Every failure
   * leaves the vault locked and asks for the phrase; the failures that mean the key is gone or no longer this vault's turn Touch ID off.
   * A failed fingerprint does not count as a wrong phrase (the system has its own limit), and a success clears the phrase's delay (the vault does, when the key opens it).
   */
  private async unlockWithTouchId(window: PasswordWindow): Promise<PasswordReply> {
    const keychain = this.deps.keychain
    if (!keychain || !keychain.available()) return this.reply(window, false, this.touchIdUnavailable())
    if (!keychain.enabled()) return this.reply(window, false, t('pwd-touch.pas-active'))
    if (this.deps.vault.isUnlocked()) return this.reply(window, true)
    if (this.touching) return this.reply(window, false, t('pwd-touch.deja-en-cours'))
    this.touching = true
    let key: Buffer | null = null
    try {
      // The helper shows its own words for the prompt, in the language of the interface: it is never given a text.
      key = await keychain.load(getLanguage(), this.deps.vault.saltOnDisk())
      await this.deps.vault.unlockWithKey(key)
    } catch (error) {
      return this.reply(window, false, await this.touchIdFailure(error))
    } finally {
      key?.fill(0)
      this.touching = false
    }
    this.arm()
    return this.reply(window, true, this.unlockedMessage())
  }

  /** What an opening says: the logins this version left out are counted, so that the user knows a copy of the file was kept. */
  private unlockedMessage(): string {
    const dropped = this.deps.vault.droppedAtOpening()
    return dropped > 0 ? tp('pwd.coffre-deverrouille-identifiants-ecartes', dropped) : t('pwd.coffre-deverrouille')
  }

  /** The sentence for a Touch ID that did not open the vault, after turning it off when its key is gone or stale. Logs a kind. */
  private async touchIdFailure(error: unknown): Promise<string> {
    if (error instanceof KeychainError) {
      console.error('[passwords] Touch ID did not open the vault:', error.kind, error.status ?? '')
      switch (error.kind) {
        case 'cancelled':
        case 'failed':
          return t('pwd-touch.n-a-pas-abouti')
        case 'biometry-changed':
          await this.forgetTouchId('other fingers are enrolled')
          return t('pwd-touch.empreintes-changees')
        case 'not-found':
          await this.forgetTouchId('the key is not in the keychain')
          return t('pwd-touch.cle-introuvable')
        case 'stale':
          await this.forgetTouchId('the key belongs to another phrase')
          return t('pwd-touch.cle-perimee')
        default:
          return t('pwd-touch.indisponible')
      }
    }
    // The keychain gave a key that does not open the file (a vault replaced under the same name): it is of no use any more.
    if (error instanceof ExportCryptoError && error.kind === 'wrong-passphrase') {
      console.error('[passwords] the key of Touch ID does not open the vault')
      await this.forgetTouchId('the key does not open the vault')
      return t('pwd-touch.cle-perimee')
    }
    return this.failure('opening the vault with Touch ID', error)
  }

  /** Why Touch ID is not offered: not now (the helper is there, the system cannot show a prompt: lid closed, no sensor), or not in this build. */
  private touchIdUnavailable(): string {
    return this.deps.keychain?.installed() === true ? t('pwd-touch.pas-maintenant') : t('pwd-touch.indisponible')
  }

  /** Turns Touch ID on: the phrase is asked again (an open vault is not enough to hand its key to the keychain), then the key is stored. */
  private async touchIdOn(phrase: string, window: PasswordWindow): Promise<PasswordReply> {
    const keychain = this.deps.keychain
    if (!keychain || !keychain.available()) return this.reply(window, false, this.touchIdUnavailable())
    if (!this.deps.vault.isUnlocked()) return this.reply(window, false, t('pwd.le-coffre-est-verrouille'))
    let secret: { material: Buffer; salt: Buffer } | null = null
    try {
      secret = await this.deps.vault.keyMaterial(phrase)
      await keychain.enable(secret.material, secret.salt)
    } catch (error) {
      if (error instanceof ExportCryptoError && error.kind === 'wrong-passphrase') return this.reply(window, false, t('pwd-touch.activation-phrase-incorrecte'))
      if (error instanceof KeychainError) {
        console.error('[passwords] Touch ID could not be turned on:', error.kind, error.status ?? '')
        return this.reply(window, false, t('pwd-touch.activation-impossible'))
      }
      return this.reply(window, false, this.failure('turning Touch ID on', error))
    } finally {
      secret?.material.fill(0)
    }
    this.touch()
    return this.reply(window, true, t('pwd-touch.active'))
  }

  /** Turns Touch ID off: the key leaves the keychain first; when the keychain cannot be asked, Touch ID stays on and the user is told. */
  private async touchIdOff(window: PasswordWindow): Promise<PasswordReply> {
    const keychain = this.deps.keychain
    if (!keychain) return this.reply(window, false, t('pwd-touch.indisponible'))
    try {
      await keychain.disable()
    } catch (error) {
      console.error('[passwords] Touch ID could not be turned off:', error instanceof KeychainError ? `${error.kind} ${error.status ?? ''}` : error instanceof Error ? error.name : typeof error)
      return this.reply(window, false, t('pwd-touch.desactivation-impossible'))
    }
    return this.reply(window, true, t('pwd-touch.desactive'))
  }

  private async add(request: Extract<PasswordRequest, { kind: 'add' }>, window: PasswordWindow): Promise<PasswordReply> {
    if (!this.deps.vault.isUnlocked()) return this.reply(window, false, t('pwd.le-coffre-est-verrouille'))
    const login = checkedLogin(request)
    if (!login.ok) return this.reply(window, false, NEW_LOGIN_MESSAGES[login.problem])
    try {
      const kind = await this.deps.vault.save(login)
      this.touch()
      return this.reply(window, true, kind === 'new' ? t('pwd.identifiant-enregistre') : kind === 'update' ? t('pwd.mot-de-passe-mis-a-jour') : t('pwd.cet-identifiant-est-deja-enregistre-tel-quel'))
    } catch (error) {
      return this.reply(window, false, this.failure('saving a login', error))
    }
  }

  private async remove(id: string, window: PasswordWindow): Promise<PasswordReply> {
    if (!this.deps.vault.isUnlocked()) return this.reply(window, false, t('pwd.le-coffre-est-verrouille'))
    try {
      const removed = await this.deps.vault.remove(id)
      this.touch()
      return this.reply(window, removed, removed ? t('pwd.identifiant-supprime') : t('pwd.cet-identifiant-n-existe-plus'))
    } catch (error) {
      return this.reply(window, false, this.failure('removing a login', error))
    }
  }

  // ---------- one-time codes ----------

  /** Adds, or replaces, the key of the one-time codes of an entry. The text is a secret: the refusal says what is wrong with it, never what it was. */
  private async totpSet(id: string, text: string, window: PasswordWindow): Promise<PasswordReply> {
    if (!this.deps.vault.isUnlocked()) return this.reply(window, false, t('pwd.le-coffre-est-verrouille'))
    const parsed = parseTotpInput(text)
    if (!parsed.ok) return this.reply(window, false, parsed.problem === 'unsupported' ? t('pwd.totp-non-pris-en-charge') : t('pwd.totp-cle-invalide'))
    try {
      const done = await this.deps.vault.setTotp(id, parsed.config)
      this.touch()
      return this.reply(window, done, done ? t('pwd.totp-enregistre') : t('pwd.cet-identifiant-n-existe-plus'))
    } catch (error) {
      return this.reply(window, false, this.failure('saving a one-time code key', error))
    }
  }

  private async totpRemove(id: string, window: PasswordWindow): Promise<PasswordReply> {
    if (!this.deps.vault.isUnlocked()) return this.reply(window, false, t('pwd.le-coffre-est-verrouille'))
    try {
      const done = await this.deps.vault.removeTotp(id)
      this.touch()
      return this.reply(window, done, done ? t('pwd.totp-retire') : t('pwd.totp-absent'))
    } catch (error) {
      return this.reply(window, false, this.failure('removing a one-time code key', error))
    }
  }

  /** The code of now for an entry, or the sentence for why there is none. */
  private codeOf(id: string): { code: string; secondsLeft: number; msLeft: number; period: number } | string {
    const config = this.deps.vault.totpOf(id)
    if (config === null) return t('pwd.totp-absent')
    try {
      return { ...totpAt(config, this.now()), period: config.period }
    } catch (error) {
      return this.failure('computing a one-time code', error)
    }
  }

  private totpCode(id: string, auto: boolean, window: PasswordWindow): PasswordReply {
    if (!this.deps.vault.isUnlocked()) return this.reply(window, false, t('pwd.le-coffre-est-verrouille'))
    const made = this.codeOf(id)
    if (typeof made === 'string') return this.reply(window, false, made)
    // The panel asks again by itself when a code ends: that is a clock, not a person, and must not keep the vault open for ever.
    if (!auto) this.touch()
    return this.reply(window, true, undefined, { totp: { id, ...made } })
  }

  /** Puts the code of now on the clipboard, from this process; it comes off after `clipboardClearMs`, and when the vault locks. */
  private async totpCopy(id: string, window: PasswordWindow): Promise<PasswordReply> {
    if (!this.deps.vault.isUnlocked()) return this.reply(window, false, t('pwd.le-coffre-est-verrouille'))
    const clipboard = this.deps.clipboard
    if (!clipboard) return this.reply(window, false, t('pwd.totp-presse-papiers-indisponible'))
    const made = this.codeOf(id)
    if (typeof made === 'string') return this.reply(window, false, made)
    // A code that was copied before is replaced, not left for its timer to wipe the new one. The new one is noted before the write is
    // awaited: a vault that locks meanwhile finds it and takes it off.
    this.forgetCopiedCode()
    const delay = this.deps.clipboardClearMs ?? PASSWORD_LIMITS.clipboardClearMs
    const timer = setTimeout(() => void this.clearCopiedCode(), delay)
    timer.unref?.()
    const mine = { code: made.code, timer }
    this.copied = mine
    try {
      await clipboard.writeText(made.code)
    } catch (error) {
      console.error('[passwords] a one-time code could not be copied:', error instanceof Error ? error.name : typeof error)
      if (this.copied === mine) this.forgetCopiedCode()
      return this.reply(window, false, t('pwd.totp-copie-impossible'))
    }
    // The vault locked while the code was being written: it is already on the clipboard, so it comes off at once.
    if (!this.deps.vault.isUnlocked()) {
      await this.takeOffClipboard(mine.code)
      return this.reply(window, false, t('pwd.le-coffre-est-verrouille'))
    }
    this.touch()
    return this.reply(window, true, t('pwd.totp-copie', { seconds: Math.ceil(delay / 1000) }))
  }

  private forgetCopiedCode(): void {
    if (this.copied) clearTimeout(this.copied.timer)
    this.copied = null
  }

  /**
   * Takes the copied code off the clipboard, only if it is still what is there: something the user copied since is theirs. A clipboard that
   * cannot be read or cleared is logged as a kind (the code is not said), and the code is no longer the code after its own period.
   */
  private async clearCopiedCode(): Promise<void> {
    const copied = this.copied
    if (!copied) return
    this.forgetCopiedCode()
    await this.takeOffClipboard(copied.code)
  }

  private async takeOffClipboard(code: string): Promise<void> {
    const clipboard = this.deps.clipboard
    try {
      if (clipboard && (await clipboard.readText()) === code) clipboard.clear()
    } catch (error) {
      console.error('[passwords] the copied one-time code could not be taken off the clipboard:', error instanceof Error ? error.name : typeof error)
    }
  }

  // ---------- filling ----------

  /** "Chercher dans le coffre" for the page on screen, then fill when there is one choice. The menu, the shortcut and the command bar come here. */
  async fillActive(window: PasswordWindow): Promise<PasswordReply> {
    if (!this.on()) return { ok: false, message: t('pwd.le-gestionnaire-de-mots-de-passe-est-desactive'), view: NO_PASSWORDS_VIEW }
    const target = window.target()
    const say = (message: string): PasswordReply => {
      window.toast(message)
      return this.reply(window, false, message)
    }
    if (window.isPrivate() || target?.privateTab) return say(t('pwd.aucun-mot-de-passe-n-est-rempli-dans-une'))
    if (!target) return say(t('pwd.aucune-page-a-remplir'))

    const origin = eligibleOriginOf(target.url)
    if (origin === null) {
      // An http page (or another port) of a site that has an entry: the entry is not offered, and the user is told that it exists.
      const near = this.deps.vault.isUnlocked() ? this.nearEntry(target.url) : undefined
      return say(near ? t('pwd.identifiant-existe-adresse-differe-non-https', { site: hostLabel(near.origin) }) : t('pwd.cette-page-n-accepte-pas-de-mot-de-passe'))
    }
    // Locked, or no vault yet: the panel opens to ask for the phrase (or to create one); the user then picks and fills there.
    if (!this.deps.vault.isUnlocked()) {
      window.openPanel()
      return this.reply(window, true)
    }
    this.touch()
    const rows = this.deps.vault.rowsForPage(target.url)
    if (rows.length === 1) return this.fillEntry(window, rows[0]!.id, true)
    if (rows.length > 1) {
      window.openPanel()
      return this.reply(window, true)
    }
    return say(this.noEntryMessage(origin))
  }

  /** An entry of the same site (same registrable domain) as the page, whose origin is not the page's: the neighbour a person may have meant. */
  private nearEntry(pageUrl: string | null): { origin: string } | undefined {
    const site = siteOf(pageUrl)
    const pageOrigin = URL.canParse(pageUrl ?? '') ? new URL(pageUrl!).origin : null
    return site === null ? undefined : this.deps.vault.rows().find((row) => row.origin !== pageOrigin && siteOf(row.origin) === site)
  }

  /** The sentence for a page with no entry of its own, with the warning when an entry exists for a neighbouring address. */
  private noEntryMessage(pageOrigin: string): string {
    const near = this.nearEntry(pageOrigin)
    return near
      ? t('pwd.aucun-mot-de-passe-identifiant-existe-autre-adresse', { page: hostLabel(pageOrigin), site: hostLabel(near.origin) })
      : t('pwd.aucun-mot-de-passe-enregistre-pour-page', { page: hostLabel(pageOrigin) })
  }

  /** The only way a password goes to a page: one entry, into the page on screen, after the verdict on its origin. */
  async fillEntry(window: PasswordWindow, id: string, announce: boolean): Promise<PasswordReply> {
    const say = (message: string): PasswordReply => {
      if (announce) window.toast(message)
      return this.reply(window, false, message)
    }
    if (!this.on()) return say(t('pwd.le-gestionnaire-de-mots-de-passe-est-desactive'))
    const target = window.target()
    const entry = this.deps.vault.isUnlocked() ? this.deps.vault.secret(id) : null
    const verdict = fillVerdict({
      featureOn: true,
      privateTab: window.isPrivate() || (target?.privateTab ?? false),
      untrustedCertificate: target?.untrustedCertificate === true,
      vaultUnlocked: this.deps.vault.isUnlocked(),
      pageUrl: target?.url,
      entryOrigin: entry?.origin ?? ''
    })
    if (!verdict.ok) {
      if (verdict.reason === 'origin-differs' && target) {
        const pageOrigin = eligibleOriginOf(target.url)
        return say(t('pwd.identifiant-enregistre-pour-page', { message: verdict.message, site: hostLabel(entry?.origin ?? ''), page: pageOrigin === null ? '?' : hostLabel(pageOrigin) }))
      }
      return say(verdict.message)
    }
    if (!entry || !target) return say(t('pwd.cet-identifiant-n-existe-plus'))
    this.touch()
    let outcome: FillOutcome | null
    try {
      outcome = parseFillOutcome(await target.fill({ origin: verdict.origin, username: entry.username, password: entry.password }))
    } catch (error) {
      console.error('[passwords] the page could not be filled:', error instanceof Error ? error.name : typeof error)
      return say(t('pwd.la-page-n-a-pas-pu-etre-remplie-elle-a-peut'))
    }
    if (outcome === null) return say(t('pwd.la-page-n-a-pas-repondu-comme-prevu-rien-n-a'))
    if (!outcome.ok) return say(FILL_FAILURE_MESSAGES[outcome.reason])
    return this.reply(window, true)
  }

  // ---------- logins seen on pages ----------

  private forgetCaptures(): void {
    for (const window of [...this.pending.keys()]) this.forgetCapture(window)
  }

  /** Forgets the login a window was offered, and takes its notice away: a notice that offers what no longer exists must not stay on screen. */
  private forgetCapture(window: PasswordWindow): void {
    const seen = this.pending.get(window)
    if (!seen) return
    clearTimeout(seen.timer)
    this.pending.delete(window)
    if (seen.toast !== undefined) window.dismissToast?.(seen.toast)
  }

  /**
   * A form the user submitted in the main frame of a tab (the page bridge, src/preload/password-bridge.ts). `frameUrl` is the address the
   * browser holds for that frame; the page does not name its own origin. The login is kept in memory and offered by a notice: nothing is
   * written until the user answers in the panel.
   */
  submitted(window: PasswordWindow, from: { privateTab: boolean; frameUrl: string; untrustedCertificate?: boolean }, submission: Submission): void {
    if (!this.on() || window.isPrivate() || from.privateTab) return
    // A form sent over a certificate that was let through: what was typed may have gone to someone else, and is not offered to the vault under the site's name.
    if (cameOverUntrustedCertificate(from.frameUrl, from.untrustedCertificate)) return
    const origin = eligibleOriginOf(from.frameUrl)
    if (origin === null) return
    // A page that submits forms in a loop is not given a stream of notices.
    const at = this.now()
    const last = this.lastOffer.get(window)
    if (last !== undefined && at - last < OFFER_GAP_MS) return
    this.lastOffer.set(window, at)
    if (this.deps.vault.isUnlocked() && this.deps.vault.captureKind({ origin, ...submission }) === 'same') return
    this.forgetCapture(window)
    const timer = setTimeout(() => this.forgetCapture(window), PASSWORD_LIMITS.captureTtlMs)
    timer.unref?.()
    const seen: Pending = { window, origin, username: submission.username, password: submission.password, offer: ++this.offers, timer }
    this.pending.set(window, seen)
    // The notice names the site and nothing of the login.
    const id = window.toast(t('pwd.enregistrer-le-mot-de-passe-pour-host', { host: hostLabel(origin) }), { label: t('pwd.enregistrer'), run: () => window.openPanel() }, OFFER_TOAST_MS)
    if (typeof id === 'number') seen.toast = id
  }

  private async confirmCapture(window: PasswordWindow, offer: number): Promise<PasswordReply> {
    const seen = this.pending.get(window)
    if (!seen) return this.reply(window, false, t('pwd.il-n-y-a-plus-rien-a-enregistrer'))
    // A form submitted in another tab took the place of the login the panel was showing when « Enregistrer » was clicked: the click was for that
    // one, not for this one. Nothing is saved; the reply carries the offer of now, which the panel shows.
    if (seen.offer !== offer) return this.reply(window, false, t('pwd.un-autre-identifiant-est-propose'))
    if (!this.deps.vault.isUnlocked()) return this.reply(window, false, t('pwd.deverrouillez-le-coffre-ou-creez-le-pour'))
    try {
      const kind = await this.deps.vault.save({ origin: seen.origin, username: seen.username, password: seen.password })
      this.forgetCapture(window)
      this.touch()
      return this.reply(window, true, kind === 'update' ? t('pwd.mot-de-passe-mis-a-jour') : t('pwd.mot-de-passe-enregistre'))
    } catch (error) {
      return this.reply(window, false, this.failure('saving the login of a page', error))
    }
  }

  private dismissCapture(window: PasswordWindow, offer: number): PasswordReply {
    // « Ne pas enregistrer » is for the login that was shown: one that came since is kept, and the panel shows it.
    if (this.pending.get(window)?.offer === offer) this.forgetCapture(window)
    return this.reply(window, true)
  }

  // ---------- files ----------

  private async importCsv(window: PasswordWindow, files: PasswordFiles): Promise<PasswordReply> {
    if (!this.deps.vault.isUnlocked()) return this.reply(window, false, t('pwd.le-coffre-est-verrouille'))
    const path = await files.chooseToRead('csv')
    if (path === null) return this.reply(window, true)
    const read = await files.readText(path, CSV_LIMITS.bytes)
    if (!read.ok) return this.reply(window, false, read.message)
    const parsed = parseLoginCsv(read.text)
    if (!parsed.ok) {
      console.error('[passwords] a CSV file was refused:', parsed.error)
      return this.reply(window, false, CSV_MESSAGES[parsed.error])
    }
    try {
      const report = await this.deps.vault.addMany(parsed.parsed)
      this.touch()
      return this.reply(window, true, t('pwd.report-supprimez-maintenant-le-fichier-csv', { report: describeReport(report) }), { report })
    } catch (error) {
      return this.reply(window, false, this.failure('importing a CSV file', error))
    }
  }

  private async exportSealed(phrase: string, window: PasswordWindow, files: PasswordFiles): Promise<PasswordReply> {
    if (!this.deps.vault.isUnlocked()) return this.reply(window, false, t('pwd.le-coffre-est-verrouille'))
    const problem = phraseProblem(phrase)
    if (problem) return this.reply(window, false, problem)
    const path = await files.chooseToWrite()
    if (path === null) return this.reply(window, true)
    try {
      files.writePrivate(path, await this.deps.vault.exportSealed(phrase))
      this.touch()
      return this.reply(window, true, t('pwd.export-chiffre-enregistre-il-faudra-la-phrase'))
    } catch (error) {
      return this.reply(window, false, this.failure('exporting the vault', error))
    }
  }

  private async importExport(phrase: string, window: PasswordWindow, files: PasswordFiles): Promise<PasswordReply> {
    if (!this.deps.vault.isUnlocked()) return this.reply(window, false, t('pwd.le-coffre-est-verrouille'))
    const path = await files.chooseToRead('export')
    if (path === null) return this.reply(window, true)
    const read = await files.readText(path, SEALED_FILE_MAX)
    if (!read.ok) return this.reply(window, false, read.message)
    try {
      const report = await this.deps.vault.addMany(await openExport(read.text, phrase))
      this.touch()
      return this.reply(window, true, describeReport(report), { report })
    } catch (error) {
      return this.reply(window, false, this.failure('importing an export', error))
    }
  }
}

/** "Réessayez dans N s." for a phrase refused because of the wait after the wrong ones (at least a second: the wait is not over). */
function waitMessage(ms: number): string {
  return t('lock-service.reessayez-dans-seconds-s', { seconds: Math.max(1, Math.ceil(ms / 1000)) })
}

const VAULT_MESSAGES: Record<Exclude<VaultError['kind'], 'wait'>, string> = {
  get exists() { return t('pwd.un-coffre-existe-deja') },
  get missing() { return t('pwd.il-n-y-a-pas-de-coffre') },
  get locked() { return t('pwd.le-coffre-est-verrouille') },
  get phrase() { return t('passwords.la-phrase-est-invalide') },
  get full() { return t('pwd.le-coffre-est-plein-entries-identifiants-au-plus', { entries: PASSWORD_LIMITS.entries }) },
  get corrupt() { return t('pwd.le-coffre-contient-quelque-chose-que-cette') },
  get write() { return t('pwd.le-fichier-du-coffre-n-a-pas-pu-etre-ecrit') },
  get invalid() { return t('pwd.cet-identifiant-n-est-pas-valide') }
}

let current: PasswordService | null = null
export const setPasswordService = (service: PasswordService | null): void => {
  current = service
}
/** The password manager of the running application; null before it is set up. */
export const getPasswordService = (): PasswordService | null => current
