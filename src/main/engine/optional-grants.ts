// `chrome.permissions` for the extensions of every profile: what each one was granted of the permissions its manifest lists as facultative,
// kept per profile, and the four calls of the API answered from it. A request is a question to the person, on the same sheet as an
// installation, and only after a click or a key: an extension cannot put the question in front of them on its own. The rules are pure
// (shared/optional-permissions.ts); what touches the engine comes in through the host, so that this is tested without Electron.

import {
  grantedFacts,
  heldBy,
  isEmptySet,
  isOptional,
  missingFrom,
  readPermissionSet,
  readStoredGrant,
  reviewOfRequest,
  storeGrant,
  unionOf,
  withGranted,
  withinOptional,
  withoutRemoved,
  type GrantedFacts,
  type PermissionSet
} from '@shared/optional-permissions'
import type { ExtensionReview, SuffixTest } from '@shared/extension-review'
import { t } from '@shared/i18n'

/** The errors an extension reads, in the words the documented API uses. */
export const PERMISSION_ERRORS = {
  invalid: 'Invalid permissions: a list of permission names and a list of match patterns are expected.',
  notOptional: 'Only permissions specified in the manifest may be requested.',
  noGesture: 'This function must be called during a user gesture',
  pending: 'A request for permissions is already waiting for an answer.',
  required: 'You cannot remove required permissions.'
} as const

export interface OptionalGrantsHost {
  /** The manifest of an extension of a profile, as its files give it (loaded there or switched off). Undefined for one that is not known. */
  manifestOf(profileId: string, extensionId: string): unknown
  /** The name the extension goes by in the lists. */
  nameOf(profileId: string, extensionId: string): string
  /** What was kept for the extension in the profile, as `write` wrote it. */
  read(profileId: string, extensionId: string): string | undefined
  write(profileId: string, extensionId: string, value: string | undefined): void
  /** Whether the person clicked or pressed a key just before. */
  hadGesture(): boolean
  /** Shows the sheet; resolves true only when the person agreed. `sender` is the page or the worker that asked, as the caller knows it. */
  ask(profileId: string, extensionId: string, review: ExtensionReview, sender: unknown): Promise<boolean>
  /** What the extension holds in the profile changed: whoever reads its permissions reads them again. */
  changed(profileId: string, extensionId: string): void
  /** `chrome.permissions.onAdded` / `onRemoved` for the extension in the profile. */
  emit(profileId: string, extensionId: string, event: 'onAdded' | 'onRemoved', set: PermissionSet): void
  /** A line in the journal of the extension, for the person. */
  note(profileId: string, extensionId: string, message: string): void
  isSuffix?: SuffixTest
  warn?(message: string): void
}

const EMPTY: PermissionSet = { permissions: [], origins: [] }
const names = (set: PermissionSet): string => [...set.permissions, ...set.origins].slice(0, 12).join(', ')

export class OptionalGrants {
  /** The extensions whose question is on screen, by `profile:id`: one question at a time for each. */
  private readonly asking = new Set<string>()

  constructor(private readonly host: OptionalGrantsHost) {}

  /** What the person granted the extension in the profile, and that its manifest still lists as facultative. */
  granted(profileId: string, extensionId: string): PermissionSet {
    const text = this.host.read(profileId, extensionId)
    if (text === undefined) return EMPTY
    try {
      return withinOptional(this.host.manifestOf(profileId, extensionId), readStoredGrant(text))
    } catch (error) {
      // Kept text that is not a grant grants nothing. The line says for which extension, so that what was agreed to is not lost in silence, and the
      // text is dropped so that the line is written once: the extension asks again.
      ;(this.host.warn ?? console.warn)(`[extensions] what was granted to ${extensionId} in profile ${profileId} cannot be read, it is forgotten: ${(error as Error).message}`)
      this.host.write(profileId, extensionId, undefined)
      return EMPTY
    }
  }

  /** The manifest the access rules read for the extension in the profile: `manifest` with what was granted. */
  effective<T>(profileId: string, extensionId: string, manifest: T): T {
    return withGranted(manifest, this.granted(profileId, extensionId))
  }

  private read(raw: unknown): PermissionSet {
    const set = readPermissionSet(raw)
    if (set === null) throw new Error(PERMISSION_ERRORS.invalid)
    return set
  }

  private held(profileId: string, extensionId: string): unknown {
    return this.effective(profileId, extensionId, this.host.manifestOf(profileId, extensionId))
  }

  contains(profileId: string, extensionId: string, raw: unknown): boolean {
    return isEmptySet(missingFrom(this.held(profileId, extensionId), this.read(raw)))
  }

  getAll(profileId: string, extensionId: string): PermissionSet {
    return heldBy(this.held(profileId, extensionId))
  }

  /**
   * `chrome.permissions.request`. True at once for what is already held. Anything the manifest does not list as facultative is refused whole, and so is
   * a request that follows no click or key. Otherwise the person answers the sheet, and a yes is kept for this profile.
   */
  async request(profileId: string, extensionId: string, raw: unknown, sender: unknown): Promise<boolean> {
    const asked = this.read(raw)
    const manifest = this.host.manifestOf(profileId, extensionId)
    if (manifest === undefined) return false
    const granted = this.granted(profileId, extensionId)
    const missing = missingFrom(withGranted(manifest, granted), asked)
    if (isEmptySet(missing)) return true
    if (!isOptional(manifest, missing)) {
      this.host.note(profileId, extensionId, t('extpage.autorisation-demandee-hors-manifeste', { names: names(missing) }))
      throw new Error(PERMISSION_ERRORS.notOptional)
    }
    if (!this.host.hadGesture()) {
      this.host.note(profileId, extensionId, t('extpage.autorisation-demandee-sans-geste', { names: names(missing) }))
      throw new Error(PERMISSION_ERRORS.noGesture)
    }
    const key = `${profileId}:${extensionId}`
    if (this.asking.has(key)) throw new Error(PERMISSION_ERRORS.pending)
    const review = reviewOfRequest(manifest, granted, missing, this.host.nameOf(profileId, extensionId), this.host.isSuffix)
    if (review === null) return false
    this.asking.add(key)
    let agreed: boolean
    try {
      agreed = await this.host.ask(profileId, extensionId, review, sender)
    } finally {
      this.asking.delete(key)
    }
    if (!agreed) return false
    // The sheet stayed open for a while: the extension may have been updated or removed since. What is kept is judged on the manifest of now.
    const now = this.host.manifestOf(profileId, extensionId)
    if (now === undefined || !isOptional(now, missing)) return false
    this.host.write(profileId, extensionId, storeGrant(unionOf(this.granted(profileId, extensionId), missing)))
    this.host.changed(profileId, extensionId)
    this.host.emit(profileId, extensionId, 'onAdded', missing)
    return true
  }

  /** `chrome.permissions.remove`: the extension gives back what it was granted. What its manifest gives by itself is not its to give up. */
  remove(profileId: string, extensionId: string, raw: unknown): boolean {
    const outcome = withoutRemoved(this.host.manifestOf(profileId, extensionId), this.granted(profileId, extensionId), this.read(raw))
    if (outcome === null) throw new Error(PERMISSION_ERRORS.required)
    this.keep(profileId, extensionId, outcome)
    return true
  }

  /** The person takes one granted permission or site back, from the Extensions page. False when it was not held. */
  revoke(profileId: string, extensionId: string, name: string): boolean {
    const granted = this.granted(profileId, extensionId)
    const removed: PermissionSet = { permissions: granted.permissions.filter((held) => held === name), origins: granted.origins.filter((held) => held === name) }
    if (isEmptySet(removed)) return false
    this.keep(profileId, extensionId, { kept: { permissions: granted.permissions.filter((held) => held !== name), origins: granted.origins.filter((held) => held !== name) }, removed })
    return true
  }

  private keep(profileId: string, extensionId: string, outcome: { kept: PermissionSet; removed: PermissionSet }): void {
    if (isEmptySet(outcome.removed)) return
    this.host.write(profileId, extensionId, isEmptySet(outcome.kept) ? undefined : storeGrant(outcome.kept))
    this.host.changed(profileId, extensionId)
    this.host.emit(profileId, extensionId, 'onRemoved', outcome.removed)
  }

  /** The extension left the profile for good (uninstalled): installed again, it is asked again. */
  forget(profileId: string, extensionId: string): void {
    this.host.write(profileId, extensionId, undefined)
  }

  /** What the Extensions page lists for the extension in the profile. */
  facts(profileId: string, extensionId: string): GrantedFacts {
    return grantedFacts(this.host.manifestOf(profileId, extensionId), this.granted(profileId, extensionId))
  }
}
