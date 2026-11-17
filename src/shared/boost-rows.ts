import { BOOST_NAME_MAX } from './boost-share'

/**
 * The name typed to rename a Tweak from the panel of the site: trimmed, cut at the length a name may have, and null when there is nothing to save (empty,
 * or what the Tweak is called already) - the panel then just closes the field, and the name stays as it was.
 */
export function renamedBoost(typed: string, current: string): string | null {
  const name = typed.replace(/\p{Cc}/gu, ' ').trim().slice(0, BOOST_NAME_MAX).trim()
  return name === '' || name === current ? null : name
}

export interface SiteBoostChip {
  id: string
  name: string
  /** The one open in the editor. */
  current: boolean
  /** Saved: only a saved Tweak can be deleted from the strip (a new one that was never saved has nothing to delete). */
  stored: boolean
}

/**
 * The strip of the Tweaks of a site in the editor: the saved ones in their order, the open one under the name being typed (not the saved one), and the open one at
 * the end when it is new and not saved yet - so that the strip shows what the site will have, not what it had.
 */
export function siteBoosts(siblings: readonly { id: string; name: string }[], currentId: string, draftName: string): SiteBoostChip[] {
  const chips = siblings.map((b): SiteBoostChip => ({ id: b.id, name: b.id === currentId ? draftName : b.name, current: b.id === currentId, stored: true }))
  return chips.some((c) => c.current) ? chips : [...chips, { id: currentId, name: draftName, current: true, stored: false }]
}
